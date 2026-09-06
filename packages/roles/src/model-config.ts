import { MissingModelCredentialError } from './model-errors.js';
import {
  MODEL_API_KEY_VARIABLE,
  MODEL_ID_VARIABLE,
  REFERENCE_MODEL_ID,
  REFERENCE_MODEL_PROVIDER,
} from './reference-model-port.js';
import { ownTrimmedString } from './own-value.js';

/**
 * Explicit configuration for ONE reference provider and model, resolved from an
 * environment that is handed in rather than read.
 *
 * Modelled on `resolveTracingConfig` in `packages/observability`, and for the
 * same two reasons: the result is decidable in a test without mutating the
 * process, and **the credential is deliberately absent from it**. Callers need
 * to know whether the lane can run and under which model; whoever issues the
 * request reads the key itself, at the executable edge, from the variable this
 * result names.
 * see roles-port-contract.test.mjs › "resolves an available configuration
 * without ever returning the key"
 */
export type ModelConfig =
  | Readonly<{ available: false; missing: typeof MODEL_API_KEY_VARIABLE }>
  | Readonly<{
      available: true;
      provider: typeof REFERENCE_MODEL_PROVIDER;
      modelId: string;
      apiKeyVariable: typeof MODEL_API_KEY_VARIABLE;
    }>;

/**
 * Decide whether the live model lane can run, and say what is missing when it
 * cannot.
 *
 * An exported-but-empty variable is read as ABSENT rather than as configured: a
 * blank key produces a 401 at the provider, which reads downstream like a model
 * failure instead of a configuration one.
 * see roles-port-contract.test.mjs › "treats an empty or whitespace credential
 * as absent rather than as configured"
 */
/**
 * The credential, normalised, or `undefined` when there is not a usable one.
 *
 * 🔴 One reader, used by BOTH the availability decision above and the caller
 * that actually sends the value, so the string that was validated is the string
 * that is sent. They diverged before: `resolveModelConfig` validated a TRIMMED
 * value while `scripts/eval-live-model.mjs` passed the raw environment read, so
 * a credential could be judged usable in one shape and sent in another.
 *
 * A value carrying a control character is refused here rather than trimmed into
 * shape, because trimming cannot reach one in the middle — and the middle is
 * where it leaks: `Headers.append` rejects it with a `TypeError` that quotes the
 * whole header value. Found by `security-scanner` at the AIC-94 gate.
 * see roles-port-contract.test.mjs › "treats a credential carrying a control
 * character as absent rather than as configured"
 * see live-model-lane.test.mjs › "never hands the transport a credential the
 * configuration did not validate"
 *
 * ⚠ Returns the secret. It is the one function here that does, and nothing
 * stores what it returns: `ModelConfig` carries only `apiKeyVariable`, the NAME.
 */
export function readModelCredential(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const apiKey = ownTrimmedString(env, MODEL_API_KEY_VARIABLE);
  if (apiKey === undefined) return undefined;
  return /[\u0000-\u001F\u007F]/u.test(apiKey) ? undefined : apiKey;
}

export function resolveModelConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelConfig {
  if (readModelCredential(env) === undefined) {
    return { available: false, missing: MODEL_API_KEY_VARIABLE };
  }
  return {
    available: true,
    provider: REFERENCE_MODEL_PROVIDER,
    modelId: ownTrimmedString(env, MODEL_ID_VARIABLE) ?? REFERENCE_MODEL_ID,
    apiKeyVariable: MODEL_API_KEY_VARIABLE,
  };
}

/**
 * The same decision, as a refusal.
 *
 * The live lane calls this rather than branching on `available` itself, so the
 * "no credential" path produces one named error in one place instead of a
 * message per call site.
 */
export function requireModelConfig(
  env: Readonly<Record<string, string | undefined>>,
): Extract<ModelConfig, { available: true }> {
  const config = resolveModelConfig(env);
  if (!config.available) throw new MissingModelCredentialError(config.missing);
  return config;
}

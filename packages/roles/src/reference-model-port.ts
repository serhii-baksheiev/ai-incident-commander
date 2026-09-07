import { ModelCompletionError } from './model-errors.js';
import type { ModelUsage, ModelUsageLedger } from './model-usage-ledger.js';
import { CREDENTIAL_FORBIDDEN_CHARACTERS, ownValue } from './own-value.js';

/**
 * The ONE reference provider, and the only file in `packages/` that knows its
 * host, its headers or its wire format.
 *
 * Everything else in this package — the roles, the configuration, the ledger —
 * speaks `ModelPort`, which names no provider. That is what makes "the graph and
 * domain packages stay provider-independent" checkable rather than asserted:
 * a second provider would be a second file beside this one, not an edit spread
 * across the roles.
 * see roles-boundary.test.mjs › "reaches the model provider from exactly one
 * file in the workspace"
 *
 * ⚠ **No provider SDK is installed and this file does not add one.** The
 * transport is plain `fetch`, INJECTED, so the whole path is decidable in a unit
 * test with no network. A published SDK would be a new outbound dependency,
 * which `.claude/rules/autonomy.md` places in Tier 2.
 *
 * ⚠ Limits of this adapter, each one a deliberate omission rather than an
 * oversight, because the item's non-goals exclude a provider matrix:
 *   - no streaming: a role's answer is a small JSON document, and the streaming
 *     shape is a second parser this lane does not need;
 *   - no retry: the live lane must report a provider refusal, never hide one
 *     behind a loop that eventually succeeds;
 *   - no tool use and no thinking configuration: the roles here ask for a
 *     structured answer, not for an agent.
 * see roles-boundary.test.mjs › "states the adapter limits in the adapter"
 */

/** The provider this repository configures. */
export const REFERENCE_MODEL_PROVIDER = 'anthropic' as const;

/** The environment variable the credential is read from, and the only one. */
export const MODEL_API_KEY_VARIABLE = 'ANTHROPIC_API_KEY' as const;

/** The environment variable that overrides the model, for a deliberate sweep. */
export const MODEL_ID_VARIABLE = 'AIC_REFERENCE_MODEL_ID' as const;

/** The model this repository evaluates against unless an operator names another. */
export const REFERENCE_MODEL_ID = 'claude-opus-5' as const;

const PROVIDER_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const PROVIDER_API_VERSION = '2023-06-01';

/**
 * How long one completion may take before the lane gives up on it.
 *
 * Stated rather than left to the runtime default, which is minutes: the lane
 * runs a bounded number of calls and a hung one would stall the whole run with
 * nothing to read. A caller that needs a different bound passes its own
 * `signal`.
 * see roles-port-contract.test.mjs › "gives the provider request a deadline the
 * caller can override"
 */
const PROVIDER_TIMEOUT_MS = 120_000;

export interface ModelCompletionRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /**
   * 🔴 A JSON Schema the PROVIDER enforces on the answer, so a malformed one is
   * impossible rather than caught.
   *
   * Every role asked for its shape in a sentence and then parsed hopefully —
   * first `{` to last `}`. Measured on real calibration runs, the reference
   * model answered `"rationale"::"placehol"`, a doubled colon, and the lane
   * recorded the model arm unreportable for the whole thirty-record corpus.
   *
   * ⚠ This constrains ENCODING, never content. It cannot make a bad hypothesis
   * good, and the roles still refuse a schema-valid answer whose content the
   * domain rejects — those refusals are the measurement this lane exists for.
   * Absent means no constraint is sent at all: an empty one is a constraint
   * nobody declared.
   * see roles-port-contract.test.mjs › "constrains the answer shape at the provider when a role declares one"
   * see roles-port-contract.test.mjs › "sends no output_config when a role declares no shape"
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Overrides `PROVIDER_TIMEOUT_MS`; absent means that default applies. */
  readonly signal?: AbortSignal;
}

export interface ModelCompletion {
  readonly text: string;
  readonly modelId: string;
  readonly usage: ModelUsage;
  /**
   * 🔴 Why the provider stopped, carried so a TRUNCATION is not read as the
   * model answering badly.
   *
   * Without it a completion cut off at `max_tokens` reaches a role as an
   * ordinary string, `JSON.parse` fails on the half-written object, and the role
   * reports "the answer is not parseable JSON" — a false statement about the one
   * thing this lane exists to measure. Measured on a real calibration run before
   * this field existed: the lane recorded the model arm unreportable for
   * producing malformed output, and adding the field removed the symptom.
   *
   * Absent when the provider did not say, which is not the same as "the model
   * finished": a fake port in a test may omit it, and a role reads it as
   * unknown rather than as complete.
   * see roles-port-contract.test.mjs › "carries the reason a completion stopped, so a truncation is not read as the model answering badly"
   */
  readonly stopReason?: string;
}

/**
 * The provider-neutral port the roles depend on.
 *
 * A role is written against this interface and never against the adapter below,
 * so a test drives the three roles with a fake port and no network.
 */
export interface ModelPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletion>;
}

export type FetchImpl = (
  url: string,
  init: Readonly<{
    method: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    // Both are load-bearing rather than optional niceties: the deadline stops a
    // hung provider stalling a bounded run, and `redirect: 'error'` keeps the
    // custom `x-api-key` header — which the fetch spec does NOT strip on a
    // cross-origin redirect, unlike `Authorization` — from travelling to another
    // origin. An injected transport that ignores them weakens both, which is
    // why they are on the type a transport has to satisfy.
    signal: AbortSignal;
    redirect: 'error';
  }>,
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function requireOwnCount(payload: unknown, key: string): number {
  const value = ownValue(payload, key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ModelCompletionError(
      `model response usage has no own ${key} count`,
    );
  }
  return value;
}

function firstOwnTextBlock(payload: unknown): string {
  const content = ownValue(payload, 'content');
  if (!Array.isArray(content)) {
    throw new ModelCompletionError('model response carries no content array');
  }
  for (let index = 0; index < content.length; index += 1) {
    const block = ownValue(content, String(index));
    if (ownValue(block, 'type') !== 'text') continue;
    const text = ownValue(block, 'text');
    if (typeof text === 'string' && text.length > 0) return text;
  }
  throw new ModelCompletionError('model response carries no text block');
}

/**
 * Build the reference provider adapter.
 *
 * `fetchImpl` defaults to the global `fetch`, so production wiring passes
 * nothing and every test passes a function. `apiKey` arrives as an argument and
 * is never read from the process environment here. That no workspace package
 * reads `process.env` at all is checked rather than asserted, which is what
 * lets a caller test this port without touching the real environment.
 * see roles-boundary.test.mjs › "keeps every process-environment read out of
 * the workspace packages"
 */
export function createReferenceModelPort({
  apiKey,
  modelId,
  ledger,
  fetchImpl,
}: Readonly<{
  apiKey: string;
  modelId: string;
  ledger: ModelUsageLedger;
  fetchImpl?: FetchImpl;
}>): ModelPort {
  // 🔴 Empty is not the only unusable credential, and the other kind LEAKS.
  //
  // A control character inside the value — a key copied from a wrapped terminal,
  // or `export ANTHROPIC_API_KEY="$(cat key.txt)"` on a two-line file, which
  // strips only the TRAILING newline — survives `trim()`. It then reaches
  // `Headers.append`, and for `NUL`, `LF` and `CR` — measured, and the whole
  // leaking set — the `TypeError` QUOTES THE OFFENDING HEADER VALUE, and
  // `scripts/eval-live-model.mjs` prints `name: message` to stderr. That command
  // is AUTHORED to be run in CI, where the destination would be a retained job
  // log. No workflow in this repository invokes it today — checked, because the
  // difference sizes the exposure this guard is justified by.
  //
  // Refusing here means this module's OWN error fires instead, and that one
  // carries no value by construction. Found by `security-scanner` at the AIC-94
  // gate and reproduced independently.
  // see roles-port-contract.test.mjs › "refuses a credential carrying a control
  // character instead of letting the transport quote it back"
  if (apiKey.trim().length === 0 || CREDENTIAL_FORBIDDEN_CHARACTERS.test(apiKey)) {
    throw new ModelCompletionError('the reference model port needs a credential');
  }
  const transport: FetchImpl =
    fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchImpl>);

  return {
    async complete(request) {
      // Before the request, not after it: an exhausted cap must cost nothing.
      ledger.reserve();

      const response = await transport(PROVIDER_MESSAGES_URL, {
        method: 'POST',
        // A hung provider must not hang the lane: without this the call sits at
        // the runtime's default, which is minutes.
        signal: request.signal ?? AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        // `x-api-key` is a CUSTOM header, so the fetch spec's cross-origin
        // redirect stripping — which covers `Authorization` — does not apply to
        // it. A provider-side open redirect would hand the credential to
        // another origin, so a redirect is an error rather than something to
        // follow. Found by `security-scanner` at the AIC-94 gate.
        // see roles-port-contract.test.mjs › "refuses to follow a redirect,
        // because the credential header would travel with it"
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': PROVIDER_API_VERSION,
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          // Own-read and spread only when the caller declared one, so an absent
          // schema sends no `output_config` rather than an empty constraint.
          ...(ownValue(request, 'outputSchema') === undefined
            ? {}
            : {
                output_config: {
                  format: { type: 'json_schema', schema: request.outputSchema },
                },
              }),
        }),
      });

      if (!response.ok) {
        // The provider's own words, not a summary: a lane that reports a live
        // failure has to say what the provider said.
        const detail = await response.text().catch(() => '');
        throw new ModelCompletionError(
          `model provider refused the request: ${detail.slice(0, 400)}`,
          response.status,
        );
      }

      const payload: unknown = await response.json();
      const text = firstOwnTextBlock(payload);
      const usageBlock = ownValue(payload, 'usage');
      const usage: ModelUsage = {
        inputTokens: requireOwnCount(usageBlock, 'input_tokens'),
        outputTokens: requireOwnCount(usageBlock, 'output_tokens'),
      };

      // Own-read like every other field off a provider answer: an inherited
      // `stop_reason` would be a claim about a completion nobody made.
      const stopReasonSlot = ownValue(payload, 'stop_reason');
      const stopReason =
        typeof stopReasonSlot === 'string' && stopReasonSlot.length > 0
          ? stopReasonSlot
          : undefined;

      ledger.record(usage);
      return {
        text,
        modelId,
        usage,
        ...(stopReason === undefined ? {} : { stopReason }),
      };
    },
  };
}

import { ModelCompletionError } from './model-errors.js';
import type { ModelUsage, ModelUsageLedger } from './model-usage-ledger.js';
import { ownValue } from './own-value.js';

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

export interface ModelCompletionRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

export interface ModelCompletion {
  readonly text: string;
  readonly modelId: string;
  readonly usage: ModelUsage;
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
 * is never read from the process environment here — `packages/` reads
 * `process.env` zero times, and the credential enters at the executable edge.
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
  if (apiKey.trim().length === 0) {
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

      ledger.record(usage);
      return { text, modelId, usage };
    },
  };
}

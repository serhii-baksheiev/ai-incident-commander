import { canonicalJson } from '@aic/domain';

export const REPLAY_FIXTURE_VERSION = 1 as const;

/**
 * Serializes a tool input canonically - object keys sorted recursively, array
 * order kept - using `@aic/domain`'s `canonicalJson`, the one place canonical
 * JSON lives (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation"). Refuses the same non-JSON values `canonicalJson` refuses;
 * see durable-execution-contract.test.mjs › "replay-key canonicalize already
 * refuses the same non-JSON values canonicalJson refuses (no divergence to
 * reconcile)" and, for the byte-identical output this move must leave
 * unchanged, › "pins packages/tools/src/replay-key.ts output for fixed
 * inputs, measured on current code".
 */
export function canonicalSerializeToolInput(input: unknown): string {
  return JSON.stringify(canonicalJson(input));
}

export function createReplayFixtureKey(toolId: string, input: unknown): string {
  return `${REPLAY_FIXTURE_VERSION}:${JSON.stringify([
    toolId,
    canonicalSerializeToolInput(input),
  ])}`;
}

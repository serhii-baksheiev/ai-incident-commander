import { buildReplayIdentity } from './bound-source-registry.js';
import { isReadOnlyToolId } from './contracts.js';
import { createRequestFingerprint } from './evidence-source.js';
import type { EvidenceSourceOutcome } from './evidence-source.js';
import { REPLAY_FIXTURE_VERSION } from './replay-key.js';

/**
 * AIC-100, slice d: `migrateReplayFixtureV1` — converts a legacy v1 replay
 * fixture (`packages/tools/replay/index.ts`'s own `ReplayFixture` shape) into
 * the v2 `BoundSourceRegistry` recordings shape, so a `ReplayToolAdapter`
 * built from a legacy fixture can run entirely on
 * `createBoundSourceRegistry`'s `replay` mode. See
 * test/replay-fixture-migration.test.mjs's header for the full set of design
 * pins this file satisfies: the fixed `aic.incident-tool@1` adapter identity,
 * `sourceBindingId === operation === toolId`, `credentialRefId: null`, every
 * legacy `ToolResult` carried WHOLE as the migrated recording's `ok` `output`
 * (never reinterpreted into a typed refusal reason), a non-`1` fixture
 * version refused synchronously, and a non-read-only tool id or an
 * unparseable key skipped rather than thrown.
 *
 * The v1 key shape it parses is exactly
 * `packages/tools/src/replay-key.ts`'s `createReplayFixtureKey`'s own:
 * `` `${REPLAY_FIXTURE_VERSION}:${JSON.stringify([toolId, canonicalSerializeToolInput(input)])}` ``.
 * `canonicalSerializeToolInput` is `JSON.stringify(canonicalJson(input))` —
 * already-canonical JSON text — so parsing it back with `JSON.parse` and
 * handing the result to `createRequestFingerprint` (which canonicalizes
 * again internally) produces the same fingerprint `createRequestFingerprint`
 * would compute directly on the original, non-canonicalized input: canonical
 * JSON is idempotent under `canonicalJson`. That equivalence is what lets a
 * v1 key built from a key-order-permuted input still migrate to the same v2
 * identity a direct fingerprint of the original input produces (see the test
 * file's row 3) and what lets `createIncidentToolSource`'s record-mode
 * registry key an entry identically to this module's own migration of the
 * matching v1 fixture (`test/legacy-adapters-on-registry.test.mjs`'s "a
 * record-mode registry over createIncidentToolSource produces the same
 * identity ..." row).
 *
 * `Object.keys(fixture.responses)` is processed in SORTED order, not
 * insertion order — so `skipped.keys`, the one field whose exact array order
 * would otherwise track the caller's own object literal, stays independent of
 * that order too (`recordings` is an object and already order-independent
 * under `assert.deepEqual`).
 */

const MIGRATED_ADAPTER_ID = 'aic.incident-tool';
const MIGRATED_ADAPTER_VERSION = '1';
const MIGRATED_ADAPTER = `${MIGRATED_ADAPTER_ID}@${MIGRATED_ADAPTER_VERSION}`;

export interface LegacyReplayFixtureV1 {
  readonly version: unknown;
  readonly responses: Readonly<Record<string, unknown>>;
}

export interface MigratedReplayFixture {
  readonly recordings: Record<string, EvidenceSourceOutcome<unknown>>;
  readonly skipped: { readonly count: number; readonly keys: readonly string[] };
}

interface ParsedLegacyKey {
  readonly toolId: string;
  readonly input: unknown;
}

/**
 * Recovers `(toolId, input)` from a legacy v1 key, or `null` when the key is
 * not this version's shape — never thrown, so a caller loops over every key
 * and treats `null` as "skip this one" (this module's own contract: a single
 * bad entry is reported in `skipped`, never a thrown failure for the whole
 * fixture).
 */
function parseLegacyReplayKey(key: string): ParsedLegacyKey | null {
  const prefix = `${REPLAY_FIXTURE_VERSION}:`;
  if (!key.startsWith(prefix)) {
    return null;
  }

  let parsedKey: unknown;
  try {
    parsedKey = JSON.parse(key.slice(prefix.length));
  } catch {
    return null;
  }

  if (
    !Array.isArray(parsedKey) ||
    parsedKey.length !== 2 ||
    typeof parsedKey[0] !== 'string' ||
    typeof parsedKey[1] !== 'string'
  ) {
    return null;
  }

  const [toolId, canonicalInputText] = parsedKey;
  let input: unknown;
  try {
    input = JSON.parse(canonicalInputText);
  } catch {
    return null;
  }

  return { toolId, input };
}

export function migrateReplayFixtureV1(
  fixture: LegacyReplayFixtureV1,
  options: { readonly fetchedAt: string },
): MigratedReplayFixture {
  if (fixture.version !== REPLAY_FIXTURE_VERSION) {
    throw new Error(
      `migrateReplayFixtureV1: unsupported fixture version ${JSON.stringify(fixture.version)}`,
    );
  }

  const { fetchedAt } = options;
  const recordings: Record<string, EvidenceSourceOutcome<unknown>> = {};
  const skippedKeys: string[] = [];

  for (const key of Object.keys(fixture.responses).sort()) {
    const parsed = parseLegacyReplayKey(key);
    if (parsed === null || !isReadOnlyToolId(parsed.toolId)) {
      skippedKeys.push(key);
      continue;
    }

    const { toolId, input } = parsed;
    let requestFingerprint: string;
    try {
      requestFingerprint = createRequestFingerprint(toolId, input);
    } catch {
      skippedKeys.push(key);
      continue;
    }

    const identity = buildReplayIdentity({
      sourceBindingId: toolId,
      adapter: MIGRATED_ADAPTER,
      requestFingerprint,
    });

    recordings[identity] = {
      status: 'ok',
      output: fixture.responses[key],
      provenance: {
        sourceBindingId: toolId,
        adapter: MIGRATED_ADAPTER,
        credentialRefId: null,
        fetchedAt,
        requestFingerprint,
      },
    };
  }

  return { recordings, skipped: { count: skippedKeys.length, keys: skippedKeys } };
}

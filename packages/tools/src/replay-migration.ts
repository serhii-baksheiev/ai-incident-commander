import { buildReplayIdentity } from './bound-source-registry.js';
import { isReadOnlyToolId } from './contracts.js';
import { createRequestFingerprint } from './evidence-source.js';
import { INCIDENT_TOOL_ADAPTER_ID, INCIDENT_TOOL_ADAPTER_VERSION } from './incident-tool-source.js';
import type { EvidenceSourceOutcome } from './evidence-source.js';
import { REPLAY_FIXTURE_VERSION } from './replay-key.js';

/**
 * AIC-100, slice d: converts a legacy v1 replay fixture into the v2
 * recordings `BoundSourceRegistry` replays. Design pins and edge cases:
 * test/replay-fixture-migration.test.mjs.
 *
 * Keys are processed in sorted order so `skipped.keys` does not depend on the
 * caller's insertion order.
 */

const MIGRATED_ADAPTER = `${INCIDENT_TOOL_ADAPTER_ID}@${INCIDENT_TOOL_ADAPTER_VERSION}`;

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

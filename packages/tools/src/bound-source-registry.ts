import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  classifyEvidenceSourceFailure,
  createRequestFingerprint,
} from './evidence-source.js';
import type {
  EvidenceSource,
  EvidenceSourceOutcome,
  EvidenceSourceProvenance,
} from './evidence-source.js';

/**
 * AIC-100, slice b: `BoundSourceRegistry` — the live/record/replay wrapper
 * around slice a's `EvidenceSource` port (`./evidence-source.js`, unmodified
 * here). See test/bound-source-registry.test.mjs's header for the full set of
 * design pins this file satisfies (provenance is written ONLY by the
 * registry, the two provenance edge cases, the versioned replay identity, and
 * the explicit `rekeyReplayRecordings` migration path).
 *
 * The module reads no ambient clock: every `fetchedAt` comes from the
 * injected `clock: () => Date` an options bag carries, never `Date.now()` or
 * `new Date()` called directly here.
 */

/** The three modes a `BoundSourceRegistry` may run in — a closed union. */
export type BoundSourceMode = 'live' | 'record' | 'replay';

/** One evidence source bound into a registry under a stable id. */
export interface BoundSourceBinding {
  readonly sourceBindingId: string;
  readonly source: EvidenceSource;
  readonly credentialRefId: string | null;
}

/** A stored recording: get/set/keys/delete, all async. */
export interface ReplayStore {
  get(identity: string): Promise<EvidenceSourceOutcome<unknown> | undefined>;
  set(identity: string, outcome: EvidenceSourceOutcome<unknown>): Promise<void>;
  keys(): Promise<string[]>;
  delete(identity: string): Promise<void>;
}

export interface BoundSourceRegistryOptions {
  readonly mode: BoundSourceMode;
  readonly bindings: readonly BoundSourceBinding[];
  readonly store: ReplayStore;
  readonly clock: () => Date;
}

export interface BoundSourceRegistry {
  execute(
    sourceBindingId: string,
    operation: string,
    input: unknown,
  ): Promise<EvidenceSourceOutcome<unknown>>;
}

/**
 * Versioned replay-identity scheme: `` `v${REPLAY_IDENTITY_VERSION}:${sourceBindingId}:${adapter}:${requestFingerprint}` ``.
 * Bumping it is an explicit, reviewed decision (a new migration shape for
 * `rekeyReplayRecordings`), never an implicit side effect of some other
 * change — see test/bound-source-registry.test.mjs's header.
 */
export const REPLAY_IDENTITY_VERSION = 2;

function buildReplayIdentity(parts: {
  readonly sourceBindingId: string;
  readonly adapter: string;
  readonly requestFingerprint: string;
}): string {
  return `v${REPLAY_IDENTITY_VERSION}:${parts.sourceBindingId}:${parts.adapter}:${parts.requestFingerprint}`;
}

const BOUND_SOURCE_MODES: readonly BoundSourceMode[] = ['live', 'record', 'replay'];

/**
 * The registry: the single writer of provenance in every mode. See the
 * test file's header for the exact per-mode behaviour this satisfies.
 */
export function createBoundSourceRegistry(
  options: BoundSourceRegistryOptions,
): BoundSourceRegistry {
  const { mode, bindings, store, clock } = options;

  if (!BOUND_SOURCE_MODES.includes(mode)) {
    throw new Error(`createBoundSourceRegistry: unknown mode ${JSON.stringify(mode)}`);
  }

  const bindingsById = new Map<string, BoundSourceBinding>();
  for (const binding of bindings) {
    if (bindingsById.has(binding.sourceBindingId)) {
      throw new Error(
        `createBoundSourceRegistry: duplicate sourceBindingId ${binding.sourceBindingId}`,
      );
    }
    bindingsById.set(binding.sourceBindingId, binding);
  }

  return {
    async execute(sourceBindingId, operation, input) {
      let requestFingerprint = '';
      let fingerprintFailed = false;
      try {
        requestFingerprint = createRequestFingerprint(operation, input);
      } catch {
        fingerprintFailed = true;
      }

      const binding = bindingsById.get(sourceBindingId);

      if (!binding) {
        const provenance: EvidenceSourceProvenance = {
          sourceBindingId,
          adapter: '',
          credentialRefId: null,
          fetchedAt: clock().toISOString(),
          requestFingerprint,
        };
        return { status: 'refused', reason: 'unavailable', provenance };
      }

      const descriptor = binding.source.describe();
      const adapter = `${descriptor.adapterId}@${descriptor.version}`;
      const credentialRefId = binding.credentialRefId;

      const buildProvenance = (fetchedAt: string): EvidenceSourceProvenance => ({
        sourceBindingId,
        adapter,
        credentialRefId,
        fetchedAt,
        requestFingerprint,
      });

      if (fingerprintFailed) {
        return {
          status: 'refused',
          reason: 'adapter_error',
          provenance: buildProvenance(clock().toISOString()),
        };
      }

      if (mode === 'replay') {
        const identity = buildReplayIdentity({ sourceBindingId, adapter, requestFingerprint });
        const stored = await store.get(identity);
        if (!stored) {
          return {
            status: 'refused',
            reason: 'unavailable',
            provenance: buildProvenance(clock().toISOString()),
          };
        }
        return stored;
      }

      // live and record share this path from here.
      if (!descriptor.operations.includes(operation)) {
        return {
          status: 'refused',
          reason: 'unavailable',
          provenance: buildProvenance(clock().toISOString()),
        };
      }

      let outcome: EvidenceSourceOutcome<unknown>;
      try {
        const result = await binding.source.execute(operation, input);
        const fetchedAt = clock().toISOString();
        outcome =
          result.status === 'ok'
            ? { status: 'ok', output: result.output, provenance: buildProvenance(fetchedAt) }
            : { status: 'refused', reason: result.reason, provenance: buildProvenance(fetchedAt) };
      } catch (error) {
        outcome = {
          status: 'refused',
          reason: classifyEvidenceSourceFailure(error),
          provenance: buildProvenance(clock().toISOString()),
        };
      }

      if (mode === 'record') {
        const identity = buildReplayIdentity({ sourceBindingId, adapter, requestFingerprint });
        await store.set(identity, outcome);
      }

      return outcome;
    },
  };
}

/** In-process `ReplayStore`: a plain `Map`, nothing persisted. */
export function createMemoryReplayStore(): ReplayStore {
  const recordings = new Map<string, EvidenceSourceOutcome<unknown>>();
  return {
    async get(identity) {
      return recordings.get(identity);
    },
    async set(identity, outcome) {
      recordings.set(identity, outcome);
    },
    async keys() {
      return Array.from(recordings.keys());
    },
    async delete(identity) {
      recordings.delete(identity);
    },
  };
}

type StoredRecordings = Record<string, EvidenceSourceOutcome<unknown>>;

function readRecordingsFile(path: string): StoredRecordings {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) {
    return {};
  }
  return JSON.parse(raw) as StoredRecordings;
}

/**
 * Writes the whole file back with its keys sorted, so two stores holding the
 * same recordings, populated in different orders, produce byte-identical
 * files — see test/bound-source-registry.test.mjs's
 * "createFileReplayStore writes byte-identical files regardless of the order
 * recordings were set in" row.
 */
function writeRecordingsFile(path: string, recordings: StoredRecordings): void {
  const sorted: StoredRecordings = {};
  for (const key of Object.keys(recordings).sort()) {
    sorted[key] = recordings[key];
  }
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/**
 * File-backed `ReplayStore`: one JSON file at `path`, read fresh and
 * rewritten whole on every mutation — no in-memory cache, so a freshly
 * constructed store in a genuinely separate process (see the test file's
 * "deterministic across a process restart" row) always sees what is on disk.
 * Construction itself performs no I/O: the file is read only inside
 * `get`/`set`/`keys`/`delete`, so a store that is only ever constructed and
 * never called (see test/fixtures/bound-source-registry-type-contract.ts,
 * executed directly by node's bare test-file discovery) touches no file.
 */
export function createFileReplayStore(path: string): ReplayStore {
  return {
    async get(identity) {
      return readRecordingsFile(path)[identity];
    },
    async set(identity, outcome) {
      const recordings = readRecordingsFile(path);
      recordings[identity] = outcome;
      writeRecordingsFile(path, recordings);
    },
    async keys() {
      return Object.keys(readRecordingsFile(path));
    },
    async delete(identity) {
      const recordings = readRecordingsFile(path);
      delete recordings[identity];
      writeRecordingsFile(path, recordings);
    },
  };
}

/**
 * The only thing that ever re-keys a stored recording: moves every entry
 * recorded under `(sourceBindingId, fromAdapter)` to the identity for
 * `(sourceBindingId, toAdapter)`, updating both the stored key and the
 * recorded outcome's own `provenance.adapter`. Returns the number of entries
 * migrated. An entry for a different `sourceBindingId` or a different
 * `fromAdapter` is left untouched — nothing re-keys implicitly.
 */
export async function rekeyReplayRecordings(
  store: ReplayStore,
  options: {
    readonly sourceBindingId: string;
    readonly fromAdapter: string;
    readonly toAdapter: string;
  },
): Promise<number> {
  const { sourceBindingId, fromAdapter, toAdapter } = options;
  const fromPrefix = `v${REPLAY_IDENTITY_VERSION}:${sourceBindingId}:${fromAdapter}:`;

  const keys = await store.keys();
  let migrated = 0;

  for (const key of keys) {
    if (!key.startsWith(fromPrefix)) {
      continue;
    }
    const requestFingerprint = key.slice(fromPrefix.length);
    const outcome = await store.get(key);
    if (outcome === undefined) {
      continue;
    }

    const newIdentity = buildReplayIdentity({
      sourceBindingId,
      adapter: toAdapter,
      requestFingerprint,
    });
    const migratedProvenance: EvidenceSourceProvenance = { ...outcome.provenance, adapter: toAdapter };
    const migratedOutcome: EvidenceSourceOutcome<unknown> =
      outcome.status === 'ok'
        ? { status: 'ok', output: outcome.output, provenance: migratedProvenance }
        : { status: 'refused', reason: outcome.reason, provenance: migratedProvenance };

    await store.set(newIdentity, migratedOutcome);
    await store.delete(key);
    migrated += 1;
  }

  return migrated;
}

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  EVIDENCE_SOURCE_REFUSAL_REASONS,
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
 * the explicit `rekeyReplayRecordings` migration path), including the review
 * round 1 findings the same header names (the JSON-array replay identity,
 * replay's provenance.credentialRefId, the fromAdapter===toAdapter no-op, the
 * file store's 0o600 mode, malformed/unparseable recordings, and __proto__
 * handling).
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
 * Versioned replay-identity scheme, pinned to a JSON array rather than a raw
 * `:`-join: `` `v${REPLAY_IDENTITY_VERSION}:` + JSON.stringify([sourceBindingId, adapter, requestFingerprint]) ``.
 * A raw `:`-join lets one part's own `:` characters relabel a boundary — see
 * test/bound-source-registry.test.mjs's header and its "does not collide
 * across a `:` inside a part" row (review round 1, code-reviewer blocker 1).
 * Bumping the version is an explicit, reviewed decision (a new migration
 * shape for `rekeyReplayRecordings`), never an implicit side effect of some
 * other change.
 */
export const REPLAY_IDENTITY_VERSION = 2;

const REPLAY_IDENTITY_PREFIX = `v${REPLAY_IDENTITY_VERSION}:`;

function buildReplayIdentity(parts: {
  readonly sourceBindingId: string;
  readonly adapter: string;
  readonly requestFingerprint: string;
}): string {
  return REPLAY_IDENTITY_PREFIX + JSON.stringify([parts.sourceBindingId, parts.adapter, parts.requestFingerprint]);
}

interface ParsedReplayIdentity {
  readonly sourceBindingId: string;
  readonly adapter: string;
  readonly requestFingerprint: string;
}

/**
 * The only way a stored key's parts are recovered: JSON.parse of the part
 * after this version's prefix, in a try — never a string-prefix/slice
 * operation, which is exactly the encoding that let two different
 * (sourceBindingId, adapter) pairs collide (review round 1, code-reviewer
 * blocker 1). A key that does not carry this version's prefix, or whose tail
 * does not parse as a 3-element string array, is not this version's shape and
 * is returned as `null` — callers skip it rather than guessing at it.
 */
function parseReplayIdentity(identity: string): ParsedReplayIdentity | null {
  if (!identity.startsWith(REPLAY_IDENTITY_PREFIX)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(identity.slice(REPLAY_IDENTITY_PREFIX.length));
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string'
  ) {
    return null;
  }
  return { sourceBindingId: parsed[0], adapter: parsed[1], requestFingerprint: parsed[2] };
}

const BOUND_SOURCE_MODES: readonly BoundSourceMode[] = ['live', 'record', 'replay'];

/**
 * A stored value is trusted only once it is checked to be a well-formed
 * `EvidenceSourceOutcome`: `status` is `ok` or `refused`; a `refused` status
 * carries a `reason` inside `EVIDENCE_SOURCE_REFUSAL_REASONS`; `provenance` is
 * an object whose `fetchedAt` is a string (the one field a replay hit reuses
 * verbatim). Anything else — including a value with no `provenance` at all —
 * is malformed and treated as a miss (`unavailable`), never handed back to
 * the caller verbatim. See test/bound-source-registry.test.mjs's "replay
 * treats a stored record …" rows (security blocker 5b).
 */
function isWellFormedStoredOutcome(value: unknown): value is EvidenceSourceOutcome<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { status?: unknown; reason?: unknown; provenance?: unknown };
  if (typeof record.provenance !== 'object' || record.provenance === null) {
    return false;
  }
  const fetchedAt = (record.provenance as { fetchedAt?: unknown }).fetchedAt;
  if (typeof fetchedAt !== 'string') {
    return false;
  }
  if (record.status === 'ok') {
    return true;
  }
  if (record.status === 'refused') {
    return (
      typeof record.reason === 'string' &&
      (EVIDENCE_SOURCE_REFUSAL_REASONS as readonly string[]).includes(record.reason)
    );
  }
  return false;
}

function withRekeyedProvenanceAdapter(
  outcome: EvidenceSourceOutcome<unknown>,
  adapter: string,
): EvidenceSourceOutcome<unknown> {
  const provenance: EvidenceSourceProvenance = { ...outcome.provenance, adapter };
  return outcome.status === 'ok'
    ? { status: 'ok', output: outcome.output, provenance }
    : { status: 'refused', reason: outcome.reason, provenance };
}

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

        let stored: EvidenceSourceOutcome<unknown> | undefined;
        try {
          stored = await store.get(identity);
        } catch (error) {
          // store.get() is never allowed to reject execute() — an unparseable
          // recordings file, or any other store failure, refuses adapter_error
          // instead. See "replay over a file that is not valid JSON …"
          // (security blocker 5a).
          return {
            status: 'refused',
            reason: classifyEvidenceSourceFailure(error),
            provenance: buildProvenance(clock().toISOString()),
          };
        }

        if (stored === undefined || !isWellFormedStoredOutcome(stored)) {
          return {
            status: 'refused',
            reason: 'unavailable',
            provenance: buildProvenance(clock().toISOString()),
          };
        }

        // A replay hit rebuilds provenance from the CURRENT binding —
        // sourceBindingId, adapter and credentialRefId are recomputed fresh
        // (never read back off the recording, see code-reviewer blocker 2) —
        // keeping only the RECORDED fetchedAt, the one field a replay hit
        // takes from the stored recording rather than the replaying clock.
        const rebuiltProvenance = buildProvenance(stored.provenance.fetchedAt);
        return stored.status === 'ok'
          ? { status: 'ok', output: stored.output, provenance: rebuiltProvenance }
          : { status: 'refused', reason: stored.reason, provenance: rebuiltProvenance };
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
        // UNREDACTED: the stored recording is exactly the adapter's own
        // output, verbatim, until AIC-100 slice c adds redaction — see
        // test/bound-source-registry.test.mjs's header, "Review round 1 —
        // security findings pinned here too".
        const identity = buildReplayIdentity({ sourceBindingId, adapter, requestFingerprint });
        try {
          await store.set(identity, outcome);
        } catch (error) {
          // store.set() is never allowed to reject execute() either, even
          // though the adapter call itself may already have succeeded (review
          // round 1, security blocker 5c).
          return {
            status: 'refused',
            reason: classifyEvidenceSourceFailure(error),
            provenance: buildProvenance(clock().toISOString()),
          };
        }
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

/**
 * Parses the recordings file into a null-prototype object, so a `__proto__`
 * key present in the file is stored as an ordinary own property rather than
 * reassigning the object's real prototype, and a lookup for an identity like
 * `'constructor'` or `'toString'` can never resolve to an inherited
 * `Object.prototype` member — there is no prototype to inherit from. See
 * test/bound-source-registry.test.mjs's "a __proto__ key in the file never
 * surfaces through get() …" row (security advisory 6).
 */
function readRecordingsFile(path: string): StoredRecordings {
  const target: StoredRecordings = Object.create(null) as StoredRecordings;
  if (!existsSync(path)) {
    return target;
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) {
    return target;
  }
  const parsed = JSON.parse(raw) as Record<string, EvidenceSourceOutcome<unknown>>;
  return Object.assign(target, parsed);
}

/**
 * Writes the whole file back with its keys sorted, so two stores holding the
 * same recordings, populated in different orders, produce byte-identical
 * files — see test/bound-source-registry.test.mjs's
 * "createFileReplayStore writes byte-identical files regardless of the order
 * recordings were set in" row.
 *
 * Written atomically: a temp file in the same directory (so the rename below
 * is same-filesystem) is created with mode `0o600` — never world-readable,
 * because a recording is UNREDACTED adapter output until AIC-100 slice c
 * (security blocker 4) — and renamed over the target, so a reader never
 * observes a partially written file and no temp file is left behind once
 * `set()`/`delete()` returns. See test/bound-source-registry.test.mjs's
 * "creates its recordings file with mode 0o600" and "after a set(), no
 * temporary file is left beside the store …" rows.
 */
function writeRecordingsFile(path: string, recordings: StoredRecordings): void {
  const sorted: StoredRecordings = Object.create(null) as StoredRecordings;
  for (const key of Object.keys(recordings).sort()) {
    sorted[key] = recordings[key];
  }
  const contents = `${JSON.stringify(sorted, null, 2)}\n`;
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Nothing was left to clean up — the write itself is what failed.
    }
    throw error;
  }
}

/** A unique, non-exported key used only to detect the file store's own bulk-rekey capability below — never serialized, never part of the public `ReplayStore` contract. */
const FILE_STORE_BULK_REKEY: unique symbol = Symbol('bound-source-registry.file-store-bulk-rekey');

interface BulkRekeyableReplayStore extends ReplayStore {
  readonly [FILE_STORE_BULK_REKEY]?: (options: {
    readonly sourceBindingId: string;
    readonly fromAdapter: string;
    readonly toAdapter: string;
  }) => Promise<number>;
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
 *
 * UNREDACTED: every recording this store persists is exactly the adapter's
 * own output, verbatim — AIC-100 slice c adds redaction; this slice does not.
 */
export function createFileReplayStore(path: string): ReplayStore {
  const store: BulkRekeyableReplayStore = {
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
    // A single read + single write over every matching entry, rather than
    // `rekeyReplayRecordings`'s generic get/set/delete-per-entry fallback,
    // which would otherwise re-read and re-write this whole file once per
    // matched entry (O(n) file I/O per entry, so O(n^2) overall — review
    // round 1 performance finding).
    async [FILE_STORE_BULK_REKEY]({ sourceBindingId, fromAdapter, toAdapter }) {
      const recordings = readRecordingsFile(path);
      const next: StoredRecordings = Object.create(null) as StoredRecordings;
      let migrated = 0;
      for (const [key, outcome] of Object.entries(recordings)) {
        const parsedIdentity = parseReplayIdentity(key);
        if (
          parsedIdentity !== null &&
          parsedIdentity.sourceBindingId === sourceBindingId &&
          parsedIdentity.adapter === fromAdapter
        ) {
          const newIdentity = buildReplayIdentity({
            sourceBindingId,
            adapter: toAdapter,
            requestFingerprint: parsedIdentity.requestFingerprint,
          });
          next[newIdentity] = withRekeyedProvenanceAdapter(outcome, toAdapter);
          migrated += 1;
        } else {
          next[key] = outcome;
        }
      }
      if (migrated > 0) {
        writeRecordingsFile(path, next);
      }
      return migrated;
    },
  };
  return store;
}

function hasBulkRekey(store: ReplayStore): store is BulkRekeyableReplayStore {
  return typeof (store as BulkRekeyableReplayStore)[FILE_STORE_BULK_REKEY] === 'function';
}

/**
 * The only thing that ever re-keys a stored recording: moves every entry
 * recorded under `(sourceBindingId, fromAdapter)` to the identity for
 * `(sourceBindingId, toAdapter)`, updating both the stored key and the
 * recorded outcome's own `provenance.adapter`. Returns the number of entries
 * migrated. An entry for a different `sourceBindingId` or a different
 * `fromAdapter` is left untouched — nothing re-keys implicitly. Keys are
 * recovered by parsing this version's JSON-array encoding (see
 * `parseReplayIdentity`), never by a string prefix/slice — a key that is not
 * this version's shape is left exactly where it is.
 *
 * `fromAdapter === toAdapter` is a no-op: it returns `0` without touching the
 * store at all — no read, no write — so the recording is left exactly where
 * it was, still replayable (review round 1, code-reviewer blocker 3).
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

  if (fromAdapter === toAdapter) {
    return 0;
  }

  if (hasBulkRekey(store)) {
    const bulkRekey = store[FILE_STORE_BULK_REKEY];
    if (bulkRekey) {
      return bulkRekey({ sourceBindingId, fromAdapter, toAdapter });
    }
  }

  const keys = await store.keys();
  let migrated = 0;

  for (const key of keys) {
    const parsedIdentity = parseReplayIdentity(key);
    if (
      parsedIdentity === null ||
      parsedIdentity.sourceBindingId !== sourceBindingId ||
      parsedIdentity.adapter !== fromAdapter
    ) {
      continue;
    }

    const outcome = await store.get(key);
    if (outcome === undefined) {
      continue;
    }

    const newIdentity = buildReplayIdentity({
      sourceBindingId,
      adapter: toAdapter,
      requestFingerprint: parsedIdentity.requestFingerprint,
    });

    await store.set(newIdentity, withRekeyedProvenanceAdapter(outcome, toAdapter));
    await store.delete(key);
    migrated += 1;
  }

  return migrated;
}

/**
 * AIC-100, slice b: the compile-time half of `BoundSourceRegistry`'s
 * contract — pinned the same way `test/fixtures/evidence-source-type-contract.ts`
 * (slice a) pins `EvidenceSource`: a real value, structurally checked, with
 * rows proving the check is not vacuous.
 *
 * Design this file pins, decided here rather than discovered mid-assertion
 * (the ticket names the shape, not every internal detail):
 *
 *   - `createBoundSourceRegistry(options: BoundSourceRegistryOptions):
 *     BoundSourceRegistry`, where `BoundSourceRegistry` exposes
 *     `execute(sourceBindingId, operation, input): Promise<EvidenceSourceOutcome>`.
 *   - `BoundSourceRegistryOptions` = `{ mode: BoundSourceMode; bindings:
 *     readonly BoundSourceBinding[]; store: ReplayStore; clock: () => Date }`,
 *     and `BoundSourceBinding` = `{ sourceBindingId: string; source:
 *     EvidenceSource; credentialRefId: string | null }` — `credentialRefId`
 *     is required, not optional, so a binding can never silently default it.
 *   - `BoundSourceMode` = `'live' | 'record' | 'replay'`, a closed union.
 *   - `ReplayStore` = `{ get(identity): Promise<EvidenceSourceOutcome |
 *     undefined>; set(identity, outcome): Promise<void>; keys():
 *     Promise<string[]>; delete(identity): Promise<void> }`.
 *   - `createMemoryReplayStore(): ReplayStore` and
 *     `createFileReplayStore(path: string): ReplayStore`.
 *   - `rekeyReplayRecordings(store, { sourceBindingId, fromAdapter,
 *     toAdapter }): Promise<number>`.
 *   - `REPLAY_IDENTITY_VERSION: number`, a frozen constant.
 *
 * A real value, not a `declare`: like its sibling fixtures, `test/fixtures`
 * is swept by node's default test-file discovery, so this file is also
 * EXECUTED with its types stripped — every binding below must be valid plain
 * JavaScript too.
 */
import type {
  BoundSourceMode,
  BoundSourceRegistry,
  BoundSourceRegistryOptions,
  EvidenceSource,
  ReplayStore,
} from '@aic/tools';
import {
  createBoundSourceRegistry,
  createFileReplayStore,
  createMemoryReplayStore,
  rekeyReplayRecordings,
  REPLAY_IDENTITY_VERSION,
} from '@aic/tools';

function acceptsBoundSourceRegistry(registry: BoundSourceRegistry): void {
  void registry;
}
function acceptsReplayStore(store: ReplayStore): void {
  void store;
}

const fakeSource: EvidenceSource = {
  describe: () => ({ adapterId: 'fixture-adapter', version: '1.0.0', operations: ['fetch-logs'] }),
  check: async () => ({ status: 'ready' }),
  execute: async () => ({
    status: 'ok',
    output: {},
    provenance: {
      sourceBindingId: 'binding-fixture',
      adapter: 'fixture-adapter@1.0.0',
      credentialRefId: null,
      fetchedAt: '2026-09-24T00:00:00.000Z',
      requestFingerprint: `sha256:${'0'.repeat(64)}`,
    },
  }),
};

const memoryStore = createMemoryReplayStore();
acceptsReplayStore(memoryStore);

const fileStore = createFileReplayStore('/tmp/aic-100b-type-contract-does-not-need-to-exist.json');
acceptsReplayStore(fileStore);

const mode: BoundSourceMode = 'record';
void mode;

// @ts-expect-error BoundSourceMode excludes arbitrary strings
const badMode: BoundSourceMode = 'bogus';
void badMode;

const options: BoundSourceRegistryOptions = {
  mode: 'live',
  bindings: [{ sourceBindingId: 'binding-fixture', source: fakeSource, credentialRefId: null }],
  store: memoryStore,
  clock: () => new Date('2026-09-24T00:00:00.000Z'),
};

const registry = createBoundSourceRegistry(options);
acceptsBoundSourceRegistry(registry);

async function typeCheckExecute(): Promise<void> {
  const outcome = await registry.execute('binding-fixture', 'fetch-logs', { service: 'checkout' });
  void outcome;
}
void typeCheckExecute;

// @ts-expect-error a binding requires credentialRefId (string | null), never omitted
const optionsMissingCredentialRefId: BoundSourceRegistryOptions = {
  mode: 'live',
  bindings: [{ sourceBindingId: 'binding-fixture', source: fakeSource }],
  store: memoryStore,
  clock: () => new Date(),
};
void optionsMissingCredentialRefId;

async function typeCheckRekey(): Promise<void> {
  const migrated = await rekeyReplayRecordings(fileStore, {
    sourceBindingId: 'binding-fixture',
    fromAdapter: 'fixture-adapter@1.0.0',
    toAdapter: 'fixture-adapter@2.0.0',
  });
  const count: number = migrated;
  void count;
}
void typeCheckRekey;

const version: number = REPLAY_IDENTITY_VERSION;
void version;

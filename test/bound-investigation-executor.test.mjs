/**
 * AIC-146 slice b3: the tools-side bound-source execution port — the one
 * function that receives a `BoundSourceRegistry` outcome for a planned
 * `(tool, input)` call and turns it into the shape the graph's
 * `execute_investigation` node expects (`packages/graph/src/nodes/execute-investigation.ts`'s
 * `ExecuteInvestigationOutcome`). The design this file pins is restated below
 * rather than cited from an external artifact.
 *
 * ## The new export this file pins
 *
 *   `createBoundInvestigationExecutor({ bindings, credentialRefs?, mode,
 *   store?, clock, fetch?, resolveSecret?, buildSource?, budgets? }):
 *   Promise<BoundInvestigationExecutorConstructionResult>`, from
 *   `packages/tools/src/bound-investigation-executor.ts` (new), exported from
 *   `@aic/tools`'s package index.
 *
 *   - `bindings`: real `@aic/domain` `SourceBinding` records (id,
 *     environmentId and credentialRefId are UUIDs by `SourceBindingSchema`
 *     itself — `RegistryIdSchema = z.uuid()`, `packages/domain/src/scope.ts`).
 *   - `credentialRefs`: real `CredentialRef` records, looked up by a
 *     binding's own `credentialRefId`; optional, defaults to none.
 *   - `mode`: `'live' | 'record' | 'replay'`, forwarded to the internal
 *     `BoundSourceRegistry`.
 *   - `store`: a `ReplayStore`; optional for a caller that only ever runs
 *     `live` (every row below that cares about `store` behaviour supplies
 *     one explicitly, for full control).
 *   - `clock`, `fetch`, `resolveSecret`, `budgets`: forwarded to the
 *     registry / `createEvidenceSourceForBinding` unchanged.
 *   - `buildSource`: an optional seam replacing `createEvidenceSourceForBinding`
 *     — the same `(catalogBinding, deps) => Promise<AdapterCatalogResult>`
 *     signature — used below to inject a source whose `describe()` disagrees
 *     with its own binding (the "adapter-mismatch" and "describe() called
 *     once" rows) without touching the real adapters at all.
 *
 *   `BoundInvestigationExecutorConstructionResult` is
 *   `{ ok: true; executor: BoundInvestigationExecutor } | { ok: false;
 *   reason: ...; sourceBindingId?: string; tool?: string; sourceBindingIds?:
 *   readonly string[] }` — an `ok`-discriminated union, mirroring
 *   `@aic/domain`'s own `PrimaryScopeCheck` (`packages/domain/src/scope.ts`)
 *   rather than `AdapterCatalogResult`'s `status: 'ready' | 'refused'`
 *   (`adapter-catalog.ts`): both conventions already exist in this
 *   codebase, and `ok:boolean` is the one this file's own construction
 *   result — a single yes/no gate before any evidence collection, exactly
 *   like `PrimaryScopeCheck` — is closer to. The closed `reason` values
 *   are `not-a-registry-binding`, `unsupported-adapter`, `invalid-config`,
 *   `missing-credential`, `credential-not-read`, `secret-absent`,
 *   `secret-unreadable` (all six borrowed verbatim from
 *   `AdapterCatalogRefusalReason`, `adapter-catalog.ts`, since a catalog
 *   refusal IS a construction refusal here), `adapter-mismatch` (the
 *   registry's own compatibility-handshake throw, caught and reported
 *   without echoing its message — see
 *   test/bound-source-compatibility.test.mjs's own header),
 *   `ambiguous-route` (two bindings whose routes name the same tool,
 *   mirroring `replay/index.ts`'s `assertOneFormPerTool`), and — pinned
 *   below, review round 1 — `duplicate-binding` (the same `sourceBindingId`
 *   passed twice, naming that id — never `adapter-mismatch`),
 *   `invalid-budgets` and `invalid-mode` (a `budgets` or `mode` value the
 *   registry rejects for every binding, not one — so neither names a
 *   `sourceBindingId`), `credential-environment-mismatch` (a binding's
 *   `credentialRefId` names a read `CredentialRef` in a DIFFERENT
 *   Environment — the same rule `RegistrySnapshotSchema`,
 *   `packages/domain/src/scope.ts`, states for the mutation path, restated
 *   here because this port matches a credential by id alone) and
 *   `store-required` (mode `record` or `replay` with no `store` supplied —
 *   `store` stays optional only for a caller that only ever runs `live`).
 *
 *   `BoundInvestigationExecutor.execute(context):
 *   Promise<BoundInvestigationExecutorOutcome>` where `context` is
 *   `{ runId, testId, attempt, tool, input }` and the outcome is `{status:
 *   'ok', output: readonly Evidence[], provenance: EvidenceProvenance} |
 *   {status:'unavailable', reason: string} | {status:'error', message:
 *   string}` — restated locally in `@aic/tools` rather than imported from
 *   `@aic/graph`, the same direction `execute-investigation.ts`'s own
 *   `ExecuteInvestigationOutcome` restates `ToolResult` rather than
 *   importing `@aic/tools` (`packages/graph/package.json` declares no such
 *   dependency, and the reverse is true too: `packages/tools/package.json`
 *   depends on `@aic/domain` only). The port's own `provenance` is REQUIRED
 *   on its `ok` variant, not optional — a bound-source outcome always names
 *   the binding that served it — which stays assignable into the graph's
 *   own, more permissive `ExecuteInvestigationOutcome` (an object with a
 *   required field satisfies a type that only asks for an optional one).
 *   `test/fixtures/bound-investigation-executor-type-contract.ts` pins the
 *   assignment directly against `Parameters<typeof
 *   createInvestigationNodes>[0]['execute']`, never a hand-copied second
 *   spelling of that parameter's shape (`.claude/rules/invariants.md`, "one
 *   mechanism, one implementation").
 *
 * ## Independent oracle for provenance
 *
 * `requestFingerprint` is checked against a HAND-WRITTEN canonical envelope
 * string, sha256'd with `node:crypto` directly — never by calling
 * `createRequestFingerprint` or `canonicalJson` from this file — mirroring
 * test/evidence-source-contract.test.mjs's own "matches an independently
 * computed sha256" row and test/lab-evidence-source.test.mjs's
 * `handBuiltFingerprint` helper, reused here under the same name and shape.
 *
 * ## Routing
 *
 * A planned `(tool, input)` is routed to the one `SourceBinding` whose
 * adapter's `describe().operations`, filtered to `isReadOnlyToolId(...)`,
 * names that tool — built once at construction from each binding's own
 * `describe()` snapshot, never re-read on a later `execute()` call (the
 * "describe() called exactly once" row below). `lab@1` describes exactly
 * `READ_ONLY_TOOL_REGISTRY`'s ids; `github@1`'s operations are GitHub verbs
 * (`list_deployments`, …), none of which is a `ToolId`, so a `github@1`
 * binding alone routes nothing.
 *
 * ## No credential literal
 *
 * `resolvedSecretValue` below is an all-letters marker
 * (`.claude/scripts/lib/secrets.mjs`'s `assigned-secret` arm cannot flag an
 * all-letters captured value), mirroring
 * test/adapter-catalog.test.mjs's own `resolvedSecretValue`; `secretName`
 * builds a `CredentialRef.secretName` from parts at runtime, mirroring the
 * same file's own helper.
 *
 * All rows below fail right now because `createBoundInvestigationExecutor`
 * is not yet exported from `@aic/tools` — the factory helper's own
 * assertion is the first thing every row hits.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as tools from '@aic/tools';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(
  projectRoot,
  'test/fixtures/bound-investigation-executor-type-contract.ts',
);

const CLOCK_ISO = '2026-09-29T00:00:00.000Z';
const fixedClock = () => new Date(CLOCK_ISO);

/* -------------------------------------------------------------------------- */
/* Export factory                                                             */
/* -------------------------------------------------------------------------- */

function createBoundInvestigationExecutorFactory() {
  assert.equal(
    typeof tools.createBoundInvestigationExecutor,
    'function',
    '@aic/tools must export createBoundInvestigationExecutor({ bindings, credentialRefs?, mode, store?, clock, fetch?, resolveSecret?, buildSource?, budgets? }): Promise<{ ok: true, executor } | { ok: false, reason, ... }> (AIC-146 b3)',
  );
  return tools.createBoundInvestigationExecutor;
}

/* -------------------------------------------------------------------------- */
/* SourceBinding / CredentialRef fixtures — schema-valid, ids from randomUUID */
/* -------------------------------------------------------------------------- */

function rawLabBinding(overrides = {}) {
  return {
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId: 'lab',
    adapterVersion: '1',
    name: 'lab-primary',
    config: { baseUrl: 'http://127.0.0.1:9999' },
    credentialRefId: null,
    ...overrides,
  };
}

/** Always schema-valid: every row that needs a deliberately-invalid binding builds it with rawLabBinding instead. */
function makeBinding(overrides = {}) {
  return domain.SourceBindingSchema.parse(rawLabBinding(overrides));
}

const GITHUB_OWNER = 'octo-owner';
const GITHUB_REPO = 'octo-repo';

function makeGithubBinding(overrides = {}) {
  return domain.SourceBindingSchema.parse(
    rawLabBinding({
      adapterId: 'github',
      adapterVersion: '1',
      name: 'github-primary',
      config: { owner: GITHUB_OWNER, repo: GITHUB_REPO },
      ...overrides,
    }),
  );
}

/** Mirrors test/adapter-catalog.test.mjs's own runtime-assembled secretName helper. */
const secretName = (...parts) => parts.join('_');

function makeReadCredentialRef(overrides = {}) {
  return domain.CredentialRefSchema.parse({
    id: randomUUID(),
    environmentId: randomUUID(),
    access: 'read',
    name: 'github-read',
    secretName: secretName('GITHUB', 'READ', 'TOKEN'),
    ...overrides,
  });
}

// All-letters, mirroring test/adapter-catalog.test.mjs's own
// `resolvedSecretValue`: a value guard-secret-file's `assigned-secret` arm
// cannot flag, since it rejects an all-letters captured value.
const resolvedSecretValue = 'resolvedreadonlysecretvaluemarker';

async function unreachableResolveSecret() {
  throw new Error('RESOLVE_SECRET_MUST_NOT_BE_CALLED_FOR_A_CREDENTIAL_LESS_BINDING');
}

/**
 * A github-pat SHAPE, assembled at runtime — never written as one
 * contiguous literal (`.claude/rules/autonomy.md`) — mirrors
 * test/cli-apply.test.mjs's and test/cli-incident-command.test.mjs's own
 * `pastedSecret` helper. Used only as a construction candidate's `id` field,
 * to prove a refusal never echoes it back (review round 1, security
 * advisory 3).
 */
const credentialShapedId = () => ['ghp', 'B'.repeat(28)].join('_');

/* -------------------------------------------------------------------------- */
/* Evidence item fixtures — real EvidenceSchema-valid records                 */
/* -------------------------------------------------------------------------- */

function makeEvidenceItem(overrides = {}) {
  return domain.EvidenceSchema.parse({
    id: 'evidence-checkout-deploy-v42',
    trialId: 'trial-placeholder',
    kind: 'deploy',
    source: 'deployments/checkout',
    observedAt: '2026-08-26T15:00:00.000Z',
    statement: 'checkout-v42 changed the database endpoint configuration',
    rawRef: 'replay://deployments/checkout/evidence-checkout-deploy-v42',
    ...overrides,
  });
}

const DEPLOYMENTS_INPUT = Object.freeze({ service: 'checkout', window: 'incident' });

/**
 * A SCHEMA-VALID `EvidenceProvenance` — used to prove the own-provenance
 * PRESENCE refusal fires even when the value itself would pass
 * `EvidenceProvenanceSchema` on its own (review round 1, code blocker 1).
 */
function makeWellFormedItemProvenance(overrides = {}) {
  return domain.EvidenceProvenanceSchema.parse({
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: CLOCK_ISO,
    requestFingerprint: `sha256:${'0'.repeat(64)}`,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Independent-oracle fingerprint helper — hand-built, never calling         */
/* createRequestFingerprint or canonicalJson (mirrors                        */
/* test/lab-evidence-source.test.mjs's own handBuiltFingerprint)             */
/* -------------------------------------------------------------------------- */

function handBuiltFingerprint(operation, input) {
  const envelope = `{"input":${JSON.stringify(input)},"operation":${JSON.stringify(operation)}}`;
  const hex = createHash('sha256').update(envelope).digest('hex');
  return `sha256:${hex}`;
}

/* -------------------------------------------------------------------------- */
/* Fake fetch — records every call, never touches the network                */
/* (mirrors test/lab-evidence-source.test.mjs's own helpers)                 */
/* -------------------------------------------------------------------------- */

function fakeResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createFakeFetch(implementation) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return implementation(url, init);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function createRefusingFetch(reasonForFailure) {
  return createFakeFetch(() => {
    throw new Error(`FAKE_FETCH_MUST_NOT_BE_CALLED: ${reasonForFailure}`);
  });
}

/** A fetch whose promise never settles — used to exercise the timeout budget. */
function neverSettlingFetch() {
  return () => new Promise(() => {});
}

/* -------------------------------------------------------------------------- */
/* buildSource seam helpers — a fake EvidenceSource with call counters, never */
/* going through the real adapters (mirrors                                  */
/* test/bound-source-compatibility.test.mjs's own buildCountingSource)       */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER_PROVENANCE = Object.freeze({
  sourceBindingId: '',
  adapter: '',
  credentialRefId: null,
  fetchedAt: '',
  requestFingerprint: '',
});

/** describe() is expected to be called; check()/execute() firing at all is the failure this seam proves against. */
function buildRefusingToBeCalledSource({ adapterId, version, operations }) {
  const calls = { describe: 0, check: 0, execute: 0 };
  return {
    calls,
    source: {
      describe() {
        calls.describe += 1;
        return { adapterId, version, operations };
      },
      async check() {
        calls.check += 1;
        throw new Error('COUNTING_SOURCE_CHECK_MUST_NOT_BE_CALLED');
      },
      async execute() {
        calls.execute += 1;
        throw new Error('COUNTING_SOURCE_EXECUTE_MUST_NOT_BE_CALLED');
      },
    },
  };
}

/** A working fake source (describe/check/execute all succeed), with call counters. */
function buildCountingWorkingSource({ adapterId, version, operations, items }) {
  const calls = { describe: 0, check: 0, execute: 0 };
  return {
    calls,
    source: {
      describe() {
        calls.describe += 1;
        return { adapterId, version, operations };
      },
      async check() {
        calls.check += 1;
        return { status: 'ready' };
      },
      async execute() {
        calls.execute += 1;
        return { status: 'ok', output: items, provenance: PLACEHOLDER_PROVENANCE };
      },
    },
  };
}

function buildSourceReturning(source) {
  return async () => ({ status: 'ready', source });
}

/**
 * Wraps the REAL `createEvidenceSourceForBinding` (never a fake) with
 * check()/execute() counters, so a construction-refusal row that never
 * builds a source through the buildSource seam explicitly can still assert
 * those two counts stayed at 0 alongside `fetch` — extending the "each
 * construction refusal, fetch/check/execute/store reads counted at 0" claim
 * beyond the two adapter-mismatch rows (review round 1, code advisory 2).
 */
function buildSourceWithSourceCallCounters() {
  const calls = { check: 0, execute: 0 };
  const buildSource = async (binding, deps) => {
    const result = await tools.createEvidenceSourceForBinding(binding, deps);
    if (result.status !== 'ready') return result;
    const inner = result.source;
    return {
      status: 'ready',
      source: {
        describe: () => inner.describe(),
        async check(...args) {
          calls.check += 1;
          return inner.check(...args);
        },
        async execute(...args) {
          calls.execute += 1;
          return inner.execute(...args);
        },
      },
    };
  };
  return { calls, buildSource };
}

/** A `ReplayStore` with call counters, never touching the network or disk (review round 1, code advisory 2). */
function buildCountingStore() {
  const calls = { get: 0, set: 0, keys: 0, delete: 0 };
  return {
    calls,
    store: {
      async get() {
        calls.get += 1;
        return undefined;
      },
      async set() {
        calls.set += 1;
      },
      async keys() {
        calls.keys += 1;
        return [];
      },
      async delete() {
        calls.delete += 1;
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* An always-throwing ReplayStore — proves the port refuses BEFORE ever       */
/* delegating into the registry, since replay mode's own execute() touches   */
/* store.get() before any operation allow-list check (design note 5).        */
/* -------------------------------------------------------------------------- */

function buildUnreachableStore() {
  return {
    async get() {
      throw new Error('STORE_GET_MUST_NOT_BE_CALLED');
    },
    async set() {
      throw new Error('STORE_SET_MUST_NOT_BE_CALLED');
    },
    async keys() {
      return [];
    },
    async delete() {},
  };
}

function baseContext(overrides = {}) {
  return {
    runId: 'run-1',
    testId: 'test-1',
    attempt: 1,
    tool: 'deployments',
    input: DEPLOYMENTS_INPUT,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Routing an ok call to lab@1                                                */
/* -------------------------------------------------------------------------- */

test('routes a planned deployments call to the lab@1 binding, returns the stub body\'s items as output, and stamps provenance naming the binding UUID, lab@1, no credential, the injected clock and a hand-built fingerprint', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const items = [makeEvidenceItem()];
  const fetchFn = createFakeFetch(() => fakeResponse({ status: 200, body: items }));

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));

  const outcome = await constructed.executor.execute(baseContext());

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, items);
  assert.deepEqual(outcome.provenance, {
    sourceBindingId: binding.id,
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: fixedClock().toISOString(),
    requestFingerprint: handBuiltFingerprint('deployments', DEPLOYMENTS_INPUT),
  });
  assert.equal(fetchFn.calls.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Construction refusal: unsupported adapter version                         */
/* -------------------------------------------------------------------------- */

test('a lab@2 binding is refused unsupported-adapter at construction, with fetch, check, execute and store reads all counted at 0', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding({ adapterVersion: '2' });
  const fetchFn = createRefusingFetch('lab@2 is unsupported and must never reach fetch');
  const { calls: sourceCalls, buildSource } = buildSourceWithSourceCallCounters();
  const { calls: storeCalls, store } = buildCountingStore();

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store,
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
    buildSource,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'unsupported-adapter', sourceBindingId: binding.id });
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(sourceCalls.check, 0);
  assert.equal(sourceCalls.execute, 0);
  assert.equal(storeCalls.get, 0);
  assert.equal(storeCalls.set, 0);
});

/* -------------------------------------------------------------------------- */
/* Construction refusal: adapter-mismatch (buildSource seam)                 */
/* -------------------------------------------------------------------------- */

test("a buildSource seam whose describe() reports lab@2 for a binding declaring lab@1 is refused adapter-mismatch; check, execute and fetch are never called", async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const { calls, source } = buildRefusingToBeCalledSource({
    adapterId: 'lab',
    version: '2',
    operations: tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id),
  });
  const fetchFn = createRefusingFetch('a mismatched adapter must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
    buildSource: buildSourceReturning(source),
  });

  assert.deepEqual(constructed, { ok: false, reason: 'adapter-mismatch', sourceBindingId: binding.id });
  assert.equal(calls.check, 0);
  assert.equal(calls.execute, 0);
  assert.equal(fetchFn.calls.length, 0);
});

test('the same adapter-mismatch construction refusal holds in replay mode, and store.get is never called', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const { calls, source } = buildRefusingToBeCalledSource({
    adapterId: 'lab',
    version: '2',
    operations: tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id),
  });
  const fetchFn = createRefusingFetch('a mismatched adapter must never reach fetch, in replay either');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'replay',
    store: buildUnreachableStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
    buildSource: buildSourceReturning(source),
  });

  assert.deepEqual(constructed, { ok: false, reason: 'adapter-mismatch', sourceBindingId: binding.id });
  assert.equal(calls.check, 0);
  assert.equal(calls.execute, 0);
  assert.equal(fetchFn.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Construction refusal classification (review round 1, code blocker 3):     */
/* `createBoundSourceRegistry` throws on five distinct causes — duplicate    */
/* sourceBindingId, invalid budgets, an unknown mode, an unsafe adapter      */
/* field and a genuine expectedAdapter mismatch. The port checks the first   */
/* three itself, before the registry is built. The four rows below pin four  */
/* DISTINCT typed reasons: 'duplicate-binding' (naming the duplicated id), 'invalid-budgets'*/
/* (no sourceBindingId — the value is wrong across every binding, not one),  */
/* 'invalid-mode' (no sourceBindingId, for the same reason), and             */
/* 'adapter-mismatch' still, but naming only the truly mismatched binding    */
/* out of a healthy pair.                                                    */
/* -------------------------------------------------------------------------- */

test('the same binding passed twice is refused duplicate-binding, naming the duplicated id (not adapter-mismatch)', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const fetchFn = createRefusingFetch('a duplicate binding must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding, binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'duplicate-binding', sourceBindingId: binding.id });
  assert.equal(fetchFn.calls.length, 0);
});

test('invalid budgets (a negative timeoutMs) are refused invalid-budgets, with no sourceBindingId — the value is wrong for every binding, not one', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const fetchFn = createRefusingFetch('invalid budgets must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
    budgets: { timeoutMs: -5 },
  });

  assert.deepEqual(constructed, { ok: false, reason: 'invalid-budgets' });
  assert.equal('sourceBindingId' in constructed, false, JSON.stringify(constructed));
  assert.equal(fetchFn.calls.length, 0);
});

test('an unknown mode is refused invalid-mode, with no sourceBindingId — the value is wrong for every binding, not one', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const fetchFn = createRefusingFetch('an unknown mode must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'nonsense-mode',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'invalid-mode' });
  assert.equal('sourceBindingId' in constructed, false, JSON.stringify(constructed));
  assert.equal(fetchFn.calls.length, 0);
});

test('a genuine describe() mismatch among two otherwise-healthy bindings is still refused adapter-mismatch, naming only the truly mismatched binding', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const healthyBinding = makeBinding({ name: 'lab-healthy' });
  const mismatchedBinding = makeBinding({ name: 'lab-mismatched' });
  const { calls, source: mismatchedSource } = buildRefusingToBeCalledSource({
    adapterId: 'lab',
    version: '2',
    operations: tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id),
  });
  const fetchFn = createRefusingFetch('a construction refusal must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [healthyBinding, mismatchedBinding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
    buildSource: async (binding, deps) => {
      if (binding.id === mismatchedBinding.id) {
        return buildSourceReturning(mismatchedSource)(binding, deps);
      }
      return tools.createEvidenceSourceForBinding(binding, deps);
    },
  });

  assert.deepEqual(constructed, { ok: false, reason: 'adapter-mismatch', sourceBindingId: mismatchedBinding.id });
  assert.equal(calls.check, 0);
  assert.equal(calls.execute, 0);
  assert.equal(fetchFn.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* HTTP status mapping through lab@1                                         */
/* -------------------------------------------------------------------------- */

for (const status of [401, 403]) {
  test(`an HTTP ${status} from lab@1 is unavailable/denied`, async () => {
    const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
    const constructed = await createBoundInvestigationExecutor({
      bindings: [makeBinding()],
      mode: 'live',
      store: tools.createMemoryReplayStore(),
      clock: fixedClock,
      fetch: createFakeFetch(() => fakeResponse({ status, body: { error: 'irrelevant upstream text' } })),
      resolveSecret: unreachableResolveSecret,
    });

    assert.equal(constructed.ok, true, JSON.stringify(constructed));
    const outcome = await constructed.executor.execute(baseContext());
    assert.deepEqual(outcome, { status: 'unavailable', reason: 'denied' });
  });
}

test('an HTTP 429 from lab@1 is unavailable/rate_limited', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 429, body: { error: 'irrelevant upstream text' } })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());
  assert.deepEqual(outcome, { status: 'unavailable', reason: 'rate_limited' });
});

test('a source call that never settles within the configured timeoutMs is unavailable/timeout', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: neverSettlingFetch(),
    resolveSecret: unreachableResolveSecret,
    budgets: { timeoutMs: 1, maxResultBytes: 5_000_000, maxPages: 50 },
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());
  assert.deepEqual(outcome, { status: 'unavailable', reason: 'timeout' });
});

test('an HTTP 400 from lab@1 is error/adapter_error, with no echoed body text', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 400, body: { error: 'do-not-echo-this-upstream-body-text' } })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.message, 'adapter_error');
  assert.equal(JSON.stringify(outcome).includes('do-not-echo-this-upstream-body-text'), false);
});

/* -------------------------------------------------------------------------- */
/* No route for the requested tool                                           */
/* -------------------------------------------------------------------------- */

test('a tool no binding describes is refused unavailable, without ever reaching the registry: store.get and fetch are never called', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const fetchFn = createRefusingFetch('no route means fetch is never reached');

  // Replay mode: the registry's OWN execute() never checks the operation
  // allow-list in replay (design note 5), so it would call store.get()
  // regardless of routing if the port merely delegated every call into the
  // registry. Using replay mode with a throwing store makes that delegation
  // observable, unlike live mode where the registry's own allow-list check
  // would produce the identical outward result either way.
  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'replay',
    store: buildUnreachableStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext({ tool: 'not-a-real-tool', input: {} }));

  assert.deepEqual(outcome, { status: 'unavailable', reason: 'unavailable' });
  assert.equal(fetchFn.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* github@1 routes no ToolId                                                  */
/* -------------------------------------------------------------------------- */

test('a github@1 binding routes no ToolId: every read-only tool id is refused unavailable, and fetch is never called', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const environmentId = randomUUID();
  const credentialRef = makeReadCredentialRef({ environmentId });
  const binding = makeGithubBinding({ credentialRefId: credentialRef.id, environmentId });
  const fetchFn = createRefusingFetch('github@1 routes no ToolId, so fetch must never be reached');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    credentialRefs: [credentialRef],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: async (name) => {
      assert.equal(name, credentialRef.secretName);
      return { status: 'found', value: resolvedSecretValue };
    },
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));

  for (const { id: toolId } of tools.READ_ONLY_TOOL_REGISTRY) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await constructed.executor.execute(baseContext({ tool: toolId, input: {} }));
    assert.deepEqual(outcome, { status: 'unavailable', reason: 'unavailable' }, `tool ${toolId}`);
  }
  assert.equal(fetchFn.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Construction refusal: a credentialRefId naming a CredentialRef in a       */
/* DIFFERENT Environment (review round 1, security advisory 1).             */
/* `RegistrySnapshotSchema` (`@aic/domain`'s scope.ts) refuses exactly this  */
/* pairing on the mutation path, but this port matches a binding's own      */
/* `credentialRefId` by id alone (`credentialRefsById.get(...)`), never      */
/* comparing the two records' `environmentId`s — so a caller that passes    */
/* one environment's bindings alongside the whole registry's credentialRefs */
/* (a documented, currently-legal call shape) would resolve the wrong       */
/* environment's secret.                                                    */
/* -------------------------------------------------------------------------- */

test('a github@1 binding whose credentialRefId names a read CredentialRef in a DIFFERENT environment is refused credential-environment-mismatch, and resolveSecret is never called', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const bindingEnvironmentId = randomUUID();
  const credentialEnvironmentId = randomUUID();
  assert.notEqual(bindingEnvironmentId, credentialEnvironmentId);

  const credentialRef = makeReadCredentialRef({ environmentId: credentialEnvironmentId });
  const binding = makeGithubBinding({ environmentId: bindingEnvironmentId, credentialRefId: credentialRef.id });
  const fetchFn = createRefusingFetch('a cross-environment credential refusal must never reach fetch');
  const resolveSecretCalls = [];

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    credentialRefs: [credentialRef],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: async (name) => {
      resolveSecretCalls.push(name);
      return { status: 'found', value: resolvedSecretValue };
    },
  });

  assert.deepEqual(constructed, {
    ok: false,
    reason: 'credential-environment-mismatch',
    sourceBindingId: binding.id,
  });
  assert.equal(resolveSecretCalls.length, 0);
  assert.equal(fetchFn.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Construction refusal: no store supplied for record/replay mode (review    */
/* round 1, security advisory 4). A silent in-memory default is the right    */
/* choice for `live` (where no code path ever reads or writes it), but it    */
/* makes `record` discard every recording and `replay` miss every call.      */
/* -------------------------------------------------------------------------- */

test("mode 'record' with no store supplied is refused store-required", async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const fetchFn = createRefusingFetch('a missing-store refusal must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'record',
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'store-required' });
  assert.equal(fetchFn.calls.length, 0);
});

test("mode 'replay' with no store supplied is refused store-required", async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const fetchFn = createRefusingFetch('a missing-store refusal must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'replay',
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'store-required' });
  assert.equal(fetchFn.calls.length, 0);
});

test("mode 'live' with no store supplied still constructs — store is optional only for live callers (this file's own header)", async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const items = [makeEvidenceItem()];

  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body: items })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
});

/* -------------------------------------------------------------------------- */
/* Ambiguous routing                                                          */
/* -------------------------------------------------------------------------- */

test('two lab@1 bindings are refused ambiguous-route at construction, naming a tool and both binding ids', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const bindingA = makeBinding({ name: 'lab-a' });
  const bindingB = makeBinding({ name: 'lab-b' });
  const fetchFn = createRefusingFetch('ambiguous routing must be refused before any fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [bindingA, bindingB],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, false);
  assert.equal(constructed.reason, 'ambiguous-route');
  assert.ok(
    tools.READ_ONLY_TOOL_REGISTRY.some((entry) => entry.id === constructed.tool),
    `reported tool ${JSON.stringify(constructed.tool)} must be one lab@1 describes`,
  );
  assert.deepEqual([...constructed.sourceBindingIds].sort(), [bindingA.id, bindingB.id].sort());
  assert.equal(fetchFn.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Routing admits only read-only ToolIds (review round 1, code blocker 2):   */
/* `buildRouteTable` filters each entry's `describe().operations` through    */
/* `isReadOnlyToolId` before it becomes a route. A binding whose adapter     */
/* describes a NON-read-only operation alongside a read-only one must route  */
/* the read-only one and refuse the other as if no binding described it —   */
/* never reach that binding's `execute()` for the non-read-only operation.   */
/* -------------------------------------------------------------------------- */

test('a binding whose adapter describes a non-read-only operation alongside a read-only ToolId routes only the read-only one; the non-read-only operation is unavailable and never reaches execute()', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const items = [makeEvidenceItem()];
  const { calls, source } = buildCountingWorkingSource({
    adapterId: 'lab',
    version: '1',
    // A read-only ToolId ('deployments') alongside a github-style,
    // NON-read-only verb ('rollback') — mirrors how a real adapter like
    // github@1 describes operations outside READ_ONLY_TOOL_REGISTRY.
    operations: ['deployments', 'rollback'],
    items,
  });

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createRefusingFetch('this row uses buildSource, not fetch'),
    resolveSecret: unreachableResolveSecret,
    buildSource: buildSourceReturning(source),
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));

  const rollbackOutcome = await constructed.executor.execute(baseContext({ tool: 'rollback', input: {} }));
  assert.deepEqual(rollbackOutcome, { status: 'unavailable', reason: 'unavailable' });
  assert.equal(calls.execute, 0, 'a non-read-only operation must never reach source.execute()');

  const deploymentsOutcome = await constructed.executor.execute(baseContext({ tool: 'deployments' }));
  assert.equal(deploymentsOutcome.status, 'ok');
  assert.deepEqual(deploymentsOutcome.output, items);
  assert.equal(calls.execute, 1, 'the read-only operation must still route to source.execute()');
});

/* -------------------------------------------------------------------------- */
/* Item-level refusals                                                       */
/* -------------------------------------------------------------------------- */

// Note (review round 1, code blocker 1): this row's `provenance` value is
// itself malformed ({ notEvenAUuid: true }), so `EvidenceSchema.safeParse`
// alone already refuses it — this row does NOT exercise the own-provenance
// PRESENCE check (`Object.hasOwn(item, 'provenance')`,
// packages/tools/src/bound-investigation-executor.ts:249-251). The next row
// pins that check with a SCHEMA-VALID provenance value, which
// `EvidenceSchema` alone would accept.
test('an output item carrying its own MALFORMED provenance is refused adapter_error via EvidenceSchema itself, and no evidence is returned', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const items = [
    {
      ...makeEvidenceItem(),
      // Fails EvidenceProvenanceSchema on its own — see the sibling row
      // below for the schema-VALID case that pins the presence check.
      provenance: { notEvenAUuid: true },
    },
  ];

  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body: items })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.message, 'adapter_error');
  assert.equal('output' in outcome, false);
});

test('an output item carrying its own SCHEMA-VALID provenance is refused adapter_error, and no evidence is returned — the refusal fires on the mere PRESENCE of an own provenance key, not on whether that value itself parses', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const wellFormedProvenance = makeWellFormedItemProvenance();

  // Precondition: EvidenceSchema alone accepts this item, so if this row's
  // refusal held, it could only be because EvidenceSchema rejected the
  // provenance value — proving the own-provenance PRESENCE check
  // (`Object.hasOwn(item, 'provenance')`) is what is actually under test.
  const itemWithWellFormedOwnProvenance = { ...makeEvidenceItem(), provenance: wellFormedProvenance };
  assert.equal(
    domain.EvidenceSchema.safeParse(itemWithWellFormedOwnProvenance).success,
    true,
    'precondition failed: EvidenceSchema must accept this item on its own, or this row would not isolate the presence check',
  );

  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body: [itemWithWellFormedOwnProvenance] })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.message, 'adapter_error');
  assert.equal('output' in outcome, false);
});

test('a non-array ok output from lab@1 is refused adapter_error, with no echoed text', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const constructed = await createBoundInvestigationExecutor({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body: { note: 'unexpected-object-body-must-never-be-echoed' } })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.message, 'adapter_error');
  assert.equal('output' in outcome, false);
  assert.equal(JSON.stringify(outcome).includes('unexpected-object-body-must-never-be-echoed'), false);
});

test('an output item failing EvidenceSchema is refused adapter_error, with no echoed text', async () => {
  const createBoundInvestigationExecutorForRow = createBoundInvestigationExecutorFactory();
  const { rawRef, ...missingRawRef } = makeEvidenceItem({
    statement: 'marker-text-that-must-never-be-echoed-back',
  });
  void rawRef;

  const constructed = await createBoundInvestigationExecutorForRow({
    bindings: [makeBinding()],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body: [missingRawRef] })),
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  const outcome = await constructed.executor.execute(baseContext());

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.message, 'adapter_error');
  assert.equal('output' in outcome, false);
  assert.equal(JSON.stringify(outcome).includes('marker-text-that-must-never-be-echoed-back'), false);
});

/* -------------------------------------------------------------------------- */
/* Record then replay: byte-identical                                       */
/* -------------------------------------------------------------------------- */

test('record then replay: output and provenance are byte-identical, and replay reuses the recorded fetchedAt even under a different clock', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const store = tools.createMemoryReplayStore();
  const items = [makeEvidenceItem()];

  const recordConstructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'record',
    store,
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body: items })),
    resolveSecret: unreachableResolveSecret,
  });
  assert.equal(recordConstructed.ok, true, JSON.stringify(recordConstructed));
  const recorded = await recordConstructed.executor.execute(baseContext());
  assert.equal(recorded.status, 'ok');

  const differentClock = () => new Date('2099-01-01T00:00:00.000Z');
  const replayConstructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'replay',
    store,
    clock: differentClock,
    fetch: createRefusingFetch('a replay hit must never touch fetch'),
    resolveSecret: unreachableResolveSecret,
  });
  assert.equal(replayConstructed.ok, true, JSON.stringify(replayConstructed));
  const replayed = await replayConstructed.executor.execute(baseContext());

  assert.deepEqual(replayed, recorded);
  assert.equal(replayed.provenance.fetchedAt, fixedClock().toISOString());
  assert.notEqual(replayed.provenance.fetchedAt, differentClock().toISOString());
});

/* -------------------------------------------------------------------------- */
/* describe() called exactly once per binding                                */
/* -------------------------------------------------------------------------- */

test('describe() is called exactly once per binding, across construction and every subsequent execute()', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding();
  const items = [makeEvidenceItem()];
  const { calls, source } = buildCountingWorkingSource({
    adapterId: 'lab',
    version: '1',
    operations: tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id),
    items,
  });

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createRefusingFetch('this row uses buildSource, not fetch'),
    resolveSecret: unreachableResolveSecret,
    buildSource: buildSourceReturning(source),
  });

  assert.equal(constructed.ok, true, JSON.stringify(constructed));
  assert.equal(calls.describe, 1, 'describe() must run exactly once, at construction');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await constructed.executor.execute(baseContext({ attempt }));
    assert.equal(outcome.status, 'ok');
  }

  assert.equal(calls.describe, 1, 'describe() must never be called again by a later execute()');
  assert.equal(calls.execute, 3);
});

/* -------------------------------------------------------------------------- */
/* A non-UUID binding id                                                     */
/* -------------------------------------------------------------------------- */

test('a non-UUID binding id ("incident-lab") is refused not-a-registry-binding without echoing the id, with fetch, check, execute and store reads all counted at 0', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = rawLabBinding({ id: 'incident-lab', name: 'incident-lab-binding' });
  const fetchFn = createRefusingFetch('a non-registry binding must never reach fetch');
  const { calls: sourceCalls, buildSource } = buildSourceWithSourceCallCounters();
  const { calls: storeCalls, store } = buildCountingStore();

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store,
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
    buildSource,
  });

  // A refusal names a binding only by an id that parses as a registry UUID:
  // any other string may be anything, a pasted credential included.
  assert.deepEqual(constructed, { ok: false, reason: 'not-a-registry-binding' });
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(sourceCalls.check, 0);
  assert.equal(sourceCalls.execute, 0);
  assert.equal(storeCalls.get, 0);
  assert.equal(storeCalls.set, 0);
});

test('not-a-registry-binding for a record whose id is credential-shaped never echoes the raw id', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const rawId = credentialShapedId();
  const binding = rawLabBinding({ id: rawId, name: 'credential-shaped-id-binding' });
  const fetchFn = createRefusingFetch('a non-registry binding must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.equal(constructed.ok, false);
  assert.equal(constructed.reason, 'not-a-registry-binding');
  assert.equal(
    JSON.stringify(constructed).includes(rawId),
    false,
    `the refusal must not echo the raw credential-shaped id: ${JSON.stringify(constructed)}`,
  );
  assert.equal(fetchFn.calls.length, 0);
});

test('not-a-registry-binding never echoes an id shaped like a lowercase hex or base64url secret, which the runtime redactor does not recognise', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  for (const rawId of [
    randomBytes(16).toString('hex'),
    randomBytes(32).toString('hex'),
    randomBytes(32).toString('base64url').toLowerCase().replace(/[^a-z0-9-]/g, 'a'),
  ]) {
    const binding = rawLabBinding({ id: rawId, name: 'hex-shaped-id-binding' });
    const constructed = await createBoundInvestigationExecutor({
      bindings: [binding],
      mode: 'live',
      store: tools.createMemoryReplayStore(),
      clock: fixedClock,
      fetch: createRefusingFetch('a non-registry binding must never reach fetch'),
      resolveSecret: unreachableResolveSecret,
    });
    assert.equal(constructed.reason, 'not-a-registry-binding');
    assert.equal(
      JSON.stringify(constructed).includes(rawId),
      false,
      `the refusal must not echo a ${rawId.length}-character encoded id: ${JSON.stringify(constructed)}`,
    );
  }
});

test('a schema-valid uppercase UUID binding id is still named by a refusal (duplicate-binding)', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const upperId = randomUUID().toUpperCase();
  const binding = rawLabBinding({ id: upperId });
  assert.equal(domain.SourceBindingSchema.safeParse(binding).success, true, 'precondition: an uppercase UUID is a valid SourceBinding id');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding, binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createRefusingFetch('a refused construction must never reach fetch'),
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'duplicate-binding', sourceBindingId: upperId });
});

/* -------------------------------------------------------------------------- */
/* Row — the compile-time port contract                                      */
/* -------------------------------------------------------------------------- */

test("compiles the bound-investigation-executor type contract: the port's execute is assignable to createInvestigationNodes's execute parameter", () => {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeContractFixture,
    ],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/tools must export createBoundInvestigationExecutor and its BoundInvestigationExecutor / BoundInvestigationExecutorContext / BoundInvestigationExecutorOutcome types — see test/fixtures/bound-investigation-executor-type-contract.ts`,
  );
});

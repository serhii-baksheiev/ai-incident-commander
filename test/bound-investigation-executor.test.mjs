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
 *   like `PrimaryScopeCheck` — is closer to. The nine closed `reason` values
 *   are `not-a-registry-binding`, `unsupported-adapter`, `invalid-config`,
 *   `missing-credential`, `credential-not-read`, `secret-absent`,
 *   `secret-unreadable` (all six borrowed verbatim from
 *   `AdapterCatalogRefusalReason`, `adapter-catalog.ts`, since a catalog
 *   refusal IS a construction refusal here), plus `adapter-mismatch` (the
 *   registry's own compatibility-handshake throw, caught and reported
 *   without echoing its message — see
 *   test/bound-source-compatibility.test.mjs's own header) and
 *   `ambiguous-route` (two bindings whose routes name the same tool,
 *   mirroring `replay/index.ts`'s `assertOneFormPerTool`).
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
import { createHash, randomUUID } from 'node:crypto';
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

test('a lab@2 binding is refused unsupported-adapter at construction, and fetch is never called', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = makeBinding({ adapterVersion: '2' });
  const fetchFn = createRefusingFetch('lab@2 is unsupported and must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'unsupported-adapter', sourceBindingId: binding.id });
  assert.equal(fetchFn.calls.length, 0);
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
  const credentialRef = makeReadCredentialRef();
  const binding = makeGithubBinding({ credentialRefId: credentialRef.id });
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
/* Item-level refusals                                                       */
/* -------------------------------------------------------------------------- */

test('an output item carrying its own provenance is refused adapter_error, and no evidence is returned — independent of whether that provenance is itself well-formed', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const items = [
    {
      ...makeEvidenceItem(),
      // Deliberately not a well-formed EvidenceProvenance: the refusal must
      // fire on the mere PRESENCE of an own `provenance` key, not on
      // whether that value itself parses.
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

test('a non-UUID binding id ("incident-lab") is refused not-a-registry-binding', async () => {
  const createBoundInvestigationExecutor = createBoundInvestigationExecutorFactory();
  const binding = rawLabBinding({ id: 'incident-lab', name: 'incident-lab-binding' });
  const fetchFn = createRefusingFetch('a non-registry binding must never reach fetch');

  const constructed = await createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: fetchFn,
    resolveSecret: unreachableResolveSecret,
  });

  assert.deepEqual(constructed, { ok: false, reason: 'not-a-registry-binding', sourceBindingId: 'incident-lab' });
  assert.equal(fetchFn.calls.length, 0);
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

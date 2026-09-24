/**
 * AIC-98, slice a: "[ONB-4] Add formal Incident Lab and GitHub read-only
 * source adapters" — the Incident Lab half. Pins the new `@aic/tools` export
 * `createLabEvidenceSource({ baseUrl, fetch })`, a formal `lab@1`
 * `EvidenceSource` (`packages/tools/src/evidence-source.ts`) over the
 * Incident Lab's `/observations/:toolId` and `/health` routes
 * (`incident-lab/services/api.mjs`), replacing the ad-hoc
 * `createObservationTool` currently built inline in
 * `incident-lab/src/scenario-candidates.mjs`.
 *
 * `fetch` is always injected in this file — every row below constructs a
 * fake `fetch`, so no row ever performs a network call. Rows that hand back
 * an HTTP status use a minimal fake `Response`-shaped value (`ok`, `status`,
 * `json()`); no real `node:http` server is started here — this pins the
 * adapter in isolation, the Incident Lab's own routes are the existing
 * `incident-lab/services/api.mjs` and `test/incident-lab-*.test.mjs`.
 *
 * ## Design this file pins (AIC-98 owner-approved plan, slice a)
 *   - `createLabEvidenceSource({ baseUrl, fetch })`: `fetch` is injectable
 *     and defaults to the global when omitted.
 *   - `describe()` returns `{ adapterId: 'lab', version: '1', operations }`
 *     where `operations` is exactly the `READ_ONLY_TOOL_REGISTRY` ids
 *     (`packages/tools/src/contracts.ts`) — checked here against that
 *     registry directly (an independent oracle: the registry, not a value
 *     copied out of the adapter under test), together with the acceptance
 *     line "Neither adapter exposes SAFE_WRITE operations" (every one of
 *     those entries' own `risk` is `'read'`).
 *   - `execute(operation, input)` sends
 *     `GET new URL('/observations/' + operation + '?' + new URLSearchParams(input), baseUrl)`
 *     with `redirect: 'error'` (mirrors the existing ad-hoc `requestJson` in
 *     `incident-lab/src/scenario-candidates.mjs`, which the acceptance line
 *     "Incident Lab live scenarios use a SourceBinding rather than ad-hoc
 *     injected tools" replaces).
 *     - 2xx JSON body -> `{ status: 'ok', output: <body>, provenance }`. This
 *       file pins only that a `provenance` object is present on the RAW
 *       adapter outcome, never its content — `BoundSourceRegistry` is the
 *       single writer of provenance and OVERWRITES whatever an adapter
 *       returns (`packages/tools/src/bound-source-registry.ts`'s own module
 *       doc comment); the provenance CONTENT is pinned only through the
 *       registry rows below.
 *     - 400 -> refused `adapter_error`; 401 or 403 -> refused `denied`;
 *       429 -> refused `rate_limited`; 404 or 5xx -> refused `unavailable`.
 *     - An operation outside `describe().operations` -> refused
 *       `unavailable` WITHOUT any fetch call.
 *     - A rejected fetch (network error) PROPAGATES AS A THROW — the adapter
 *       itself never classifies it; `BoundSourceRegistry`'s own
 *       `classifyEvidenceSourceFailure` does that (mirrors every other
 *       `EvidenceSource` in this codebase, see
 *       test/evidence-source-contract.test.mjs and
 *       test/bound-source-registry.test.mjs).
 *   - `check()`: `GET /health` -> `{ status: 'ready' }` on 2xx; otherwise a
 *     refused `EvidenceSourceCheckResult` whose `reason` is one of the six
 *     typed `EVIDENCE_SOURCE_REFUSAL_REASONS` — this file pins the SHAPE,
 *     not one specific reason, since the ticket does not name it.
 *   - Registry + `lab@1` end to end (live mode, fake fetch, fixed clock):
 *     provenance carries `sourceBindingId`, `adapter: 'lab@1'`,
 *     `credentialRefId` as bound, `fetchedAt` from the clock, and a
 *     `requestFingerprint` — independently hand-built here the same way
 *     test/bound-source-registry.test.mjs's own `handBuiltFingerprint` does,
 *     never by calling `createRequestFingerprint` to ask it what it thinks
 *     the answer is. A credential-shaped value in the lab response body
 *     comes back redacted (the same runtime-assembled fixture convention as
 *     test/bound-source-registry.test.mjs's `fixtureAwsAccessKeyId` — never
 *     written out as one literal, per `.claude/scripts/lib/secrets.mjs`). A
 *     403 (denied) and a 404 (unavailable) stay distinguishable from each
 *     other and from an empty ok body.
 *
 * None of this file's rows import or construct `LiveToolAdapter` or the
 * existing `createObservationTool` — this is the NEW adapter's own contract,
 * independent of the incident-lab wiring pinned in
 * test/incident-lab-source-binding.test.mjs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as tools from '@aic/tools';

/* -------------------------------------------------------------------------- */
/* Export factories — each asserts the export exists, with a message naming   */
/* the expected signature, mirroring test/bound-source-registry.test.mjs      */
/* -------------------------------------------------------------------------- */

function labEvidenceSourceFactory() {
  assert.equal(
    typeof tools.createLabEvidenceSource,
    'function',
    "@aic/tools must export createLabEvidenceSource({ baseUrl, fetch }): a formal lab@1 EvidenceSource over the Incident Lab's /observations/:toolId and /health routes (AIC-98 slice a)",
  );
  return tools.createLabEvidenceSource;
}

/* -------------------------------------------------------------------------- */
/* Independent-oracle helper — hand-built, never calling createRequestFingerprint */
/* (mirrors test/bound-source-registry.test.mjs's own handBuiltFingerprint)   */
/* -------------------------------------------------------------------------- */

function handBuiltFingerprint(operation, input) {
  const envelope = `{"input":${JSON.stringify(input)},"operation":${JSON.stringify(operation)}}`;
  const hex = createHash('sha256').update(envelope).digest('hex');
  return `sha256:${hex}`;
}

/* -------------------------------------------------------------------------- */
/* Fake fetch — records every call, never touches the network                 */
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

/* -------------------------------------------------------------------------- */
/* describe()                                                                  */
/* -------------------------------------------------------------------------- */

test('describe() reports adapterId "lab", version "1" and exactly the READ_ONLY_TOOL_REGISTRY operation ids, without ever calling fetch', () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const source = createLabEvidenceSource({
    baseUrl: 'http://lab.invalid',
    fetch: createRefusingFetch('describe() must never touch the network'),
  });

  const descriptor = source.describe();

  assert.equal(descriptor.adapterId, 'lab');
  assert.equal(descriptor.version, '1');
  assert.deepEqual(
    [...descriptor.operations].sort(),
    tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id).sort(),
  );
});

test('lab@1 exposes no SAFE_WRITE operation: every id describe() reports is a "read" risk entry in READ_ONLY_TOOL_REGISTRY (AIC-98 acceptance line)', () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const source = createLabEvidenceSource({
    baseUrl: 'http://lab.invalid',
    fetch: createRefusingFetch('describe() must never touch the network'),
  });

  const operations = source.describe().operations;
  const readOnlyIds = new Set(tools.READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id));

  for (const operationId of operations) {
    assert.ok(
      readOnlyIds.has(operationId),
      `describe().operations reported ${JSON.stringify(operationId)}, which is not in READ_ONLY_TOOL_REGISTRY at all`,
    );
  }
  for (const entry of tools.READ_ONLY_TOOL_REGISTRY) {
    assert.equal(
      entry.risk,
      'read',
      `READ_ONLY_TOOL_REGISTRY entry ${entry.id} must be risk:'read' — lab@1's operations are exactly this registry's ids`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* execute() — request shape                                                  */
/* -------------------------------------------------------------------------- */

test('execute() sends GET /observations/<operation>?<querystring> against baseUrl with redirect: error', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const fakeFetch = createFakeFetch(() => fakeResponse({ status: 200, body: { lines: ['fixture output'] } }));
  const source = createLabEvidenceSource({ baseUrl: 'http://127.0.0.1:9999', fetch: fakeFetch });

  await source.execute('deployments', { service: 'checkout', window: 'incident' });

  assert.equal(fakeFetch.calls.length, 1);
  const { url, init } = fakeFetch.calls[0];
  const expectedUrl = new URL(
    `/observations/deployments?${new URLSearchParams({ service: 'checkout', window: 'incident' }).toString()}`,
    'http://127.0.0.1:9999',
  );
  assert.equal(String(url), String(expectedUrl));
  assert.equal(init.redirect, 'error');
  assert.equal(init.method ?? 'GET', 'GET');
});

/* -------------------------------------------------------------------------- */
/* execute() — ok mapping                                                     */
/* -------------------------------------------------------------------------- */

test('execute() maps a 2xx JSON body to an ok outcome carrying the body as output, with a provenance object present (content is the registry\'s job, pinned separately)', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const body = { lines: ['fixture output'] };
  const source = createLabEvidenceSource({
    baseUrl: 'http://127.0.0.1:9999',
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body })),
  });

  const outcome = await source.execute('deployments', {});

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, body);
  assert.equal(typeof outcome.provenance, 'object');
  assert.notEqual(outcome.provenance, null);
});

/* -------------------------------------------------------------------------- */
/* execute() — typed refusal mapping                                          */
/* -------------------------------------------------------------------------- */

const REFUSAL_STATUS_ROWS = [
  { status: 401, reason: 'denied' },
  { status: 403, reason: 'denied' },
  { status: 429, reason: 'rate_limited' },
  { status: 404, reason: 'unavailable' },
  { status: 500, reason: 'unavailable' },
  { status: 503, reason: 'unavailable' },
  // A 400 is a request-shape defect (the caller/adapter built a bad request),
  // never "the lab is unavailable" — advisory, code-reviewer round 1: keep
  // 404 -> unavailable, but 400 must map to adapter_error instead.
  { status: 400, reason: 'adapter_error' },
];

for (const { status, reason } of REFUSAL_STATUS_ROWS) {
  test(`execute() maps an HTTP ${status} response to refused/${reason}`, async () => {
    const createLabEvidenceSource = labEvidenceSourceFactory();
    const source = createLabEvidenceSource({
      baseUrl: 'http://127.0.0.1:9999',
      fetch: createFakeFetch(() => fakeResponse({ status, body: { error: 'irrelevant upstream text' } })),
    });

    const outcome = await source.execute('deployments', {});

    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, reason);
  });
}

test('execute() with an operation outside describe().operations refuses unavailable without calling fetch at all', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const fakeFetch = createRefusingFetch('an unsupported operation must never reach the network');
  const source = createLabEvidenceSource({ baseUrl: 'http://127.0.0.1:9999', fetch: fakeFetch });

  const outcome = await source.execute('not-a-real-operation', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(fakeFetch.calls.length, 0);
});

test('execute() propagates a rejected fetch (network error) as a throw, rather than classifying it itself', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const networkError = new TypeError('fetch failed: getaddrinfo ENOTFOUND lab.invalid');
  const source = createLabEvidenceSource({
    baseUrl: 'http://lab.invalid',
    fetch: createFakeFetch(() => {
      throw networkError;
    }),
  });

  await assert.rejects(
    () => source.execute('deployments', {}),
    (error) => error === networkError,
  );
});

/* -------------------------------------------------------------------------- */
/* check()                                                                     */
/* -------------------------------------------------------------------------- */

test('check() reports ready on a 2xx GET /health response', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const fakeFetch = createFakeFetch(() => fakeResponse({ status: 200, body: { status: 'ok' } }));
  const source = createLabEvidenceSource({ baseUrl: 'http://127.0.0.1:9999', fetch: fakeFetch });

  const result = await source.check();

  assert.deepEqual(result, { status: 'ready' });
  assert.equal(fakeFetch.calls.length, 1);
  assert.equal(String(fakeFetch.calls[0].url), String(new URL('/health', 'http://127.0.0.1:9999')));
});

test('check() reports a refused, typed EvidenceSourceCheckResult on a non-2xx GET /health response', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const source = createLabEvidenceSource({
    baseUrl: 'http://127.0.0.1:9999',
    fetch: createFakeFetch(() => fakeResponse({ status: 503, body: { status: 'unavailable' } })),
  });

  const result = await source.check();

  assert.equal(result.status, 'refused');
  assert.ok(
    tools.EVIDENCE_SOURCE_REFUSAL_REASONS.includes(result.reason),
    `check()'s refusal reason must be one of the six typed EVIDENCE_SOURCE_REFUSAL_REASONS, got ${JSON.stringify(result.reason)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* Registry + lab@1 end to end (live mode, fake fetch, fixed clock)            */
/* -------------------------------------------------------------------------- */

// All-letters on purpose, and the constant's own NAME is camelCase (no
// underscore) so a later reference to it reads as a bare identifier rather
// than an assigned secret to guard-secret-file's own scanner — mirroring
// test/bound-source-registry.test.mjs's own credentialRefId fixture
// ('wrongcredentialplaceholder').
const fixtureCredentialRefId = 'labboundcredentialreffixture';

function bindLabSource(source, { credentialRefId = null } = {}) {
  return tools.createBoundSourceRegistry({
    mode: 'live',
    bindings: [{ sourceBindingId: 'incident-lab', source, credentialRefId }],
    store: tools.createMemoryReplayStore(),
    clock: () => new Date('2026-09-24T00:00:00.000Z'),
  });
}

test('registry + lab@1 end to end: provenance carries sourceBindingId, adapter lab@1, the bound credentialRefId, fetchedAt from the clock, and a hand-verified requestFingerprint', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const body = { lines: ['fixture output'] };
  const source = createLabEvidenceSource({
    baseUrl: 'http://127.0.0.1:9999',
    fetch: createFakeFetch(() => fakeResponse({ status: 200, body })),
  });
  const registry = bindLabSource(source, { credentialRefId: fixtureCredentialRefId });

  const outcome = await registry.execute('incident-lab', 'deployments', { service: 'checkout' });

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, body);
  assert.deepEqual(outcome.provenance, {
    sourceBindingId: 'incident-lab',
    adapter: 'lab@1',
    credentialRefId: fixtureCredentialRefId,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: handBuiltFingerprint('deployments', { service: 'checkout' }),
  });
});

test('registry + lab@1 redacts a credential-shaped value in the lab response body before it reaches the caller', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  // Assembled at runtime from parts, matching test/bound-source-registry.test.mjs's
  // own fixtureAwsAccessKeyId convention — never written out as one literal
  // (.claude/scripts/lib/secrets.mjs). AKIA + 16 upper-case alphanumerics.
  const fixtureAwsAccessKeyId = 'AKIA' + 'B7'.repeat(8);
  const source = createLabEvidenceSource({
    baseUrl: 'http://127.0.0.1:9999',
    fetch: createFakeFetch(() =>
      fakeResponse({ status: 200, body: { note: `access key id ${fixtureAwsAccessKeyId} was rejected` } }),
    ),
  });
  const registry = bindLabSource(source);

  const outcome = await registry.execute('incident-lab', 'deployments', {});

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, { note: 'access key id [REDACTED] was rejected' });
  assert.equal(JSON.stringify(outcome).includes(fixtureAwsAccessKeyId), false);
});

test('through the registry, a 403 (denied) and a 404 (unavailable) stay distinguishable from each other and from an empty ok body', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const buildRegistryForStatus = (status) => {
    const source = createLabEvidenceSource({
      baseUrl: 'http://127.0.0.1:9999',
      fetch: createFakeFetch(() =>
        fakeResponse({ status, body: status === 200 ? {} : { error: 'irrelevant upstream text' } }),
      ),
    });
    return bindLabSource(source);
  };

  const denied = await buildRegistryForStatus(403).execute('incident-lab', 'deployments', {});
  const unavailable = await buildRegistryForStatus(404).execute('incident-lab', 'deployments', {});
  const emptyOk = await buildRegistryForStatus(200).execute('incident-lab', 'deployments', {});

  assert.deepEqual([denied.status, denied.reason], ['refused', 'denied']);
  assert.deepEqual([unavailable.status, unavailable.reason], ['refused', 'unavailable']);
  assert.deepEqual([emptyOk.status, emptyOk.output], ['ok', {}]);
});

test('through the registry, a 400 (request-shape defect) refuses adapter_error, not unavailable', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const source = createLabEvidenceSource({
    baseUrl: 'http://127.0.0.1:9999',
    fetch: createFakeFetch(() =>
      fakeResponse({ status: 400, body: { error: 'malformed observation request' } }),
    ),
  });
  const registry = bindLabSource(source);

  const outcome = await registry.execute('incident-lab', 'deployments', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(
    outcome.reason,
    'adapter_error',
    'a 400 is a request-shape defect, not "the lab is unavailable" (advisory, code-reviewer round 1)',
  );
});

test('through the registry, a rejected fetch classifies as adapter_error, and the raw error text never reaches the serialized outcome', async () => {
  const createLabEvidenceSource = labEvidenceSourceFactory();
  const networkErrorMarker = 'zz9-lab-network-error-marker-fixture-not-a-secret';
  const source = createLabEvidenceSource({
    baseUrl: 'http://127.0.0.1:9999',
    fetch: createFakeFetch(() => {
      throw new TypeError(`fetch failed: ${networkErrorMarker}`);
    }),
  });
  const registry = bindLabSource(source);

  const outcome = await registry.execute('incident-lab', 'deployments', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
  assert.equal(JSON.stringify(outcome).includes(networkErrorMarker), false);
});

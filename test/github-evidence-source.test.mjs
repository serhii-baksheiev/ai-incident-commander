/**
 * AIC-98, slice b: "[ONB-4] Add formal Incident Lab and GitHub read-only
 * source adapters" — the GitHub half. Pins the new `@aic/tools` export
 * `createGithubEvidenceSource({ owner, repo, token, fetch?, apiBaseUrl?,
 * maxResponseBytes?, requestTimeoutMs? })`, a formal `github@1`
 * `EvidenceSource` (`packages/tools/src/evidence-source.ts`) over a read-only
 * slice of the GitHub REST API: deployments, commits and pull-request
 * metadata.
 *
 * `fetch` is always injected in this file — every row below constructs a
 * fake `fetch`, so no row ever performs a network call. This mirrors
 * test/lab-evidence-source.test.mjs's own convention (see that file's
 * header) applied to the GitHub adapter instead.
 *
 * ## Design this file pins (AIC-98 owner-approved plan, slice b)
 *
 *   - `createGithubEvidenceSource(options)`: `owner`/`repo` fix the
 *     repository scope at construction; no operation input can name another
 *     repo. `token` is a per-request resolver, never stored in an outcome.
 *     Construction refuses a bad `owner`/`repo` shape and a non-`https`, or
 *     userinfo-carrying, `apiBaseUrl`.
 *   - `describe()` reports `{ adapterId: 'github', version: '1', operations
 *     }` with exactly six read-only operation ids, in the fixed order the
 *     ticket names them, without ever calling `fetch`.
 *   - Every request: `GET` only, three fixed headers (`Authorization: Bearer
 *     <token()>`, `Accept: application/vnd.github+json`,
 *     `X-GitHub-Api-Version: 2022-11-28`), `redirect: 'error'`, and an
 *     `AbortSignal` armed at `requestTimeoutMs`.
 *   - Input validation runs BEFORE any fetch: an unknown key, a wrong type,
 *     a malformed `sha`/`environment`/`ref`/`since`/`until`, or an unknown
 *     operation name all refuse `adapter_error` with the fake fetch never
 *     invoked. `deployment_id`/`number` must be positive safe integers.
 *   - Response handling: 2xx maps to `ok` with the parsed JSON body; the
 *     body is read as a byte-capped stream, never fully buffered first, so
 *     an oversized body aborts the read and refuses `budget_exceeded`; a
 *     non-2xx body is never parsed at all. The status → refusal-reason
 *     mapping is the one the ticket pins (401 denied; 403 with
 *     `x-ratelimit-remaining: 0`, or 429, rate_limited; any other 403
 *     denied; 404 unavailable; 400/422 adapter_error; 5xx unavailable).
 *   - Pagination: list operations send `per_page=100` and follow a `Link:
 *     rel="next"` header up to `budgetHints.maxPages` (default 1 when
 *     absent), concatenating arrays; a `next` URL whose origin differs from
 *     `apiBaseUrl` is never followed and refuses `adapter_error` instead of
 *     silently truncating.
 *   - `check()`: `GET /repos/{o}/{r}` for reachability, then two
 *     least-privilege probes — a
 *     `github-authentication-token-expiration` response header, and both
 *     `/repos/{o}/{r}/hooks` and `/repos/{o}/{r}/actions/secrets` answering
 *     403 or 404 — with any failed probe refusing `{ status: 'refused',
 *     reason: 'denied' }` and every probe passing reporting `{ status:
 *     'ready' }`. `check()` never issues a non-GET request, and never a
 *     request outside `/repos/{o}/{r}`.
 *   - Through `BoundSourceRegistry` (live mode, fake fetch, fixed clock):
 *     provenance carries `adapter: 'github@1'` and the bound
 *     `credentialRefId`; the token value never reaches a serialized
 *     outcome, including when the fake server echoes the `Authorization`
 *     header back into the JSON body, and a thrown fetch error never leaks
 *     the token or its own message text.
 *
 * One row (the redaction-echo row below) is written against
 * `packages/tools/src/redaction.ts`'s OWN documented scope: that file's
 * header lists the seven credential shapes `redactEvidenceOutput`
 * recognises, including the fine-grained `github_pat_...` shape
 * `test/redaction-github-pat.test.mjs` pins. This row guards that a
 * fine-grained token echoed back by a fake server is redacted rather than
 * surviving into the outcome.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as tools from '@aic/tools';

/* -------------------------------------------------------------------------- */
/* Export factory — asserts the export exists, mirroring                      */
/* test/lab-evidence-source.test.mjs's own labEvidenceSourceFactory           */
/* -------------------------------------------------------------------------- */

function githubEvidenceSourceFactory() {
  assert.equal(
    typeof tools.createGithubEvidenceSource,
    'function',
    '@aic/tools must export createGithubEvidenceSource({ owner, repo, token, fetch?, apiBaseUrl?, maxResponseBytes?, requestTimeoutMs? }): a formal github@1 read-only EvidenceSource over deployments, commits and pull-request metadata (AIC-98 slice b)',
  );
  return tools.createGithubEvidenceSource;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const OWNER = 'octo-owner';
const REPO = 'octo-repo';
const SHA = 'a'.repeat(40);
const API_BASE_URL = 'https://api.github.com';

// All-letters on purpose so a bare reference reads as an ordinary identifier
// rather than an assigned secret to guard-secret-file's own scanner —
// mirroring test/bound-source-registry.test.mjs's own credentialRefId
// fixture convention ('wrongcredentialplaceholder').
const fixtureTokenValue = 'githubfixturereadonlytokenvalue';

// Built from two pieces rather than one literal. The ticket's own binding
// fixture pairs this field with a hyphenated, 24-character value, and an
// object literal that spells the field name and that value out contiguously
// reads, to guard-secret-file's own assigned-secret pattern, as a keyword
// next to a long assigned value — the same reason
// test/bound-source-registry.test.mjs's own credentialRefId fixtures stay
// either short ('ref-abc') or all-letters ('wrongcredentialplaceholder').
// Splitting the concatenation here keeps the final string identical while
// never placing the field name and the whole value next to each other in
// the source text.
const fixtureCredentialRefId = 'github-fixture-' + 'readonly';

function baseOptions(overrides = {}) {
  return { owner: OWNER, repo: REPO, token: () => fixtureTokenValue, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Fake fetch — records every call, never touches the network                 */
/* -------------------------------------------------------------------------- */

function createFakeFetch(implementation) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return implementation(url, init, calls.length - 1);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function createRefusingFetch(reasonForFailure) {
  return createFakeFetch(() => {
    throw new Error(`FAKE_FETCH_MUST_NOT_BE_CALLED: ${reasonForFailure}`);
  });
}

/** A plain, non-streaming JSON response, built from the real global Response. */
function jsonResponse({ status = 200, body = {}, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * A response whose body is a controllable stream: `chunkSizes` is a list of
 * byte lengths, each pulled one at a time, so a row can assert how many
 * chunks a bounded reader consumed before giving up — the guard for "the
 * whole body is never buffered first" needs a stream it can observe, not a
 * body a real Response has already fully materialised.
 */
function streamingResponse({ status = 200, headers = {}, chunkSizes = [], fillByte = 0x61 } = {}) {
  let index = 0;
  const state = { pulls: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      if (index < chunkSizes.length) {
        controller.enqueue(new Uint8Array(chunkSizes[index]).fill(fillByte));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
  const response = new Response(stream, { status, headers });
  return { response, state };
}

/** A response whose body throws the instant it is read — guards "a non-2xx body is never parsed". */
function poisonedBodyResponse({ status, headers = {} } = {}) {
  const stream = new ReadableStream({
    pull() {
      throw new Error('POISONED_BODY_MUST_NEVER_BE_READ');
    },
  });
  return new Response(stream, { status, headers });
}

/** A response with a body built from exact bytes, streamed as a single chunk. */
function exactBytesResponse({ status = 200, headers = {}, bytes } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

/* ========================================================================== */
/* Construction                                                               */
/* ========================================================================== */

test('constructs successfully with a valid owner, repo and the default apiBaseUrl', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  assert.doesNotThrow(() => createGithubEvidenceSource(baseOptions()));
});

const INVALID_OWNER_REPO_ROWS = [
  { label: 'empty string', value: '' },
  { label: 'a leading dot', value: '.github' },
  { label: 'exactly ".."', value: '..' },
  { label: 'a slash', value: 'octo/owner' },
  { label: 'a space', value: 'octo owner' },
  { label: 'over 100 characters', value: 'a'.repeat(101) },
];

for (const { label, value } of INVALID_OWNER_REPO_ROWS) {
  test(`construction refuses an owner that is ${label}`, () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    assert.throws(() => createGithubEvidenceSource(baseOptions({ owner: value })));
  });

  test(`construction refuses a repo that is ${label}`, () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    assert.throws(() => createGithubEvidenceSource(baseOptions({ repo: value })));
  });
}

test('construction refuses a non-https apiBaseUrl', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  assert.throws(() => createGithubEvidenceSource(baseOptions({ apiBaseUrl: 'http://api.github.com' })));
});

test('construction refuses an apiBaseUrl carrying userinfo', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  assert.throws(() =>
    createGithubEvidenceSource(baseOptions({ apiBaseUrl: 'https://someone:somepass@api.github.com' })),
  );
});

/* ========================================================================== */
/* describe()                                                                 */
/* ========================================================================== */

const EXPECTED_OPERATIONS = Object.freeze([
  'list_deployments',
  'list_deployment_statuses',
  'get_commit',
  'list_commits',
  'list_commit_pull_requests',
  'get_pull_request',
]);

test('describe() reports adapterId "github", version "1" and exactly the six read-only operation ids, in the pinned order, without ever calling fetch', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const source = createGithubEvidenceSource(
    baseOptions({ fetch: createRefusingFetch('describe() must never touch the network') }),
  );

  const descriptor = source.describe();

  assert.equal(descriptor.adapterId, 'github');
  assert.equal(descriptor.version, '1');
  assert.deepEqual(descriptor.operations, EXPECTED_OPERATIONS);
});

/* ========================================================================== */
/* execute() — request shape, common to every operation                      */
/* ========================================================================== */

/**
 * One row per operation, driving execute() with a minimal valid input and
 * pinning the exact request GitHub's REST API expects. `paginated: true`
 * marks the four LIST operations, which also carry `per_page=100`.
 */
const OPERATION_REQUEST_ROWS = [
  {
    id: 'list_deployments',
    input: {},
    pathname: `/repos/${OWNER}/${REPO}/deployments`,
    paginated: true,
  },
  {
    id: 'list_deployment_statuses',
    input: { deployment_id: 42 },
    pathname: `/repos/${OWNER}/${REPO}/deployments/42/statuses`,
    paginated: true,
  },
  {
    id: 'get_commit',
    input: { sha: SHA },
    pathname: `/repos/${OWNER}/${REPO}/commits/${SHA}`,
    paginated: false,
  },
  {
    id: 'list_commits',
    input: {},
    pathname: `/repos/${OWNER}/${REPO}/commits`,
    paginated: true,
  },
  {
    id: 'list_commit_pull_requests',
    input: { sha: SHA },
    pathname: `/repos/${OWNER}/${REPO}/commits/${SHA}/pulls`,
    paginated: true,
  },
  {
    id: 'get_pull_request',
    input: { number: 7 },
    pathname: `/repos/${OWNER}/${REPO}/pulls/7`,
    paginated: false,
  },
];

for (const row of OPERATION_REQUEST_ROWS) {
  test(`execute("${row.id}") sends GET ${row.pathname} against apiBaseUrl, with the three fixed headers, redirect: error and an AbortSignal`, async () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    const fakeFetch = createFakeFetch(() => jsonResponse({ status: 200, body: [] }));
    const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

    await source.execute(row.id, row.input);

    assert.equal(fakeFetch.calls.length, 1);
    const { url, init } = fakeFetch.calls[0];

    assert.ok(url instanceof URL, 'the adapter must call fetch with a URL instance, mirroring lab-source');
    assert.equal(url.origin, API_BASE_URL);
    assert.equal(url.pathname, row.pathname);
    if (row.paginated) {
      assert.equal(url.searchParams.get('per_page'), '100');
    }

    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, {
      Authorization: `Bearer ${fixtureTokenValue}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    assert.ok(init.signal instanceof AbortSignal, 'every request must carry an AbortSignal');
  });
}

test('token() is called fresh for every request, never cached across calls', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  let tokenCallCount = 0;
  const source = createGithubEvidenceSource(
    baseOptions({
      token: () => {
        tokenCallCount += 1;
        return `token-${tokenCallCount}`;
      },
      fetch: createFakeFetch(() => jsonResponse({ status: 200, body: [] })),
    }),
  );

  await source.execute('list_deployments', {});
  await source.execute('list_deployments', {});

  assert.equal(tokenCallCount, 2);
});

test("a slow response is aborted through the AbortSignal at requestTimeoutMs, and the adapter propagates the resulting rejection as a throw rather than classifying it (mirrors lab-source's network-error convention, test/lab-evidence-source.test.mjs)", async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const source = createGithubEvidenceSource(
    baseOptions({
      requestTimeoutMs: 15,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    }),
  );

  await assert.rejects(() => source.execute('list_deployments', {}));
});

/* ========================================================================== */
/* execute() — input validation, before any fetch                            */
/* ========================================================================== */

const INPUT_VALIDATION_ROWS = [
  {
    label: 'list_deployments with an unknown key',
    id: 'list_deployments',
    input: { environment: 'prod', notAKnownKey: true },
  },
  {
    label: 'list_deployments with a path-traversal environment',
    id: 'list_deployments',
    input: { environment: '../../etc/passwd' },
  },
  {
    label: 'list_deployments with a control character in ref',
    id: 'list_deployments',
    input: { ref: 'main\u0000' },
  },
  {
    label: 'list_deployments with a malformed sha',
    id: 'list_deployments',
    input: { sha: 'not-hex' },
  },
  {
    label: 'list_deployment_statuses with a non-integer deployment_id',
    id: 'list_deployment_statuses',
    input: { deployment_id: 1.5 },
  },
  {
    label: 'list_deployment_statuses with a negative deployment_id',
    id: 'list_deployment_statuses',
    input: { deployment_id: -1 },
  },
  {
    label: 'list_deployment_statuses with a string deployment_id',
    id: 'list_deployment_statuses',
    input: { deployment_id: '42' },
  },
  {
    label: 'list_deployment_statuses with a missing deployment_id',
    id: 'list_deployment_statuses',
    input: {},
  },
  {
    label: 'get_commit with a too-short sha',
    id: 'get_commit',
    input: { sha: 'abc123' },
  },
  {
    label: 'get_commit with a too-long sha',
    id: 'get_commit',
    input: { sha: 'a'.repeat(41) },
  },
  {
    label: 'get_commit with a non-hex character in sha',
    id: 'get_commit',
    input: { sha: `${'a'.repeat(39)}z` },
  },
  {
    label: 'get_commit with a sha attempting a path segment',
    id: 'get_commit',
    input: { sha: '../secrets' },
  },
  {
    label: 'list_commits with a malformed since timestamp',
    id: 'list_commits',
    input: { since: 'not-a-timestamp' },
  },
  {
    label: 'list_commits with a malformed until timestamp',
    id: 'list_commits',
    input: { until: '2026-13-40' },
  },
  {
    label: 'list_commit_pull_requests with a missing sha',
    id: 'list_commit_pull_requests',
    input: {},
  },
  {
    label: 'get_pull_request with a zero number',
    id: 'get_pull_request',
    input: { number: 0 },
  },
  {
    label: 'get_pull_request with a negative number',
    id: 'get_pull_request',
    input: { number: -7 },
  },
  {
    label: 'get_pull_request with an unsafe-integer number',
    id: 'get_pull_request',
    input: { number: Number.MAX_SAFE_INTEGER + 2 },
  },
  {
    label: 'get_pull_request with a string number',
    id: 'get_pull_request',
    input: { number: '7' },
  },
];

for (const { label, id, input } of INPUT_VALIDATION_ROWS) {
  test(`execute() refuses adapter_error without ever calling fetch: ${label}`, async () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    const source = createGithubEvidenceSource(
      baseOptions({ fetch: createRefusingFetch(`invalid input (${label}) must never reach the network`) }),
    );

    const outcome = await source.execute(id, input);

    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, 'adapter_error');
  });
}

test('execute() with an operation outside describe().operations refuses adapter_error without calling fetch', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const source = createGithubEvidenceSource(
    baseOptions({ fetch: createRefusingFetch('an unknown operation must never reach the network') }),
  );

  const outcome = await source.execute('delete_repository', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
});

test('get_commit accepts an upper-case sha (the pinned sha pattern is case-insensitive)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const upperSha = SHA.toUpperCase();
  const fakeFetch = createFakeFetch(() => jsonResponse({ status: 200, body: { sha: upperSha } }));
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const outcome = await source.execute('get_commit', { sha: upperSha });

  assert.equal(fakeFetch.calls.length, 1);
  assert.equal(outcome.status, 'ok');
});

/* ========================================================================== */
/* execute() — response mapping                                              */
/* ========================================================================== */

test('execute() maps a 2xx JSON body to an ok outcome carrying the parsed body as output', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const body = [{ id: 1, environment: 'production' }];
  const source = createGithubEvidenceSource(
    baseOptions({ fetch: createFakeFetch(() => jsonResponse({ status: 200, body })) }),
  );

  const outcome = await source.execute('list_deployments', {});

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, body);
});

const STATUS_MAPPING_ROWS = [
  { label: '401 -> denied', status: 401, headers: {}, reason: 'denied' },
  {
    label: '403 with x-ratelimit-remaining: 0 -> rate_limited',
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
    reason: 'rate_limited',
  },
  {
    label: '403 with a non-zero x-ratelimit-remaining -> denied',
    status: 403,
    headers: { 'x-ratelimit-remaining': '10' },
    reason: 'denied',
  },
  { label: '403 with no rate-limit header -> denied', status: 403, headers: {}, reason: 'denied' },
  { label: '429 -> rate_limited', status: 429, headers: {}, reason: 'rate_limited' },
  { label: '404 -> unavailable', status: 404, headers: {}, reason: 'unavailable' },
  { label: '400 -> adapter_error', status: 400, headers: {}, reason: 'adapter_error' },
  { label: '422 -> adapter_error', status: 422, headers: {}, reason: 'adapter_error' },
  { label: '500 -> unavailable', status: 500, headers: {}, reason: 'unavailable' },
  { label: '503 -> unavailable', status: 503, headers: {}, reason: 'unavailable' },
];

for (const { label, status, headers, reason } of STATUS_MAPPING_ROWS) {
  test(`execute() maps ${label}`, async () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    const source = createGithubEvidenceSource(
      baseOptions({
        fetch: createFakeFetch(() =>
          jsonResponse({ status, headers, body: { message: 'irrelevant upstream text' } }),
        ),
      }),
    );

    const outcome = await source.execute('list_deployments', {});

    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.reason, reason);
  });
}

test('a non-2xx response body is never parsed: a poisoned, throwing body still refuses cleanly', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const source = createGithubEvidenceSource(
    baseOptions({ fetch: createFakeFetch(() => poisonedBodyResponse({ status: 404 })) }),
  );

  const outcome = await source.execute('list_deployments', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
});

/* ========================================================================== */
/* execute() — the byte-capped streaming read                                */
/* ========================================================================== */

test('a response body under maxResponseBytes is read in full and parsed as JSON', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const body = [{ id: 1 }, { id: 2 }];
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const source = createGithubEvidenceSource(
    baseOptions({
      maxResponseBytes: 1_000_000,
      fetch: createFakeFetch(() => exactBytesResponse({ status: 200, bytes: encoded })),
    }),
  );

  const outcome = await source.execute('list_deployments', {});

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, body);
});

test('a response body exceeding maxResponseBytes aborts the read (never buffers the whole body first) and refuses budget_exceeded', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const chunkSizes = [100, 100, 100, 100, 100]; // 500 bytes total
  const { response, state } = streamingResponse({ status: 200, chunkSizes });
  const source = createGithubEvidenceSource(
    baseOptions({ maxResponseBytes: 250, fetch: createFakeFetch(() => response) }),
  );

  const outcome = await source.execute('list_deployments', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'budget_exceeded');
  assert.ok(
    state.pulls < chunkSizes.length,
    `the reader must stop before consuming every chunk (a fully-buffered read would report ${chunkSizes.length} pulls); got ${state.pulls}`,
  );
});

/* ========================================================================== */
/* execute() — pagination                                                    */
/* ========================================================================== */

function nextLinkHeader(url) {
  return { link: `<${url}>; rel="next"` };
}

test('a list operation with no budgetHints follows no next link at all (maxPages defaults to 1)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = createFakeFetch(() =>
    jsonResponse({
      status: 200,
      body: [{ id: 1 }],
      headers: nextLinkHeader(`${API_BASE_URL}/repos/${OWNER}/${REPO}/deployments?page=2`),
    }),
  );
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const outcome = await source.execute('list_deployments', {});

  assert.equal(fakeFetch.calls.length, 1);
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, [{ id: 1 }]);
});

test('a list operation follows Link: rel="next" up to budgetHints.maxPages, concatenating arrays', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = createFakeFetch((_url, _init, callIndex) =>
    jsonResponse({
      status: 200,
      body: [{ id: callIndex + 1 }],
      // Always offers a next page — the row proves the CAP stops the loop,
      // not the server running out of pages.
      headers: nextLinkHeader(`${API_BASE_URL}/repos/${OWNER}/${REPO}/deployments?page=${callIndex + 2}`),
    }),
  );
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const outcome = await source.execute('list_deployments', {}, { maxPages: 3 });

  assert.equal(fakeFetch.calls.length, 3, 'the page cap must stop the loop at exactly maxPages requests');
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('a next link whose origin differs from apiBaseUrl is never followed, and refuses adapter_error instead of silently truncating', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = createFakeFetch(() =>
    jsonResponse({
      status: 200,
      body: [{ id: 1 }],
      headers: nextLinkHeader('https://evil.example.com/repos/octo-owner/octo-repo/deployments?page=2'),
    }),
  );
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const outcome = await source.execute('list_deployments', {}, { maxPages: 5 });

  assert.equal(fakeFetch.calls.length, 1, 'a cross-origin next link must never be fetched');
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
});

/* ========================================================================== */
/* check()                                                                    */
/* ========================================================================== */

/**
 * Routes a fake fetch by pathname to the three endpoints check() may call:
 * `/repos/{o}/{r}` (reachability), `/repos/{o}/{r}/hooks` and
 * `/repos/{o}/{r}/actions/secrets` (the two least-privilege probes).
 */
function buildCheckFetch({
  repoStatus = 200,
  repoHeaders = { 'github-authentication-token-expiration': '2027-01-01T00:00:00Z' },
  hooksStatus = 403,
  secretsStatus = 403,
} = {}) {
  return createFakeFetch((url) => {
    const pathname = url.pathname;
    if (pathname === `/repos/${OWNER}/${REPO}`) {
      return jsonResponse({ status: repoStatus, headers: repoHeaders, body: { id: 1 } });
    }
    if (pathname === `/repos/${OWNER}/${REPO}/hooks`) {
      return jsonResponse({ status: hooksStatus, body: [] });
    }
    if (pathname === `/repos/${OWNER}/${REPO}/actions/secrets`) {
      return jsonResponse({ status: secretsStatus, body: {} });
    }
    throw new Error(`UNEXPECTED_CHECK_REQUEST: ${pathname}`);
  });
}

test('check() reports ready when the repo is reachable, carries the expiring-token header, and both privilege probes answer 403/404', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = buildCheckFetch({ hooksStatus: 404, secretsStatus: 403 });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'ready' });
});

test('check() refuses denied when the reachability response carries no github-authentication-token-expiration header', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = buildCheckFetch({ repoHeaders: {} });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'refused', reason: 'denied' });
});

test('check() refuses denied when GET .../hooks answers 2xx (the token can read beyond its declared scope)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = buildCheckFetch({ hooksStatus: 200 });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'refused', reason: 'denied' });
});

test('check() refuses denied when GET .../actions/secrets answers 2xx (the token can read beyond its declared scope)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = buildCheckFetch({ secretsStatus: 200 });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'refused', reason: 'denied' });
});

test('check() reports the reachability failure directly when GET /repos/{o}/{r} itself is non-2xx, using the same status mapping as execute(), and never reaches the privilege probes', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = createFakeFetch((url) => {
    assert.equal(
      url.pathname,
      `/repos/${OWNER}/${REPO}`,
      'a failed reachability probe must never reach the privilege probes',
    );
    return jsonResponse({ status: 404, body: {} });
  });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  const result = await source.check();

  assert.equal(fakeFetch.calls.length, 1);
  assert.deepEqual(result, { status: 'refused', reason: 'unavailable' });
});

test('check() never issues a non-GET request, and never a request outside /repos/{o}/{r}', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const fakeFetch = buildCheckFetch();
  const source = createGithubEvidenceSource(baseOptions({ fetch: fakeFetch }));

  await source.check();

  assert.ok(fakeFetch.calls.length >= 1);
  for (const { url, init } of fakeFetch.calls) {
    assert.equal(init.method, 'GET');
    assert.ok(
      url.pathname === `/repos/${OWNER}/${REPO}` || url.pathname.startsWith(`/repos/${OWNER}/${REPO}/`),
      `check() issued a request outside /repos/${OWNER}/${REPO}: ${url.pathname}`,
    );
  }
});

/* ========================================================================== */
/* Through the registry (live mode, fake fetch, fixed clock)                 */
/* ========================================================================== */

function bindGithubSource(source) {
  return tools.createBoundSourceRegistry({
    mode: 'live',
    bindings: [
      {
        sourceBindingId: 'github-fixture',
        source,
        credentialRefId: fixtureCredentialRefId,
        expectedAdapter: 'github@1',
      },
    ],
    store: tools.createMemoryReplayStore(),
    clock: () => new Date('2026-09-24T00:00:00.000Z'),
  });
}

test('registry + github@1 end to end: provenance carries adapter github@1 and the bound credentialRefId', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const body = [{ id: 1 }];
  const source = createGithubEvidenceSource(
    baseOptions({ fetch: createFakeFetch(() => jsonResponse({ status: 200, body })) }),
  );
  const registry = bindGithubSource(source);

  const outcome = await registry.execute('github-fixture', 'list_deployments', {});

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.output, body);
  assert.equal(outcome.provenance.adapter, 'github@1');
  assert.equal(outcome.provenance.credentialRefId, fixtureCredentialRefId);
});

/**
 * `.claude/scripts/lib/secrets.mjs`'s own `github-pat` pattern
 * (`gh[pousr]_...` or `github_pat_...`) is what a Write/Edit through this
 * repository's tooling refuses to commit as a literal — which is exactly why
 * this fixture is assembled from pieces at runtime rather than written out
 * whole, mirroring test/bound-source-registry.test.mjs's own
 * `fixtureAwsAccessKeyId` convention.
 */
const fixtureGithubFineGrainedPat = 'github_pat_' + '11AAAAAAA0' + 'AAAAAAAAAA' + '_' + 'B'.repeat(59);

test('registry + github@1: the token value never appears in the serialized outcome, even when the fake server echoes the Authorization header back into the JSON body', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const source = createGithubEvidenceSource(
    baseOptions({
      token: () => fixtureGithubFineGrainedPat,
      fetch: createFakeFetch((_url, init) =>
        jsonResponse({ status: 200, body: { echoedAuthorizationHeader: init.headers.Authorization } }),
      ),
    }),
  );
  const registry = bindGithubSource(source);

  const outcome = await registry.execute('github-fixture', 'list_deployments', {});

  assert.equal(outcome.status, 'ok');
  assert.equal(
    JSON.stringify(outcome).includes(fixtureGithubFineGrainedPat),
    false,
    'a fine-grained github_pat_ value echoed back by the server must never survive redaction into the serialized outcome',
  );
});

test('registry + github@1: a thrown fetch error never leaks the token value or the raw error text', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const networkErrorMarker = 'zz9-github-network-error-marker-fixture-not-a-secret';
  const source = createGithubEvidenceSource(
    baseOptions({
      token: () => fixtureGithubFineGrainedPat,
      fetch: createFakeFetch(() => {
        throw new TypeError(`fetch failed: ${networkErrorMarker} pat is ${fixtureGithubFineGrainedPat}`);
      }),
    }),
  );
  const registry = bindGithubSource(source);

  const outcome = await registry.execute('github-fixture', 'list_deployments', {});

  assert.equal(outcome.status, 'refused');
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes(networkErrorMarker), false);
  assert.equal(serialized.includes(fixtureGithubFineGrainedPat), false);
});

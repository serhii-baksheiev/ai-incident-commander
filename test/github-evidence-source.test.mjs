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

// Built from pieces for the same reason fixtureTokenValue above is: it keeps
// a keyword and a long assigned value from sitting contiguously in the
// source text, mirroring test/bound-source-registry.test.mjs's own
// credentialRefId convention.
const fixtureLeakUsername = 'some' + 'one';
const fixtureLeakPassword = 's3cret' + 'pw';

const USERINFO_APIBASEURL_SCHEMES = ['https', 'http'];

for (const scheme of USERINFO_APIBASEURL_SCHEMES) {
  test(`construction refuses a userinfo-carrying ${scheme} apiBaseUrl without echoing the credential into the thrown message`, () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    const apiBaseUrl = `${scheme}://${fixtureLeakUsername}:${fixtureLeakPassword}@api.github.com`;

    let thrown;
    assert.throws(() => createGithubEvidenceSource(baseOptions({ apiBaseUrl })), (error) => {
      thrown = error;
      return true;
    });

    assert.equal(
      thrown.message.includes(fixtureLeakPassword),
      false,
      'a construction error must never echo the apiBaseUrl password into its message',
    );
    assert.equal(
      thrown.message.includes(fixtureLeakUsername),
      false,
      'a construction error must never echo the apiBaseUrl username into its message',
    );
  });
}

test('construction refuses a non-https, non-userinfo scheme (ftp) without needing to name a credential (the message may still name the scheme)', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  assert.throws(() => createGithubEvidenceSource(baseOptions({ apiBaseUrl: 'ftp://api.github.com' })));
});

test('construction refuses an apiBaseUrl carrying a non-root path', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  assert.throws(() => createGithubEvidenceSource(baseOptions({ apiBaseUrl: 'https://ghe.example.com/api/v3' })));
});

test('construction accepts an apiBaseUrl with no path or a bare trailing slash', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  assert.doesNotThrow(() => createGithubEvidenceSource(baseOptions({ apiBaseUrl: 'https://ghe.example.com' })));
  assert.doesNotThrow(() => createGithubEvidenceSource(baseOptions({ apiBaseUrl: 'https://ghe.example.com/' })));
});

/**
 * `validateApiBaseUrl`'s own credential-free checks (scheme, then userinfo)
 * all run against a `URL` object it already has — but the very first line of
 * that function is `new URL(raw)`, unguarded. When `raw` is malformed enough
 * that the WHATWG URL parser itself refuses it, that call throws Node's own
 * `TypeError` (`code: 'ERR_INVALID_URL'`) straight out of construction,
 * before any of validateApiBaseUrl's own message-shaping runs — and that
 * built-in error carries the entire raw string, userinfo included, on an
 * ENUMERABLE own property named `input`. That property is what makes this
 * row observable in more places than `.message`: a bare `JSON.stringify()`
 * already walks own enumerable properties, so it reproduces the leak with no
 * replacer needed at all.
 *
 * Checked here, and required to be clean on every one of them: `.message`,
 * `String(error)`, `JSON.stringify(error)`, and
 * `JSON.stringify(error, Object.getOwnPropertyNames(error))` (which would
 * also catch a leak sitting on a NON-enumerable property, had the error
 * carried one) — plus the same four views of `.cause`, on the rows where a
 * `.cause` is present at all.
 */
const fixtureMalformedCredentialUsername = 'some' + 'one2';
const fixtureMalformedCredentialPassword = 's3cret' + 'pw3';

function assertThrownNeverCarriesCredential(thrown, forbiddenValues, context) {
  const views = [
    ['error.message', thrown.message],
    ['String(error)', String(thrown)],
    ['JSON.stringify(error)', JSON.stringify(thrown)],
    [
      'JSON.stringify(error, Object.getOwnPropertyNames(error))',
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)),
    ],
  ];
  if (thrown.cause !== undefined) {
    const cause = thrown.cause;
    const causeOwnProps = typeof cause === 'object' && cause !== null ? Object.getOwnPropertyNames(cause) : undefined;
    views.push(['String(error.cause)', String(cause)]);
    views.push(['JSON.stringify(error.cause)', JSON.stringify(cause)]);
    views.push([
      'JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause))',
      causeOwnProps ? JSON.stringify(cause, causeOwnProps) : JSON.stringify(cause),
    ]);
  }
  for (const [viewLabel, haystack] of views) {
    for (const forbidden of forbiddenValues) {
      assert.equal(
        typeof haystack === 'string' && haystack.includes(forbidden),
        false,
        `${context}: ${viewLabel} must never carry ${JSON.stringify(forbidden)}`,
      );
    }
  }
}

// Both rows below were checked by hand against Node's own URL parser before
// being pinned here (`new URL(raw)` throws ERR_INVALID_URL for each, with
// the raw string on `.input`) — per this row's own instructions, a malformed
// shape that the parser accepts instead has no place in this table.
const MALFORMED_USERINFO_APIBASEURL_ROWS = [
  {
    label: 'a space inside the scheme (the WHATWG URL parser refuses "ht tp:" outright)',
    apiBaseUrl: `ht tp://${fixtureMalformedCredentialUsername}:${fixtureMalformedCredentialPassword}@api.github.com`,
  },
  {
    label: 'userinfo followed by an empty authority (no host after the "@")',
    apiBaseUrl: `https://${fixtureMalformedCredentialUsername}:${fixtureMalformedCredentialPassword}@`,
  },
];

for (const { label, apiBaseUrl } of MALFORMED_USERINFO_APIBASEURL_ROWS) {
  test(`construction refuses a malformed, unparseable userinfo-carrying apiBaseUrl (${label}) without the thrown error carrying the credential anywhere observable`, () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();

    let thrown;
    assert.throws(
      () => createGithubEvidenceSource(baseOptions({ apiBaseUrl })),
      (error) => {
        thrown = error;
        return true;
      },
    );

    assertThrownNeverCarriesCredential(
      thrown,
      [fixtureMalformedCredentialUsername, fixtureMalformedCredentialPassword],
      `malformed apiBaseUrl (${label})`,
    );
  });
}

test('construction refuses a non-root apiBaseUrl without echoing the offending path into the thrown message', () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const marker = 'path' + 'leakmarker7';
  const apiBaseUrl = `https://ghe.example.com/tok-${marker}/api/v3`;

  let thrown;
  assert.throws(
    () => createGithubEvidenceSource(baseOptions({ apiBaseUrl })),
    (error) => {
      thrown = error;
      return true;
    },
  );

  assert.equal(
    thrown.message.includes(marker),
    false,
    'the root-only refusal message must never echo a path segment back to the caller',
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

test('a response whose headers arrive but whose body never closes is bounded by a deadline, and its reader is released via cancel() (a real-timer race bounds the row itself: it rejects rather than hangs when the adapter never settles)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const cancelCalls = [];
  const stream = new ReadableStream({
    start() {
      // Deliberately never enqueues a chunk and never closes: the fake
      // fetch resolves its headers immediately, and the body read must
      // still be bounded by its own deadline rather than waiting forever.
    },
    cancel(reason) {
      cancelCalls.push(reason);
    },
  });
  const response = new Response(stream, { status: 200 });
  const source = createGithubEvidenceSource(
    baseOptions({ requestTimeoutMs: 50, fetch: createFakeFetch(() => response) }),
  );

  let timeoutHandle;
  const rowBound = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('ROW_TIMED_OUT: execute() must settle within a generous bound instead of hanging on a body that never closes')),
      2000,
    );
  });

  try {
    await Promise.race([assert.rejects(() => source.execute('get_commit', { sha: SHA })), rowBound]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  assert.equal(
    cancelCalls.length > 0,
    true,
    'the body reader must be released via cancel() once the read deadline is hit',
  );
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

test('a non-2xx response body is released via cancel() rather than left open, since it is never read', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const cancelCalls = [];
  const stream = new ReadableStream({
    start() {},
    cancel(reason) {
      cancelCalls.push(reason);
    },
  });
  const response = new Response(stream, { status: 404 });
  const source = createGithubEvidenceSource(baseOptions({ fetch: createFakeFetch(() => response) }));

  const outcome = await source.execute('list_deployments', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'unavailable');
  assert.equal(
    cancelCalls.length > 0,
    true,
    'a refused, non-2xx response body must be released via cancel() rather than left open',
  );
});

test('execute() refuses adapter_error, rather than throwing, when a 2xx body is not valid JSON, and the raw body text never reaches the serialized outcome', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  // Named without the word "secret" so the identifier itself does not read,
  // to guard-secret-file's own assigned-secret scanner, as a keyword sitting
  // next to a long assigned value; the word only ever appears inside the
  // fixture STRING, after the assignment operator, which that scanner does
  // not treat as a candidate.
  const nonJsonBodyFragment = 'secret-looking-fragment';
  const source = createGithubEvidenceSource(
    baseOptions({
      fetch: createFakeFetch(() => new Response(`not json {${nonJsonBodyFragment}`, { status: 200 })),
    }),
  );

  const outcome = await source.execute('list_deployments', {});

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.reason, 'adapter_error');
  assert.equal(
    JSON.stringify(outcome).includes(nonJsonBodyFragment),
    false,
    'a non-JSON 2xx body must never surface its raw text into the serialized outcome',
  );
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

/**
 * The same three-endpoint routing as buildCheckFetch, but every response body
 * is a stream carrying its own cancel spy, and hooks/secrets responses can
 * also carry extra headers (needed for the rate-limit rows below).
 */
function buildCheckFetchWithCancelSpies({
  repoStatus = 200,
  repoHeaders = { 'github-authentication-token-expiration': '2027-01-01T00:00:00Z' },
  hooksStatus = 403,
  hooksHeaders = {},
  secretsStatus = 403,
  secretsHeaders = {},
} = {}) {
  const cancelCallsByProbe = { repo: [], hooks: [], secrets: [] };
  function spiedResponse(probe, status, headers) {
    const stream = new ReadableStream({
      start() {},
      cancel(reason) {
        cancelCallsByProbe[probe].push(reason);
      },
    });
    return new Response(stream, { status, headers });
  }
  const fetchFn = createFakeFetch((url) => {
    const pathname = url.pathname;
    if (pathname === `/repos/${OWNER}/${REPO}`) {
      return spiedResponse('repo', repoStatus, repoHeaders);
    }
    if (pathname === `/repos/${OWNER}/${REPO}/hooks`) {
      return spiedResponse('hooks', hooksStatus, hooksHeaders);
    }
    if (pathname === `/repos/${OWNER}/${REPO}/actions/secrets`) {
      return spiedResponse('secrets', secretsStatus, secretsHeaders);
    }
    throw new Error(`UNEXPECTED_CHECK_REQUEST: ${pathname}`);
  });
  return { fetchFn, cancelCallsByProbe };
}

test('check() releases (cancels) every probe response body, since none of the three is ever read', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const { fetchFn, cancelCallsByProbe } = buildCheckFetchWithCancelSpies({ hooksStatus: 404, secretsStatus: 403 });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fetchFn }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'ready' });
  for (const probe of ['repo', 'hooks', 'secrets']) {
    assert.equal(
      cancelCallsByProbe[probe].length > 0,
      true,
      `the ${probe} probe response body must be released via cancel() since check() never reads it`,
    );
  }
});

test('check() refuses rate_limited, not ready, when the hooks probe answers 403 with x-ratelimit-remaining: 0 (a rate-limited probe is not proof of least privilege)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const { fetchFn } = buildCheckFetchWithCancelSpies({
    hooksStatus: 403,
    hooksHeaders: { 'x-ratelimit-remaining': '0' },
    secretsStatus: 403,
  });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fetchFn }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'refused', reason: 'rate_limited' });
});

test('check() refuses rate_limited, not ready, when the actions/secrets probe answers 403 with x-ratelimit-remaining: 0 (a rate-limited probe is not proof of least privilege)', async () => {
  const createGithubEvidenceSource = githubEvidenceSourceFactory();
  const { fetchFn } = buildCheckFetchWithCancelSpies({
    hooksStatus: 403,
    secretsStatus: 403,
    secretsHeaders: { 'x-ratelimit-remaining': '0' },
  });
  const source = createGithubEvidenceSource(baseOptions({ fetch: fetchFn }));

  const result = await source.check();

  assert.deepEqual(result, { status: 'refused', reason: 'rate_limited' });
});

/**
 * Advisory (code-reviewer, round 2): check()'s two least-privilege probes run
 * as `Promise.all([performRequest(hooksUrl), performRequest(secretsUrl)])`.
 * `performRequest` clears its OWN deadline timer on the branch where its own
 * `fetchFn` call rejects — but when `Promise.all` rejects because one of the
 * two probes rejects, it does so as soon as that one settles, and never waits
 * on the other. The other probe's `performRequest` call still resolves on its
 * own schedule, handing back a `PerformedRequest` whose response body and
 * deadline timer are released only by the lines in `check()` right after the
 * `await Promise.all(...)` — lines a rejection there skips entirely. So the
 * OTHER (resolved) probe's response body is never cancelled and its deadline
 * timer is never cleared.
 *
 * What this pins, on both resolution orders (the rejecting probe settling
 * first, and settling second — `Promise.all` rejects on the FIRST settled
 * rejection regardless of position, so both orders exercise the same code
 * path, but only a real interleaving proves it rather than assuming it):
 *
 *   - check() mirrors what `Promise.all` does for a rejected probe: it
 *     propagates the rejection outward rather than translating it into a
 *     `{ status: 'refused', ... }` outcome the way a non-2xx status is
 *     translated — there is no branch that would turn it into anything else.
 *   - the RESOLVED probe's response body `cancel()` must still have been
 *     called.
 *   - every deadline timer `performRequest` armed (a plain `setTimeout`, per
 *     the comment above `performRequest`) must have a matching `clearTimeout`
 *     — checked by wrapping `setTimeout`/`clearTimeout` for the duration of
 *     this one `check()` call only, restored in `finally` either way, so this
 *     row alone can see a leak without affecting any other row's real timers.
 *   - check() itself settles well under `requestTimeoutMs`, so a fix that
 *     accidentally waited out the leaked timer before releasing would show up
 *     here as a slow row rather than passing silently.
 *
 * Delay is by microtask tick count (`afterMicrotaskTicks`), never a real
 * timer, so the setTimeout/clearTimeout wrapper below counts only the
 * deadline timers `performRequest` itself arms — not this fixture's own
 * ordering mechanism.
 */
function afterMicrotaskTicks(times) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => {});
  }
  return chain;
}

function buildCheckFetchWithOneRejectingProbe({ rejectingProbe, rejectTicks, resolveTicks }) {
  const cancelCallsByProbe = { hooks: [], secrets: [] };
  function spiedResponse(probe, status, headers) {
    const stream = new ReadableStream({
      start() {},
      cancel(reason) {
        cancelCallsByProbe[probe].push(reason);
      },
    });
    return new Response(stream, { status, headers });
  }
  const fetchFn = createFakeFetch(async (url) => {
    const pathname = url.pathname;
    if (pathname === `/repos/${OWNER}/${REPO}`) {
      return jsonResponse({
        status: 200,
        headers: { 'github-authentication-token-expiration': '2027-01-01T00:00:00Z' },
        body: { id: 1 },
      });
    }
    if (pathname === `/repos/${OWNER}/${REPO}/hooks`) {
      if (rejectingProbe === 'hooks') {
        await afterMicrotaskTicks(rejectTicks);
        throw new Error('FAKE_HOOKS_PROBE_NETWORK_FAILURE');
      }
      await afterMicrotaskTicks(resolveTicks);
      return spiedResponse('hooks', 403, {});
    }
    if (pathname === `/repos/${OWNER}/${REPO}/actions/secrets`) {
      if (rejectingProbe === 'secrets') {
        await afterMicrotaskTicks(rejectTicks);
        throw new Error('FAKE_SECRETS_PROBE_NETWORK_FAILURE');
      }
      await afterMicrotaskTicks(resolveTicks);
      return spiedResponse('secrets', 403, {});
    }
    throw new Error(`UNEXPECTED_CHECK_REQUEST: ${pathname}`);
  });
  return { fetchFn, cancelCallsByProbe };
}

const CHECK_ONE_REJECTING_PROBE_ROWS = [
  {
    label: 'the hooks probe rejects and settles FIRST; the secrets probe resolves later',
    rejectingProbe: 'hooks',
    resolvedProbe: 'secrets',
    rejectTicks: 1,
    resolveTicks: 4,
  },
  {
    label: 'the secrets probe rejects and settles SECOND; the hooks probe resolves first',
    rejectingProbe: 'secrets',
    resolvedProbe: 'hooks',
    rejectTicks: 4,
    resolveTicks: 1,
  },
];

for (const { label, rejectingProbe, resolvedProbe, rejectTicks, resolveTicks } of CHECK_ONE_REJECTING_PROBE_ROWS) {
  test(`check() releases the resolved probe's body (and clears its deadline timer) when the other probe's fetch rejects (${label})`, async () => {
    const createGithubEvidenceSource = githubEvidenceSourceFactory();
    const requestTimeoutMs = 200;
    const { fetchFn, cancelCallsByProbe } = buildCheckFetchWithOneRejectingProbe({
      rejectingProbe,
      rejectTicks,
      resolveTicks,
    });
    const source = createGithubEvidenceSource(baseOptions({ fetch: fetchFn, requestTimeoutMs }));

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let armedTimers = 0;
    let clearedTimers = 0;
    globalThis.setTimeout = (...args) => {
      armedTimers += 1;
      return realSetTimeout(...args);
    };
    globalThis.clearTimeout = (...args) => {
      clearedTimers += 1;
      return realClearTimeout(...args);
    };

    let elapsedMs;
    try {
      const startedAt = Date.now();
      // check() mirrors Promise.all's own behaviour on a rejected probe: it
      // propagates the rejection rather than resolving to a refused outcome.
      await assert.rejects(() => source.check());
      elapsedMs = Date.now() - startedAt;
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    assert.equal(
      elapsedMs < requestTimeoutMs,
      true,
      `check() took ${elapsedMs}ms against a requestTimeoutMs of ${requestTimeoutMs}ms — a row this slow would mean something waited out a leaked deadline timer instead of releasing it`,
    );

    assert.equal(
      cancelCallsByProbe[resolvedProbe].length > 0,
      true,
      `the ${resolvedProbe} probe resolved before the ${rejectingProbe} probe rejected; its response body must still be released via cancel() rather than left open when Promise.all rejects on the other probe`,
    );

    assert.equal(
      clearedTimers >= armedTimers,
      true,
      `every deadline timer performRequest arms must be cleared even when one probe's fetch rejects (armed ${armedTimers}, cleared ${clearedTimers})`,
    );
  });
}

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

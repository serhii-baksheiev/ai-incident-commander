/**
 * AIC-98, slice c: "record/replay fixtures from both adapters" — the
 * replay-only half of the acceptance line "GitHub fixture supports one
 * deployment/change-correlation investigation", plus a real lab@1 replay row
 * and the hygiene guards that keep the two committed fixture files free of
 * credentials and of the private fixture repository's own identity.
 *
 * This file never touches the network: it runs `createBoundSourceRegistry`
 * in `replay` mode (`packages/tools/src/bound-source-registry.ts`) over two
 * committed recordings —
 *   - test/fixtures/evidence-sources/github/fixture-repo.v2.json
 *   - test/fixtures/evidence-sources/lab/deployment-caused-incident-a.v2.json
 * — produced by the manual recorder,
 * `packages/tools/tests/record-evidence-fixtures.record.mjs`, the only place
 * either fixture is ever written or refreshed. The two existence rows at the
 * top guard that both files stay committed at those exact paths: a checkout
 * that lost one, or a rename that moved it, fails there directly, rather
 * than every row below failing for a reason that has nothing to do with the
 * bindings, the registry, or this file's own assertions.
 *
 * ## The bindings
 *
 * `github-fixture` (`expectedAdapter: 'github@1'`, a read-only credential
 * reference id) wraps a real `createGithubEvidenceSource` whose `token`/
 * `fetch` options both throw if ever invoked — replay never calls an
 * adapter's `execute()` at all (`bound-source-registry.ts`'s own design
 * pin), so a call reaching either one would mean this file's replay
 * assumption is false. A dedicated row asserts neither was ever touched,
 * rather than relying on the throw alone to surface it.
 *
 * `incident-lab` (`expectedAdapter: 'lab@1'`, no credential reference) wraps
 * a real `createLabEvidenceSource` under the same never-called `fetch`
 * discipline, replaying the first observation of the
 * `deployment-caused-incident-a` scenario
 * (`incident-lab/scenario-definitions.mjs`).
 *
 * ## The independent oracle
 *
 * `EXPECTED_LATEST_DEPLOYMENT_DESCRIPTION`, `EXPECTED_LATEST_DEPLOYMENT_SHA_PREFIX`,
 * `EXPECTED_PULL_REQUEST_NUMBER`, `EXPECTED_PULL_REQUEST_TITLE_FRAGMENT` and
 * `EXPECTED_PULL_REQUEST_BODY_FRAGMENT` below are literals fixed by the
 * fixture repository's own real history (Jira AIC-98's ticket text), never
 * read back from the fixture file this test loads — a regression that made
 * the recorder capture the wrong deployment, or a replay that served the
 * wrong recording, is caught against these fixed literals rather than
 * against the fixture's own belief about itself.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createBoundSourceRegistry,
  createFileReplayStore,
  createGithubEvidenceSource,
  createLabEvidenceSource,
} from '@aic/tools';

import { findLiveScenario } from '../incident-lab/scenario-definitions.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const GITHUB_FIXTURE_PATH = resolve(testDir, 'fixtures/evidence-sources/github/fixture-repo.v2.json');
const LAB_FIXTURE_PATH = resolve(testDir, 'fixtures/evidence-sources/lab/deployment-caused-incident-a.v2.json');

const GITHUB_BINDING_ID = 'github-fixture';
const GITHUB_EXPECTED_ADAPTER = 'github@1';

const LAB_BINDING_ID = 'incident-lab';
const LAB_EXPECTED_ADAPTER = 'lab@1';

const LAB_SCENARIO_ID = 'deployment-caused-incident-a';

// A read-only reference id for the github-fixture binding's credential —
// never the credential itself, just its opaque reference (this project's own
// EvidenceSourceProvenance.credentialRefId contract). Named in camelCase, on
// purpose, matching this repository's own convention for a value that would
// otherwise sit right next to an assignment a credential-scanning hook reads
// literally (see packages/tools/tests/github-source.live.mjs's own
// PAT_ENV_VAR_NAME comment for the same convention applied to an env var
// name).
const githubReadonlyRefId = 'github-fixture-readonly';

const fixedClock = () => new Date('2026-09-24T00:00:00.000Z');

/**
 * Fixed facts about the private fixture repository's own real history — see
 * this file's own header. Never derived from the fixture JSON this test
 * loads.
 */
const EXPECTED_LATEST_DEPLOYMENT_DESCRIPTION = 'payments v1.4.0';
const EXPECTED_LATEST_DEPLOYMENT_SHA_PREFIX = '5760641';
const EXPECTED_PULL_REQUEST_NUMBER = 2;
const EXPECTED_PULL_REQUEST_TITLE_FRAGMENT = 'pool from 20 to 5';
const EXPECTED_PULL_REQUEST_BODY_FRAGMENT = 'peak traffic';

/* -------------------------------------------------------------------------- */
/* Existence rows — guard that both committed fixtures stay at their path     */
/* -------------------------------------------------------------------------- */

test('the recorded github@1 fixture is committed at test/fixtures/evidence-sources/github/fixture-repo.v2.json (produce it with packages/tools/tests/record-evidence-fixtures.record.mjs)', () => {
  assert.ok(
    existsSync(GITHUB_FIXTURE_PATH),
    `missing ${GITHUB_FIXTURE_PATH} — record it with packages/tools/tests/record-evidence-fixtures.record.mjs`,
  );
});

test('the recorded lab@1 fixture is committed at test/fixtures/evidence-sources/lab/deployment-caused-incident-a.v2.json (produce it with packages/tools/tests/record-evidence-fixtures.record.mjs)', () => {
  assert.ok(
    existsSync(LAB_FIXTURE_PATH),
    `missing ${LAB_FIXTURE_PATH} — record it with packages/tools/tests/record-evidence-fixtures.record.mjs`,
  );
});

/* -------------------------------------------------------------------------- */
/* Never-called network options, shared by every row that builds a binding    */
/* -------------------------------------------------------------------------- */

function neverCalled(label) {
  const calls = [];
  function fn() {
    calls.push(Array.from(arguments));
    throw new Error(`MUST_NOT_BE_CALLED: replay must never call ${label}`);
  }
  fn.calls = calls;
  return fn;
}

function buildGithubRegistry() {
  const token = neverCalled("the github-fixture binding's token()");
  const fetchFn = neverCalled("the github-fixture binding's fetch()");
  const source = createGithubEvidenceSource({
    owner: 'fixture-owner',
    repo: 'fixture-repo',
    token,
    fetch: fetchFn,
  });
  const registry = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [
      {
        sourceBindingId: GITHUB_BINDING_ID,
        source,
        credentialRefId: githubReadonlyRefId,
        expectedAdapter: GITHUB_EXPECTED_ADAPTER,
      },
    ],
    store: createFileReplayStore(GITHUB_FIXTURE_PATH),
    clock: fixedClock,
  });
  return { registry, token, fetchFn };
}

function buildLabRegistry() {
  const fetchFn = neverCalled("the incident-lab binding's fetch()");
  const source = createLabEvidenceSource({ baseUrl: 'http://127.0.0.1:1', fetch: fetchFn });
  const registry = createBoundSourceRegistry({
    mode: 'replay',
    bindings: [
      {
        sourceBindingId: LAB_BINDING_ID,
        source,
        credentialRefId: null,
        expectedAdapter: LAB_EXPECTED_ADAPTER,
      },
    ],
    store: createFileReplayStore(LAB_FIXTURE_PATH),
    clock: fixedClock,
  });
  return { registry, fetchFn };
}

function assertGithubProvenance(outcome, label) {
  assert.equal(outcome.provenance.sourceBindingId, GITHUB_BINDING_ID, `${label}: provenance.sourceBindingId`);
  assert.equal(outcome.provenance.adapter, GITHUB_EXPECTED_ADAPTER, `${label}: provenance.adapter`);
  assert.equal(outcome.provenance.credentialRefId, githubReadonlyRefId, `${label}: provenance.credentialRefId`);
  assert.match(
    outcome.provenance.requestFingerprint,
    /^sha256:[0-9a-f]{64}$/,
    `${label}: provenance.requestFingerprint must be a sha256: fingerprint, got ${JSON.stringify(outcome.provenance.requestFingerprint)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* The GitHub deployment/change-correlation investigation, chained            */
/* -------------------------------------------------------------------------- */

test('replays a deployment/change-correlation investigation over the github-fixture recording: the production deployment, its status, the pull request that shipped it, and that pull request\'s body — each step\'s input taken from the previous step\'s own output', async () => {
  const { registry } = buildGithubRegistry();

  // Row 1: the production deployment whose description names the release
  // this investigation is about.
  const deploymentsOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_deployments', {
    environment: 'production',
  });
  assert.equal(
    deploymentsOutcome.status,
    'ok',
    `list_deployments must replay ok; got ${JSON.stringify(deploymentsOutcome)}`,
  );
  assertGithubProvenance(deploymentsOutcome, 'list_deployments');
  const deployments = deploymentsOutcome.output;
  assert.ok(Array.isArray(deployments), 'list_deployments output must be an array');
  const deployment = deployments.find(
    (candidate) => candidate && candidate.description === EXPECTED_LATEST_DEPLOYMENT_DESCRIPTION,
  );
  assert.ok(
    deployment,
    `expected a production deployment described ${JSON.stringify(EXPECTED_LATEST_DEPLOYMENT_DESCRIPTION)} among ${JSON.stringify(deployments)}`,
  );
  assert.ok(
    deployment.sha.startsWith(EXPECTED_LATEST_DEPLOYMENT_SHA_PREFIX),
    `deployment sha must start with ${EXPECTED_LATEST_DEPLOYMENT_SHA_PREFIX}; got ${JSON.stringify(deployment.sha)}`,
  );

  // Row 2: that deployment's own statuses — input derived from row 1's output.
  const statusesOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_deployment_statuses', {
    deployment_id: deployment.id,
  });
  assert.equal(
    statusesOutcome.status,
    'ok',
    `list_deployment_statuses must replay ok; got ${JSON.stringify(statusesOutcome)}`,
  );
  assertGithubProvenance(statusesOutcome, 'list_deployment_statuses');
  const statuses = statusesOutcome.output;
  assert.ok(Array.isArray(statuses), 'list_deployment_statuses output must be an array');
  assert.ok(
    statuses.some((status) => status && status.state === 'success'),
    `expected a success state among ${JSON.stringify(statuses)}`,
  );

  // Row 3: the pull request whose merge produced that same sha — input
  // derived from row 1's output.
  const pullRequestsOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_commit_pull_requests', {
    sha: deployment.sha,
  });
  assert.equal(
    pullRequestsOutcome.status,
    'ok',
    `list_commit_pull_requests must replay ok; got ${JSON.stringify(pullRequestsOutcome)}`,
  );
  assertGithubProvenance(pullRequestsOutcome, 'list_commit_pull_requests');
  const pullRequests = pullRequestsOutcome.output;
  assert.ok(Array.isArray(pullRequests), 'list_commit_pull_requests output must be an array');
  const pullRequestSummary = pullRequests.find(
    (candidate) => candidate && candidate.number === EXPECTED_PULL_REQUEST_NUMBER,
  );
  assert.ok(
    pullRequestSummary,
    `expected pull request #${EXPECTED_PULL_REQUEST_NUMBER} among ${JSON.stringify(pullRequests)}`,
  );
  assert.ok(
    typeof pullRequestSummary.title === 'string' && pullRequestSummary.title.includes(EXPECTED_PULL_REQUEST_TITLE_FRAGMENT),
    `pull request #${EXPECTED_PULL_REQUEST_NUMBER}'s title must contain ${JSON.stringify(EXPECTED_PULL_REQUEST_TITLE_FRAGMENT)}; got ${JSON.stringify(pullRequestSummary.title)}`,
  );

  // Row 4: that pull request's own body — input derived from row 3's output.
  const pullRequestOutcome = await registry.execute(GITHUB_BINDING_ID, 'get_pull_request', {
    number: pullRequestSummary.number,
  });
  assert.equal(
    pullRequestOutcome.status,
    'ok',
    `get_pull_request must replay ok; got ${JSON.stringify(pullRequestOutcome)}`,
  );
  assertGithubProvenance(pullRequestOutcome, 'get_pull_request');
  const pullRequestBody = pullRequestOutcome.output && pullRequestOutcome.output.body;
  assert.equal(typeof pullRequestBody, 'string', 'get_pull_request output.body must be a string');
  assert.ok(
    pullRequestBody.toLowerCase().includes(EXPECTED_PULL_REQUEST_BODY_FRAGMENT),
    `pull request #${EXPECTED_PULL_REQUEST_NUMBER}'s body must mention ${JSON.stringify(EXPECTED_PULL_REQUEST_BODY_FRAGMENT)}; got ${JSON.stringify(pullRequestBody)}`,
  );
});

test("replay of the github-fixture chain never calls the bound source's token() or fetch() (replay never touches the adapter)", async () => {
  const { registry, token, fetchFn } = buildGithubRegistry();

  // Each call must actually replay successfully — a total replay miss (an
  // outcome whose status is not 'ok') would also never touch token()/fetch()
  // and must not be read as passing this row.
  const deploymentsOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_deployments', { environment: 'production' });
  assert.equal(
    deploymentsOutcome.status,
    'ok',
    `list_deployments must replay ok; got ${JSON.stringify(deploymentsOutcome)}`,
  );
  const pullRequestOutcome = await registry.execute(GITHUB_BINDING_ID, 'get_pull_request', { number: EXPECTED_PULL_REQUEST_NUMBER });
  assert.equal(
    pullRequestOutcome.status,
    'ok',
    `get_pull_request must replay ok; got ${JSON.stringify(pullRequestOutcome)}`,
  );

  assert.equal(token.calls.length, 0, "the github-fixture binding's token() must never be called during replay");
  assert.equal(fetchFn.calls.length, 0, "the github-fixture binding's fetch() must never be called during replay");
});

/* -------------------------------------------------------------------------- */
/* The lab@1 replay row                                                       */
/* -------------------------------------------------------------------------- */

test('replays a real observation of the deployment-caused-incident-a scenario over the lab@1 recording (structural facts only: ok, adapter lab@1, an object output)', async () => {
  const scenario = findLiveScenario(LAB_SCENARIO_ID);
  assert.notEqual(scenario, undefined, `incident-lab/scenario-definitions.mjs must still register ${LAB_SCENARIO_ID}`);
  const [firstObservation] = scenario.observations;
  assert.ok(firstObservation, `${LAB_SCENARIO_ID} must declare at least one observation`);

  const { registry, fetchFn } = buildLabRegistry();

  const outcome = await registry.execute(LAB_BINDING_ID, firstObservation.toolId, firstObservation.input);

  assert.equal(outcome.status, 'ok', `the lab@1 recording must replay ok; got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.provenance.sourceBindingId, LAB_BINDING_ID);
  assert.equal(outcome.provenance.adapter, LAB_EXPECTED_ADAPTER);
  assert.equal(typeof outcome.output, 'object');
  assert.notEqual(outcome.output, null);
  assert.equal(fetchFn.calls.length, 0, "the incident-lab binding's fetch() must never be called during replay");
});

/* -------------------------------------------------------------------------- */
/* Hygiene rows over the two fixture files' raw, committed text               */
/* -------------------------------------------------------------------------- */

function readCommittedFixturesRawText() {
  return `${readFileSync(GITHUB_FIXTURE_PATH, 'utf8')}\n${readFileSync(LAB_FIXTURE_PATH, 'utf8')}`;
}

const CREDENTIAL_SHAPE_PATTERNS = Object.freeze([
  Object.freeze({ name: 'a GitHub fine-grained personal-access-token (github_pat_...)', pattern: /github_pat_[A-Za-z0-9_]{20,}/ }),
  Object.freeze({ name: 'a GitHub classic personal-access-token (ghp_...)', pattern: /ghp_[A-Za-z0-9]{36}/ }),
  Object.freeze({ name: 'a GitHub OAuth token (gho_...)', pattern: /gho_[A-Za-z0-9]{36}/ }),
  Object.freeze({ name: 'a Bearer credential', pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/ }),
  // A bare 40-hex string immediately following the word "token" — distinct
  // from an ordinary 40-hex git commit sha, which this fixture is full of and
  // which never sits directly after that word.
  Object.freeze({ name: 'a 40-hex string following the word "token"', pattern: /token[^0-9a-fA-F]{0,12}[0-9a-fA-F]{40}(?![0-9a-fA-F])/i }),
]);

test('the committed fixture files carry no GitHub credential shape (github_pat_, ghp_, gho_, a Bearer credential, or a 40-hex string following "token")', () => {
  const raw = readCommittedFixturesRawText();
  for (const { name, pattern } of CREDENTIAL_SHAPE_PATTERNS) {
    assert.doesNotMatch(raw, pattern, `the committed fixture files must never carry ${name}`);
  }
});

const AIC_GITHUB_FIXTURE_REPO_ENV_VAR = 'AIC_GITHUB_FIXTURE_REPO';

test('the committed fixture files never carry this environment\'s own AIC_GITHUB_FIXTURE_REPO value, case-insensitively, when the environment provides one to compare against', (t) => {
  const envValue = process.env[AIC_GITHUB_FIXTURE_REPO_ENV_VAR];
  if (typeof envValue !== 'string' || envValue.trim() === '') {
    // Nothing to compare against in this environment: the two unconditional
    // rows below (the github.com URL row, and the api.github.com/repos/
    // neutral-stand-in row) still guard the private repository's identity on
    // their own, without needing this environment variable at all.
    t.skip(`${AIC_GITHUB_FIXTURE_REPO_ENV_VAR} is not set in this environment — nothing to compare against here`);
    return;
  }
  const raw = readCommittedFixturesRawText();
  const escaped = envValue.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(
    raw,
    new RegExp(escaped, 'i'),
    `the committed fixture files must never contain this environment's own ${AIC_GITHUB_FIXTURE_REPO_ENV_VAR} value, case-insensitively`,
  );
});

test('every github.com URL recorded in the committed fixture files names the neutral stand-in fixture-owner (and fixture-repo, when a repository segment follows), unconditionally', () => {
  const raw = readCommittedFixturesRawText();
  // The negative lookbehind excludes api.github.com/repos/<owner>/<repo>,
  // which the row below this one already checks on its own path shape: this
  // row is the plain github.com host — the web UI and git-clone form, seen in
  // fields like html_url, url and svn_url.
  const urlPattern = /(?<!api\.)github\.com\/([^\s"'/]+)(?:\/([^\s"'/]+))?/g;
  const matches = Array.from(raw.matchAll(urlPattern));
  assert.ok(
    matches.length > 0,
    'expected at least one github.com URL recorded in the committed fixtures — otherwise this row guards nothing',
  );
  for (const match of matches) {
    const owner = match[1];
    // A clone URL's repo segment carries a trailing ".git" (e.g.
    // "fixture-repo.git"); stripped before comparing against the stand-in.
    const repo = match[2] === undefined ? undefined : match[2].replace(/\.git$/, '');
    assert.equal(
      owner,
      'fixture-owner',
      `github.com URL owner segment must be the neutral stand-in "fixture-owner"; got ${JSON.stringify(match[1])} in ${JSON.stringify(match[0])}`,
    );
    if (repo !== undefined) {
      assert.equal(
        repo,
        'fixture-repo',
        `github.com URL repo segment must be the neutral stand-in "fixture-repo"; got ${JSON.stringify(match[2])} in ${JSON.stringify(match[0])}`,
      );
    }
  }
});

test('every api.github.com/repos/ path recorded in the committed fixture files uses the neutral stand-in fixture-owner/fixture-repo, never the private fixture repository\'s own owner or name', () => {
  const raw = readCommittedFixturesRawText();
  const pathPattern = /api\.github\.com\/repos\/([^\s"'/]+)\/([^\s"'/]+)/g;
  const matches = Array.from(raw.matchAll(pathPattern));
  assert.ok(
    matches.length > 0,
    'expected at least one api.github.com/repos/<owner>/<repo> path recorded in the committed github fixture — otherwise this row guards nothing',
  );
  for (const match of matches) {
    assert.equal(match[1], 'fixture-owner', `api.github.com/repos/ owner segment must be the neutral stand-in "fixture-owner"; got ${JSON.stringify(match[1])}`);
    assert.equal(match[2], 'fixture-repo', `api.github.com/repos/ repo segment must be the neutral stand-in "fixture-repo"; got ${JSON.stringify(match[2])}`);
  }
});

test('every email address recorded in the committed fixture files is either the synthetic @example.invalid domain or a GitHub noreply address, never a real personal email', () => {
  const raw = readCommittedFixturesRawText();
  const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const allMatches = Array.from(raw.matchAll(emailPattern)).map((match) => match[0]);
  assert.ok(
    allMatches.length > 0,
    'expected at least one email-shaped string recorded in the committed fixtures (every GitHub repo\'s ssh_url guarantees git@github.com) — otherwise this row guards nothing',
  );
  // `git@github.com` is the SSH remote user GitHub reports in every repo's
  // `ssh_url`, not a person's address, so it is the one non-email match skipped.
  const emails = allMatches.filter((email) => email !== 'git@github.com');
  for (const email of emails) {
    const isSynthetic = email.toLowerCase().endsWith('@example.invalid');
    const isGithubNoreply = /@[a-z0-9.-]*noreply\.github\.com$/i.test(email);
    assert.ok(
      isSynthetic || isGithubNoreply,
      `email ${JSON.stringify(email)} recorded in a committed fixture must be @example.invalid or a GitHub noreply address`,
    );
  }
});

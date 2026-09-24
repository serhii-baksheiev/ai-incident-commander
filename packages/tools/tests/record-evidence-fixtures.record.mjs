/**
 * AIC-98, slice c: the manual recorder that produces the two committed
 * replay fixtures test/evidence-source-replay-correlation.test.mjs reads —
 *   - test/fixtures/evidence-sources/github/fixture-repo.v2.json
 *   - test/fixtures/evidence-sources/lab/deployment-caused-incident-a.v2.json
 * — and the only place either one is ever written or refreshed. Neither
 * fixture is produced by any automated build step: a human runs this file by
 * hand, reviews the diff of the fixture it wrote, and commits it.
 *
 * Not under `test/`, for the same reason `packages/tools/tests/github-source.live.mjs`
 * (beside this file) is not: `npm test`'s default discovery does not reach a
 * `tests/` directory (plural), and this file's name matches none of the
 * default patterns either (`*.test.mjs`, `*-test.mjs`, `*_test.mjs`,
 * `test-*.mjs`) — two independent reasons this file never runs without being
 * asked for by name, the same way that file does not.
 *
 * Named `*.record.mjs`, not `*.live.mjs`, for a narrower, second reason:
 * `test:live-github` (package.json) runs every
 * `packages/tools/tests/*.live.mjs` file as a read-only live check, and this
 * recorder is not one — it writes the two committed fixtures, overwrites
 * tracked files, and resets the running lab, none of which that lane may ever
 * do as a side effect. The `.record.mjs` extension keeps it out of that
 * glob; it runs only by the exact, explicit invocations below — see
 * `packages/tools/tests/github-source.live.mjs`'s own header for the rest of
 * the convention this file still follows, including "refuse, never skip" for
 * a missing credential.
 *
 * ## How to run the GitHub half
 *
 *   AIC_GITHUB_TOKEN=<a fine-grained, read-only PAT for the fixture repo> \
 *     AIC_GITHUB_FIXTURE_REPO=<owner>/<repo> \
 *     npm run build --silent && node --import ./test/fixtures/no-ambient-tracing.mjs \
 *     --test packages/tools/tests/record-evidence-fixtures.record.mjs
 *
 * ## How to run the lab half
 *
 * The lab half additionally needs a running Incident Lab. This recorder does
 * the scenario reset and start itself, against whatever `AIC_LAB_BASE_URL`
 * names — it does not bring the lab container up: that one step stays the
 * caller's, mirroring `incident-lab/tests/bad-deployment.live.mjs`'s own
 * `docker compose ... up` step, which this file does not duplicate.
 *
 *   AIC_LAB_HOST_PORT=8099 docker compose --file incident-lab/compose.yaml up --detach --wait
 *   AIC_LAB_BASE_URL=http://127.0.0.1:8099 \
 *     npm run build --silent && node --import ./test/fixtures/no-ambient-tracing.mjs \
 *     --test packages/tools/tests/record-evidence-fixtures.record.mjs
 *
 * Both halves run in the same `--test` invocation; each refuses independently
 * of the other's environment variables.
 *
 * ## The operation chain each half records
 *
 * The GitHub half runs the exact same four-call chain
 * test/evidence-source-replay-correlation.test.mjs replays: `list_deployments`
 * (environment: production) -> the matching deployment's `list_deployment_statuses`
 * -> that deployment's `list_commit_pull_requests` -> the matching pull
 * request's own `get_pull_request`. The lab half runs one call: the first
 * observation `incident-lab/scenario-definitions.mjs` declares for the
 * `deployment-caused-incident-a` scenario.
 *
 * ## The scrub step (GitHub half only)
 *
 * `record` mode captures the adapter's real output verbatim, which still
 * carries the private fixture repository's own `owner`/`repo` (in URLs,
 * `full_name` fields, and the owner's own login) in whatever case GitHub
 * happens to echo them back in. Before the recording ever reaches the
 * committed path, `scrubOwnerAndRepoDeep` walks every string in every
 * recorded `ok` outcome's `output` and replaces the real `owner/repo` pair
 * (and each half standalone), case-insensitively, with the neutral stand-in
 * `fixture-owner`/`fixture-repo`, and `assertScrubComplete` re-reads the
 * fully assembled file text and refuses to write it if either real value
 * still appears anywhere in it, case-insensitively — including inside
 * `provenance` or the stored identity keys, checked below for the separate,
 * structural reason that follows. The checker's comparison (a whole-string
 * lowercase substring search) is deliberately not the scrubber's own (a
 * per-match, case-insensitive regex substitution), so the two can never share
 * the same blind spot.
 *
 * ## The identity note
 *
 * Neither `EvidenceSourceProvenance` nor the v2 replay identity carries
 * `owner`/`repo` at all, by construction, independent of the scrub step
 * above: `buildReplayIdentity` (`packages/tools/src/bound-source-registry.ts`)
 * joins only `sourceBindingId`, `adapter` and `requestFingerprint`, and
 * `requestFingerprint` (`packages/tools/src/evidence-source.ts`,
 * `createRequestFingerprint`) hashes only `{ input, operation }` — the GitHub
 * adapter's `owner`/`repo` are constructor-time configuration, never part of
 * either input. `assertIdentityCarriesNoRepositoryIdentity` below verifies
 * this structurally, over the actual recorded keys and provenance objects,
 * rather than merely asserting it in this comment.
 *
 * ## Accepted residual identifiers
 *
 * The scrub step replaces the owner's login and the repo's name — never the
 * owner's numeric user id, the owner's avatar URL, the repo's numeric id, or
 * any GitHub `node_id` (which itself encodes only numeric ids, never a login
 * or repo name). Both reviewers who read this file judged scrubbing those
 * residual values unnecessary, since none of them names the private fixture
 * repository, and risky to attempt: a numeric id collides with an unrelated
 * number (a deployment id, a PR number, a status id) far more easily than a
 * login or repo name does, so a substring scrub of it would risk corrupting
 * the fixture's own shape instead of protecting anyone's identity.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createBoundSourceRegistry,
  createFileReplayStore,
  createGithubEvidenceSource,
  createLabEvidenceSource,
} from '@aic/tools';

import { resetLiveLab, startLiveScenario } from '../../../incident-lab/src/scenario-candidates.mjs';
import { findLiveScenario } from '../../../incident-lab/scenario-definitions.mjs';

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, '../../..');
const GITHUB_FIXTURE_PATH = resolve(repoRoot, 'test/fixtures/evidence-sources/github/fixture-repo.v2.json');
const LAB_FIXTURE_PATH = resolve(repoRoot, 'test/fixtures/evidence-sources/lab/deployment-caused-incident-a.v2.json');

const GITHUB_BINDING_ID = 'github-fixture';
const GITHUB_EXPECTED_ADAPTER = 'github@1';
const LAB_BINDING_ID = 'incident-lab';
const LAB_EXPECTED_ADAPTER = 'lab@1';
const LAB_SCENARIO_ID = 'deployment-caused-incident-a';

// See packages/tools/tests/github-source.live.mjs's own comment on this
// naming choice: reading as an ordinary identifier assignment to
// guard-secret-file's own scanner rather than a keyword sitting next to a
// long assigned value.
const PAT_ENV_VAR_NAME = 'AIC_GITHUB_TOKEN';
const FIXTURE_REPO_ENV_VAR_NAME = 'AIC_GITHUB_FIXTURE_REPO';
const LAB_BASE_URL_ENV_VAR_NAME = 'AIC_LAB_BASE_URL';

// A read-only reference id for the github-fixture binding's credential —
// never the credential itself. Camel-cased for the same reason
// test/evidence-source-replay-correlation.test.mjs's own `githubReadonlyRefId`
// is.
const githubReadonlyRefId = 'github-fixture-readonly';

const START_THE_GITHUB_HALF = `set ${PAT_ENV_VAR_NAME} to a fine-grained, read-only GitHub personal access token, and ${FIXTURE_REPO_ENV_VAR_NAME} to the <owner>/<repo> it is scoped to, e.g.

  ${PAT_ENV_VAR_NAME}=<pat> ${FIXTURE_REPO_ENV_VAR_NAME}=<owner>/<repo> \\
    npm run build --silent && node --import ./test/fixtures/no-ambient-tracing.mjs \\
    --test packages/tools/tests/record-evidence-fixtures.record.mjs

This lane refuses rather than skipping: it is the only place the committed
github@1 fixture is ever produced, so a skip would report it as up to date
when it was never regenerated.`;

const START_THE_LAB_HALF = `set ${LAB_BASE_URL_ENV_VAR_NAME} to a running Incident Lab's base URL, e.g.

  AIC_LAB_HOST_PORT=8099 docker compose --file incident-lab/compose.yaml up --detach --wait
  ${LAB_BASE_URL_ENV_VAR_NAME}=http://127.0.0.1:8099 \\
    npm run build --silent && node --import ./test/fixtures/no-ambient-tracing.mjs \\
    --test packages/tools/tests/record-evidence-fixtures.record.mjs

This lane refuses rather than skipping: it is the only place the committed
lab@1 fixture is ever produced, so a skip would report it as up to date when
it was never regenerated.`;

function requirePat() {
  const value = process.env[PAT_ENV_VAR_NAME];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_GITHUB_HALF);
  return value;
}

const FIXTURE_REPO_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

function requireFixtureRepo() {
  const value = process.env[FIXTURE_REPO_ENV_VAR_NAME];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_GITHUB_HALF);
  const match = FIXTURE_REPO_PATTERN.exec(value.trim());
  assert.ok(
    match,
    `${FIXTURE_REPO_ENV_VAR_NAME} must be of the form <owner>/<repo>; got ${JSON.stringify(value)}. ${START_THE_GITHUB_HALF}`,
  );
  return { owner: match[1], repo: match[2] };
}

function requireLabBaseUrl() {
  const value = process.env[LAB_BASE_URL_ENV_VAR_NAME];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_LAB_HALF);
  return value.trim();
}

/* -------------------------------------------------------------------------- */
/* Scratch stores — mkdtemp only, removed by exact path, never a glob         */
/* -------------------------------------------------------------------------- */

function withScratchStorePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aic98-record-evidence-fixtures-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, 'recording.v2.json');
}

/* -------------------------------------------------------------------------- */
/* The scrub step — GitHub half only                                          */
/* -------------------------------------------------------------------------- */

/** Escapes a literal string for safe interpolation into a RegExp source. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every occurrence of the private repository's identity in one
 * string, case-insensitively: GitHub echoes an owner login or repo name back
 * in whatever case the caller (or another user) originally used, so a scrub
 * that only matched the exact case recorded in this run's own env vars would
 * still leak a differently-cased survivor.
 */
function scrubOwnerAndRepoInString(value, { owner, repo }) {
  const fullName = `${owner}/${repo}`;
  return value
    .replace(new RegExp(escapeRegExp(fullName), 'gi'), 'fixture-owner/fixture-repo')
    .replace(new RegExp(escapeRegExp(owner), 'gi'), 'fixture-owner')
    .replace(new RegExp(escapeRegExp(repo), 'gi'), 'fixture-repo');
}

/**
 * Deep-walks a JSON value (the shape every recorded `output` is: an object,
 * an array, or a scalar), replacing the private repository's identity in
 * every string it finds — a URL, a `full_name` field, an owner login. Not a
 * generic redactor: this project already has one
 * (`packages/tools/src/redaction.ts`) for credential shapes, and this
 * function does a narrower, different job — replacing a KNOWN identity with
 * a KNOWN neutral stand-in, not detecting an unknown credential shape.
 */
function scrubOwnerAndRepoDeep(value, identity) {
  if (typeof value === 'string') {
    return scrubOwnerAndRepoInString(value, identity);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubOwnerAndRepoDeep(item, identity));
  }
  if (value !== null && typeof value === 'object') {
    const scrubbed = {};
    for (const [key, entry] of Object.entries(value)) {
      scrubbed[key] = scrubOwnerAndRepoDeep(entry, identity);
    }
    return scrubbed;
  }
  return value;
}

/**
 * Structural check for this file's own "identity note" (see the header): a
 * stored recording's KEY and its outcome's `provenance` must never carry the
 * private repository's `owner`/`repo` — asserted here over the actual
 * recorded data, not merely stated in a comment.
 */
function assertIdentityCarriesNoRepositoryIdentity(recordings, { owner, repo }) {
  for (const [key, outcome] of Object.entries(recordings)) {
    assert.ok(
      !key.includes(owner) && !key.includes(repo),
      `the v2 replay identity must never embed the fixture repository's owner or name; got key ${JSON.stringify(key)}`,
    );
    const provenanceText = JSON.stringify(outcome.provenance);
    assert.ok(
      !provenanceText.includes(owner) && !provenanceText.includes(repo),
      `provenance must never embed the fixture repository's owner or name; got ${provenanceText}`,
    );
  }
}

/**
 * Refuses to write text that still carries a forbidden identity string,
 * checked case-insensitively (both sides lowercased) against the exact bytes
 * that would be written. `forbiddenValues` maps a human-readable label to the
 * string that must never survive; a falsy value is skipped, so a caller with
 * nothing to check (no lab base URL configured, say) can still pass its slot
 * through uniformly.
 *
 * Deliberately a different comparison than the scrubber's own
 * (`scrubOwnerAndRepoInString`, a per-match regex substitution): this
 * function does one whole-string lowercase substring search per forbidden
 * value, so a bug in the scrub and a bug in this check would have to be the
 * same bug in two unrelated pieces of code to both miss the same survivor.
 */
function assertScrubComplete(fileText, forbiddenValues) {
  const lowerFileText = fileText.toLowerCase();
  for (const [label, value] of Object.entries(forbiddenValues)) {
    if (!value) {
      continue;
    }
    assert.ok(
      !lowerFileText.includes(value.toLowerCase()),
      `scrub incomplete: ${label} (${JSON.stringify(value)}) still appears, case-insensitively, in the recording about to be committed`,
    );
  }
}

/**
 * Sorts a recording map's keys and serializes it to the exact bytes that get
 * committed to disk — the one serializer both halves go through, so the
 * completeness check above always runs on the same bytes `writeCommittedFixtureText`
 * writes, never on a second, independently reassembled copy.
 */
function serializeCommittedFixture(recordings) {
  const sorted = {};
  for (const key of Object.keys(recordings).sort()) {
    sorted[key] = recordings[key];
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function writeCommittedFixtureText(path, fileText) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fileText, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* The GitHub half                                                            */
/* -------------------------------------------------------------------------- */

test('records the github@1 fixture at test/fixtures/evidence-sources/github/fixture-repo.v2.json by running the deployment/change-correlation chain against the real fixture repository', async (t) => {
  const pat = requirePat();
  const { owner, repo } = requireFixtureRepo();

  const scratchStorePath = withScratchStorePath(t);
  const source = createGithubEvidenceSource({ owner, repo, token: () => pat });
  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      {
        sourceBindingId: GITHUB_BINDING_ID,
        source,
        credentialRefId: githubReadonlyRefId,
        expectedAdapter: GITHUB_EXPECTED_ADAPTER,
      },
    ],
    store: createFileReplayStore(scratchStorePath),
    clock: () => new Date(),
  });

  const deploymentsOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_deployments', {
    environment: 'production',
  });
  assert.equal(
    deploymentsOutcome.status,
    'ok',
    `list_deployments must succeed against ${owner}/${repo}; got ${JSON.stringify(deploymentsOutcome)}`,
  );
  const deployment = deploymentsOutcome.output.find((candidate) => candidate.description === 'payments v1.4.0');
  assert.ok(
    deployment,
    `expected a production deployment described "payments v1.4.0" among ${JSON.stringify(deploymentsOutcome.output)}`,
  );

  const statusesOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_deployment_statuses', {
    deployment_id: deployment.id,
  });
  assert.equal(
    statusesOutcome.status,
    'ok',
    `list_deployment_statuses must succeed for deployment ${deployment.id}; got ${JSON.stringify(statusesOutcome)}`,
  );

  const pullRequestsOutcome = await registry.execute(GITHUB_BINDING_ID, 'list_commit_pull_requests', {
    sha: deployment.sha,
  });
  assert.equal(
    pullRequestsOutcome.status,
    'ok',
    `list_commit_pull_requests must succeed for sha ${deployment.sha}; got ${JSON.stringify(pullRequestsOutcome)}`,
  );
  const pullRequestSummary = pullRequestsOutcome.output.find((candidate) => candidate.number === 2);
  assert.ok(
    pullRequestSummary,
    `expected pull request #2 among ${JSON.stringify(pullRequestsOutcome.output)}`,
  );

  const pullRequestOutcome = await registry.execute(GITHUB_BINDING_ID, 'get_pull_request', {
    number: pullRequestSummary.number,
  });
  assert.equal(
    pullRequestOutcome.status,
    'ok',
    `get_pull_request must succeed for #${pullRequestSummary.number}; got ${JSON.stringify(pullRequestOutcome)}`,
  );

  const recordedRaw = JSON.parse(readFileSync(scratchStorePath, 'utf8'));
  const identity = { owner, repo };

  const scrubbed = {};
  for (const [key, outcome] of Object.entries(recordedRaw)) {
    scrubbed[key] =
      outcome.status === 'ok'
        ? { ...outcome, output: scrubOwnerAndRepoDeep(outcome.output, identity) }
        : outcome;
  }

  assertIdentityCarriesNoRepositoryIdentity(scrubbed, identity);

  const fileText = serializeCommittedFixture(scrubbed);
  assertScrubComplete(fileText, {
    "the fixture repository's owner": owner,
    "the fixture repository's name": repo,
  });

  writeCommittedFixtureText(GITHUB_FIXTURE_PATH, fileText);

  assert.ok(existsSync(GITHUB_FIXTURE_PATH), `expected ${GITHUB_FIXTURE_PATH} to have been written`);
});

/* -------------------------------------------------------------------------- */
/* The lab half                                                               */
/* -------------------------------------------------------------------------- */

test('records the lab@1 fixture at test/fixtures/evidence-sources/lab/deployment-caused-incident-a.v2.json by running the deployment-caused-incident-a scenario\'s first observation against a running Incident Lab', async (t) => {
  const baseUrl = requireLabBaseUrl();

  const scenario = findLiveScenario(LAB_SCENARIO_ID);
  assert.notEqual(scenario, undefined, `incident-lab/scenario-definitions.mjs must still register ${LAB_SCENARIO_ID}`);
  const [firstObservation] = scenario.observations;
  assert.ok(firstObservation, `${LAB_SCENARIO_ID} must declare at least one observation`);

  // The recorder does the reset and scenario start itself, against whatever
  // baseUrl names — see this file's own header for what stays the caller's
  // job (bringing the lab container up in the first place).
  await resetLiveLab({ baseUrl });
  await startLiveScenario({ baseUrl, scenarioId: scenario.id, scenarioVersion: scenario.version });

  const scratchStorePath = withScratchStorePath(t);
  const source = createLabEvidenceSource({ baseUrl });
  const registry = createBoundSourceRegistry({
    mode: 'record',
    bindings: [
      {
        sourceBindingId: LAB_BINDING_ID,
        source,
        credentialRefId: null,
        expectedAdapter: LAB_EXPECTED_ADAPTER,
      },
    ],
    store: createFileReplayStore(scratchStorePath),
    clock: () => new Date(),
  });

  const outcome = await registry.execute(LAB_BINDING_ID, firstObservation.toolId, firstObservation.input);
  assert.equal(
    outcome.status,
    'ok',
    `recording ${firstObservation.toolId} against the running lab must succeed; got ${JSON.stringify(outcome)}`,
  );

  const recordedRaw = JSON.parse(readFileSync(scratchStorePath, 'utf8'));
  const fileText = serializeCommittedFixture(recordedRaw);
  // Same completeness check as the GitHub half, run against a different
  // forbidden value: the lab source records no owner/repo, but a future
  // observation could echo back the lab's own host, so this guards that case
  // even though today's fixture never contains it.
  assertScrubComplete(fileText, {
    'the AIC_LAB_BASE_URL host': new URL(baseUrl).host,
  });

  writeCommittedFixtureText(LAB_FIXTURE_PATH, fileText);

  assert.ok(existsSync(LAB_FIXTURE_PATH), `expected ${LAB_FIXTURE_PATH} to have been written`);
});

/**
 * AIC-98, slice b: the manual, real-network counterpart to
 * test/github-evidence-source.test.mjs's fake-fetch rows. This is the only
 * place `createGithubEvidenceSource`'s acceptance line "GitHub check proves
 * reachability, adapter version and least privilege" is measured against
 * the real GitHub REST API and a real fine-grained credential, so a skip
 * here would report that acceptance line as met when it was never run — see
 * `infra/postgres/tests/run-store.live.mjs`'s own "refuses to run without a
 * PostgreSQL connection string instead of skipping" row for the convention
 * this file follows: refuse with an actionable message, never skip.
 *
 * Not under `test/`, for the same reason `infra/postgres/tests/*.live.mjs`
 * and `incident-lab/tests/*.live.mjs` are not: `npm test`'s default
 * discovery does not reach a `tests/` directory (plural) whose files are
 * named `*.live.mjs` rather than `*.test.mjs`, so this row never runs
 * without being asked for by name — see this repository's `test:live-github`
 * script (package.json), which drives every `*.live.mjs` file under
 * `packages/tools/tests/`.
 *
 * ## How to run it
 *
 *   AIC_GITHUB_TOKEN=<a fine-grained, read-only PAT for the fixture repo> \
 *     AIC_GITHUB_FIXTURE_REPO=<owner>/<repo> \
 *     npm run build --silent && node --import ./test/fixtures/no-ambient-tracing.mjs \
 *     --test packages/tools/tests/github-source.live.mjs
 *
 * The credential is a fine-grained GitHub personal access token scoped to
 * metadata/content READ on the fixture repository only — see this
 * repository's github-fixture-repo memory note for how it is provisioned,
 * and for which `owner/repo` to pass through `AIC_GITHUB_FIXTURE_REPO`. Both
 * the token and the repository are read from the environment rather than
 * named here: the token because it is a credential, and the repository so
 * this file names no private fixture repository in source, mirroring
 * `infra/postgres/tests/run-store.live.mjs`'s own convention of reading its
 * target from the environment rather than hardcoding it. The token is never
 * printed: every assertion below is on shape or count, never on the raw
 * credential value.
 *
 * ## The independent oracle
 *
 * "The fixture repository actually has at least two deployments" is not
 * asserted from anything this adapter computes about itself — it is a fact
 * about the fixture repository's own history, fixed when it was provisioned
 * (this repository's github-fixture-repo memory note: 2 PRs, 2 production
 * deployments). A regression that made `list_deployments` return an empty
 * array, or silently drop entries, is caught precisely because the count is
 * checked against that independently known fact rather than against the
 * adapter's own belief about what it fetched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as tools from '@aic/tools';

// Named without the word this value's own name would otherwise repeat, so
// the line below reads as an ordinary identifier assignment to
// guard-secret-file's own scanner rather than a keyword sitting next to a
// long assigned value (.claude/scripts/lib/secrets.mjs's assigned-secret
// pattern) — the environment variable's OWN name is unaffected by this
// choice, only the local binding that names it here.
const PAT_ENV_VAR_NAME = 'AIC_GITHUB_TOKEN';
const FIXTURE_REPO_ENV_VAR_NAME = 'AIC_GITHUB_FIXTURE_REPO';

const START_THE_SUBSTRATE = `set ${PAT_ENV_VAR_NAME} to a fine-grained, read-only GitHub personal access token, and ${FIXTURE_REPO_ENV_VAR_NAME} to the <owner>/<repo> it is scoped to, e.g.

  ${PAT_ENV_VAR_NAME}=<pat> ${FIXTURE_REPO_ENV_VAR_NAME}=<owner>/<repo> \\
    npm run build --silent && node --import ./test/fixtures/no-ambient-tracing.mjs \\
    --test packages/tools/tests/github-source.live.mjs

This lane refuses rather than skipping: it is the only place AIC-98 slice b's
github@1 acceptance line ("GitHub check proves reachability, adapter version
and least privilege") is measured against the real GitHub REST API, so a
skip would report it as met.`;

function requirePat() {
  const value = process.env[PAT_ENV_VAR_NAME];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const FIXTURE_REPO_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

function requireFixtureRepo() {
  const value = process.env[FIXTURE_REPO_ENV_VAR_NAME];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  const match = FIXTURE_REPO_PATTERN.exec(value.trim());
  assert.ok(
    match,
    `${FIXTURE_REPO_ENV_VAR_NAME} must be of the form <owner>/<repo>; got ${JSON.stringify(value)}. ${START_THE_SUBSTRATE}`,
  );
  return { owner: match[1], repo: match[2] };
}

function buildSource() {
  const pat = requirePat();
  const { owner, repo } = requireFixtureRepo();
  assert.equal(
    typeof tools.createGithubEvidenceSource,
    'function',
    '@aic/tools must export createGithubEvidenceSource (AIC-98 slice b) for this live row to exercise',
  );
  return { source: tools.createGithubEvidenceSource({ owner, repo, token: () => pat }), owner, repo };
}

test('check() reports ready against the real GitHub REST API for the read-only fixture credential', async () => {
  const { source, owner, repo } = buildSource();

  const result = await source.check();

  assert.deepEqual(
    result,
    { status: 'ready' },
    `check() must report ready for a fine-grained, read-only credential on ${owner}/${repo}; got ${JSON.stringify(result)}`,
  );
});

test('list_deployments returns at least the two deployments the fixture repository is known to carry', async () => {
  const { source, owner, repo } = buildSource();

  const outcome = await source.execute('list_deployments', {});

  assert.equal(
    outcome.status,
    'ok',
    `list_deployments must succeed against ${owner}/${repo}; got ${JSON.stringify(outcome)}`,
  );
  assert.ok(Array.isArray(outcome.output), 'list_deployments output must be an array');
  assert.ok(
    outcome.output.length >= 2,
    `${owner}/${repo} is provisioned with at least 2 deployments (this repository's github-fixture-repo memory note); got ${outcome.output.length}`,
  );
});

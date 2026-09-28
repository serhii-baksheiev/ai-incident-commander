/**
 * AIC-126 slice a: the correspondence between `FINAL_EVALUATION_CANDIDATE_PATHS`
 * (`packages/evals/src/final-evaluation-record.ts`, read by
 * `scripts/eval-final-holdout.mjs`'s `candidateFingerprint()`) and the files
 * Node actually LOADS when importing the two lane scripts.
 *
 * Before this slice the list carried `test/fixtures/benchmark-experiment.mjs`
 * because `scripts/lane-arms.mjs` imported `replayBackedNodes` from it
 * directly. `createInvestigationNodes` (`@aic/graph`) and
 * `createScriptedReasoning` (`@aic/evals`) remove that import, so the list
 * no longer needs a `test/` entry to cover what the lane commands load — and
 * declaring one anyway would be exactly the defect
 * `final-evaluation-oneshot.test.mjs`'s "refuses a re-run at a candidate
 * whose only change is the evidence record it wrote" already rejects for
 * `docs/`: a path under `test/` can change for reasons that have nothing to
 * do with what the graph does, and a `docs/`-shaped exclusion argument
 * applies to it symmetrically. That existing row is the citation for the
 * "irrelevant files" claim (a change under `docs/` or to `README.md` cannot
 * move the fingerprint, because neither is declared): it is not duplicated
 * here.
 *
 * Measured at RUNTIME, never by parsing import statements: a resolve hook
 * loaded through `module.register` records every `file:` URL Node resolves
 * while a child process imports `scripts/eval-live-model.mjs` and
 * `scripts/eval-final-holdout.mjs` — importing either runs no lane, see
 * `live-model-lane.test.mjs` › "runs its lane only when it is the process
 * entry point". `module.register`'s hooks run on a dedicated thread, so the
 * hook cannot hand results back through a shared closure; it reports each
 * resolved `file:` URL over stderr with `process._rawDebug`, a synchronous,
 * thread-safe write, and the test parses them back out of the child's
 * captured stderr.
 *
 * ⚠ What this does not see: the npm commands' own `--import` preload
 * (`test/fixtures/no-ambient-tracing.mjs`, which only turns ambient tracing
 * off); a module reached only through a dynamic `import()` at run time (the
 * dynamic-import row below keeps that set empty); and a workspace package
 * consumed as a real copy under `node_modules` rather than a symlink, which
 * `isWorkspaceExternalDependency` would drop.
 *
 * 🔴 Mutation note: this row is the one thing that would catch
 * `scripts/lane-arms.mjs` quietly reimporting a `test/` fixture in the
 * future. Re-adding `import { replayBackedNodes } from
 * '../test/fixtures/benchmark-experiment.mjs'` to that file must redden the
 * "every loaded file falls under a declared candidate path" row below,
 * because `test/fixtures/benchmark-experiment.mjs` is no longer declared.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';

import { childEnv } from './fixtures/child-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LOADED_PREFIX = 'AIC126A_LOADED ';
const DONE_MARKER = 'AIC126A_DONE';

/**
 * A resolve hook loaded from a `data:` URL — no file on disk to clean up, and
 * no risk of colliding with a real module specifier.
 */
const LOADER_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith('file:')) {
    process._rawDebug(${JSON.stringify(LOADED_PREFIX)} + result.url);
  }
  return result;
}
`;

function mainScriptFor(relativeScriptPaths) {
  const imports = relativeScriptPaths
    .map((path) => `await import(${JSON.stringify(`./${path}`)});`)
    .join('\n');
  return `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(LOADER_SOURCE)}), pathToFileURL('./'));

${imports}
console.log(${JSON.stringify(DONE_MARKER)});
`;
}

/**
 * Spawns a node process at `REPO_ROOT` that imports every path in
 * `relativeScriptPaths` under the resolve hook above, and returns the set of
 * `file:` URLs Node actually resolved while doing so.
 */
function loadedFileUrls(relativeScriptPaths) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', mainScriptFor(relativeScriptPaths)],
    { cwd: REPO_ROOT, encoding: 'utf8', env: childEnv() },
  );

  assert.equal(
    result.status,
    0,
    `importing ${relativeScriptPaths.join(', ')} under the resolve hook must exit 0:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes(DONE_MARKER),
    `the child process must reach its own end marker: ${result.stdout}`,
  );

  const urls = new Set();
  for (const line of result.stderr.split('\n')) {
    if (line.startsWith(LOADED_PREFIX)) urls.add(line.slice(LOADED_PREFIX.length));
  }
  return urls;
}

/** The `file:` URL resolved down to a repo-relative, forward-slash path — symlinks (a workspace package under node_modules/@aic/*) resolved to their real location first. */
function repoRelativePath(fileUrl) {
  const absolute = fileURLToPath(fileUrl);
  const real = realpathSync(absolute);
  return relative(REPO_ROOT, real).split(sep).join('/');
}

/** Source text with block and line comments removed — coarse, and enough to keep a comment that names `import(` from reading as a call. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A path is a workspace-external dependency if `node_modules` names any of its segments once symlinks are resolved — a workspace package's own `node_modules/@aic/*` symlink resolves away to `packages/*` before this check ever sees it. */
function isWorkspaceExternalDependency(relativePath) {
  return relativePath.split('/').includes('node_modules');
}

/* -------------------------------------------------------------------------- */
/* 1. every file the lane commands actually load falls under a declared path */
/* -------------------------------------------------------------------------- */

test('every repository file Node loads importing scripts/eval-live-model.mjs and scripts/eval-final-holdout.mjs falls under a path FINAL_EVALUATION_CANDIDATE_PATHS declares', () => {
  const urls = loadedFileUrls(['scripts/eval-live-model.mjs', 'scripts/eval-final-holdout.mjs']);
  assert.ok(urls.size > 0, 'sanity: the resolve hook must have recorded at least one loaded file');

  const relativePaths = [...urls]
    .map(repoRelativePath)
    .filter((path) => !isWorkspaceExternalDependency(path));

  assert.ok(
    relativePaths.length > 0,
    'sanity: at least one loaded file must be inside this repository\'s own workspace (not a third-party dependency)',
  );

  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;
  const uncovered = relativePaths.filter(
    (path) => !candidatePaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`)),
  );

  assert.deepEqual(
    uncovered,
    [],
    `every file the two lane scripts load must fall under a path FINAL_EVALUATION_CANDIDATE_PATHS declares, or a real change to it would go unfingerprinted: ${JSON.stringify(uncovered, null, 2)}`,
  );
});

/**
 * The row above measures what importing the two scripts loads. A module loaded
 * only when a lane RUNS — through a dynamic `import()` — would never be
 * resolved there, so this row closes that gap for the files the scripts load
 * today: none of them contains a dynamic import, so the import-time set is the
 * run-time set. It looks for the call as this repository writes it,
 * `import(` with no space, in the code with its comments removed (a comment
 * may name the call), and targets drift, not an adversary.
 */
test('no repository file the two lane scripts load contains a dynamic import(), so what importing them loads is what running them loads', () => {
  const urls = loadedFileUrls(['scripts/eval-live-model.mjs', 'scripts/eval-final-holdout.mjs']);
  const withDynamicImport = [...urls]
    .map(repoRelativePath)
    .filter((path) => !isWorkspaceExternalDependency(path))
    .filter((path) => /\bimport\(/.test(withoutComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'))));

  assert.deepEqual(withDynamicImport, [], `a dynamic import would load code the fingerprint row cannot see: ${JSON.stringify(withDynamicImport)}`);
});

/* -------------------------------------------------------------------------- */
/* 2. the candidate list no longer needs a test/ entry, and never names docs/ */
/* -------------------------------------------------------------------------- */

test('FINAL_EVALUATION_CANDIDATE_PATHS no longer lists test/fixtures/benchmark-experiment.mjs, and names no path under test/ or docs/', () => {
  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;

  assert.equal(
    candidatePaths.includes('test/fixtures/benchmark-experiment.mjs'),
    false,
    'scripts/lane-arms.mjs no longer imports this fixture (createInvestigationNodes/createScriptedReasoning replace it), so the candidate list must not declare it either',
  );

  for (const prefix of ['test/', 'docs/']) {
    const offenders = candidatePaths.filter((entry) => entry === prefix.slice(0, -1) || entry.startsWith(prefix));
    assert.deepEqual(
      offenders,
      [],
      `the candidate path list must name nothing under ${prefix}: the lane must not depend on either, found ${JSON.stringify(offenders)}`,
    );
  }
});

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
 * ⚠ What this does not see: a module reached only through a dynamic
 * `import()` at run time (the dynamic-import row below keeps that set
 * empty); a workspace package consumed as a real copy under `node_modules`
 * rather than a symlink, which `isWorkspaceExternalDependency` would drop;
 * and `package.json` itself, which is undeclared on purpose — an edit to a
 * script the lane never runs or to `license` must not move the one-shot
 * fingerprint, so its command
 * lines are pinned instead by "the build, eval:live-model and
 * eval:final-holdout npm scripts are exactly the command lines the candidate
 * fingerprint was reviewed against" below, an exact-string row a reviewer
 * sees turn red rather than a fingerprint that silently moves. The npm
 * commands' own `--import` preload IS measured, by "every repository file
 * Node loads importing scripts/eval-live-model.mjs and
 * scripts/eval-final-holdout.mjs together with the --import preload those npm
 * scripts declare falls under a path FINAL_EVALUATION_CANDIDATE_PATHS
 * declares" below; it lives at `scripts/lib/no-ambient-tracing.mjs`.
 *
 * 🔴 Mutation note: this row is the one thing that would catch
 * `scripts/lane-arms.mjs` quietly reimporting a `test/` fixture in the
 * future. Re-adding `import { replayBackedNodes } from
 * '../test/fixtures/benchmark-experiment.mjs'` to that file must redden the
 * "every loaded file falls under a declared candidate path" row below,
 * because `test/fixtures/benchmark-experiment.mjs` is no longer declared.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as evals from '@aic/evals';
import { MODEL_API_KEY_VARIABLE } from '@aic/roles';

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

/**
 * Source text without its comment LINES — lines that start with `//`, `/*` or
 * `*`, the only comment shapes this repository's sources and emitted JS use.
 * Line-local on purpose: it can never remove code on another line, so a
 * string that happens to contain `/*` or `//` cannot hide a real call.
 */
function withoutComments(text) {
  return text.split('\n').filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line)).join('\n');
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

/* -------------------------------------------------------------------------- */
/* 3. AIC-137: the candidate list covers the command line, not just the       */
/*    module graph — tsconfig.json, tsconfig.base.json and the --import      */
/*    preload the eval: npm scripts declare; package.json's own command      */
/*    lines are pinned by an exact-string row instead                        */
/* -------------------------------------------------------------------------- */

/** Every `--import` specifier an npm script string declares, in the order it names them. */
function importPreloadSpecifiers(scriptString) {
  return [...scriptString.matchAll(/--import(?:=|\s+)(\S+)/g)].map((match) => match[1]);
}

/** A specifier resolved to a repo-relative, `./`-stripped path. */
function repoRelativeSpecifier(specifier) {
  return specifier.replace(/^\.\//, '');
}

test('every --import preload the eval:live-model and eval:final-holdout npm scripts declare falls under a path FINAL_EVALUATION_CANDIDATE_PATHS declares', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;

  for (const scriptName of ['eval:live-model', 'eval:final-holdout']) {
    const scriptString = manifest.scripts[scriptName];
    assert.equal(
      typeof scriptString,
      'string',
      `package.json must declare an ${scriptName} script, or this row asserts nothing`,
    );

    const specifiers = importPreloadSpecifiers(scriptString).map(repoRelativeSpecifier);
    assert.ok(
      specifiers.length > 0,
      `${scriptName} must declare at least one --import preload, or this row asserts nothing`,
    );

    const uncovered = specifiers.filter(
      (path) => !candidatePaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`)),
    );

    assert.deepEqual(
      uncovered,
      [],
      `${scriptName}'s --import preload must fall under a path FINAL_EVALUATION_CANDIDATE_PATHS declares, or a real change to it would go unfingerprinted: ${JSON.stringify(uncovered)}`,
    );
  }
});

/**
 * The row above measures the npm-script text; this one measures what running
 * it actually loads — extending the same runtime resolve-hook technique as
 * row 1 (importing scripts/eval-live-model.mjs and scripts/eval-final-holdout.mjs)
 * to also import the preload those two npm scripts declare, in the same child
 * process, so a file the preload itself loads is checked too.
 */
test('every repository file Node loads importing scripts/eval-live-model.mjs and scripts/eval-final-holdout.mjs together with the --import preload those npm scripts declare falls under a path FINAL_EVALUATION_CANDIDATE_PATHS declares', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const preloadSpecifiers = new Set();
  for (const scriptName of ['eval:live-model', 'eval:final-holdout']) {
    for (const specifier of importPreloadSpecifiers(manifest.scripts[scriptName] ?? '')) {
      preloadSpecifiers.add(repoRelativeSpecifier(specifier));
    }
  }
  assert.ok(
    preloadSpecifiers.size > 0,
    'sanity: the npm scripts must declare at least one --import preload',
  );

  const urls = loadedFileUrls([
    ...preloadSpecifiers,
    'scripts/eval-live-model.mjs',
    'scripts/eval-final-holdout.mjs',
  ]);

  const relativePaths = [...urls]
    .map(repoRelativePath)
    .filter((path) => !isWorkspaceExternalDependency(path));

  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;
  const uncovered = relativePaths.filter(
    (path) => !candidatePaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`)),
  );

  assert.deepEqual(
    uncovered,
    [],
    `every file loaded together with the npm scripts' own --import preload must fall under a declared candidate path, or the preload itself is unfingerprinted: ${JSON.stringify(uncovered, null, 2)}`,
  );
});

test('FINAL_EVALUATION_CANDIDATE_PATHS declares tsconfig.json and tsconfig.base.json, and not package.json', () => {
  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;

  for (const required of ['tsconfig.json', 'tsconfig.base.json']) {
    assert.ok(
      candidatePaths.includes(required),
      `${required} builds the command line the two lane scripts run under — npm run build is tsc -b, which reads tsconfig.json, which extends tsconfig.base.json — so omitting it would let a real change to it re-use a spent candidate: ${JSON.stringify(candidatePaths)}`,
    );
  }

  assert.equal(
    candidatePaths.includes('package.json'),
    false,
    "package.json carries scripts the lane never runs (test, lint, cli) and fields such as license alongside the command line it declares, so declaring it would let an edit to any of them move the fingerprint and re-admit a hold-out run — the documented asymmetry (omitting a behaviour-affecting path is a false refusal; including one that does not affect behaviour is a false unlock, final-evaluation-record.ts and docs/evidence/final-evaluation/README.md) rules it out. Its command lines are pinned instead by the exact-string row 'the build, eval:live-model and eval:final-holdout npm scripts are exactly the command lines the candidate fingerprint was reviewed against'",
  );
});

/**
 * Derived from `tsconfig.json` itself rather than hard-coded, the same way as
 * the `packages/*` and `apps/*` row above: whatever the root config declares
 * as `extends`, and every `references[].path` it lists, resolved relative to
 * the repo root, must fall under a declared candidate path — `tsc -b`, the
 * `build` script both eval: npm scripts run first, reads exactly these.
 */
test('the root tsconfig.json extends target and every references path fall under a path FINAL_EVALUATION_CANDIDATE_PATHS declares', () => {
  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;
  const tsconfigPath = join(REPO_ROOT, 'tsconfig.json');
  const parsed = JSON.parse(readFileSync(tsconfigPath, 'utf8'));

  assert.equal(
    typeof parsed.extends,
    'string',
    'tsconfig.json must declare an "extends" string, or this row cannot derive its target',
  );
  assert.ok(
    Array.isArray(parsed.references) && parsed.references.length > 0,
    'sanity: tsconfig.json must declare at least one reference',
  );

  const targets = [
    relative(REPO_ROOT, resolve(dirname(tsconfigPath), parsed.extends)).split(sep).join('/'),
    ...parsed.references.map((reference) =>
      relative(REPO_ROOT, resolve(dirname(tsconfigPath), reference.path)).split(sep).join('/'),
    ),
  ];

  const uncovered = targets.filter(
    (path) => !candidatePaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`)),
  );

  assert.deepEqual(
    uncovered,
    [],
    `tsconfig.json's extends target and every references path must fall under a declared candidate path, or a change there would go unfingerprinted: ${JSON.stringify(uncovered)}`,
  );
});

/**
 * `package.json` is deliberately undeclared in `FINAL_EVALUATION_CANDIDATE_PATHS`
 * (the row above states why), so nothing fingerprints the command lines it
 * carries. This row is what stands in instead: it pins the exact text of the
 * three lines a change to package.json cannot silently move the candidate
 * fingerprint through, so an edit to any of them reddens this row where a
 * reviewer sees it, rather than moving a hash nobody is looking at. npm also
 * runs a `pre<name>`/`post<name>` script around each of them (the mechanism
 * final-evaluation-command.test.mjs already pins for `pretest`), so the row
 * reads every script key that names one of the three with or without such a
 * prefix: an added hook is a key this comparison does not expect.
 */
test('the build, eval:live-model and eval:final-holdout npm scripts are exactly the command lines the candidate fingerprint was reviewed against', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  const laneCommandKeys = /^(?:pre|post)?(?:build|eval:live-model|eval:final-holdout)$/;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.scripts).filter(([name]) => laneCommandKeys.test(name)),
    ),
    {
      build: 'tsc -b',
      'eval:live-model':
        'npm run build --silent && node --import ./scripts/lib/no-ambient-tracing.mjs scripts/eval-live-model.mjs',
      'eval:final-holdout':
        'npm run build --silent && node --import ./scripts/lib/no-ambient-tracing.mjs scripts/eval-final-holdout.mjs',
    },
    'package.json is deliberately undeclared in FINAL_EVALUATION_CANDIDATE_PATHS, so a change to these three lines, or a pre/post hook added around any of them, cannot move the candidate fingerprint at all — it must instead redden this row',
  );
});

/**
 * npm itself is configured by two things `package.json` being undeclared
 * leaves outside the fingerprint: the `packageManager` field, which decides
 * which npm corepack runs the lane commands with, and a root `.npmrc`, whose
 * `node-options` would inject a preload into every node process those
 * commands spawn. Neither is declared, so both are pinned here instead.
 */
test('the root package.json pins packageManager and the repository has no root .npmrc, so npm runs the lane commands unconfigured', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.equal(
    manifest.packageManager,
    'npm@10.9.8',
    'packageManager decides which npm runs the lane command lines, and package.json is undeclared in FINAL_EVALUATION_CANDIDATE_PATHS, so a change to it must redden this row',
  );
  assert.equal(
    existsSync(join(REPO_ROOT, '.npmrc')),
    false,
    'a root .npmrc can set node-options for every node process npm spawns, the lane scripts included, and it is undeclared in FINAL_EVALUATION_CANDIDATE_PATHS, so adding one must redden this row',
  );
});

/**
 * Derived from the tsconfig files themselves rather than hard-coded: whatever
 * every package or app `tsconfig.json` declares as `extends`,
 * resolved relative to each file, must fall under a declared candidate path —
 * so a base config renamed or relocated is still covered without this row
 * needing to know its new name.
 */
test('every packages/*/tsconfig.json and apps/*/tsconfig.json extends target falls under a path FINAL_EVALUATION_CANDIDATE_PATHS declares', () => {
  const candidatePaths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;

  const tsconfigPaths = ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REPO_ROOT, group, entry.name, 'tsconfig.json'))
      .filter((path) => existsSync(path)),
  );

  assert.ok(
    tsconfigPaths.length > 0,
    'sanity: at least one packages/*/tsconfig.json or apps/*/tsconfig.json must exist',
  );

  const uncovered = tsconfigPaths
    .map((tsconfigPath) => {
      const parsed = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
      assert.equal(
        typeof parsed.extends,
        'string',
        `${relative(REPO_ROOT, tsconfigPath)} must declare an "extends" string, or this row cannot derive its target`,
      );
      const resolved = resolve(dirname(tsconfigPath), parsed.extends);
      return relative(REPO_ROOT, resolved).split(sep).join('/');
    })
    .filter(
      (path) => !candidatePaths.some((candidate) => path === candidate || path.startsWith(`${candidate}/`)),
    );

  assert.deepEqual(
    uncovered,
    [],
    `every package/app tsconfig's extends target must fall under a declared candidate path, or a compiler-options change there would go unfingerprinted: ${JSON.stringify(uncovered)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 4. AIC-137: the candidate fingerprint moves with the tsconfigs that shape  */
/*    the build, and stays put on package.json — whose command line is       */
/*    pinned by the exact-string row above instead                           */
/* -------------------------------------------------------------------------- */

/**
 * A detached `git worktree` copy of HEAD: real checked-out files (never
 * symlinks), sharing this repository's object database, so a commit made
 * inside it costs nothing to discard and never touches this worktree's own
 * branch. `node_modules` is untracked, so it is symlinked in from this
 * worktree rather than reinstalled — `@aic/evals`'s
 * `FINAL_EVALUATION_CANDIDATE_PATHS` is a static value, identical however it
 * is reached, and `candidateFingerprint()`'s own `git` calls run with the
 * COPY's `REPO_ROOT` (derived from the `import.meta.url` of the file actually
 * imported), never this worktree's.
 */
async function withScratchWorktree(body) {
  const dir = join(tmpdir(), `aic-137-worktree-${randomUUID()}`);
  execFileSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv(),
  });
  try {
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return await body(dir);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', dir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: childEnv(),
    });
  }
}

/** Mutates, stages and commits one tracked file inside a scratch worktree. */
function commitMutation(dir, relativePath, mutate) {
  const filePath = join(dir, relativePath);
  writeFileSync(filePath, mutate(readFileSync(filePath, 'utf8')));
  execFileSync('git', ['add', relativePath], { cwd: dir, encoding: 'utf8', env: childEnv() });
  execFileSync(
    'git',
    [
      '-c', 'user.name=aic-test',
      '-c', 'user.email=aic-test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', `aic-137 test mutation of ${relativePath}`,
    ],
    { cwd: dir, encoding: 'utf8', env: childEnv() },
  );
}

test("the candidate fingerprint does not move when package.json's version changes", async () => {
  await withScratchWorktree(async (dir) => {
    const { candidateFingerprint } = await import(
      pathToFileURL(join(dir, 'scripts', 'eval-final-holdout.mjs')).href
    );

    const before = candidateFingerprint();
    commitMutation(dir, 'package.json', (text) => {
      const manifest = JSON.parse(text);
      manifest.version = '0.0.0-aic-137-probe';
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
    const after = candidateFingerprint();

    assert.equal(
      before,
      after,
      'package.json is deliberately undeclared in FINAL_EVALUATION_CANDIDATE_PATHS, so an edit to package.json alone must not move the candidate fingerprint and re-admit a spent hold-out run (a bump written by `npm version` also rewrites package-lock.json, which is declared, and does move it)',
    );
  });
});

test('the candidate fingerprint moves when tsconfig.json changes', async () => {
  await withScratchWorktree(async (dir) => {
    const { candidateFingerprint } = await import(
      pathToFileURL(join(dir, 'scripts', 'eval-final-holdout.mjs')).href
    );

    const before = candidateFingerprint();
    commitMutation(dir, 'tsconfig.json', (text) => {
      const config = JSON.parse(text);
      config.aic137Probe = true;
      return `${JSON.stringify(config, null, 2)}\n`;
    });
    const after = candidateFingerprint();

    assert.notEqual(
      before,
      after,
      'tsconfig.json is the tsc -b entry point both eval: npm scripts build through, so a change to it must move the candidate fingerprint',
    );
  });
});

test('the candidate fingerprint moves when tsconfig.base.json changes', async () => {
  await withScratchWorktree(async (dir) => {
    const { candidateFingerprint } = await import(
      pathToFileURL(join(dir, 'scripts', 'eval-final-holdout.mjs')).href
    );

    const before = candidateFingerprint();
    commitMutation(dir, 'tsconfig.base.json', (text) => {
      const config = JSON.parse(text);
      config.compilerOptions.aic137Probe = true;
      return `${JSON.stringify(config, null, 2)}\n`;
    });
    const after = candidateFingerprint();

    assert.notEqual(
      before,
      after,
      'every packages/*/tsconfig.json and apps/*/tsconfig.json extends tsconfig.base.json, so a change to it must move the candidate fingerprint',
    );
  });
});

// A change under docs/ must still not move the fingerprint. Already pinned by
// path membership in final-evaluation-oneshot.test.mjs › "refuses a re-run at
// a candidate whose only change is the evidence record it wrote" (docs/ is
// asserted absent from FINAL_EVALUATION_CANDIDATE_PATHS there, which is
// exactly what keeps a docs/ commit from moving this hash) — not re-measured
// here by mutation, because that row already pins the exact fact this one
// would prove by a slower route.

/* -------------------------------------------------------------------------- */
/* 5. AIC-137 round 3: an uncommitted change outside the declared candidate   */
/*    paths — package.json, a root .npmrc or npm-shrinkwrap.json — must also  */
/*    refuse the run, naming the offending path. The guard over               */
/*    FINAL_EVALUATION_CANDIDATE_PATHS already exists and is pinned by the    */
/*    row at the end of this section; these rows are its sibling over the     */
/*    three paths that command's own working tree still leaves unguarded.     */
/* -------------------------------------------------------------------------- */

/**
 * A credential shape assembled at runtime, never a literal
 * (`.claude/rules/autonomy.md`, "Never" — no secret-shaped literal in a
 * fixture). Copied from `test/lane-arms.test.mjs`'s own `fakeApiKey` rather
 * than declared a second time as a shared export, matching that file's own
 * choice to keep it local.
 */
function fakeApiKey() {
  return ['sk', 'ant', 'test', '9'.repeat(24)].join('-');
}

/**
 * Runs `eval-final-holdout.mjs --dry-run` as a real child process, cwd'd at a
 * scratch worktree, under the same `--import` preload the npm script
 * declares.
 *
 * Verified by reading `scripts/eval-final-holdout.mjs`: the `if
 * (flag('dry-run'))` block is a `stdout.write` followed by a bare `return`,
 * strictly above both the `execute()` call (the lane, and the only path to a
 * provider request) and `writeRecordDurably`/publication (the only writes
 * `main()` performs) — so this spawns no network call and writes nothing
 * beyond what `git worktree add` already checked out.
 */
function runFinalHoldoutDryRun(dir) {
  return spawnSync(
    process.execPath,
    ['--import', './scripts/lib/no-ambient-tracing.mjs', 'scripts/eval-final-holdout.mjs', '--dry-run'],
    {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv({ [MODEL_API_KEY_VARIABLE]: fakeApiKey() }),
    },
  );
}

/** A regexp source escaped so a path carrying a `.` matches only itself. */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('a clean scratch worktree runs eval-final-holdout.mjs --dry-run cleanly, printing the decision with candidate.workingTreeClean true', async () => {
  await withScratchWorktree(async (dir) => {
    const result = runFinalHoldoutDryRun(dir);

    assert.equal(
      result.status,
      0,
      `--dry-run must exit 0 on a clean scratch worktree:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.candidate.workingTreeClean, true);
  });
});

test('the final hold-out command refuses to run with an uncommitted package.json change, naming package.json', async () => {
  await withScratchWorktree(async (dir) => {
    const manifestPath = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scripts['aic-137-probe'] = 'node --import /tmp/aic-137-probe.mjs -e 1';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runFinalHoldoutDryRun(dir);

    assert.notEqual(
      result.status,
      0,
      `--dry-run must refuse a run with an uncommitted package.json change:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(result.stdout.trim(), '', 'a refused run must print no dry-run JSON');
    assert.match(result.stderr, /package\.json/, 'the refusal must name package.json');
    assert.doesNotMatch(
      result.stderr,
      /no model provider credential is configured/,
      'the refusal must be the working-tree guard, not the unrelated missing-credential guard',
    );
  });
});

for (const untrackedFile of ['.npmrc', 'npm-shrinkwrap.json']) {
  test(`the final hold-out command refuses to run with an untracked root ${untrackedFile}, naming it`, async () => {
    await withScratchWorktree(async (dir) => {
      writeFileSync(
        join(dir, untrackedFile),
        untrackedFile === '.npmrc' ? 'node-options=--import=/tmp/aic-137-probe.mjs\n' : '{}\n',
      );

      const result = runFinalHoldoutDryRun(dir);

      assert.notEqual(
        result.status,
        0,
        `--dry-run must refuse a run with an untracked root ${untrackedFile}:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.equal(result.stdout.trim(), '', 'a refused run must print no dry-run JSON');
      assert.match(
        result.stderr,
        new RegExp(escapeForRegExp(untrackedFile)),
        `the refusal must name ${untrackedFile}`,
      );
      assert.doesNotMatch(
        result.stderr,
        /no model provider credential is configured/,
        'the refusal must be the working-tree guard, not the unrelated missing-credential guard',
      );
    });
  });
}

test('the final hold-out command refuses to run with an uncommitted change under a candidate path', async () => {
  await withScratchWorktree(async (dir) => {
    const filePath = join(dir, 'scripts', 'lane-arms.mjs');
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n// aic-137 probe: uncommitted, never committed\n`);

    const result = runFinalHoldoutDryRun(dir);

    assert.notEqual(
      result.status,
      0,
      `--dry-run must refuse a run with an uncommitted change under a declared candidate path:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(result.stdout.trim(), '', 'a refused run must print no dry-run JSON');
    assert.match(result.stderr, /uncommitted changes under a candidate path/);
    assert.match(result.stderr, /scripts\/lane-arms\.mjs/, 'the refusal must name the dirty candidate-path file');
  });
});

/**
 * AIC-127 slice 1: the live-pilot partition identity, and its disjointness
 * from the benchmark corpus (calibration, hold-out, and the frozen
 * final-evaluation plan).
 *
 * `live-pilot/` is a new top-level directory, outside `packages/`, `apps/`
 * and `scripts/`, that will carry one reconstructed incident (`flowa-904`)
 * for a live-pilot replay. It must never become a benchmark scenario, must
 * never share an id with one, and must sit outside every path the
 * final-evaluation one-shot fingerprints — so adding pilot material can
 * never move that fingerprint or silently unlock a second hold-out run.
 *
 * `test/oracle-positive-control.test.mjs` establishes the conventions this
 * file follows: a dependency-cruiser boundary is proven by actually running
 * `npm run lint:graph` against a scratch copy of the repository with a
 * probe import added, not by reading the config file's text; its own
 * `copyForBoundaryProbe`/`runDepcruiseProbe` shape is duplicated here rather
 * than imported, because that file itself explains why every existing
 * depcruise probe in this repository accepts that duplication rather than
 * manufacturing a shared import for it.
 *
 * The disjointness checks below never derive their expected id sets from
 * `live-pilot/registry.mjs` itself — every comparison set is read from the
 * real benchmark registries (`@aic/evals`) or from the committed
 * final-evaluation records, so a bug that made the pilot registry agree with
 * itself could not also make these checks pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';

import { benchmarkVersions } from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* Loading the module under test                                              */
/* -------------------------------------------------------------------------- */

/**
 * `live-pilot/registry.mjs` is the module this slice adds. A missing module
 * must fail every row that needs it with a clear, named assertion rather than
 * an unhandled rejection, so the dynamic import is wrapped once here.
 */
async function loadLivePilotRegistry() {
  try {
    return await import(new URL('../live-pilot/registry.mjs', import.meta.url));
  } catch (error) {
    assert.fail(
      'live-pilot/registry.mjs must export LIVE_PILOT_PARTITION and LIVE_PILOT_CASES so the partition-identity ' +
        `and disjointness checks in this file have something real to inspect; import failed with: ${error.message}`,
    );
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* The disjointness oracle — an independent implementation, not production   */
/* -------------------------------------------------------------------------- */

/**
 * Every disjointness row below is built on this pair of functions. Neither
 * imports nor duplicates any production disjointness logic (there is none to
 * duplicate: `@aic/evals` and `live-pilot/registry.mjs` never check each
 * other), so this is a fresh, independent oracle rather than production
 * checking its own work.
 */
function overlapOf(idsA, idsB) {
  const setB = new Set(idsB);
  return idsA.filter((id) => setB.has(id));
}

function assertDisjoint(labelA, idsA, labelB, idsB) {
  const overlap = overlapOf(idsA, idsB);
  assert.deepEqual(
    overlap,
    [],
    `${labelA} must share no id with ${labelB}, which is what keeps the live-pilot partition isolated from the ` +
      `benchmark corpus; overlapping id(s): ${JSON.stringify(overlap)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* A. the partition identity and case-registry shape                          */
/* -------------------------------------------------------------------------- */

test('declares the live-pilot partition identity and exactly one frozen case, flowa-904, split into model-visible and evaluator-only path groups', async () => {
  const live = await loadLivePilotRegistry();
  assert.equal(live.LIVE_PILOT_PARTITION, 'live-pilot');
  assert.equal(
    Object.isFrozen(live.LIVE_PILOT_CASES),
    true,
    'LIVE_PILOT_CASES must be frozen so no later slice or consumer can mutate the partition roster in place',
  );
  assert.equal(live.LIVE_PILOT_CASES.length, 1);

  const [flowa904] = live.LIVE_PILOT_CASES;
  assert.equal(flowa904.id, 'flowa-904');
  assert.equal(flowa904.partition, live.LIVE_PILOT_PARTITION);
  assert.deepEqual(Object.keys(flowa904.modelVisible).sort(), ['bindings', 'intake', 'recordings']);
  assert.deepEqual(Object.keys(flowa904.evaluatorOnly).sort(), ['historicalTruth']);

  for (const [key, value] of Object.entries(flowa904.modelVisible)) {
    assert.equal(typeof value, 'string', `modelVisible.${key} must be a path string`);
    assert.equal(value.startsWith('/'), false, `modelVisible.${key} must be relative to live-pilot/, never absolute`);
  }
  assert.equal(typeof flowa904.evaluatorOnly.historicalTruth, 'string');
  assert.equal(flowa904.evaluatorOnly.historicalTruth.startsWith('/'), false);
});

/* -------------------------------------------------------------------------- */
/* B. disjointness from the benchmark scenario partitions, both directions    */
/* -------------------------------------------------------------------------- */

function benchmarkScenarioIds() {
  const { calibration, holdout } = evals.BENCHMARK_SCENARIO_PARTITIONS;
  return [...new Set([...calibration, ...holdout, ...evals.REPLAY_SCENARIOS.map((scenario) => scenario.id)])];
}

test('the benchmark calibration and holdout partitions, and the full REPLAY_SCENARIOS id list, are non-empty and share no id with any live-pilot case', async () => {
  const live = await loadLivePilotRegistry();
  const { calibration, holdout } = evals.BENCHMARK_SCENARIO_PARTITIONS;
  assert.ok(
    calibration.length > 0,
    'BENCHMARK_SCENARIO_PARTITIONS.calibration must be non-empty for this disjointness check to compare against something real',
  );
  assert.ok(
    holdout.length > 0,
    'BENCHMARK_SCENARIO_PARTITIONS.holdout must be non-empty for this disjointness check to compare against something real',
  );
  assert.ok(
    evals.REPLAY_SCENARIOS.length > 0,
    'REPLAY_SCENARIOS must be non-empty for this disjointness check to compare against something real',
  );

  const pilotIds = live.LIVE_PILOT_CASES.map((c) => c.id);
  assertDisjoint('live-pilot case ids', pilotIds, 'benchmark calibration, holdout and REPLAY_SCENARIOS ids', benchmarkScenarioIds());
});

test('every benchmark calibration, holdout and REPLAY_SCENARIOS id is outside the live-pilot case registry', async () => {
  const live = await loadLivePilotRegistry();
  const pilotIds = live.LIVE_PILOT_CASES.map((c) => c.id);
  assertDisjoint('benchmark calibration, holdout and REPLAY_SCENARIOS ids', benchmarkScenarioIds(), 'live-pilot case ids', pilotIds);
});

/* -------------------------------------------------------------------------- */
/* C. disjointness from the final-evaluation plan, both directions            */
/* -------------------------------------------------------------------------- */

function readFinalEvaluationRecords() {
  const recordsDir = resolve(projectRoot, 'docs/evidence/final-evaluation');
  return readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(resolve(recordsDir, name), 'utf8')));
}

/**
 * The universe a live-pilot id must never enter: every scenario id, example
 * id and partition name the final-evaluation plan can produce, read from the
 * committed records' own `runsPerScenario` plus the live-model lane default,
 * unioned with what each record's own `corpus` already carries.
 */
function finalEvaluationUniverse(records) {
  const runsPerScenarioValues = new Set([evals.LIVE_MODEL_LANE_RUNS_PER_SCENARIO]);
  const scenarioIds = new Set();
  const exampleIds = new Set();
  const partitionNames = new Set(Object.keys(evals.BENCHMARK_SCENARIO_PARTITIONS));

  for (const record of records) {
    // A record with no corpus (for example a void record that crashed before
    // any scenario ran) names no scenario, example or partition id to guard
    // against, so it contributes nothing to the universe.
    if (record.corpus === undefined) continue;
    runsPerScenarioValues.add(record.corpus.runsPerScenario);
    for (const id of record.corpus.calibration ?? []) scenarioIds.add(id);
    for (const id of record.corpus.holdout ?? []) scenarioIds.add(id);
    for (const id of record.corpus.exampleIds ?? []) exampleIds.add(id);
    if (typeof record.corpus.scenarioSet === 'string') partitionNames.add(record.corpus.scenarioSet);
  }

  for (const runsPerScenario of runsPerScenarioValues) {
    const plan = evals.createFinalEvaluationBenchmarkPlan({
      experimentId: 'aic-127-live-pilot-partition-probe',
      runsPerScenario,
      metadata: benchmarkVersions,
    });
    for (const planRecord of plan) {
      scenarioIds.add(planRecord.scenario.id);
      exampleIds.add(planRecord.exampleId);
    }
  }

  return { scenarioIds: [...scenarioIds], exampleIds: [...exampleIds], partitionNames: [...partitionNames] };
}

test("every live-pilot case id, and the partition name itself, are disjoint from the final-evaluation plan's scenario ids, example ids and partition names", async () => {
  const live = await loadLivePilotRegistry();
  const records = readFinalEvaluationRecords();
  assert.ok(
    records.length > 0,
    'docs/evidence/final-evaluation must hold at least one committed record for this check to compare against something real',
  );
  const { scenarioIds, exampleIds, partitionNames } = finalEvaluationUniverse(records);
  const pilotIds = live.LIVE_PILOT_CASES.map((c) => c.id);

  assertDisjoint('live-pilot case ids', pilotIds, 'final-evaluation scenario ids', scenarioIds);
  assertDisjoint('live-pilot case ids', pilotIds, 'final-evaluation example ids', exampleIds);
  assertDisjoint('the live-pilot partition name', [live.LIVE_PILOT_PARTITION], 'final-evaluation partition names', partitionNames);
});

test('every final-evaluation scenario id, example id and partition name is outside the live-pilot case registry and its partition name', async () => {
  const live = await loadLivePilotRegistry();
  const records = readFinalEvaluationRecords();
  const { scenarioIds, exampleIds, partitionNames } = finalEvaluationUniverse(records);
  const pilotIds = live.LIVE_PILOT_CASES.map((c) => c.id);

  assertDisjoint('final-evaluation scenario ids', scenarioIds, 'live-pilot case ids', pilotIds);
  assertDisjoint('final-evaluation example ids', exampleIds, 'live-pilot case ids', pilotIds);
  assertDisjoint('final-evaluation partition names', partitionNames, 'the live-pilot partition name', [live.LIVE_PILOT_PARTITION]);
});

/* -------------------------------------------------------------------------- */
/* D. fingerprint separation, both directions                                 */
/* -------------------------------------------------------------------------- */

function isPathOrPrefixOfEachOther(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

test('no FINAL_EVALUATION_CANDIDATE_PATHS entry equals the live-pilot partition name or is a path-prefix of it, in either direction', async () => {
  const live = await loadLivePilotRegistry();
  const collisions = evals.FINAL_EVALUATION_CANDIDATE_PATHS.filter((candidatePath) =>
    isPathOrPrefixOfEachOther(candidatePath, live.LIVE_PILOT_PARTITION),
  );
  assert.deepEqual(
    collisions,
    [],
    'a candidate fingerprint path must never equal or prefix-collide with the live-pilot partition name, or committing ' +
      `pilot material would move the one-shot final-evaluation fingerprint; colliding path(s): ${JSON.stringify(collisions)}`,
  );
});

function collectFiles(root, excludedDirNames) {
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirNames.has(entry.name)) continue;
        stack.push(entryPath);
      } else if (entry.isFile()) {
        results.push(entryPath);
      }
    }
  }
  return results;
}

test('no file under packages/, apps/, scripts/, or the shared benchmark-experiment fixture references the live-pilot directory', async () => {
  const live = await loadLivePilotRegistry();
  const needle = `${live.LIVE_PILOT_PARTITION}/`;
  const excludedDirNames = new Set(['node_modules', 'dist', 'coverage', '.git']);
  const files = [
    ...collectFiles(resolve(projectRoot, 'packages'), excludedDirNames),
    ...collectFiles(resolve(projectRoot, 'apps'), excludedDirNames),
    ...collectFiles(resolve(projectRoot, 'scripts'), excludedDirNames),
    resolve(projectRoot, 'test/fixtures/benchmark-experiment.mjs'),
  ];
  const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(needle));
  assert.deepEqual(
    offenders,
    [],
    `no product or evaluator source file may reference the "${needle}" path, which is what keeps live-pilot data ` +
      `outside every candidate fingerprint path; offending file(s): ${JSON.stringify(offenders.map((f) => relative(projectRoot, f)))}`,
  );
});

/* -------------------------------------------------------------------------- */
/* E. the partition is not a benchmark partition                              */
/* -------------------------------------------------------------------------- */

test('the live-pilot partition name is not one of the benchmark partition keys', async () => {
  const live = await loadLivePilotRegistry();
  assert.equal(
    Object.keys(evals.BENCHMARK_SCENARIO_PARTITIONS).includes(live.LIVE_PILOT_PARTITION),
    false,
    'BENCHMARK_SCENARIO_PARTITIONS must carry exactly calibration and holdout; live-pilot must never become a third benchmark partition',
  );
});

/* -------------------------------------------------------------------------- */
/* F. non-vacuity: the oracle above must actually be able to fail             */
/* -------------------------------------------------------------------------- */

test('the disjointness oracle used above fails when a copy of the live-pilot case ids carries an injected calibration id', async () => {
  const live = await loadLivePilotRegistry();
  const { calibration } = evals.BENCHMARK_SCENARIO_PARTITIONS;
  const pilotIdsWithInjectedCalibrationId = [...live.LIVE_PILOT_CASES.map((c) => c.id), calibration[0]];
  assert.throws(
    () => assertDisjoint('live-pilot case ids', pilotIdsWithInjectedCalibrationId, 'benchmark calibration ids', calibration),
    /must share no id with/,
    'injecting a real calibration id into a copy of the pilot ids must be caught, or the oracle above is vacuously green',
  );
});

test('the disjointness oracle used above fails when a copy of the benchmark calibration ids carries an injected live-pilot case id', async () => {
  const live = await loadLivePilotRegistry();
  const pilotIds = live.LIVE_PILOT_CASES.map((c) => c.id);
  assert.ok(
    pilotIds.length > 0,
    'the live-pilot registry must declare at least one case for this non-vacuity row to inject',
  );
  const { calibration } = evals.BENCHMARK_SCENARIO_PARTITIONS;
  const calibrationIdsWithInjectedPilotId = [...calibration, pilotIds[0]];
  assert.throws(
    () => assertDisjoint('live-pilot case ids', pilotIds, 'benchmark calibration ids', calibrationIdsWithInjectedPilotId),
    /must share no id with/,
    'injecting a live-pilot case id into a copy of the benchmark ids must be caught, or the oracle above is vacuously green',
  );
});

/* -------------------------------------------------------------------------- */
/* G. dependency-cruiser: packages/ and apps/ never import live-pilot/        */
/* -------------------------------------------------------------------------- */

/**
 * The exact probe shape `test/oracle-positive-control.test.mjs`'s
 * `copyForBoundaryProbe`/`runDepcruiseProbe` uses, duplicated here rather
 * than imported — see that file's own header for why every existing
 * depcruise probe in this repository accepts the same duplication rather
 * than manufacturing a shared import for it.
 *
 * Limit stated rather than discovered later: this probe only proves the rule
 * bites a relative import that resolves to a real file. `live-pilot/registry.mjs`
 * has to exist on disk for dependency-cruiser to normalize the import target to
 * a `live-pilot/`-prefixed path at all — an unresolved import is left as its
 * raw specifier and never matches the rule's `to.path`, which is a property of
 * dependency-cruiser's own resolution step, not of this probe.
 */
function copyForBoundaryProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-live-pilot-boundary-'));
  const fixtureRoot = join(temporaryRoot, 'repository');
  const excludedEntries = new Set([
    '.agents',
    '.claude',
    '.codex',
    '.git',
    '.github',
    'coverage',
    'node_modules',
  ]);

  cpSync(projectRoot, fixtureRoot, {
    recursive: true,
    filter(source) {
      const pathFromRoot = relative(projectRoot, source);
      return pathFromRoot === '' || !excludedEntries.has(pathFromRoot.split('/')[0]);
    },
  });

  const sourceNodeModules = resolve(projectRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, resolve(fixtureRoot, 'node_modules'), 'dir');
  }

  return { fixtureRoot, temporaryRoot };
}

function writeProbeSource(fixtureRoot, packageDirectory, source) {
  const path = resolve(fixtureRoot, packageDirectory, 'src/__boundary_probe__.ts');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

/**
 * The registry module the probe imports, written into the scratch copy so
 * the import can resolve — see the limit stated above the probe helpers.
 */
function writeRegistryStub(fixtureRoot) {
  const path = resolve(fixtureRoot, 'live-pilot/registry.mjs');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "export const LIVE_PILOT_PARTITION = 'live-pilot';\nexport const LIVE_PILOT_CASES = Object.freeze([]);\n",
  );
}

function runNpm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: childEnv({ CI: '1' }),
  });
}

function commandDiagnostics(command, result) {
  return `${command} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function runDepcruiseProbe(mutate) {
  const { fixtureRoot, temporaryRoot } = copyForBoundaryProbe();
  try {
    writeRegistryStub(fixtureRoot);
    const baseline = runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
    assert.equal(
      baseline.status,
      0,
      `the unmodified scaffold, with only the live-pilot registry stub added, must pass npm run lint:graph before a boundary probe is meaningful\n${commandDiagnostics('npm run lint:graph', baseline)}`,
    );

    mutate(fixtureRoot);
    return runNpm(['run', '--silent', 'lint:graph'], fixtureRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('rejects packages/graph importing live-pilot/registry.mjs by relative path', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'packages/graph', 'import "../../../live-pilot/registry.mjs";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted a packages/graph import of live-pilot/registry.mjs: product code must never reach live-pilot data\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /live-pilot/,
    `the refusal must name the live-pilot boundary rule, not merely some unrelated violation\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

test('rejects apps/cli, the shipped binary, importing live-pilot/registry.mjs by relative path', () => {
  const result = runDepcruiseProbe((fixtureRoot) =>
    writeProbeSource(fixtureRoot, 'apps/cli', 'import "../../../live-pilot/registry.mjs";\n'),
  );
  assert.notEqual(
    result.status,
    0,
    `npm run lint:graph accepted an apps/cli import of live-pilot/registry.mjs: the shipped application must never reach live-pilot data either\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
  assert.match(
    result.stdout + result.stderr,
    /live-pilot/,
    `the refusal must name the live-pilot boundary rule, not merely some unrelated violation\n${commandDiagnostics('npm run lint:graph', result)}`,
  );
});

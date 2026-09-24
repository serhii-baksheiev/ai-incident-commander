/**
 * AIC-120: the durable hold-out record and publication-only recovery.
 *
 * Order required: admit -> execute -> build the COMPLETE local record ->
 * durably persist it -> attempt LangSmith publication per publishable arm ->
 * durably record each outcome -> if a required publication failed, exit
 * non-zero with the measurement preserved. Measurement identity (one admitted
 * run per candidate fingerprint) is independent of publication-attempt
 * identity (many attempts, logged separately).
 *
 * Rows below map to the owner's numbered list (T1-T12), plus the pure-module
 * and readback rows the list groups under "Plus". Each T number is named in
 * its test's own title so a failure is easy to place.
 *
 * None of the modules under test exist yet:
 *   - packages/evals/src/final-evaluation-publication.ts (planHoldoutPublication,
 *     parsePublicationAttempt, summarizeHoldoutPublication, and the two constants)
 *   - packages/observability/src/index.ts gains verifyPersistedBenchmarkReference
 *   - scripts/final-holdout-publication.mjs (new)
 *   - scripts/publish-final-holdout.mjs (new)
 *   - scripts/eval-final-holdout.mjs gains an exported completeHoldout
 * so every row below is expected to fail on a missing export or a missing
 * module, never on a typo in the test itself.
 *
 * Independent oracle: file bytes are compared directly with Buffer.compare;
 * digests are recomputed here with node:crypto rather than by calling the
 * function under test twice.
 *
 * Fixtures: `fourArmLaneCapturing` below runs the REAL `runLiveModelLane`
 * over scripted control/model nodes and a fake naive completion port — the
 * same construction `test/lane-arms.test.mjs`'s `fourArmLaneForPublish` uses
 * — so `report`/`experiments` in the rows that need them are shapes
 * production actually produces, not hand-invented ones. Rows that need only a
 * standalone `PersistedBenchmarkExperiment` (the publish-only retry rows,
 * which operate on a record already written to disk) use
 * `distinctExperiment`, built the same way `test/fixtures/benchmark-experiment.mjs`'s
 * own `singleRecordExperiment` is, parameterised on `experimentId` so two
 * calls are told apart.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pid } from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import * as observability from '@aic/observability';
import { MODEL_API_KEY_VARIABLE } from '@aic/roles';

import {
  benchmarkVersions,
  capturingClient,
  perfectOutcomeFor,
  requireFunction,
} from './fixtures/benchmark-experiment.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const HEAD_SHA = 'e'.repeat(40);
const HEAD_SHA12 = HEAD_SHA.slice(0, 12);

function fakeApiKey() {
  return ['sk', 'ant', 'test', '9'.repeat(24)].join('-');
}

const v3Metadata = Object.freeze({
  ...benchmarkVersions,
  evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
});

/** Register a mkdtemp directory for cleanup, removing only that exact path. */
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A schema-valid, internally-consistent naive completion, like lane-arms.test.mjs's. */
function fakeNaivePort() {
  return {
    async complete() {
      return {
        text: JSON.stringify({
          hypotheses: [],
          assessments: [],
          conclusion: { kind: 'inconclusive', causes: [] },
          stopKind: 'ambiguous',
        }),
        modelId: 'fake-naive-model',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

/**
 * A whole lane, driven through the real `runLiveModelLane`, with scripted
 * control/model arms and a fake-ported naive arm — the same construction
 * `test/lane-arms.test.mjs`'s `fourArmLaneForPublish` uses, generalised here
 * to capture both experiments by default. `runModelArm`/`runNaiveArm`
 * override the default when the row needs an unreportable or refused arm;
 * `includeNaiveArm: false` omits the naive arm entirely, which is how the
 * lane reports it `not-run`; `includeControlBaseline: false` produces the
 * undeclared-baseline case both arms share.
 */
async function fourArmLaneCapturing({
  runModelArm,
  runNaiveArm,
  includeNaiveArm = true,
  includeControlBaseline = true,
} = {}) {
  const { scriptedNodes } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const { naiveArm } = await import('../scripts/lane-arms.mjs');

  async function scriptedGraphExperiment(label, plan) {
    return evals.runGraphBenchmarkExperiment({
      experimentId: `aic-120-${label}`,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      createNodes: (record) => scriptedNodes(record),
      async recordEvaluation() {},
    });
  }

  let modelExperiment;
  let naiveExperiment;
  const naiveConfig = Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' });

  const naiveOption =
    runNaiveArm !== undefined
      ? {
          async runNaiveArm(plan) {
            naiveExperiment = await runNaiveArm(plan);
            return naiveExperiment;
          },
        }
      : includeNaiveArm
        ? {
            async runNaiveArm(plan) {
              naiveExperiment = await naiveArm({
                experimentId: 'aic-120-naive',
                port: fakeNaivePort(),
                config: naiveConfig,
              })(plan);
              return naiveExperiment;
            },
          }
        : {};

  const report = await evals.runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-120-lane',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    ...(includeControlBaseline ? { controlBaseline: readControlBaseline() } : {}),
    async runControlArm(plan) {
      return scriptedGraphExperiment('control', plan);
    },
    ...naiveOption,
    async runModelArm(plan) {
      if (runModelArm !== undefined) {
        modelExperiment = await runModelArm(plan);
        return modelExperiment;
      }
      modelExperiment = await scriptedGraphExperiment('model', plan);
      return modelExperiment;
    },
  });

  return { report, modelExperiment, naiveExperiment };
}

/** A standalone, realistic experiment, told apart from another call by experimentId. */
function distinctExperiment(experimentId) {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  assert.ok(record, `the calibration plan must contain at least one record for ${experimentId}`);
  const result = evals.evaluateBenchmarkRecord({ record, outcome: perfectOutcomeFor(record.scenario) });
  return { records: [record], results: [result] };
}

let referenceCounter = 0;
/** A plausible PersistedBenchmarkReference, unique per call. */
function sampleReference() {
  referenceCounter += 1;
  return {
    datasetId: `dataset-${referenceCounter}`,
    datasetName: `aic-120-dataset-${referenceCounter}`,
    projects: [{ experimentId: `exp-${referenceCounter}`, projectId: `project-${referenceCounter}` }],
    exampleIds: [`example-${referenceCounter}`],
    runIds: [`run-${referenceCounter}`],
  };
}

/** A verify fake that answers as `verifyPersistedBenchmarkReference` would on a healthy readback. */
async function verifyEchoingReference({ reference }) {
  return {
    datasetId: reference.datasetId,
    projectIds: reference.projects.map((project) => project.projectId),
    exampleCount: reference.exampleIds.length,
    runCount: reference.runIds.length,
  };
}

/** A fresh candidate fingerprint and the basename the command derives from it. */
function freshFingerprint() {
  const hex = randomBytes(32).toString('hex');
  return { fingerprint: `sha256:${hex}`, basename: `${hex.slice(0, 12)}.json` };
}

/**
 * A minimal, realistic "complete" hold-out record: the same fields the
 * committed records under docs/evidence/final-evaluation/ carry, built with a
 * literal wrapper (like final-evaluation-oneshot.test.mjs's own `recordFor`)
 * around REAL PersistedBenchmarkExperiment objects for `experiments`.
 */
function completeRecordFor({ fingerprint, measurementId, modelExperiment, naiveExperiment, publicationPlan }) {
  return {
    schemaVersion: evals.FINAL_EVALUATION_RECORD_VERSION,
    status: 'complete',
    measurementId,
    candidate: {
      fingerprint,
      algorithm: 'sha256-over-git-ls-tree',
      paths: [...evals.FINAL_EVALUATION_CANDIDATE_PATHS],
      headSha: HEAD_SHA,
      workingTreeClean: true,
    },
    corpus: {
      scenarioSet: 'final-evaluation',
      runsPerScenario: 3,
      fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    claimedAt: '2026-09-24T00:00:00.000Z',
    completedAt: '2026-09-24T00:05:00.000Z',
    report: { note: 'not read by publishOnly; kept for realism' },
    experiments: { model: modelExperiment, naive: naiveExperiment },
    publicationPlan,
    publicationRequested: false,
    acceptance: [],
  };
}

function writeJson(path, body) {
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function counterAttemptId(prefix = 'attempt') {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

/** A PublicationAttempt, built directly rather than through the parser under test. */
function attemptFor({ arm, outcome, measurementSha256, attemptId, reference, reason, mode = 'with-measurement' }) {
  const base = {
    schemaVersion: 1,
    measurementId: 'measurement-fixture',
    candidateFingerprint: `sha256:${'a'.repeat(64)}`,
    measurementSha256,
    attemptId,
    attemptedAt: '2026-09-24T00:00:00.000Z',
    mode,
    arm,
    outcome,
    datasetName: `aic-19-final-holdout-${arm}-${HEAD_SHA12}-a1`,
  };
  if (outcome === 'verified') {
    return { ...base, reference: reference ?? sampleReference() };
  }
  if (outcome === 'readback-failed') {
    return { ...base, reference: reference ?? sampleReference(), reason: reason ?? 'readback disagreed' };
  }
  return { ...base, reason: reason ?? 'ingestion refused' };
}

const SOME_SHA = `sha256:${'f'.repeat(64)}`;
const OTHER_SHA = `sha256:${'0'.repeat(64)}`;

/* -------------------------------------------------------------------------- */
/* 1. planHoldoutPublication — pure, carries the three deleted                */
/*    publishHoldoutArms rows' assertions as plan-level reasons               */
/* -------------------------------------------------------------------------- */

test('planHoldoutPublication requires both arms, in publish order, when each is reportable and carries an experiment', async () => {
  assert.equal(
    typeof evals.planHoldoutPublication,
    'function',
    '@aic/evals must export planHoldoutPublication',
  );
  const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing();
  assert.equal(report.arms.model.reportable, true);
  assert.equal(report.arms.naive.reportable, true);

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: modelExperiment, naive: naiveExperiment },
  });

  assert.deepEqual([...evals.FINAL_EVALUATION_PUBLISHABLE_ARMS], ['model', 'naive']);
  assert.deepEqual(Object.keys(plan), ['model', 'naive']);
  assert.deepEqual(plan.model, { required: true });
  assert.deepEqual(plan.naive, { required: true });
  assert.equal(Object.isFrozen(plan), true, 'the plan must be frozen: nothing downstream may mutate a publication decision');
});

test('planHoldoutPublication marks the model arm not required with the model arms own unreportable reason, and still requires the naive arm, when the model arm is unreportable and the naive arm is reportable', async () => {
  const { report, naiveExperiment } = await fourArmLaneCapturing({
    async runModelArm() {
      throw new Error('model harness exploded');
    },
  });
  assert.equal(report.arms.model.reportable, false);
  assert.equal(report.arms.naive.reportable, true);

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: undefined, naive: naiveExperiment },
  });

  assert.deepEqual(plan.model, { required: false, reason: report.arms.model.unreportableReason });
  assert.deepEqual(plan.naive, { required: true });
});

test('planHoldoutPublication marks the naive arm not required with its own not-run reason, when the caller supplied no naive arm', async () => {
  const { report, modelExperiment } = await fourArmLaneCapturing({ includeNaiveArm: false });
  assert.deepEqual(report.arms.naive, { arm: 'naive', status: 'not-run', reason: 'the caller supplied no naive arm' });

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: modelExperiment, naive: undefined },
  });

  assert.deepEqual(plan.naive, { required: false, reason: 'the caller supplied no naive arm' });
});

test('planHoldoutPublication marks the naive arm not required with its refusal reason, when the naive arm threw', async () => {
  const { report, modelExperiment } = await fourArmLaneCapturing({
    async runNaiveArm() {
      throw new Error('naive harness exploded');
    },
  });
  assert.equal(report.arms.naive.status, 'refused');

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: modelExperiment, naive: undefined },
  });

  assert.deepEqual(plan.naive, { required: false, reason: 'naive harness exploded' });
});

test('planHoldoutPublication marks the naive arm not required with its own unreportable reason, when the naive arm completed but no control baseline was declared', async () => {
  const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing({
    includeControlBaseline: false,
  });
  assert.equal(report.arms.naive.status, 'completed');
  assert.equal(report.arms.naive.reportable, false);

  const plan = evals.planHoldoutPublication({
    report,
    experiments: { model: modelExperiment, naive: naiveExperiment },
  });

  assert.deepEqual(plan.naive, { required: false, reason: report.arms.naive.unreportableReason });
});

test('planHoldoutPublication marks the naive arm not required with its own reason, when naiveExperiment is undefined despite a completed, reportable arm', () => {
  const laneReport = {
    arms: {
      model: { arm: 'model', reportable: true },
      naive: { arm: 'naive', status: 'completed', reportable: true },
    },
  };
  const plan = evals.planHoldoutPublication({
    report: laneReport,
    experiments: { model: {}, naive: undefined },
  });
  assert.deepEqual(plan.naive, { required: false, reason: 'the naive arm produced no experiment to publish' });
});

test('planHoldoutPublication marks the model arm not required with its own reason, when experiments.model is undefined despite the model arm being reportable', () => {
  const laneReport = {
    arms: {
      model: { arm: 'model', reportable: true },
      naive: { arm: 'naive', status: 'not-run', reason: 'the caller supplied no naive arm' },
    },
  };
  const plan = evals.planHoldoutPublication({
    report: laneReport,
    experiments: { model: undefined, naive: undefined },
  });
  assert.deepEqual(plan.model, { required: false, reason: 'the model arm produced no experiment to publish' });
});

/* -------------------------------------------------------------------------- */
/* 2. parsePublicationAttempt — strict own-property parse                    */
/* -------------------------------------------------------------------------- */

test('parsePublicationAttempt accepts a well-formed verified attempt', () => {
  assert.equal(
    typeof evals.parsePublicationAttempt,
    'function',
    '@aic/evals must export parsePublicationAttempt',
  );
  const attempt = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'a1' });
  const parsed = evals.parsePublicationAttempt(attempt);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(attempt)));
});

test('parsePublicationAttempt accepts a well-formed ingestion-failed attempt, carrying no reference', () => {
  const attempt = attemptFor({ arm: 'naive', outcome: 'ingestion-failed', measurementSha256: SOME_SHA, attemptId: 'a2' });
  assert.equal(Object.hasOwn(attempt, 'reference'), false, 'the fixture must carry no reference, or this row proves nothing');
  const parsed = evals.parsePublicationAttempt(attempt);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(attempt)));
});

test('parsePublicationAttempt accepts a well-formed readback-failed attempt, carrying both a reference and a reason', () => {
  const attempt = attemptFor({ arm: 'model', outcome: 'readback-failed', measurementSha256: SOME_SHA, attemptId: 'a3' });
  const parsed = evals.parsePublicationAttempt(attempt);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(attempt)));
});

/**
 * `assert.throws(() => evals.parsePublicationAttempt(...))` alone would pass
 * vacuously before the export exists at all — calling `undefined(...)` throws
 * a TypeError regardless of what the fixture mutated, which is a false green
 * rather than a demonstration that the REFUSAL is decided on the field named
 * in the row's title. Every refusal row below asserts the export is a
 * function first, the same guard the acceptance rows above use, so a missing
 * export fails this row for that reason rather than passing it by accident.
 */
function requireParsePublicationAttempt() {
  assert.equal(
    typeof evals.parsePublicationAttempt,
    'function',
    '@aic/evals must export parsePublicationAttempt',
  );
  return evals.parsePublicationAttempt;
}

for (const [label, mutate] of [
  ['an unknown schemaVersion', (a) => ({ ...a, schemaVersion: 2 })],
  ['an unknown arm', (a) => ({ ...a, arm: 'oracle' })],
  ['an unknown outcome', (a) => ({ ...a, outcome: 'succeeded' })],
  ['an unknown mode', (a) => ({ ...a, mode: 'legacy' })],
]) {
  test(`parsePublicationAttempt refuses ${label}`, () => {
    const parse = requireParsePublicationAttempt();
    const attempt = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'a4' });
    assert.throws(() => parse(mutate(attempt)));
  });
}

test('parsePublicationAttempt refuses a failure outcome with no reason', () => {
  const parse = requireParsePublicationAttempt();
  const attempt = attemptFor({ arm: 'model', outcome: 'ingestion-failed', measurementSha256: SOME_SHA, attemptId: 'a5' });
  const { reason, ...withoutReason } = attempt;
  assert.throws(() => parse(withoutReason));
});

test('parsePublicationAttempt refuses a verified attempt with no reference', () => {
  const parse = requireParsePublicationAttempt();
  const attempt = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'a6' });
  const { reference, ...withoutReference } = attempt;
  assert.throws(() => parse(withoutReference));
});

test('parsePublicationAttempt refuses a readback-failed attempt with no reference', () => {
  const parse = requireParsePublicationAttempt();
  const attempt = attemptFor({ arm: 'model', outcome: 'readback-failed', measurementSha256: SOME_SHA, attemptId: 'a7' });
  const { reference, ...withoutReference } = attempt;
  assert.throws(() => parse(withoutReference));
});

/* -------------------------------------------------------------------------- */
/* 3. summarizeHoldoutPublication — sticky verified, digest mismatch throws  */
/* -------------------------------------------------------------------------- */

test('summarizeHoldoutPublication reports satisfied when every required arm has a verified attempt', () => {
  assert.equal(
    typeof evals.summarizeHoldoutPublication,
    'function',
    '@aic/evals must export summarizeHoldoutPublication',
  );
  const plan = { model: { required: true }, naive: { required: true } };
  const modelAttempt = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'm1' });
  const naiveAttempt = attemptFor({ arm: 'naive', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'n1' });

  const summary = evals.summarizeHoldoutPublication({
    plan,
    attempts: [modelAttempt, naiveAttempt],
    measurementSha256: SOME_SHA,
  });

  assert.equal(summary.satisfied, true);
  assert.deepEqual(summary.arms.model, { state: 'verified', attempts: 1, last: modelAttempt });
  assert.deepEqual(summary.arms.naive, { state: 'verified', attempts: 1, last: naiveAttempt });
  assert.equal(Object.isFrozen(summary), true);
});

test('summarizeHoldoutPublication reports a not-required arm from the plan alone, with no attempts needed, and satisfied depends only on required arms', () => {
  const plan = { model: { required: true }, naive: { required: false, reason: 'the caller supplied no naive arm' } };
  const modelAttempt = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'm1' });

  const summary = evals.summarizeHoldoutPublication({ plan, attempts: [modelAttempt], measurementSha256: SOME_SHA });

  assert.deepEqual(summary.arms.naive, { state: 'not-required', reason: 'the caller supplied no naive arm' });
  assert.equal(summary.satisfied, true);
});

test('summarizeHoldoutPublication reports a required arm with no attempts as not-attempted, and satisfied false', () => {
  const plan = { model: { required: true }, naive: { required: true } };
  const summary = evals.summarizeHoldoutPublication({ plan, attempts: [], measurementSha256: SOME_SHA });

  assert.deepEqual(summary.arms.model, { state: 'not-attempted' });
  assert.deepEqual(summary.arms.naive, { state: 'not-attempted' });
  assert.equal(summary.satisfied, false);
});

test('summarizeHoldoutPublication reports the state of the LAST attempt when none is verified, and counts every attempt', () => {
  const plan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const first = attemptFor({ arm: 'model', outcome: 'ingestion-failed', measurementSha256: SOME_SHA, attemptId: 'm1' });
  const second = attemptFor({ arm: 'model', outcome: 'readback-failed', measurementSha256: SOME_SHA, attemptId: 'm2' });

  const summary = evals.summarizeHoldoutPublication({ plan, attempts: [first, second], measurementSha256: SOME_SHA });

  assert.deepEqual(summary.arms.model, { state: 'readback-failed', attempts: 2, last: second });
  assert.equal(summary.satisfied, false);
});

test('summarizeHoldoutPublication keeps an arm verified even when a later attempt for it failed', () => {
  const plan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const first = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'm1' });
  const second = attemptFor({ arm: 'model', outcome: 'ingestion-failed', measurementSha256: SOME_SHA, attemptId: 'm2' });

  const summary = evals.summarizeHoldoutPublication({ plan, attempts: [first, second], measurementSha256: SOME_SHA });

  assert.equal(summary.arms.model.state, 'verified', 'a later failure must never un-verify an arm that was already verified');
  assert.equal(summary.arms.model.attempts, 2);
  assert.equal(summary.arms.model.last.outcome, 'verified');
  assert.equal(summary.satisfied, true);
});

test('summarizeHoldoutPublication throws when an attempt carries a different measurementSha256 than the one given, because the measured record changed after it was published', () => {
  // Asserted first, not left to `assert.throws` alone: calling `undefined(...)`
  // throws regardless of the fixture, which would pass this row before the
  // export exists at all — see requireParsePublicationAttempt's header above
  // for the same reasoning.
  assert.equal(
    typeof evals.summarizeHoldoutPublication,
    'function',
    '@aic/evals must export summarizeHoldoutPublication',
  );
  const plan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const attempt = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: OTHER_SHA, attemptId: 'm1' });

  assert.throws(() => evals.summarizeHoldoutPublication({ plan, attempts: [attempt], measurementSha256: SOME_SHA }));
});

/* -------------------------------------------------------------------------- */
/* 4. verifyPersistedBenchmarkReference — against a fake read client         */
/* -------------------------------------------------------------------------- */

function fakeReadbackClient({ datasets = {}, projects = {}, runsByProject = {}, examplesByDataset = {} }) {
  return {
    async readDataset({ datasetId }) {
      if (!Object.hasOwn(datasets, datasetId)) throw new Error(`fake readback: no such dataset ${datasetId}`);
      return datasets[datasetId];
    },
    async readProject({ projectId }) {
      if (!Object.hasOwn(projects, projectId)) throw new Error(`fake readback: no such project ${projectId}`);
      return projects[projectId];
    },
    async *listRuns({ projectId }) {
      for (const run of runsByProject[projectId] ?? []) yield run;
    },
    async *listExamples({ datasetId }) {
      for (const example of examplesByDataset[datasetId] ?? []) yield example;
    },
  };
}

test('verifyPersistedBenchmarkReference resolves counts when every id in the reference reads back from the fake client', async () => {
  const verify = requireFunction(observability, 'verifyPersistedBenchmarkReference', '@aic/observability');
  const reference = {
    datasetId: 'd1',
    datasetName: 'aic-120-verify-ok',
    projects: [{ experimentId: 'e1', projectId: 'p1' }],
    exampleIds: ['ex1', 'ex2'],
    runIds: ['r1', 'r2'],
  };
  const client = fakeReadbackClient({
    datasets: { d1: { id: 'd1' } },
    projects: { p1: { id: 'p1' } },
    runsByProject: { p1: [{ id: 'r1' }, { id: 'r2' }] },
    examplesByDataset: { d1: [{ id: 'ex1' }, { id: 'ex2' }] },
  });

  const result = await verify({ client, reference });

  assert.deepEqual(result, { datasetId: 'd1', projectIds: ['p1'], exampleCount: 2, runCount: 2 });
});

test('verifyPersistedBenchmarkReference rejects naming the count, when a run id in the reference never reads back', async () => {
  const verify = requireFunction(observability, 'verifyPersistedBenchmarkReference', '@aic/observability');
  const reference = {
    datasetId: 'd1',
    datasetName: 'aic-120-verify-missing-run',
    projects: [{ experimentId: 'e1', projectId: 'p1' }],
    exampleIds: ['ex1'],
    runIds: ['r1', 'r2'],
  };
  const client = fakeReadbackClient({
    datasets: { d1: { id: 'd1' } },
    projects: { p1: { id: 'p1' } },
    // Only one of the two run ids the reference names actually reads back.
    runsByProject: { p1: [{ id: 'r1' }] },
    examplesByDataset: { d1: [{ id: 'ex1' }] },
  });

  await assert.rejects(
    () => verify({ client, reference }),
    (error) => error instanceof Error && /run/i.test(error.message) && /\d/.test(error.message),
    'the rejection must name what was missing by count, not by dumping the payload',
  );
});

/**
 * AIC-120 round 2: before this fix, the read-back dataset's own `id` was read
 * and returned but never compared with the `datasetId` the caller asked to
 * verify. A workspace whose `readDataset` answered with a real dataset — just
 * not the one this reference names — read as a clean verification, exactly
 * the wrong-workspace failure this function's own header exists to catch.
 * This row guards against that: the read-back id is now compared against the
 * requested `datasetId` before verification can succeed.
 */
test('verifyPersistedBenchmarkReference rejects when the read-back dataset id disagrees with the requested datasetId', async () => {
  const verify = requireFunction(observability, 'verifyPersistedBenchmarkReference', '@aic/observability');
  const reference = {
    datasetId: 'd1',
    datasetName: 'aic-120-verify-dataset-mismatch',
    projects: [{ experimentId: 'e1', projectId: 'p1' }],
    exampleIds: ['ex1'],
    runIds: ['r1'],
  };
  const client = fakeReadbackClient({
    // The workspace answers a dataset object for the requested id, but the
    // object's OWN id names a different dataset — the shape a wrong-region
    // endpoint or a stale readback client could plausibly produce.
    datasets: { d1: { id: 'd1-from-a-different-workspace' } },
    projects: { p1: { id: 'p1' } },
    runsByProject: { p1: [{ id: 'r1' }] },
    examplesByDataset: { d1: [{ id: 'ex1' }] },
  });

  await assert.rejects(
    () => verify({ client, reference }),
    (error) => error instanceof Error && /d1-from-a-different-workspace/.test(error.message) && /d1/.test(error.message),
    'a read-back dataset whose own id disagrees with the requested datasetId must be refused, naming both ids: this guards against the function returning whatever id came back with no comparison at all',
  );
});

/* -------------------------------------------------------------------------- */
/* 5. Orchestration primitives — scripts/final-holdout-publication.mjs       */
/* -------------------------------------------------------------------------- */

test('writeRecordDurably writes pretty-printed JSON with a trailing newline, leaving no leftover temp file', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-write-');
  const path = join(dir, 'record.json');
  const body = { hello: 'world', nested: { a: 1 } };

  await writeRecordDurably(path, body);

  const raw = readFileSync(path, 'utf8');
  assert.equal(raw, `${JSON.stringify(body, null, 2)}\n`);

  assert.deepEqual(readdirSync(dir), ['record.json'], 'no <path>.tmp-<pid>-<token> file may survive the write');
});

/**
 * AIC-120 round 3 (security-scanner advisory carried from PR #124): the temp
 * name was `${path}.tmp-${pid}` — predictable from the record path and this
 * process's own pid, which any local reader can see. A file or symlink
 * planted at that exact name for a FRESH candidate (never written before)
 * made the complete-record write fail with EEXIST *after* the hold-out's
 * model calls were already spent, losing the one-shot measurement the
 * function exists to protect. The fix appends a random per-call token to the
 * temp name, so a leftover or planted entry at the OLD name is simply a
 * different path from the one this call opens — it is never even looked at.
 */
test('writeRecordDurably ignores a leftover file or symlink at the old predictable temp name, because the temp path now carries a random per-call token', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');

  await t.test('a leftover regular file at the old <path>.tmp-<pid> name does not block the write', async () => {
    const dir = tempDir(t, 'aic-120-old-name-file-');
    const path = join(dir, 'record.json');
    const oldTmpPath = `${path}.tmp-${pid}`;
    writeFileSync(oldTmpPath, 'leftover from a killed prior run\n');
    const body = { hello: 'world' };

    await writeRecordDurably(path, body);

    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), body);
  });

  await t.test('a leftover symlink at the old <path>.tmp-<pid> name, pointing at a victim file, does not block the write and leaves the victim untouched', async () => {
    const dir = tempDir(t, 'aic-120-old-name-symlink-');
    const path = join(dir, 'record.json');
    const targetPath = join(dir, 'victim.json');
    const targetContents = 'untouched\n';
    writeFileSync(targetPath, targetContents);
    const oldTmpPath = `${path}.tmp-${pid}`;
    symlinkSync(targetPath, oldTmpPath);
    const body = { hello: 'world' };

    await writeRecordDurably(path, body);

    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), body);
    assert.equal(
      readFileSync(targetPath, 'utf8'),
      targetContents,
      'the symlink at the OLD name points at this victim; the new implementation must never open the old name at all, so the victim is left exactly as it was',
    );
  });
});

/**
 * AIC-120 round 3: two calls to `writeRecordDurably` for the same path, from
 * this process, each get a clean run — the second call's temp name is not
 * blocked by anything the first call left behind, and neither call leaves a
 * `<path>.tmp-*` entry behind afterward. That is all this row proves.
 *
 * 🔴 This row does NOT prove the default token is random. It passes exactly
 * as written against the pre-fix implementation at `bf58006`, whose temp name
 * was `${path}.tmp-${pid}` — constant across calls in one process — because
 * the first call's `renameSync` already frees that name before the second
 * call opens it; a constant *default* token passes this row identically. For
 * the property that the default token varies per call, see the row below,
 * "freshTempToken returns twelve lowercase hex characters, and returns a
 * different value on every one of 1000 consecutive calls".
 */
test('writeRecordDurably succeeds on two calls to the same path from this process, leaving no leftover temp file from either call', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-write-twice-');
  const path = join(dir, 'record.json');

  await writeRecordDurably(path, { call: 1 });
  await writeRecordDurably(path, { call: 2 });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { call: 2 });
  assert.deepEqual(
    readdirSync(dir),
    ['record.json'],
    'each call must clean up its own temp file; no <path>.tmp-* entry from either call may survive',
  );
});

/**
 * AIC-120 round 3: before this fix, `writeRecordDurably` opened its temp file
 * with the plain `'w'` flag, which has no `O_EXCL`/`O_NOFOLLOW` and so
 * followed a pre-created symlink at that exact path. An attacker (or a
 * leftover temp file from a killed prior run, replaced by a symlink) who
 * planted `<path>.tmp-<pid>` pointing at an arbitrary file got that file
 * overwritten with the new record, and then renamed into place at `path` —
 * the write landed wherever the symlink pointed, never where the caller
 * asked. This row guards against that at the temp name this call actually
 * uses: `'wx'` refuses to open a path that already exists, symlink or not.
 * The explicit `token` is the test seam the fix exposes for exactly this —
 * without it, the caller (this test) cannot predict the random name a
 * default call would use and so could not plant anything at it.
 */
test('writeRecordDurably refuses to write through a pre-created symlink at its own temp path, leaving the symlink target untouched', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-write-symlink-');
  const path = join(dir, 'record.json');
  const targetPath = join(dir, 'attacker-target.json');
  const targetContents = 'untouched\n';
  writeFileSync(targetPath, targetContents);
  const token = 'deadbeefcafe';
  const tmpPath = `${path}.tmp-${pid}-${token}`;
  symlinkSync(targetPath, tmpPath);

  await assert.rejects(
    () => writeRecordDurably(path, { hello: 'world' }, { token }),
    'a pre-created symlink at the temp path must be refused, not followed: opening it with a plain "w" flag writes through the link to whatever it points at',
  );

  assert.equal(
    readFileSync(targetPath, 'utf8'),
    targetContents,
    'the symlink target must be left exactly as it was: this guards against the write following the link and overwriting it with the new record',
  );
  assert.equal(
    existsSync(path),
    false,
    'the refusal must happen before the rename, so the caller-visible path never receives the attacker-controlled content',
  );
});

test('writeRecordDurably atomically replaces a prior file rather than appending to it', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-write-replace-');
  const path = join(dir, 'record.json');

  await writeRecordDurably(path, { version: 1 });
  await writeRecordDurably(path, { version: 2 });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2 });
});

/**
 * AIC-120 gate round 2 (code-reviewer blocker 1): the security value of the
 * temp-name fix rests entirely on the DEFAULT token being unpredictable per
 * call — every other row in this file either plants at the old fixed name or
 * supplies its own explicit `token`, so none of them can tell a random
 * default apart from a constant one. The round-1 mutation probe found
 * exactly that gap: `token = randomBytes(6)…` -> `token = 'aaaaaaaaaaaa'`
 * left the whole suite green (59/59 in this file, 108/109 across every file
 * touching the module). This row observes `freshTempToken` directly so a
 * constant default reddens it.
 */
test('freshTempToken returns twelve lowercase hex characters, and returns a different value on every one of 1000 consecutive calls', async () => {
  const { freshTempToken } = await import('../scripts/final-holdout-publication.mjs');
  assert.equal(
    typeof freshTempToken,
    'function',
    'freshTempToken must be exported from scripts/final-holdout-publication.mjs; a missing export, not a typo in this test, is why this row is expected to fail today',
  );

  const seen = new Set();
  for (let i = 0; i < 1000; i += 1) {
    const token = freshTempToken();
    assert.match(
      token,
      /^[0-9a-f]{12}$/,
      `call #${i} must return twelve lowercase hex characters, got ${JSON.stringify(token)}`,
    );
    seen.add(token);
  }
  assert.equal(
    seen.size,
    1000,
    'freshTempToken must return 1000 distinct values across 1000 calls; this row proves distinctness across calls only — for the claim that the source is a CSPRNG, see the row below, "the source of freshTempToken is exactly one return of randomBytes(6).toString(\'hex\'), imported from node:crypto"',
  );
});

/**
 * AIC-120 gate round 3 (code-reviewer blocker, round 2): the row above proves
 * DISTINCTNESS across 1000 calls, not UNPREDICTABILITY — those come apart on
 * exactly the threat the fix exists for. A plain incrementing counter body
 * ("__counter += 1; return __counter.toString(16).padStart(12, '0')") is
 * twelve lowercase hex characters, distinct on every call, and every future
 * value is trivially derivable from the last one it produced — it passed the
 * row above and the "defaults its token parameter to freshTempToken()" audit
 * below unchanged, because neither one looks at what freshTempToken is MADE
 * OF, only at its call site and its output shape. This row does look inside:
 * it extracts the function's own body from the module's source text and pins
 * it to exactly one statement, delegating to Node's CSPRNG.
 *
 * 🔴 This pins that the token comes from `node:crypto`'s `randomBytes`, a
 * CSPRNG. It does NOT measure entropy, and it cannot: reading source text
 * tells you which primitive was called, never how much randomness that
 * primitive's actual output carries at runtime. For the observed-behaviour
 * half (fixed width, hex alphabet, no collision across 1000 calls), see the
 * row above, "freshTempToken returns twelve lowercase hex characters, and
 * returns a different value on every one of 1000 consecutive calls".
 */
test("the source of freshTempToken is exactly one return of randomBytes(6).toString('hex'), imported from node:crypto", () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'final-holdout-publication.mjs'), 'utf8');

  assert.match(
    source,
    /import\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*'node:crypto'/,
    'scripts/final-holdout-publication.mjs must import randomBytes from node:crypto',
  );

  const marker = 'export function freshTempToken()';
  const markerIndex = source.indexOf(marker);
  assert.notEqual(
    markerIndex,
    -1,
    'freshTempToken must be declared as "export function freshTempToken()" for this audit to locate its body',
  );

  const openBraceIndex = source.indexOf('{', markerIndex + marker.length);
  assert.notEqual(openBraceIndex, -1, 'freshTempToken() must be followed by a "{" opening its body');

  let depth = 0;
  let closeBraceIndex = -1;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBraceIndex = i;
        break;
      }
    }
  }
  assert.notEqual(closeBraceIndex, -1, 'the body opened at freshTempToken() { must close with a balanced "}"');

  const body = source.slice(openBraceIndex + 1, closeBraceIndex).trim();
  assert.equal(
    body,
    "return randomBytes(6).toString('hex');",
    `freshTempToken's body must be exactly one return of randomBytes(6).toString('hex'), got: ${body}`,
  );
});

/**
 * AIC-120 gate round 2 (code-reviewer blocker 2): the header above
 * `writeRecordDurably` claims, unconditionally, that "the temp name carries a
 * fresh random token per call". That is only true for the DEFAULT — a caller
 * that supplies `{ token }` (the seam the symlink row above uses) gets
 * exactly the token it passed, which is the documented, deliberate escape
 * hatch, not a bug. Proving the default's shape from inside a test that
 * calls `writeRecordDurably` cannot distinguish "default computed by
 * freshTempToken()" from "default computed by an equivalent inline
 * expression" without reaching into the module's internals, and it cannot
 * observe randomness at all without spying on `node:crypto.randomBytes` —
 * which is a live ESM binding, so this module's own already-imported
 * reference to it cannot be swapped for a fake from outside. A source audit
 * is the seam that is actually available: read the file text and check that
 * the signature really does delegate the default to the tested,
 * independently-verified `freshTempToken` above, rather than inlining a
 * second, undocumented way to compute one.
 */
test('the source of writeRecordDurably defaults its token parameter to a call to freshTempToken()', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'final-holdout-publication.mjs'), 'utf8');
  const marker = 'export async function writeRecordDurably(';
  const markerIndex = source.indexOf(marker);
  assert.notEqual(
    markerIndex,
    -1,
    'writeRecordDurably must be declared as "export async function writeRecordDurably(" for this audit to locate its signature',
  );

  const openParenIndex = markerIndex + marker.length - 1;
  let depth = 0;
  let closeParenIndex = -1;
  for (let i = openParenIndex; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        closeParenIndex = i;
        break;
      }
    }
  }
  assert.notEqual(closeParenIndex, -1, 'the parameter list opened at writeRecordDurably( must close with a balanced ")"');

  const signature = source.slice(markerIndex, closeParenIndex + 1);
  assert.match(
    signature,
    /token\s*=\s*freshTempToken\(\)/,
    `the writeRecordDurably parameter list must default token to freshTempToken(), got: ${signature}`,
  );
});

/**
 * A security advisory from the round-1 review: the temp name is built by
 * plain string concatenation (`${path}.tmp-${pid}-${token}`), with no
 * escaping of `token`. A token containing a path separator or a `..`
 * segment changes which filesystem entry actually gets opened — exactly the
 * unpredictability the fix exists to add is undone if the token itself can
 * redirect the write. `freshTempToken()`'s own output can never trigger
 * this (it is fixed-width hex), so this refusal only matters for the
 * explicit `{ token }` seam a caller may use.
 */
test('writeRecordDurably rejects a token that is not lowercase hex of length 1-32, before touching the filesystem', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const invalidTokens = ['../x', 'x/y', '', 'ABC', 'a'.repeat(33)];

  for (const token of invalidTokens) {
    const dir = tempDir(t, 'aic-120-invalid-token-');
    const path = join(dir, 'record.json');

    await assert.rejects(
      () => writeRecordDurably(path, { hello: 'world' }, { token }),
      `writeRecordDurably must refuse the malformed token ${JSON.stringify(token)}`,
    );

    assert.equal(
      existsSync(path),
      false,
      `no file may land at ${path} for the refused token ${JSON.stringify(token)}`,
    );
    assert.deepEqual(
      readdirSync(dir),
      [],
      `no <path>.tmp-* entry (or anything else) may be created in ${dir} for the refused token ${JSON.stringify(token)}: the refusal must happen before any filesystem call`,
    );
  }
});

/**
 * AIC-120 gate round 3 (code-reviewer advisory, round 2): `VALID_TOKEN.test(token)`
 * coerces its argument to a string before matching, so a value that is not a
 * primitive string at all — a number, a BigInt, a boxed `String`, an object
 * whose `toString` happens to produce valid hex — can satisfy the regex
 * without ever being the "1-32 lowercase hex characters" string the header
 * promises. The new contract adds `typeof token !== 'string'` as a refusal
 * ahead of the regex, so none of these coerce their way past it.
 *
 * 🔴 This row FAILS today for every one of these values: the current guard
 * (`VALID_TOKEN.test(token)` alone) accepts all four, because `RegExp#test`
 * stringifies its argument before matching.
 */
test('writeRecordDurably refuses a token that is not a primitive string, even when it coerces to valid hex', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const cases = [
    ['a number (12345)', 12345],
    ['a BigInt (10n)', 10n],
    ["a boxed String (new String('deadbeef'))", new String('deadbeef')],
    ["an object whose toString() returns 'deadbeef'", { toString: () => 'deadbeef' }],
  ];

  for (const [label, token] of cases) {
    await t.test(label, async () => {
      const dir = tempDir(t, 'aic-120-non-string-token-');
      const path = join(dir, 'record.json');

      await assert.rejects(
        () => writeRecordDurably(path, { hello: 'world' }, { token }),
        `writeRecordDurably must refuse a non-string token (${label}), even though it coerces to a hex-looking string`,
      );

      assert.deepEqual(
        readdirSync(dir),
        [],
        `no file may land in ${dir} for the refused non-string token (${label}): the refusal must happen before any filesystem call`,
      );
    });
  }
});

/**
 * AIC-120 gate round 3 (code-reviewer advisory, round 2): "refused before the
 * filesystem is touched at all" was not distinguished from "refused after a
 * no-op mkdirSync", because every existing row's temp directory already
 * exists by the time writeRecordDurably runs, so a no-op `mkdirSync` there is
 * invisible to a `readdirSync` assertion. This row uses a path under two
 * directories that do not exist yet: a refusal ordered after `mkdirSync`
 * would have created the first of them, and a refusal ordered before it
 * leaves the tree exactly as it was.
 *
 * 🔴 This row may already be green today — the guard in
 * scripts/final-holdout-publication.mjs already runs before `mkdirSync`. It
 * is added so the ordering claim in the header has a test that would catch a
 * regression, not because it is expected to fail now.
 */
test('writeRecordDurably rejects a malformed token before creating any missing parent directory', async (t) => {
  const { writeRecordDurably } = await import('../scripts/final-holdout-publication.mjs');
  const root = tempDir(t, 'aic-120-refuse-before-mkdir-');
  const missingParent = join(root, 'missing-1');
  const path = join(missingParent, 'missing-2', 'record.json');

  await assert.rejects(
    () => writeRecordDurably(path, { hello: 'world' }, { token: '../x' }),
    'a malformed token must be refused',
  );

  assert.equal(
    existsSync(missingParent),
    false,
    'the first missing parent directory must not have been created: the refusal must precede any mkdirSync call',
  );
});

test('attemptLogPath places the attempt log in a publications/ subdirectory beside the record, named after its basename without .json', async () => {
  const { attemptLogPath } = await import('../scripts/final-holdout-publication.mjs');
  const recordPath = join('/evidence', 'final-evaluation', 'abc123456789.json');
  assert.equal(
    attemptLogPath(recordPath),
    join('/evidence', 'final-evaluation', 'publications', 'abc123456789.jsonl'),
  );
});

test('appendPublicationAttempt appends one JSON line per call, and readPublicationAttempts reads them back in order', async (t) => {
  const { appendPublicationAttempt, readPublicationAttempts, attemptLogPath } = await import(
    '../scripts/final-holdout-publication.mjs'
  );
  const dir = tempDir(t, 'aic-120-log-');
  const logPath = attemptLogPath(join(dir, 'aaaaaaaaaaaa.json'));

  const first = attemptFor({ arm: 'model', outcome: 'ingestion-failed', measurementSha256: SOME_SHA, attemptId: 'a1' });
  const second = attemptFor({ arm: 'model', outcome: 'verified', measurementSha256: SOME_SHA, attemptId: 'a2' });
  await appendPublicationAttempt(logPath, first);
  await appendPublicationAttempt(logPath, second);

  const read = await readPublicationAttempts(logPath);
  assert.deepEqual(read.map((a) => a.attemptId), ['a1', 'a2']);
});

test('readPublicationAttempts reads a genuinely absent log as no attempts', async () => {
  const { readPublicationAttempts } = await import('../scripts/final-holdout-publication.mjs');
  const result = await readPublicationAttempts(join(tmpdir(), 'aic-120-does-not-exist', 'publications', 'x.jsonl'));
  assert.deepEqual(result, []);
});

test('readPublicationAttempts refuses an unparseable line rather than treating the log as absent', async (t) => {
  const { readPublicationAttempts, attemptLogPath } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-log-broken-');
  const logPath = attemptLogPath(join(dir, 'aaaaaaaaaaaa.json'));
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, 'not json at all\n');

  await assert.rejects(() => readPublicationAttempts(logPath));
});

test('measurementDigest reads the raw bytes on disk and returns sha256:<hex>, matching an independently computed digest', async (t) => {
  const { measurementDigest } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-digest-');
  const path = join(dir, 'record.json');
  writeFileSync(path, '{"a":1}\n');

  const digest = await measurementDigest(path);

  const expected = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  assert.equal(digest, expected);
});

/* -------------------------------------------------------------------------- */
/* 6. T1-T3 — completeHoldout (scripts/eval-final-holdout.mjs)               */
/* -------------------------------------------------------------------------- */

function claimedBaseFor(fingerprint, measurementId) {
  return {
    schemaVersion: evals.FINAL_EVALUATION_RECORD_VERSION,
    status: 'claimed',
    measurementId,
    candidate: {
      fingerprint,
      algorithm: 'sha256-over-git-ls-tree',
      paths: [...evals.FINAL_EVALUATION_CANDIDATE_PATHS],
      headSha: HEAD_SHA,
      workingTreeClean: true,
    },
    corpus: { scenarioSet: 'final-evaluation', runsPerScenario: 3, fingerprint: `sha256:${'c'.repeat(64)}` },
    claimedAt: '2026-09-24T00:00:00.000Z',
  };
}

test('T1: even when every persist call rejects, the record on disk is status complete with its report and experiments intact', async (t) => {
  const { completeHoldout } = await import('../scripts/eval-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t1-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  const measurementId = randomUUID();
  const base = claimedBaseFor(fingerprint, measurementId);

  let capturedReport;
  let capturedExperiments;
  async function execute() {
    const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing();
    capturedReport = report;
    capturedExperiments = { model: modelExperiment, naive: naiveExperiment };
    return { report, experiments: capturedExperiments };
  }

  const { record, exitCode } = await completeHoldout({
    path: recordPath,
    base,
    publishRequested: true,
    execute,
    async persist() {
      throw new Error('LangSmith is unreachable');
    },
    async verify() {
      throw new Error('must not be called: persist already failed for every arm');
    },
    now: () => new Date().toISOString(),
    newAttemptId: () => randomUUID(),
  });

  assert.equal(exitCode, 1);
  assert.equal(record.status, 'complete');

  const onDisk = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(onDisk.status, 'complete');
  assert.equal(onDisk.measurementId, measurementId);
  assert.deepEqual(
    JSON.parse(JSON.stringify(onDisk.report)),
    JSON.parse(JSON.stringify(capturedReport)),
    'the report on disk must be exactly what execute() produced',
  );
  assert.deepEqual(onDisk.experiments.model, JSON.parse(JSON.stringify(capturedExperiments.model)));
  assert.deepEqual(onDisk.experiments.naive, JSON.parse(JSON.stringify(capturedExperiments.naive)));
});

test('T2: completeHoldout returns exitCode 1 when publication was requested but a required arm never verifies', async (t) => {
  const { completeHoldout } = await import('../scripts/eval-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t2-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  const base = claimedBaseFor(fingerprint, randomUUID());

  async function execute() {
    const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing();
    return { report, experiments: { model: modelExperiment, naive: naiveExperiment } };
  }

  const { exitCode, summary } = await completeHoldout({
    path: recordPath,
    base,
    publishRequested: true,
    execute,
    async persist() {
      throw new Error('ingestion refused');
    },
    async verify() {
      throw new Error('must not be called');
    },
    now: () => new Date().toISOString(),
    newAttemptId: () => randomUUID(),
  });

  assert.equal(exitCode, 1);
  assert.equal(summary.satisfied, false);
});

test('completeHoldout returns exitCode 0, and calls neither persist nor verify, when publication was not requested', async (t) => {
  const { completeHoldout } = await import('../scripts/eval-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t2b-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  const base = claimedBaseFor(fingerprint, randomUUID());

  async function execute() {
    const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing();
    return { report, experiments: { model: modelExperiment, naive: naiveExperiment } };
  }

  const { record, exitCode } = await completeHoldout({
    path: recordPath,
    base,
    publishRequested: false,
    execute,
    async persist() {
      throw new Error('must not be called: publication was not requested');
    },
    async verify() {
      throw new Error('must not be called: publication was not requested');
    },
    now: () => new Date().toISOString(),
    newAttemptId: () => randomUUID(),
  });

  assert.equal(exitCode, 0);
  assert.equal(record.status, 'complete');
  assert.equal(record.publicationRequested, false);
});

test("T3: execute runs exactly once, and a counting fake naive port used inside it takes no further calls once completeHoldout has finished, even though publication then fails", async (t) => {
  const { completeHoldout } = await import('../scripts/eval-final-holdout.mjs');
  const { scriptedNodes } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const { naiveArm } = await import('../scripts/lane-arms.mjs');

  let executeCalls = 0;
  let completionCalls = 0;
  async function execute() {
    executeCalls += 1;
    const fakePort = {
      async complete() {
        completionCalls += 1;
        return {
          text: JSON.stringify({
            hypotheses: [],
            assessments: [],
            conclusion: { kind: 'inconclusive', causes: [] },
            stopKind: 'ambiguous',
          }),
          modelId: 'fake-naive-model',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const naiveConfig = Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' });

    async function scriptedGraphExperiment(label, plan) {
      return evals.runGraphBenchmarkExperiment({
        experimentId: `aic-120-t3-${label}`,
        scenarioSet: plan.scenarioSet,
        runsPerScenario: plan.runsPerScenario,
        metadata: plan.metadata,
        createNodes: (record) => scriptedNodes(record),
        async recordEvaluation() {},
      });
    }

    let modelExperiment;
    let naiveExperiment;
    const report = await evals.runLiveModelLane({
      env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
      scenarioSet: 'calibration',
      experimentId: 'aic-120-t3',
      headSha: HEAD_SHA,
      metadata: v3Metadata,
      controlBaseline: readControlBaseline(),
      async runControlArm(plan) {
        return scriptedGraphExperiment('control', plan);
      },
      async runModelArm(plan) {
        modelExperiment = await scriptedGraphExperiment('model', plan);
        return modelExperiment;
      },
      async runNaiveArm(plan) {
        naiveExperiment = await naiveArm({ experimentId: 'aic-120-t3-naive', port: fakePort, config: naiveConfig })(plan);
        return naiveExperiment;
      },
    });
    return { report, experiments: { model: modelExperiment, naive: naiveExperiment } };
  }

  const dir = tempDir(t, 'aic-120-t3-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  const base = claimedBaseFor(fingerprint, randomUUID());

  await completeHoldout({
    path: recordPath,
    base,
    publishRequested: true,
    execute,
    async persist() {
      throw new Error('ingestion refused');
    },
    async verify() {
      throw new Error('must not be called');
    },
    now: () => new Date().toISOString(),
    newAttemptId: () => randomUUID(),
  });

  assert.equal(executeCalls, 1, 'execute must run exactly once: the measurement is one-shot');
  const completionsAfterExecute = completionCalls;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    completionCalls,
    completionsAfterExecute,
    'no model completion may happen after execute() has already returned: a publication failure must never rerun a model',
  );
});

/* -------------------------------------------------------------------------- */
/* 7. T4/T5 — publishOnly needs no model credential and imports nothing that */
/*    could reach one                                                        */
/* -------------------------------------------------------------------------- */

test('T4: publishOnly succeeds with no model provider credential in the environment', async (t) => {
  // The row controls its own environment rather than trusting whatever the
  // process was invoked with: delete the model API key variable for the
  // duration of this test, restore whatever was there (present or absent)
  // afterward, and assert the deletion actually took before relying on it —
  // a title this test does not itself enforce is not a claim this row proves.
  const hadKey = Object.hasOwn(process.env, MODEL_API_KEY_VARIABLE);
  const previousValue = process.env[MODEL_API_KEY_VARIABLE];
  delete process.env[MODEL_API_KEY_VARIABLE];
  t.after(() => {
    if (hadKey) process.env[MODEL_API_KEY_VARIABLE] = previousValue;
  });
  assert.equal(
    Object.hasOwn(process.env, MODEL_API_KEY_VARIABLE),
    false,
    `this row must control its own environment, or its title ("with no model provider credential in the environment") is not what it tested — ${MODEL_API_KEY_VARIABLE} must be absent from the moment this line runs`,
  );

  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t4-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t4-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const record = completeRecordFor({
    fingerprint,
    measurementId: randomUUID(),
    modelExperiment,
    naiveExperiment: null,
    publicationPlan,
  });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  const result = await publishOnly({
    recordPath,
    async persist() {
      return sampleReference();
    },
    verify: verifyEchoingReference,
    now: () => '2026-09-24T00:00:00.000Z',
    newAttemptId: counterAttemptId('t4'),
  });

  assert.equal(
    Object.hasOwn(process.env, MODEL_API_KEY_VARIABLE),
    false,
    'the credential must still be absent after publishOnly ran: if anything in the call chain needed it, either it would have thrown by now or it read one that leaked in from elsewhere',
  );
  assert.equal(result.summary.satisfied, true);
});

test('T5: publish-final-holdout.mjs and final-holdout-publication.mjs import no role, lane or benchmark runner, and name no corpus, so publication cannot execute a scenario', () => {
  for (const relativePath of ['scripts/publish-final-holdout.mjs', 'scripts/final-holdout-publication.mjs']) {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    for (const forbidden of [
      '@aic/roles',
      'runLiveModelLane',
      'runGraphBenchmarkExperiment',
      'runNaiveBenchmarkExperiment',
      'createReferenceModelPort',
      "'final-evaluation'",
    ]) {
      assert.equal(source.includes(forbidden), false, `${relativePath} must not reference ${forbidden}`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 8. T6-T10 — publishOnly's retry behaviour over a record already on disk   */
/* -------------------------------------------------------------------------- */

test('T6: two failed publishOnly attempts followed by a successful one leave the attempt log holding all three, in order', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const { attemptLogPath, readPublicationAttempts } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-t6-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t6-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'the caller supplied no naive arm' } };
  const record = completeRecordFor({
    fingerprint,
    measurementId: randomUUID(),
    modelExperiment,
    naiveExperiment: null,
    publicationPlan,
  });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  const newAttemptId = counterAttemptId('t6');
  let call = 0;
  async function failTwiceThenSucceed() {
    call += 1;
    if (call < 3) throw new Error(`ingestion refused (attempt ${call})`);
    return sampleReference();
  }

  await publishOnly({ recordPath, persist: failTwiceThenSucceed, verify: verifyEchoingReference, now: () => 'T', newAttemptId });
  await publishOnly({ recordPath, persist: failTwiceThenSucceed, verify: verifyEchoingReference, now: () => 'T', newAttemptId });
  const finalResult = await publishOnly({ recordPath, persist: failTwiceThenSucceed, verify: verifyEchoingReference, now: () => 'T', newAttemptId });

  assert.equal(finalResult.summary.satisfied, true);
  const attempts = await readPublicationAttempts(attemptLogPath(recordPath));
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((a) => a.outcome), ['ingestion-failed', 'ingestion-failed', 'verified']);
  assert.deepEqual(attempts.map((a) => a.arm), ['model', 'model', 'model']);
});

test('T7: a successful publishOnly leaves the record file byte-identical to what it was before', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t7-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t7-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const record = completeRecordFor({
    fingerprint,
    measurementId: randomUUID(),
    modelExperiment,
    naiveExperiment: null,
    publicationPlan,
  });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);
  const before = readFileSync(recordPath);

  await publishOnly({
    recordPath,
    async persist() {
      return sampleReference();
    },
    verify: verifyEchoingReference,
    now: () => 'T',
    newAttemptId: counterAttemptId('t7'),
  });

  const after = readFileSync(recordPath);
  assert.equal(
    Buffer.compare(before, after),
    0,
    'publishOnly must never rewrite the measured record — metrics, outputs, headSha, fingerprint, scenario results, usage and measurementId must stay byte-identical; only the attempt log may change',
  );
});

test('T8: naive persist succeeds and model persist rejects — the log holds model ingestion-failed and naive verified, satisfied is false, and the next publishOnly retries only the model arm', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t8-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t8-model');
  const naiveExperiment = distinctExperiment('aic-120-t8-naive');
  const publicationPlan = { model: { required: true }, naive: { required: true } };
  const record = completeRecordFor({ fingerprint, measurementId: randomUUID(), modelExperiment, naiveExperiment, publicationPlan });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  const isModel = (experiment) => experiment.records[0].experimentId === modelExperiment.records[0].experimentId;

  const newAttemptId = counterAttemptId('t8-first');
  async function firstPersist(options) {
    if (isModel(options.experiment)) throw new Error('model ingestion refused');
    return sampleReference();
  }
  const first = await publishOnly({ recordPath, persist: firstPersist, verify: verifyEchoingReference, now: () => 'T1', newAttemptId });

  assert.equal(first.summary.satisfied, false);
  assert.equal(first.summary.arms.model.state, 'ingestion-failed');
  assert.equal(first.summary.arms.naive.state, 'verified');

  const retryCalls = [];
  const second = await publishOnly({
    recordPath,
    async persist(options) {
      retryCalls.push(options);
      return sampleReference();
    },
    verify: verifyEchoingReference,
    now: () => 'T2',
    newAttemptId: counterAttemptId('t8-second'),
  });

  assert.equal(retryCalls.length, 1, 'the retry must call persist exactly once, for the still-unverified model arm');
  assert.ok(isModel(retryCalls[0].experiment), 'the retry must be for the model arm, since naive is already verified');
  assert.equal(second.summary.satisfied, true);
});

test('T9: when persist rejects for both required arms, the record stays complete on disk, the log holds two ingestion-failed lines, and the result reports exitCode 1', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const { attemptLogPath, readPublicationAttempts } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-t9-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t9-model');
  const naiveExperiment = distinctExperiment('aic-120-t9-naive');
  const publicationPlan = { model: { required: true }, naive: { required: true } };
  const record = completeRecordFor({ fingerprint, measurementId: randomUUID(), modelExperiment, naiveExperiment, publicationPlan });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);
  const before = readFileSync(recordPath, 'utf8');

  const result = await publishOnly({
    recordPath,
    async persist() {
      throw new Error('ingestion refused');
    },
    async verify() {
      throw new Error('must not be called: persist already failed');
    },
    now: () => 'T',
    newAttemptId: counterAttemptId('t9'),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.satisfied, false);
  const after = readFileSync(recordPath, 'utf8');
  assert.equal(after, before, 'the measured record must remain complete on disk regardless of publication outcome');

  const attempts = await readPublicationAttempts(attemptLogPath(recordPath));
  assert.deepEqual(attempts.map((a) => a.outcome), ['ingestion-failed', 'ingestion-failed']);
  assert.deepEqual(attempts.map((a) => a.arm).sort(), ['model', 'naive']);
});

test('T10: persist succeeds but verify rejects — the arm logs readback-failed with its reference kept, distinct from ingestion-failed, and the next publishOnly verifies the same reference with no new persist call', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const { attemptLogPath, readPublicationAttempts } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-t10-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t10-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const record = completeRecordFor({ fingerprint, measurementId: randomUUID(), modelExperiment, naiveExperiment: null, publicationPlan });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  const reference = sampleReference();
  let firstPersistCalls = 0;
  const first = await publishOnly({
    recordPath,
    async persist() {
      firstPersistCalls += 1;
      return reference;
    },
    async verify() {
      throw new Error('LangSmith readback 500');
    },
    now: () => 'T1',
    newAttemptId: counterAttemptId('t10-first'),
  });

  assert.equal(firstPersistCalls, 1);
  assert.equal(first.summary.arms.model.state, 'readback-failed');
  assert.notEqual(first.summary.arms.model.state, 'ingestion-failed');

  const attempts1 = await readPublicationAttempts(attemptLogPath(recordPath));
  assert.equal(attempts1.length, 1);
  assert.equal(attempts1[0].outcome, 'readback-failed');
  assert.deepEqual(attempts1[0].reference, reference, 'the reference LangSmith actually created must be kept even though the readback failed');

  let secondPersistCalls = 0;
  let verifyCalls = 0;
  const second = await publishOnly({
    recordPath,
    async persist() {
      secondPersistCalls += 1;
      return sampleReference();
    },
    async verify({ reference: given }) {
      verifyCalls += 1;
      assert.deepEqual(given, reference, 'the retry must verify the SAME reference the failed attempt recorded');
      return verifyEchoingReference({ reference: given });
    },
    now: () => 'T2',
    newAttemptId: counterAttemptId('t10-second'),
  });

  assert.equal(secondPersistCalls, 0, 'a retry after readback-failed must not create a new dataset: it verifies the one already created');
  assert.equal(verifyCalls, 1);
  assert.equal(second.summary.arms.model.state, 'verified');
});

/* -------------------------------------------------------------------------- */
/* 8b. Dataset naming and attempt mode — pinned against an independent oracle */
/* -------------------------------------------------------------------------- */

/**
 * AIC-120 round 2: `publishRecordedMeasurement`'s dataset name is an inline
 * template literal with no exported name any test called — replacing it with
 * a constant left every existing row in this file green, because none of them
 * reads the `datasetName` a `persist` call actually received. This row does,
 * and the expected names are computed here from the record's own
 * `candidate.headSha`, independently of the production module rather than by
 * reading back whatever `publishRecordedMeasurement` just built.
 * see test/lane-arms.test.mjs, "6. publishHoldoutArms / publishLiveModelArms"
 * header, for where this pin now lives relative to the deleted rows it closes
 * a gap `planHoldoutPublication`'s own rows never covered.
 */
test('publishOnly persists each required arm under a dataset name built from the record’s own head SHA and attempt number, and a retry after ingestion-failed bumps the suffix', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-dataset-name-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-dataset-name-model');
  const naiveExperiment = distinctExperiment('aic-120-dataset-name-naive');
  const publicationPlan = { model: { required: true }, naive: { required: true } };
  const record = completeRecordFor({
    fingerprint,
    measurementId: randomUUID(),
    modelExperiment,
    naiveExperiment,
    publicationPlan,
  });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  const headSha12 = record.candidate.headSha.slice(0, 12);
  assert.equal(
    headSha12,
    HEAD_SHA12,
    'the fixture’s own headSha must be the one this row computes the expected name from',
  );

  const firstAttemptDatasetNames = [];
  async function alwaysFail(options) {
    firstAttemptDatasetNames.push(options.datasetName);
    throw new Error('ingestion refused');
  }

  await publishOnly({
    recordPath,
    persist: alwaysFail,
    verify: verifyEchoingReference,
    now: () => 'T1',
    newAttemptId: counterAttemptId('dataset-name-first'),
  });

  assert.deepEqual(
    firstAttemptDatasetNames.sort(),
    [`aic-19-final-holdout-model-${headSha12}-a1`, `aic-19-final-holdout-naive-${headSha12}-a1`].sort(),
    'the first attempt for each arm must persist under a dataset name naming the arm, the record’s own head SHA, and attempt number 1 — computed here, not read back from what production just did',
  );

  const secondAttemptDatasetNames = [];
  async function alwaysFailAgain(options) {
    secondAttemptDatasetNames.push(options.datasetName);
    throw new Error('ingestion refused again');
  }

  await publishOnly({
    recordPath,
    persist: alwaysFailAgain,
    verify: verifyEchoingReference,
    now: () => 'T2',
    newAttemptId: counterAttemptId('dataset-name-second'),
  });

  assert.deepEqual(
    secondAttemptDatasetNames.sort(),
    [`aic-19-final-holdout-model-${headSha12}-a2`, `aic-19-final-holdout-naive-${headSha12}-a2`].sort(),
    'a retry after an ingestion-failed attempt must persist under a dataset name suffixed -a2, so it can never collide with the half-created dataset the first attempt may have left behind',
  );
});

/**
 * AIC-120 round 2: nothing pinned the `mode` a publication attempt is written
 * with, so mutating `completeHoldout`'s literal `'with-measurement'` into
 * `'publication-only'` (or the reverse in `publishOnly`) survives the suite
 * unnoticed.
 */
test('completeHoldout writes each publication attempt with mode "with-measurement", and a later publishOnly retry writes "publication-only"', async (t) => {
  const { completeHoldout } = await import('../scripts/eval-final-holdout.mjs');
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const { attemptLogPath, readPublicationAttempts } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-mode-pin-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  const base = claimedBaseFor(fingerprint, randomUUID());

  async function execute() {
    const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing();
    return { report, experiments: { model: modelExperiment, naive: naiveExperiment } };
  }

  await completeHoldout({
    path: recordPath,
    base,
    publishRequested: true,
    execute,
    async persist() {
      throw new Error('ingestion refused');
    },
    async verify() {
      throw new Error('must not be called: persist already failed for every arm');
    },
    now: () => 'T1',
    newAttemptId: counterAttemptId('mode-pin-first'),
  });

  const firstAttempts = await readPublicationAttempts(attemptLogPath(recordPath));
  assert.ok(
    firstAttempts.length > 0,
    'completeHoldout must have logged at least one attempt, or this row proves nothing about its mode',
  );
  assert.deepEqual(
    firstAttempts.map((attempt) => attempt.mode),
    firstAttempts.map(() => 'with-measurement'),
    'every attempt completeHoldout writes must carry mode "with-measurement", literally',
  );

  const retryResult = await publishOnly({
    recordPath,
    async persist() {
      return sampleReference();
    },
    verify: verifyEchoingReference,
    now: () => 'T2',
    newAttemptId: counterAttemptId('mode-pin-retry'),
  });

  const allAttempts = await readPublicationAttempts(attemptLogPath(recordPath));
  const retryAttempts = allAttempts.slice(firstAttempts.length);
  assert.ok(
    retryAttempts.length > 0,
    'the publishOnly retry must have logged at least one new attempt, or this row proves nothing about its mode',
  );
  assert.deepEqual(
    retryAttempts.map((attempt) => attempt.mode),
    retryAttempts.map(() => 'publication-only'),
    'every attempt publishOnly writes must carry mode "publication-only", literally — the same field, read the same way, disagreeing only in which command wrote it',
  );
  assert.equal(retryResult.summary.satisfied, true);
});

/* -------------------------------------------------------------------------- */
/* 9. T11 — publishOnly's three refusals, each before any persist call       */
/* -------------------------------------------------------------------------- */

test('T11a: publishOnly refuses a record still in the claimed state, and never calls persist', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t11a-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  writeJson(recordPath, claimedBaseFor(fingerprint, randomUUID()));

  let persistCalls = 0;
  await assert.rejects(() =>
    publishOnly({
      recordPath,
      async persist() {
        persistCalls += 1;
      },
      async verify() {},
      now: () => 'T',
      newAttemptId: () => 'a1',
    }),
  );
  assert.equal(persistCalls, 0);
});

test('T11b: publishOnly refuses a complete record whose file basename does not match its candidate fingerprint, and never calls persist', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t11b-');
  const { fingerprint } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t11b-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const record = completeRecordFor({ fingerprint, measurementId: randomUUID(), modelExperiment, naiveExperiment: null, publicationPlan });
  const recordPath = join(dir, 'completely-unrelated-name.json');
  writeJson(recordPath, record);

  let persistCalls = 0;
  await assert.rejects(() =>
    publishOnly({
      recordPath,
      async persist() {
        persistCalls += 1;
      },
      async verify() {},
      now: () => 'T',
      newAttemptId: () => 'a1',
    }),
  );
  assert.equal(persistCalls, 0);
});

test('T11c: publishOnly refuses when the record bytes changed after a prior attempt was logged, because the measured digest no longer matches, and never calls persist', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t11c-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t11c-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const record = completeRecordFor({ fingerprint, measurementId: randomUUID(), modelExperiment, naiveExperiment: null, publicationPlan });
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  // One attempt, logged against the ORIGINAL bytes' digest.
  await publishOnly({
    recordPath,
    async persist() {
      throw new Error('ingestion refused');
    },
    async verify() {},
    now: () => 'T1',
    newAttemptId: () => 'a1',
  });

  // The record changes on disk after the attempt was logged.
  writeJson(recordPath, { ...record, completedAt: '2099-01-01T00:00:00.000Z' });

  let persistCalls = 0;
  await assert.rejects(() =>
    publishOnly({
      recordPath,
      async persist() {
        persistCalls += 1;
      },
      async verify() {},
      now: () => 'T2',
      newAttemptId: () => 'a2',
    }),
  );
  assert.equal(persistCalls, 0);
});

test('T11d: publishOnly refuses a complete record whose candidate.headSha is missing, before any persist call, and logs no attempt', async (t) => {
  const { publishOnly } = await import('../scripts/publish-final-holdout.mjs');
  const { attemptLogPath, readPublicationAttempts } = await import('../scripts/final-holdout-publication.mjs');
  const dir = tempDir(t, 'aic-120-t11d-');
  const { fingerprint, basename } = freshFingerprint();
  const modelExperiment = distinctExperiment('aic-120-t11d-model');
  const publicationPlan = { model: { required: true }, naive: { required: false, reason: 'x' } };
  const record = completeRecordFor({ fingerprint, measurementId: randomUUID(), modelExperiment, naiveExperiment: null, publicationPlan });
  delete record.candidate.headSha;
  const recordPath = join(dir, basename);
  writeJson(recordPath, record);

  let persistCalls = 0;
  await assert.rejects(
    () =>
      publishOnly({
        recordPath,
        async persist() {
          persistCalls += 1;
        },
        async verify() {},
        now: () => 'T',
        newAttemptId: () => 'a1',
      }),
    (error) => error instanceof Error && /headSha/.test(error.message),
  );
  assert.equal(persistCalls, 0);

  const attempts = await readPublicationAttempts(attemptLogPath(recordPath));
  assert.deepEqual(attempts, [], 'a refusal before any persist call must log no attempt at all');
});

/* -------------------------------------------------------------------------- */
/* 10. T12 — ordering non-vacuity, and no publish key reaches the lane call  */
/* -------------------------------------------------------------------------- */

test('T12: a persist that reads the record file AT CALL TIME sees status complete, proving the durable write happens before any publication attempt', async (t) => {
  const { completeHoldout } = await import('../scripts/eval-final-holdout.mjs');
  const dir = tempDir(t, 'aic-120-t12-');
  const { fingerprint, basename } = freshFingerprint();
  const recordPath = join(dir, basename);
  const base = claimedBaseFor(fingerprint, randomUUID());

  async function execute() {
    const { report, modelExperiment, naiveExperiment } = await fourArmLaneCapturing();
    return { report, experiments: { model: modelExperiment, naive: naiveExperiment } };
  }

  let sawComplete = false;
  async function persist() {
    const onDisk = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(
      onDisk.status,
      'complete',
      'the record on disk must already be complete before persist is ever called — this reddens if the durable write moves after publication',
    );
    sawComplete = true;
    return sampleReference();
  }

  await completeHoldout({
    path: recordPath,
    base,
    publishRequested: true,
    execute,
    persist,
    verify: verifyEchoingReference,
    now: () => new Date().toISOString(),
    newAttemptId: () => randomUUID(),
  });

  assert.equal(sawComplete, true, 'persist must have been called at least once for this row to mean anything');
});

test('scripts/eval-final-holdout.mjs passes runLiveModelLane no publish option any more', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');
  const markerIndex = source.indexOf('evals.runLiveModelLane({');
  assert.ok(markerIndex >= 0, 'expected to find the runLiveModelLane call site');

  const openIndex = source.indexOf('{', markerIndex);
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  assert.ok(closeIndex > openIndex, 'expected a matching closing brace for the options object');

  const body = source.slice(openIndex + 1, closeIndex);
  assert.doesNotMatch(
    body,
    /\bpublish\s*[:(]/,
    'the lane call must carry no publish key: LangSmith publication moved entirely into completeHoldout/publishRecordedMeasurement',
  );
});

test('main() reports the recovery command and exits 1 when completeHoldout returns a non-zero exitCode', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/eval-final-holdout.mjs'), 'utf8');
  assert.match(source, /eval:final-holdout:publish/, 'main must print the recovery command by name');
  assert.match(source, /exitCode/, "main must read completeHoldout's exitCode");
  assert.match(source, /exit\(1\)/, 'main must exit 1 when a required publication did not satisfy the plan');
});

/* -------------------------------------------------------------------------- */
/* 11. JSON round trip: a record read back from disk publishes the same     */
/*    createRun/createExamples payload as the in-memory experiment          */
/* -------------------------------------------------------------------------- */

test('an experiment read back from a JSON round trip through the record publishes the same createRun/createExamples payload to a capturing LangSmith client as the in-memory experiment', async () => {
  const inMemory = distinctExperiment('aic-120-roundtrip');
  const roundTripped = JSON.parse(JSON.stringify(inMemory));

  const captureA = capturingClient();
  await observability.persistBenchmarkExperiment({
    client: captureA.client,
    datasetName: 'aic-120-roundtrip-dataset',
    experiment: inMemory,
  });

  const captureB = capturingClient();
  await observability.persistBenchmarkExperiment({
    client: captureB.client,
    datasetName: 'aic-120-roundtrip-dataset',
    experiment: roundTripped,
  });

  const payloadsOf = (capture) =>
    capture.calls
      .filter((call) => call.method === 'createRun' || call.method === 'createExamples')
      .map((call) => call.payload);

  assert.deepEqual(payloadsOf(captureA), payloadsOf(captureB));
});

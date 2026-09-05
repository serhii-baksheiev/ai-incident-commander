/**
 * AIC-94, step 8: the bounded live-model evaluation lane.
 *
 * 🔴 **Nothing in this file executes a model.** There is no provider credential
 * in this environment, so the two acceptance rows that need one — "a real model
 * executes the three roles" and "one live Incident Lab scenario completes" — are
 * not demonstrated anywhere in this repository, and this file must not be read
 * as demonstrating them. What it pins is everything the lane does AROUND the
 * model: the refusal when no credential exists, the caps, the two-arm design
 * that separates a harness regression from a model-quality one, and the metric
 * this lane refuses to publish as model quality at all.
 *
 * The arms are injected, so the lane is decidable with scripted experiments.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import { MissingModelCredentialError, MODEL_API_KEY_VARIABLE } from '@aic/roles';

import {
  benchmarkVersions,
  replayBackedNodes,
} from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requireExport(name) {
  assert.ok(evals[name] !== undefined, `@aic/evals must export ${name}`);
  return evals[name];
}

const HEAD_SHA = 'a'.repeat(40);

function fakeApiKey() {
  return ['sk', 'ant', 'test', '0'.repeat(24)].join('-');
}

/**
 * A scripted experiment over the real final-evaluation plan.
 *
 * The plan comes from `createFinalEvaluationBenchmarkPlan`, so the hold-out
 * policy is the one already accepted in `BENCHMARK_SCENARIO_PARTITIONS` and this
 * lane never builds a second partition.
 */
function scriptedExperiment(experimentId, scoreFor) {
  const records = evals.createFinalEvaluationBenchmarkPlan({
    experimentId,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  const results = records.map((record) => ({
    experimentId: record.experimentId,
    exampleId: record.exampleId,
    runId: record.runId,
    actualStopKind: 'sufficient',
    metrics: {
      unsupported_claim_rate: {
        key: 'unsupported_claim_rate',
        score: scoreFor('unsupported_claim_rate', record),
      },
      evidence_coverage: {
        key: 'evidence_coverage',
        score: scoreFor('evidence_coverage', record),
      },
      termination_correctness: {
        key: 'termination_correctness',
        score: scoreFor('termination_correctness', record),
      },
    },
    behaviorMetrics: {},
  }));
  return { records, results, stopKindDistribution: { sufficient: results.length } };
}

const perfect = (key) => (key === 'unsupported_claim_rate' ? 0 : 1);

function laneOptions(overrides = {}) {
  return {
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    experimentId: 'aic-94-live-model',
    headSha: HEAD_SHA,
    metadata: benchmarkVersions,
    controlBaseline: {
      unsupported_claim_rate: 0,
      evidence_coverage: 1,
      termination_correctness: 1,
    },
    async runControlArm() {
      return scriptedExperiment('aic-94-live-model-control', perfect);
    },
    async runModelArm() {
      return scriptedExperiment('aic-94-live-model-model', perfect);
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* the credential refusal — the acceptance row this environment can reach      */
/* -------------------------------------------------------------------------- */

test('refuses the lane with the named variable and touches nothing when no credential is set', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const touched = [];

  await assert.rejects(
    () => runLiveModelLane(
      laneOptions({
        env: {},
        async runControlArm() {
          touched.push('control');
          return scriptedExperiment('unreached', perfect);
        },
        async runModelArm() {
          touched.push('model');
          return scriptedExperiment('unreached', perfect);
        },
        async publish() {
          touched.push('publish');
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof MissingModelCredentialError);
      assert.equal(error.variable, MODEL_API_KEY_VARIABLE);
      return true;
    },
  );

  assert.deepEqual(
    touched,
    [],
    'no arm, no dataset, no project and no run: an unconfigured lane must cost nothing',
  );
});

/* -------------------------------------------------------------------------- */
/* the bounds                                                                 */
/* -------------------------------------------------------------------------- */

test('publishes the two caps it runs under rather than leaving them implicit', () => {
  const maxRuns = requireExport('LIVE_MODEL_LANE_MAX_MODEL_RUNS');
  const maxCalls = requireExport('LIVE_MODEL_LANE_MAX_MODEL_CALLS');
  const runsPerScenario = requireExport('LIVE_MODEL_LANE_RUNS_PER_SCENARIO');

  assert.equal(Number.isSafeInteger(maxRuns) && maxRuns > 0, true);
  assert.equal(Number.isSafeInteger(maxCalls) && maxCalls > 0, true);
  assert.equal(runsPerScenario, 3);
  assert.equal(
    maxRuns,
    evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.length * runsPerScenario +
      evals.BENCHMARK_SCENARIO_PARTITIONS.holdout.length * runsPerScenario,
    'the run cap is derived from the accepted partition, not typed beside it',
  );
});

test('refuses a run count above the declared cap before any arm executes', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  let armsRun = 0;

  await assert.rejects(
    () => runLiveModelLane(
      laneOptions({
        runsPerScenario: 9,
        async runControlArm() {
          armsRun += 1;
          return scriptedExperiment('unreached', perfect);
        },
      }),
    ),
    /cap/i,
  );
  assert.equal(armsRun, 0);
});

/* -------------------------------------------------------------------------- */
/* two arms, same plan, reported separately                                   */
/* -------------------------------------------------------------------------- */

test('runs both arms over the same plan and reports them separately', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const plans = [];

  const report = await runLiveModelLane(
    laneOptions({
      async runControlArm(plan) {
        plans.push(['control', plan]);
        return scriptedExperiment('aic-94-live-model-control', perfect);
      },
      async runModelArm(plan) {
        plans.push(['model', plan]);
        return scriptedExperiment('aic-94-live-model-model', perfect);
      },
    }),
  );

  assert.deepEqual(plans.map(([arm]) => arm), ['control', 'model']);
  assert.deepEqual(plans[0][1], plans[1][1], 'both arms take the same plan');
  assert.equal(plans[0][1].scenarioSet, 'final-evaluation');
  assert.equal(report.headSha, HEAD_SHA);
  assert.deepEqual(Object.keys(report.arms).sort(), ['control', 'model']);
  assert.notEqual(
    report.arms.control.metrics,
    report.arms.model.metrics,
    'the two arms are never merged into one set of numbers',
  );
});

test('refuses two arms whose plans did not cover the same examples', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () => runLiveModelLane(
      laneOptions({
        async runModelArm() {
          const experiment = scriptedExperiment('aic-94-live-model-model', perfect);
          return {
            ...experiment,
            records: experiment.records.slice(0, -1),
            results: experiment.results.slice(0, -1),
          };
        },
      }),
    ),
    /same examples/i,
    'a comparison across two different corpora is not a comparison',
  );
});

test('publishes one figure per metric and no composite anywhere', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(laneOptions());

  for (const arm of Object.values(report.arms)) {
    for (const [key, value] of Object.entries(arm.metrics)) {
      assert.equal(value.key, key);
      assert.equal(typeof value.mean, 'number');
      assert.equal(typeof value.exampleCount, 'number');
    }
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /"(?:composite|overall|aggregate|totalScore)"/i,
    'one number standing for every metric is what lets a red metric read as green',
  );
});

/* -------------------------------------------------------------------------- */
/* harness regression vs model-quality regression                             */
/* -------------------------------------------------------------------------- */

test('reports a moved control arm as a harness regression and withholds the model numbers', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    laneOptions({
      async runControlArm() {
        return scriptedExperiment('aic-94-live-model-control', (key, record) =>
          key === 'termination_correctness' && record.exampleId.startsWith('0')
            ? 0
            : perfect(key));
      },
    }),
  );

  assert.equal(report.verdict, 'harness-regression');
  assert.equal(report.arms.model.reportable, false);
  assert.match(report.arms.model.unreportableReason, /harness/i);
  assert.ok(
    report.arms.control.movedMetrics.includes('termination_correctness'),
    'the report must name which control metric moved',
  );
});

test('reports model quality only when the control arm matches its declared baseline', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(laneOptions());

  assert.equal(report.verdict, 'model-quality');
  assert.equal(report.arms.control.movedMetrics.length, 0);
  assert.equal(report.arms.model.reportable, true);
});

test('refuses to report model quality when no control baseline was declared', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(laneOptions({ controlBaseline: undefined }));

  assert.equal(report.verdict, 'control-baseline-undeclared');
  assert.equal(report.arms.model.reportable, false);
  assert.match(report.arms.model.unreportableReason, /baseline/i);
  assert.deepEqual(
    Object.keys(report.arms.control.observedBaseline).sort(),
    ['termination_correctness', 'unsupported_claim_rate'],
    'the run still reports what the control arm scored, so an operator can declare it — minus the withheld metric, which is not a figure anyone should be declaring a baseline for',
  );
});

/* -------------------------------------------------------------------------- */
/* D4: evidence_coverage is a harness figure here, not a model-quality figure  */
/* -------------------------------------------------------------------------- */

test('withholds evidence_coverage from model quality and says why', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(laneOptions());

  assert.equal(
    'evidence_coverage' in report.arms.model.metrics,
    false,
    'a graph-executed evidence_coverage is a harness artefact and must never be published as model quality',
  );
  assert.match(
    report.withheld.evidence_coverage,
    /fingerprint|predicate|statement/i,
    'the reason must name the mismatch, not merely announce a withholding',
  );
  assert.equal(
    'evidence_coverage' in report.arms.control.metrics,
    false,
    'the same figure is withheld on both arms: it is the harness that produces it',
  );
});

test('reports what the model arm consumed on its own axes', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    laneOptions({
      modelUsage: () => ({ calls: 7, inputTokens: 900, outputTokens: 120 }),
    }),
  );

  assert.deepEqual(report.arms.model.usage, {
    calls: 7,
    inputTokens: 900,
    outputTokens: 120,
  });
  assert.equal(
    'usage' in report.arms.control,
    false,
    'the scripted arm consumed no model and must not report a zero as if it had',
  );
});

/* -------------------------------------------------------------------------- */
/* an ingestion refusal is a failure, never a completed publication            */
/* -------------------------------------------------------------------------- */

test('reports a publication refusal as a failure rather than as a published lane', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () => runLiveModelLane(
      laneOptions({
        async publish() {
          throw new Error('429 usage limit exceeded');
        },
      }),
    ),
    /429/,
    'a refused ingestion must surface: a retry loop here would hide it',
  );
});


/* -------------------------------------------------------------------------- */
/* the command                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The command's credential-absent behaviour, which is the ONE end-to-end path of
 * this lane that this environment can execute.
 *
 * It spawns with the suite's allow-list environment, so the variable really is
 * absent rather than merely unset in this test's own scope.
 */
test('exits non-zero naming the variable when the command is run with no credential', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(projectRoot, 'scripts/eval-live-model.mjs')],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv({ CI: '1' }) },
  );

  assert.notEqual(result.status, 0, 'an unconfigured lane must fail the command');
  assert.match(result.stderr, /MissingModelCredentialError/);
  assert.match(result.stderr, new RegExp(MODEL_API_KEY_VARIABLE));
  assert.equal(
    result.stdout,
    '',
    'no report is written when the lane never ran: an empty report is still a report',
  );
});


/* -------------------------------------------------------------------------- */
/* D4, measured rather than asserted                                          */
/* -------------------------------------------------------------------------- */

/**
 * The reason `evidence_coverage` is withheld, reproduced.
 *
 * `evaluateEvidenceCoverage` compares `[kind, source, predicate]` as an exact
 * fingerprint, where the expected predicate is hand-written ground-truth prose
 * and the observed one is the fixture's evidence `statement`. Those strings are
 * never equal in this corpus, so a graph-executed run scores zero on this metric
 * for a reason that has nothing to do with whoever reasoned over the evidence.
 *
 * This is a pre-existing evaluator defect, filed separately and NOT fixed here.
 * It is measured here because the whole point of this lane is to separate a
 * harness artefact from a model result, and a withholding nobody can check is
 * just an assertion.
 */
test('measures the harness zero that makes evidence_coverage unreportable', async () => {
  const experiment = await evals.runGraphBenchmarkExperiment({
    experimentId: 'aic-94-evidence-coverage-harness-probe',
    scenarioSet: 'final-evaluation',
    runsPerScenario: 3,
    metadata: {
      ...benchmarkVersions,
      statusRulesVersion: STATUS_RULES_VERSION,
    },
    createNodes: (record) =>
      replayBackedNodes(
        record,
        new Map([[record.runId, []]]),
        new Map([[record.runId, 0]]),
      ),
    async recordEvaluation() {},
  });

  assert.equal(experiment.results.length, 30);
  assert.deepEqual(
    [
      ...new Set(
        experiment.results.map(({ metrics }) => metrics.evidence_coverage.score),
      ),
    ],
    [0],
    'every graph-executed run scores zero, which is why publishing this figure as model quality would be a lie in either direction',
  );

  const scenario = evals.REPLAY_SCENARIOS.find(
    ({ groundTruth }) => groundTruth.expectedEvidence.length > 0,
  );
  const expected = scenario.groundTruth.expectedEvidence[0];
  const observed = scenario.fixture.entries
    .flatMap(({ result }) => (result.status === 'ok' ? result.output : []))
    .map(({ kind, source, statement }) => ({ kind, source, predicate: statement }));
  assert.equal(
    observed.some(
      (fingerprint) =>
        fingerprint.kind === expected.kind &&
        fingerprint.source === expected.source &&
        fingerprint.predicate === expected.predicate,
    ),
    false,
    'the ground-truth predicate is prose and the evidence statement is a different sentence: the fingerprints cannot match, which is the defect',
  );
});

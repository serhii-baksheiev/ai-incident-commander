/**
 * AIC-117 slice a: the four-arm live-model lane report core
 * (`packages/evals/src/live-model-lane.ts`, plus `evaluateUnsupportedClaimRate`
 * in `benchmark-evaluation.ts` for claimCount).
 *
 * 🔴 Nothing here executes a model. Every arm below is an injected fake that
 * drives `runLiveModelLane` with a real `BenchmarkExperiment` — built by
 * running the declared plan through this file's own `scriptedExperiment`,
 * never through the lane's own summarizing helpers — so example ids and
 * records are genuine while per-record scores are hand-picked to force the
 * comparison each row needs.
 *
 * Scope: this file pins the NEW surface only — the optional oracle and naive
 * arms, per-scenario metrics, claimCount, the lifted notApplicable map, the
 * version-dependent withheld set, comparability, graph-vs-naive win/tie/loss,
 * and the derived call caps. `test/live-model-lane.test.mjs` already pins the
 * unchanged two-arm behaviour and is not duplicated here.
 *
 * Every expected number below is computed from literal inputs in the test
 * itself (a claims array's own length, a hand-picked per-scenario score, the
 * budget-policy fields and partition lengths read directly off `@aic/evals`)
 * rather than by calling the lane's own constants or summarizing helpers into
 * themselves.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';
import { MODEL_API_KEY_VARIABLE, requireModelConfig } from '@aic/roles';

import {
  benchmarkVersions,
  perfectOutcomeFor,
} from './fixtures/benchmark-experiment.mjs';

const HEAD_SHA = 'b'.repeat(40);

function requireExport(name) {
  assert.ok(evals[name] !== undefined, `@aic/evals must export ${name}`);
  return evals[name];
}

function fakeApiKey() {
  return ['sk', 'ant', 'test', '1'.repeat(24)].join('-');
}

/**
 * The plan for one declared corpus, built the same way every arm below builds
 * it: from the accepted `BENCHMARK_SCENARIO_PARTITIONS`, never from a second
 * partition this file invents.
 */
function planFor(scenarioSet, options) {
  return scenarioSet === 'calibration'
    ? evals.createCalibrationBenchmarkPlan(options)
    : evals.createFinalEvaluationBenchmarkPlan(options);
}

const perfect = (key) => (key === 'unsupported_claim_rate' ? 0 : 1);

/**
 * A scripted experiment over the real plan for the declared corpus — the same
 * pattern `test/live-model-lane.test.mjs` uses, duplicated here rather than
 * imported (a test file exports nothing another test file may import) and
 * extended with the two things this slice's rows need: a run-indexed score
 * (`scoreFor(key, record, runIndex)`, `runIndex` counting up within each
 * scenario in plan order), a per-record `notApplicable` map, and an optional
 * claimCount on the unsupported_claim_rate metric.
 */
function scriptedExperiment(
  experimentId,
  scoreFor,
  {
    omitMetrics = [],
    scenarioSet = 'final-evaluation',
    runsPerScenario = 3,
    metadata = benchmarkVersions,
    claimCountFor,
    notApplicableFor,
  } = {},
) {
  const records = planFor(scenarioSet, { experimentId, runsPerScenario, metadata });
  const omitted = new Set(omitMetrics);
  const runIndexByScenario = new Map();
  const results = records.map((record) => {
    const scenarioId = record.scenario.id;
    const runIndex = runIndexByScenario.get(scenarioId) ?? 0;
    runIndexByScenario.set(scenarioId, runIndex + 1);

    const metrics = {};
    for (const key of [
      'unsupported_claim_rate',
      'evidence_coverage',
      'termination_correctness',
    ]) {
      if (omitted.has(key)) continue;
      const score = scoreFor(key, record, runIndex);
      metrics[key] =
        key === 'unsupported_claim_rate' && claimCountFor !== undefined
          ? { key, score, claimCount: claimCountFor(record, runIndex) }
          : { key, score };
    }
    const notApplicable = notApplicableFor?.(record, runIndex);
    return {
      experimentId: record.experimentId,
      exampleId: record.exampleId,
      runId: record.runId,
      actualStopKind: 'sufficient',
      metrics,
      behaviorMetrics: {},
      ...(notApplicable === undefined ? {} : { notApplicable }),
    };
  });
  return { records, results, stopKindDistribution: { sufficient: results.length } };
}

/**
 * The four-arm option set every row starts from: all four arms declared and
 * completing perfectly over the same declared plan, so a row overriding one
 * arm (or the plan) does not have to restate the other three.
 */
function fourArmLaneOptions(overrides = {}) {
  const scenarioSet = overrides.scenarioSet ?? 'final-evaluation';
  const runsPerScenario = overrides.runsPerScenario ?? 3;
  const metadata = overrides.metadata ?? benchmarkVersions;
  return {
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet,
    runsPerScenario,
    experimentId: 'aic-117-four-arm',
    headSha: HEAD_SHA,
    metadata,
    // evidence_coverage is absent here on purpose: under the default v0.2
    // metadata it is withheld, so declaring it would be refused by name — the
    // same reason `live-model-lane.test.mjs`'s laneOptions omits it.
    controlBaseline: {
      unsupported_claim_rate: 0,
      termination_correctness: 1,
    },
    async runControlArm() {
      return scriptedExperiment('aic-117-control', perfect, { scenarioSet, runsPerScenario, metadata });
    },
    async runOracleArm() {
      return scriptedExperiment('aic-117-oracle', perfect, { scenarioSet, runsPerScenario, metadata });
    },
    async runNaiveArm() {
      return scriptedExperiment('aic-117-naive', perfect, { scenarioSet, runsPerScenario, metadata });
    },
    async runModelArm() {
      return scriptedExperiment('aic-117-model', perfect, { scenarioSet, runsPerScenario, metadata });
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. report schema version and information mode                             */
/* -------------------------------------------------------------------------- */

test('carries the report schema version as an own property, at the exported value', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  assert.equal(requireExport('LIVE_MODEL_LANE_REPORT_SCHEMA_VERSION'), 2);

  const report = await runLiveModelLane(fourArmLaneOptions());

  assert.ok(Object.hasOwn(report, 'schemaVersion'));
  assert.equal(report.schemaVersion, 2);
});

test('declares informationMode full-dump on every report', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(fourArmLaneOptions());

  assert.equal(report.informationMode, 'full-dump');
});

/* -------------------------------------------------------------------------- */
/* 2. four arms; oracle and naive are optional                                */
/* -------------------------------------------------------------------------- */

test('still returns not-run oracle and naive arms, with model and control unchanged apart from the new fields, when the caller supplies only the two original arms', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'final-evaluation',
    experimentId: 'aic-117-two-arm',
    headSha: HEAD_SHA,
    metadata: benchmarkVersions,
    controlBaseline: { unsupported_claim_rate: 0, termination_correctness: 1 },
    async runControlArm() {
      return scriptedExperiment('aic-117-two-arm-control', perfect);
    },
    async runModelArm() {
      return scriptedExperiment('aic-117-two-arm-model', perfect);
    },
  });

  assert.deepEqual(Object.keys(report.arms).sort(), ['control', 'model', 'naive', 'oracle']);
  assert.deepEqual(report.arms.oracle, {
    arm: 'oracle',
    status: 'not-run',
    reason: 'the caller supplied no oracle arm',
  });
  assert.deepEqual(report.arms.naive, {
    arm: 'naive',
    status: 'not-run',
    reason: 'the caller supplied no naive arm',
  });
  assert.equal('metrics' in report.arms.oracle, false, 'an arm the caller did not supply carries no metrics key at all');
  assert.equal('metrics' in report.arms.naive, false);

  assert.deepEqual(
    Object.keys(report.arms.control).sort(),
    ['arm', 'metrics', 'movedMetrics', 'observedBaseline', 'predictionGapCounts', 'status'],
    'the control arm keeps its existing fields and gains status and the prediction-gap counts (AIC-119 slice 4, a diagnostic, not a metric)',
  );
  assert.equal(
    report.arms.control.status,
    'completed',
    'the control arm never carries a refused state: a throwing control aborts the lane rather than being reported as one',
  );
  assert.deepEqual(
    Object.keys(report.arms.model).sort(),
    ['arm', 'metrics', 'model', 'predictionGapCounts', 'reportable', 'status'],
    'the model arm keeps every existing field and gains status, model and the prediction-gap counts (AIC-119 slice 4, a diagnostic, not a metric)',
  );
  assert.equal(report.arms.model.status, 'completed');
});

test('refuses a non-function runOracleArm before any arm runs', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const touched = [];

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          runOracleArm: 'not a function',
          async runControlArm() {
            touched.push('control');
            return scriptedExperiment('unreached', perfect);
          },
          async runNaiveArm() {
            touched.push('naive');
            return scriptedExperiment('unreached', perfect);
          },
          async runModelArm() {
            touched.push('model');
            return scriptedExperiment('unreached', perfect);
          },
        }),
      ),
    /runOracleArm/,
  );
  assert.deepEqual(touched, [], 'a malformed option must cost no arm, exactly as an unconfigured credential does');
});

test('refuses a non-function runNaiveArm before control runs', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const touched = [];

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          runNaiveArm: 'not a function',
          async runControlArm() {
            touched.push('control');
            return scriptedExperiment('unreached', perfect);
          },
          async runOracleArm() {
            touched.push('oracle');
            return scriptedExperiment('unreached', perfect);
          },
          async runModelArm() {
            touched.push('model');
            return scriptedExperiment('unreached', perfect);
          },
        }),
      ),
    /runNaiveArm/,
  );
  assert.deepEqual(touched, []);
});

test('runs control, then oracle, then naive, then model, all over the same plan', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const order = [];
  const plans = [];

  await runLiveModelLane(
    fourArmLaneOptions({
      async runControlArm(plan) {
        order.push('control');
        plans.push(plan);
        return scriptedExperiment('order-control', perfect);
      },
      async runOracleArm(plan) {
        order.push('oracle');
        plans.push(plan);
        return scriptedExperiment('order-oracle', perfect);
      },
      async runNaiveArm(plan) {
        order.push('naive');
        plans.push(plan);
        return scriptedExperiment('order-naive', perfect);
      },
      async runModelArm(plan) {
        order.push('model');
        plans.push(plan);
        return scriptedExperiment('order-model', perfect);
      },
    }),
  );

  assert.deepEqual(order, ['control', 'oracle', 'naive', 'model']);
  for (const plan of plans) assert.deepEqual(plan, plans[0]);
});

test('throws when the oracle arm throws, and never invokes naive or model', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const touched = [];

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runOracleArm() {
            throw new Error('oracle harness is broken');
          },
          async runNaiveArm() {
            touched.push('naive');
            return scriptedExperiment('unreached', perfect);
          },
          async runModelArm() {
            touched.push('model');
            return scriptedExperiment('unreached', perfect);
          },
        }),
      ),
    /oracle harness is broken/,
  );
  assert.deepEqual(
    touched,
    [],
    'a positive control that cannot run is a harness defect: the paid arms must never spend on top of it',
  );
});

test('reports a completed oracle arm with its metrics', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(fourArmLaneOptions());

  assert.equal(report.arms.oracle.arm, 'oracle');
  assert.equal(report.arms.oracle.status, 'completed');
  assert.deepEqual(
    Object.keys(report.arms.oracle.metrics).sort(),
    ['termination_correctness', 'unsupported_claim_rate'],
  );
});

test('catches a naive-arm throw like the model arm and caps refusalReason at 400 characters, while the model arm still runs', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const longMessage = 'x'.repeat(500);
  let modelRan = false;

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runNaiveArm() {
        throw new Error(longMessage);
      },
      async runModelArm() {
        modelRan = true;
        return scriptedExperiment('naive-throw-model', perfect);
      },
    }),
  );

  assert.equal(report.arms.naive.status, 'refused');
  assert.equal(report.arms.naive.reportable, false);
  assert.equal(report.arms.naive.refusalReason.length, 401, '400 characters plus the ellipsis');
  assert.equal(report.arms.naive.refusalReason.endsWith('…'), true);
  assert.equal(report.arms.naive.refusalReason.slice(0, 400), longMessage.slice(0, 400));
  assert.equal('metrics' in report.arms.naive, false, 'a refused arm produced no score');
  assert.equal(modelRan, true, 'a naive-arm refusal must not stop the model arm from running');
  assert.equal(report.arms.model.status, 'completed');
});

test('applies the same reportable rules to a completed naive arm as to the model arm', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const undeclared = await runLiveModelLane(fourArmLaneOptions({ controlBaseline: undefined }));
  assert.equal(undeclared.arms.naive.reportable, false);
  assert.match(undeclared.arms.naive.unreportableReason, /baseline/i);

  const moved = await runLiveModelLane(
    fourArmLaneOptions({
      async runControlArm() {
        return scriptedExperiment('naive-reportable-moved-control', (key, record) =>
          key === 'termination_correctness' && record.exampleId.startsWith('0')
            ? 0
            : perfect(key));
      },
    }),
  );
  assert.equal(moved.arms.naive.reportable, false);
  assert.match(moved.arms.naive.unreportableReason, /harness/i);

  const ok = await runLiveModelLane(fourArmLaneOptions());
  assert.equal(ok.arms.naive.reportable, true);
  assert.equal('unreportableReason' in ok.arms.naive, false);
});

test('refuses when the oracle arm does not cover the declared plan', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runOracleArm() {
            const experiment = scriptedExperiment('oracle-mismatch', perfect);
            return {
              ...experiment,
              records: experiment.records.slice(0, -1),
              results: experiment.results.slice(0, -1),
            };
          },
        }),
      ),
    (error) => {
      assert.match(error.message, /oracle/i);
      return true;
    },
  );
});

test('refuses when the naive arm does not cover the declared plan', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runNaiveArm() {
            const experiment = scriptedExperiment('naive-mismatch', perfect);
            return {
              ...experiment,
              records: experiment.records.slice(0, -1),
              results: experiment.results.slice(0, -1),
            };
          },
        }),
      ),
    (error) => {
      assert.match(error.message, /naive/i);
      return true;
    },
  );
});

test('gives the model arm a status field alongside its existing fields, for both a completion and a throw', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const completed = await runLiveModelLane(fourArmLaneOptions());
  assert.equal(completed.arms.model.status, 'completed');

  const refused = await runLiveModelLane(
    fourArmLaneOptions({
      async runModelArm() {
        throw new Error('model refused');
      },
    }),
  );
  assert.equal(refused.arms.model.status, 'refused');
});

test('a refused model arm carries no predictionGapCounts, exactly as it carries no metrics', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const refused = await runLiveModelLane(
    fourArmLaneOptions({
      async runModelArm() {
        throw new Error('model refused');
      },
    }),
  );

  assert.equal(refused.arms.model.status, 'refused');
  assert.equal('metrics' in refused.arms.model, false);
  assert.equal('predictionGapCounts' in refused.arms.model, false, 'a refused arm produced no results to count');
});

/* -------------------------------------------------------------------------- */
/* 3. per-arm usage from one ledger reader                                    */
/* -------------------------------------------------------------------------- */

function usageCounter() {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  return {
    read: () => ({ calls, inputTokens, outputTokens }),
    advance(delta) {
      calls += delta.calls;
      inputTokens += delta.inputTokens;
      outputTokens += delta.outputTokens;
    },
  };
}

test("reports the naive and model arms' usage as the delta over each arm's own execution, never cumulative", async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const counter = usageCounter();
  // The ledger has already spent before the lane starts, so neither arm's
  // figures can equal the cumulative reading.
  counter.advance({ calls: 3, inputTokens: 700, outputTokens: 60 });
  const naiveDelta = { calls: 2, inputTokens: 100, outputTokens: 20 };
  const modelDelta = { calls: 5, inputTokens: 300, outputTokens: 90 };

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      modelUsage: counter.read,
      async runNaiveArm() {
        counter.advance(naiveDelta);
        return scriptedExperiment('usage-naive', perfect);
      },
      async runModelArm() {
        counter.advance(modelDelta);
        return scriptedExperiment('usage-model', perfect);
      },
    }),
  );

  assert.deepEqual(report.arms.naive.usage, naiveDelta);
  assert.deepEqual(report.arms.model.usage, modelDelta);
  assert.equal('usage' in report.arms.control, false, 'the scripted control arm consumed no model');
  assert.equal('usage' in report.arms.oracle, false, 'the oracle arm consumed no model');
});

test("keeps a naive arm's usage delta even when it refuses after spending", async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const counter = usageCounter();
  const naiveDelta = { calls: 1, inputTokens: 40, outputTokens: 5 };

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      modelUsage: counter.read,
      async runNaiveArm() {
        counter.advance(naiveDelta);
        throw new Error('the naive role produced no parseable answer');
      },
    }),
  );

  assert.equal(report.arms.naive.status, 'refused');
  assert.deepEqual(report.arms.naive.usage, naiveDelta, 'a refused arm still spent what it spent before refusing');
});

test('carries no usage key on any arm when modelUsage is not supplied', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(fourArmLaneOptions());

  for (const arm of ['control', 'oracle', 'naive', 'model']) {
    assert.equal('usage' in report.arms[arm], false, `${arm} must carry no usage key when no ledger reader was declared`);
  }
});

test("carries the credential's provider and model on both the naive and the model arm", async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const env = { [MODEL_API_KEY_VARIABLE]: fakeApiKey() };
  const config = requireModelConfig(env);

  const report = await runLiveModelLane(fourArmLaneOptions({ env }));

  assert.deepEqual(report.arms.naive.model, { provider: config.provider, modelId: config.modelId });
  assert.deepEqual(report.arms.model.model, { provider: config.provider, modelId: config.modelId });
});

/* -------------------------------------------------------------------------- */
/* 4. per-scenario, per-run metrics; claimCount                               */
/* -------------------------------------------------------------------------- */

test('adds perScenario run-ordered scores and the per-run mean to every metric entry', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const runScores = [0, 0.5, 1];

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      async runModelArm() {
        return scriptedExperiment(
          'perscenario-model',
          (key, _record, runIndex) => (key === 'termination_correctness' ? runScores[runIndex] : perfect(key)),
          { scenarioSet: 'calibration', runsPerScenario: 3 },
        );
      },
    }),
  );

  const scenarioId = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration[0];
  const entry = report.arms.model.metrics.termination_correctness.perScenario[scenarioId];
  assert.deepEqual(entry.scores, runScores, 'scores are carried in run order');
  assert.equal(entry.mean, 0.5, '(0 + 0.5 + 1) / 3');
});

test('evaluateUnsupportedClaimRate reports how many claims it counted', () => {
  const claims = [{ evidenceIds: ['e1'] }, { evidenceIds: [] }, { evidenceIds: ['e2'] }];

  const result = evals.evaluateUnsupportedClaimRate({ claims, supportingEvidenceIds: ['e1', 'e2'] });

  assert.equal(result.key, 'unsupported_claim_rate');
  assert.equal(result.claimCount, claims.length);
});

test('evaluateBenchmarkRecord carries claimCount on the unsupported_claim_rate metric', () => {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'aic-117-claimcount-record',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  const claims = [{ evidenceIds: ['supporting-evidence'] }, { evidenceIds: [] }];
  const outcome = { ...perfectOutcomeFor(record.scenario), claims };

  const result = evals.evaluateBenchmarkRecord({ record, outcome });

  assert.equal(result.metrics.unsupported_claim_rate.claimCount, claims.length);
});

test('sums claimCount over runs on the arm metric and carries claimCounts per scenario', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const claimCounts = [1, 2, 3];

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      async runModelArm() {
        return scriptedExperiment('claimcount-lane-model', perfect, {
          scenarioSet: 'calibration',
          runsPerScenario: 3,
          claimCountFor: (_record, runIndex) => claimCounts[runIndex],
        });
      },
    }),
  );

  const scenarioCount = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.length;
  const claimCountsSum = claimCounts.reduce((sum, count) => sum + count, 0);
  const metric = report.arms.model.metrics.unsupported_claim_rate;

  assert.equal(metric.claimCount, claimCountsSum * scenarioCount, 'the same per-run counts repeat on every scenario');

  const scenarioId = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration[0];
  assert.deepEqual(metric.perScenario[scenarioId].claimCounts, claimCounts);
});

/**
 * Partial instrumentation publishes neither a misleading sum nor a
 * per-scenario array shorter than its scores: one run of one scenario lacks
 * `claimCount`, which must drop the claim counts for the WHOLE metric, not
 * just that one scenario.
 */
test('publishes no claimCount and no claimCounts anywhere when one result of the arm lacks it', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      async runModelArm() {
        return scriptedExperiment('claimcount-partial-model', perfect, {
          scenarioSet: 'calibration',
          runsPerScenario: 3,
          claimCountFor: (_record, runIndex) => (runIndex === 0 ? undefined : 3),
        });
      },
    }),
  );

  const metric = report.arms.model.metrics.unsupported_claim_rate;
  assert.equal(
    'claimCount' in metric,
    false,
    'a metric with one uninstrumented run must publish no summed claimCount',
  );
  for (const [scenarioId, scenarioMetric] of Object.entries(metric.perScenario)) {
    assert.equal(
      'claimCounts' in scenarioMetric,
      false,
      `scenario ${scenarioId} must carry no claimCounts either: partial instrumentation on the metric withholds it everywhere, not only on the run that lacked it`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 5. notApplicable lifted to the arm                                         */
/* -------------------------------------------------------------------------- */

const CONSTANT_NOT_APPLICABLE = Object.freeze({
  challenge_effect: 'not applicable: a single-shot arm runs no challenge round to compare a leader across',
});

test('lifts a consistent notApplicable map from every result of an arm onto the arm itself', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runNaiveArm() {
        return scriptedExperiment('notapplicable-naive', perfect, {
          notApplicableFor: () => CONSTANT_NOT_APPLICABLE,
        });
      },
    }),
  );

  assert.deepEqual(report.arms.naive.notApplicable, CONSTANT_NOT_APPLICABLE);
});

test('lifts a consistent notApplicable map from every result of the model arm onto the arm itself', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runModelArm() {
        return scriptedExperiment('notapplicable-model', perfect, {
          notApplicableFor: () => CONSTANT_NOT_APPLICABLE,
        });
      },
    }),
  );

  assert.deepEqual(report.arms.model.notApplicable, CONSTANT_NOT_APPLICABLE);
});

test('lifts a consistent notApplicable map from every result of the oracle arm onto the arm itself', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runOracleArm() {
        return scriptedExperiment('notapplicable-oracle', perfect, {
          notApplicableFor: () => CONSTANT_NOT_APPLICABLE,
        });
      },
    }),
  );

  assert.deepEqual(report.arms.oracle.notApplicable, CONSTANT_NOT_APPLICABLE);
});

test('carries no notApplicable key on an arm whose results carried none', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(fourArmLaneOptions());

  assert.equal('notApplicable' in report.arms.model, false);
  assert.equal('notApplicable' in report.arms.naive, false);
});

test('refuses an arm whose results disagree about notApplicable, naming the arm', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runNaiveArm() {
            return scriptedExperiment('notapplicable-inconsistent-naive', perfect, {
              notApplicableFor: (_record, runIndex) => (runIndex === 0 ? CONSTANT_NOT_APPLICABLE : undefined),
            });
          },
        }),
      ),
    (error) => {
      assert.match(error.message, /naive/i);
      return true;
    },
  );
});

/**
 * The mirror of `live-model-lane.test.mjs` › "judges the declared baseline
 * before the paid arm runs, so a bad declaration costs no model call": an
 * oracle whose own results disagree about notApplicable is a harness defect
 * discoverable from the oracle's own experiment alone, so it must be refused
 * before either paid arm — naive or model — ever runs, exactly as an
 * unconfigured credential or a malformed optional-arm option costs no arm.
 */
test('rejects before any paid arm runs when the oracle arms own results disagree about notApplicable', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const touched = [];

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runOracleArm() {
            return scriptedExperiment('notapplicable-inconsistent-oracle', perfect, {
              notApplicableFor: (_record, runIndex) => (runIndex === 0 ? CONSTANT_NOT_APPLICABLE : undefined),
            });
          },
          async runNaiveArm() {
            touched.push('naive');
            return scriptedExperiment('unreached', perfect);
          },
          async runModelArm() {
            touched.push('model');
            return scriptedExperiment('unreached', perfect);
          },
        }),
      ),
    (error) => {
      assert.match(error.message, /oracle/i);
      return true;
    },
  );

  assert.deepEqual(
    touched,
    [],
    'a self-inconsistent oracle is free to detect from the oracle experiment alone; neither paid arm may spend on top of it',
  );
});

/**
 * The naive arm's own inconsistency is likewise free to see the moment its
 * experiment returns — before the model arm, the one arm this whole lane
 * exists to bound, is ever reached.
 */
test('rejects before the model arm runs when the naive arms own results disagree about notApplicable', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  let modelRan = false;

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runNaiveArm() {
            return scriptedExperiment('notapplicable-inconsistent-naive-precheck', perfect, {
              notApplicableFor: (_record, runIndex) => (runIndex === 0 ? CONSTANT_NOT_APPLICABLE : undefined),
            });
          },
          async runModelArm() {
            modelRan = true;
            return scriptedExperiment('unreached', perfect);
          },
        }),
      ),
    (error) => {
      assert.match(error.message, /naive/i);
      return true;
    },
  );

  assert.equal(
    modelRan,
    false,
    'a naive arm whose own results disagree is a harness defect visible for free; the model arm must never spend on top of it',
  );
});

test('rejects a control arm that missed the declared plan before any paid arm runs', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const paid = [];

  await assert.rejects(
    () =>
      runLiveModelLane(
        fourArmLaneOptions({
          async runControlArm() {
            const experiment = scriptedExperiment('control-short-of-plan', perfect);
            return {
              ...experiment,
              records: experiment.records.slice(0, -1),
              results: experiment.results.slice(0, -1),
            };
          },
          async runNaiveArm() {
            paid.push('naive');
            return scriptedExperiment('unreached', perfect);
          },
          async runModelArm() {
            paid.push('model');
            return scriptedExperiment('unreached', perfect);
          },
        }),
      ),
    /control arm must cover the declared plan/,
  );

  assert.deepEqual(paid, [], 'a control arm short of the plan is visible for free; no paid arm may spend on top of it');
});

test("never lets a withheld metric appear in an arm's notApplicable, even when a result declared it", async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const declared = Object.freeze({
    evidence_coverage: 'declared not applicable by the fake naive arm',
    challenge_effect: 'not applicable: no challenge round in a single prompt',
  });

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runNaiveArm() {
        return scriptedExperiment('withheld-beats-notapplicable-naive', perfect, {
          notApplicableFor: () => declared,
        });
      },
    }),
  );

  assert.equal('evidence_coverage' in report.arms.naive.notApplicable, false, 'withheld is the lane-level statement and takes precedence');
  assert.deepEqual(report.arms.naive.notApplicable, {
    challenge_effect: 'not applicable: no challenge round in a single prompt',
  });
  assert.equal('evidence_coverage' in report.arms.naive.metrics, false);
});

/* -------------------------------------------------------------------------- */
/* 6. withheld depends on the declared evaluator version                      */
/* -------------------------------------------------------------------------- */

test('withholds evidence_coverage under behavior-evaluators-v0.2 and reports it on no arm', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(fourArmLaneOptions());

  assert.deepEqual(report.withheld, evals.LIVE_MODEL_LANE_WITHHELD_METRICS);
  for (const arm of ['control', 'oracle', 'naive', 'model']) {
    assert.equal('evidence_coverage' in report.arms[arm].metrics, false, `${arm} must not carry the withheld metric`);
  }
});

test('reports evidence_coverage under behavior-evaluators-v0.3, with withheld empty', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const structuralMetadata = { ...benchmarkVersions, evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION };

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      metadata: structuralMetadata,
      controlBaseline: {
        unsupported_claim_rate: 0,
        evidence_coverage: 1,
        termination_correctness: 1,
      },
    }),
  );

  assert.deepEqual(report.withheld, {});
  for (const arm of ['control', 'oracle', 'naive', 'model']) {
    assert.equal('evidence_coverage' in report.arms[arm].metrics, true, `${arm} must carry evidence_coverage once it is not withheld`);
  }
});

/* -------------------------------------------------------------------------- */
/* 7. comparability via the oracle                                            */
/* -------------------------------------------------------------------------- */

test('reports comparability for every oracle metric, and marks a metric off best as not comparable', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runOracleArm() {
        return scriptedExperiment(
          'comparability-oracle',
          (key) => (key === 'unsupported_claim_rate' ? 0.5 : perfect(key)),
        );
      },
    }),
  );

  assert.deepEqual(report.comparability, {
    unsupported_claim_rate: { best: 0, oracleMean: 0.5, comparable: false },
    termination_correctness: { best: 1, oracleMean: 1, comparable: true },
  });
});

test('carries no comparability key when the oracle did not run', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'final-evaluation',
    experimentId: 'aic-117-no-oracle',
    headSha: HEAD_SHA,
    metadata: benchmarkVersions,
    controlBaseline: { unsupported_claim_rate: 0, termination_correctness: 1 },
    async runControlArm() {
      return scriptedExperiment('no-oracle-control', perfect);
    },
    async runModelArm() {
      return scriptedExperiment('no-oracle-model', perfect);
    },
  });

  assert.equal('comparability' in report, false);
});

/* -------------------------------------------------------------------------- */
/* 8. graph vs naive, win/tie/loss                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately ASYMMETRIC on both metrics, so that swapping which arm counts
 * as closer to best (a comparison inverted end to end) would move the win and
 * loss counts apart rather than leaving them equal — a 1-win/1-loss fixture
 * stays green under either direction, which is why the counts below differ.
 *
 * termination_correctness (best = 1), by scenario:
 *   TERMINATION_WIN_SCENARIOS (2 scenarios) — model at best (distance 0),
 *     naive off it (distance 1) => win, twice.
 *   TERMINATION_LOSS_SCENARIO — model off best (distance 1), naive at best
 *     (distance 0) => loss, once.
 *   TERMINATION_TIE_SCENARIO — both at 0.5 (distance 0.5 each) => tie.
 *   the remaining 4 scenarios — both at 1 (distance 0) => tie.
 *   Hand count over the 8 calibration scenarios: { win: 2, tie: 5, loss: 1 }.
 *
 * unsupported_claim_rate (best = 0), by a DIFFERENT set of scenarios so this
 * metric's direction is pinned independently of the one above:
 *   CLAIM_RATE_WIN_SCENARIOS (2 scenarios) — model at best (distance 0),
 *     naive off it (distance 1) => win, twice.
 *   CLAIM_RATE_LOSS_SCENARIO — model off best (distance 1), naive at best
 *     (distance 0) => loss, once.
 *   the remaining 5 scenarios — both at 0 (distance 0) => tie.
 *   Hand count over the 8 calibration scenarios: { win: 2, tie: 5, loss: 1 }.
 *
 * The oracle and the control are perfect throughout (the `perfect` helper
 * `fourArmLaneOptions` already defaults both arms to), so every metric is
 * comparable and the declared baseline holds.
 */
const TERMINATION_WIN_SCENARIOS = ['bad-deployment', 'db-pool-exhaustion'];
const TERMINATION_LOSS_SCENARIO = 'false-alert';
const TERMINATION_TIE_SCENARIO = 'deployment-caused-incident-a';

const CLAIM_RATE_WIN_SCENARIOS = ['multiple-plausible-causes', 'transient-self-resolved'];
const CLAIM_RATE_LOSS_SCENARIO = 'challenge-keeps-leader';

function graphVsNaiveScoreFor(role) {
  return (key, record) => {
    const id = record.scenario.id;
    if (key === 'unsupported_claim_rate') {
      if (CLAIM_RATE_WIN_SCENARIOS.includes(id)) return role === 'model' ? 0 : 1;
      if (id === CLAIM_RATE_LOSS_SCENARIO) return role === 'model' ? 1 : 0;
      return 0;
    }
    if (key !== 'termination_correctness') return 1;
    if (TERMINATION_WIN_SCENARIOS.includes(id)) return role === 'model' ? 1 : 0;
    if (id === TERMINATION_LOSS_SCENARIO) return role === 'model' ? 0 : 1;
    if (id === TERMINATION_TIE_SCENARIO) return 0.5;
    return 1;
  };
}

test('counts win, tie and loss per metric between the graph and the naive arm, against the oracle', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      async runNaiveArm() {
        return scriptedExperiment('graphvsnaive-naive', graphVsNaiveScoreFor('naive'), {
          scenarioSet: 'calibration',
          runsPerScenario: 3,
        });
      },
      async runModelArm() {
        return scriptedExperiment('graphvsnaive-model', graphVsNaiveScoreFor('model'), {
          scenarioSet: 'calibration',
          runsPerScenario: 3,
        });
      },
    }),
  );

  assert.deepEqual(Object.keys(report.graphVsNaive).sort(), ['termination_correctness', 'unsupported_claim_rate']);
  assert.deepEqual(report.graphVsNaive.unsupported_claim_rate, { win: 2, tie: 5, loss: 1 });
  assert.deepEqual(report.graphVsNaive.termination_correctness, { win: 2, tie: 5, loss: 1 });
});

/**
 * A metric the oracle misses best on is excluded from graphVsNaive entirely
 * (`comparability[key].comparable === false`), while a metric it does reach
 * best on stays — so the exclusion is per-metric, not a lane-wide effect of
 * one bad oracle axis.
 */
test('excludes a metric the oracle misses best on from graphVsNaive, while a metric it reaches best on stays', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      async runOracleArm() {
        return scriptedExperiment(
          'oracle-gate-oracle',
          (key) => (key === 'termination_correctness' ? 0.5 : perfect(key)),
        );
      },
    }),
  );

  assert.deepEqual(report.comparability.termination_correctness, {
    best: 1,
    oracleMean: 0.5,
    comparable: false,
  });
  assert.equal(
    'termination_correctness' in report.graphVsNaive,
    false,
    'a metric the oracle misses best on is not comparable, so the graph and naive arms are never compared on it',
  );
  assert.ok(
    report.graphVsNaive.unsupported_claim_rate,
    'a metric the oracle DOES reach best on must stay in the comparison',
  );
});

/**
 * `challenge_effect` is never compared between the graph and the naive arm:
 * the naive arm marks it not applicable, so it is never computed for that arm
 * and there is no naive score to compare.
 * see naive-arm.test.mjs › "challenge_effect is never computed for a naive result, and every result carries notApplicable equal to NAIVE_NOT_APPLICABLE"
 *
 * The naive arm here is the REAL `runNaiveBenchmarkExperiment`, driven over
 * the calibration plan, rather than the fixture's `scriptedExperiment` — the
 * `notApplicable` map under test is the naive runner's own, not one this file
 * injects.
 */
test('never compares challenge_effect between the graph and the naive arm, because the naive arm marks it not-applicable', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');
  const CHALLENGE_SCENARIO_ID = 'challenge-keeps-leader';
  const DEFAULT_NAIVE_ANSWER = Object.freeze({
    hypotheses: Object.freeze([]),
    assessments: Object.freeze([]),
    conclusion: Object.freeze({ kind: 'inconclusive', causes: Object.freeze([]) }),
    stopKind: 'stalled',
  });

  function challengeEffectExperiment(experimentId, plan) {
    const records = planFor(plan.scenarioSet, {
      experimentId,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
    });
    const results = records.map((record) => ({
      experimentId: record.experimentId,
      exampleId: record.exampleId,
      runId: record.runId,
      actualStopKind: 'sufficient',
      metrics: {
        unsupported_claim_rate: { key: 'unsupported_claim_rate', score: 0 },
        termination_correctness: { key: 'termination_correctness', score: 1 },
      },
      behaviorMetrics:
        record.scenario.id === CHALLENGE_SCENARIO_ID
          ? { challenge_effect: { key: 'challenge_effect', score: 1 } }
          : {},
    }));
    return { records, results, stopKindDistribution: { sufficient: results.length } };
  }

  const report = await runLiveModelLane(
    fourArmLaneOptions({
      scenarioSet: 'calibration',
      runsPerScenario: 3,
      async runOracleArm(plan) {
        return challengeEffectExperiment('challenge-effect-oracle', plan);
      },
      async runNaiveArm(plan) {
        return evals.runNaiveBenchmarkExperiment({
          experimentId: 'challenge-effect-naive',
          scenarioSet: plan.scenarioSet,
          runsPerScenario: plan.runsPerScenario,
          metadata: plan.metadata,
          async investigate() {
            return DEFAULT_NAIVE_ANSWER;
          },
          async recordEvaluation() {},
        });
      },
      async runModelArm(plan) {
        return challengeEffectExperiment('challenge-effect-model', plan);
      },
    }),
  );

  assert.deepEqual(report.arms.naive.notApplicable, evals.NAIVE_NOT_APPLICABLE);
  assert.ok(
    report.comparability.challenge_effect,
    'the oracle must reach challenge_effect for this row to test anything: without a comparability entry the exclusion below would be vacuous',
  );
  assert.equal(report.comparability.challenge_effect.comparable, true);
  assert.equal(
    'challenge_effect' in report.graphVsNaive,
    false,
    "challenge_effect is never compared: the naive arm's own notApplicable excludes it before the metric is ever read",
  );
});

/**
 * The mirror of the "still returns not-run oracle and naive arms" row: here
 * naive AND model both complete, and only the oracle is missing — so
 * `comparability` and `graphVsNaive` are absent for the same reason
 * (`comparability` requires the oracle; `graphVsNaive` requires all three),
 * not because either paid arm failed to run.
 */
test('carries no comparability or graphVsNaive key when the oracle did not run, even though naive and model both completed', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const { runOracleArm: _omitted, ...withoutOracle } = fourArmLaneOptions();
  const report = await runLiveModelLane(withoutOracle);

  assert.equal(report.arms.oracle.status, 'not-run');
  assert.equal(report.arms.naive.status, 'completed');
  assert.equal(report.arms.model.status, 'completed');
  assert.equal('comparability' in report, false);
  assert.equal('graphVsNaive' in report, false);
});

test('carries no graphVsNaive key when the naive arm did not run', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const { runNaiveArm: _omitted, ...withoutNaive } = fourArmLaneOptions();
  const report = await runLiveModelLane(withoutNaive);

  assert.equal(report.arms.naive.status, 'not-run');
  assert.equal(report.arms.oracle.status, 'completed', 'only the naive arm is missing here');
  assert.equal('graphVsNaive' in report, false);
});

/* -------------------------------------------------------------------------- */
/* 9. call cap derived from the budget policy and the partition lengths       */
/* -------------------------------------------------------------------------- */

/**
 * The graph arm's per-run budget re-enters a model-backed role TWICE per
 * challenge round, not once: a challenge round is
 * `challenge_hypothesis => execute_investigation => evaluate_predictions =>
 * interpret_residual_evidence`, and both `challenge_hypothesis` and
 * `interpret_residual_evidence` are model-backed roles. So the reserved
 * challenge headroom is spent at 2 model calls per round, not 1.
 *
 * AIC-119 slice E: `propose_conclusion` is reached exactly once per run — at
 * termination, once per terminal, never per iteration or per challenge round
 * — so the derivation gains a bare `+ 1`, independent of every other term
 * here. The `+ 1` is an independent literal, not a read of
 * `LIVE_MODEL_LANE_GRAPH_MODEL_CALLS_PER_RUN` itself.
 */
test('derives the per-run and total model-call caps from the budget policy and the partition lengths', () => {
  const graphPerRun = requireExport('LIVE_MODEL_LANE_GRAPH_MODEL_CALLS_PER_RUN');
  const naivePerRun = requireExport('LIVE_MODEL_LANE_NAIVE_MODEL_CALLS_PER_RUN');
  const maxRuns = requireExport('LIVE_MODEL_LANE_MAX_MODEL_RUNS');
  const maxCalls = requireExport('LIVE_MODEL_LANE_MAX_MODEL_CALLS');

  assert.equal(
    graphPerRun,
    1 +
      evals.BENCHMARK_BUDGET_POLICY.maxIterations +
      2 * evals.BENCHMARK_BUDGET_POLICY.reservedChallengeBudget +
      1,
    'one generate_hypotheses, plus the iteration headroom, plus TWO model-backed roles per reserved challenge round, plus ONE propose_conclusion at termination',
  );
  assert.equal(naivePerRun, 1);
  assert.equal(
    maxRuns,
    (evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.length + evals.BENCHMARK_SCENARIO_PARTITIONS.holdout.length) * 3,
  );
  assert.equal(maxCalls, maxRuns * (graphPerRun + naivePerRun));
});

test('publishes the per-run call caps in the report alongside the existing bounds', async () => {
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(fourArmLaneOptions());

  assert.equal(report.caps.graphModelCallsPerRun, requireExport('LIVE_MODEL_LANE_GRAPH_MODEL_CALLS_PER_RUN'));
  assert.equal(report.caps.naiveModelCallsPerRun, requireExport('LIVE_MODEL_LANE_NAIVE_MODEL_CALLS_PER_RUN'));
});

/* -------------------------------------------------------------------------- */
/* 10. the output-token ceiling                                               */
/* -------------------------------------------------------------------------- */

test('sets the output-token ceiling at the raised bound (owner decision 2026-09-24)', () => {
  assert.equal(requireExport('LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS'), 1_200_000);
});

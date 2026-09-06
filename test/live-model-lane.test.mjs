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
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import { MissingModelCredentialError, MODEL_API_KEY_VARIABLE } from '@aic/roles';

import {
  benchmarkVersions,
  replayBackedNodes,
} from './fixtures/benchmark-experiment.mjs';
import { childEnv } from './fixtures/child-env.mjs';
// Imported rather than described: the two arms are compared as objects below, and
// a comparison that read this file's source instead would be a paraphrase of the
// command rather than the command. The import is only possible because the
// command runs its lane behind an entry-point guard — the row that pins the
// guard is the last one in this file.
import { modelNodes, scriptedNodes } from '../scripts/eval-live-model.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requireExport(name) {
  assert.ok(evals[name] !== undefined, `@aic/evals must export ${name}`);
  return evals[name];
}

const HEAD_SHA = 'a'.repeat(40);

function fakeApiKey() {
  return ['sk', 'ant', 'test', '0'.repeat(24)].join('-');
}

/** The same shape with one control character spliced inside it: a key copied out of a wrapped terminal. */
function fakeApiKeyCarrying(controlCharacter) {
  const key = fakeApiKey();
  const middle = Math.floor(key.length / 2);
  return `${key.slice(0, middle)}${controlCharacter}${key.slice(middle)}`;
}

/**
 * A scripted experiment over the real final-evaluation plan.
 *
 * The plan comes from `createFinalEvaluationBenchmarkPlan`, so the hold-out
 * policy is the one already accepted in `BENCHMARK_SCENARIO_PARTITIONS` and this
 * lane never builds a second partition.
 */
function scriptedExperiment(experimentId, scoreFor, { omitMetrics = [] } = {}) {
  const records = evals.createFinalEvaluationBenchmarkPlan({
    experimentId,
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  const omitted = new Set(omitMetrics);
  const results = records.map((record) => {
    const metrics = {};
    for (const key of [
      'unsupported_claim_rate',
      'evidence_coverage',
      'termination_correctness',
    ]) {
      // An arm that STOPS emitting a metric is the shape the lane has to treat
      // as a move rather than as a match, so the fixture has to be able to
      // produce it.
      if (omitted.has(key)) continue;
      metrics[key] = { key, score: scoreFor(key, record) };
    }
    return {
      experimentId: record.experimentId,
      exampleId: record.exampleId,
      runId: record.runId,
      actualStopKind: 'sufficient',
      metrics,
      behaviorMetrics: {},
    };
  });
  return { records, results, stopKindDistribution: { sufficient: results.length } };
}

const perfect = (key) => (key === 'unsupported_claim_rate' ? 0 : 1);

function laneOptions(overrides = {}) {
  return {
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    experimentId: 'aic-94-live-model',
    headSha: HEAD_SHA,
    metadata: benchmarkVersions,
    // `evidence_coverage` is deliberately absent: the lane withholds it, so a
    // baseline pinning it would pin a number nothing ever compares — which the
    // lane now refuses by name rather than ignoring.
    controlBaseline: {
      unsupported_claim_rate: 0,
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

test('reports a moved control arm as a harness regression and marks the model numbers unreportable', async () => {
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

test('treats a declared control metric the arm stopped emitting as a move, not as a match', async () => {
  // The cheapest way past a comparison is to stop emitting the metric, so that
  // absence reads as "not applicable" and the moved value leaves the comparison
  // entirely. `benchmark-regression-gate.ts` refuses exactly this for behavior
  // metrics — AIC-81 made it a refusal rather than a skip — and the first
  // version of THIS lane reintroduced the skip one ticket later, because it
  // compared only the keys the control arm happened to produce.
  //
  // `code-reviewer` measured it: a control arm that dropped a declared metric
  // returned verdict 'model-quality' with movedMetrics [] and reportable true —
  // a harness regression published as model quality, which is the one thing
  // this lane exists to make impossible.
  const runLiveModelLane = requireExport('runLiveModelLane');

  const report = await runLiveModelLane(
    laneOptions({
      async runControlArm() {
        return scriptedExperiment(
          'aic-94-live-model-control',
          (key) => perfect(key),
          { omitMetrics: ['termination_correctness'] },
        );
      },
    }),
  );

  assert.equal(
    report.verdict,
    'harness-regression',
    'a metric the baseline declares and the control arm no longer emits is a move',
  );
  assert.equal(report.arms.model.reportable, false);
  assert.ok(
    report.arms.control.movedMetrics.includes('termination_correctness'),
    'the report must name the metric that vanished, not merely refuse',
  );
});

test('refuses a control baseline naming a metric this lane does not compare', async () => {
  // The mirror of the row above: a typo or a renamed metric in the declared
  // baseline used to be ignored, so a baseline that pinned nothing read as a
  // baseline that was met.
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () =>
      runLiveModelLane(
        laneOptions({
          controlBaseline: {
            unsupported_claim_rate: 1,
            not_a_metric_this_lane_knows: 1,
          },
        }),
      ),
    /not_a_metric_this_lane_knows/,
    'an undeclared key in the control baseline must be refused by name',
  );
});

test('refuses a control baseline naming a metric this lane withholds', async () => {
  // The other half of the refusal, and the one that had no row: `code-reviewer`
  // measured that deleting the withheld clause left the whole suite green,
  // because the unknown-key row is caught by the spelling check alone. A
  // withheld key is worse than a typo — the name is a real metric, so a reader
  // of the baseline file has every reason to think it is being compared, and it
  // can never reach the comparison.
  const runLiveModelLane = requireExport('runLiveModelLane');

  await assert.rejects(
    () =>
      runLiveModelLane(
        laneOptions({
          controlBaseline: {
            unsupported_claim_rate: 0,
            evidence_coverage: 1,
          },
        }),
      ),
    /withholds: evidence_coverage/,
    'a withheld metric in the baseline must be refused by name, with the remedy that fits it',
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

/**
 * The value that is sent has to be the value that was validated.
 *
 * The command reads the credential at the executable edge and hands it to the
 * port; if it hands over a string the configuration did not check, the check is
 * not a check. A credential with an inner control character is where the two
 * come apart: `trim` does not remove it, so the lane reads as configured, and
 * the transport reports an invalid header value by QUOTING it — straight into
 * the `${error.name}: ${error.message}` this command writes to stderr, which for
 * `npm run eval:live-model` is a retained CI job log.
 *
 * The credential here is assembled at runtime for the reason every fixture in
 * this suite is (`.claude/rules/autonomy.md`, "Never"), and it is spawned rather
 * than exported into this process, so no real key can reach the child.
 */
test('never hands the transport a credential the configuration did not validate', () => {
  const canary = fakeApiKeyCarrying('\n');

  const result = spawnSync(
    process.execPath,
    [resolve(projectRoot, 'scripts/eval-live-model.mjs')],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv({ CI: '1', [MODEL_API_KEY_VARIABLE]: canary }),
    },
  );

  assert.notEqual(result.status, 0, 'an unusable credential must fail the command');
  for (const [stream, text] of [
    ['stderr', result.stderr],
    ['stdout', result.stdout],
  ]) {
    // Each SEGMENT as well as the whole value: an error that echoes only the
    // first line has still published the key up to the break.
    for (const secret of [canary, ...canary.split(/[\u0000-\u001f]/)]) {
      assert.equal(
        text.includes(secret),
        false,
        `the credential reached ${stream}, which in CI is a retained job log`,
      );
    }
  }
  assert.doesNotMatch(
    result.stderr,
    /TypeError/,
    'a transport-raised type error means the string was handed on unchecked; the refusal belongs to this repository, whose errors carry no value',
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

  // 🔴 The control arm's sensitivity, measured rather than enumerated by hand.
  //
  // An earlier version of the prose said the replay-backed control "sits at
  // zero on evidence_coverage and termination_correctness" — two of six.
  // `prose-reviewer` ran the arm and found ALL SIX at 0.0000. Since 1 is the
  // perfect score for five of them, the control arm is at the INSENSITIVE floor
  // almost everywhere: a harness change that pushes any of those down cannot
  // move it, so the lane's control cannot see that direction at all.
  //
  // That is a real limit of the evidence this lane produces and the prose now
  // points here instead of counting. Which metrics sit at the floor is a fact
  // about the corpus and the scripted nodes, so it is asserted rather than
  // described — a metric that stops being at the floor reddens this row, which
  // is the day the prose has to be re-read.
  const floors = {};
  for (const result of experiment.results) {
    for (const [key, metric] of [
      ...Object.entries(result.metrics),
      ...Object.entries(result.behaviorMetrics),
    ]) {
      if (metric === undefined) continue;
      floors[key] = (floors[key] ?? new Set()).add(metric.score);
    }
  }
  const atZero = Object.entries(floors)
    .filter(([, scores]) => scores.size === 1 && scores.has(0))
    .map(([key]) => key)
    .sort();

  assert.deepEqual(
    atZero,
    [
      'challenge_effect',
      'evidence_coverage',
      'false_alert_correctness',
      'misleading_evidence_handling',
      'termination_correctness',
      'unsupported_claim_rate',
    ],
    'every metric the replay-backed control arm emits sits at a single score of zero — so the control arm is at the insensitive floor on all of them except unsupported_claim_rate, where zero is the perfect score',
  );
});

/* -------------------------------------------------------------------------- */
/* AIC-111: the two arms have to count the same thing                          */
/* -------------------------------------------------------------------------- */

/**
 * The execution input `runGraphBenchmarkExperiment` hands `createNodes`, built
 * here from one real CALIBRATION record — the lane itself runs the
 * final-evaluation plan, and a row that read a hold-out result would be spending
 * corpus this ticket has no claim on. The shape mirrors the runner's own
 * construction (`benchmark-evaluation.ts`, `executionInput`), because a nodes
 * factory handed a different shape is not the factory the lane calls.
 */
function calibrationExecutionInput() {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'aic-111-lane-arms',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  assert.ok(record, 'the calibration plan must contain at least one record');
  return {
    experimentId: record.experimentId,
    exampleId: record.exampleId,
    scenarioId: record.scenario.id,
    fixture: record.scenario.fixture,
    runId: record.runId,
    threadId: record.threadId,
    metadata: record.metadata,
  };
}

/** The three nodes the model arm is allowed to differ in, and nothing else. */
const MODEL_BACKED_ROLES = [
  'challenge_hypothesis',
  'generate_hypotheses',
  'interpret_residual_evidence',
];

/**
 * A port that refuses to answer and records that it was asked. Nothing in this
 * file may reach a provider, so the arms are compared as objects and the port
 * exists only to be handed over unused.
 */
function refusingPort(asked) {
  return {
    async complete() {
      asked.push('complete');
      throw new Error('no row in this file may call the model port');
    },
  };
}

test('swaps exactly the three reasoning roles and leaves the rest of the lifecycle shared', () => {
  const input = calibrationExecutionInput();
  const asked = [];
  const control = scriptedNodes(input);
  const model = modelNodes(input, refusingPort(asked));

  assert.deepEqual(
    Object.keys(model).sort(),
    Object.keys(control).sort(),
    'the model arm is the control arm with three roles replaced, so it can neither gain nor lose a node',
  );

  // Compared by the SOURCE each node came from, not by reference: `scriptedNodes`
  // builds a fresh closure on every call, so a reference comparison would report
  // that two constructions of the same arm are different arms. What matters here
  // is which implementation a node came from, and that is what the source says.
  const differing = Object.keys(control)
    .filter((name) => String(model[name]) !== String(control[name]))
    .sort();

  assert.deepEqual(
    differing,
    MODEL_BACKED_ROLES,
    'only the three reasoning roles may differ between the arms: a lane whose arms differ anywhere else is comparing the harness, not the model',
  );
  assert.deepEqual(asked, [], 'no row in this file may call the model port');
});

test('counts the same tool calls on both arms of the lane', async () => {
  const input = calibrationExecutionInput();
  const asked = [];
  const control = scriptedNodes(input);
  const model = modelNodes(input, refusingPort(asked));

  const controlUpdate = await control.execute_investigation({ evidence: [] });
  const modelUpdate = await model.execute_investigation({ evidence: [] });

  assert.equal(
    controlUpdate.trials?.length,
    input.fixture.entries.length,
    `the control arm replayed ${String(input.fixture.entries.length)} recorded tool calls and wrote ${String(controlUpdate.trials?.length)} trials: the axis that reports what a run spent reads that channel, so an arm that leaves it unwritten publishes a measured-looking zero`,
  );
  assert.deepEqual(
    modelUpdate.trials,
    controlUpdate.trials,
    'both arms replay the same recorded calls through the same node, so the lane compares two numbers that mean the same thing — a model arm counting differently would read as model behaviour',
  );
  assert.deepEqual(asked, [], 'no row in this file may call the model port');
});

/**
 * The scaffolding this comparison rests on, pinned in both directions.
 *
 * The two arms above are the command's own functions rather than copies, which
 * requires importing the command — and a command that ran its lane at import
 * time could not be imported. The guard that makes it importable must not have
 * changed what `npm run eval:live-model` does, so both halves are asserted: an
 * import runs nothing, and an execution still refuses without a credential.
 */
test('runs its lane only when it is the process entry point', () => {
  const commandPath = resolve(projectRoot, 'scripts/eval-live-model.mjs');
  const commandUrl = JSON.stringify(pathToFileURL(commandPath).href);

  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { modelNodes, scriptedNodes } from ${commandUrl};\nprocess.stdout.write([typeof scriptedNodes, typeof modelNodes].join(','));`,
    ],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv({ CI: '1' }) },
  );

  assert.equal(
    imported.status,
    0,
    `importing the command must run no lane: ${imported.stderr}`,
  );
  assert.equal(
    imported.stdout,
    'function,function',
    'the command must export both arms, or the comparison above has to copy them and can then drift from what the lane runs',
  );

  const executed = spawnSync(
    process.execPath,
    [commandPath],
    { cwd: projectRoot, encoding: 'utf8', env: childEnv({ CI: '1' }) },
  );

  assert.notEqual(
    executed.status,
    0,
    'making the command importable must not stop it being a command: with no credential it still refuses',
  );
  assert.match(executed.stderr, new RegExp(MODEL_API_KEY_VARIABLE));
});

/**
 * The half the row above cannot see, and the reason it needs its own.
 *
 * That row spawns `resolve(projectRoot, …)`, a path already resolved through
 * every symlink by the runner's own `import.meta.url` — so it exercises only
 * the case where the two sides agree. ESM resolves `import.meta.url` through
 * symlinks while `process.argv[1]` keeps the path as typed, and the first
 * version of this guard compared the two directly. Reached through a link it
 * then ran no lane and exited 0: a command that refuses turned into a command
 * that reports success having done nothing, which is the one failure this
 * file's header promises cannot happen.
 *
 * Not a contrived path. macOS resolves `$TMPDIR` through `/var` → `/private/var`,
 * so `mkdtempSync` alone is enough to produce it — which is what this row uses.
 */
test('refuses without a credential when it is reached through a symlinked path', () => {
  const linkRoot = mkdtempSync(join(tmpdir(), 'aic-111-entrypoint-'));
  try {
    const link = join(linkRoot, 'repo');
    symlinkSync(projectRoot, link);

    const executed = spawnSync(
      process.execPath,
      [join(link, 'scripts/eval-live-model.mjs')],
      { cwd: projectRoot, encoding: 'utf8', env: childEnv({ CI: '1' }) },
    );

    assert.notEqual(
      executed.status,
      0,
      `reached through a symlink the command must still refuse, not exit 0 having run nothing: stdout=${JSON.stringify(executed.stdout)} stderr=${JSON.stringify(executed.stderr)}`,
    );
    assert.match(executed.stderr, new RegExp(MODEL_API_KEY_VARIABLE));
  } finally {
    rmSync(linkRoot, { force: true, recursive: true });
  }
});

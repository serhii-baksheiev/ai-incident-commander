/**
 * AIC-119 slice 4 (owner ruling D1, item 7): the prediction-gap diagnostic.
 *
 * "How many investigations failed to move from evidence-based reasoning to a
 * stronger state precisely because the prediction path is missing?" is
 * answered by `predictionGapOf(finalState)`, a pure function in `@aic/evals`
 * that distinguishes, from the run's FINAL state only:
 *   - reached corroborated (`finalCorroborated`);
 *   - reached supported (`finalSupported`);
 *   - terminated sufficient from corroborated (`sufficientFromCorroborated`);
 *   - stalled where the leader had every evidence requirement and only
 *     lacked a confirmed prediction (`stalledLeaderLacksConfirmedPrediction`);
 *   - stalled for an unrelated reason (`stalledOther`).
 *
 * This is a DIAGNOSTIC axis, not a quality metric (owner ruling D1, item 7's
 * last sentence): none of its keys may appear among `BENCHMARK_METRIC_KEYS`,
 * `BEHAVIOR_METRIC_KEYS`, a result's `metrics`/`behaviorMetrics`, the lane's
 * `graphVsNaive` comparison, `observedBaseline`, or any LangSmith feedback row
 * the persistence projection emits.
 *
 * Expected values in the per-flag rows below are literals, written by hand
 * from the definitions above — never read back off `predictionGapOf` or
 * `deriveHypothesisStanding` (`.claude/rules/invariants.md`, "the
 * independent-oracle invariant").
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import * as observability from '@aic/observability';
import { MODEL_API_KEY_VARIABLE } from '@aic/roles';

import {
  benchmarkVersions,
  capturingClient,
  requireFunction,
  singleRecordExperiment,
} from './fixtures/benchmark-experiment.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';

function requirePredictionGapOf() {
  return requireFunction(evals, 'predictionGapOf', '@aic/evals');
}

/** v0.2 promoted to the v0.3 structural evaluator, the version the committed
 * calibration control baseline (`docs/evidence/control-baseline-calibration.json`)
 * is declared under — the same promotion `lane-arms.test.mjs` applies before
 * handing this metadata to `runLiveModelLane`. */
const v3Metadata = Object.freeze({
  ...benchmarkVersions,
  evaluatorVersion: evals.STRUCTURAL_EVALUATOR_VERSION,
});

/* -------------------------------------------------------------------------- */
/* State-building helpers, copied in shape from state-termination.test.mjs   */
/* and hypothesis-standing.test.mjs                                          */
/* -------------------------------------------------------------------------- */

function hypothesis(id, createdBy = 'initial') {
  return { id, statement: `${id} statement`, createdBy };
}

function evidenceFor(id, reliability = 'medium') {
  return {
    id,
    trialId: `trial-${id}`,
    kind: 'deploy',
    source: 'deployment-history',
    observedAt: '2026-09-24T08:00:00.000Z',
    statement: `observation recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
    reliability,
  };
}

function supportAssessment(hypothesisId, evidenceId, strength, overrides = {}) {
  return {
    id: `support-${hypothesisId}-${evidenceId}`,
    evidenceId,
    hypothesisId,
    effect: 'supports',
    strength,
    rationale: `supports ${hypothesisId} at ${strength} strength from ${evidenceId}`,
    producedBy: 'rule',
    at: '2026-09-24T08:01:00.000Z',
    ...overrides,
  };
}

function predictionFor(id, hypothesisId, status) {
  return {
    id,
    hypothesisId,
    statement: `${hypothesisId} prediction ${id}`,
    expectedIfTrue: [{ observation: 'the predicted observation occurs' }],
    expectedIfFalse: [{ observation: 'the predicted observation does not occur' }],
    status,
  };
}

/** Two independent medium/high supports, no confirmed prediction: corroborated under v0.2. */
function corroboratedAssessments(hypothesisId, [firstEvidenceId, secondEvidenceId]) {
  return [
    supportAssessment(hypothesisId, firstEvidenceId, 'medium'),
    supportAssessment(hypothesisId, secondEvidenceId, 'high'),
  ];
}

function finalState({
  incidentId = 'incident-prediction-gap',
  hypotheses = [],
  predictions = [],
  evidence = [],
  assessments = [],
  trials = [],
  stopKind,
  statusRulesVersion = STATUS_RULES_VERSION,
} = {}) {
  return {
    incident: scopedIncident(incidentId),
    hypotheses,
    predictions,
    tests: [],
    trials,
    evidence,
    assessments,
    control: {
      runId: 'run-prediction-gap',
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion,
      phase: 'terminating',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 1,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
      stopKind,
    },
  };
}

function trialFor(id, status, overrides = {}) {
  return {
    id,
    runId: 'run-prediction-gap',
    testId: `test-${id}`,
    attempt: 1,
    tool: 'logs.search',
    input: {},
    status,
    durationMs: 10,
    evidenceIds: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* (a) a sole corroborated leader stopped sufficient                          */
/* -------------------------------------------------------------------------- */

test('a sole corroborated leader that terminated sufficient reports sufficientFromCorroborated and finalCorroborated, and nothing else', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceFor('e1'), evidenceFor('e2')],
    assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
    stopKind: 'sufficient',
  });

  const gap = predictionGapOf(state);

  assert.deepEqual(gap, {
    stopKind: 'sufficient',
    leaderId: 'h-1',
    leaderStatus: 'corroborated',
    highestStatus: 'corroborated',
    leaderConfirmedPredictions: 0,
    finalCorroborated: true,
    finalSupported: false,
    sufficientFromCorroborated: true,
    stalledLeaderLacksConfirmedPrediction: false,
    stalledOther: false,
  });
});

/* -------------------------------------------------------------------------- */
/* (b) a supported leader (>=1 confirmed prediction) stopped sufficient       */
/* -------------------------------------------------------------------------- */

test('a supported leader, promoted by a confirmed prediction, that terminated sufficient reports finalSupported true and sufficientFromCorroborated false', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceFor('e1'), evidenceFor('e2')],
    predictions: [predictionFor('p-1', 'h-1', 'confirmed')],
    assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
    stopKind: 'sufficient',
  });

  const gap = predictionGapOf(state);

  assert.deepEqual(gap, {
    stopKind: 'sufficient',
    leaderId: 'h-1',
    leaderStatus: 'supported',
    highestStatus: 'supported',
    leaderConfirmedPredictions: 1,
    finalCorroborated: false,
    finalSupported: true,
    sufficientFromCorroborated: false,
    stalledLeaderLacksConfirmedPrediction: false,
    stalledOther: false,
  });
});

/* -------------------------------------------------------------------------- */
/* (c) two corroborated hypotheses stopped ambiguous                          */
/* -------------------------------------------------------------------------- */

test('two corroborated hypotheses that terminated ambiguous report stalledLeaderLacksConfirmedPrediction on the earlier-listed leader', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-first'), hypothesis('h-second')],
    evidence: [evidenceFor('e-f1'), evidenceFor('e-f2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
    assessments: [
      ...corroboratedAssessments('h-first', ['e-f1', 'e-f2']),
      ...corroboratedAssessments('h-second', ['e-s1', 'e-s2']),
    ],
    stopKind: 'ambiguous',
  });

  const gap = predictionGapOf(state);

  assert.deepEqual(gap, {
    stopKind: 'ambiguous',
    leaderId: 'h-first',
    leaderStatus: 'corroborated',
    highestStatus: 'corroborated',
    leaderConfirmedPredictions: 0,
    finalCorroborated: true,
    finalSupported: false,
    sufficientFromCorroborated: false,
    stalledLeaderLacksConfirmedPrediction: true,
    stalledOther: false,
  });
});

/**
 * "Lacks a confirmed prediction" is literal: a refuted or untested prediction
 * is not a confirmed one, so a corroborated leader carrying only those reports
 * the same flag as a leader with no prediction at all. Neither prediction here
 * is tied to a contradicting assessment, so neither rejects or weakens h-first.
 */
test('a corroborated leader carrying only a refuted and an untested prediction counts zero confirmed predictions and, stopped ambiguous, reports stalledLeaderLacksConfirmedPrediction', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-first'), hypothesis('h-second')],
    predictions: [
      predictionFor('p-refuted', 'h-first', 'refuted'),
      predictionFor('p-untested', 'h-first', 'untested'),
    ],
    evidence: [evidenceFor('e-f1'), evidenceFor('e-f2'), evidenceFor('e-s1'), evidenceFor('e-s2')],
    assessments: [
      ...corroboratedAssessments('h-first', ['e-f1', 'e-f2']),
      ...corroboratedAssessments('h-second', ['e-s1', 'e-s2']),
    ],
    stopKind: 'ambiguous',
  });

  const gap = predictionGapOf(state);

  assert.equal(gap.leaderId, 'h-first');
  assert.equal(gap.leaderStatus, 'corroborated');
  assert.equal(gap.leaderConfirmedPredictions, 0, 'a refuted or untested prediction is not a confirmed one');
  assert.equal(gap.stalledLeaderLacksConfirmedPrediction, true);
});

test("leaderConfirmedPredictions counts only the leader's confirmed predictions, not every prediction it carries", () => {
  const predictionGapOf = requirePredictionGapOf();
  // One support: h-only stays a candidate whatever its predictions say, and it
  // is the leader because it is the only hypothesis.
  const state = finalState({
    hypotheses: [hypothesis('h-only')],
    predictions: [
      predictionFor('p-confirmed', 'h-only', 'confirmed'),
      predictionFor('p-untested', 'h-only', 'untested'),
    ],
    evidence: [evidenceFor('e-1')],
    assessments: [supportAssessment('h-only', 'e-1', 'medium')],
    stopKind: 'stalled',
  });

  const gap = predictionGapOf(state);

  assert.equal(gap.leaderStatus, 'candidate');
  assert.equal(gap.leaderConfirmedPredictions, 1, 'one of the two predictions is confirmed');
  assert.equal(gap.stalledOther, true);
});

/* -------------------------------------------------------------------------- */
/* (d) only candidates, stopped stalled                                       */
/* -------------------------------------------------------------------------- */

test('a lone candidate hypothesis that terminated stalled reports stalledOther and nothing else', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceFor('e-cand')],
    assessments: [supportAssessment('h-1', 'e-cand', 'medium')],
    stopKind: 'stalled',
  });

  const gap = predictionGapOf(state);

  assert.deepEqual(gap, {
    stopKind: 'stalled',
    leaderId: 'h-1',
    leaderStatus: 'candidate',
    highestStatus: 'candidate',
    leaderConfirmedPredictions: 0,
    finalCorroborated: false,
    finalSupported: false,
    sufficientFromCorroborated: false,
    stalledLeaderLacksConfirmedPrediction: false,
    stalledOther: true,
  });
});

/* -------------------------------------------------------------------------- */
/* (e) no hypotheses, stopped stalled                                         */
/* -------------------------------------------------------------------------- */

test('no hypotheses at all, terminated stalled, reports an undefined leader and stalledOther, and nothing else', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({ hypotheses: [], stopKind: 'stalled' });

  const gap = predictionGapOf(state);

  assert.deepEqual(gap, {
    stopKind: 'stalled',
    leaderId: undefined,
    leaderStatus: undefined,
    highestStatus: undefined,
    leaderConfirmedPredictions: 0,
    finalCorroborated: false,
    finalSupported: false,
    sufficientFromCorroborated: false,
    stalledLeaderLacksConfirmedPrediction: false,
    stalledOther: true,
  });
});

/* -------------------------------------------------------------------------- */
/* (f) tools-unavailable                                                      */
/* -------------------------------------------------------------------------- */

test('a tools-unavailable termination reports stalledOther, never stalledLeaderLacksConfirmedPrediction, whatever the leader status', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-1')],
    trials: [trialFor('trial-1', 'unavailable'), trialFor('trial-2', 'error')],
    evidence: [],
    stopKind: 'tools-unavailable',
  });

  const gap = predictionGapOf(state);

  assert.deepEqual(gap, {
    stopKind: 'tools-unavailable',
    leaderId: 'h-1',
    leaderStatus: 'candidate',
    highestStatus: 'candidate',
    leaderConfirmedPredictions: 0,
    finalCorroborated: false,
    finalSupported: false,
    sufficientFromCorroborated: false,
    stalledLeaderLacksConfirmedPrediction: false,
    stalledOther: true,
  });
});

/* -------------------------------------------------------------------------- */
/* Frozen                                                                      */
/* -------------------------------------------------------------------------- */

test('returns a frozen object', () => {
  const predictionGapOf = requirePredictionGapOf();
  const state = finalState({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceFor('e1'), evidenceFor('e2')],
    assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
    stopKind: 'sufficient',
  });

  const gap = predictionGapOf(state);

  assert.equal(Object.isFrozen(gap), true, 'predictionGapOf must return a frozen object');
});

/* -------------------------------------------------------------------------- */
/* Scenario independence                                                      */
/* -------------------------------------------------------------------------- */

test('scenario independence: a different incident.id gives an identical diagnostic', () => {
  const predictionGapOf = requirePredictionGapOf();
  const buildState = (incidentId) =>
    finalState({
      incidentId,
      hypotheses: [hypothesis('h-1')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
      stopKind: 'sufficient',
    });

  const gapAlpha = predictionGapOf(buildState('incident-alpha'));
  const gapBeta = predictionGapOf(buildState('incident-beta'));

  assert.deepEqual(gapAlpha, {
    stopKind: 'sufficient',
    leaderId: 'h-1',
    leaderStatus: 'corroborated',
    highestStatus: 'corroborated',
    leaderConfirmedPredictions: 0,
    finalCorroborated: true,
    finalSupported: false,
    sufficientFromCorroborated: true,
    stalledLeaderLacksConfirmedPrediction: false,
    stalledOther: false,
  });
  assert.deepEqual(
    gapAlpha,
    gapBeta,
    'incident.id must not change the prediction-gap diagnostic',
  );
});

/* -------------------------------------------------------------------------- */
/* Every graph-executed benchmark result carries it; naive and oracle do not  */
/* -------------------------------------------------------------------------- */

test('runGraphBenchmarkExperiment attaches predictionGap, computed from finalState, to every result', async () => {
  const runGraphBenchmarkExperiment = requireFunction(
    evals,
    'runGraphBenchmarkExperiment',
    '@aic/evals',
  );
  const { scriptedNodes } = await import('../scripts/lane-arms.mjs');

  const experiment = await runGraphBenchmarkExperiment({
    experimentId: 'aic-119s4-graph-prediction-gap',
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
    createNodes: (record) => scriptedNodes(record),
    async recordEvaluation() {},
  });

  assert.ok(experiment.results.length > 0, 'the calibration plan must produce at least one result');
  for (const result of experiment.results) {
    assert.ok(
      result.predictionGap !== undefined,
      'every graph-executed benchmark result must carry predictionGap',
    );
    assert.equal(
      result.predictionGap.stopKind,
      result.actualStopKind,
      'predictionGap.stopKind must be the same stop kind the result itself reports',
    );
  }
});

test('predictionGap is absent from every result the naive arm and the oracle arm produce', async () => {
  // A precondition of this row's claim: predictionGapOf is the diagnostic
  // being asserted absent below, so this row is meaningless while @aic/evals
  // does not export it yet.
  requirePredictionGapOf();
  const { naiveArm, oracleArm } = await import('../scripts/lane-arms.mjs');

  const runOracleArm = oracleArm({ experimentId: 'aic-119s4-oracle-prediction-gap' });
  const oracleExperiment = await runOracleArm({
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  assert.ok(oracleExperiment.results.length > 0);
  for (const result of oracleExperiment.results) {
    assert.equal(
      result.predictionGap,
      undefined,
      'the oracle arm does not execute the graph, so it must carry no predictionGap',
    );
  }

  const fakePort = {
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
  const runNaiveArm = naiveArm({
    experimentId: 'aic-119s4-naive-prediction-gap',
    port: fakePort,
    config: Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' }),
  });
  const naiveExperiment = await runNaiveArm({
    scenarioSet: 'calibration',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  assert.ok(naiveExperiment.results.length > 0);
  for (const result of naiveExperiment.results) {
    assert.equal(
      result.predictionGap,
      undefined,
      'the naive arm does not execute the graph, so it must carry no predictionGap',
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The live lane's per-arm counts                                             */
/* -------------------------------------------------------------------------- */

const HEAD_SHA = 'e'.repeat(40);

function fakeApiKey() {
  return ['sk', 'ant', 'test', '9'.repeat(24)].join('-');
}

/** Sums each flag over `results`, plus `runs`, from the results' own predictionGap field. */
function computePredictionGapCounts(results) {
  const counts = {
    runs: results.length,
    finalCorroborated: 0,
    finalSupported: 0,
    sufficientFromCorroborated: 0,
    stalledLeaderLacksConfirmedPrediction: 0,
    stalledOther: 0,
  };
  for (const result of results) {
    const gap = result.predictionGap;
    assert.ok(gap !== undefined, 'every counted result must carry predictionGap');
    if (gap.finalCorroborated) counts.finalCorroborated += 1;
    if (gap.finalSupported) counts.finalSupported += 1;
    if (gap.sufficientFromCorroborated) counts.sufficientFromCorroborated += 1;
    if (gap.stalledLeaderLacksConfirmedPrediction) counts.stalledLeaderLacksConfirmedPrediction += 1;
    if (gap.stalledOther) counts.stalledOther += 1;
  }
  return counts;
}

test('the live lane reports predictionGapCounts for the control and model arms, equal to a hand-computed aggregate of their own results, and reports the measured calibration control fact that every run stalls with no corroborated hypothesis', async () => {
  const runLiveModelLane = requireFunction(evals, 'runLiveModelLane', '@aic/evals');
  const { scriptedNodes, CALIBRATION_CONTROL_BASELINE_PATH } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');

  let controlExperiment;
  let modelExperiment;

  async function scriptedGraphExperiment(experimentId, plan) {
    return evals.runGraphBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      createNodes: (record) => scriptedNodes(record),
      async recordEvaluation() {},
    });
  }

  const report = await runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-119s4-prediction-gap-lane',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    controlBaseline: readControlBaseline(CALIBRATION_CONTROL_BASELINE_PATH),
    async runControlArm(plan) {
      controlExperiment = await scriptedGraphExperiment('aic-119s4-prediction-gap-control', plan);
      return controlExperiment;
    },
    async runModelArm(plan) {
      modelExperiment = await scriptedGraphExperiment('aic-119s4-prediction-gap-model', plan);
      return modelExperiment;
    },
  });

  assert.ok(controlExperiment.results.length > 0, 'the calibration plan must produce at least one control result');

  const expectedControlCounts = computePredictionGapCounts(controlExperiment.results);
  assert.deepEqual(
    report.arms.control.predictionGapCounts,
    expectedControlCounts,
    'report.arms.control.predictionGapCounts must equal a hand-computed aggregate of the control experiment results, never a number this row hard-codes',
  );
  assert.equal(report.arms.control.predictionGapCounts.runs, controlExperiment.results.length);

  const expectedModelCounts = computePredictionGapCounts(modelExperiment.results);
  assert.deepEqual(
    report.arms.model.predictionGapCounts,
    expectedModelCounts,
    'report.arms.model.predictionGapCounts must equal a hand-computed aggregate of the model experiment results',
  );

  // The measured calibration control fact: scriptedNodes' interpret_residual_evidence
  // writes no assessments, so every hypothesis stays a candidate and every run
  // stalls with no corroborated hypothesis — stalledOther equals runs.
  for (const result of controlExperiment.results) {
    assert.equal(result.actualStopKind, 'stalled', 'every scripted control run over calibration stalls');
    assert.equal(result.predictionGap.stalledOther, true);
    assert.equal(result.predictionGap.finalCorroborated, false);
  }
  assert.equal(
    report.arms.control.predictionGapCounts.stalledOther,
    report.arms.control.predictionGapCounts.runs,
    'every scripted control run stalls for an unrelated reason (no assessments are ever produced), so stalledOther must equal runs',
  );
});

test('predictionGapCounts is absent from the oracle and naive arm entries of the live lane report', async () => {
  // A precondition of this row's claim: predictionGapCounts is only
  // meaningful to assert absent once predictionGapOf, its per-run source,
  // exists in @aic/evals.
  requirePredictionGapOf();
  const runLiveModelLane = requireFunction(evals, 'runLiveModelLane', '@aic/evals');
  const { scriptedNodes, CALIBRATION_CONTROL_BASELINE_PATH } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const { oracleArm, naiveArm } = await import('../scripts/lane-arms.mjs');

  async function scriptedGraphExperiment(experimentId, plan) {
    return evals.runGraphBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      createNodes: (record) => scriptedNodes(record),
      async recordEvaluation() {},
    });
  }

  const fakePort = {
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

  const report = await runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-119s4-prediction-gap-lane-arms',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    controlBaseline: readControlBaseline(CALIBRATION_CONTROL_BASELINE_PATH),
    runOracleArm: oracleArm({ experimentId: 'aic-119s4-prediction-gap-lane-oracle' }),
    runNaiveArm: naiveArm({
      experimentId: 'aic-119s4-prediction-gap-lane-naive',
      port: fakePort,
      config: Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' }),
    }),
    async runControlArm(plan) {
      return scriptedGraphExperiment('aic-119s4-prediction-gap-lane-arms-control', plan);
    },
    async runModelArm(plan) {
      return scriptedGraphExperiment('aic-119s4-prediction-gap-lane-arms-model', plan);
    },
  });

  assert.equal(report.arms.oracle.status, 'completed');
  assert.equal(
    Object.hasOwn(report.arms.oracle, 'predictionGapCounts'),
    false,
    'the oracle arm never executes the graph, so its report entry must carry no predictionGapCounts',
  );
  assert.equal(report.arms.naive.status, 'completed');
  assert.equal(
    Object.hasOwn(report.arms.naive, 'predictionGapCounts'),
    false,
    'the naive arm never executes the graph, so its report entry must carry no predictionGapCounts',
  );
});

/* -------------------------------------------------------------------------- */
/* It is NOT a metric                                                          */
/* -------------------------------------------------------------------------- */

test('none of the prediction-gap keys appear in BENCHMARK_METRIC_KEYS or BEHAVIOR_METRIC_KEYS', () => {
  const predictionGapOf = requirePredictionGapOf();
  const sampleGap = predictionGapOf(
    finalState({
      hypotheses: [hypothesis('h-1')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
      stopKind: 'sufficient',
    }),
  );
  const gapKeys = Object.keys(sampleGap);
  assert.ok(gapKeys.length > 0);

  const metricKeys = new Set([
    ...evals.BENCHMARK_METRIC_KEYS,
    ...evals.BEHAVIOR_METRIC_KEYS,
  ]);
  for (const key of gapKeys) {
    assert.equal(
      metricKeys.has(key),
      false,
      `${key} is a prediction-gap diagnostic field and must never appear as a benchmark or behavior metric key`,
    );
  }
  assert.equal(
    metricKeys.has('predictionGap'),
    false,
    'predictionGap itself must never appear as a benchmark or behavior metric key',
  );
});

test("none of the prediction-gap keys appear in a graph-executed result's metrics or behaviorMetrics, in observedBaseline, or in graphVsNaive", async () => {
  const runLiveModelLane = requireFunction(evals, 'runLiveModelLane', '@aic/evals');
  const { scriptedNodes, CALIBRATION_CONTROL_BASELINE_PATH } = await import('../scripts/eval-live-model.mjs');
  const { readControlBaseline } = await import('../scripts/eval-final-holdout.mjs');
  const { oracleArm, naiveArm } = await import('../scripts/lane-arms.mjs');

  async function scriptedGraphExperiment(experimentId, plan) {
    return evals.runGraphBenchmarkExperiment({
      experimentId,
      scenarioSet: plan.scenarioSet,
      runsPerScenario: plan.runsPerScenario,
      metadata: plan.metadata,
      createNodes: (record) => scriptedNodes(record),
      async recordEvaluation() {},
    });
  }

  const fakePort = {
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

  let controlExperiment;
  const report = await runLiveModelLane({
    env: { [MODEL_API_KEY_VARIABLE]: fakeApiKey() },
    scenarioSet: 'calibration',
    experimentId: 'aic-119s4-not-a-metric-lane',
    headSha: HEAD_SHA,
    metadata: v3Metadata,
    controlBaseline: readControlBaseline(CALIBRATION_CONTROL_BASELINE_PATH),
    runOracleArm: oracleArm({ experimentId: 'aic-119s4-not-a-metric-oracle' }),
    runNaiveArm: naiveArm({
      experimentId: 'aic-119s4-not-a-metric-naive',
      port: fakePort,
      config: Object.freeze({ modelId: 'fake-naive-model', provider: 'anthropic' }),
    }),
    async runControlArm(plan) {
      controlExperiment = await scriptedGraphExperiment('aic-119s4-not-a-metric-control', plan);
      return controlExperiment;
    },
    async runModelArm(plan) {
      return scriptedGraphExperiment('aic-119s4-not-a-metric-model', plan);
    },
  });

  const gapKeys = Object.keys(
    requirePredictionGapOf()(
      finalState({
        hypotheses: [hypothesis('h-1')],
        evidence: [evidenceFor('e1'), evidenceFor('e2')],
        assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
        stopKind: 'sufficient',
      }),
    ),
  );

  for (const result of controlExperiment.results) {
    for (const key of gapKeys) {
      assert.equal(Object.hasOwn(result.metrics, key), false, `metrics must not carry ${key}`);
      assert.equal(Object.hasOwn(result.behaviorMetrics, key), false, `behaviorMetrics must not carry ${key}`);
    }
  }

  for (const key of gapKeys) {
    assert.equal(
      Object.hasOwn(report.arms.control.observedBaseline, key),
      false,
      `observedBaseline must not carry ${key}`,
    );
  }

  if (report.graphVsNaive !== undefined) {
    for (const key of gapKeys) {
      assert.equal(
        Object.hasOwn(report.graphVsNaive, key),
        false,
        `graphVsNaive must not carry ${key}`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* No feedback row                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `observability.persistBenchmarkExperiment` never reaches the network in
 * this file: every row passes its own `capturingClient`, and this tripwire
 * catches an accidental real client the same way `persistence-four-arm.test.mjs`
 * does.
 */
const outboundAttempts = [];
globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : String(input?.url ?? input);
  outboundAttempts.push(`${init?.method ?? 'GET'} ${target}`);
  throw new Error('this test attempted an outbound call');
};

afterEach(() => {
  const attempted = outboundAttempts.splice(0, outboundAttempts.length);
  assert.deepEqual(
    attempted,
    [],
    'no row in this file may reach the network: every row passes its own client',
  );
});

test('persisting a result carrying predictionGap emits no feedback row keyed by any prediction-gap field', async () => {
  const predictionGapOf = requirePredictionGapOf();
  const samplePredictionGap = predictionGapOf(
    finalState({
      hypotheses: [hypothesis('h-1')],
      evidence: [evidenceFor('e1'), evidenceFor('e2')],
      assessments: corroboratedAssessments('h-1', ['e1', 'e2']),
      stopKind: 'sufficient',
    }),
  );
  const gapKeys = Object.keys(samplePredictionGap);

  const { experiment } = singleRecordExperiment((result) => ({
    ...result,
    predictionGap: samplePredictionGap,
  }));

  const capture = capturingClient();
  await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'aic-119s4-prediction-gap-no-feedback-row',
    experiment,
  });

  assert.ok(capture.feedback.length > 0, 'the projection must publish at least one feedback row to check against');
  for (const row of capture.feedback) {
    assert.equal(
      row.key.startsWith('prediction'),
      false,
      `no feedback key may start with "prediction": got ${row.key}`,
    );
    for (const gapKey of gapKeys) {
      assert.notEqual(row.key, gapKey, `no feedback key may equal the prediction-gap field ${gapKey}`);
    }
  }
});

/**
 * AIC-124 slice c: wiring the deterministic prediction path (slice a:
 * `packages/domain`'s `derivePredictions`/`evaluatePredictionObservations`;
 * slice b: `packages/graph`'s `createDerivePredictions`/
 * `createEvaluatePredictions` and `PREDICTION_TEMPLATES`) into the lanes and
 * into the kernel's own challenge round.
 *
 * `createEvaluatePredictions` evaluates only the predictions already in
 * `state.predictions` — it derives nothing. Deriving is
 * `createDerivePredictions`'s job alone. So every row below that needs a
 * confirmed or refuted prediction derives first (with `derive_predictions`)
 * and evaluates second (with `evaluate_predictions`), never the other way
 * round.
 *
 * `scripts/lane-arms.mjs`'s `scriptedNodes(record)` already overrides
 * `derive_hypothesis_state`/`termination_check` with the canonical,
 * state-driven nodes (AIC-119 slice 3); `modelNodes(record, port)` spreads
 * `scriptedNodes`. This slice's own job is the two prediction nodes:
 * `derive_predictions`/`evaluate_predictions` still come from
 * `replayBackedNodes`'s trace-only no-ops (`test/fixtures/benchmark-experiment.mjs`),
 * which is why every row below that reaches them through `scriptedNodes`/
 * `modelNodes` is red until that wiring lands.
 *
 * A second, independent wiring belongs to the kernel itself
 * (`packages/graph/src/investigation.ts`'s `challengeHypothesis`): the graph's
 * own topology has no `derive_predictions` edge on the challenge round (only
 * `challenge_hypothesis -> execute_investigation`), so a challenge
 * alternative — created with no prediction of its own — never gets one
 * unless the challenge wrapper derives on its behalf, before the round
 * re-enters `execute_investigation`. Section 5 below pins that behaviour
 * directly against `createInvestigationGraph`, independently of the lane.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Command } from '@langchain/langgraph';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import * as evals from '@aic/evals';
import { createReplayFixtureKey } from '@aic/tools';
import { ReplayToolAdapter } from '@aic/tools/replay';

import { scopedIncident } from './fixtures/scoped-incident.mjs';
import { benchmarkVersions } from './fixtures/benchmark-experiment.mjs';

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

function baseControl(overrides = {}) {
  return {
    runId: 'run-aic124c-prediction-wiring',
    schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: domain.STATUS_RULES_VERSION,
    phase: 'investigating',
    maxIterations: 4,
    llmCallBudget: 8,
    reservedChallengeBudget: 2,
    challengeRounds: 0,
    iterationsUsed: 0,
    llmCallsUsed: 0,
    resumeCount: 0,
    humanReview: false,
    ...overrides,
  };
}

/**
 * The execution-input shape `scripts/lane-arms.mjs`'s `scriptedNodes`/
 * `modelNodes` need, copied rather than imported from
 * `test/lane-arms.test.mjs` (not exported there, and that file's own
 * convention — see its header — is that a row needing `scripts/lane-arms.mjs`
 * builds this input inline rather than depending on another test file's
 * private helper).
 */
function executionInputFor(scenarioId) {
  const records = evals.createCalibrationBenchmarkPlan({
    experimentId: 'aic-124c-prediction-wiring',
    runsPerScenario: 3,
    metadata: benchmarkVersions,
  });
  const record = records.find(({ scenario }) => scenario.id === scenarioId);
  assert.ok(record, `the calibration plan must contain a record for ${scenarioId}`);
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

function calibrationExecutionInput() {
  const [record] = evals.createCalibrationBenchmarkPlan({
    experimentId: 'aic-124c-prediction-wiring-generic',
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

/** The full initial `IncidentState` a benchmark run starts from. */
function initialStateFor(input) {
  return {
    incident: {
      id: evals.opaqueIncidentId(input.runId),
      primaryScope: evals.BENCHMARK_PRIMARY_SCOPE,
    },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: input.runId,
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: evals.BENCHMARK_BUDGET_POLICY.maxIterations,
      llmCallBudget: evals.BENCHMARK_BUDGET_POLICY.llmCallBudget,
      reservedChallengeBudget: evals.BENCHMARK_BUDGET_POLICY.reservedChallengeBudget,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

/**
 * A hand-built state exercising a `connection-pool-exhaustion` cause on a
 * component the corpus never names, so a row here cannot be satisfied by
 * accidentally matching real corpus evidence instead of the fact this row
 * supplies.
 */
function poolHypothesisState({ observedAt, predictions = [] } = {}) {
  return {
    incident: scopedIncident('incident-aic124c-prediction-wiring'),
    hypotheses: [{
      id: 'h-1',
      statement: 'the pool for a component the corpus never names stayed occupied',
      createdBy: 'initial',
      cause: { component: 'aic124c-distractor-pool', mechanism: 'connection-pool-exhaustion' },
    }],
    predictions,
    tests: [],
    trials: [],
    evidence: observedAt === undefined
      ? []
      : [{
          id: 'e-1',
          trialId: 'trial-e-1',
          kind: 'metric',
          source: 'metrics',
          observedAt,
          statement: 'the pool for aic124c-distractor-pool read at-limit',
          rawRef: 'replay://evidence/e-1',
          observation: {
            version: domain.EXPECTED_OBSERVATION_VERSION,
            facts: [
              {
                form: 'signal-state',
                subject: 'aic124c-distractor-pool',
                window: 'incident',
                signal: 'connection-pool',
                state: 'at-limit',
              },
            ],
          },
        }],
    assessments: [],
    control: baseControl(),
  };
}

/** One millisecond after `evals.REPLAY_AS_OF`, as a literal — see A below. */
const ONE_MS_AFTER_REPLAY_AS_OF = '2026-08-26T15:00:00.001Z';

/* -------------------------------------------------------------------------- */
/* A. REPLAY_AS_OF admits the whole recorded corpus                          */
/* -------------------------------------------------------------------------- */

/**
 * The corpus is a recording collected at one instant: every evidence item in
 * `REPLAY_SCENARIOS` carries the identical `observedAt`
 * (`packages/evals/src/replay-scenarios.ts`'s own `evidence()` builder).
 * `REPLAY_AS_OF` is that instant, not a scenario-specific value picked to
 * make one scenario's predictions come out a particular way.
 */
test('@aic/evals exports REPLAY_AS_OF as the exact instant the whole replay corpus was recorded', () => {
  assert.equal(evals.REPLAY_AS_OF, '2026-08-26T15:00:00.000Z');
});

test('every evidence item in every ok fixture entry of every REPLAY_SCENARIOS scenario was observed at or before REPLAY_AS_OF', () => {
  const asOfMs = Date.parse(evals.REPLAY_AS_OF);
  assert.ok(Number.isFinite(asOfMs), 'fixture sanity: REPLAY_AS_OF must itself be a parseable timestamp');

  let itemsChecked = 0;
  for (const scenario of evals.REPLAY_SCENARIOS) {
    for (const entry of scenario.fixture.entries) {
      if (entry.result.status !== 'ok') continue;
      for (const item of entry.result.output) {
        itemsChecked += 1;
        assert.ok(
          Date.parse(item.observedAt) <= asOfMs,
          `${scenario.id}: evidence ${item.id} observedAt ${item.observedAt} must be <= REPLAY_AS_OF (${evals.REPLAY_AS_OF})`,
        );
      }
    }
  }
  assert.ok(itemsChecked > 0, 'fixture sanity: at least one ok evidence item must exist to check');
});

/* -------------------------------------------------------------------------- */
/* B. scriptedNodes/modelNodes carry the canonical prediction nodes          */
/* -------------------------------------------------------------------------- */

/**
 * Proven by BEHAVIOUR, not identity or source text — the same discipline
 * `test/lane-arms.test.mjs`'s own termination/derive_hypothesis_state row
 * (AIC-119 slice 3) already holds itself to. `replayBackedNodes`'s own
 * `derive_predictions`/`evaluate_predictions` are trace-only no-ops that
 * always answer `{}`, so this row can only pass once the canonical nodes are
 * wired in.
 *
 * `derive_predictions` and `evaluate_predictions` are exercised as two
 * separate calls, never one: `evaluate_predictions` evaluates only what
 * `state.predictions` already carries.
 */
test('scriptedNodes(record) and modelNodes(record, port) carry the canonical derive_predictions and evaluate_predictions: a matching connection-pool-exhaustion fact observed at REPLAY_AS_OF confirms the derived prediction with one rule assessment, and the same fact one millisecond later confirms nothing', async () => {
  const { scriptedNodes, modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = calibrationExecutionInput();
  const fakePort = {
    async complete() {
      throw new Error('neither derive_predictions nor evaluate_predictions may ever reach a model port');
    },
  };

  for (const nodes of [scriptedNodes(input), modelNodes(input, fakePort)]) {
     
    const derived = await nodes.derive_predictions(poolHypothesisState());
    assert.equal(derived.predictions.length, 1, 'derive_predictions must derive exactly one prediction for the pool hypothesis');
    assert.equal(derived.predictions[0].hypothesisId, 'h-1');
    assert.equal(derived.predictions[0].status, 'untested');

     
    const confirmed = await nodes.evaluate_predictions(
      poolHypothesisState({ observedAt: evals.REPLAY_AS_OF, predictions: derived.predictions }),
    );
    assert.equal(confirmed.predictions.length, 1, 'the derived prediction must change status to confirmed');
    assert.equal(confirmed.predictions[0].status, 'confirmed');
    assert.equal(confirmed.assessments.length, 1);
    assert.equal(confirmed.assessments[0].producedBy, 'rule');
    assert.equal(confirmed.assessments[0].effect, 'supports');

     
    const late = await nodes.evaluate_predictions(
      poolHypothesisState({ observedAt: ONE_MS_AFTER_REPLAY_AS_OF, predictions: derived.predictions }),
    );
    assert.equal(late.assessments.length, 0, 'evidence observed after REPLAY_AS_OF must contribute no assessment: the lane\'s asOf is REPLAY_AS_OF');
    assert.ok(late.predictions.every((prediction) => prediction.status === 'untested'));
  }
});

/* -------------------------------------------------------------------------- */
/* C. the scripted control arm stays prediction-free                         */
/* -------------------------------------------------------------------------- */

/**
 * `scriptedNodes`'s own `generate_hypotheses` (`replayBackedNodes`) creates a
 * hypothesis carrying no `cause` at all, and `challenge_hypothesis`'s
 * alternative carries none either — so `derivePredictions`'s rule 1 ("a
 * hypothesis with no cause gets no predictions") empties this arm on every
 * edge that could otherwise derive one, whichever derive_predictions
 * implementation is wired in.
 */
test('running the real kernel over a calibration record with scriptedNodes ends with predictions: [] and no producedBy: "rule" assessment', async () => {
  const { scriptedNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('bad-deployment');

  const investigationGraph = graph.createInvestigationGraph({ nodes: scriptedNodes(input) });
  const result = await investigationGraph.execute({ kind: 'start', state: initialStateFor(input) });

  assert.deepEqual(result.predictions, []);
  assert.ok(
    result.assessments.every((assessment) => assessment.producedBy !== 'rule'),
    'a causeless hypothesis must never receive a rule-produced assessment',
  );
});

/* -------------------------------------------------------------------------- */
/* D. the calibration outcome matrix, pinned as literals                     */
/* -------------------------------------------------------------------------- */

function replayFixtureFor(fixture) {
  return {
    version: fixture.version,
    responses: Object.fromEntries(
      fixture.entries.map(({ toolId, input, result }) => [
        createReplayFixtureKey(toolId, input),
        result,
      ]),
    ),
  };
}

/**
 * The evidence a scenario's own fixture replays, with `Evidence.observation`
 * merged on exactly as the lane merges it — through `ReplayToolAdapter` and
 * `evals.createObservationAnnotator()`, the same two production pieces
 * `test/fixtures/benchmark-experiment.mjs`'s `replayBackedNodes` uses. This
 * function only reshapes a scenario's fixture into the constructor's input
 * shape; the merge itself happens inside `ReplayToolAdapter`, never
 * re-implemented here.
 */
async function observedEvidenceFor(scenario) {
  const replay = new ReplayToolAdapter(replayFixtureFor(scenario.fixture), {
    observations: evals.createObservationAnnotator(),
  });
  const evidence = [];
  for (const entry of scenario.fixture.entries) {
     
    const replayed = await replay.execute(entry.toolId, entry.input);
    if (replayed.status === 'ok') evidence.push(...replayed.output);
  }
  return evidence;
}

/**
 * Identifies which `PREDICTION_TEMPLATES` template a derived prediction came
 * from by its `expectedIfTrue` shape — `Prediction` carries no template key
 * of its own. Robust to every template the calibration mechanisms
 * (`deployment-regression`, `connection-pool-exhaustion`, `cache-stampede`)
 * register; a template outside those three throws rather than misclassifying.
 */
function templateKeyOfPrediction(prediction) {
  const [first] = prediction.expectedIfTrue;
  assert.ok(first, `prediction ${prediction.id} must carry at least one expectedIfTrue observation`);
  if (first.form === 'deployment-in-window') return 'deployment-before-onset';
  if (first.form === 'signal-state' && first.signal === 'error-rate') return 'error-rate-elevated';
  if (first.form === 'signal-state' && first.signal === 'connection-pool') return 'pool-at-limit';
  if (first.form === 'signal-state' && first.signal === 'worker-saturation') return 'workers-at-limit';
  if (first.form === 'log-class-in-window') return 'refill-activity';
  throw new Error(`cannot classify prediction template from expectedIfTrue: ${JSON.stringify(prediction.expectedIfTrue)}`);
}

/**
 * Derives, then evaluates, over one hypothesis carrying `cause` against one
 * scenario's own replayed evidence, evaluated at REPLAY_AS_OF — never the
 * other order, per this file's header.
 */
async function evaluateRootCauseAgainstScenario({ cause, scenario }) {
  const deriveNode = graph.createDerivePredictions();
  const evaluateNode = graph.createEvaluatePredictions({ asOf: () => evals.REPLAY_AS_OF });

  const hypothesis = { id: 'h-1', statement: 'the scenario\'s own root cause', createdBy: 'initial', cause };
  const evidence = await observedEvidenceFor(scenario);
  const base = { hypotheses: [hypothesis], predictions: [], evidence, assessments: [] };
  const derived = deriveNode(base);
  const afterDerive = { ...base, predictions: domain.upsertById(base.predictions, derived.predictions) };
  // The evaluate node returns deltas for the `upsertById` reducer; applying
  // them the same way gives the state a graph run would hold after the node.
  const evaluated = evaluateNode(afterDerive);
  const predictions = domain.upsertById(afterDerive.predictions, evaluated.predictions);
  const assessments = domain.upsertById(afterDerive.assessments, evaluated.assessments);

  const statuses = Object.fromEntries(
    predictions.map((prediction) => [templateKeyOfPrediction(prediction), prediction.status]),
  );
  return { statuses, assessmentCount: assessments.length, predictions };
}

/**
 * Hand-computed and measured against the corpus's own `OBSERVATION_ANNOTATIONS`
 * facts (`packages/evals/src/observation-annotations.ts`) and
 * `STRUCTURAL_GROUND_TRUTH` root causes — this is the registered expectation.
 * Hold-out scenarios (`BENCHMARK_SCENARIO_PARTITIONS.holdout`) are
 * deliberately NOT evaluated here.
 */
const EXPECTED_CALIBRATION_PREDICTION_MATRIX = {
  'bad-deployment': {
    statuses: { 'deployment-before-onset': 'untested', 'error-rate-elevated': 'untested' },
    assessmentCount: 0,
  },
  'db-pool-exhaustion': {
    statuses: { 'pool-at-limit': 'untested' },
    assessmentCount: 0,
  },
  'deployment-caused-incident-a': {
    statuses: { 'deployment-before-onset': 'confirmed', 'error-rate-elevated': 'untested' },
    assessmentCount: 1,
  },
  'dependency-caused-incident-b': {
    statuses: { 'pool-at-limit': 'untested' },
    assessmentCount: 0,
  },
  'transient-self-resolved': {
    statuses: { 'workers-at-limit': 'untested', 'refill-activity': 'untested' },
    assessmentCount: 0,
  },
  'challenge-keeps-leader': {
    statuses: { 'deployment-before-onset': 'confirmed', 'error-rate-elevated': 'untested' },
    assessmentCount: 1,
  },
};

test('BENCHMARK_SCENARIO_PARTITIONS.calibration scenarios with no STRUCTURAL_GROUND_TRUTH rootCause are exactly false-alert and multiple-plausible-causes', () => {
  const skipped = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.filter(
    (scenarioId) => evals.STRUCTURAL_GROUND_TRUTH[scenarioId]?.rootCause === undefined,
  );
  assert.deepEqual(skipped.sort(), ['false-alert', 'multiple-plausible-causes'].sort());
});

test('the calibration outcome matrix: evaluating each rootCause-carrying scenario\'s own root cause against its own replayed evidence at REPLAY_AS_OF equals the registered literal matrix, and no prediction is ever refuted', async () => {
  assert.deepEqual(
    Object.keys(EXPECTED_CALIBRATION_PREDICTION_MATRIX).sort(),
    evals.BENCHMARK_SCENARIO_PARTITIONS.calibration
      .filter((scenarioId) => evals.STRUCTURAL_GROUND_TRUTH[scenarioId]?.rootCause !== undefined)
      .sort(),
    'fixture sanity: the registered matrix must cover exactly the rootCause-carrying calibration scenarios',
  );

  for (const [scenarioId, expected] of Object.entries(EXPECTED_CALIBRATION_PREDICTION_MATRIX)) {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    assert.ok(scenario, `REPLAY_SCENARIOS must carry ${scenarioId}`);
    const { rootCause } = evals.STRUCTURAL_GROUND_TRUTH[scenarioId];

     
    const observed = await evaluateRootCauseAgainstScenario({ cause: rootCause, scenario });

    assert.deepEqual(observed.statuses, expected.statuses, `${scenarioId}: prediction statuses must equal the registered matrix`);
    assert.equal(observed.assessmentCount, expected.assessmentCount, `${scenarioId}: assessment count must equal the registered matrix`);
    assert.ok(
      observed.predictions.every((prediction) => prediction.status !== 'refuted'),
      `${scenarioId}: no prediction may be refuted`,
    );
  }
});

test('distractor: dependency-caused-incident-b evaluated against a cause that is not its own root cause still confirms deployment-before-onset, because the template only checks whether a deployment landed pre-onset', async () => {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === 'dependency-caused-incident-b');
  assert.ok(scenario, 'REPLAY_SCENARIOS must carry dependency-caused-incident-b');

  const distractorCause = { component: 'payments', mechanism: 'deployment-regression' };
  assert.notDeepEqual(
    distractorCause,
    evals.STRUCTURAL_GROUND_TRUTH['dependency-caused-incident-b'].rootCause,
    'fixture sanity: the distractor cause must not be this scenario\'s own root cause',
  );

  const observed = await evaluateRootCauseAgainstScenario({ cause: distractorCause, scenario });

  assert.equal(observed.statuses['deployment-before-onset'], 'confirmed');
  assert.equal(observed.statuses['error-rate-elevated'], 'untested');
  assert.equal(observed.assessmentCount, 1);
});

/* -------------------------------------------------------------------------- */
/* E. through the real kernel, with a fake port for the four reasoning roles */
/* -------------------------------------------------------------------------- */

/** Tells the four model-backed roles apart by the answer shape they declared. */
function roleFromOutputSchema(outputSchema) {
  const keys = new Set(Object.keys(outputSchema?.properties ?? {}));
  if (keys.has('hypotheses')) return 'generate_hypotheses';
  if (keys.has('assessments')) return 'interpret_residual_evidence';
  if (keys.has('alternative') && keys.has('discriminatingTests')) return 'challenge_hypothesis';
  if (keys.has('kind') && keys.has('causes')) return 'propose_conclusion';
  throw new Error(`fake port cannot classify a request from its outputSchema keys: ${[...keys].join(', ')}`);
}

/**
 * A fake `ModelPort` that answers a schema-valid document for whichever role
 * asked, giving `generate_hypotheses` a hypothesis whose cause matches
 * `deployment-caused-incident-a`'s own root cause and giving
 * `challenge_hypothesis` an alternative with an unrelated cause — enough for
 * the graph to reach a stop kind, never enough to claim anything about model
 * quality.
 */
function fakePortFor({ leaderId, alternativeId }) {
  return {
    async complete(request) {
      const role = roleFromOutputSchema(request.outputSchema);
      let document;
      if (role === 'generate_hypotheses') {
        document = {
          hypotheses: [{
            id: leaderId,
            statement: 'a payments deployment broke the service',
            cause: { component: 'payments', mechanism: 'deployment-regression' },
          }],
        };
      } else if (role === 'interpret_residual_evidence') {
        document = { assessments: [] };
      } else if (role === 'challenge_hypothesis') {
        document = {
          alternative: {
            id: alternativeId,
            statement: 'the inventory-api pool stayed occupied instead',
            cause: { component: 'aic124c-alt-component', mechanism: 'connection-pool-exhaustion' },
          },
          discriminatingTests: [{
            id: 'aic124c-challenge-test-1',
            predictionId: 'aic124c-challenge-prediction-1',
            tool: 'metrics',
            input: {},
            cost: 'cheap',
            status: 'planned',
          }],
        };
      } else {
        document = { kind: 'inconclusive', causes: [] };
      }
      return {
        text: JSON.stringify(document),
        modelId: 'fake-model-under-test',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

test('through the real kernel, modelNodes(record, port) gives a model-proposed hypothesis a confirmed prediction and one rule assessment, and gives the challenge alternative its own predictions too', async () => {
  const { modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('deployment-caused-incident-a');
  const port = fakePortFor({ leaderId: 'aic124c-leader', alternativeId: 'aic124c-alternative' });

  const nodes = modelNodes(input, port);
  const investigationGraph = graph.createInvestigationGraph({ nodes });
  const result = await investigationGraph.execute({ kind: 'start', state: initialStateFor(input) });

  const leaderPredictions = result.predictions.filter((prediction) => prediction.hypothesisId === 'aic124c-leader');
  assert.ok(leaderPredictions.length > 0, 'the leader must carry at least one prediction');
  assert.ok(
    leaderPredictions.some((prediction) => prediction.status === 'confirmed'),
    'a deployment-before-onset prediction must confirm against this scenario\'s own evidence',
  );
  const leaderRuleAssessments = result.assessments.filter(
    (assessment) => assessment.hypothesisId === 'aic124c-leader' && assessment.producedBy === 'rule',
  );
  assert.equal(leaderRuleAssessments.length, 1);

  const alternativePredictions = result.predictions.filter(
    (prediction) => prediction.hypothesisId === 'aic124c-alternative',
  );
  assert.ok(
    alternativePredictions.length > 0,
    'the challenge alternative must receive its own predictions, derived by the challenge wrapper',
  );
});

/* -------------------------------------------------------------------------- */
/* F. the kernel's own challenge wrapper derives predictions for the         */
/*    alternative, independently of any lane                                 */
/* -------------------------------------------------------------------------- */

const CHALLENGE_WRAPPER_CONTROL = Object.freeze({
  runId: 'run-aic124c-challenge-wrapper',
  schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
  statusRulesVersion: domain.STATUS_RULES_VERSION,
  phase: 'investigating',
  maxIterations: 4,
  llmCallBudget: 8,
  reservedChallengeBudget: 2,
  challengeRounds: 0,
  iterationsUsed: 0,
  llmCallsUsed: 0,
  resumeCount: 0,
  humanReview: false,
});

/**
 * A minimal, otherwise-inert lifecycle: every node not named by the caller is
 * a no-op returning `{}`. `termination_check` answers `challenge-required`
 * once, then a fixed terminal stop kind, so the graph runs exactly one
 * challenge round and ends.
 */
function challengeWrapperNodes({ generateHypotheses, deriveePredictions, challengeHypothesisResult, executeSpy }) {
  let terminationCalls = 0;
  const noop = async () => ({});
  return {
    normalize_incident: noop,
    collect_baseline: noop,
    generate_hypotheses: generateHypotheses,
    derive_predictions: deriveePredictions,
    plan_investigation: noop,
    async execute_investigation(state) {
      executeSpy(state);
      return {};
    },
    evaluate_predictions: noop,
    interpret_residual_evidence: noop,
    derive_hypothesis_state: noop,
    async termination_check(state) {
      terminationCalls += 1;
      if (terminationCalls === 1) {
        return { route: 'challenge-required', leaderId: state.hypotheses[0]?.id };
      }
      return { route: 'terminal', stopKind: 'stalled' };
    },
    async challenge_hypothesis() {
      return challengeHypothesisResult;
    },
    propose_conclusion: noop,
  };
}

function challengeWrapperInitialState() {
  return {
    incident: scopedIncident('incident-aic124c-challenge-wrapper'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: CHALLENGE_WRAPPER_CONTROL,
  };
}

const ALTERNATIVE_HYPOTHESIS = Object.freeze({
  id: 'aic124c-alt',
  statement: 'the alternative candidate cause',
  createdBy: 'challenge',
  cause: { component: 'aic124c-alt-pool', mechanism: 'connection-pool-exhaustion' },
});

const ALTERNATIVE_DISCRIMINATING_TEST = Object.freeze({
  id: 'aic124c-alt-test',
  predictionId: 'aic124c-alt-prediction',
  tool: 'metrics',
  input: {},
  cost: 'cheap',
  status: 'planned',
});

test('the challenge round derives predictions for the alternative, through createDerivePredictions, before the challenge edge reaches execute_investigation for the round — and leaves the leader\'s already-derived prediction unchanged', async () => {
  const executeCalls = [];
  const canonicalDerive = graph.createDerivePredictions();

  const nodes = challengeWrapperNodes({
    async generateHypotheses() {
      return {
        hypotheses: [{
          id: 'aic124c-leader',
          statement: 'the leader candidate cause',
          createdBy: 'initial',
          cause: { component: 'aic124c-leader-pool', mechanism: 'connection-pool-exhaustion' },
        }],
      };
    },
    deriveePredictions: canonicalDerive,
    challengeHypothesisResult: {
      alternative: ALTERNATIVE_HYPOTHESIS,
      discriminatingTests: [ALTERNATIVE_DISCRIMINATING_TEST],
    },
    executeSpy: (state) => executeCalls.push(state),
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });
  const finalState = await investigationGraph.execute({ kind: 'start', state: challengeWrapperInitialState() });

  assert.equal(executeCalls.length, 2, 'execute_investigation must run once before the challenge and once for the challenge round');
  const [beforeChallenge, forChallenge] = executeCalls;

  const leaderPredictionBefore = beforeChallenge.predictions.find(
    (prediction) => prediction.hypothesisId === 'aic124c-leader',
  );
  assert.ok(leaderPredictionBefore, 'the leader must already carry a derived prediction on the first execute_investigation entry');

  const leaderPredictionForChallenge = forChallenge.predictions.find(
    (prediction) => prediction.hypothesisId === 'aic124c-leader',
  );
  assert.deepEqual(
    leaderPredictionForChallenge,
    leaderPredictionBefore,
    'the challenge round\'s derive call must not reset or alter the leader\'s already-derived prediction',
  );

  const alternativePredictionForChallenge = forChallenge.predictions.find(
    (prediction) => prediction.hypothesisId === 'aic124c-alt',
  );
  assert.ok(
    alternativePredictionForChallenge,
    'the alternative must already carry a derived prediction when execute_investigation runs for the challenge round',
  );
  assert.equal(alternativePredictionForChallenge.status, 'untested');

  assert.equal(finalState.control.stopKind, 'stalled');
});

test('the challenge round applies only the predictions key from what derive_predictions returns, ignoring any other key a derive node might carry', async () => {
  const executeCalls = [];

  function deriveIgnoringExtraKeys(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { predictions: [] };
    return {
      predictions: [{
        id: 'aic124c-stub-alt-prediction',
        hypothesisId: alternative.id,
        statement: 'a stub prediction for the alternative',
        observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
        expectedIfTrue: [],
        expectedIfFalse: [],
        status: 'untested',
      }],
      // A key no derive_predictions contract declares: the wrapper must not
      // let it reach state, however the node's own bug produced it.
      hypotheses: [{ id: 'aic124c-sneaky', statement: 'must never reach state', createdBy: 'initial' }],
    };
  }

  const nodes = challengeWrapperNodes({
    async generateHypotheses() {
      // No cause: this row isolates the challenge-time derive call, so the
      // leader must derive nothing on the ordinary lifecycle edge.
      return { hypotheses: [{ id: 'aic124c-leader', statement: 'the leader candidate cause', createdBy: 'initial' }] };
    },
    deriveePredictions: deriveIgnoringExtraKeys,
    challengeHypothesisResult: {
      alternative: ALTERNATIVE_HYPOTHESIS,
      discriminatingTests: [ALTERNATIVE_DISCRIMINATING_TEST],
    },
    executeSpy: (state) => executeCalls.push(state),
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });
  const finalState = await investigationGraph.execute({ kind: 'start', state: challengeWrapperInitialState() });

  assert.equal(executeCalls.length, 2);
  const [, forChallenge] = executeCalls;

  assert.ok(
    forChallenge.predictions.some((prediction) => prediction.id === 'aic124c-stub-alt-prediction'),
    'the predictions key the derive node returned must reach state before the challenge round\'s execute_investigation',
  );
  assert.ok(
    !finalState.hypotheses.some((hypothesis) => hypothesis.id === 'aic124c-sneaky'),
    'a key other than predictions on the derive node\'s result must never reach state',
  );
});

/* -------------------------------------------------------------------------- */
/* G. the challenge-time derive call holds the same line as the wrapped edge  */
/* -------------------------------------------------------------------------- */

/**
 * A leader with no cause, so the ordinary `derive_predictions` lifecycle edge
 * derives nothing for it and every row below can attribute whatever it sees
 * to the challenge-time call alone.
 */
function causelessLeaderHypotheses() {
  return { hypotheses: [{ id: 'aic124c-leader', statement: 'the leader candidate cause', createdBy: 'initial' }] };
}

test('the challenge round refuses a derive_predictions node that returns routing (Command or Send) instead of a state update, the way the wrapped lifecycle edge does', async () => {
  function deriveReturningRoutingForChallenge(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { predictions: [] };
    return new Command({ goto: 'execute_investigation' });
  }

  const nodes = challengeWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: deriveReturningRoutingForChallenge,
    challengeHypothesisResult: {
      alternative: ALTERNATIVE_HYPOTHESIS,
      discriminatingTests: [ALTERNATIVE_DISCRIMINATING_TEST],
    },
    executeSpy: () => {},
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });

  await assert.rejects(
    investigationGraph.execute({ kind: 'start', state: challengeWrapperInitialState() }),
    (error) => {
      assert.match(
        String(error?.message ?? ''),
        /derive_predictions|routing/i,
        'the refusal must name derive_predictions or routing, the way preserveGraphOwnedControl\'s own refusal names what it refused',
      );
      return true;
    },
    'a Command returned by derive_predictions at challenge time must not be silently dropped: the run must reject rather than continue with the routing discarded',
  );
});

test('the challenge round adds the derive node\'s own declaredLlmCalls to control.llmCallsUsed, the same channel the wrapped lifecycle edge reads', async () => {
  function deriveWithDeclaredCalls(declaredLlmCalls) {
    return (state) => {
      const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
      if (alternative === undefined) return { predictions: [] };
      const predictions = [{
        id: 'aic124c-declared-calls-alt-prediction',
        hypothesisId: alternative.id,
        statement: 'a stub prediction for the declared-calls row',
        observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
        expectedIfTrue: [],
        expectedIfFalse: [],
        status: 'untested',
      }];
      if (declaredLlmCalls === undefined) return { predictions };
      return { predictions, declaredLlmCalls };
    };
  }

  async function runWith(declaredLlmCalls) {
    const nodes = challengeWrapperNodes({
      generateHypotheses: causelessLeaderHypotheses,
      deriveePredictions: deriveWithDeclaredCalls(declaredLlmCalls),
      challengeHypothesisResult: {
        alternative: ALTERNATIVE_HYPOTHESIS,
        discriminatingTests: [ALTERNATIVE_DISCRIMINATING_TEST],
      },
      executeSpy: () => {},
    });
    const investigationGraph = graph.createInvestigationGraph({ nodes });
    return investigationGraph.execute({ kind: 'start', state: challengeWrapperInitialState() });
  }

  const baseline = await runWith(undefined);
  const declaring = await runWith(1);

  assert.equal(
    declaring.control.llmCallsUsed,
    baseline.control.llmCallsUsed + 1,
    'declaring one llm call at challenge time must spend exactly one more than the same run declaring nothing',
  );
});

test('the challenge round reads only an own "predictions" property off what derive_predictions returns, never one its prototype supplies', async () => {
  const decoyPrediction = Object.freeze({
    id: 'aic124c-prototype-decoy-prediction',
    hypothesisId: ALTERNATIVE_HYPOTHESIS.id,
    statement: 'a prototype-inherited decoy prediction',
    observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
    expectedIfTrue: [],
    expectedIfFalse: [],
    status: 'untested',
  });

  // The decoy is inherited from the result object's OWN prototype rather than
  // planted on `Object.prototype`: a global decoy also reaches state through
  // LangGraph's channel writes for every other node's update, before the
  // challenge round runs, so it cannot tell this read apart from the rest of
  // the graph. A per-object prototype isolates exactly the challenge-round
  // read of the derive result.
  const nodes = challengeWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: async (state) =>
      state.hypotheses.some((hypothesis) => hypothesis.createdBy === 'challenge')
        ? Object.create({ predictions: [decoyPrediction] })
        : {},
    challengeHypothesisResult: {
      alternative: ALTERNATIVE_HYPOTHESIS,
      discriminatingTests: [ALTERNATIVE_DISCRIMINATING_TEST],
    },
    executeSpy: () => {},
  });
  const investigationGraph = graph.createInvestigationGraph({ nodes });

  const finalState = await investigationGraph.execute({ kind: 'start', state: challengeWrapperInitialState() });

  assert.ok(
    !finalState.predictions.some((prediction) => prediction.id === decoyPrediction.id),
    'a derive_predictions result carrying no own "predictions" property must never give the alternative a prediction from its prototype',
  );
});

test('the challenge round rejects a derive_predictions result whose predictions key is not an array', async () => {
  function deriveWithInvalidPredictionsShape(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { predictions: [] };
    return { predictions: 'not-an-array' };
  }

  const nodes = challengeWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: deriveWithInvalidPredictionsShape,
    challengeHypothesisResult: {
      alternative: ALTERNATIVE_HYPOTHESIS,
      discriminatingTests: [ALTERNATIVE_DISCRIMINATING_TEST],
    },
    executeSpy: () => {},
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });

  await assert.rejects(
    investigationGraph.execute({ kind: 'start', state: challengeWrapperInitialState() }),
    'a non-array predictions value from derive_predictions at challenge time must reject rather than corrupt state.predictions',
  );
});

/* -------------------------------------------------------------------------- */
/* H. once predictions are wired, a model role sees the verdicts, not the    */
/*    observation facts behind them                                          */
/* -------------------------------------------------------------------------- */

test('a model role is shown the derived prediction verdicts and rule assessments, never the observation facts behind them', async () => {
  const { modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('deployment-caused-incident-a');
  const leaderId = 'aic124c-info-leader';
  const alternativeId = 'aic124c-info-alternative';
  const innerPort = fakePortFor({ leaderId, alternativeId });
  const capturedRequests = [];
  const capturingFakePort = {
    async complete(request) {
      capturedRequests.push(request);
      return innerPort.complete(request);
    },
  };

  const nodes = modelNodes(input, capturingFakePort);
  const investigationGraph = graph.createInvestigationGraph({ nodes });
  const result = await investigationGraph.execute({ kind: 'start', state: initialStateFor(input) });

  const leaderPredictions = result.predictions.filter((prediction) => prediction.hypothesisId === leaderId);
  const confirmedPrediction = leaderPredictions.find((prediction) => prediction.status === 'confirmed');
  assert.ok(confirmedPrediction, 'fixture sanity: the leader must reach a confirmed prediction for this row to check anything');

  const ruleAssessment = result.assessments.find(
    (assessment) => assessment.hypothesisId === leaderId && assessment.producedBy === 'rule',
  );
  assert.ok(ruleAssessment, 'fixture sanity: the confirmed prediction must carry a rule-produced assessment');

  const interpretRequests = capturedRequests.filter(
    (request) => roleFromOutputSchema(request.outputSchema) === 'interpret_residual_evidence',
  );
  assert.ok(interpretRequests.length > 0, 'fixture sanity: interpret_residual_evidence must be called at least once');
  const lastInterpretRequest = interpretRequests[interpretRequests.length - 1];

  assert.ok(
    lastInterpretRequest.prompt.includes(confirmedPrediction.id),
    'the prompt must show the confirmed prediction\'s own id',
  );
  assert.match(
    lastInterpretRequest.prompt,
    /"status":\s*"confirmed"/,
    'the prompt must show the prediction\'s confirmed status',
  );
  assert.ok(
    lastInterpretRequest.prompt.includes(ruleAssessment.id),
    'the prompt must show the rule assessment\'s own id',
  );
  assert.match(
    lastInterpretRequest.prompt,
    /"producedBy":\s*"rule"/,
    'the prompt must show that the assessment was produced by the rule evaluator',
  );

  // `.includes('observation')` alone would false-positive on a derived
  // prediction's own `observationVersion` field (a Prediction key, always
  // shown) — the exact key form below is what the observation-merge row this
  // reuses actually checks for on a state that carries no predictions.
  assert.equal(
    lastInterpretRequest.prompt.includes('"observation":'),
    false,
    'the prompt must never carry the key "observation" (evidence[].observation)',
  );
  assert.equal(
    lastInterpretRequest.prompt.includes('coverage'),
    false,
    'the prompt must never carry a fact field unique to the observation channel (ObservedFact\'s own "coverage")',
  );
});

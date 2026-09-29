/**
 * AIC-125 slice e: both graph arms of the lanes run the real investigation
 * loop. `scripts/lane-arms.mjs`'s `scriptedNodes(record)` uses
 * `createPlanInvestigation()` and `createExecuteInvestigation({ execute })`,
 * where `execute` is `createPlannedReplayExecutor({ fixture: record.fixture,
 * routes: INVESTIGATION_ROUTES, annotate: evals.createObservationAnnotator()
 * }).execute` (`@aic/tools/replay`), and `modelNodes(record, port)` inherits
 * both. The model arm sees only what its own predictions (and the challenge
 * round) asked for — a subset of the recorded corpus the naive arm reads —
 * and the scripted-control arm, whose hypotheses carry no cause, fetches
 * nothing. Registered in docs/evidence/preregistration/v0.2-four-arm-supplement-7.md.
 *
 * Every row below reaches `modelNodes`/`scriptedNodes` through
 * `scripts/lane-arms.mjs`, never a hand-rolled copy — `.claude/rules/
 * invariants.md` ("one mechanism, one implementation").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';
import * as graph from '@aic/graph';
import { createPlannedReplayExecutor } from '@aic/tools/replay';

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

function baseControl(overrides = {}) {
  return {
    runId: 'run-aic125e-plan-execute',
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
 * `modelNodes` need, copied rather than imported — not exported by
 * `test/lane-arms.test.mjs`, and this suite's own convention (mirroring that
 * file's header) is that a row needing `scripts/lane-arms.mjs` builds this
 * input inline rather than depending on another test file's private helper.
 */
function executionInputFor(scenarioId) {
  const records = evals.createCalibrationBenchmarkPlan({
    experimentId: 'aic-125e-plan-execute-wiring',
    runsPerScenario: 3,
    metadata: {},
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

/** The full initial `IncidentState` a benchmark run starts from — copied from prediction-wiring.test.mjs's own helper of the same name. */
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

function refusingPort(label = 'a model port') {
  return {
    async complete() {
      throw new Error(`${label} must never be reached by this row`);
    },
  };
}

/**
 * Identifies which `PREDICTION_TEMPLATES` template a derived prediction came
 * from by its `expectedIfTrue` shape — `Prediction` carries no template key
 * of its own. Copied from prediction-wiring.test.mjs's own helper of the same
 * name (this suite's convention: a row needing it builds its own copy).
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

/** Tells the four model-backed roles apart by the answer shape they declared — copied from prediction-wiring.test.mjs. */
function roleFromOutputSchema(outputSchema) {
  const keys = new Set(Object.keys(outputSchema?.properties ?? {}));
  if (keys.has('hypotheses')) return 'generate_hypotheses';
  if (keys.has('assessments')) return 'interpret_residual_evidence';
  if (keys.has('alternative') && keys.has('discriminatingTests')) return 'challenge_hypothesis';
  if (keys.has('kind') && keys.has('causes')) return 'propose_conclusion';
  throw new Error(`fake port cannot classify a request from its outputSchema keys: ${[...keys].join(', ')}`);
}

/* -------------------------------------------------------------------------- */
/* 1. modelNodes(record, port): plan_investigation is the canonical planner,  */
/*    execute_investigation executes ONLY planned tests through the planned- */
/*    replay port; scriptedNodes(record) still replays every fixture entry   */
/* -------------------------------------------------------------------------- */

test('modelNodes(record, port).plan_investigation plans exactly one test for one untested prediction whose planned request has a matching recorded quantity, and execute_investigation yields exactly one trial carrying exactly the matching evidence', async () => {
  const { modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('deployment-caused-incident-a');
  const nodes = modelNodes(input, refusingPort('modelNodes(record, port)'));

  const hypothesis = {
    id: 'h-1',
    statement: "a payments deployment broke the service",
    createdBy: 'initial',
    cause: { component: 'payments', mechanism: 'deployment-regression' },
  };
  const baseState = {
    hypotheses: [hypothesis],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: baseControl(),
  };

  const derived = await nodes.derive_predictions(baseState);
  const onePrediction = derived.predictions.find(
    (prediction) => templateKeyOfPrediction(prediction) === 'deployment-before-onset',
  );
  assert.ok(onePrediction, 'fixture sanity: derive_predictions must produce a deployment-before-onset prediction');
  assert.equal(onePrediction.status, 'untested');

  const stateWithPrediction = { ...baseState, predictions: [onePrediction] };
  const planned = await nodes.plan_investigation(stateWithPrediction);
  assert.equal(planned.tests.length, 1, 'exactly one untested prediction must plan exactly one test');
  assert.equal(planned.tests[0].status, 'planned');
  assert.equal(planned.tests[0].tool, 'deployments');
  assert.deepEqual(planned.tests[0].input, { service: 'payments', window: 'pre-onset' });

  const stateWithTest = { ...stateWithPrediction, tests: planned.tests };
  const executed = await nodes.execute_investigation(stateWithTest);

  assert.equal(executed.trials.length, planned.tests.length, 'trial count must equal planned test count');
  assert.equal(executed.trials.length, 1);
  assert.equal(executed.trials[0].status, 'ok');
  assert.equal(executed.evidence.length, 1);
  assert.equal(executed.evidence[0].id, 'confirmation-deploy-v17');

  // The scenario's other recorded fixture entry (a `dependencies` call
  // nobody planned) is never replayed.
  assert.ok(
    !executed.evidence.some((item) => item.id === 'payments-dependencies-healthy'),
    "a fixture entry nobody planned (the scenario's own dependencies call) must never be replayed",
  );
});

/**
 * AIC-125 supplement 7 (design owner ruling): `scriptedNodes` no longer keeps
 * its own full-corpus sweep — its `execute_investigation` is now the very
 * same `createExecuteInvestigation({ execute: createPlannedReplayExecutor(...) })`
 * `modelNodes` uses (`scripts/lane-arms.mjs`), so it too runs only the tests
 * already `planned` in state, in state order, and replays nothing on its own.
 * This retitled row proves that by behaviour rather than asserting a stale
 * "unchanged" claim the redesign made false: a state with no planned test
 * gets no sweep at all, and a state with one planned test gets exactly one
 * trial from exactly that test.
 */
test('scriptedNodes(record) executes only planned tests, through the same canonical executor modelNodes uses: a state with no planned test replays nothing from the fixture, and a state with one planned test yields exactly one trial', async () => {
  const { scriptedNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('deployment-caused-incident-a');
  const nodes = scriptedNodes(input);

  const noTestsResult = await nodes.execute_investigation({ tests: [], trials: [], evidence: [] });
  assert.deepEqual(
    noTestsResult,
    { tests: [], trials: [], evidence: [] },
    'with no planned test, scriptedNodes must replay nothing from the fixture — the full-corpus sweep is gone',
  );

  const plannedTest = {
    id: 'aic125e-scripted-test-1',
    predictionId: 'aic125e-scripted-prediction-1',
    tool: 'deployments',
    input: { service: 'payments', window: 'pre-onset' },
    cost: 'cheap',
    status: 'planned',
  };
  const oneTestResult = await nodes.execute_investigation({
    tests: [plannedTest],
    trials: [],
    evidence: [],
    control: baseControl(),
  });
  assert.equal(oneTestResult.trials.length, 1, 'exactly one planned test must yield exactly one trial');
  assert.equal(oneTestResult.trials[0].status, 'ok');
  assert.deepEqual(oneTestResult.evidence.map((item) => item.id), ['confirmation-deploy-v17']);
  assert.ok(
    !oneTestResult.evidence.some((item) => item.id === 'payments-dependencies-healthy'),
    "the scenario's other recorded fixture entry (a dependencies call nobody planned) must never be replayed",
  );
});

/* -------------------------------------------------------------------------- */
/* 2. through the real kernel: plan-only invariants on deployment-caused-a    */
/* -------------------------------------------------------------------------- */

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
            cause: { component: 'aic125e-alt-component', mechanism: 'connection-pool-exhaustion' },
          },
          discriminatingTests: [{
            id: 'aic125e-challenge-test-1',
            predictionId: 'aic125e-challenge-prediction-1',
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

test('through the real kernel, modelNodes(record, port) on deployment-caused-incident-a produces trials only for planned or challenge-derived tests, confirms the deployment prediction from the evidence the planned request fetched, and leaves trialEvidenceViolations empty', async () => {
  const { modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('deployment-caused-incident-a');
  const port = fakePortFor({ leaderId: 'aic125e-leader', alternativeId: 'aic125e-alternative' });

  const nodes = modelNodes(input, port);
  const investigationGraph = graph.createInvestigationGraph({ nodes });
  const result = await investigationGraph.execute({ kind: 'start', state: initialStateFor(input) });

  // AIC-142: INVESTIGATION_ROUTES now names `dependencies` too (the
  // dependency-health signal routes to it — test/investigation-routes.test.mjs),
  // but no PREDICTION_TEMPLATES template emits a dependency-health
  // observation (this file › "no PREDICTION_TEMPLATES observation is a
  // signal-state observation of dependency-health or latency"), and this row's
  // fake challenge role proposes no dependencies test, so nothing this run
  // plans or proposes ever requests it — a
  // structural guarantee about which templates are in play, not "no route
  // names it" and not a per-scenario coincidence.
  assert.ok(
    result.trials.every((trial) => trial.tool !== 'dependencies'),
    'no trial may ever be for the dependencies tool: no current PREDICTION_TEMPLATES template emits a dependency-health observation',
  );
  assert.ok(
    !result.evidence.some((item) => item.id === 'payments-dependencies-healthy'),
    "the scenario's own dependencies evidence must never appear in final state",
  );

  const leaderPredictions = result.predictions.filter((prediction) => prediction.hypothesisId === 'aic125e-leader');
  const confirmedPrediction = leaderPredictions.find((prediction) => prediction.status === 'confirmed');
  assert.ok(confirmedPrediction, 'the deployment-before-onset prediction must confirm from the planned request\'s own evidence');
  assert.ok(
    result.evidence.some((item) => item.id === 'confirmation-deploy-v17'),
    'the evidence the planned request fetched must be exactly the scenario\'s own confirming item',
  );

  assert.deepEqual(
    domain.trialEvidenceViolations({ trials: result.trials, evidence: result.evidence }),
    [],
  );

  const testIds = new Set(result.tests.map((test) => test.id));
  for (const trial of result.trials) {
    assert.ok(testIds.has(trial.testId), `trial ${trial.id} must name a test still present in the final state`);
  }
  for (const item of result.evidence) {
    assert.ok(
      result.trials.some((trial) => trial.id === item.trialId),
      `evidence ${item.id} must trace back to a trial in the final state — every evidence item is one the port returned for a planned or challenge test`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 3. the information regime: the model arm's evidence is a SUBSET of the    */
/*    scripted arm's, over every calibration scenario                        */
/* -------------------------------------------------------------------------- */

/**
 * The model arm's plan-only evidence for one hypothesis over one scenario —
 * derive, then plan, then execute through `scripts/lane-arms.mjs`'s own
 * `modelNodes`, never a hand-rolled pipeline. A scenario with no
 * `STRUCTURAL_GROUND_TRUTH` rootCause gives the hypothesis no `cause` at all,
 * so `derive_predictions` derives nothing for it (rule 1: a causeless
 * hypothesis gets no predictions) and this correctly returns no evidence.
 */
async function modelPlanOnlyEvidenceIdsFor(scenarioId) {
  const { modelNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor(scenarioId);
  const nodes = modelNodes(input, refusingPort('modelNodes(record, port)'));

  const rootCause = evals.STRUCTURAL_GROUND_TRUTH[scenarioId]?.rootCause;
  const hypothesis = {
    id: 'h-1',
    statement: "the scenario's own root cause",
    createdBy: 'initial',
    ...(rootCause === undefined ? {} : { cause: rootCause }),
  };
  const baseState = {
    hypotheses: [hypothesis],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: baseControl(),
  };

  const derived = await nodes.derive_predictions(baseState);
  const stateWithPredictions = { ...baseState, predictions: derived.predictions };
  const planned = await nodes.plan_investigation(stateWithPredictions);
  const stateWithTests = { ...stateWithPredictions, tests: planned.tests };
  const executed = await nodes.execute_investigation(stateWithTests);

  return new Set(executed.evidence.map((item) => item.id));
}

/**
 * AIC-125 supplement 7: `scriptedNodes` no longer sweeps the full corpus on
 * its own either (see the retitled row above), so the model arm's plan-only
 * evidence can no longer be compared against "the scripted arm's full-corpus
 * evidence" — there is no such thing left to compare it to. What it IS still
 * a subset of is the full recorded corpus itself — what the naive arm reads,
 * a full dump of every entry `REPLAY_SCENARIOS` carries — read here directly
 * off the fixture, never through a node, so this stays an independent oracle
 * rather than one graph arm's reading of another.
 */
function fullCorpusOkEvidenceIdsFor(scenarioId) {
  const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
  assert.ok(scenario, `REPLAY_SCENARIOS must carry ${scenarioId}`);
  return new Set(
    scenario.fixture.entries
      .filter(({ result }) => result.status === 'ok')
      .flatMap(({ result }) => result.output.map(({ id }) => id)),
  );
}

test("for every calibration scenario, the model arm's plan-only evidence ids (derive → plan → execute for the ground-truth cause) are a subset of the scenario's own recorded ok evidence ids, and a strict subset for at least one scenario", async () => {
  let sawStrictSubset = false;

  for (const scenarioId of evals.BENCHMARK_SCENARIO_PARTITIONS.calibration) {
    // eslint-disable-next-line no-await-in-loop -- one scenario at a time, matching this suite's other sweeps
    const modelIds = await modelPlanOnlyEvidenceIdsFor(scenarioId);
    const fullCorpusIds = fullCorpusOkEvidenceIdsFor(scenarioId);

    for (const id of modelIds) {
      assert.ok(
        fullCorpusIds.has(id),
        `${scenarioId}: the model arm's evidence id ${id} must also appear in the scenario's own recorded ok evidence`,
      );
    }
    if (modelIds.size < fullCorpusIds.size) sawStrictSubset = true;
  }

  assert.ok(sawStrictSubset, 'at least one calibration scenario must show a strict subset, not merely an equal one');
});

test("deployment-caused-incident-a is one scenario giving a strict subset: the model arm sees exactly the confirming evidence, the scenario's own recorded corpus also carries the dependencies evidence, and the scripted-control arm run through the real kernel ends with no evidence at all", async () => {
  const modelIds = await modelPlanOnlyEvidenceIdsFor('deployment-caused-incident-a');
  const fullCorpusIds = fullCorpusOkEvidenceIdsFor('deployment-caused-incident-a');

  assert.deepEqual([...modelIds], ['confirmation-deploy-v17']);
  assert.deepEqual([...fullCorpusIds].sort(), ['confirmation-deploy-v17', 'payments-dependencies-healthy']);

  /**
   * `scriptedNodes(record)` shares `modelNodes`'s own canonical
   * `plan_investigation`/`execute_investigation`. Its own `generate_hypotheses`
   * (the fixture's `replayBackedNodes`) mints a hypothesis with no `cause`
   * field at all, so `derive_predictions` derives nothing for it and
   * `plan_investigation` plans nothing before the mandatory challenge round.
   * Measured by running the real kernel below (not hand-computed): the run
   * still produces exactly one trial — the challenge round's own hard-coded
   * discriminating test (`tool: record.fixture.entries[0].toolId, input: {
   * replay: true }`, `test/fixtures/benchmark-experiment.mjs`), which the
   * planned-replay executor answers `unavailable` because no recorded call
   * and no route's input shape ever matches a literal `{ replay: true }`. So
   * the control arm ends with NO evidence, but not with NO trial: one
   * `unavailable` trial from that probe, and `control.stopKind ===
   * 'tools-unavailable'`.
   */
  const { scriptedNodes } = await import('../scripts/lane-arms.mjs');
  const input = executionInputFor('deployment-caused-incident-a');
  const nodes = scriptedNodes(input);
  const investigationGraph = graph.createInvestigationGraph({ nodes });
  const result = await investigationGraph.execute({ kind: 'start', state: initialStateFor(input) });

  assert.deepEqual(result.evidence, [], 'the scripted-control arm must end this calibration run with no evidence at all');
  assert.equal(result.trials.length, 1, "the sole trial is the challenge round's own hard-coded probe");
  assert.equal(result.trials[0].status, 'unavailable');
  assert.equal(result.control.stopKind, 'tools-unavailable');
});

/* -------------------------------------------------------------------------- */
/* 4. the calibration measurement row: derive -> plan -> execute (port) ->   */
/*    evaluate, pinned as literals                                           */
/* -------------------------------------------------------------------------- */

/**
 * Derives, plans, executes through `createPlannedReplayExecutor` (never the
 * full-corpus replay), then evaluates at `REPLAY_AS_OF` — the real planner
 * and port, over one hypothesis carrying `cause` against one scenario's own
 * fixture. Mirrors prediction-wiring.test.mjs's `evaluateRootCauseAgainstScenario`
 * (which uses the full corpus instead), never imported from it per this
 * suite's convention of building its own copy.
 */
async function planOnlyMeasurementFor({ cause, scenario }) {
  const deriveNode = graph.createDerivePredictions();
  const planNode = graph.createPlanInvestigation();
  const evaluateNode = graph.createEvaluatePredictions({ asOf: () => evals.REPLAY_AS_OF });
  const executor = createPlannedReplayExecutor({
    fixture: scenario.fixture,
    routes: graph.INVESTIGATION_ROUTES,
    annotate: evals.createObservationAnnotator(),
  });
  const executeNode = graph.createExecuteInvestigation({ execute: (context) => executor.execute(context) });

  const hypothesis = { id: 'h-1', statement: "the scenario's own root cause", createdBy: 'initial', cause };
  let state = {
    hypotheses: [hypothesis],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: baseControl(),
  };

  const derived = deriveNode(state);
  state = { ...state, predictions: domain.upsertById(state.predictions, derived.predictions) };

  const planned = planNode(state);
  state = { ...state, tests: domain.upsertById(state.tests, planned.tests) };

  const executed = await executeNode(state);
  state = {
    ...state,
    tests: domain.upsertById(state.tests, executed.tests),
    trials: domain.upsertById(state.trials, executed.trials),
    evidence: domain.upsertById(state.evidence, executed.evidence),
  };

  const evaluated = evaluateNode(state);
  state = {
    ...state,
    predictions: domain.upsertById(state.predictions, evaluated.predictions),
    assessments: domain.upsertById(state.assessments, evaluated.assessments),
  };

  const statuses = Object.fromEntries(
    state.predictions.map((prediction) => [templateKeyOfPrediction(prediction), prediction.status]),
  );

  return { statuses, trialCount: state.trials.length, assessmentCount: state.assessments.length };
}

/**
 * Measured by running `planOnlyMeasurementFor` over the real corpus (this
 * file's own script run, not hand-computed): the prediction statuses and
 * assessment count exactly match `EXPECTED_CALIBRATION_PREDICTION_MATRIX`
 * (prediction-wiring.test.mjs) for every scenario, because every quantity
 * either scenario's evidence confirms is one the full corpus also carries —
 * only `trialCount` differs (fewer trials than a full replay), which the
 * full-corpus matrix never measured. Hold-out scenarios are deliberately NOT
 * evaluated here.
 */
const EXPECTED_PLAN_ONLY_CALIBRATION_MATRIX = {
  'bad-deployment': {
    statuses: { 'deployment-before-onset': 'untested', 'error-rate-elevated': 'untested' },
    trialCount: 2,
    assessmentCount: 0,
  },
  'db-pool-exhaustion': {
    statuses: { 'pool-at-limit': 'untested' },
    trialCount: 1,
    assessmentCount: 0,
  },
  'deployment-caused-incident-a': {
    statuses: { 'deployment-before-onset': 'confirmed', 'error-rate-elevated': 'untested' },
    trialCount: 2,
    assessmentCount: 1,
  },
  'dependency-caused-incident-b': {
    statuses: { 'pool-at-limit': 'untested' },
    trialCount: 1,
    assessmentCount: 0,
  },
  'transient-self-resolved': {
    statuses: { 'workers-at-limit': 'untested', 'refill-activity': 'untested' },
    trialCount: 2,
    assessmentCount: 0,
  },
  'challenge-keeps-leader': {
    statuses: { 'deployment-before-onset': 'confirmed', 'error-rate-elevated': 'untested' },
    trialCount: 2,
    assessmentCount: 1,
  },
};

test('BENCHMARK_SCENARIO_PARTITIONS.calibration scenarios with no STRUCTURAL_GROUND_TRUTH rootCause are exactly false-alert and multiple-plausible-causes', () => {
  const skipped = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.filter(
    (scenarioId) => evals.STRUCTURAL_GROUND_TRUTH[scenarioId]?.rootCause === undefined,
  );
  assert.deepEqual(skipped.sort(), ['false-alert', 'multiple-plausible-causes'].sort());
});

test('the plan-only calibration measurement matrix: deriving, planning and executing each rootCause-carrying scenario\'s own root cause through the real planner and port, then evaluating at REPLAY_AS_OF, equals the registered literal matrix', async () => {
  assert.deepEqual(
    Object.keys(EXPECTED_PLAN_ONLY_CALIBRATION_MATRIX).sort(),
    evals.BENCHMARK_SCENARIO_PARTITIONS.calibration
      .filter((scenarioId) => evals.STRUCTURAL_GROUND_TRUTH[scenarioId]?.rootCause !== undefined)
      .sort(),
    'fixture sanity: the registered matrix must cover exactly the rootCause-carrying calibration scenarios',
  );

  for (const [scenarioId, expected] of Object.entries(EXPECTED_PLAN_ONLY_CALIBRATION_MATRIX)) {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    assert.ok(scenario, `REPLAY_SCENARIOS must carry ${scenarioId}`);
    const { rootCause } = evals.STRUCTURAL_GROUND_TRUTH[scenarioId];

    // eslint-disable-next-line no-await-in-loop -- one scenario's plan-execute-evaluate cycle at a time
    const observed = await planOnlyMeasurementFor({ cause: rootCause, scenario });

    assert.deepEqual(observed.statuses, expected.statuses, `${scenarioId}: prediction statuses must equal the registered plan-only matrix`);
    assert.equal(observed.trialCount, expected.trialCount, `${scenarioId}: trial count must equal the registered plan-only matrix`);
    assert.equal(observed.assessmentCount, expected.assessmentCount, `${scenarioId}: assessment count must equal the registered plan-only matrix`);
  }
});

/**
 * Why a deployment prediction can be confirmed and never refuted on this
 * corpus: every deployment fact the frozen observation table carries reads a
 * deployment as present, so no planned deployment request can return an
 * absence. Registered in supplement 7.
 */
test('every deployment-in-window fact in OBSERVATION_ANNOTATIONS counts at least one deployment, so no planned deployment request can return an absence', () => {
  const deploymentFacts = evals.OBSERVATION_ANNOTATIONS
    .flatMap((row) => row.facts)
    .filter((fact) => fact.form === 'deployment-in-window');

  assert.ok(deploymentFacts.length > 0, 'fixture sanity: the table must carry deployment facts');
  for (const fact of deploymentFacts) {
    assert.ok(fact.count > 0, `a deployment fact reads an absence: ${JSON.stringify(fact)}`);
  }
});

/**
 * AIC-142: what the planned-replay port can answer under
 * investigation-routes-v2, measured without any provider call. For each
 * calibration scenario, every request the route table can form — over the
 * services the scenario's own recorded calls name, the three observation
 * windows, every signal the table routes (latency is refused, so it forms no
 * request) and every log class — is sent through the same
 * createPlannedReplayExecutor the lanes use, and the requests answered `ok`
 * are compared against the literal below. This is structural reachability:
 * which requests the graph CAN execute on the frozen corpus. Whether a model
 * chooses them is what calibration measures. Registered in
 * docs/evidence/preregistration/v0.2-four-arm-supplement-9.md.
 */
const EXPECTED_ROUTE_VOCABULARY_REACHABILITY = Object.freeze({
  'bad-deployment': ['deployments {"service":"checkout","window":"incident"} -> checkout-deploy-v42'],
  'db-pool-exhaustion': [],
  'false-alert': [],
  'deployment-caused-incident-a': [
    'deployments {"service":"payments","window":"pre-onset"} -> confirmation-deploy-v17',
    'deployments {"service":"payments","window":"incident"} -> confirmation-deploy-v17',
    'dependencies {"service":"payments","window":"incident","metric":"dependency-health"} -> payments-dependencies-healthy',
  ],
  'dependency-caused-incident-b': [
    'deployments {"service":"payments","window":"pre-onset"} -> confirmation-deploy-v17',
    'deployments {"service":"payments","window":"incident"} -> confirmation-deploy-v17',
  ],
  'multiple-plausible-causes': [],
  'transient-self-resolved': [],
  'challenge-keeps-leader': [
    'deployments {"service":"payments","window":"pre-onset"} -> payments-v19-before-timeouts',
    'dependencies {"service":"payments","window":"incident","metric":"dependency-health"} -> payments-v19-dependencies-healthy',
  ],
});

test('the route-vocabulary reachability matrix under investigation-routes-v2: every request the route table can form for each calibration scenario over its own recorded services, windows and discriminants, answered through the planned-replay port, equals the registered literal', async () => {
  assert.deepEqual(
    Object.keys(EXPECTED_ROUTE_VOCABULARY_REACHABILITY).sort(),
    [...evals.BENCHMARK_SCENARIO_PARTITIONS.calibration].sort(),
    'fixture sanity: the registered matrix must cover exactly the calibration partition',
  );
  const windows = domain.ObservationWindowSchema.options;
  const logClasses = domain.LogClassSchema.options;
  const signalRoutes = graph.INVESTIGATION_ROUTES.byForm['signal-state'].bySignal;

  for (const [scenarioId, expected] of Object.entries(EXPECTED_ROUTE_VOCABULARY_REACHABILITY)) {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    assert.ok(scenario, `REPLAY_SCENARIOS must carry ${scenarioId}`);
    const services = [...new Set(scenario.fixture.entries.map((entry) => entry.input?.service).filter((service) => typeof service === 'string'))].sort();
    const executor = createPlannedReplayExecutor({
      fixture: scenario.fixture,
      routes: graph.INVESTIGATION_ROUTES,
      annotate: evals.createObservationAnnotator(),
    });
    const answered = [];
    for (const service of services) {
      for (const window of windows) {
        const requests = [['deployments', { service, window }]];
        for (const signal of domain.SignalKindSchema.options) {
          const entry = signalRoutes[signal];
          if (typeof entry.tool === 'string') requests.push([entry.tool, { service, window, metric: signal }]);
        }
        for (const logClass of logClasses) requests.push(['logs', { service, window, query: logClass }]);
        for (const [tool, input] of requests) {
          // eslint-disable-next-line no-await-in-loop -- one request at a time, in a stable order
          const result = await executor.execute({ tool, input });
          if (result.status === 'ok') answered.push(`${tool} ${JSON.stringify(input)} -> ${result.output.map(({ id }) => id).join(',')}`);
        }
      }
    }
    assert.deepEqual(answered.sort(), [...expected].sort(), `${scenarioId}: requests answered ok must equal the registered route-vocabulary reachability`);
  }
});

/**
 * AIC-142: the same enumeration as the row above, under the form-only table
 * AIC-142 replaced (`investigation-routes-v1`, restated here as a literal so
 * the comparison stays checkable after that table left production). Under it
 * every signal-state request went to `metrics`, and no route named
 * `dependencies`. The requests answered `ok` are exactly the v2 set minus the
 * two `dependencies`/`dependency-health` requests — so the repair added those
 * two and removed nothing. Registered in supplement 9.
 */
test('under the replaced form-only table investigation-routes-v1, the same route-vocabulary enumeration answers exactly the v2 matrix minus its two dependencies/dependency-health requests', async () => {
  const signalInput = Object.freeze({ service: 'subject', window: 'window', metric: 'signal' });
  const formOnlyV1 = Object.freeze({
    version: 'investigation-routes-v1',
    byForm: Object.freeze({
      'deployment-in-window': Object.freeze({ tool: 'deployments', input: Object.freeze({ service: 'subject', window: 'window' }) }),
      'signal-state': Object.freeze({ tool: 'metrics', input: signalInput }),
      'log-class-in-window': Object.freeze({ tool: 'logs', input: Object.freeze({ service: 'subject', window: 'window', query: 'logClass' }) }),
    }),
  });
  const windows = domain.ObservationWindowSchema.options;
  const logClasses = domain.LogClassSchema.options;

  for (const [scenarioId, v2Answered] of Object.entries(EXPECTED_ROUTE_VOCABULARY_REACHABILITY)) {
    const scenario = evals.REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    const services = [...new Set(scenario.fixture.entries.map((entry) => entry.input?.service).filter((service) => typeof service === 'string'))].sort();
    const executor = createPlannedReplayExecutor({
      fixture: scenario.fixture,
      routes: formOnlyV1,
      annotate: evals.createObservationAnnotator(),
    });
    const answered = [];
    for (const service of services) {
      for (const window of windows) {
        const requests = [['deployments', { service, window }]];
        for (const signal of domain.SignalKindSchema.options) requests.push(['metrics', { service, window, metric: signal }]);
        for (const logClass of logClasses) requests.push(['logs', { service, window, query: logClass }]);
        for (const [tool, input] of requests) {
          // eslint-disable-next-line no-await-in-loop -- one request at a time, in a stable order
          const result = await executor.execute({ tool, input });
          if (result.status === 'ok') answered.push(`${tool} ${JSON.stringify(input)} -> ${result.output.map(({ id }) => id).join(',')}`);
        }
      }
    }
    const expectedV1 = v2Answered.filter((line) => !line.startsWith('dependencies {') || !line.includes('"metric":"dependency-health"'));
    assert.deepEqual(answered.sort(), [...expectedV1].sort(), `${scenarioId}: under v1 the answered requests must be the v2 set minus its dependencies/dependency-health requests`);
  }
  const added = Object.values(EXPECTED_ROUTE_VOCABULARY_REACHABILITY).flat().filter((line) => line.startsWith('dependencies {'));
  assert.equal(added.length, 2, 'the repair adds exactly two answerable requests across the calibration partition');
});

/**
 * Why a template-derived plan cannot reach the requests the repair added: no
 * PREDICTION_TEMPLATES observation names dependency-health, and none names
 * latency.
 */
test('no PREDICTION_TEMPLATES observation is a signal-state observation of dependency-health or latency', () => {
  const signals = new Set();
  for (const templates of Object.values(graph.PREDICTION_TEMPLATES.byMechanism)) {
    for (const template of templates) {
      for (const observation of [...template.expectedIfTrue, ...template.expectedIfFalse]) {
        if (observation.form === 'signal-state') signals.add(observation.signal);
      }
    }
  }
  assert.ok(signals.size > 0, 'fixture sanity: the templates must derive some signal-state observation');
  assert.equal(signals.has('dependency-health'), false);
  assert.equal(signals.has('latency'), false);
});

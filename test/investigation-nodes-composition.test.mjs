/**
 * AIC-126 slice a: `@aic/graph`'s `createInvestigationNodes({ reasoning,
 * execute, asOf })`, the one canonical, package-owned composition of the
 * investigation's twelve nodes.
 *
 * Before this slice, `scripts/lane-arms.mjs` assembled the node map itself —
 * spreading `replayBackedNodes` (`test/fixtures/benchmark-experiment.mjs`)
 * for the scripted-control roles and the identity/no-op nodes, then
 * overriding the deterministic nodes one by one. `createInvestigationNodes`
 * replaces that assembly with one function the package owns, so a lane (and
 * later a CLI) never has to import test fixtures to build a working graph.
 *
 * The four REASONING roles (`generate_hypotheses`,
 * `interpret_residual_evidence`, `challenge_hypothesis`,
 * `propose_conclusion`) are exactly the caller's own functions — identity is
 * enough, because the caller (a lane, a CLI) owns whether those roles are
 * scripted or model-backed. The other eight nodes are canonical: the two
 * no-op lifecycle nodes (`normalize_incident`, `collect_baseline`) and the six
 * deterministic, state-driven nodes this package already exports as
 * individual factories (`createDerivePredictions`, `createPlanInvestigation`,
 * `createExecuteInvestigation`, `createEvaluatePredictions`,
 * `createDeriveHypothesisState`, `createStateTerminationCheck`).
 *
 * Every deterministic-node row below is proven by BEHAVIOUR — calling the
 * node and checking what it does — never by identity or by reading source
 * text, matching the discipline `lane-arms.test.mjs` and
 * `prediction-wiring.test.mjs` already hold themselves to.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';

import { createFakeCommittedExecution } from './fixtures/fake-committed-execution.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';

const RUN_ID = 'run-investigation-nodes-composition';
const ASOF = '2026-09-28T09:00:00.000Z';

function requireGraphExport(name) {
  assert.equal(typeof graph[name], 'function', `@aic/graph must export ${name}`);
  return graph[name];
}

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

function baseControl(overrides = {}) {
  return {
    runId: RUN_ID,
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

function state(overrides = {}) {
  return {
    incident: scopedIncident('incident-investigation-nodes-composition'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: baseControl(),
    ...overrides,
  };
}

function hypothesis(id, overrides = {}) {
  return {
    id,
    statement: `${id} statement`,
    createdBy: 'initial',
    cause: { component: 'checkout-db-pool', mechanism: 'connection-pool-exhaustion' },
    ...overrides,
  };
}

function plannedTest(id, overrides = {}) {
  return {
    id,
    predictionId: 'prediction-1',
    tool: 'metrics',
    input: { service: 'checkout' },
    cost: 'cheap',
    status: 'planned',
    ...overrides,
  };
}

function evidenceItem(id, facts, overrides = {}) {
  const base = {
    id,
    trialId: `trial-${id}`,
    kind: 'metric',
    source: 'metrics',
    observedAt: ASOF,
    statement: `evidence recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
  };
  if (facts !== undefined) {
    base.observation = { version: domain.EXPECTED_OBSERVATION_VERSION, facts };
  }
  return { ...base, ...overrides };
}

/** A reasoning object carrying the four roles, each a distinguishable marker function. */
function fakeReasoning(overrides = {}) {
  return {
    async generate_hypotheses() {
      return { hypotheses: [] };
    },
    async interpret_residual_evidence() {
      return {};
    },
    async challenge_hypothesis() {
      return {
        alternative: { id: 'fake-alternative', statement: 'fake', createdBy: 'challenge' },
        discriminatingTests: [],
      };
    },
    async propose_conclusion() {
      return { conclusion: { kind: 'inconclusive', causes: [] } };
    },
    ...overrides,
  };
}

async function noopExecute() {
  return { status: 'ok', output: [] };
}

function asOfConstant(value) {
  return () => value;
}

/* -------------------------------------------------------------------------- */
/* 1. shape: exactly INVESTIGATION_NODE_NAMES, reasoning wired by identity    */
/* -------------------------------------------------------------------------- */

test('createInvestigationNodes({ reasoning, execute, asOf }) returns a node map whose keys are exactly INVESTIGATION_NODE_NAMES', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const reasoning = fakeReasoning();

  const nodes = createInvestigationNodes({ reasoning, execute: noopExecute, asOf: asOfConstant(ASOF) });

  assert.deepEqual(
    Object.keys(nodes).sort(),
    [...graph.INVESTIGATION_NODE_NAMES].sort(),
    'the returned node map must carry exactly the twelve names @aic/graph declares, no more and no fewer',
  );
});

test('the four reasoning roles on the returned node map are exactly the functions passed in reasoning (identity)', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const reasoning = fakeReasoning();

  const nodes = createInvestigationNodes({ reasoning, execute: noopExecute, asOf: asOfConstant(ASOF) });

  for (const role of ['generate_hypotheses', 'interpret_residual_evidence', 'challenge_hypothesis', 'propose_conclusion']) {
    assert.equal(
      nodes[role],
      reasoning[role],
      `nodes.${role} must be the caller's own ${role} function, unwrapped`,
    );
  }
});

test('a reasoning object missing one of the four roles throws a TypeError naming the missing key', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const reasoning = fakeReasoning();
  delete reasoning.generate_hypotheses;

  assert.throws(
    () => createInvestigationNodes({ reasoning, execute: noopExecute, asOf: asOfConstant(ASOF) }),
    (error) => {
      assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
      assert.ok(
        error.message.includes('generate_hypotheses'),
        `expected the message to name the missing key generate_hypotheses: ${error.message}`,
      );
      return true;
    },
  );
});

test('a reasoning object carrying an extra key throws a TypeError naming that key', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const reasoning = fakeReasoning({ async unexpected_role() {} });

  assert.throws(
    () => createInvestigationNodes({ reasoning, execute: noopExecute, asOf: asOfConstant(ASOF) }),
    (error) => {
      assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
      assert.ok(
        error.message.includes('unexpected_role'),
        `expected the message to name the extra key unexpected_role: ${error.message}`,
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* 2. normalize_incident / collect_baseline: canonical no-ops                */
/* -------------------------------------------------------------------------- */

test('a reasoning role that is not a function throws a TypeError naming the role', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');

  assert.throws(
    () => createInvestigationNodes({
      reasoning: fakeReasoning({ challenge_hypothesis: 'not-a-function' }),
      execute: async () => ({ status: 'unavailable', reason: 'unused' }),
      asOf: asOfConstant(ASOF),
    }),
    (error) => error instanceof TypeError && /challenge_hypothesis/.test(error.message),
  );
});

test('a reasoning value that is not an object throws a TypeError naming reasoning', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');

  assert.throws(
    () => createInvestigationNodes({
      reasoning: null,
      execute: async () => ({ status: 'unavailable', reason: 'unused' }),
      asOf: asOfConstant(ASOF),
    }),
    (error) => error instanceof TypeError && /reasoning/.test(error.message),
  );
});

test('normalize_incident and collect_baseline are no-ops that return {} regardless of state', async () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute: noopExecute, asOf: asOfConstant(ASOF) });

  const testState = state({ hypotheses: [hypothesis('h-1')] });

  assert.deepEqual(await nodes.normalize_incident(testState), {});
  assert.deepEqual(await nodes.collect_baseline(testState), {});
});

/* -------------------------------------------------------------------------- */
/* 3. derive_predictions: the canonical node, proven by behaviour            */
/* -------------------------------------------------------------------------- */

test('derive_predictions derives at least one prediction for a caused hypothesis, matching domain.derivePredictions over PREDICTION_TEMPLATES', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute: noopExecute, asOf: asOfConstant(ASOF) });
  const testState = state({ hypotheses: [hypothesis('h-1')] });

  const result = nodes.derive_predictions(testState);

  const expected = domain.derivePredictions({
    hypotheses: testState.hypotheses,
    predictions: testState.predictions,
    templates: graph.PREDICTION_TEMPLATES,
  });
  assert.ok(expected.length > 0, 'fixture sanity: the hypothesis must actually derive at least one prediction');
  assert.deepEqual(result, { predictions: expected });
});

/* -------------------------------------------------------------------------- */
/* 4. plan_investigation: the canonical node, proven by behaviour            */
/* -------------------------------------------------------------------------- */

test('plan_investigation plans at least one test for an untested derived prediction, matching domain.planInvestigation over INVESTIGATION_ROUTES', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute: noopExecute, asOf: asOfConstant(ASOF) });
  const baseState = state({ hypotheses: [hypothesis('h-1')] });

  const { predictions } = nodes.derive_predictions(baseState);
  const testState = { ...baseState, predictions };

  const result = nodes.plan_investigation(testState);

  const expected = domain.planInvestigation({
    predictions: testState.predictions,
    tests: testState.tests,
    routes: graph.INVESTIGATION_ROUTES,
  });
  assert.ok(expected.length > 0, 'fixture sanity: the derived prediction must actually plan at least one test');
  assert.deepEqual(result, { tests: expected });
});

/* -------------------------------------------------------------------------- */
/* 5. execute_investigation: calls the given execute only for planned tests  */
/* -------------------------------------------------------------------------- */

test('execute_investigation calls the given execute only for planned tests, and never for executed, unavailable or failed ones', async () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const calls = [];
  const execute = async (context) => {
    calls.push(context);
    return { status: 'ok', output: [] };
  };
  const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute, asOf: asOfConstant(ASOF) });

  const testState = state({
    tests: [
      plannedTest('test-done', { status: 'executed' }),
      plannedTest('test-planned-1', { status: 'planned' }),
      plannedTest('test-failed', { status: 'failed' }),
      plannedTest('test-planned-2', { status: 'planned' }),
      plannedTest('test-unavailable', { status: 'unavailable' }),
    ],
  });

  const result = await nodes.execute_investigation(testState);

  assert.deepEqual(
    calls.map((context) => context.testId),
    ['test-planned-1', 'test-planned-2'],
    'only the planned tests are executed, in the order they appear in state',
  );
  assert.deepEqual(
    result.tests.map((testItem) => testItem.id),
    ['test-planned-1', 'test-planned-2'],
    'only the tests that were actually run are returned',
  );
});

/**
 * AIC-146 b5: `createInvestigationNodes` forwards its own `evidenceProvenance`
 * option straight to the `execute_investigation` node it builds
 * (`createExecuteInvestigation`, `./execute-investigation.js`) — the same
 * option `investigation-execution.test.mjs`'s own "AIC-146 b5" section pins
 * directly against that node. Driven here through the COMPOSED node, so a
 * caller that only ever reaches `execute_investigation` through
 * `createInvestigationNodes` (every lane, and the CLI) gets the same refusal
 * a caller of the node alone would.
 */
test('createInvestigationNodes forwards evidenceProvenance to its execute_investigation node: "required" with an ok outcome lacking provenance throws through the composed node (AIC-146 b5)', async () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const execute = async () => ({ status: 'ok', output: [evidenceItem('e-unstamped')] });
  const nodes = createInvestigationNodes({
    reasoning: fakeReasoning(),
    execute,
    asOf: asOfConstant(ASOF),
    evidenceProvenance: 'required',
  });

  const testState = state({ tests: [plannedTest('test-a')] });

  await assert.rejects(
    () => nodes.execute_investigation(testState),
    /provenance/i,
    'the forwarded "required" option must reach the composed execute_investigation node, not be swallowed at the boundary',
  );
});

/**
 * AIC-146 slice c1: `createInvestigationNodes` forwards its own `execution`
 * option straight to the `execute_investigation` node it builds
 * (`createExecuteInvestigation`), the same option
 * `investigation-execution-committed.test.mjs` pins directly against that
 * node. Driven here through the COMPOSED node, so a caller that only ever
 * reaches `execute_investigation` through `createInvestigationNodes` (every
 * lane, and the CLI) gets the committed wrapping too.
 */
test('createInvestigationNodes forwards execution to its execute_investigation node: a commit is observed through the composed node', async () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const fake = createFakeCommittedExecution();
  const execute = async () => ({ status: 'ok', output: [] });
  const nodes = createInvestigationNodes({
    reasoning: fakeReasoning(),
    execute,
    asOf: asOfConstant(ASOF),
    execution: fake,
  });
  const testState = state({ tests: [plannedTest('test-a')] });

  await nodes.execute_investigation(testState);

  const expectedKey = domain.buildExecKey('tool.trial', { runId: RUN_ID, testId: 'test-a', trialAttempt: 1 });
  assert.deepEqual(
    fake.calls,
    [expectedKey],
    'the forwarded execution port must reach the composed execute_investigation node, not be dropped at the boundary',
  );
});

/* -------------------------------------------------------------------------- */
/* 6. evaluate_predictions: the canonical node, honours asOf                 */
/* -------------------------------------------------------------------------- */

test('evaluate_predictions honours asOf: a fact observed at asOf confirms the derived prediction, and the same fact one millisecond later does not', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const evidenceAt = evidenceItem('e-1', [
    { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
  ]);

  function runFor(asOfValue) {
    const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute: noopExecute, asOf: asOfConstant(asOfValue) });
    const baseState = state({ hypotheses: [hypothesis('h-1')], evidence: [evidenceAt] });
    const { predictions } = nodes.derive_predictions(baseState);
    const testState = { ...baseState, predictions };
    return nodes.evaluate_predictions(testState);
  }

  const onTime = runFor(ASOF);
  assert.equal(onTime.predictions.length, 1, 'a fact observed exactly at asOf must confirm the derived prediction');
  assert.equal(onTime.predictions[0].status, 'confirmed');
  assert.equal(onTime.assessments.length, 1);

  const before = runFor(new Date(new Date(ASOF).getTime() - 1).toISOString());
  assert.deepEqual(
    before,
    { predictions: [], assessments: [] },
    'asOf one millisecond before the fact was observed must confirm nothing',
  );
});

/* -------------------------------------------------------------------------- */
/* 7. derive_hypothesis_state / termination_check: state-driven, canonical   */
/* -------------------------------------------------------------------------- */

/**
 * The same T6 state `lane-arms.test.mjs` uses to prove the canonical
 * `termination_check` is wired rather than a fixture no-op that always
 * answers `sufficient`: `challengeRounds: 1`, one `createdBy: 'initial'`
 * candidate hypothesis, no assessments, non-empty evidence and an ok trial —
 * read off the T0-T6 table by hand
 * (`packages/graph/src/nodes/termination.ts`), never by calling
 * `createStateTerminationCheck` to compute it.
 */
test('termination_check is the canonical, state-driven node: a candidate hypothesis past its mandatory challenge round with no qualifying assessment terminates stalled, not sufficient', async () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute: noopExecute, asOf: asOfConstant(ASOF) });

  const oneCandidateNoAssessments = state({
    hypotheses: [hypothesis('h-1', { cause: undefined })],
    trials: [{
      id: 'trial-1',
      runId: RUN_ID,
      testId: 'test-1',
      attempt: 1,
      tool: 'logs.search',
      input: {},
      status: 'ok',
      durationMs: 10,
      evidenceIds: ['e-1'],
    }],
    evidence: [{
      id: 'e-1',
      trialId: 'trial-1',
      kind: 'deploy',
      source: 'deployment-history',
      observedAt: ASOF,
      statement: 'observation recorded as e-1',
      rawRef: 'replay://evidence/e-1',
      reliability: 'medium',
    }],
    control: baseControl({ phase: 'terminating', challengeRounds: 1 }),
  });

  const decision = await nodes.termination_check(oneCandidateNoAssessments);
  assert.deepEqual(
    decision,
    { route: 'terminal', stopKind: 'stalled' },
    'a fixture no-op terminator would hardcode stopKind: "sufficient" regardless of state; the canonical node must read this state as T6',
  );
});

test('derive_hypothesis_state is the canonical, state-driven node: it refuses an assessment naming evidence the state does not carry', () => {
  const createInvestigationNodes = requireGraphExport('createInvestigationNodes');
  const nodes = createInvestigationNodes({ reasoning: fakeReasoning(), execute: noopExecute, asOf: asOfConstant(ASOF) });

  const danglingAssessment = state({
    hypotheses: [hypothesis('h-1', { cause: undefined })],
    assessments: [{
      id: 'a-dangling',
      evidenceId: 'evidence-the-state-does-not-carry',
      hypothesisId: 'h-1',
      effect: 'supports',
      strength: 'high',
      rationale: 'names evidence nobody collected',
      producedBy: 'rule',
    }],
  });

  assert.throws(
    () => nodes.derive_hypothesis_state(danglingAssessment),
    /derive_hypothesis_state:/,
    'a fixture no-op would return {} unconditionally; the canonical node must refuse an assessment naming evidence the state does not carry',
  );
});

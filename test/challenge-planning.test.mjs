/**
 * AIC-125 slice d: the challenge round plans tests for the alternative's
 * predictions.
 *
 * `challengeHypothesis` (`packages/graph/src/investigation.ts`) already calls
 * `nodes.derive_predictions` inline, before the round's `execute_investigation`
 * — see prediction-wiring.test.mjs, section F/G. This file pins the next inline
 * call the same round makes: `nodes.plan_investigation`, over the state that
 * now includes the alternative, its freshly derived predictions and the
 * challenge role's own discriminating tests — so an untested prediction the
 * alternative carries gets a planned test the same way the ordinary lifecycle
 * edge would plan one, and the round's `execute_investigation` sees the
 * challenge role's own tests PLUS whatever the inline planner adds.
 *
 * Every hardening row below mirrors the derive_predictions rows this same
 * file's sibling (prediction-wiring.test.mjs, section G) already holds the
 * inline `derive_predictions` call to: routing refused, `declaredLlmCalls`
 * spent through the same channel, only an own `tests` property read (an
 * inherited one and an own getter both ignored), and a non-array `tests`
 * rejected by name.
 *
 * Helpers below are copied rather than imported from prediction-wiring.test.mjs
 * — that file's own convention (see its header) is that a row needing this
 * shape builds it inline rather than depending on another test file's private
 * helper.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { Command } from '@langchain/langgraph';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const WRAPPER_CONTROL = Object.freeze({
  runId: 'run-aic125d-challenge-planning',
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
 * challenge round and ends — the same shape prediction-wiring.test.mjs's
 * `challengeWrapperNodes` uses, with `plan_investigation` made configurable.
 */
function planningWrapperNodes({
  generateHypotheses,
  deriveePredictions,
  planInvestigationNode,
  challengeHypothesisResult,
  executeSpy,
}) {
  let terminationCalls = 0;
  const noop = async () => ({});
  return {
    normalize_incident: noop,
    collect_baseline: noop,
    generate_hypotheses: generateHypotheses,
    derive_predictions: deriveePredictions,
    plan_investigation: planInvestigationNode,
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

function planningWrapperInitialState() {
  return {
    incident: scopedIncident('incident-aic125d-challenge-planning'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: WRAPPER_CONTROL,
  };
}

/**
 * A leader with no cause, so the ordinary `derive_predictions` /
 * `plan_investigation` lifecycle edges derive and plan nothing for it, and
 * every row below can attribute whatever it sees in the challenge round's
 * `execute_investigation` state to the challenge-time calls alone.
 */
function causelessLeaderHypotheses() {
  return { hypotheses: [{ id: 'aic125d-leader', statement: 'the leader candidate cause', createdBy: 'initial' }] };
}

const emptyDerive = async () => ({ predictions: [] });

/** The observation-form -> tool-request table's production version, at test time. */
function expectedPlannedTestId(tool, input, routesVersion) {
  const digest = createHash('sha256')
    .update(JSON.stringify(domain.canonicalJson([tool, input, routesVersion])))
    .digest('hex');
  return `test-${digest}`;
}

const MAIN_ALTERNATIVE_CAUSE = Object.freeze({ component: 'orders-db', mechanism: 'connection-pool-exhaustion' });
const MAIN_PLANNED_INPUT = Object.freeze({ service: 'orders-db', window: 'incident', metric: 'connection-pool' });

function alternativeHypothesis(id, cause) {
  return {
    id,
    statement: 'the alternative candidate cause',
    createdBy: 'challenge',
    cause,
  };
}

/* -------------------------------------------------------------------------- */
/* A1/A2: the round plans, and de-dups against its own tests                  */
/* -------------------------------------------------------------------------- */

test('the challenge round calls plan_investigation inline, over the alternative, its derived predictions and the challenge role\'s own discriminating tests: with the canonical derive_predictions and plan_investigation, an alternative with cause {component: orders-db, mechanism: connection-pool-exhaustion} yields a planned metrics test for orders-db/incident/connection-pool, and the round\'s execute_investigation sees the challenge role\'s own test plus the newly planned one', async () => {
  const executeCalls = [];
  const challengeTest = Object.freeze({
    id: 'aic125d-challenge-role-test',
    predictionId: 'aic125d-challenge-role-prediction',
    tool: 'deployments',
    input: { service: 'orders-db', window: 'pre-onset' },
    cost: 'cheap',
    status: 'planned',
  });

  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: graph.createDerivePredictions(),
    planInvestigationNode: graph.createPlanInvestigation(),
    challengeHypothesisResult: {
      alternative: alternativeHypothesis('aic125d-alt', MAIN_ALTERNATIVE_CAUSE),
      discriminatingTests: [challengeTest],
    },
    executeSpy: (state) => executeCalls.push(state),
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });
  await investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() });

  assert.equal(executeCalls.length, 2, 'execute_investigation must run once before the challenge and once for the challenge round');
  const [, forChallenge] = executeCalls;

  const expectedPlannedId = expectedPlannedTestId('metrics', MAIN_PLANNED_INPUT, graph.INVESTIGATION_ROUTES.version);
  const plannedTest = forChallenge.tests.find((testItem) => testItem.id === expectedPlannedId);
  assert.ok(
    plannedTest,
    `the challenge round must plan a metrics test for the alternative's pool-at-limit prediction; tests seen: ${JSON.stringify(forChallenge.tests)}`,
  );
  assert.equal(plannedTest.tool, 'metrics');
  assert.deepEqual(plannedTest.input, MAIN_PLANNED_INPUT);
  assert.equal(plannedTest.status, 'planned');

  assert.ok(
    forChallenge.tests.some((testItem) => testItem.id === challengeTest.id),
    'the round\'s state must still carry the challenge role\'s own proposed test',
  );
  assert.equal(
    forChallenge.tests.length,
    2,
    'the round carries exactly the challenge role\'s test plus the one newly planned test',
  );
});

test('a request the challenge role already proposed (same tool+input) is not planned twice (planner de-dup against the round\'s own tests)', async () => {
  const executeCalls = [];
  let planInvestigationCalls = 0;
  const dupChallengeTest = Object.freeze({
    id: 'aic125d-dedup-challenge-test',
    predictionId: 'aic125d-dedup-challenge-prediction',
    tool: 'metrics',
    input: { ...MAIN_PLANNED_INPUT },
    cost: 'cheap',
    status: 'planned',
  });
  const canonicalPlan = graph.createPlanInvestigation();
  const countingPlan = (state) => {
    if (state.hypotheses.some((hypothesis) => hypothesis.createdBy === 'challenge')) {
      planInvestigationCalls += 1;
    }
    return canonicalPlan(state);
  };

  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: graph.createDerivePredictions(),
    planInvestigationNode: countingPlan,
    challengeHypothesisResult: {
      alternative: alternativeHypothesis('aic125d-alt-dedup', MAIN_ALTERNATIVE_CAUSE),
      discriminatingTests: [dupChallengeTest],
    },
    executeSpy: (state) => executeCalls.push(state),
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });
  await investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() });

  assert.ok(
    planInvestigationCalls > 0,
    'fixture sanity: plan_investigation must actually be invoked over the challenge-round state for this row to test de-dup at all',
  );
  const [, forChallenge] = executeCalls;
  assert.equal(
    forChallenge.tests.length,
    1,
    'the identical request must not be planned a second time: only the challenge role\'s own test may carry it',
  );
  assert.equal(forChallenge.tests[0].id, dupChallengeTest.id);
});

/* -------------------------------------------------------------------------- */
/* A3: hardening, mirroring the derive_predictions rows                       */
/* -------------------------------------------------------------------------- */

const STUB_CHALLENGE_RESULT = Object.freeze({
  alternative: alternativeHypothesis('aic125d-alt-hardening', MAIN_ALTERNATIVE_CAUSE),
  discriminatingTests: [Object.freeze({
    id: 'aic125d-hardening-challenge-test',
    predictionId: 'aic125d-hardening-challenge-prediction',
    tool: 'metrics',
    input: {},
    cost: 'cheap',
    status: 'planned',
  })],
});

test('the challenge round refuses a plan_investigation node that returns routing (Command or Send) instead of a state update, the way the wrapped lifecycle edge does', async () => {
  function planInvestigationReturningRoutingForChallenge(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { tests: [] };
    return new Command({ goto: 'execute_investigation' });
  }

  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: emptyDerive,
    planInvestigationNode: planInvestigationReturningRoutingForChallenge,
    challengeHypothesisResult: STUB_CHALLENGE_RESULT,
    executeSpy: () => {},
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });

  await assert.rejects(
    investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() }),
    (error) => {
      assert.match(
        String(error?.message ?? ''),
        /plan_investigation|routing/i,
        'the refusal must name plan_investigation or routing, the way preserveGraphOwnedControl\'s own refusal names what it refused',
      );
      return true;
    },
    'a Command returned by plan_investigation at challenge time must not be silently dropped: the run must reject rather than continue with the routing discarded',
  );
});

test('the challenge round adds the plan node\'s own declaredLlmCalls to control.llmCallsUsed, the same channel the wrapped lifecycle edge reads', async () => {
  function planInvestigationWithDeclaredCalls(declaredLlmCalls) {
    return (state) => {
      const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
      if (alternative === undefined) return { tests: [] };
      if (declaredLlmCalls === undefined) return { tests: [] };
      return { tests: [], declaredLlmCalls };
    };
  }

  async function runWith(declaredLlmCalls) {
    const nodes = planningWrapperNodes({
      generateHypotheses: causelessLeaderHypotheses,
      deriveePredictions: emptyDerive,
      planInvestigationNode: planInvestigationWithDeclaredCalls(declaredLlmCalls),
      challengeHypothesisResult: STUB_CHALLENGE_RESULT,
      executeSpy: () => {},
    });
    const investigationGraph = graph.createInvestigationGraph({ nodes });
    return investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() });
  }

  const baseline = await runWith(undefined);
  const declaring = await runWith(1);

  assert.equal(
    declaring.control.llmCallsUsed,
    baseline.control.llmCallsUsed + 1,
    'declaring one llm call at challenge-time planning must spend exactly one more than the same run declaring nothing',
  );
});

test('the challenge round reads only an own "tests" property off what plan_investigation returns, never one its prototype supplies', async () => {
  const decoyTest = Object.freeze({
    id: 'aic125d-prototype-decoy-test',
    predictionId: 'aic125d-prototype-decoy-prediction',
    tool: 'metrics',
    input: {},
    cost: 'cheap',
    status: 'planned',
  });

  let planInvestigationCalls = 0;
  function planInvestigationWithPrototypeDecoyTests(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { tests: [] };
    planInvestigationCalls += 1;
    return Object.create({ tests: [decoyTest] });
  }

  const executeCalls = [];
  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: emptyDerive,
    planInvestigationNode: planInvestigationWithPrototypeDecoyTests,
    challengeHypothesisResult: STUB_CHALLENGE_RESULT,
    executeSpy: (state) => executeCalls.push(state),
  });
  const investigationGraph = graph.createInvestigationGraph({ nodes });

  const finalState = await investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() });

  assert.ok(
    planInvestigationCalls > 0,
    'fixture sanity: plan_investigation must actually be invoked over the challenge-round state for this row to test anything',
  );
  assert.ok(
    !finalState.tests.some((testItem) => testItem.id === decoyTest.id),
    'a plan_investigation result carrying no own "tests" property must never plant a test from its prototype',
  );
  const [, forChallenge] = executeCalls;
  assert.ok(
    !forChallenge.tests.some((testItem) => testItem.id === decoyTest.id),
    'the round\'s own execute_investigation must never see the prototype-inherited decoy test either',
  );
});

test('the challenge round never invokes an own getter for "tests" on what plan_investigation returns, and takes nothing from it', async () => {
  const decoyTest = Object.freeze({
    id: 'aic125d-own-getter-decoy-test',
    predictionId: 'aic125d-own-getter-decoy-prediction',
    tool: 'metrics',
    input: {},
    cost: 'cheap',
    status: 'planned',
  });
  let getterCalls = 0;
  let planInvestigationCalls = 0;

  function planInvestigationWithOwnGetterTests(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { tests: [] };
    planInvestigationCalls += 1;
    return {
      get tests() {
        getterCalls += 1;
        return [decoyTest];
      },
    };
  }

  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: emptyDerive,
    planInvestigationNode: planInvestigationWithOwnGetterTests,
    challengeHypothesisResult: STUB_CHALLENGE_RESULT,
    executeSpy: () => {},
  });
  const investigationGraph = graph.createInvestigationGraph({ nodes });

  const finalState = await investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() });

  assert.ok(
    planInvestigationCalls > 0,
    'fixture sanity: plan_investigation must actually be invoked over the challenge-round state for this row to test anything',
  );
  assert.equal(getterCalls, 0, 'an own accessor for "tests" must never be invoked');
  assert.ok(
    !finalState.tests.some((testItem) => testItem.id === decoyTest.id),
    'a test behind an own getter must never reach state',
  );
});

test('the challenge round rejects a plan_investigation result whose tests key is not an array', async () => {
  function planInvestigationWithInvalidTestsShape(state) {
    const alternative = state.hypotheses.find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (alternative === undefined) return { tests: [] };
    return { tests: 'not-an-array' };
  }

  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: emptyDerive,
    planInvestigationNode: planInvestigationWithInvalidTestsShape,
    challengeHypothesisResult: STUB_CHALLENGE_RESULT,
    executeSpy: () => {},
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });

  await assert.rejects(
    investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() }),
    /non-array tests/,
    'a non-array tests value from plan_investigation at challenge time must reject rather than corrupt state.tests',
  );
});

test('the challenge-time plan_investigation call does not count a logical iteration: iterationsUsed is unchanged by it', async () => {
  const executeCalls = [];
  let planInvestigationCalls = 0;
  const canonicalPlan = graph.createPlanInvestigation();
  const countingPlan = (state) => {
    if (state.hypotheses.some((hypothesis) => hypothesis.createdBy === 'challenge')) {
      planInvestigationCalls += 1;
    }
    return canonicalPlan(state);
  };
  const nodes = planningWrapperNodes({
    generateHypotheses: causelessLeaderHypotheses,
    deriveePredictions: graph.createDerivePredictions(),
    planInvestigationNode: countingPlan,
    challengeHypothesisResult: {
      alternative: alternativeHypothesis('aic125d-alt-iterations', MAIN_ALTERNATIVE_CAUSE),
      discriminatingTests: STUB_CHALLENGE_RESULT.discriminatingTests,
    },
    executeSpy: (state) => executeCalls.push(state),
  });

  const investigationGraph = graph.createInvestigationGraph({ nodes });
  await investigationGraph.execute({ kind: 'start', state: planningWrapperInitialState() });

  assert.ok(
    planInvestigationCalls > 0,
    'fixture sanity: plan_investigation must actually be invoked over the challenge-round state for this row to test anything',
  );
  assert.equal(executeCalls.length, 2);
  const [beforeChallenge, forChallenge] = executeCalls;
  assert.equal(
    forChallenge.control.iterationsUsed,
    beforeChallenge.control.iterationsUsed,
    'the challenge round\'s inline plan_investigation call must not add a logical iteration: only the wrapped, ordinary lifecycle edge counts one',
  );
});

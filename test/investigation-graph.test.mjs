import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateSchema,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';

const lifecycleNodes = [
  'normalize_incident',
  'collect_baseline',
  'generate_hypotheses',
  'derive_predictions',
  'plan_investigation',
  'execute_investigation',
  'evaluate_predictions',
  'interpret_residual_evidence',
  'derive_hypothesis_state',
  'termination_check',
  'challenge_hypothesis',
  'propose_conclusion',
];

const initialState = () => ({
  incident: { id: 'incident-graph-skeleton' },
  hypotheses: [],
  predictions: [],
  tests: [],
  trials: [],
  evidence: [],
  assessments: [],
  control: {
    runId: 'run-graph-skeleton',
    schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: STATUS_RULES_VERSION,
    phase: 'normalizing',
    maxIterations: 4,
    llmCallBudget: 8,
    iterationsUsed: 0,
    llmCallsUsed: 0,
    resumeCount: 0,
    reservedChallengeBudget: 2,
    challengeRounds: 0,
    humanReview: false,
  },
});

function requireGraphFactory() {
  assert.equal(
    typeof graphPackage.createInvestigationGraph,
    'function',
    '@aic/graph must publish createInvestigationGraph({ nodes })',
  );
  return graphPackage.createInvestigationGraph;
}

function fakeNodes(trace, terminationCheck, challengeHypothesis = async () => ({})) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async (state, ...args) => {
        trace.push(name);
        if (name === 'termination_check') {
          return terminationCheck(state);
        }
        if (name === 'challenge_hypothesis') {
          return challengeHypothesis(state, ...args);
        }
        return {};
      },
    ]),
  );
}

const challengeAlternative = (round) => ({
  id: `challenge-alternative-${round}`,
  statement: `Alternative produced by challenge round ${round}`,
  createdBy: 'challenge',
});

const currentLeader = () => ({
  id: 'current-leader',
  statement: 'The current leading explanation',
  createdBy: 'initial',
});

const discriminatingTest = (round) => ({
  id: `challenge-test-${round}`,
  predictionId: `challenge-prediction-${round}`,
  tool: 'logs.search',
  input: { round },
  cost: 'cheap',
  status: 'planned',
});

test('keeps the twelve frozen lifecycle handlers and adds one sequential conclusion-review node', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const graph = createInvestigationGraph({
    nodes: fakeNodes([], async () => ({ route: 'terminal', stopKind: 'stalled' })),
  });
  const topology = await graph.getGraph();

  assert.deepEqual(
    graphPackage.INVESTIGATION_NODE_NAMES,
    lifecycleNodes,
    'the graph-owned review step must not widen the frozen lifecycle handler contract',
  );
  assert.deepEqual(
    Object.keys(topology.nodes).sort(),
    ['__start__', ...lifecycleNodes, 'review_conclusion', '__end__'].sort(),
    'the graph must not hide a ReAct or prebuilt tool-loop node beside the frozen lifecycle',
  );
  assert.deepEqual(
    topology.edges
      .map(({ conditional, source, target }) =>
        `${source}->${target}:${conditional ? 'conditional' : 'sequential'}`,
      )
      .sort(),
    [
      '__start__->normalize_incident:sequential',
      'normalize_incident->collect_baseline:sequential',
      'collect_baseline->generate_hypotheses:sequential',
      'generate_hypotheses->derive_predictions:sequential',
      'derive_predictions->plan_investigation:sequential',
      'plan_investigation->execute_investigation:sequential',
      'execute_investigation->evaluate_predictions:sequential',
      'evaluate_predictions->interpret_residual_evidence:sequential',
      'interpret_residual_evidence->derive_hypothesis_state:sequential',
      'derive_hypothesis_state->termination_check:sequential',
      'termination_check->plan_investigation:conditional',
      'termination_check->challenge_hypothesis:conditional',
      'termination_check->propose_conclusion:conditional',
      'challenge_hypothesis->execute_investigation:sequential',
      'propose_conclusion->__end__:conditional',
      'propose_conclusion->review_conclusion:conditional',
      'review_conclusion->__end__:conditional',
      'review_conclusion->derive_predictions:conditional',
      'review_conclusion->generate_hypotheses:conditional',
    ].sort(),
  );
  assert.deepEqual(
    topology.edges
      .filter(({ target }) => target === 'review_conclusion')
      .map(({ source }) => source),
    ['propose_conclusion'],
    'review must be one sequential post-conclusion step, never a Send/fan-out target',
  );
});

test('replays the deterministic more-evidence cycle before routing a terminal stop kind', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  let checks = 0;
  const graph = createInvestigationGraph({
    nodes: fakeNodes(trace, async () => {
      checks += 1;
      return checks === 1
        ? { route: 'need-more-evidence' }
        : { route: 'terminal', stopKind: 'stalled' };
    }),
  });

  const result = await graph.execute({ kind: 'start', state: initialState() });

  assert.deepEqual(trace, [
    'normalize_incident',
    'collect_baseline',
    'generate_hypotheses',
    'derive_predictions',
    'plan_investigation',
    'execute_investigation',
    'evaluate_predictions',
    'interpret_residual_evidence',
    'derive_hypothesis_state',
    'termination_check',
    'plan_investigation',
    'execute_investigation',
    'evaluate_predictions',
    'interpret_residual_evidence',
    'derive_hypothesis_state',
    'termination_check',
    'propose_conclusion',
  ]);
  assert.equal(result.control.stopKind, 'stalled');
});

test('routes every canonical terminal stop kind through propose_conclusion to END', async () => {
  const createInvestigationGraph = requireGraphFactory();

  for (const stopKind of [
    'sufficient',
    'ambiguous',
    'stalled',
    'budget-exhausted',
    'tools-unavailable',
    'human-stop',
  ]) {
    const trace = [];
    const graph = createInvestigationGraph({
      nodes: fakeNodes(trace, async () => ({ route: 'terminal', stopKind })),
    });
    const state = initialState();
    if (stopKind === 'sufficient') {
      state.control.challengeRounds = 1;
    }

    const result = await graph.execute({ kind: 'start', state });

    assert.equal(result.control.stopKind, stopKind, `${stopKind} must remain distinguishable`);
    assert.deepEqual(
      trace.slice(-2),
      ['termination_check', 'propose_conclusion'],
      `${stopKind} must take the terminal edge before invoke resolves at END`,
    );
    assert.equal(
      trace.filter((name) => name === 'propose_conclusion').length,
      1,
      `${stopKind} must propose exactly one conclusion`,
    );
  }
});

test('keeps termination_check as the sole owner of the final stop kind', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const nodes = fakeNodes(
    trace,
    async () => ({ route: 'terminal', stopKind: 'stalled' }),
  );
  nodes.propose_conclusion = async (state) => {
    trace.push('propose_conclusion');
    return {
      control: {
        ...state.control,
        stopKind: 'ambiguous',
      },
    };
  };
  const graph = createInvestigationGraph({ nodes });

  const result = await graph.execute({ kind: 'start', state: initialState() });

  assert.deepEqual(trace.slice(-2), ['termination_check', 'propose_conclusion']);
  assert.equal(
    result.control.stopKind,
    'stalled',
    'a later lifecycle handler must not overwrite the termination decision',
  );
});

test('merges a typed challenge result and accounts for its reserved budget in the graph', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  let checks = 0;
  const alternative = challengeAlternative(1);
  const testPlan = discriminatingTest(1);
  const graph = createInvestigationGraph({
    nodes: fakeNodes(
      trace,
      async () => {
        checks += 1;
        return checks === 1
          ? { route: 'challenge-required', leaderId: 'current-leader' }
          : { route: 'terminal', stopKind: 'stalled' };
      },
      async () => ({
        alternative,
        discriminatingTests: [testPlan],
      }),
    ),
  });
  const state = initialState();
  state.hypotheses = [currentLeader()];

  const result = await graph.execute({ kind: 'start', state });

  assert.deepEqual(
    Object.keys(result).sort(),
    Object.keys(state).sort(),
    'transient challenge routing must not become persisted IncidentState',
  );
  assert.equal(checks, 2);
  assert.deepEqual(
    trace.slice(trace.indexOf('termination_check')),
    [
      'termination_check',
      'challenge_hypothesis',
      'execute_investigation',
      'evaluate_predictions',
      'interpret_residual_evidence',
      'derive_hypothesis_state',
      'termination_check',
      'propose_conclusion',
    ],
  );
  assert.deepEqual(result.hypotheses, [currentLeader(), alternative]);
  assert.deepEqual(result.tests, [testPlan]);
  assert.equal(result.control.challengeRounds, 1);
  assert.equal(result.control.reservedChallengeBudget, 1);
  assert.equal(result.control.stopKind, 'stalled');
  assert.equal('confidence' in result.hypotheses[1], false);
  assert.equal('score' in result.hypotheses[1], false);
});

for (const malformedCase of [
  {
    name: 'an alternative with numeric confidence',
    result: () => ({
      alternative: { ...challengeAlternative(1), confidence: 0.75 },
      discriminatingTests: [discriminatingTest(1)],
    }),
  },
  {
    name: 'an alternative not created by challenge',
    result: () => ({
      alternative: { ...challengeAlternative(1), createdBy: 'initial' },
      discriminatingTests: [discriminatingTest(1)],
    }),
  },
  {
    name: 'a string discriminating-tests collection',
    result: () => ({
      alternative: challengeAlternative(1),
      discriminatingTests: 'not-an-array',
    }),
  },
  {
    name: 'an invalid discriminating test',
    result: () => ({
      alternative: challengeAlternative(1),
      discriminatingTests: [{ ...discriminatingTest(1), cost: 'free' }],
    }),
  },
  {
    name: 'an empty discriminating-test list',
    result: () => ({
      alternative: challengeAlternative(1),
      discriminatingTests: [],
    }),
  },
  {
    name: 'an alternative ID already present in state',
    result: (state) => ({
      alternative: {
        ...challengeAlternative(1),
        id: state.hypotheses[0].id,
      },
      discriminatingTests: [discriminatingTest(1)],
    }),
  },
  {
    name: 'a test ID already present in state',
    prepare: (state) => {
      state.tests = [discriminatingTest(1)];
    },
    result: () => ({
      alternative: challengeAlternative(1),
      discriminatingTests: [
        {
          ...discriminatingTest(1),
          input: { replacement: true },
        },
      ],
    }),
  },
]) {
  test(`rejects ${malformedCase.name} before merging or consuming challenge budget`, async () => {
    const createInvestigationGraph = requireGraphFactory();
    const trace = [];
    const postChallengeObservations = [];
    let challengeCalls = 0;
    let checks = 0;
    const state = initialState();
    state.hypotheses = [currentLeader()];
    malformedCase.prepare?.(state);
    const challengeResult = malformedCase.result(state);
    const nodes = fakeNodes(
      trace,
      async () => {
        checks += 1;
        if (checks === 1) {
          postChallengeObservations.length = 0;
          return { route: 'challenge-required', leaderId: 'current-leader' };
        }
        return { route: 'terminal', stopKind: 'stalled' };
      },
      async () => {
        challengeCalls += 1;
        return challengeResult;
      },
    );
    nodes.execute_investigation = async (current) => {
      trace.push('execute_investigation');
      postChallengeObservations.push({
        challengeRounds: current.control.challengeRounds,
        reservedChallengeBudget: current.control.reservedChallengeBudget,
        hypothesisIds: current.hypotheses.map(({ id }) => id),
        testIds: current.tests.map((item) => item?.id),
      });
      return {};
    };
    const graph = createInvestigationGraph({ nodes });

    const outcome = await graph.execute({ kind: 'start', state }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    assert.equal(challengeCalls, 1);
    assert.deepEqual(
      postChallengeObservations,
      [],
      'invalid output must stop before reducers and budget accounting run',
    );
    assert.equal('error' in outcome, true, 'invalid output must reject invocation');
  });
}

test('does not let normal lifecycle nodes consume reserved challenge budget', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const nodes = fakeNodes(
    trace,
    async () => ({ route: 'terminal', stopKind: 'stalled' }),
  );
  nodes.plan_investigation = async (state) => {
    trace.push('plan_investigation');
    return {
      control: {
        ...state.control,
        reservedChallengeBudget: 0,
        challengeRounds: 1,
      },
    };
  };
  const graph = createInvestigationGraph({ nodes });

  const result = await graph.execute({ kind: 'start', state: initialState() });

  assert.equal(result.control.challengeRounds, 0);
  assert.equal(result.control.reservedChallengeBudget, 2);
});

test('restores graph-owned control after in-place mutation and still performs mandatory challenge', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  let challengeCalls = 0;
  const nodes = fakeNodes(
    trace,
    async () => ({
      route: 'terminal',
      stopKind: 'sufficient',
      leaderId: 'current-leader',
    }),
    async () => {
      challengeCalls += 1;
      return {
        alternative: challengeAlternative(challengeCalls),
        discriminatingTests: [discriminatingTest(challengeCalls)],
      };
    },
  );
  nodes.plan_investigation = async (state) => {
    trace.push('plan_investigation');
    state.control.challengeRounds = 2;
    state.control.reservedChallengeBudget = 0;
    return {};
  };
  const graph = createInvestigationGraph({ nodes });
  const state = initialState();
  state.hypotheses = [currentLeader()];

  const result = await graph.execute({ kind: 'start', state });

  assert.equal(challengeCalls, 1);
  assert.equal(result.control.challengeRounds, 1);
  assert.equal(result.control.reservedChallengeBudget, 1);
  assert.equal(result.control.stopKind, 'sufficient');
});

test('terminates budget-exhausted without challenging when the reserve is empty', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  let challengeCalls = 0;
  const graph = createInvestigationGraph({
    nodes: fakeNodes(
      trace,
      async () => ({
        route: 'challenge-required',
        leaderId: 'current-leader',
      }),
      async () => {
        challengeCalls += 1;
        return {
          alternative: challengeAlternative(challengeCalls),
          discriminatingTests: [discriminatingTest(challengeCalls)],
        };
      },
    ),
  });
  const state = initialState();
  state.hypotheses = [currentLeader()];
  state.control.reservedChallengeBudget = 0;

  const result = await graph.execute({ kind: 'start', state });

  assert.equal(challengeCalls, 0);
  assert.equal(result.control.stopKind, 'budget-exhausted');
  assert.equal(result.control.challengeRounds, 0);
  assert.equal(result.control.reservedChallengeBudget, 0);
  assert.deepEqual(trace.slice(-2), ['termination_check', 'propose_conclusion']);
});

for (const invalidCounter of [
  { field: 'challengeRounds', label: 'fractional challenge rounds', value: 0.5 },
  { field: 'challengeRounds', label: 'negative challenge rounds', value: -1 },
  {
    field: 'challengeRounds',
    label: 'non-safe-integer challenge rounds',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  {
    field: 'reservedChallengeBudget',
    label: 'fractional challenge reserve',
    value: 0.5,
  },
  {
    field: 'reservedChallengeBudget',
    label: 'negative challenge reserve',
    value: -1,
  },
  {
    field: 'reservedChallengeBudget',
    label: 'non-safe-integer challenge reserve',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
]) {
  test(`fails closed on ${invalidCounter.label} before challenge execution`, async () => {
    const createInvestigationGraph = requireGraphFactory();
    const trace = [];
    let challengeCalls = 0;
    const graph = createInvestigationGraph({
      nodes: fakeNodes(
        trace,
        async () => ({
          route: 'challenge-required',
          leaderId: 'current-leader',
        }),
        async () => {
          challengeCalls += 1;
          return {
            alternative: challengeAlternative(challengeCalls),
            discriminatingTests: [discriminatingTest(challengeCalls)],
          };
        },
      ),
    });
    const state = initialState();
    state.hypotheses = [currentLeader()];
    state.control[invalidCounter.field] = invalidCounter.value;

    const outcome = await graph.execute({ kind: 'start', state }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    assert.equal(challengeCalls, 0, 'invalid counters must fail before challenge execution');
    assert.equal('error' in outcome, true, 'invalid counters must reject invocation');
    assert.deepEqual(
      trace,
      [],
      'a counter that is not a count must be refused at the input boundary, before any lifecycle node runs',
    );
  });
}

/**
 * The row above stops at "not a count". This one is the other side of that
 * line: `MAX_CHALLENGE_ROUNDS + 1` is a perfectly good count, so the domain
 * schema accepts it — see domain-contract.test.mjs > "accepts a challenge round
 * count past the graph cap, which is not a schema concern" — and only the graph
 * knows it is not a state this graph can be in.
 *
 * This is the regression pin on `assertChallengeCounters`: however strict the
 * schema becomes about the SHAPE of the counter, the cap stays the graph's job,
 * and deleting the guard because "the schema covers it now" turns this red.
 * Unlike the rows above, lifecycle nodes DO run here before the refusal lands —
 * the input was well-formed, so the refusal cannot come from the boundary.
 */
test('refuses a start state one past the challenge round cap, which the domain schema accepts', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  let challengeCalls = 0;
  const graph = createInvestigationGraph({
    nodes: fakeNodes(
      trace,
      async () => ({
        route: 'challenge-required',
        leaderId: 'current-leader',
      }),
      async () => {
        challengeCalls += 1;
        return {
          alternative: challengeAlternative(challengeCalls),
          discriminatingTests: [discriminatingTest(challengeCalls)],
        };
      },
    ),
  });
  const state = initialState();
  state.hypotheses = [currentLeader()];
  state.control.challengeRounds = graphPackage.MAX_CHALLENGE_ROUNDS + 1;

  assert.equal(
    IncidentStateSchema.safeParse(state).success,
    true,
    'this state must be well-formed at the domain boundary, or the graph refusal below proves nothing about the cap',
  );

  const outcome = await graph.execute({ kind: 'start', state }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  assert.equal(challengeCalls, 0, 'a run past the cap must not execute another challenge');
  assert.equal('error' in outcome, true, 'a challenge round count past the cap must reject the run');
  assert.match(
    outcome.error.message,
    /invalid challenge round counter/,
    'the refusal must name the counter it refused on, not surface as an opaque input error',
  );
});

test('targets the adjudicated leader for both challenge rounds and terminates a third request as ambiguous', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const challengeTargets = [];
  let challengeCalls = 0;
  let checks = 0;
  const graph = createInvestigationGraph({
    nodes: fakeNodes(
      trace,
      async () => {
        checks += 1;
        return {
          route: 'challenge-required',
          leaderId:
            checks === 1 ? 'current-leader' : `challenge-alternative-${checks - 1}`,
        };
      },
      async (_state, leaderId) => {
        challengeCalls += 1;
        challengeTargets.push(leaderId);
        return {
          alternative: challengeAlternative(challengeCalls),
          discriminatingTests: [discriminatingTest(challengeCalls)],
        };
      },
    ),
  });
  const state = initialState();
  state.hypotheses = [currentLeader()];

  const result = await graph.execute({ kind: 'start', state });

  assert.equal(challengeCalls, 2);
  assert.deepEqual(challengeTargets, [
    'current-leader',
    'challenge-alternative-1',
  ]);
  assert.deepEqual(
    result.hypotheses.map(({ id }) => id),
    ['current-leader', 'challenge-alternative-1', 'challenge-alternative-2'],
  );
  assert.deepEqual(
    result.tests.map(({ id }) => id),
    ['challenge-test-1', 'challenge-test-2'],
  );
  assert.equal(result.control.challengeRounds, 2);
  assert.equal(result.control.reservedChallengeBudget, 0);
  assert.equal(result.control.stopKind, 'ambiguous');
  assert.deepEqual(trace.slice(-2), ['termination_check', 'propose_conclusion']);
});

test('does not expose sufficient until termination_check runs after mandatory challenge', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const observedStopKinds = [];
  let checks = 0;
  const graph = createInvestigationGraph({
    nodes: fakeNodes(
      trace,
      async () => {
        checks += 1;
        return {
          route: 'terminal',
          stopKind: 'sufficient',
          leaderId: 'current-leader',
        };
      },
      async (state) => {
        observedStopKinds.push(state.control.stopKind);
        return {
          alternative: challengeAlternative(1),
          discriminatingTests: [discriminatingTest(1)],
        };
      },
    ),
  });
  const state = initialState();
  state.hypotheses = [currentLeader()];

  const result = await graph.execute({ kind: 'start', state });

  assert.deepEqual(observedStopKinds, [undefined]);
  assert.equal(checks, 2);
  assert.equal(trace.filter((name) => name === 'challenge_hypothesis').length, 1);
  assert.equal(trace.at(-1), 'propose_conclusion');
  assert.equal(result.control.challengeRounds, 1);
  assert.equal(result.control.reservedChallengeBudget, 1);
  assert.equal(result.control.stopKind, 'sufficient');
});

const budgetedNodes = (trace, terminationCheck, planResult = async () => ({})) => {
  const nodes = fakeNodes(trace, terminationCheck);
  nodes.plan_investigation = async (state) => {
    trace.push('plan_investigation');
    return planResult(state);
  };
  return nodes;
};

const runToCompletion = (graph, state) =>
  graph.execute({ kind: 'start', state }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

const assertResolved = (outcome, message) => {
  assert.equal(
    'error' in outcome,
    false,
    `${message}: ${outcome.error?.message ?? ''}`,
  );
  return outcome.value;
};

test('terminates budget-exhausted when the iteration budget is spent instead of running away', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: fakeNodes(trace, async () => ({ route: 'need-more-evidence' })),
  });
  const state = initialState();
  state.control.maxIterations = 2;

  const outcome = await runToCompletion(graph, state);

  const result = assertResolved(
    outcome,
    'an exhausted iteration budget must stop the graph, not abort the run',
  );
  assert.equal(result.control.stopKind, 'budget-exhausted');
  assert.equal(
    trace.filter((name) => name === 'plan_investigation').length,
    2,
    'the graph must not plan a third iteration beyond maxIterations',
  );
  assert.deepEqual(trace.slice(-2), ['termination_check', 'propose_conclusion']);
});

test('counts one logical iteration per plan_investigation entry up to the iteration budget', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: fakeNodes(trace, async () => ({ route: 'need-more-evidence' })),
  });
  const state = initialState();
  state.control.maxIterations = 2;

  const outcome = await runToCompletion(graph, state);

  const result = assertResolved(outcome, 'the iteration budget must end the run cleanly');
  assert.equal(result.control.iterationsUsed, 2);
  assert.equal(
    result.control.iterationsUsed,
    trace.filter((name) => name === 'plan_investigation').length,
    'iterationsUsed must report the iterations the graph really ran',
  );
});

test('counts a single logical iteration when the first termination check ends the run', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: fakeNodes(trace, async () => ({ route: 'terminal', stopKind: 'stalled' })),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(outcome, 'a single-pass run must resolve');
  assert.equal(result.control.iterationsUsed, 1);
  assert.equal(result.control.stopKind, 'stalled');
});

test('leaves llmCallsUsed at zero when no node declares an llm call', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: fakeNodes(trace, async () => ({ route: 'terminal', stopKind: 'stalled' })),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(outcome, 'a run without any llm execution must resolve');
  assert.equal(
    result.control.llmCallsUsed,
    0,
    'with no llm execution path the graph must not invent consumption',
  );
});

test('adds a node-declared llm call count to llmCallsUsed through the typed boundary', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      trace,
      async () => ({ route: 'terminal', stopKind: 'stalled' }),
      async () => ({ declaredLlmCalls: 3 }),
    ),
  });
  const state = initialState();

  const outcome = await runToCompletion(graph, state);

  const result = assertResolved(outcome, 'a declared llm call count must be accepted');
  assert.equal(result.control.llmCallsUsed, 3);
  assert.deepEqual(
    Object.keys(result).sort(),
    Object.keys(state).sort(),
    'a declared call count must not become persisted IncidentState',
  );
  assert.equal(
    'declaredLlmCalls' in result.control,
    false,
    'the declaration channel must not leak into control',
  );
});

test('terminates budget-exhausted when declared llm calls reach llmCallBudget', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      trace,
      async () => ({ route: 'need-more-evidence' }),
      async () => ({ declaredLlmCalls: 2 }),
    ),
  });
  const state = initialState();
  state.control.maxIterations = 8;
  state.control.llmCallBudget = 4;

  const outcome = await runToCompletion(graph, state);

  const result = assertResolved(
    outcome,
    'an exhausted llm call budget must stop the graph, not abort the run',
  );
  assert.equal(result.control.stopKind, 'budget-exhausted');
  assert.equal(result.control.llmCallsUsed, 4);
  assert.equal(
    trace.filter((name) => name === 'plan_investigation').length,
    2,
    'the graph must not spend a third batch of declared calls past llmCallBudget',
  );
  assert.deepEqual(trace.slice(-2), ['termination_check', 'propose_conclusion']);
});

test('does not let normal lifecycle nodes rewrite the graph-owned logical budgets', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      trace,
      async () => ({ route: 'terminal', stopKind: 'stalled' }),
      async (state) => ({
        control: {
          ...state.control,
          maxIterations: 99,
          llmCallBudget: 99,
          iterationsUsed: 0,
          llmCallsUsed: 42,
        },
      }),
    ),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(outcome, 'the run must resolve with the graph-owned budgets intact');
  assert.equal(result.control.maxIterations, 4);
  assert.equal(result.control.llmCallBudget, 8);
  assert.equal(result.control.iterationsUsed, 1);
  assert.equal(result.control.llmCallsUsed, 0);
});

/**
 * The node here mutates the control it was handed and returns that same object,
 * because mutating it and returning nothing proves nothing: the graph hands a
 * node a shallow copy of control, so an unreturned mutation never reaches the
 * channel whether the budgets are protected or not.
 *
 * Under the mutation this test exists for — removing the graph-owned
 * restoration of these budget fields — it now reddens together with the test
 * above that spreads and returns. That is the discrimination the unreturned
 * form did not have, and it is most of what this shape buys: expect the two to
 * fail together, and do not read a green here as cover the sibling lacks.
 *
 * They are not interchangeable, though. Freeze the copy — `Object.freeze({
 * ...state.control })` in `incidentStateOf` — and this test fails on the write
 * while the sibling passes, so the in-place shape also pins that the control a
 * node is handed is writable at all.
 *
 * What neither pins is the copy's EXISTENCE: with `control: state.control` in
 * its place the whole suite stays green, which is what made the unreturned form
 * vacuous. Covering that needs its own change.
 */
test('restores graph-owned logical budgets after in-place mutation by a lifecycle node', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      trace,
      async () => ({ route: 'terminal', stopKind: 'stalled' }),
      async (state) => {
        state.control.maxIterations = 99;
        state.control.llmCallBudget = 99;
        state.control.iterationsUsed = 0;
        state.control.llmCallsUsed = 42;
        return { control: state.control };
      },
    ),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(outcome, 'the run must resolve with the graph-owned budgets intact');
  assert.equal(result.control.maxIterations, 4);
  assert.equal(result.control.llmCallBudget, 8);
  assert.equal(result.control.iterationsUsed, 1);
  assert.equal(result.control.llmCallsUsed, 0);
});

test('leaves resumeCount at zero on a run that never pauses for a human', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: fakeNodes(trace, async () => ({ route: 'terminal', stopKind: 'stalled' })),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(outcome, 'an unattended run must resolve');
  assert.equal(
    result.control.resumeCount,
    0,
    'a run nobody resumed must report no resumes, not an invented one',
  );
});

test('does not let normal lifecycle nodes rewrite the graph-owned resume counter', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      trace,
      async () => ({ route: 'terminal', stopKind: 'stalled' }),
      async (state) => ({
        control: {
          ...state.control,
          resumeCount: 42,
        },
      }),
    ),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(
    outcome,
    'the run must resolve with the graph-owned resume counter intact',
  );
  assert.equal(
    result.control.resumeCount,
    0,
    'only the graph may write resumeCount, so a node claiming resumes must be ignored',
  );
});

/**
 * The node here mutates the control it was handed and returns that same object,
 * because mutating it and returning nothing proves nothing: the graph hands a
 * node a shallow copy of control, so an unreturned mutation never reaches the
 * channel whether the counter is protected or not.
 */
test('restores the graph-owned resume counter when a lifecycle node mutates the control it was handed', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      trace,
      async () => ({ route: 'terminal', stopKind: 'stalled' }),
      async (state) => {
        state.control.resumeCount = 42;
        return { control: state.control };
      },
    ),
  });

  const outcome = await runToCompletion(graph, initialState());

  const result = assertResolved(
    outcome,
    'the run must resolve with the graph-owned resume counter intact',
  );
  assert.equal(
    result.control.resumeCount,
    0,
    'a mutated resume counter must be restored, not carried into the persisted control',
  );
});

/**
 * A corrupt-counter case only proves fail-closed behaviour if the same fixture
 * without the corruption runs to completion, so each one asserts that baseline
 * first: a fixture the graph rejects wholesale would pass every rejection
 * assertion below for the wrong reason.
 */
const assertUncorruptedRunResolves = async (
  createInvestigationGraph,
  planResult = async () => ({}),
) => {
  const graph = createInvestigationGraph({
    nodes: budgetedNodes(
      [],
      async () => ({ route: 'terminal', stopKind: 'stalled' }),
      planResult,
    ),
  });

  assertResolved(
    await runToCompletion(graph, initialState()),
    'the same fixture without the corrupt value must resolve',
  );
};

for (const invalidBudgetCounter of [
  { field: 'iterationsUsed', label: 'fractional iterations used', value: 0.5 },
  { field: 'iterationsUsed', label: 'negative iterations used', value: -1 },
  {
    field: 'iterationsUsed',
    label: 'non-safe-integer iterations used',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  { field: 'llmCallsUsed', label: 'fractional llm calls used', value: 0.5 },
  { field: 'llmCallsUsed', label: 'negative llm calls used', value: -1 },
  {
    field: 'llmCallsUsed',
    label: 'non-safe-integer llm calls used',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  { field: 'maxIterations', label: 'a fractional iteration budget', value: 0.5 },
  { field: 'maxIterations', label: 'a negative iteration budget', value: -1 },
  {
    field: 'maxIterations',
    label: 'a non-safe-integer iteration budget',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  { field: 'resumeCount', label: 'a fractional resume count', value: 0.5 },
  { field: 'resumeCount', label: 'a negative resume count', value: -1 },
  {
    field: 'resumeCount',
    label: 'a non-safe-integer resume count',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  { field: 'llmCallBudget', label: 'a fractional llm call budget', value: 0.5 },
  { field: 'llmCallBudget', label: 'a negative llm call budget', value: -1 },
  {
    field: 'llmCallBudget',
    label: 'a non-safe-integer llm call budget',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
]) {
  test(`fails closed on ${invalidBudgetCounter.label} before spending a logical budget`, async () => {
    const createInvestigationGraph = requireGraphFactory();
    await assertUncorruptedRunResolves(createInvestigationGraph);

    const trace = [];
    const graph = createInvestigationGraph({
      nodes: fakeNodes(trace, async () => ({ route: 'terminal', stopKind: 'stalled' })),
    });
    const state = initialState();
    state.control[invalidBudgetCounter.field] = invalidBudgetCounter.value;

    const outcome = await runToCompletion(graph, state);

    assert.equal('error' in outcome, true, 'a corrupt logical budget must reject invocation');
    assert.equal(
      trace.includes('propose_conclusion'),
      false,
      'a corrupt logical budget must fail before the run spends budget on a conclusion',
    );
  });
}

for (const invalidDeclaration of [
  { label: 'a fractional', value: 0.5 },
  { label: 'a negative', value: -1 },
  { label: 'a non-safe-integer', value: Number.MAX_SAFE_INTEGER + 1 },
  { label: 'a non-numeric', value: '2' },
]) {
  test(`fails closed on a node declaring ${invalidDeclaration.label} llm call count`, async () => {
    const createInvestigationGraph = requireGraphFactory();
    await assertUncorruptedRunResolves(
      createInvestigationGraph,
      async () => ({ declaredLlmCalls: 1 }),
    );

    const trace = [];
    const graph = createInvestigationGraph({
      nodes: budgetedNodes(
        trace,
        async () => ({ route: 'terminal', stopKind: 'stalled' }),
        async () => ({ declaredLlmCalls: invalidDeclaration.value }),
      ),
    });

    const outcome = await runToCompletion(graph, initialState());

    assert.equal(
      'error' in outcome,
      true,
      'an unusable llm call declaration must reject the invocation',
    );
    assert.equal(
      trace.includes('propose_conclusion'),
      false,
      'an unusable llm call declaration must fail before a conclusion is proposed',
    );
  });
}

/**
 * The declaration channel is a node's own report of what it spent. Reading it
 * off the prototype chain lets an inherited property spend a budget no node
 * declared, so the two halves are pinned together under the same poisoned
 * prototype: inherited is absent, own is still honoured.
 */
test('ignores an inherited declaredLlmCalls while still honouring an own one', async () => {
  const createInvestigationGraph = requireGraphFactory();
  Object.defineProperty(Object.prototype, 'declaredLlmCalls', {
    value: 7,
    configurable: true,
    writable: true,
  });

  try {
    const inheritedOnly = createInvestigationGraph({
      nodes: budgetedNodes(
        [],
        async () => ({ route: 'terminal', stopKind: 'stalled' }),
        async () => ({}),
      ),
    });
    const declaredNothing = assertResolved(
      await runToCompletion(inheritedOnly, initialState()),
      'a run whose nodes declare nothing must resolve',
    );

    const ownDeclaration = createInvestigationGraph({
      nodes: budgetedNodes(
        [],
        async () => ({ route: 'terminal', stopKind: 'stalled' }),
        async () => ({ declaredLlmCalls: 3 }),
      ),
    });
    const declaredThree = assertResolved(
      await runToCompletion(ownDeclaration, initialState()),
      'a run declaring its own llm calls must resolve',
    );

    assert.deepEqual(
      {
        inherited: declaredNothing.control.llmCallsUsed,
        own: declaredThree.control.llmCallsUsed,
      },
      { inherited: 0, own: 3 },
      'only an own declaredLlmCalls may spend the llm call budget',
    );
  } finally {
    delete Object.prototype.declaredLlmCalls;
  }

  assert.equal(
    Object.hasOwn(Object.prototype, 'declaredLlmCalls'),
    false,
    'the poisoned prototype must not outlive this test',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
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

test('publishes exactly the twelve frozen lifecycle nodes and their deterministic edges', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const graph = createInvestigationGraph({
    nodes: fakeNodes([], async () => ({ route: 'terminal', stopKind: 'stalled' })),
  });
  const topology = await graph.getGraph();

  assert.deepEqual(
    Object.keys(topology.nodes).sort(),
    ['__start__', ...lifecycleNodes, '__end__'].sort(),
    'the graph must not hide a ReAct or prebuilt tool-loop node beside the frozen lifecycle',
  );
  assert.deepEqual(
    topology.edges.map(({ source, target }) => `${source}->${target}`).sort(),
    [
      '__start__->normalize_incident',
      'normalize_incident->collect_baseline',
      'collect_baseline->generate_hypotheses',
      'generate_hypotheses->derive_predictions',
      'derive_predictions->plan_investigation',
      'plan_investigation->execute_investigation',
      'execute_investigation->evaluate_predictions',
      'evaluate_predictions->interpret_residual_evidence',
      'interpret_residual_evidence->derive_hypothesis_state',
      'derive_hypothesis_state->termination_check',
      'termination_check->plan_investigation',
      'termination_check->challenge_hypothesis',
      'termination_check->propose_conclusion',
      'challenge_hypothesis->execute_investigation',
      'propose_conclusion->__end__',
    ].sort(),
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

  const result = await graph.invoke(initialState());

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

    const result = await graph.invoke(state);

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

  const result = await graph.invoke(initialState());

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

  const result = await graph.invoke(state);

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

    const outcome = await graph.invoke(state).then(
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

  const result = await graph.invoke(initialState());

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

  const result = await graph.invoke(state);

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

  const result = await graph.invoke(state);

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

    const outcome = await graph.invoke(state).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    assert.equal(challengeCalls, 0, 'invalid counters must fail before challenge execution');
    assert.equal('error' in outcome, true, 'invalid counters must reject invocation');
  });
}

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

  const result = await graph.invoke(state);

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

  const result = await graph.invoke(state);

  assert.deepEqual(observedStopKinds, [undefined]);
  assert.equal(checks, 2);
  assert.equal(trace.filter((name) => name === 'challenge_hypothesis').length, 1);
  assert.equal(trace.at(-1), 'propose_conclusion');
  assert.equal(result.control.challengeRounds, 1);
  assert.equal(result.control.reservedChallengeBudget, 1);
  assert.equal(result.control.stopKind, 'sufficient');
});

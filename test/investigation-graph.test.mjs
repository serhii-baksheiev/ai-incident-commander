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
      async (state) => {
        trace.push(name);
        if (name === 'termination_check') {
          return terminationCheck(state);
        }
        if (name === 'challenge_hypothesis') {
          return challengeHypothesis(state);
        }
        return {};
      },
    ]),
  );
}

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

test('does not expose sufficient until termination_check runs after mandatory challenge', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const observedStopKinds = [];
  const graph = createInvestigationGraph({
    nodes: fakeNodes(
      trace,
      async () => ({ route: 'terminal', stopKind: 'sufficient' }),
      async (state) => {
        observedStopKinds.push(state.control.stopKind);
        return {
          control: {
            ...state.control,
            challengeRounds: state.control.challengeRounds + 1,
          },
        };
      },
    ),
  });

  const result = await graph.invoke(initialState());

  assert.deepEqual(observedStopKinds, [undefined]);
  assert.equal(trace.filter((name) => name === 'challenge_hypothesis').length, 1);
  assert.equal(trace.at(-1), 'propose_conclusion');
  assert.equal(result.control.challengeRounds, 1);
  assert.equal(result.control.stopKind, 'sufficient');
});

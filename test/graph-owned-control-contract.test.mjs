import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateControlSchema,
  InvestigationPhaseSchema,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(
  projectRoot,
  'test/fixtures/graph-owned-control-type-contract.ts',
);

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

/** The stop kind `terminalStall` decides, and the only one this file uses. */
const TERMINAL_STOP_KIND = 'stalled';

const initialState = () => ({
  incident: { id: 'incident-graph-owned-control' },
  hypotheses: [],
  predictions: [],
  tests: [],
  trials: [],
  evidence: [],
  assessments: [],
  control: {
    runId: 'run-graph-owned-control',
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

/**
 * The control fields a lifecycle node is still allowed to write, spelled out
 * here rather than derived, so that the classification below is a claim this
 * test makes and not a restatement of the implementation's answer.
 *
 * What this forces: a field added to `IncidentStateControlSchema` belongs to
 * exactly one of the two sets, and until someone says which, the partition test
 * goes red. A new field can no longer arrive unclassified — which is the
 * failure this whole contract exists to stop.
 */
const NODE_WRITABLE_CONTROL_FIELDS = [
  'schemaVersion',
  'statusRulesVersion',
  'phase',
];

/**
 * For each graph-owned field, a value that is valid for its type and differs
 * from what `initialState()` starts with — so a hijack that got through is
 * visible rather than accidentally equal to what the graph would have written.
 */
const HIJACK_VALUES = {
  runId: 'hijacked-run',
  humanReview: true,
  stopKind: 'human-stop',
  iterationsUsed: 42,
  llmCallsUsed: 42,
  resumeCount: 7,
  challengeRounds: 99,
  reservedChallengeBudget: 99,
  maxIterations: 99,
  llmCallBudget: 99,
};

/**
 * The control a run of `fakeNodes` + `terminalStall` must end with, DECLARED
 * rather than captured from a baseline run of the same code.
 *
 * A baseline run cannot discriminate: a mutation that moves the hijack run also
 * moves the baseline, so the two stay equal and the assertion says nothing.
 * This literal does not move.
 */
const EXPECTED_FINAL_CONTROL = {
  schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
  statusRulesVersion: STATUS_RULES_VERSION,
  phase: 'normalizing',
  runId: 'run-graph-owned-control',
  humanReview: false,
  challengeRounds: 0,
  reservedChallengeBudget: 2,
  maxIterations: 4,
  llmCallBudget: 8,
  iterationsUsed: 1,
  llmCallsUsed: 0,
  resumeCount: 0,
  stopKind: TERMINAL_STOP_KIND,
};

/**
 * Every value a graph-owned field is allowed to hold **while the run is still
 * going** — read by the nodes themselves, one snapshot per node.
 *
 * This is the assertion the final control cannot make. `terminate()` rewrites
 * `stopKind` on every path into `propose_conclusion`, so a `stopKind` a node
 * smuggled in earlier is overwritten before anyone reads the result: the run
 * ends correct and was wrong throughout. The same holds more weakly for the
 * other nine — a mid-run leak is visible to every later node and to every
 * checkpoint written in between, whatever the final value says.
 *
 * `iterationsUsed` legitimately moves 0 -> 1 when `plan_investigation` is
 * entered, which is why these are sets rather than single values.
 *
 * `propose_conclusion` is the one node exempt from the `stopKind` half: it runs
 * only after `terminate()` has written the stop kind the graph itself decided,
 * so seeing one there is the correct state and not a leak. It is still checked
 * — against that decided value — rather than skipped.
 */
const EXPECTED_OBSERVED_VALUES = {
  runId: ['run-graph-owned-control'],
  humanReview: [false],
  stopKind: [undefined],
  iterationsUsed: [0, 1],
  llmCallsUsed: [0],
  resumeCount: [0],
  challengeRounds: [0],
  reservedChallengeBudget: [2],
  maxIterations: [4],
  llmCallBudget: [8],
};

function requireGraphFactory() {
  assert.equal(
    typeof graphPackage.createInvestigationGraph,
    'function',
    '@aic/graph must publish createInvestigationGraph({ nodes })',
  );
  return graphPackage.createInvestigationGraph;
}

function requireGraphOwnedControlFields() {
  const fields = graphPackage.GRAPH_OWNED_CONTROL_FIELDS;
  assert.equal(
    Array.isArray(fields),
    true,
    '@aic/graph must publish GRAPH_OWNED_CONTROL_FIELDS as one exported list',
  );
  return fields;
}

function fakeNodes(trace, terminationCheck, ordinaryResult = async () => ({})) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async (state, ...args) => {
        trace.push(name);
        if (name === 'termination_check') {
          return terminationCheck(state, ...args);
        }
        if (name === 'challenge_hypothesis') {
          return {};
        }
        return ordinaryResult(state, name);
      },
    ]),
  );
}

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

const terminalStall = async () => ({
  route: 'terminal',
  stopKind: TERMINAL_STOP_KIND,
});

test('publishes the graph-owned control field set as one exported constant', () => {
  const fields = requireGraphOwnedControlFields();

  assert.equal(
    fields.length > 0,
    true,
    'an empty graph-owned set would protect nothing',
  );
  assert.deepStrictEqual(
    fields.filter((field) => typeof field !== 'string'),
    [],
    'every graph-owned control field must be named by a string',
  );
  assert.equal(
    new Set(fields).size,
    fields.length,
    'a duplicated field name means two sites disagree about the list',
  );

  const declared = Object.keys(IncidentStateControlSchema.shape);
  assert.deepStrictEqual(
    fields.filter((field) => !declared.includes(field)),
    [],
    'a graph-owned field the control schema does not declare protects nothing',
  );
});

test('classifies every control field the schema declares as graph-owned or node-writable', () => {
  const graphOwned = new Set(requireGraphOwnedControlFields());
  const nodeWritable = new Set(NODE_WRITABLE_CONTROL_FIELDS);

  assert.deepStrictEqual(
    [...graphOwned].filter((field) => nodeWritable.has(field)).sort(),
    [],
    'a field cannot be both graph-owned and node-writable',
  );
  assert.deepStrictEqual(
    [...graphOwned, ...nodeWritable].sort(),
    Object.keys(IncidentStateControlSchema.shape).sort(),
    'every control field the schema declares must be classified exactly once',
  );
});

test('keeps every graph-owned control field intact when a lifecycle node writes it', async (t) => {
  const createInvestigationGraph = requireGraphFactory();
  const graphOwned = requireGraphOwnedControlFields();

  assert.deepStrictEqual(
    Object.keys(HIJACK_VALUES).sort(),
    [...graphOwned].sort(),
    'each graph-owned field needs a hijack value, or a new field goes untested',
  );

  const clean = assertResolved(
    await runToCompletion(
      createInvestigationGraph({ nodes: fakeNodes([], terminalStall) }),
      initialState(),
    ),
    'the undisturbed run must resolve before any hijack is judged',
  ).control;
  assert.deepStrictEqual(
    clean,
    EXPECTED_FINAL_CONTROL,
    'the declared expectation must describe what an undisturbed run really ends with',
  );

  for (const field of graphOwned) {
    await t.test(`restores ${field} written by a lifecycle node`, async () => {
      const graph = createInvestigationGraph({
        nodes: fakeNodes([], terminalStall, async (state) => ({
          control: { ...state.control, [field]: HIJACK_VALUES[field] },
        })),
      });

      const result = assertResolved(
        await runToCompletion(graph, initialState()),
        `a node writing ${field} must not abort the run`,
      );

      assert.deepStrictEqual(
        result.control,
        EXPECTED_FINAL_CONTROL,
        `a lifecycle node writing ${field} must leave the persisted control untouched`,
      );
    });
  }
});

test('hides a hijacked graph-owned field from every node that runs after it', async (t) => {
  const createInvestigationGraph = requireGraphFactory();
  const graphOwned = requireGraphOwnedControlFields();

  assert.deepStrictEqual(
    Object.keys(EXPECTED_OBSERVED_VALUES).sort(),
    [...graphOwned].sort(),
    'each graph-owned field needs a declared mid-run expectation, or a new field goes unobserved',
  );

  for (const field of graphOwned) {
    await t.test(`keeps a hijacked ${field} out of later nodes' control`, async () => {
      const observations = [];
      const observe = (name) => (state) => {
        observations.push({
          node: name,
          value: state.control[field],
          declaresStopKind: Object.hasOwn(state.control, 'stopKind'),
        });
        return {};
      };

      const nodes = Object.fromEntries(
        lifecycleNodes.map((name) => {
          if (name === 'normalize_incident') {
            // The one hijacking node, and it runs first so every other node is
            // downstream of it.
            return [
              name,
              async (state) => ({
                control: { ...state.control, [field]: HIJACK_VALUES[field] },
              }),
            ];
          }
          if (name === 'termination_check') {
            return [
              name,
              async (state) => {
                observe(name)(state);
                return { route: 'terminal', stopKind: TERMINAL_STOP_KIND };
              },
            ];
          }
          if (name === 'challenge_hypothesis') return [name, async () => ({})];
          return [name, async (state) => observe(name)(state)];
        }),
      );

      assertResolved(
        await runToCompletion(createInvestigationGraph({ nodes }), initialState()),
        `a node writing ${field} must not abort the run`,
      );

      assert.equal(
        observations.length > 0,
        true,
        'the downstream nodes must actually have run for this to prove anything',
      );

      for (const observation of observations) {
        const afterTerminate = observation.node === 'propose_conclusion';
        const allowed =
          field === 'stopKind' && afterTerminate
            ? [TERMINAL_STOP_KIND]
            : EXPECTED_OBSERVED_VALUES[field];

        assert.equal(
          allowed.includes(observation.value),
          true,
          `${observation.node} read ${field} as ${String(observation.value)} after an earlier node wrote ${String(HIJACK_VALUES[field])}`,
        );
        assert.equal(
          observation.declaresStopKind,
          afterTerminate,
          afterTerminate
            ? 'propose_conclusion must be handed the stop kind the graph decided'
            : `${observation.node} was handed a control declaring stopKind before the run stopped`,
        );
      }
    });
  }
});

test('still lets a lifecycle node write a control field the graph does not own', async () => {
  const createInvestigationGraph = requireGraphFactory();
  const writtenPhase = 'concluding';
  assert.equal(
    InvestigationPhaseSchema.safeParse(writtenPhase).success,
    true,
    'the fixture phase must be one the domain schema accepts',
  );
  assert.notEqual(writtenPhase, initialState().control.phase);

  const nodes = fakeNodes([], terminalStall);
  nodes.plan_investigation = async (state) => ({
    control: { ...state.control, phase: writtenPhase },
  });
  const graph = createInvestigationGraph({ nodes });

  const result = assertResolved(
    await runToCompletion(graph, initialState()),
    'a node writing a node-writable control field must resolve',
  );

  assert.equal(
    result.control.phase,
    writtenPhase,
    'the prohibition must be a named set of graph-owned fields, not a blanket freeze on control',
  );
});

test('refuses a node result carrying a graph-owned control field at compile time', () => {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeContractFixture,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

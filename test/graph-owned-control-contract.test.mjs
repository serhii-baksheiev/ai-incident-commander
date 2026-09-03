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
 * visible in the final control rather than accidentally equal to the baseline.
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

const terminalStall = async () => ({ route: 'terminal', stopKind: 'stalled' });

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

  const baseline = assertResolved(
    await runToCompletion(
      createInvestigationGraph({ nodes: fakeNodes([], terminalStall) }),
      initialState(),
    ),
    'the baseline run must resolve before any hijack is judged against it',
  ).control;

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
        baseline,
        `a lifecycle node writing ${field} must leave the persisted control untouched`,
      );
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

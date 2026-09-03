import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';
import { createSqliteCheckpointer } from '@aic/persistence';
import {
  Command,
  END,
  INTERRUPT,
  isCommand,
  isInterrupted,
} from '@langchain/langgraph';

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

/**
 * The error text LangGraph itself produces today when a wrapped lifecycle node
 * hands back a `Command`, measured at 88ef538 against the built module for all
 * three fixtures below: the real class, the class carrying an update, and the
 * duck-typed shape. Each one throws it after exactly one node.
 *
 * That accident is why every refusal test here asserts the message TWICE —
 * once for what it must say, once for what it must not. The run already
 * rejects; a test that only asserted rejection would be green today and would
 * stay green if a dependency upgrade turned the accident into a bypass. This
 * pattern is the whole discrimination the file provides.
 */
const LANGGRAPH_INTERNAL_REFUSAL = /_updateAsTuples/;

/**
 * What the wrapper's own refusal has to say. Two claims, deliberately about
 * content rather than phrasing:
 *
 *   - it names the shape it refused, so a reader knows a `Command` return is
 *     the thing that is not allowed;
 *   - it names what the graph owns and what the `Command` would have taken
 *     over — the control it protects and the routing it decides.
 */
const NAMES_THE_REFUSED_SHAPE = /\bcommand\b/i;
const NAMES_WHAT_THE_GRAPH_OWNS = /\bcontrol\b|\brout(e|ing)\b/i;

/**
 * A control update a `Command` could carry, with every graph-owned field set to
 * a value that differs from what `initialState()` starts with — so a hijack
 * that got through is visible rather than accidentally equal to what the graph
 * would have written.
 *
 * Keyed by the exported protected set rather than by hand, and asserted against
 * it below, so a field added to `GRAPH_OWNED_CONTROL_FIELDS` cannot quietly go
 * untested on this path.
 */
const HIJACKED_CONTROL = {
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

const initialState = (overrides = {}) => ({
  incident: { id: 'incident-graph-node-return-shape' },
  hypotheses: [],
  predictions: [],
  tests: [],
  trials: [],
  evidence: [],
  assessments: [],
  control: {
    runId: 'run-graph-node-return-shape',
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
    ...overrides,
  },
});

const terminalStall = async () => ({
  route: 'terminal',
  stopKind: TERMINAL_STOP_KIND,
});

function requireGraphFactory() {
  assert.equal(
    typeof graphPackage.createInvestigationGraph,
    'function',
    '@aic/graph must publish createInvestigationGraph({ nodes })',
  );
  return graphPackage.createInvestigationGraph;
}

/**
 * Every lifecycle node traced, with `normalize_incident` — the first wrapped
 * node the graph enters — returning whatever the caller wants to test.
 */
function nodesReturning(trace, firstNodeResult) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async (state) => {
        trace.push(name);
        if (name === 'normalize_incident') return firstNodeResult(state);
        if (name === 'termination_check') return terminalStall(state);
        if (name === 'challenge_hypothesis') return {};
        return {};
      },
    ]),
  );
}

const runToCompletion = (graph, state) =>
  graph.execute({ kind: 'start', state }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

/**
 * Runs a graph whose first wrapped node returns `firstNodeResult` and asserts
 * that the wrapper — not LangGraph — refused it.
 */
async function assertWrapperRefusesFirstNodeResult(label, firstNodeResult) {
  const createInvestigationGraph = requireGraphFactory();
  const trace = [];
  const graph = createInvestigationGraph({
    nodes: nodesReturning(trace, firstNodeResult),
  });

  const outcome = await runToCompletion(graph, initialState());

  assert.equal(
    'error' in outcome,
    true,
    `a lifecycle node returning ${label} must not let the run resolve: got ${JSON.stringify(
      outcome.value?.control,
    )}`,
  );
  const message = String(outcome.error?.message ?? '');
  assert.doesNotMatch(
    message,
    LANGGRAPH_INTERNAL_REFUSAL,
    `${label} must be refused by the wrapper, not by a dependency's internals: a message naming _updateAsTuples means nothing here decided anything, and the next upgrade of that dependency can turn this fail-closed into a bypass with no test going red`,
  );
  assert.match(
    message,
    NAMES_THE_REFUSED_SHAPE,
    `the refusal of ${label} must name the shape it refused`,
  );
  assert.match(
    message,
    NAMES_WHAT_THE_GRAPH_OWNS,
    `the refusal of ${label} must name what the graph owns and the Command would have taken over`,
  );

  return { trace, error: outcome.error };
}

test('declares a hijack value for every field the graph owns', () => {
  const graphOwned = graphPackage.GRAPH_OWNED_CONTROL_FIELDS;
  assert.equal(
    Array.isArray(graphOwned),
    true,
    '@aic/graph must publish GRAPH_OWNED_CONTROL_FIELDS as one exported list',
  );
  assert.deepStrictEqual(
    Object.keys(HIJACKED_CONTROL).sort(),
    [...graphOwned].sort(),
    'a graph-owned field with no hijack value goes untested on the Command path',
  );
});

test('refuses a Command returned by a lifecycle node, naming what the graph owns', async () => {
  const { trace } = await assertWrapperRefusesFirstNodeResult(
    'a Command',
    () => new Command({ goto: END }),
  );

  assert.deepStrictEqual(
    trace,
    ['normalize_incident'],
    'the refusal must land on the node that returned the Command',
  );
});

test('refuses a Command carrying a control update before the update is read', async () => {
  const { trace } = await assertWrapperRefusesFirstNodeResult(
    'a Command carrying a control update',
    (state) =>
      new Command({
        goto: END,
        update: { control: { ...state.control, ...HIJACKED_CONTROL } },
      }),
  );

  // The spread of the graph-owned control over a `Command` is meaningless: the
  // update rides inside the Command instead of on the object the wrapper
  // rewrote, so nothing the wrapper did applies to it. Refusing before the
  // update is read is what makes that unreachable rather than merely unlikely.
  assert.deepStrictEqual(
    trace,
    ['normalize_incident'],
    'no node may run after a Command carrying a hijacked control was returned',
  );
});

test('refuses a duck-typed Command shape, the way isCommand does', async () => {
  const duckTyped = { lg_name: 'Command', goto: END };
  assert.equal(
    isCommand(duckTyped),
    true,
    "LangGraph's own isCommand must accept this fixture, or the test is asserting against a shape the graph never treats as a Command",
  );

  const { trace } = await assertWrapperRefusesFirstNodeResult(
    'a duck-typed Command',
    () => duckTyped,
  );

  assert.deepStrictEqual(
    trace,
    ['normalize_incident'],
    'a duck-typed Command must be refused on the node that returned it',
  );
});

/**
 * The regression guard, and the one test here that must pass both before and
 * after the refusal exists.
 *
 * The graph's OWN nodes return `Command` legitimately — `review_conclusion` on
 * all three resume routes, and `termination_check` / `challenge_hypothesis` for
 * routing. Checked in `packages/graph/src/investigation.ts` rather than
 * assumed: `addNode('termination_check', terminationCheck, …)`,
 * `addNode('challenge_hypothesis', challengeHypothesis)` and
 * `addNode('review_conclusion', reviewConclusion, …)` all register the graph's
 * own closures directly, while every one of the ten lifecycle nodes is
 * registered through `preserveGraphOwnedControl(...)`. So the new refusal lives
 * on a wrapper none of the three pass through — but "the wrapper cannot reach
 * them" is a claim about the registration, and a registration can change.
 *
 * A `confirm` resume is the cheapest end-to-end proof: it returns
 * `new Command({ goto: END, update: { control: resumedControl } })` and reaches
 * END without entering a single wrapped node. Asserting the resume COUNT, not
 * just that the run resolved, is what makes this a proof that the Command's
 * update landed rather than that nothing threw.
 */
test("still lets the graph's own nodes return a Command", async (t) => {
  const createInvestigationGraph = requireGraphFactory();
  const runId = 'run-graph-node-return-shape-review';
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-node-return-shape-'));
  const checkpointer = createSqliteCheckpointer(
    join(temporaryRoot, 'checkpoints.sqlite'),
  );
  t.after(() => {
    checkpointer.db.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const conclusion = { kind: 'inconclusive', causes: [] };
  const trace = [];
  const nodes = nodesReturning(trace, async () => ({}));
  nodes.propose_conclusion = async () => {
    trace.push('propose_conclusion');
    return { conclusion };
  };

  const execution = createInvestigationGraph({ nodes, checkpointer });
  const config = { threadId: runId };

  const interrupted = await execution.execute(
    {
      kind: 'start',
      state: initialState({ runId, phase: 'concluding', humanReview: true }),
    },
    config,
  );
  assert.equal(
    isInterrupted(interrupted),
    true,
    'an interactive conclusion must pause for review before this test can judge the resume',
  );
  assert.equal(interrupted[INTERRUPT].length, 1);

  const [pending] = interrupted[INTERRUPT];
  const outcome = await execution
    .execute({ kind: 'resume', interruptId: pending.id, decision: { action: 'confirm' } }, config)
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

  assert.equal(
    'error' in outcome,
    false,
    `review_conclusion returns a Command on the confirm route and the graph must still accept it: ${
      outcome.error?.message ?? ''
    }`,
  );
  assert.deepStrictEqual(
    outcome.value.conclusion,
    conclusion,
    'a confirmed run must complete with the conclusion it proposed',
  );
  assert.equal(
    outcome.value.control.resumeCount,
    1,
    "the update carried by review_conclusion's Command must still be applied, not merely not-rejected",
  );
});

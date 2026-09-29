/**
 * AIC-125 slice a: the graph half of the deterministic planner —
 * `INVESTIGATION_ROUTES`, the frozen observation-form -> tool request table,
 * and `createPlanInvestigation`, the canonical `plan_investigation` node that
 * calls the pure `planInvestigation` (`@aic/domain`) with it. Style follows
 * `prediction-templates.ts` / `nodes/derive-predictions.ts` and their test
 * neighbour `prediction-nodes.test.mjs`.
 *
 * `@aic/graph` cannot import `@aic/tools` or `@aic/evals` in production (both
 * would create a dependency the package does not carry); this test file can,
 * and is the independent check that every tool id this table names is a
 * registered read-only tool, and that the table names no value from the
 * replay corpus.
 *
 * Lane wiring — which graph edge calls this node — is not this slice's
 * concern; every row here calls the node factory directly against a
 * hand-built `IncidentState`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import { OBSERVATION_ANNOTATIONS, REPLAY_SCENARIOS } from '@aic/evals';
import { READ_ONLY_TOOL_REGISTRY } from '@aic/tools';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

function requireExport(name) {
  assert.equal(typeof graph[name], 'function', `@aic/graph must export ${name}`);
  return graph[name];
}

function requireInvestigationRoutes() {
  assert.ok(graph.INVESTIGATION_ROUTES !== undefined, '@aic/graph must export INVESTIGATION_ROUTES');
  return graph.INVESTIGATION_ROUTES;
}

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

function baseControl(overrides = {}) {
  return {
    runId: 'run-investigation-routes',
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
    incident: scopedIncident('incident-investigation-routes'),
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
    cause: { component: 'orders-db', mechanism: 'connection-pool-exhaustion' },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. INVESTIGATION_ROUTES content                                           */
/* -------------------------------------------------------------------------- */

/**
 * AIC-142: `signal-state` is no longer one flat `InvestigationRouteEntry` —
 * it is a signal-keyed selector (`bySignal`), because the form alone does not
 * determine the source family (dependency-health belongs to `dependencies`,
 * not `metrics`; latency is ambiguous and refused). The METRICS_SIGNAL_INPUT
 * mapping is the one every metrics-routed signal AND the dependencies route
 * share (owner design, "Representation": "dependencies entry uses the SAME
 * input mapping as metrics"). The latency refusal's own reason text is free
 * prose the design leaves to the implementer, so it is checked for shape
 * (a non-empty string, the entry's only key) rather than pinned verbatim —
 * see "pins the exact route table content" below, which substitutes a
 * placeholder for it before comparing the rest of the table.
 */
const SIGNAL_INPUT = Object.freeze({ service: 'subject', window: 'window', metric: 'signal' });

const EXPECTED_INVESTIGATION_ROUTES_WITH_LATENCY_PLACEHOLDER = {
  version: 'investigation-routes-v2',
  byForm: {
    'deployment-in-window': {
      tool: 'deployments',
      input: { service: 'subject', window: 'window' },
    },
    'signal-state': {
      bySignal: {
        'error-rate': { tool: 'metrics', input: SIGNAL_INPUT },
        'connection-pool': { tool: 'metrics', input: SIGNAL_INPUT },
        'worker-saturation': { tool: 'metrics', input: SIGNAL_INPUT },
        'dependency-health': { tool: 'dependencies', input: SIGNAL_INPUT },
        latency: { refused: 'LATENCY_REFUSAL_PLACEHOLDER' },
      },
    },
    'log-class-in-window': {
      tool: 'logs',
      input: { service: 'subject', window: 'window', query: 'logClass' },
    },
  },
};

test('INVESTIGATION_ROUTES.version is investigation-routes-v2', () => {
  const routes = requireInvestigationRoutes();
  assert.equal(routes.version, 'investigation-routes-v2');
});

test('pins the exact route table content: version and byForm for every form and every signal, except the free-text latency refusal reason', () => {
  const routes = requireInvestigationRoutes();
  const latencyEntry = routes.byForm['signal-state']?.bySignal?.latency;
  assert.ok(latencyEntry, 'fixture sanity: signal-state.bySignal.latency must exist');
  assert.deepEqual(Object.keys(latencyEntry), ['refused'], 'the latency entry must carry exactly one key: refused');
  assert.equal(typeof latencyEntry.refused, 'string');
  assert.ok(latencyEntry.refused.length > 0, 'the refusal reason must not be empty');

  const withPlaceholder = {
    ...routes,
    byForm: {
      ...routes.byForm,
      'signal-state': {
        bySignal: {
          ...routes.byForm['signal-state'].bySignal,
          latency: { refused: 'LATENCY_REFUSAL_PLACEHOLDER' },
        },
      },
    },
  };
  assert.deepEqual(withPlaceholder, EXPECTED_INVESTIGATION_ROUTES_WITH_LATENCY_PLACEHOLDER);
});

test('INVESTIGATION_ROUTES is deeply frozen', () => {
  const routes = requireInvestigationRoutes();
  assert.ok(Object.isFrozen(routes), 'the top-level table must be frozen');
  assert.ok(Object.isFrozen(routes.byForm), 'byForm must be frozen');
  for (const [form, entry] of Object.entries(routes.byForm)) {
    assert.ok(Object.isFrozen(entry), `byForm.${form} must be frozen`);
    if (Object.hasOwn(entry, 'bySignal')) {
      assert.ok(Object.isFrozen(entry.bySignal), `byForm.${form}.bySignal must be frozen`);
      for (const [signal, signalEntry] of Object.entries(entry.bySignal)) {
        assert.ok(Object.isFrozen(signalEntry), `byForm.${form}.bySignal.${signal} must be frozen`);
        if (Object.hasOwn(signalEntry, 'input')) {
          assert.ok(Object.isFrozen(signalEntry.input), `byForm.${form}.bySignal.${signal}.input must be frozen`);
        }
      }
    } else {
      assert.ok(Object.isFrozen(entry.input), `byForm.${form}.input must be frozen`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 2. tool ids are registered, read-only tools                               */
/* -------------------------------------------------------------------------- */

/**
 * AIC-142: `byForm[form]` may now be a nested `bySignal` selector (currently
 * only `signal-state`), so this walk descends one level for such an entry
 * rather than reading `route.tool` off the form-level value directly. A
 * refusal entry (`{ refused }`) names no tool and is skipped, per the design
 * ("Refusal entries name no tool").
 */
test('every tool id in INVESTIGATION_ROUTES is a registered read-only tool (READ_ONLY_TOOL_REGISTRY, @aic/tools)', () => {
  const routes = requireInvestigationRoutes();
  const readOnlyIds = new Set(READ_ONLY_TOOL_REGISTRY.map((descriptor) => descriptor.id));
  assert.ok(readOnlyIds.size > 0, 'fixture sanity: READ_ONLY_TOOL_REGISTRY must carry ids to check against');

  const namedTools = [];
  for (const [form, entry] of Object.entries(routes.byForm)) {
    if (Object.hasOwn(entry, 'bySignal')) {
      for (const [signal, signalEntry] of Object.entries(entry.bySignal)) {
        if (Object.hasOwn(signalEntry, 'refused')) continue;
        namedTools.push([`${form}.bySignal.${signal}`, signalEntry.tool]);
      }
    } else {
      namedTools.push([form, entry.tool]);
    }
  }
  assert.ok(namedTools.length > 0, 'fixture sanity: the route walk must find at least one tool to check');

  for (const [label, tool] of namedTools) {
    assert.ok(
      readOnlyIds.has(tool),
      `route for ${label} names tool ${JSON.stringify(tool)}, which is not in READ_ONLY_TOOL_REGISTRY`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 3. every ExpectedObservation form is routed                               */
/* -------------------------------------------------------------------------- */

test('every form of the ExpectedObservation union is routed', () => {
  const routes = requireInvestigationRoutes();
  const observationForms = domain.ExpectedObservationSchema.options
    .map((option) => option.shape.form.value)
    .sort();
  assert.ok(observationForms.length > 0, 'fixture sanity: the domain union must carry at least one form');

  const routedForms = Object.keys(routes.byForm).sort();
  assert.deepEqual(
    routedForms,
    observationForms,
    'INVESTIGATION_ROUTES.byForm must name exactly the forms ExpectedObservationSchema declares, in both directions',
  );
});

/* -------------------------------------------------------------------------- */
/* 4. every PREDICTION_TEMPLATES observation is routable                     */
/* -------------------------------------------------------------------------- */

test('every observation of every PREDICTION_TEMPLATES template is routable through INVESTIGATION_ROUTES', () => {
  const routes = requireInvestigationRoutes();
  const templates = graph.PREDICTION_TEMPLATES;
  assert.ok(templates !== undefined, 'fixture sanity: @aic/graph must export PREDICTION_TEMPLATES');

  let checked = 0;
  for (const mechanismTemplates of Object.values(templates.byMechanism)) {
    for (const tmpl of mechanismTemplates) {
      for (const observation of [...tmpl.expectedIfTrue, ...tmpl.expectedIfFalse]) {
        const withSubject = { ...observation, subject: 'placeholder-subject' };
        const syntheticPrediction = {
          id: `synthetic-${tmpl.key}-${checked}`,
          hypothesisId: 'synthetic-hypothesis',
          statement: 'synthetic prediction for routability check',
          observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
          expectedIfTrue: [withSubject],
          expectedIfFalse: [],
          status: 'untested',
        };

        const result = domain.planInvestigation({
          predictions: [syntheticPrediction],
          tests: [],
          routes,
        });

        assert.equal(
          result.length,
          1,
          `template ${tmpl.key} observation ${JSON.stringify(observation)} must be routable through INVESTIGATION_ROUTES`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'fixture sanity: PREDICTION_TEMPLATES must carry observations to check');
});

/* -------------------------------------------------------------------------- */
/* 4b. AIC-142: the per-signal routing policy for signal-state               */
/*                                                                            */
/* Owner ruling AIC-142: `signal-state` is semantically broader than one     */
/* source family. Every SignalKind gets a deterministic route or an explicit */
/* refusal, verified in both directions against SignalKindSchema (row 2),    */
/* and the three production policy rows (3-5) are hand-built predictions —   */
/* PREDICTION_TEMPLATES derives none of these signals directly (see section  */
/* 4 above, which covers only the signals templates DO derive) — so these    */
/* rows are the only place the dependency-health and latency policy is       */
/* pinned against the real, exported INVESTIGATION_ROUTES table.            */
/* -------------------------------------------------------------------------- */

test('every SignalKind appears in INVESTIGATION_ROUTES.byForm[\'signal-state\'].bySignal exactly once, as a route or a refusal, and bySignal names no key outside SignalKindSchema — both directions', () => {
  const routes = requireInvestigationRoutes();
  const signalKinds = [...domain.SignalKindSchema.options].sort();
  assert.ok(signalKinds.length > 0, 'fixture sanity: SignalKindSchema must carry at least one option');

  const signalEntry = routes.byForm['signal-state'];
  assert.ok(signalEntry, 'fixture sanity: byForm must carry a signal-state entry');
  assert.ok(Object.hasOwn(signalEntry, 'bySignal'), 'signal-state must be the nested bySignal selector, not a flat route');

  const routedSignals = Object.keys(signalEntry.bySignal).sort();
  assert.deepEqual(
    routedSignals,
    signalKinds,
    'bySignal must name exactly the signals SignalKindSchema declares, in both directions',
  );

  for (const signal of signalKinds) {
    const entry = signalEntry.bySignal[signal];
    const isRoute = Object.hasOwn(entry, 'tool');
    const isRefusal = Object.hasOwn(entry, 'refused');
    assert.ok(
      isRoute !== isRefusal,
      `bySignal.${signal} must be exactly one of a route (tool) or a refusal (refused), never both or neither`,
    );
  }
});

function syntheticSignalStatePrediction(id, signal, subject) {
  return {
    id,
    hypothesisId: 'synthetic-hypothesis',
    statement: `synthetic prediction for ${signal} routing`,
    observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
    expectedIfTrue: [
      { form: 'signal-state', subject, window: 'incident', signal, state: 'elevated' },
    ],
    expectedIfFalse: [],
    status: 'untested',
  };
}

test('a hand-built dependency-health signal-state observation plans a test on tool dependencies with input {service, window, metric: \'dependency-health\'}, through planInvestigation, consulting no corpus identity', () => {
  const routes = requireInvestigationRoutes();
  const prediction = syntheticSignalStatePrediction('synthetic-dependency-health', 'dependency-health', 'svc-a');

  const result = domain.planInvestigation({ predictions: [prediction], tests: [], routes });

  assert.equal(result.length, 1, 'a dependency-health observation must plan exactly one test');
  assert.equal(result[0].tool, 'dependencies');
  assert.deepEqual(result[0].input, { service: 'svc-a', window: 'incident', metric: 'dependency-health' });
});

for (const signal of ['error-rate', 'connection-pool', 'worker-saturation']) {
  test(`a hand-built ${signal} signal-state observation plans a test on tool metrics with input {service, window, metric: '${signal}'}, through planInvestigation`, () => {
    const routes = requireInvestigationRoutes();
    const prediction = syntheticSignalStatePrediction(`synthetic-${signal}`, signal, 'svc-a');

    const result = domain.planInvestigation({ predictions: [prediction], tests: [], routes });

    assert.equal(result.length, 1, `a ${signal} observation must plan exactly one test`);
    assert.equal(result[0].tool, 'metrics');
    assert.deepEqual(result[0].input, { service: 'svc-a', window: 'incident', metric: signal });
  });
}

test('latency is an explicit refusal: bySignal.latency carries a refusal reason and no tool, and planInvestigation plans no test for a latency observation, never falling back to metrics or any other tool', () => {
  const routes = requireInvestigationRoutes();
  const latencyEntry = routes.byForm['signal-state'].bySignal.latency;
  assert.ok(Object.hasOwn(latencyEntry, 'refused'), 'latency must be a refusal entry');
  assert.equal(typeof latencyEntry.refused, 'string');
  assert.ok(latencyEntry.refused.length > 0, 'the refusal reason must not be empty');
  assert.ok(!Object.hasOwn(latencyEntry, 'tool'), 'a refusal entry must name no tool');

  const prediction = syntheticSignalStatePrediction('synthetic-latency', 'latency', 'svc-a');

  const result = domain.planInvestigation({ predictions: [prediction], tests: [], routes });

  assert.deepEqual(
    result,
    [],
    'a refused signal must plan no test at all — fail closed, never a fallback to metrics or any other tool',
  );
});

/* -------------------------------------------------------------------------- */
/* 4c. AIC-142 row 10: the planner (via createInvestigationNodes's own        */
/* default) and the replay executor the lanes/CLI build must read the one    */
/* INVESTIGATION_ROUTES object @aic/graph exports, never a second copy       */
/* -------------------------------------------------------------------------- */

function sourceOf(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

/**
 * Extracts the exact `calleeName(...)` text, balancing every `(`/`{` against
 * every `)`/`}` (not distinguishing the two bracket kinds — source in this
 * repository is always overall-balanced, so depth alone is enough), so a
 * caller can reliably find where one call's own argument list ends even when
 * it nests another call with its own object literal — a flat `[^}]*` regex
 * stops at the FIRST `}`, which is the nested call's own closing brace, not
 * the outer call's. Returns `undefined` when `calleeName(` does not occur.
 * Stated limit: a `{` or `}` inside a string literal or comment between the
 * call and its end would miscount; this repository's source style never puts
 * one there.
 */
function fullCallText(source, calleeName) {
  const marker = `${calleeName}(`;
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  let depth = 0;
  let end = start + calleeName.length;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '(' || ch === '{') depth += 1;
    else if (ch === ')' || ch === '}') depth -= 1;
    if (depth === 0) break;
  }
  return source.slice(start, end + 1);
}

test("scripts/lane-arms.mjs and apps/cli/src/commands/investigate.ts each import INVESTIGATION_ROUTES from @aic/graph and pass that same identifier as routes to createPlannedReplayExecutor, and neither overrides plan_investigation's routes on createInvestigationNodes — so the live and replay paths read one shared table, not two copies", () => {
  for (const relativePath of ['../scripts/lane-arms.mjs', '../apps/cli/src/commands/investigate.ts']) {
    const source = sourceOf(relativePath);

    assert.ok(
      new RegExp(String.raw`import\s*\{[^}]*\bINVESTIGATION_ROUTES\b[^}]*\}\s*from\s*['"]@aic/graph['"]`).test(source),
      `${relativePath} must import INVESTIGATION_ROUTES from @aic/graph`,
    );

    const replayCall = fullCallText(source, 'createPlannedReplayExecutor');
    assert.ok(replayCall, `${relativePath} must call createPlannedReplayExecutor(...)`);
    assert.ok(
      /\broutes\s*:\s*INVESTIGATION_ROUTES\b/.test(replayCall),
      `${relativePath} must pass routes: INVESTIGATION_ROUTES (the imported identifier, not a copy) into createPlannedReplayExecutor`,
    );

    const nodesCall = fullCallText(source, 'createInvestigationNodes');
    assert.ok(nodesCall, `${relativePath} must call createInvestigationNodes(...)`);
    // Remove the nested createPlannedReplayExecutor(...) call's own text (it
    // is the `execute` value passed into createInvestigationNodes) before
    // checking for a stray `routes:` key — otherwise the check above's own
    // match would make this one a false positive.
    const nodesCallWithoutNestedReplayCall = nodesCall.split(replayCall).join('');
    assert.ok(
      !/\broutes\s*:/.test(nodesCallWithoutNestedReplayCall),
      `${relativePath} must not override plan_investigation's routes on createInvestigationNodes, so it stays on the same default INVESTIGATION_ROUTES from @aic/graph`,
    );

    const occurrences = source.match(/\bINVESTIGATION_ROUTES\b/g) ?? [];
    assert.ok(
      occurrences.length >= 2,
      `fixture sanity: ${relativePath} must both import and use INVESTIGATION_ROUTES`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 5. no replay-corpus value leaks into the table                            */
/* -------------------------------------------------------------------------- */

test('INVESTIGATION_ROUTES names no replay-corpus value: no scenario id, evidence id, annotation subject, or recorded input value', () => {
  const routes = requireInvestigationRoutes();
  const serialized = JSON.stringify(routes);

  const scenarioIds = REPLAY_SCENARIOS.map((scenario) => scenario.id);
  const evidenceIds = REPLAY_SCENARIOS.flatMap((scenario) =>
    scenario.fixture.entries.flatMap((entry) =>
      entry.result.status === 'ok' ? entry.result.output.map((item) => item.id) : [],
    ),
  );
  const annotationSubjects = [
    ...new Set(OBSERVATION_ANNOTATIONS.flatMap((row) => row.facts.map((fact) => fact.subject))),
  ];
  const recordedInputValues = [
    ...new Set(
      REPLAY_SCENARIOS.flatMap((scenario) =>
        scenario.fixture.entries.flatMap((entry) =>
          entry.input && typeof entry.input === 'object'
            ? Object.values(entry.input).filter((value) => typeof value === 'string')
            : [],
        ),
      ),
    ),
  ];

  assert.ok(scenarioIds.length > 0, 'fixture sanity: REPLAY_SCENARIOS must carry ids to check against');
  assert.ok(evidenceIds.length > 0, 'fixture sanity: REPLAY_SCENARIOS must carry evidence ids to check against');
  assert.ok(annotationSubjects.length > 0, 'fixture sanity: OBSERVATION_ANNOTATIONS must carry subjects to check against');
  assert.ok(recordedInputValues.length > 0, 'fixture sanity: REPLAY_SCENARIOS must carry recorded input string values to check against');

  for (const id of scenarioIds) {
    assert.ok(!serialized.includes(id), `INVESTIGATION_ROUTES must not name the corpus scenario id ${id}`);
  }
  for (const id of evidenceIds) {
    assert.ok(!serialized.includes(id), `INVESTIGATION_ROUTES must not name the corpus evidence id ${id}`);
  }
  for (const subject of annotationSubjects) {
    assert.ok(!serialized.includes(subject), `INVESTIGATION_ROUTES must not name the corpus subject ${subject}`);
  }
  for (const value of recordedInputValues) {
    assert.ok(!serialized.includes(value), `INVESTIGATION_ROUTES must not name the recorded input value ${value}`);
  }
});

/* -------------------------------------------------------------------------- */
/* 6. createPlanInvestigation                                                */
/* -------------------------------------------------------------------------- */

test('createPlanInvestigation() returns an InvestigationNode whose tests deepEqual planInvestigation over the same state, using INVESTIGATION_ROUTES by default', () => {
  const createPlanInvestigation = requireExport('createPlanInvestigation');
  const createDerivePredictions = requireExport('createDerivePredictions');
  const routes = requireInvestigationRoutes();
  const derive = createDerivePredictions();
  const node = createPlanInvestigation();

  const baseState = state({ hypotheses: [hypothesis('h-1')] });
  const { predictions } = derive(baseState);
  const testState = { ...baseState, predictions };

  const result = node(testState);

  const expected = domain.planInvestigation({
    predictions: testState.predictions,
    tests: testState.tests,
    routes,
  });
  assert.ok(expected.length > 0, 'fixture sanity: the derived prediction must actually plan at least one test');
  assert.deepEqual(result, { tests: expected });
});

test('createPlanInvestigation() returns tests: [] when every prediction is decided', () => {
  const createPlanInvestigation = requireExport('createPlanInvestigation');
  const node = createPlanInvestigation();
  const testState = state({
    hypotheses: [hypothesis('h-1')],
    predictions: [
      {
        id: 'prediction-decided',
        hypothesisId: 'h-1',
        statement: 'a decided prediction',
        observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
        expectedIfTrue: [
          { form: 'signal-state', subject: 'orders-db', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
        ],
        expectedIfFalse: [],
        status: 'confirmed',
      },
    ],
  });

  assert.deepEqual(node(testState), { tests: [] });
});

test('accepts a caller-supplied routes option, overriding the default table', () => {
  const createPlanInvestigation = requireExport('createPlanInvestigation');
  const customRoutes = {
    version: 'custom-routes-v1',
    byForm: {
      'signal-state': {
        tool: 'metrics',
        input: { service: 'subject' },
      },
    },
  };
  const node = createPlanInvestigation({ routes: customRoutes });
  const testState = state({
    hypotheses: [hypothesis('h-1')],
    predictions: [
      {
        id: 'prediction-untested',
        hypothesisId: 'h-1',
        statement: 'an untested prediction',
        observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
        expectedIfTrue: [
          { form: 'signal-state', subject: 'orders-db', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
        ],
        expectedIfFalse: [],
        status: 'untested',
      },
    ],
  });

  const result = node(testState);

  assert.equal(result.tests.length, 1);
  assert.deepEqual(result.tests[0].input, { service: 'orders-db' });
});

test('end-to-end: deriving then planning a connection-pool-exhaustion hypothesis with component orders-db yields one metrics test with the expected input', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createPlanInvestigation = requireExport('createPlanInvestigation');
  const derive = createDerivePredictions();
  const plan = createPlanInvestigation();

  const baseState = state({
    hypotheses: [hypothesis('h-1', { cause: { component: 'orders-db', mechanism: 'connection-pool-exhaustion' } })],
  });
  const { predictions } = derive(baseState);
  const testState = { ...baseState, predictions };

  const result = plan(testState);

  assert.equal(result.tests.length, 1);
  const [t] = result.tests;
  assert.equal(t.tool, 'metrics');
  assert.deepEqual(t.input, { service: 'orders-db', window: 'incident', metric: 'connection-pool' });
  assert.equal(t.status, 'planned');
  assert.equal(t.cost, 'cheap');
});

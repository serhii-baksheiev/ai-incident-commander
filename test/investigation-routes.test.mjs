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
import test from 'node:test';

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

const EXPECTED_INVESTIGATION_ROUTES = {
  version: 'investigation-routes-v1',
  byForm: {
    'deployment-in-window': {
      tool: 'deployments',
      input: { service: 'subject', window: 'window' },
    },
    'signal-state': {
      tool: 'metrics',
      input: { service: 'subject', window: 'window', metric: 'signal' },
    },
    'log-class-in-window': {
      tool: 'logs',
      input: { service: 'subject', window: 'window', query: 'logClass' },
    },
  },
};

test('INVESTIGATION_ROUTES.version is investigation-routes-v1', () => {
  const routes = requireInvestigationRoutes();
  assert.equal(routes.version, 'investigation-routes-v1');
});

test('pins the exact route table content: version and byForm for every form', () => {
  const routes = requireInvestigationRoutes();
  assert.deepEqual(routes, EXPECTED_INVESTIGATION_ROUTES);
});

test('INVESTIGATION_ROUTES is deeply frozen', () => {
  const routes = requireInvestigationRoutes();
  assert.ok(Object.isFrozen(routes), 'the top-level table must be frozen');
  assert.ok(Object.isFrozen(routes.byForm), 'byForm must be frozen');
  for (const route of Object.values(routes.byForm)) {
    assert.ok(Object.isFrozen(route), 'each form\'s route entry must be frozen');
    assert.ok(Object.isFrozen(route.input), 'each route\'s input mapping must be frozen');
  }
});

/* -------------------------------------------------------------------------- */
/* 2. tool ids are registered, read-only tools                               */
/* -------------------------------------------------------------------------- */

test('every tool id in INVESTIGATION_ROUTES is a registered read-only tool (READ_ONLY_TOOL_REGISTRY, @aic/tools)', () => {
  const routes = requireInvestigationRoutes();
  const readOnlyIds = new Set(READ_ONLY_TOOL_REGISTRY.map((descriptor) => descriptor.id));
  assert.ok(readOnlyIds.size > 0, 'fixture sanity: READ_ONLY_TOOL_REGISTRY must carry ids to check against');

  for (const [form, route] of Object.entries(routes.byForm)) {
    assert.ok(
      readOnlyIds.has(route.tool),
      `route for form ${form} names tool ${JSON.stringify(route.tool)}, which is not in READ_ONLY_TOOL_REGISTRY`,
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

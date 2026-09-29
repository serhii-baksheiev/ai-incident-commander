/**
 * AIC-143: `routeRequestVocabulary` (`@aic/domain`,
 * `packages/domain/src/investigation-planning.ts`) turns an
 * `InvestigationRouteTable` into the closed request vocabulary a challenge
 * role may be told — one shape per tool, each naming its input keys and,
 * where the value is closed, the values that key may take. It is derived
 * purely from the table and the domain's own observation enums
 * (`ObservationWindowSchema`, `SignalKindSchema`, `LogClassSchema`), never
 * from the replay corpus.
 *
 * Style follows `test/investigation-planning.test.mjs` and
 * `test/investigation-routes.test.mjs`: every expectation here is a
 * hand-written literal, or (row 3) checked against `planInvestigation`
 * itself as an independent second mechanism — never read back off
 * `routeRequestVocabulary`'s own output.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import { OBSERVATION_ANNOTATIONS, REPLAY_SCENARIOS } from '@aic/evals';

function requireDomainExport(name) {
  assert.equal(typeof domain[name], 'function', `@aic/domain must export ${name}`);
  return domain[name];
}

/* -------------------------------------------------------------------------- */
/* 1. a small hand-written table: ordering, merging, values                   */
/* -------------------------------------------------------------------------- */

/**
 * `form-flat` is a flat route over subject/window/logClass, in the shape
 * `log-class-in-window` uses. `form-select` is a `bySignal` selector: two
 * signals (`error-rate`, `connection-pool`) route to `toolA`, one
 * (`latency`) routes to `toolB`, and one (`worker-saturation`) is refused —
 * `dependency-health` names no entry at all, exactly like a signal absent
 * from a real `bySignal` map.
 */
const SMALL_ROUTES = Object.freeze({
  version: 'small-routes-v1',
  byForm: Object.freeze({
    'form-flat': Object.freeze({
      tool: 'toolC',
      input: Object.freeze({ service: 'subject', window: 'window', query: 'logClass' }),
    }),
    'form-select': Object.freeze({
      bySignal: Object.freeze({
        'error-rate': Object.freeze({
          tool: 'toolA',
          input: Object.freeze({ service: 'subject', window: 'window', metric: 'signal' }),
        }),
        latency: Object.freeze({
          tool: 'toolB',
          input: Object.freeze({ service: 'subject', window: 'window', metric: 'signal' }),
        }),
        'connection-pool': Object.freeze({
          tool: 'toolA',
          input: Object.freeze({ service: 'subject', window: 'window', metric: 'signal' }),
        }),
        'worker-saturation': Object.freeze({ refused: 'no route for worker-saturation in this small table' }),
      }),
    }),
  }),
});

const EXPECTED_SMALL_VOCABULARY = [
  {
    tool: 'toolC',
    input: [
      { key: 'service' },
      { key: 'window', values: ['pre-onset', 'incident', 'recovery'] },
      { key: 'query', values: ['error', 'timeout', 'activity'] },
    ],
  },
  {
    tool: 'toolA',
    input: [
      { key: 'service' },
      { key: 'window', values: ['pre-onset', 'incident', 'recovery'] },
      { key: 'metric', values: ['error-rate', 'connection-pool'] },
    ],
  },
  {
    tool: 'toolB',
    input: [
      { key: 'service' },
      { key: 'window', values: ['pre-onset', 'incident', 'recovery'] },
      { key: 'metric', values: ['latency'] },
    ],
  },
];

test('routeRequestVocabulary orders tools by first appearance (byForm key order, then bySignal in SignalKindSchema order), merges the signals routed to one tool under one metric values list, and skips a refused signal entirely', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  assert.deepEqual(routeRequestVocabulary(SMALL_ROUTES), EXPECTED_SMALL_VOCABULARY);
});

/* -------------------------------------------------------------------------- */
/* 2. routeRequestVocabulary(INVESTIGATION_ROUTES): the exact literal         */
/* -------------------------------------------------------------------------- */

const EXPECTED_INVESTIGATION_VOCABULARY = [
  {
    tool: 'deployments',
    input: [{ key: 'service' }, { key: 'window', values: ['pre-onset', 'incident', 'recovery'] }],
  },
  {
    tool: 'metrics',
    input: [
      { key: 'service' },
      { key: 'window', values: ['pre-onset', 'incident', 'recovery'] },
      { key: 'metric', values: ['error-rate', 'connection-pool', 'worker-saturation'] },
    ],
  },
  {
    tool: 'dependencies',
    input: [
      { key: 'service' },
      { key: 'window', values: ['pre-onset', 'incident', 'recovery'] },
      { key: 'metric', values: ['dependency-health'] },
    ],
  },
  {
    tool: 'logs',
    input: [
      { key: 'service' },
      { key: 'window', values: ['pre-onset', 'incident', 'recovery'] },
      { key: 'query', values: ['error', 'timeout', 'activity'] },
    ],
  },
];

test('routeRequestVocabulary(INVESTIGATION_ROUTES) names exactly deployments, metrics, dependencies and logs, in that order, each with its exact input keys and values, and service carries no values', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  assert.deepEqual(routeRequestVocabulary(graph.INVESTIGATION_ROUTES), EXPECTED_INVESTIGATION_VOCABULARY);
});

/* -------------------------------------------------------------------------- */
/* 3. both-direction correspondence with what the table can actually form,   */
/*    using planInvestigation as the independent second mechanism            */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER_SUBJECT = 'placeholder-service';
const SERVICE_PLACEHOLDER_TRIPLE_VALUE = '<service>';

/** Every `ExpectedObservation` variant over the domain's own enums, one placeholder subject. */
function enumerateExpectedObservations() {
  const observations = [];
  for (const window of domain.ObservationWindowSchema.options) {
    observations.push({ form: 'deployment-in-window', subject: PLACEHOLDER_SUBJECT, window, presence: 'present' });
  }
  for (const window of domain.ObservationWindowSchema.options) {
    for (const logClass of domain.LogClassSchema.options) {
      observations.push({
        form: 'log-class-in-window',
        subject: PLACEHOLDER_SUBJECT,
        window,
        logClass,
        presence: 'present',
      });
    }
  }
  for (const window of domain.ObservationWindowSchema.options) {
    for (const signal of domain.SignalKindSchema.options) {
      observations.push({ form: 'signal-state', subject: PLACEHOLDER_SUBJECT, window, signal, state: 'normal' });
    }
  }
  return observations;
}

function tripleKey(tool, key, value) {
  return JSON.stringify([tool, key, value]);
}

function triplesFromVocabulary(vocabulary) {
  const triples = new Set();
  for (const shape of vocabulary) {
    for (const inputKey of shape.input) {
      if (inputKey.values === undefined) {
        triples.add(tripleKey(shape.tool, inputKey.key, SERVICE_PLACEHOLDER_TRIPLE_VALUE));
      } else {
        for (const value of inputKey.values) triples.add(tripleKey(shape.tool, inputKey.key, value));
      }
    }
  }
  return triples;
}

function triplesFromPlannedTests(tests) {
  const triples = new Set();
  for (const plannedTest of tests) {
    for (const [key, value] of Object.entries(plannedTest.input)) {
      const reported = value === PLACEHOLDER_SUBJECT ? SERVICE_PLACEHOLDER_TRIPLE_VALUE : value;
      triples.add(tripleKey(plannedTest.tool, key, reported));
    }
  }
  return triples;
}

test('routeRequestVocabulary(INVESTIGATION_ROUTES) names exactly the (tool, key, value) triples planInvestigation can form over every ExpectedObservation variant, in both directions, and latency appears in no entry’s values', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  const planInvestigation = requireDomainExport('planInvestigation');

  const observations = enumerateExpectedObservations();
  const predictions = observations.map((observation, index) => ({
    id: `p-${index}`,
    hypothesisId: `h-${index}`,
    statement: `prediction ${index}`,
    observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
    expectedIfTrue: [observation],
    expectedIfFalse: [],
    status: 'untested',
  }));

  const plannedTests = planInvestigation({ predictions, tests: [], routes: graph.INVESTIGATION_ROUTES });
  assert.ok(
    plannedTests.length > 0,
    'fixture sanity: planInvestigation must plan at least one test from the enumerated observations',
  );

  const vocabulary = routeRequestVocabulary(graph.INVESTIGATION_ROUTES);
  const fromVocabulary = triplesFromVocabulary(vocabulary);
  const fromPlanning = triplesFromPlannedTests(plannedTests);

  const vocabularyOnly = [...fromVocabulary].filter((triple) => !fromPlanning.has(triple)).sort();
  const planningOnly = [...fromPlanning].filter((triple) => !fromVocabulary.has(triple)).sort();

  assert.deepEqual(
    vocabularyOnly,
    [],
    `the vocabulary names requests planInvestigation never forms: ${JSON.stringify(vocabularyOnly)}`,
  );
  assert.deepEqual(
    planningOnly,
    [],
    `planInvestigation forms requests the vocabulary does not name: ${JSON.stringify(planningOnly)}`,
  );

  for (const shape of vocabulary) {
    for (const inputKey of shape.input) {
      if (inputKey.values !== undefined) {
        assert.ok(
          !inputKey.values.includes('latency'),
          `no input key's values may include latency (a refused signal): ${shape.tool}.${inputKey.key}`,
        );
      }
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 4. refusals: an out-of-vocabulary observation field, a conflicting tool   */
/* -------------------------------------------------------------------------- */

test('routeRequestVocabulary throws naming the field when a route maps an input key to an observation field outside subject, window, signal or logClass', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  const routes = Object.freeze({
    version: 'bad-field-v1',
    byForm: Object.freeze({
      'bad-form': Object.freeze({ tool: 'toolX', input: Object.freeze({ service: 'presence' }) }),
    }),
  });

  assert.throws(
    () => routeRequestVocabulary(routes),
    (error) => {
      assert.ok(error instanceof Error, 'routeRequestVocabulary must throw an Error');
      assert.ok(error.message.includes('presence'), `the error must name the offending field: ${error.message}`);
      return true;
    },
  );
});

test('routeRequestVocabulary throws naming the tool when two routes name it with different input mappings', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  const routes = Object.freeze({
    version: 'conflicting-tool-v1',
    byForm: Object.freeze({
      'form-1': Object.freeze({ tool: 'toolY', input: Object.freeze({ service: 'subject', window: 'window' }) }),
      'form-2': Object.freeze({ tool: 'toolY', input: Object.freeze({ service: 'subject' }) }),
    }),
  });

  assert.throws(
    () => routeRequestVocabulary(routes),
    (error) => {
      assert.ok(error instanceof Error, 'routeRequestVocabulary must throw an Error');
      assert.ok(error.message.includes('toolY'), `the error must name the conflicting tool: ${error.message}`);
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* 5. no replay-corpus value leaks into the vocabulary                       */
/* -------------------------------------------------------------------------- */

test('the vocabulary for INVESTIGATION_ROUTES names no replay-corpus value: no scenario id, evidence id, annotation subject, or recorded input value', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  const vocabulary = routeRequestVocabulary(graph.INVESTIGATION_ROUTES);
  const serialized = JSON.stringify(vocabulary);

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
  assert.ok(
    recordedInputValues.length > 0,
    'fixture sanity: REPLAY_SCENARIOS must carry recorded input string values to check against',
  );

  for (const id of scenarioIds) {
    assert.ok(!serialized.includes(id), `the vocabulary must not name the corpus scenario id ${id}`);
  }
  for (const id of evidenceIds) {
    assert.ok(!serialized.includes(id), `the vocabulary must not name the corpus evidence id ${id}`);
  }
  for (const subject of annotationSubjects) {
    assert.ok(!serialized.includes(subject), `the vocabulary must not name the corpus subject ${subject}`);
  }
  for (const value of recordedInputValues) {
    assert.ok(!serialized.includes(value), `the vocabulary must not name the recorded input value ${value}`);
  }
});

/* -------------------------------------------------------------------------- */
/* 6. deeply frozen                                                           */
/* -------------------------------------------------------------------------- */

test('routeRequestVocabulary(INVESTIGATION_ROUTES) is deeply frozen', () => {
  const routeRequestVocabulary = requireDomainExport('routeRequestVocabulary');
  const vocabulary = routeRequestVocabulary(graph.INVESTIGATION_ROUTES);

  assert.ok(Object.isFrozen(vocabulary), 'the vocabulary array itself must be frozen');
  for (const shape of vocabulary) {
    assert.ok(Object.isFrozen(shape), `each tool request shape must be frozen: ${shape.tool}`);
    assert.ok(Object.isFrozen(shape.input), `each shape's input array must be frozen: ${shape.tool}`);
    for (const inputKey of shape.input) {
      assert.ok(Object.isFrozen(inputKey), `each input key entry must be frozen: ${shape.tool}.${inputKey.key}`);
      if (inputKey.values !== undefined) {
        assert.ok(
          Object.isFrozen(inputKey.values),
          `each input key's values array must be frozen: ${shape.tool}.${inputKey.key}`,
        );
      }
    }
  }
});

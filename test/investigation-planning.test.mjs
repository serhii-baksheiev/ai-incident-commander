/**
 * AIC-125 slice a: the pure domain half of the deterministic planner —
 * `planInvestigation`, which turns UNTESTED predictions into new, planned
 * `InvestigationTest`s. Style follows `prediction-derivation.ts` and its test
 * neighbour `prediction-path-domain.test.mjs`: a caller-supplied table
 * (`routes`, here — the mechanism -> template table there) is a parameter,
 * never looked up by this module; the graph-owned production table and node
 * belong to `test/investigation-routes.test.mjs`.
 *
 * Every expectation is a hand-written literal or an independently computed
 * recipe (the id hash), never read back off the function under test
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant" — this
 * is domain business logic, not a security/governance mechanism, but the
 * same discipline is followed for the id recipe).
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

function requirePlanInvestigation() {
  assert.equal(
    typeof domain.planInvestigation,
    'function',
    '@aic/domain must publish planInvestigation(options)',
  );
  return domain.planInvestigation;
}

/**
 * A routes table shaped exactly like the example in the design: a
 * declarative map from an expected observation's own fields to a request's
 * input keys, one entry per `ExpectedObservation` form.
 */
const ROUTES = Object.freeze({
  version: 'routes-v1',
  byForm: Object.freeze({
    'deployment-in-window': Object.freeze({
      tool: 'deployments',
      input: Object.freeze({ service: 'subject', window: 'window' }),
    }),
    'signal-state': Object.freeze({
      tool: 'metrics',
      input: Object.freeze({ service: 'subject', window: 'window', metric: 'signal' }),
    }),
    'log-class-in-window': Object.freeze({
      tool: 'logs',
      input: Object.freeze({ service: 'subject', window: 'window', query: 'logClass' }),
    }),
  }),
});

function observation(form, overrides = {}) {
  const base = { form, subject: 'orders-db', window: 'incident' };
  if (form === 'deployment-in-window') return { ...base, presence: 'present', ...overrides };
  if (form === 'log-class-in-window') {
    return { ...base, logClass: 'error', presence: 'present', ...overrides };
  }
  if (form === 'signal-state') {
    return { ...base, signal: 'connection-pool', state: 'at-limit', ...overrides };
  }
  throw new Error(`unknown observation form: ${form}`);
}

function prediction(id, overrides = {}) {
  return {
    id,
    hypothesisId: `${id}-hyp`,
    statement: `${id} statement`,
    observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
    expectedIfTrue: [observation('signal-state')],
    expectedIfFalse: [],
    status: 'untested',
    ...overrides,
  };
}

function existingTest(id, tool, input, overrides = {}) {
  return {
    id,
    predictionId: 'existing-prediction',
    tool,
    input,
    cost: 'cheap',
    status: 'planned',
    ...overrides,
  };
}

/**
 * The exact id recipe the design gives: `'test-' + sha256 hex of
 * JSON.stringify(canonicalJson([tool, input, routes.version]))`. Computed
 * independently here, from the spec's own words, not imported from the
 * module under test.
 */
function expectedTestId(tool, input, routesVersion) {
  const digest = createHash('sha256')
    .update(JSON.stringify(domain.canonicalJson([tool, input, routesVersion])))
    .digest('hex');
  return `test-${digest}`;
}

/* -------------------------------------------------------------------------- */
/* which predictions are eligible                                            */
/* -------------------------------------------------------------------------- */

test('planInvestigation plans nothing when predictions is empty (a hypothesis with no cause never reaches this function, since it never gets a prediction in the first place)', () => {
  const planInvestigation = requirePlanInvestigation();

  const result = planInvestigation({ predictions: [], tests: [], routes: ROUTES });

  assert.deepEqual(result, []);
});

for (const status of ['confirmed', 'refuted', 'untestable']) {
  test(`planInvestigation plans nothing for a ${status} prediction`, () => {
    const planInvestigation = requirePlanInvestigation();
    const decided = prediction(`p-${status}`, { status });

    const result = planInvestigation({ predictions: [decided], tests: [], routes: ROUTES });

    assert.deepEqual(result, [], `a ${status} prediction must never be planned, only 'untested' ones`);
  });
}

test('planInvestigation plans an untested prediction sitting among decided ones, and only that one', () => {
  const planInvestigation = requirePlanInvestigation();
  const confirmed = prediction('p-confirmed', {
    status: 'confirmed',
    expectedIfTrue: [observation('deployment-in-window', { subject: 'checkout' })],
  });
  const untested = prediction('p-untested', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });

  const result = planInvestigation({
    predictions: [confirmed, untested],
    tests: [],
    routes: ROUTES,
  });

  assert.equal(result.length, 1, 'the decided prediction must contribute no test, only the untested one');
  assert.equal(result[0].predictionId, 'p-untested');
});

/* -------------------------------------------------------------------------- */
/* ordering: predictions in input order, expectedIfTrue before expectedIfFalse */
/* -------------------------------------------------------------------------- */

test('planInvestigation orders tests as expectedIfTrue observations before expectedIfFalse observations, within one prediction', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-1', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
    expectedIfFalse: [observation('deployment-in-window', { subject: 'orders-db' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

  assert.equal(result.length, 2);
  assert.equal(result[0].tool, 'metrics', 'the expectedIfTrue observation is planned first');
  assert.equal(result[1].tool, 'deployments', 'the expectedIfFalse observation is planned second');
});

test('planInvestigation keeps predictions in input order: the first prediction\'s tests precede the second\'s', () => {
  const planInvestigation = requirePlanInvestigation();
  const first = prediction('p-first', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });
  const second = prediction('p-second', {
    expectedIfTrue: [observation('signal-state', { subject: 'inventory-db' })],
  });

  const result = planInvestigation({
    predictions: [first, second],
    tests: [],
    routes: ROUTES,
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].predictionId, 'p-first');
  assert.equal(result[1].predictionId, 'p-second');
});

/* -------------------------------------------------------------------------- */
/* routing: an unrouted form, a missing field, and prototype-chain safety    */
/* -------------------------------------------------------------------------- */

test('planInvestigation produces no test for an observation whose form has no entry in routes.byForm', () => {
  const planInvestigation = requirePlanInvestigation();
  const narrowRoutes = Object.freeze({
    version: 'routes-narrow-v1',
    byForm: Object.freeze({
      'signal-state': ROUTES.byForm['signal-state'],
    }),
  });
  const p = prediction('p-unrouted', {
    expectedIfTrue: [observation('deployment-in-window', { subject: 'orders-db' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: narrowRoutes });

  assert.deepEqual(result, []);
});

test('planInvestigation produces no test for an observation whose form is only reachable through Object.prototype (toString), even when the prototype carries a matching route', () => {
  const planInvestigation = requirePlanInvestigation();
  const maliciousProto = { toString: { tool: 'metrics', input: {} } };
  const byForm = Object.assign(Object.create(maliciousProto), {
    'signal-state': ROUTES.byForm['signal-state'],
  });
  const p = prediction('p-tostring', {
    expectedIfTrue: [{ ...observation('signal-state'), form: 'toString' }],
  });

  const result = planInvestigation({
    predictions: [p],
    tests: [],
    routes: { version: 'routes-v1', byForm },
  });

  assert.deepEqual(
    result,
    [],
    'a form reachable only through Object.prototype must not be treated as a registered route',
  );
});

for (const form of ['constructor', '__proto__']) {
  test(`planInvestigation produces no test for an observation whose form is the inherited property name ${form}`, () => {
    const planInvestigation = requirePlanInvestigation();
    const p = prediction(`p-${form}`, {
      expectedIfTrue: [{ ...observation('signal-state'), form }],
    });

    const result = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

    assert.deepEqual(result, []);
  });
}

test('planInvestigation produces no test for an observation missing a field the route mapping names', () => {
  const planInvestigation = requirePlanInvestigation();
  const routesWithBadField = Object.freeze({
    version: 'routes-bad-field-v1',
    byForm: Object.freeze({
      'signal-state': Object.freeze({
        tool: 'metrics',
        // 'logClass' does not exist on a signal-state observation, which
        // carries 'signal' and 'state', not 'logClass'.
        input: Object.freeze({ service: 'subject', window: 'window', query: 'logClass' }),
      }),
    }),
  });
  const p = prediction('p-missing-field', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: routesWithBadField });

  assert.deepEqual(result, []);
});

/* -------------------------------------------------------------------------- */
/* request shape                                                             */
/* -------------------------------------------------------------------------- */

test('planInvestigation builds the request input exactly from the route mapping\'s input keys and named observation fields', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-shape', {
    expectedIfTrue: [observation('log-class-in-window', { subject: 'orders-db', logClass: 'timeout' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

  assert.equal(result.length, 1);
  assert.equal(result[0].tool, 'logs');
  assert.deepEqual(result[0].input, { service: 'orders-db', window: 'incident', query: 'timeout' });
});

test('every planInvestigation test carries cost cheap and status planned, and parses under InvestigationTestSchema', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-schema', {
    expectedIfTrue: [
      observation('signal-state', { subject: 'orders-db' }),
      observation('deployment-in-window', { subject: 'inventory-db' }),
    ],
    expectedIfFalse: [observation('log-class-in-window', { subject: 'payments-db' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

  assert.equal(result.length, 3, 'fixture sanity: three routable observations must plan three tests');
  for (const t of result) {
    assert.equal(t.cost, 'cheap');
    assert.equal(t.status, 'planned');
    const parsed = domain.InvestigationTestSchema.safeParse(t);
    assert.ok(parsed.success, `test must parse under InvestigationTestSchema: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* request identity and de-duplication                                       */
/* -------------------------------------------------------------------------- */

for (const status of ['planned', 'executed', 'unavailable', 'failed']) {
  test(`planInvestigation does not plan a second test when an existing test of status ${status} already carries the identical request`, () => {
    const planInvestigation = requirePlanInvestigation();
    const requestInput = { service: 'orders-db', window: 'incident', metric: 'connection-pool' };
    const routesVersion = ROUTES.version;
    const already = existingTest(
      expectedTestId('metrics', requestInput, routesVersion),
      'metrics',
      requestInput,
      { status },
    );
    const p = prediction('p-dup', {
      expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
    });

    const result = planInvestigation({ predictions: [p], tests: [already], routes: ROUTES });

    assert.deepEqual(
      result,
      [],
      'a request already carried by any existing test, of any status, is never planned again',
    );
  });
}

test('planInvestigation does not plan a request an existing test already carries under a different id, such as one a challenge role proposed', () => {
  const planInvestigation = requirePlanInvestigation();
  const requestInput = { service: 'orders-db', window: 'incident', metric: 'connection-pool' };
  const proposedElsewhere = existingTest('challenge-test-1', 'metrics', { metric: 'connection-pool', window: 'incident', service: 'orders-db' });
  const p = prediction('p-foreign', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [proposedElsewhere], routes: ROUTES });

  assert.deepEqual(
    result,
    [],
    'request identity is the tool and input, whatever id the test that already carries it was given',
  );
  assert.deepEqual(Object.keys(requestInput).sort(), Object.keys(proposedElsewhere.input).sort());
});

test('planInvestigation plans exactly one test when two observations of two different predictions produce the identical request, attributed to the first prediction in order', () => {
  const planInvestigation = requirePlanInvestigation();
  const first = prediction('p-first', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });
  const second = prediction('p-second', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });

  const result = planInvestigation({
    predictions: [first, second],
    tests: [],
    routes: ROUTES,
  });

  assert.equal(result.length, 1, 'the two observations produce the identical tool+input request, so only one test is planned');
  assert.equal(result[0].predictionId, 'p-first', 'the test is attributed to the first prediction in order');
});

test('planInvestigation plans exactly one test when a single prediction\'s expectedIfTrue and expectedIfFalse observations produce the identical request', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-self-dup', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db', state: 'at-limit' })],
    expectedIfFalse: [observation('signal-state', { subject: 'orders-db', state: 'normal' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

  assert.equal(
    result.length,
    1,
    'both observations route to the same tool+input (state is not part of the request mapping), so they collapse to one test',
  );
  assert.equal(result[0].predictionId, 'p-self-dup');
});

/* -------------------------------------------------------------------------- */
/* id recipe                                                                  */
/* -------------------------------------------------------------------------- */

test('planInvestigation builds the test id from tool, input and routes.version, matching the sha256 recipe exactly', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-id', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });

  const result = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

  assert.equal(result.length, 1);
  const expectedId = expectedTestId(
    'metrics',
    { service: 'orders-db', window: 'incident', metric: 'connection-pool' },
    ROUTES.version,
  );
  assert.equal(result[0].id, expectedId);
});

test('planInvestigation gives a different test id when routes.version differs, even though tool and input are identical', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-version', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });
  const otherRoutes = Object.freeze({ ...ROUTES, version: 'routes-v2' });

  const [testV1] = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });
  const [testV2] = planInvestigation({ predictions: [p], tests: [], routes: otherRoutes });

  assert.notEqual(testV1.id, testV2.id);
  assert.deepEqual(testV1.input, testV2.input, 'fixture sanity: the request itself is unchanged, only the routes version differs');
});

/* -------------------------------------------------------------------------- */
/* purity and determinism                                                    */
/* -------------------------------------------------------------------------- */

test('planInvestigation gives deepEqual output across two identical calls', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-pure', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });

  const first = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });
  const second = planInvestigation({ predictions: [p], tests: [], routes: ROUTES });

  assert.deepEqual(first, second);
});

test('planInvestigation is unaffected by permuting existing tests unrelated to the new observations', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-permute', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });
  const unrelatedA = existingTest('test-unrelated-a', 'deployments', { service: 'checkout', window: 'incident' });
  const unrelatedB = existingTest('test-unrelated-b', 'logs', { service: 'checkout', window: 'incident', query: 'error' });

  const resultOrderAB = planInvestigation({
    predictions: [p],
    tests: [unrelatedA, unrelatedB],
    routes: ROUTES,
  });
  const resultOrderBA = planInvestigation({
    predictions: [p],
    tests: [unrelatedB, unrelatedA],
    routes: ROUTES,
  });

  assert.deepEqual(resultOrderAB, resultOrderBA);
});

test('planInvestigation does not mutate its predictions, tests or routes inputs', () => {
  const planInvestigation = requirePlanInvestigation();
  const p = prediction('p-no-mutate', {
    expectedIfTrue: [observation('signal-state', { subject: 'orders-db' })],
  });
  const predictions = Object.freeze([p]);
  const tests = Object.freeze([]);
  const predictionsSnapshot = JSON.parse(JSON.stringify(predictions));
  const testsSnapshot = JSON.parse(JSON.stringify(tests));
  const routesSnapshot = JSON.parse(JSON.stringify(ROUTES));

  planInvestigation({ predictions, tests, routes: ROUTES });

  assert.deepEqual(predictions, predictionsSnapshot);
  assert.deepEqual(tests, testsSnapshot);
  assert.deepEqual(ROUTES, routesSnapshot);
});

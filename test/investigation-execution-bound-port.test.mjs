/**
 * AIC-146 slice b4, end-to-end row: a real 403 from a lab@1 stub, driven
 * through the real b3 bound-source execution port
 * (`createBoundInvestigationExecutor`, `@aic/tools`), must reach the
 * canonical `execute_investigation` node (`createExecuteInvestigation`,
 * `@aic/graph`) as a typed `denied` refusal recorded on the Trial — never as
 * negative evidence. The test this refusal blocked stays `untested` (never
 * `refuted`) once `evaluate_predictions` runs over the resulting state, since
 * an unavailable trial contributes no evidence at all for
 * `evaluatePredictionObservations` (`@aic/domain`) to observe.
 *
 * This file wires the real tools-side port to the real graph-side node,
 * unlike test/bound-investigation-executor.test.mjs (the port alone) and
 * test/investigation-execution.test.mjs (the node alone, against a fake
 * `execute`), and unlike test/lane-arms-golden.test.mjs (the deterministic
 * and planned-replay lanes, neither of which ever produces a refusal at all —
 * see that file's own header). Fixture builders below are the same shapes
 * test/bound-investigation-executor.test.mjs already established
 * (`makeBinding`, `createFakeFetch`, `fakeResponse`), restated locally rather
 * than imported, since that file exports nothing for reuse.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import * as tools from '@aic/tools';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

const CLOCK_ISO = '2026-09-29T00:00:00.000Z';
const fixedClock = () => new Date(CLOCK_ISO);
const RUN_ID = 'run-execute-investigation-bound-port';

function makeBinding(overrides = {}) {
  return domain.SourceBindingSchema.parse({
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId: 'lab',
    adapterVersion: '1',
    name: 'lab-primary',
    config: { baseUrl: 'http://127.0.0.1:9999' },
    credentialRefId: null,
    ...overrides,
  });
}

function fakeResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createFakeFetch(implementation) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return implementation(url, init);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

async function unreachableResolveSecret() {
  throw new Error('RESOLVE_SECRET_MUST_NOT_BE_CALLED_FOR_A_CREDENTIAL_LESS_BINDING');
}

function baseControl(overrides = {}) {
  return {
    runId: RUN_ID,
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

function investigationState(overrides = {}) {
  return {
    incident: scopedIncident('incident-execute-investigation-bound-port'),
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

test('a 403 from a lab@1 stub through the real b3 port: the test is unavailable, the trial carries a typed denied refusal naming the binding, and the prediction it was meant to test is never refuted (AIC-146 b4)', async () => {
  const binding = makeBinding();
  const constructed = await tools.createBoundInvestigationExecutor({
    bindings: [binding],
    mode: 'live',
    store: tools.createMemoryReplayStore(),
    clock: fixedClock,
    fetch: createFakeFetch(() => fakeResponse({ status: 403, body: { error: 'irrelevant upstream text' } })),
    resolveSecret: unreachableResolveSecret,
  });
  assert.equal(constructed.ok, true, JSON.stringify(constructed));

  const prediction = {
    id: 'prediction-1',
    hypothesisId: 'hypothesis-1',
    statement: 'checkout-v42 deployed in the incident window',
    observationVersion: 1,
    expectedIfTrue: [
      { form: 'deployment-in-window', subject: 'checkout', window: 'incident', presence: 'present' },
    ],
    expectedIfFalse: [],
    status: 'untested',
  };
  const plannedTest = {
    id: 'test-deployments',
    predictionId: prediction.id,
    tool: 'deployments',
    input: { service: 'checkout', window: 'incident' },
    cost: 'cheap',
    status: 'planned',
  };

  const createExecuteInvestigation = graph.createExecuteInvestigation;
  assert.equal(typeof createExecuteInvestigation, 'function', '@aic/graph must export createExecuteInvestigation');
  const node = createExecuteInvestigation({ execute: constructed.executor.execute });
  const startState = investigationState({ predictions: [prediction], tests: [plannedTest] });

  const executed = await node(startState);

  assert.equal(executed.tests[0].status, 'unavailable', 'a denied source call must mark the test unavailable, never failed');
  domain.InvestigationTestSchema.parse(executed.tests[0]);

  const [producedTrial] = executed.trials;
  assert.equal(producedTrial.status, 'unavailable');
  assert.deepEqual(
    producedTrial.refusal,
    { reason: 'denied', sourceBindingId: binding.id },
    'the trial must carry the typed refusal reason and the binding that refused it, read from run_trials rather than any node-level log',
  );
  domain.TrialSchema.parse(producedTrial);

  assert.deepEqual(executed.evidence, [], 'a denied call must never manufacture evidence');

  const nextState = {
    ...startState,
    tests: domain.upsertById(startState.tests, executed.tests),
    trials: domain.upsertById(startState.trials, executed.trials),
    evidence: domain.upsertById(startState.evidence, executed.evidence),
  };

  const { predictions: evaluatedPredictions } = domain.evaluatePredictionObservations({
    predictions: nextState.predictions,
    evidence: nextState.evidence,
    asOf: CLOCK_ISO,
  });

  assert.equal(evaluatedPredictions.length, 1);
  assert.notEqual(
    evaluatedPredictions[0].status,
    'refuted',
    'an unavailable trial must never read as negative evidence: the prediction it was meant to test stays untested, never refuted',
  );
  assert.equal(
    evaluatedPredictions[0].status,
    'untested',
    'with zero evidence to observe, the prediction must remain exactly as untested as it started',
  );
});

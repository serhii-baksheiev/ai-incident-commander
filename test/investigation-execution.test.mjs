/**
 * AIC-125 slice B: the canonical `execute_investigation` node, and the pure
 * domain checker for Trial.evidenceIds <-> Evidence.trialId consistency the
 * node's output must always satisfy.
 *
 * `trialEvidenceViolations` (`@aic/domain`) is pure: given the `trials` and
 * `evidence` arrays of an `IncidentState`, it reports every place the two
 * channels disagree about which trial produced which evidence item — an
 * evidence item pointing at a trial that does not exist, a trial pointing at
 * evidence that does not exist, and a trial claiming an evidence item whose
 * own `trialId` names a different trial. It never throws on well-shaped
 * input; every finding is a string in the returned array, empty when the two
 * channels are consistent.
 *
 * `createExecuteInvestigation({ execute })` (`@aic/graph`) is the node that
 * keeps the two channels in that consistent shape by construction: it runs
 * only the tests still in state `planned`, in state order, derives each
 * trial's identity from `deriveTrialId` (exported by `@aic/graph`, defined in
 * `packages/graph/src/identity.ts`), and re-stamps every newly emitted evidence
 * item's `trialId` to the trial that produced it — never re-emitting an
 * evidence id the state (or this same call) already holds, which is exactly
 * what keeps a replayed or duplicated tool answer from being credited to two
 * trials at once. It never derives predictions or assessments: this slice's
 * executor is deliberately silent on both, matching `projectToolResult` in
 * `packages/tools/src/contracts.ts` only for the `test.status` transitions,
 * not for prediction bookkeeping.
 *
 * `deriveTrialId`'s own formula (`packages/graph/src/identity.ts`) is recomputed
 * independently below (`expectedTrialId`) rather than imported, so a test
 * that pins a produced trial's id is not just asking the node's own
 * dependency what the right answer is.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

const ASOF = '2026-09-28T09:00:00.000Z';
const RUN_ID = 'run-execute-investigation';

function requireDomainExport(name) {
  assert.equal(typeof domain[name], 'function', `@aic/domain must export ${name}`);
  return domain[name];
}

function requireGraphExport(name) {
  assert.equal(typeof graph[name], 'function', `@aic/graph must export ${name}`);
  return graph[name];
}

/** Independent of `deriveTrialId`: the identity formula recomputed by hand. */
function expectedTrialId({ runId, testId, attempt }) {
  return createHash('sha256').update(JSON.stringify([runId, testId, attempt])).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

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

function state(overrides = {}) {
  return {
    incident: scopedIncident('incident-execute-investigation'),
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

function plannedTest(id, overrides = {}) {
  return {
    id,
    predictionId: 'prediction-1',
    tool: 'metrics',
    input: { service: 'checkout' },
    cost: 'cheap',
    status: 'planned',
    ...overrides,
  };
}

function evidenceItem(id, overrides = {}) {
  return {
    id,
    trialId: 'placeholder-trial',
    kind: 'metric',
    source: 'metrics',
    observedAt: ASOF,
    statement: `evidence recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
    ...overrides,
  };
}

function trial(id, overrides = {}) {
  return {
    id,
    runId: RUN_ID,
    testId: `test-for-${id}`,
    attempt: 1,
    tool: 'metrics',
    input: { service: 'checkout' },
    status: 'ok',
    durationMs: 0,
    evidenceIds: [],
    ...overrides,
  };
}

function recordingExecutor(resolve) {
  const calls = [];
  const execute = async (context) => {
    calls.push(context);
    return resolve(context);
  };
  execute.calls = calls;
  return execute;
}

/* -------------------------------------------------------------------------- */
/* 1. trialEvidenceViolations (@aic/domain)                                   */
/* -------------------------------------------------------------------------- */

test('trialEvidenceViolations returns no violations for a mutually consistent set of trials and evidence', () => {
  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  const trials = [trial('trial-1', { testId: 'test-1', evidenceIds: ['e-1'] })];
  const evidence = [evidenceItem('e-1', { trialId: 'trial-1' })];

  assert.deepEqual(trialEvidenceViolations({ trials, evidence }), []);
});

test('trialEvidenceViolations returns no violations when there are no trials and no evidence at all', () => {
  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');

  assert.deepEqual(trialEvidenceViolations({ trials: [], evidence: [] }), []);
});

test('trialEvidenceViolations reports an evidence item whose trialId names no trial in the given trials', () => {
  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  const trials = [];
  const evidence = [evidenceItem('e-orphan', { trialId: 'trial-missing' })];

  const violations = trialEvidenceViolations({ trials, evidence });

  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes('e-orphan'), 'names the offending evidence id');
  assert.ok(violations[0].includes('trial-missing'), 'names the trial id it could not find');
});

test('trialEvidenceViolations reports a trial whose evidenceIds lists an id not present in the given evidence', () => {
  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  const trials = [trial('trial-1', { testId: 'test-1', evidenceIds: ['e-missing'] })];
  const evidence = [];

  const violations = trialEvidenceViolations({ trials, evidence });

  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes('trial-1'), 'names the offending trial id');
  assert.ok(violations[0].includes('e-missing'), 'names the evidence id it could not find');
});

test('trialEvidenceViolations reports a trial listing an evidence item whose trialId names a different trial', () => {
  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  const trials = [
    trial('trial-1', { testId: 'test-1', evidenceIds: ['e-1'] }),
    trial('trial-2', { testId: 'test-2', evidenceIds: [] }),
  ];
  const evidence = [evidenceItem('e-1', { trialId: 'trial-2' })];

  const violations = trialEvidenceViolations({ trials, evidence });

  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes('trial-1'), 'names the trial making the claim');
  assert.ok(violations[0].includes('e-1'), 'names the evidence id in dispute');
  assert.ok(violations[0].includes('trial-2'), 'names the trial the evidence actually points at');
});

test('trialEvidenceViolations escapes and truncates a hostile trialId in its message, the same way other domain refusals do', () => {
  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  const hostileTrialId = `"quoted"\n${'x'.repeat(500)}`;
  const evidence = [evidenceItem('e-hostile', { trialId: hostileTrialId })];

  const violations = trialEvidenceViolations({ trials: [], evidence });

  assert.equal(violations.length, 1);
  // Independent of quoteModelText: the domain-wide escape/truncate convention
  // is JSON.stringify of the first 80 characters (conclusion-rules.ts,
  // NAME_TRUNCATE_LENGTH), recomputed here rather than imported.
  const expectedQuoted = JSON.stringify(hostileTrialId.slice(0, 80));
  assert.ok(
    violations[0].includes(expectedQuoted),
    `expected the escaped, truncated form ${expectedQuoted} in ${violations[0]}`,
  );
  assert.ok(
    !violations[0].includes(hostileTrialId),
    'the raw, untruncated hostile value must never appear in the message',
  );
});

for (const [label, trials, evidence, hostile] of [
  [
    'a trial whose evidenceIds lists an id not present in the given evidence',
    (h) => [trial('trial-1', { testId: 'test-1', evidenceIds: [h] })],
    () => [],
  ],
  [
    'a trial listing an evidence item whose trialId names a different trial',
    (h) => [trial('trial-1', { testId: 'test-1', evidenceIds: [h] }), trial('trial-2', { testId: 'test-2', evidenceIds: [] })],
    (h) => [evidenceItem(h, { trialId: 'trial-2' })],
  ],
].map(([l, t, e]) => [l, t, e, `"quoted"\n${'y'.repeat(500)}`])) {
  test(`trialEvidenceViolations escapes and truncates a hostile evidence id when reporting ${label}`, () => {
    const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');

    const violations = trialEvidenceViolations({ trials: trials(hostile), evidence: evidence(hostile) });

    assert.equal(violations.length, 1);
    const expectedQuoted = JSON.stringify(hostile.slice(0, 80));
    assert.ok(violations[0].includes(expectedQuoted), `expected ${expectedQuoted} in ${violations[0]}`);
    assert.ok(!violations[0].includes('\n'), 'a raw newline from a hostile id must never reach the message');
  });
}

/* -------------------------------------------------------------------------- */
/* 2. createExecuteInvestigation (@aic/graph) — selection and identity        */
/* -------------------------------------------------------------------------- */

test('createExecuteInvestigation({execute}) calls execute for nothing and returns empty tests, trials and evidence when no test is planned', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({
    tests: [
      plannedTest('test-executed', { status: 'executed' }),
      plannedTest('test-unavailable', { status: 'unavailable' }),
      plannedTest('test-failed', { status: 'failed' }),
    ],
  });

  const result = await node(testState);

  assert.equal(execute.calls.length, 0, 'execute must never be called when nothing is planned');
  assert.deepEqual(result, { tests: [], trials: [], evidence: [] });
});

test('runs only the tests with status planned, in state order, and never calls execute for executed, unavailable or failed tests', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({
    tests: [
      plannedTest('test-done', { status: 'executed' }),
      plannedTest('test-planned-1', { status: 'planned' }),
      plannedTest('test-failed', { status: 'failed' }),
      plannedTest('test-planned-2', { status: 'planned' }),
      plannedTest('test-unavailable', { status: 'unavailable' }),
    ],
  });

  const result = await node(testState);

  assert.deepEqual(
    execute.calls.map((context) => context.testId),
    ['test-planned-1', 'test-planned-2'],
    'only the planned tests are executed, in the order they appear in state',
  );
  assert.deepEqual(
    result.tests.map((testItem) => testItem.id),
    ['test-planned-1', 'test-planned-2'],
    'only the tests that were actually run are returned',
  );
});

test("derives attempt as 1 plus the highest attempt already in state for that test's id", async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({
    tests: [plannedTest('test-a')],
    trials: [
      trial('old-trial-1', { testId: 'test-a', attempt: 1, status: 'unavailable' }),
      trial('old-trial-2', { testId: 'test-a', attempt: 2, status: 'unavailable' }),
      trial('unrelated-trial', { testId: 'test-b', attempt: 5, status: 'ok' }),
    ],
  });

  const result = await node(testState);

  assert.equal(execute.calls[0].attempt, 3, 'the next attempt is 1 past the highest attempt already recorded for test-a (2), not a count of test-a\'s trials');
  assert.equal(result.trials[0].attempt, 3);
  assert.equal(
    result.trials[0].id,
    expectedTrialId({ runId: RUN_ID, testId: 'test-a', attempt: 3 }),
  );
});

test('derives attempt past the highest recorded attempt when a test\'s attempts are not contiguous, so a new trial never lands on an existing trial id', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({
    tests: [plannedTest('test-a')],
    trials: [
      trial(expectedTrialId({ runId: RUN_ID, testId: 'test-a', attempt: 1 }), { testId: 'test-a', attempt: 1, status: 'unavailable' }),
      trial(expectedTrialId({ runId: RUN_ID, testId: 'test-a', attempt: 3 }), { testId: 'test-a', attempt: 3, status: 'unavailable' }),
    ],
  });

  const result = await node(testState);

  assert.equal(result.trials[0].attempt, 4, 'attempts {1, 3} leave 4 as the next unused attempt');
  assert.ok(
    !testState.trials.some((existing) => existing.id === result.trials[0].id),
    'the new trial id must not collide with a trial already in state',
  );
});

test('derives the trial id from the same identity formula deriveTrialId uses: sha256 of JSON.stringify([runId, testId, attempt])', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-solo')] });

  const result = await node(testState);

  assert.equal(result.trials.length, 1);
  assert.equal(
    result.trials[0].id,
    expectedTrialId({ runId: RUN_ID, testId: 'test-solo', attempt: 1 }),
  );
});

test('two planned tests sharing the same tool and input get distinct trial ids, derived from their own test id', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const sharedShape = { tool: 'metrics', input: { service: 'checkout' } };
  const testState = state({
    tests: [plannedTest('test-a', sharedShape), plannedTest('test-b', sharedShape)],
  });

  const result = await node(testState);

  const [trialA, trialB] = result.trials;
  assert.notEqual(trialA.id, trialB.id);
  assert.equal(trialA.id, expectedTrialId({ runId: RUN_ID, testId: 'test-a', attempt: 1 }));
  assert.equal(trialB.id, expectedTrialId({ runId: RUN_ID, testId: 'test-b', attempt: 1 }));
});

/* -------------------------------------------------------------------------- */
/* 3. createExecuteInvestigation — the three ToolResult outcomes              */
/* -------------------------------------------------------------------------- */

test('on an ok result: records an ok trial, emits new evidence re-stamped with the trial id, marks the test executed, and touches neither predictions nor assessments', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({
    status: 'ok',
    output: [evidenceItem('e-new', { trialId: 'whatever-the-tool-happened-to-say' })],
  }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  const result = await node(testState);

  assert.equal(!('predictions' in result), true, 'the executor never writes predictions');
  assert.equal(!('assessments' in result), true, 'the executor never writes assessments');

  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].id, 'test-a');
  assert.equal(result.tests[0].status, 'executed');
  domain.InvestigationTestSchema.parse(result.tests[0]);

  assert.equal(result.trials.length, 1);
  const [producedTrial] = result.trials;
  assert.equal(producedTrial.status, 'ok');
  assert.equal(producedTrial.durationMs, 0);
  assert.deepEqual(producedTrial.evidenceIds, ['e-new']);
  domain.TrialSchema.parse(producedTrial);

  assert.equal(result.evidence.length, 1);
  const [producedEvidence] = result.evidence;
  assert.equal(producedEvidence.id, 'e-new');
  assert.equal(producedEvidence.trialId, producedTrial.id, 're-stamped to the trial that produced it');
  assert.equal(producedEvidence.statement, 'evidence recorded as e-new', 'every other field is kept as-is');
  domain.EvidenceSchema.parse(producedEvidence);
});

test('on an ok result: a provenance block on the tool\'s own output item never survives into the recorded evidence (AIC-146 slice a)', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  // The tool's own output item attests a binding, adapter and fingerprint
  // that no BoundSourceRegistry call ever served it — well-formed enough to
  // pass EvidenceProvenanceSchema on its own, which is exactly the hazard:
  // nothing about shape alone distinguishes an adapter's claim from the
  // registry's.
  const adapterSuppliedProvenance = {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: `sha256:${'0'.repeat(64)}`,
  };
  const execute = recordingExecutor(async () => ({
    status: 'ok',
    output: [evidenceItem('e-forged', { provenance: adapterSuppliedProvenance })],
  }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  const result = await node(testState);

  assert.equal(result.evidence.length, 1);
  const [producedEvidence] = result.evidence;
  assert.equal(
    'provenance' in producedEvidence,
    false,
    'a provenance block the tool itself attached must never reach persisted evidence',
  );
  assert.equal(producedEvidence.id, 'e-forged', 'every other field is kept as-is');
  assert.equal(
    producedEvidence.statement,
    'evidence recorded as e-forged',
    'every other field is kept as-is',
  );
  domain.EvidenceSchema.parse(producedEvidence);
});

test('on an ok result naming no evidence: records an ok trial with empty evidenceIds and emits no evidence', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  const result = await node(testState);

  assert.deepEqual(result.trials[0].evidenceIds, []);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.tests[0].status, 'executed');
});

test('on an ok result: an evidence item already held in state is not re-emitted and keeps its original trialId', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  // The tool answers with an evidence item sharing an id the state already
  // holds, attributed to a different, earlier trial — a stale or duplicated
  // answer. A checker that reddened here would show the overwritten trialId;
  // this row asserts the safe outcome directly instead.
  const execute = recordingExecutor(async () => ({
    status: 'ok',
    output: [evidenceItem('e-held', { trialId: 'trial-should-be-ignored' })],
  }));
  const node = createExecuteInvestigation({ execute });
  const heldEvidence = evidenceItem('e-held', { trialId: 'trial-already', statement: 'the original statement' });
  const testState = state({
    tests: [plannedTest('test-a')],
    trials: [trial('trial-already', { testId: 'test-already', evidenceIds: ['e-held'] })],
    evidence: [heldEvidence],
  });

  const result = await node(testState);

  assert.deepEqual(result.evidence, [], 'the already-held evidence item is not re-emitted');
  assert.deepEqual(result.trials[0].evidenceIds, [], 'the new trial claims nothing it did not actually produce');

  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  const mergedTrials = domain.upsertById(testState.trials, result.trials);
  const mergedEvidence = domain.upsertById(testState.evidence, result.evidence);
  assert.deepEqual(
    trialEvidenceViolations({ trials: mergedTrials, evidence: mergedEvidence }),
    [],
    'the original evidence item still points at its original trial; nothing was overwritten',
  );
  assert.equal(
    mergedEvidence.find((item) => item.id === 'e-held').trialId,
    'trial-already',
    'the held evidence item keeps its original trialId',
  );
});

test('on an unavailable result: records an unavailable trial with no evidenceIds, emits no evidence, and marks the test unavailable', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'unavailable', reason: 'tool disabled' }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  const result = await node(testState);

  assert.equal(!('predictions' in result), true);
  assert.equal(!('assessments' in result), true);

  assert.equal(result.tests[0].status, 'unavailable');
  domain.InvestigationTestSchema.parse(result.tests[0]);

  assert.equal(result.trials[0].status, 'unavailable');
  assert.deepEqual(result.trials[0].evidenceIds, []);
  domain.TrialSchema.parse(result.trials[0]);

  assert.deepEqual(result.evidence, []);
});

test('on an error result: records an error trial with no evidenceIds, emits no evidence, and marks the test failed', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({ status: 'error', message: 'boom' }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  const result = await node(testState);

  assert.equal(!('predictions' in result), true);
  assert.equal(!('assessments' in result), true);

  assert.equal(result.tests[0].status, 'failed');
  domain.InvestigationTestSchema.parse(result.tests[0]);

  assert.equal(result.trials[0].status, 'error');
  assert.deepEqual(result.trials[0].evidenceIds, []);
  domain.TrialSchema.parse(result.trials[0]);

  assert.deepEqual(result.evidence, []);
});

test('propagates a thrown error from execute instead of swallowing it', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = async () => {
    throw new Error('tool adapter exploded');
  };
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  await assert.rejects(() => node(testState), /tool adapter exploded/);
});

/* -------------------------------------------------------------------------- */
/* 4. createExecuteInvestigation — within-call dedup and idempotency          */
/* -------------------------------------------------------------------------- */

test("two planned tests with the same tool and input: when execute returns evidence sharing a content-derived id for both, only the first test's trial claims it and the second's evidenceIds is empty", async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const contentDerivedId = 'evidence-checkout-metrics';
  const execute = recordingExecutor(async () => ({
    status: 'ok',
    // A content-addressed tool answer: the same input always yields the same
    // evidence id, regardless of which test asked for it.
    output: [evidenceItem(contentDerivedId, { trialId: 'irrelevant' })],
  }));
  const node = createExecuteInvestigation({ execute });
  const sharedShape = { tool: 'metrics', input: { service: 'checkout' } };
  const testState = state({
    tests: [plannedTest('test-a', sharedShape), plannedTest('test-b', sharedShape)],
  });

  const result = await node(testState);

  const [trialA, trialB] = result.trials;
  assert.notEqual(trialA.id, trialB.id, 'the two trials still have distinct identities');
  assert.deepEqual(trialA.evidenceIds, [contentDerivedId], 'the first test to run claims the evidence');
  assert.deepEqual(trialB.evidenceIds, [], 'the second test produced nothing new: the id was already claimed');

  assert.equal(result.evidence.length, 1, 'the shared evidence item is emitted exactly once');
  assert.equal(result.evidence[0].trialId, trialA.id);

  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  assert.deepEqual(
    trialEvidenceViolations({ trials: result.trials, evidence: result.evidence }),
    [],
    'the resulting trial/evidence pair is internally consistent',
  );
});

test('applying the first call\'s result to state by id (upsert) and calling again is idempotent: the second call executes nothing, and trialEvidenceViolations over the resulting state finds no violations', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const execute = recordingExecutor(async () => ({
    status: 'ok',
    output: [evidenceItem('e-1', { trialId: 'irrelevant' })],
  }));
  const node = createExecuteInvestigation({ execute });
  const testState = state({ tests: [plannedTest('test-a')] });

  const first = await node(testState);
  assert.equal(execute.calls.length, 1);

  const nextState = {
    ...testState,
    tests: domain.upsertById(testState.tests, first.tests),
    trials: domain.upsertById(testState.trials, first.trials),
    evidence: domain.upsertById(testState.evidence, first.evidence),
  };

  const second = await node(nextState);

  assert.equal(execute.calls.length, 1, 'no test is planned anymore, so execute is not called again');
  assert.deepEqual(second, { tests: [], trials: [], evidence: [] });

  const trialEvidenceViolations = requireDomainExport('trialEvidenceViolations');
  assert.deepEqual(trialEvidenceViolations({ trials: nextState.trials, evidence: nextState.evidence }), []);
});

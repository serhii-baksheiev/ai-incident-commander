/**
 * AIC-146 slice c1: `createExecuteInvestigation` gains an optional
 * `execution?: CommittedExecution` (`@aic/domain`) — the same port shape the
 * spike runner (`createPersistentInvestigationRunner`, `packages/graph/src/index.ts`)
 * and the model roles (`ModelRoleOptions.execution`,
 * `packages/roles/src/investigation-roles.ts`) already take — forwarded by
 * `createInvestigationNodes` (`./nodes/compose.ts`).
 *
 * With it, each planned test's port call is wrapped:
 *
 *   execution.committed(
 *     buildExecKey('tool.trial', { runId, testId, trialAttempt }),
 *     compute,
 *     { inputFingerprint },
 *   )
 *
 * where `compute` calls `execute` AND runs the node's existing outcome
 * validation (required provenance under `evidenceProvenance: 'required'`,
 * the item-supplied-provenance refusal, the own-provenance and
 * own-trial-refusal readers) BEFORE returning, so a refused outcome is never
 * committed. `inputFingerprint` is `sha256:` plus the hex sha256 of
 * `JSON.stringify(canonicalJson({ tool, input }))` — the exact format
 * `packages/roles/src/investigation-roles.ts`'s `completeOnce` already uses
 * for `model.role`.
 *
 * The fake `CommittedExecution` is the shared in-memory stand-in,
 * `test/fixtures/fake-committed-execution.mjs` (`.claude/rules/invariants.md`,
 * "one mechanism, one implementation") — reused rather than copied.
 *
 * `inputFingerprint`'s expected value below is computed by a small,
 * independent key-sorter written in this file, never by importing
 * `@aic/domain`'s `canonicalJson` — an independent oracle
 * (`.claude/rules/invariants.md`, "the independent-oracle invariant"), so
 * this row cannot be satisfied merely by the node consulting the same
 * canonicalization logic it is itself under test for using.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';

import { createFakeCommittedExecution } from './fixtures/fake-committed-execution.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';

const ASOF = '2026-09-28T09:00:00.000Z';
const RUN_ID = 'run-execute-investigation-committed';

function requireGraphExport(name) {
  assert.equal(typeof graph[name], 'function', `@aic/graph must export ${name}`);
  return graph[name];
}

/* -------------------------------------------------------------------------- */
/* shared fixtures — the same shapes investigation-execution.test.mjs uses    */
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
    incident: scopedIncident('incident-execute-investigation-committed'),
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

/** A well-formed EvidenceProvenance, fresh every call unless `overrides` pin a field. */
function validProvenance(overrides = {}) {
  return {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: new Date().toISOString(),
    requestFingerprint: `sha256:${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`,
    ...overrides,
  };
}

/** A well-formed TrialRefusal, fresh every call unless `overrides` pin a field. */
function validRefusal(overrides = {}) {
  return { reason: 'denied', sourceBindingId: randomUUID(), ...overrides };
}

/** Wraps `resolve` in a plain async function and counts how many times it actually ran. */
function countingExecutor(resolve) {
  const calls = [];
  const execute = async (context) => {
    calls.push(context);
    return resolve(context, calls.length);
  };
  execute.calls = calls;
  return execute;
}

/**
 * `sha256:` plus the hex sha256 of the JSON of a recursively key-sorted copy
 * of `value` — a second, independent sorter, deliberately not the module
 * under test's own `canonicalJson` (`@aic/domain`). Sorting only what this
 * fixture's own envelopes need: plain objects and arrays of JSON primitives.
 */
function sortKeysIndependently(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysIndependently);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysIndependently(value[key]);
    }
    return sorted;
  }
  return value;
}

function handComputedInputFingerprint(envelope) {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeysIndependently(envelope))).digest('hex')}`;
}

/* -------------------------------------------------------------------------- */
/* 1. each planned test's outcome is committed under its own tool.trial key   */
/* -------------------------------------------------------------------------- */

test('with execution, each planned test\'s outcome is committed under the key the test builds itself with buildExecKey(\'tool.trial\', {runId, testId, trialAttempt})', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a'), plannedTest('test-b')] });

  await node(testState);

  const expectedKeys = [
    domain.buildExecKey('tool.trial', { runId: RUN_ID, testId: 'test-a', trialAttempt: 1 }),
    domain.buildExecKey('tool.trial', { runId: RUN_ID, testId: 'test-b', trialAttempt: 1 }),
  ];

  assert.deepEqual(
    fake.calls,
    expectedKeys,
    'execution.committed must be called once per planned test, under the exact test-computed tool.trial key, in state order',
  );
});

/* -------------------------------------------------------------------------- */
/* 2. a second call on the same pre-checkpoint state reuses the commit        */
/* -------------------------------------------------------------------------- */

test('a second node call on the same pre-checkpoint state reuses the committed outcome: execute runs once in total and the replayed evidence provenance matches the first call', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  let tick = 0;
  const execute = countingExecutor(async () => {
    tick += 1;
    return {
      status: 'ok',
      output: [evidenceItem('e-new')],
      provenance: validProvenance({ fetchedAt: new Date(1700000000000 + tick * 1000).toISOString() }),
    };
  });
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a')] });

  const first = await node(testState);
  const second = await node(testState);

  assert.equal(execute.calls.length, 1, 'execute must run exactly once in total across both node calls');
  assert.deepEqual(
    second.evidence[0].provenance,
    first.evidence[0].provenance,
    'the second call\'s evidence must carry the same provenance the first call recorded, not a freshly computed one',
  );
});

/* -------------------------------------------------------------------------- */
/* 3. a refused outcome replays to the same Trial.refusal                     */
/* -------------------------------------------------------------------------- */

test('an unavailable outcome with a refusal replays to the same Trial.refusal on a second call', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({
    status: 'unavailable',
    reason: 'denied',
    refusal: validRefusal(),
  }));
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a')] });

  const first = await node(testState);
  const second = await node(testState);

  assert.equal(execute.calls.length, 1, 'execute must run exactly once in total across both node calls');
  assert.deepEqual(
    second.trials[0].refusal,
    first.trials[0].refusal,
    'the second call\'s trial must carry the exact refusal the first call recorded',
  );
});

/**
 * A real `RunWriteContext.committed` hands back the canonical-JSON round trip
 * of the committed value, never the object `compute` returned
 * (`packages/persistence/src/run-write-context.ts`). This wrapper does the
 * same over the shared fake, so a value that does not survive the round trip
 * shows up here without a database.
 */
function roundTripping(fake) {
  return {
    async committed(execKey, compute, options) {
      return JSON.parse(JSON.stringify(await fake.committed(execKey, compute, options)));
    },
  };
}

test('through a round-tripping execution, a replay under evidenceProvenance "required" records the same evidence and the same Trial.refusal as the first call', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async (context) =>
    context.testId === 'test-a'
      ? { status: 'ok', output: [evidenceItem('e-new')], provenance: validProvenance() }
      : { status: 'unavailable', reason: 'denied', refusal: validRefusal() },
  );
  const node = createExecuteInvestigation({
    execute,
    evidenceProvenance: 'required',
    execution: roundTripping(fake),
  });
  const testState = state({ tests: [plannedTest('test-a'), plannedTest('test-b')] });

  const first = await node(testState);
  const second = await node(testState);

  assert.equal(execute.calls.length, 2, 'execute must run once per planned test in total across both node calls');
  assert.deepEqual(second.evidence, first.evidence);
  assert.deepEqual(second.trials, first.trials);
  assert.equal(second.trials.find((trial) => trial.testId === 'test-b').refusal.reason, 'denied');
});

/* -------------------------------------------------------------------------- */
/* 4. a refused outcome is never committed                                    */
/* -------------------------------------------------------------------------- */

test('an ok outcome with non-empty output and no provenance under evidenceProvenance: "required" throws inside compute, and nothing is committed', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({ status: 'ok', output: [evidenceItem('e-new')] }));
  const node = createExecuteInvestigation({ execute, execution: fake, evidenceProvenance: 'required' });
  const testState = state({ tests: [plannedTest('test-a')] });

  await assert.rejects(() => node(testState), /provenance/i);

  assert.equal(
    fake.calls.length,
    1,
    'execution.committed must be invoked for the planned test, so the validation that refuses this outcome runs inside compute',
  );
  assert.equal(fake.store.size, 0, 'a refused outcome must never land in the committed store');
});

test('an evidence item carrying its own provenance throws inside compute, and nothing is committed', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const smugglingItem = evidenceItem('e-smuggled', { provenance: validProvenance() });
  const execute = countingExecutor(async () => ({ status: 'ok', output: [smugglingItem] }));
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a')] });

  await assert.rejects(() => node(testState));

  assert.equal(fake.calls.length, 1, 'execution.committed must be invoked, so the item-owns-provenance refusal runs inside compute');
  assert.equal(fake.store.size, 0, 'a refused outcome must never land in the committed store');
});

test('a malformed refusal throws inside compute, and nothing is committed', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({
    status: 'unavailable',
    reason: 'denied',
    refusal: validRefusal({ reason: 'not-a-real-reason' }),
  }));
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a')] });

  await assert.rejects(() => node(testState));

  assert.equal(fake.calls.length, 1, 'execution.committed must be invoked, so the malformed-refusal validation runs inside compute');
  assert.equal(fake.store.size, 0, 'a refused outcome must never land in the committed store');
});

/* -------------------------------------------------------------------------- */
/* 5. inputFingerprint                                                        */
/* -------------------------------------------------------------------------- */

test('inputFingerprint sent to execution.committed equals sha256: plus the sha256 of a hand-sorted {tool, input} envelope', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const optionsCalls = [];
  const execution = {
    async committed(execKey, compute, options = {}) {
      optionsCalls.push(options);
      return compute();
    },
  };
  const testInput = { zebra: 1, alpha: { delta: 4, bravo: 2 }, list: [3, 1, 2] };
  const execute = countingExecutor(async () => ({ status: 'ok', output: [] }));
  const node = createExecuteInvestigation({ execute, execution });
  const testState = state({ tests: [plannedTest('test-a', { tool: 'metrics', input: testInput })] });

  await node(testState);

  assert.equal(optionsCalls.length, 1, 'execution.committed must be called exactly once');
  assert.equal(
    optionsCalls[0].inputFingerprint,
    handComputedInputFingerprint({ tool: 'metrics', input: testInput }),
    'inputFingerprint must be computed independently from the exact tool and input the test carries',
  );
});

/* -------------------------------------------------------------------------- */
/* 6b. project (AIC-146 c1b): the commit also writes the trial and evidence   */
/*     a real RunWriteContext persists into aic_app.run_trials/run_evidence, */
/*     built from the same buildRecordedOutcome the node itself uses to      */
/*     shape its own return value — never a second copy of that mapping.     */
/* -------------------------------------------------------------------------- */

test('project writes exactly the trial and evidence the node records for that test', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async (context) =>
    context.testId === 'test-a'
      ? {
          status: 'ok',
          output: [evidenceItem('e-a-1'), evidenceItem('e-a-2')],
          provenance: validProvenance(),
        }
      : { status: 'unavailable', reason: 'denied', refusal: validRefusal() },
  );
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a'), plannedTest('test-b')] });

  const result = await node(testState);

  assert.equal(fake.projectionCalls.length, 2, 'each of the two planned tests is a new commit and must be projected once');

  for (const [index, plannedTestForIndex] of testState.tests.entries()) {
    const nodeTrial = result.trials.find((trial) => trial.testId === plannedTestForIndex.id);
    const nodeEvidenceForTrial = result.evidence.filter((item) => item.trialId === nodeTrial.id);
    assert.deepEqual(
      fake.projectionCalls[index].projection.trials,
      [nodeTrial],
      `projection.trials for ${plannedTestForIndex.id} must deepEqual the node's own returned trial for that test`,
    );
    assert.deepEqual(
      fake.projectionCalls[index].projection.evidence,
      nodeEvidenceForTrial,
      `projection.evidence for ${plannedTestForIndex.id} must deepEqual the node's own returned evidence for that trial`,
    );
  }
});

test('an evidence id already recorded by an earlier test in the same node call is not projected again by the later test', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({
    status: 'ok',
    output: [evidenceItem('shared-evidence')],
    provenance: validProvenance(),
  }));
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a'), plannedTest('test-b')] });

  const result = await node(testState);

  assert.deepEqual(
    result.evidence.map((item) => item.id),
    ['shared-evidence'],
    'only the first trial claims the shared evidence id (the node\'s own dedup)',
  );
  assert.equal(fake.projectionCalls.length, 2, 'both planned tests are new commits and must be projected');
  assert.deepEqual(
    fake.projectionCalls[0].projection.evidence.map((item) => item.id),
    ['shared-evidence'],
    'the first test\'s projection carries the shared evidence item',
  );
  assert.deepEqual(
    fake.projectionCalls[1].projection.evidence,
    [],
    'the second test\'s projection must not re-project an evidence id the first test already claimed',
  );
});

test('an outcome the node refuses is never projected', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({ status: 'ok', output: [evidenceItem('e-new')] }));
  const node = createExecuteInvestigation({ execute, execution: fake, evidenceProvenance: 'required' });
  const testState = state({ tests: [plannedTest('test-a')] });

  await assert.rejects(() => node(testState), /provenance/i);

  assert.equal(fake.projectionCalls.length, 0, 'a refused outcome must never be projected, matching it never being committed');
});

test('a replay of the same pre-checkpoint state projects nothing new', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const fake = createFakeCommittedExecution();
  const execute = countingExecutor(async () => ({
    status: 'ok',
    output: [evidenceItem('e-new')],
    provenance: validProvenance(),
  }));
  const node = createExecuteInvestigation({ execute, execution: fake });
  const testState = state({ tests: [plannedTest('test-a')] });

  await node(testState);
  assert.equal(fake.projectionCalls.length, 1, 'the first call is a new commit and must be projected once');

  await node(testState);
  assert.equal(
    fake.projectionCalls.length,
    1,
    'a replay of the same pre-checkpoint state must reuse the stored commit and project nothing new',
  );
});

/* -------------------------------------------------------------------------- */
/* 6. without execution, behaviour is unchanged                               */
/* -------------------------------------------------------------------------- */

test('without an execution option, the result is deepEqual to calling the node with execution explicitly undefined, for the same planned test', async () => {
  const createExecuteInvestigation = requireGraphExport('createExecuteInvestigation');
  const outcome = { status: 'ok', output: [evidenceItem('e-new')], provenance: validProvenance() };

  const baselineNode = createExecuteInvestigation({ execute: async () => outcome });
  const explicitNode = createExecuteInvestigation({ execute: async () => outcome, execution: undefined });

  const baselineResult = await baselineNode(state({ tests: [plannedTest('test-a')] }));
  const explicitResult = await explicitNode(state({ tests: [plannedTest('test-a')] }));

  assert.deepEqual(explicitResult, baselineResult, 'passing execution: undefined must not change the node\'s result');
});

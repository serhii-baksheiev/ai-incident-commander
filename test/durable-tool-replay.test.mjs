/**
 * AIC-56 slice D1: the TOOL half of the acceptance row, on the spike runner
 * (`createPersistentInvestigationRunner`) - "Kill between result transaction
 * and LangGraph checkpoint -> replay returns the exact committed result and
 * does not call LLM/tool twice." This file proves it against an in-memory
 * `CommittedExecution` (`test/fixtures/fake-committed-execution.mjs`) over
 * LangGraph's `MemorySaver`, which is enough to decide the CONTRACT between
 * the runner and the port without a database.
 *
 * The MODEL half (a role's model invocation committed the same way) is slice
 * D2 and is not this file's concern - see
 * `docs/decisions/durable-run-execution.md` decision 5's two operations,
 * `tool.trial` and `model.role`, and `packages/domain/src/execution.ts`'s
 * `EXECUTION_OPERATIONS` registry.
 *
 * The REAL-PostgreSQL half of THIS acceptance - a real `RunWriteContext`,
 * real crash and lease recovery, driven through separate processes - is
 * `infra/postgres/tests/durable-tool-replay.live.mjs`.
 *
 * ## Design choices this file assumes
 *
 * - `createPersistentInvestigationRunner` takes an optional `execution`
 *   dependency satisfying `@aic/domain`'s `CommittedExecution` port
 *   (`committed(execKey, compute, options?)`). With no `execution`, the node
 *   is byte-for-byte today's behaviour (row 4 below is exactly that claim).
 * - With `execution`, the node commits under
 *   `buildExecKey('tool.trial', { runId, testId, trialAttempt: state.attempt })`
 *   and passes `compute = () => executeInvestigation(ctx)`; `project` is
 *   called with the COMMITTED result (the value `compute()` produced, first
 *   time or replayed) and returns `{ trials, evidence }` built from it exactly
 *   the way the node already builds them without `execution`.
 *
 * If the implementation shapes either differently, that reason belongs in the
 * PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MemorySaver } from '@langchain/langgraph';

import * as domain from '@aic/domain';
import { createPersistentInvestigationRunner, deriveEvidenceId, deriveTrialId } from '@aic/graph';

import { childEnv } from './fixtures/child-env.mjs';
import { createFakeCommittedExecution } from './fixtures/fake-committed-execution.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(projectRoot, 'test/fixtures/durable-tool-replay-type-contract.ts');

const RUN_ID = 'run-durable-tool-replay';
const TEST_ID = 'test-checkout';
const TEST_INPUT = Object.freeze({ service: 'checkout' });
const PAYLOAD_FINGERPRINT = 'fixture-payload-v1';

function buildTest(id = TEST_ID) {
  return { id, tool: 'fixture-tool', input: TEST_INPUT };
}

/** A deterministic executeInvestigation, recording every context it is called with. */
function countingExecuteInvestigation(calls) {
  return async (context) => {
    calls.push(context);
    return {
      trial: { status: 'ok', durationMs: 1 },
      evidence: {
        kind: 'log',
        source: 'fixture-tool',
        observedAt: '2026-09-24T00:00:00.000Z',
        statement: 'checkout returned a deterministic fixture result',
        rawRef: 'fixture://checkout/result',
        reliability: 'high',
      },
      payloadFingerprint: PAYLOAD_FINGERPRINT,
    };
  };
}

/** A well-formed EvidenceProvenance, fresh every call: AIC-146 b2's stamp-alongside-the-result shape. */
function validProvenance(overrides = {}) {
  return {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: new Date().toISOString(),
    requestFingerprint: `sha256:${randomBytes(32).toString('hex')}`,
    ...overrides,
  };
}

/**
 * Same shape as `countingExecuteInvestigation`, but the `ExecuteInvestigationResult`
 * also carries the given `provenance` at the top level — alongside the
 * evidence fields, never inside them (AIC-146 b2).
 */
function countingExecuteInvestigationWithProvenance(calls, provenance) {
  return async (context) => {
    calls.push(context);
    return {
      trial: { status: 'ok', durationMs: 1 },
      evidence: {
        kind: 'log',
        source: 'fixture-tool',
        observedAt: '2026-09-24T00:00:00.000Z',
        statement: 'checkout returned a deterministic fixture result',
        rawRef: 'fixture://checkout/result',
      },
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      provenance,
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Row 1 - the compile-time port contract                                     */
/* -------------------------------------------------------------------------- */

test('compiles the durable-tool-replay type contract: RunWriteContext satisfies CommittedExecution', () => {
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

/* -------------------------------------------------------------------------- */
/* Row 3 - the exec key the node uses                                         */
/* -------------------------------------------------------------------------- */

test('the tool.trial node commits under buildExecKey(runId, testId, trialAttempt: 1)', async () => {
  const calls = [];
  const fake = createFakeCommittedExecution();

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    execution: fake,
    executeInvestigation: countingExecuteInvestigation(calls),
  });

  await runner.start({ runId: RUN_ID, test: buildTest() });

  const expectedKey = domain.buildExecKey('tool.trial', {
    runId: RUN_ID,
    testId: TEST_ID,
    trialAttempt: 1,
  });

  assert.deepEqual(
    fake.calls,
    [expectedKey],
    'the node must call execution.committed with exactly the documented tool.trial exec key, and only once for one Trial attempt',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 4 - pass-through equivalence: an execution port that just calls        */
/* compute() through must change nothing observable                          */
/* -------------------------------------------------------------------------- */

test('a pass-through execution port produces the same result as no execution port at all', async () => {
  const callsWithExecution = [];
  const callsWithoutExecution = [];

  const passthrough = { committed: (_execKey, compute) => compute() };

  const runnerWithExecution = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    execution: passthrough,
    executeInvestigation: countingExecuteInvestigation(callsWithExecution),
  });
  const runnerWithoutExecution = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    executeInvestigation: countingExecuteInvestigation(callsWithoutExecution),
  });

  const [withExecution, withoutExecution] = await Promise.all([
    runnerWithExecution.start({ runId: RUN_ID, test: buildTest() }),
    runnerWithoutExecution.start({ runId: RUN_ID, test: buildTest() }),
  ]);

  assert.deepEqual(
    withExecution,
    withoutExecution,
    'an execution port that only calls compute() through must be byte-for-byte the same result as no execution port at all - decision 3 of this slice\'s intended design',
  );
  assert.equal(callsWithExecution.length, 1, 'executeInvestigation must still be called exactly once, through the pass-through port');
  assert.equal(callsWithoutExecution.length, 1, 'executeInvestigation must still be called exactly once, with no execution port at all');
});

/* -------------------------------------------------------------------------- */
/* Row 5 - project receives the committed result, and its output is exactly   */
/* the trial and evidence the runner returns                                  */
/* -------------------------------------------------------------------------- */

test('project receives the committed result, and its output is exactly the trial and evidence the runner returns', async () => {
  const calls = [];
  const fake = createFakeCommittedExecution();

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    execution: fake,
    executeInvestigation: countingExecuteInvestigation(calls),
  });

  const result = await runner.start({ runId: RUN_ID, test: buildTest() });

  assert.equal(fake.projectionCalls.length, 1, 'project must be called exactly once, for the one new commit');
  const [{ result: committedResult, projection }] = fake.projectionCalls;

  assert.equal(
    committedResult?.payloadFingerprint,
    PAYLOAD_FINGERPRINT,
    'project must receive the COMMITTED result compute() produced (the ExecuteInvestigationResult), not undefined - the trial and evidence cannot otherwise be derived from it',
  );
  assert.deepEqual(
    projection?.trials,
    result.trials,
    "project's returned trials must be exactly the ones the runner itself returns",
  );
  assert.deepEqual(
    projection?.evidence,
    result.evidence,
    "project's returned evidence must be exactly the ones the runner itself returns",
  );
});

/* -------------------------------------------------------------------------- */
/* Row 2 - crash between commit and checkpoint: replay reuses the committed   */
/* result and does not call the tool twice                                    */
/* -------------------------------------------------------------------------- */

test('crash between commit and checkpoint: resume returns the committed result and calls executeInvestigation exactly once in total', async () => {
  const calls = [];
  const checkpointer = new MemorySaver();
  const fake = createFakeCommittedExecution({ crashAfterFirstCommit: true });

  const crashingRunner = createPersistentInvestigationRunner({
    checkpointer,
    execution: fake,
    executeInvestigation: countingExecuteInvestigation(calls),
  });

  await assert.rejects(
    () => crashingRunner.start({ runId: RUN_ID, test: buildTest() }),
    /SIMULATED_CRASH_AFTER_COMMIT/,
    'the fixture must simulate the crash: the first commit lands (it is durably in the fake store), and then the sentinel propagates out of start() before LangGraph ever checkpoints this node\'s output',
  );

  // A second runner instance - simulating the restarted process - over the
  // SAME checkpointer and the SAME fake store (a fresh runner object, exactly
  // as a new process would build one, but sharing the durable state a real
  // restart would also share).
  const resumingRunner = createPersistentInvestigationRunner({
    checkpointer,
    execution: fake,
    executeInvestigation: countingExecuteInvestigation(calls),
  });

  const resumed = await resumingRunner.resume({ runId: RUN_ID });

  assert.equal(
    calls.length,
    1,
    'executeInvestigation must have been called exactly once in TOTAL across both runner instances: replay must reuse the committed result, never re-observe (decision 7)',
  );

  const expectedKey = domain.buildExecKey('tool.trial', {
    runId: RUN_ID,
    testId: TEST_ID,
    trialAttempt: 1,
  });
  const committedResult = fake.store.get(expectedKey);
  assert.ok(committedResult, 'the fake must hold a committed result for the documented tool.trial exec key');

  const expectedTrialId = deriveTrialId({ runId: RUN_ID, testId: TEST_ID, attempt: 1 });
  const expectedEvidenceId = deriveEvidenceId({
    trialId: expectedTrialId,
    payloadFingerprint: committedResult.payloadFingerprint,
  });

  assert.equal(resumed.trials.length, 1);
  assert.equal(resumed.evidence.length, 1);
  assert.deepEqual(
    resumed.trials[0],
    {
      id: expectedTrialId,
      runId: RUN_ID,
      testId: TEST_ID,
      attempt: 1,
      tool: 'fixture-tool',
      input: TEST_INPUT,
      status: committedResult.trial.status,
      durationMs: committedResult.trial.durationMs,
      evidenceIds: [expectedEvidenceId],
    },
    'the resumed Trial must be derived from the COMMITTED result (compute must not have run a second time to produce a fresh one)',
  );
  assert.deepEqual(
    resumed.evidence[0],
    { ...committedResult.evidence, id: expectedEvidenceId, trialId: expectedTrialId },
    'the resumed Evidence must be derived from the committed result',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6 (AIC-146 b2) - evidence carrying its own provenance is refused,      */
/* naming the evidence id; nothing is committed                              */
/* -------------------------------------------------------------------------- */

test('evidence carrying its own provenance is refused, naming the evidence id, and nothing is committed', async () => {
  // The port's own caller attests a binding, adapter and fingerprint that no
  // BoundSourceRegistry call ever served it - well-formed enough to pass
  // EvidenceProvenanceSchema on its own, which is exactly the hazard: nothing
  // about shape alone distinguishes an adapter's claim from the registry's.
  // Slice a silently dropped this; b2 refuses it outright.
  const adapterSuppliedProvenance = {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: `sha256:${'0'.repeat(64)}`,
  };

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    async executeInvestigation() {
      return {
        trial: { status: 'ok', durationMs: 1 },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-09-24T00:00:00.000Z',
          statement: 'checkout returned a deterministic fixture result',
          rawRef: 'fixture://checkout/result',
          provenance: adapterSuppliedProvenance,
        },
        payloadFingerprint: PAYLOAD_FINGERPRINT,
      };
    },
  });

  const expectedEvidenceId = deriveEvidenceId({
    trialId: deriveTrialId({ runId: RUN_ID, testId: TEST_ID, attempt: 1 }),
    payloadFingerprint: PAYLOAD_FINGERPRINT,
  });

  await assert.rejects(
    () => runner.start({ runId: RUN_ID, test: buildTest() }),
    (error) => {
      assert.ok(error instanceof Error, 'the refusal must be a thrown Error');
      assert.ok(
        error.message.includes(expectedEvidenceId),
        `expected the refusal to name the evidence id ${expectedEvidenceId}, got: ${error.message}`,
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6b (AIC-146 b2 round-1 fix) - the same refusal, through a real         */
/* committed-execution store: nothing lands in it                            */
/* -------------------------------------------------------------------------- */

test('evidence carrying its own provenance is refused through a real committed-execution store, the store commits nothing, and no projection runs', async () => {
  const adapterSuppliedProvenance = {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: `sha256:${'0'.repeat(64)}`,
  };
  const fake = createFakeCommittedExecution();

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    execution: fake,
    async executeInvestigation() {
      return {
        trial: { status: 'ok', durationMs: 1 },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-09-24T00:00:00.000Z',
          statement: 'checkout returned a deterministic fixture result',
          rawRef: 'fixture://checkout/result',
          provenance: adapterSuppliedProvenance,
        },
        payloadFingerprint: PAYLOAD_FINGERPRINT,
      };
    },
  });

  const expectedEvidenceId = deriveEvidenceId({
    trialId: deriveTrialId({ runId: RUN_ID, testId: TEST_ID, attempt: 1 }),
    payloadFingerprint: PAYLOAD_FINGERPRINT,
  });

  await assert.rejects(
    () => runner.start({ runId: RUN_ID, test: buildTest() }),
    (error) => {
      assert.ok(error instanceof Error, 'the refusal must be a thrown Error');
      assert.ok(
        error.message.includes(expectedEvidenceId),
        `expected the refusal to name the evidence id ${expectedEvidenceId}, got: ${error.message}`,
      );
      return true;
    },
  );

  assert.equal(
    fake.store.size,
    0,
    'a refused result must never be committed to the execution store — validation happens inside compute(), before the store can ever set the key',
  );
  assert.equal(fake.projectionCalls.length, 0, 'project must never run for a result that was never committed');
});

/* -------------------------------------------------------------------------- */
/* Row 6c (AIC-146 b2 round-1 fix) - a NON-enumerable own provenance on the   */
/* evidence is refused exactly like an enumerable one, through the durable   */
/* site                                                                      */
/* -------------------------------------------------------------------------- */

test('evidence carrying its own NON-enumerable provenance is refused through the durable site just like an enumerable one, and nothing is committed', async () => {
  const adapterSuppliedProvenance = {
    sourceBindingId: randomUUID(),
    adapter: 'lab@1',
    credentialRefId: null,
    fetchedAt: '2026-09-24T00:00:00.000Z',
    requestFingerprint: `sha256:${'1'.repeat(64)}`,
  };
  const fake = createFakeCommittedExecution();

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    execution: fake,
    async executeInvestigation() {
      const evidence = {
        kind: 'log',
        source: 'fixture-tool',
        observedAt: '2026-09-24T00:00:00.000Z',
        statement: 'checkout returned a deterministic fixture result',
        rawRef: 'fixture://checkout/result',
      };
      Object.defineProperty(evidence, 'provenance', {
        value: adapterSuppliedProvenance,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      return {
        trial: { status: 'ok', durationMs: 1 },
        evidence,
        payloadFingerprint: PAYLOAD_FINGERPRINT,
      };
    },
  });

  await assert.rejects(
    () => runner.start({ runId: RUN_ID, test: buildTest() }),
    Error,
    'a non-enumerable own provenance on the evidence must be refused, not silently spread away',
  );

  assert.equal(
    fake.store.size,
    0,
    'a refused result must never be committed to the execution store',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6d (AIC-146 b2 round-1 fix) - an explicit own provenance: undefined on */
/* the ExecuteInvestigationResult is refused with a clear message, not left   */
/* to crash opaquely at a later commit                                       */
/* -------------------------------------------------------------------------- */

test('an ExecuteInvestigationResult with an explicit own provenance: undefined is refused with a message naming provenance, before anything is committed', async () => {
  const fake = createFakeCommittedExecution();

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    execution: fake,
    async executeInvestigation() {
      return {
        trial: { status: 'ok', durationMs: 1 },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-09-24T00:00:00.000Z',
          statement: 'checkout returned a deterministic fixture result',
          rawRef: 'fixture://checkout/result',
        },
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        provenance: undefined,
      };
    },
  });

  await assert.rejects(
    () => runner.start({ runId: RUN_ID, test: buildTest() }),
    (error) => {
      assert.ok(error instanceof Error, 'the refusal must be a thrown Error');
      assert.ok(
        error.message.toLowerCase().includes('provenance'),
        `expected the refusal to name provenance, got: ${error.message}`,
      );
      return true;
    },
  );

  assert.equal(
    fake.store.size,
    0,
    'an explicit provenance: undefined must be refused before the result is ever committed, not accepted and left to fail opaquely later at the real persistence layer',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 7 (AIC-146 b2) - provenance travels alongside the result, never inside */
/* evidence, and becomes part of the persisted evidence                      */
/* -------------------------------------------------------------------------- */

test('provenance on the ExecuteInvestigationResult (alongside evidence, not inside it) becomes part of the persisted evidence', async () => {
  const calls = [];
  const provenance = validProvenance();

  const runner = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    executeInvestigation: countingExecuteInvestigationWithProvenance(calls, provenance),
  });

  const result = await runner.start({ runId: RUN_ID, test: buildTest() });

  assert.equal(result.evidence.length, 1);
  assert.deepEqual(
    result.evidence[0].provenance,
    provenance,
    'the persisted evidence must carry exactly the provenance the result declared alongside it',
  );
  domain.EvidenceSchema.parse(result.evidence[0]);
});

/* -------------------------------------------------------------------------- */
/* Row 8 (AIC-146 b2) - crash between commit and checkpoint, with provenance  */
/* -------------------------------------------------------------------------- */

test('crash between commit and checkpoint, with provenance: resume returns evidence deepEqual including provenance.fetchedAt, and executeInvestigation ran once', async () => {
  const calls = [];
  const checkpointer = new MemorySaver();
  const fake = createFakeCommittedExecution({ crashAfterFirstCommit: true });
  const provenance = validProvenance();

  const crashingRunner = createPersistentInvestigationRunner({
    checkpointer,
    execution: fake,
    executeInvestigation: countingExecuteInvestigationWithProvenance(calls, provenance),
  });

  await assert.rejects(
    () => crashingRunner.start({ runId: RUN_ID, test: buildTest() }),
    /SIMULATED_CRASH_AFTER_COMMIT/,
  );

  const resumingRunner = createPersistentInvestigationRunner({
    checkpointer,
    execution: fake,
    executeInvestigation: countingExecuteInvestigationWithProvenance(calls, provenance),
  });

  const resumed = await resumingRunner.resume({ runId: RUN_ID });

  assert.equal(
    calls.length,
    1,
    'executeInvestigation must have been called exactly once in TOTAL across both runner instances',
  );

  const expectedTrialId = deriveTrialId({ runId: RUN_ID, testId: TEST_ID, attempt: 1 });
  const expectedEvidenceId = deriveEvidenceId({ trialId: expectedTrialId, payloadFingerprint: PAYLOAD_FINGERPRINT });

  assert.equal(resumed.evidence.length, 1);
  assert.deepEqual(
    resumed.evidence[0],
    {
      id: expectedEvidenceId,
      trialId: expectedTrialId,
      kind: 'log',
      source: 'fixture-tool',
      observedAt: '2026-09-24T00:00:00.000Z',
      statement: 'checkout returned a deterministic fixture result',
      rawRef: 'fixture://checkout/result',
      provenance,
    },
    'the resumed Evidence must be derived from the COMMITTED result, provenance.fetchedAt included',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 9 (AIC-146 b2) - the evidence id formula never takes provenance as an  */
/* input                                                                      */
/* -------------------------------------------------------------------------- */

test('evidence id is independent of provenance: the same payloadFingerprint with two different fetchedAt values yields the same evidence id', async () => {
  function executorWithFetchedAt(calls, fetchedAt) {
    return async (context) => {
      calls.push(context);
      return {
        trial: { status: 'ok', durationMs: 1 },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-09-24T00:00:00.000Z',
          statement: 'checkout returned a deterministic fixture result',
          rawRef: 'fixture://checkout/result',
        },
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        provenance: validProvenance({ fetchedAt }),
      };
    };
  }

  const callsA = [];
  const callsB = [];
  const runnerA = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    executeInvestigation: executorWithFetchedAt(callsA, '2026-09-24T00:00:00.000Z'),
  });
  const runnerB = createPersistentInvestigationRunner({
    checkpointer: new MemorySaver(),
    executeInvestigation: executorWithFetchedAt(callsB, '2026-09-24T01:00:00.000Z'),
  });

  const resultA = await runnerA.start({ runId: RUN_ID, test: buildTest() });
  const resultB = await runnerB.start({ runId: RUN_ID, test: buildTest() });

  // Independent oracle: deriveEvidenceId's own documented formula
  // (packages/graph/src/identity.ts), hashed by hand rather than through the
  // module's own export - the whole point of this row is that provenance is
  // NOT one of the formula's inputs, and asking the formula itself would
  // agree with any implementation that quietly changed that.
  const expectedTrialId = deriveTrialId({ runId: RUN_ID, testId: TEST_ID, attempt: 1 });
  const expectedEvidenceId = createHash('sha256')
    .update(JSON.stringify([expectedTrialId, PAYLOAD_FINGERPRINT]))
    .digest('hex');

  assert.equal(resultA.evidence[0].id, expectedEvidenceId);
  assert.equal(resultB.evidence[0].id, expectedEvidenceId);
  assert.notEqual(
    resultA.evidence[0].provenance.fetchedAt,
    resultB.evidence[0].provenance.fetchedAt,
    'sanity: the two runs must actually carry different fetchedAt values',
  );
});

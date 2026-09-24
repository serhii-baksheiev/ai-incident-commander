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

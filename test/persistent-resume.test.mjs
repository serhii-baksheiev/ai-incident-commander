import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = resolve(projectRoot, 'test/fixtures/persistent-resume-worker.mjs');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

function spawnWorker(args) {
  const child = spawn(process.execPath, [workerPath, ...args], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  const messages = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.on('message', (message) => messages.push(message));
  return { child, messages, diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}` };
}

function waitForMessage(worker, expectedType, timeoutMs = 8_000) {
  const { child, diagnostics, messages } = worker;

  const queuedIndex = messages.findIndex(
    (message) => message?.type === expectedType || message?.type === 'worker-error',
  );
  if (queuedIndex >= 0) {
    const [message] = messages.splice(queuedIndex, 1);
    return message.type === 'worker-error'
      ? Promise.reject(new Error(`${message.message}\n${message.stack ?? ''}\n${diagnostics()}`))
      : Promise.resolve(message);
  }

  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`worker did not send ${expectedType} within ${timeoutMs}ms\n${diagnostics()}`),
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    function onMessage(message) {
      const queuedMessageIndex = messages.indexOf(message);
      if (queuedMessageIndex >= 0) {
        messages.splice(queuedMessageIndex, 1);
      }
      if (message?.type === 'worker-error') {
        cleanup();
        reject(new Error(`${message.message}\n${message.stack ?? ''}\n${diagnostics()}`));
      } else if (message?.type === expectedType) {
        cleanup();
        resolveMessage(message);
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(
          `worker exited before ${expectedType}: code=${code} signal=${signal}\n${diagnostics()}`,
        ),
      );
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(worker, timeoutMs = 8_000) {
  const { child, diagnostics } = worker;

  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not exit within ${timeoutMs}ms\n${diagnostics()}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    function onExit(code, signal) {
      cleanup();
      resolveExit({ code, signal });
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function commandDiagnostics(args, result) {
  return `${process.execPath} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

test('derives stable Trial and Evidence ids from their frozen identity inputs', async () => {
  const { deriveEvidenceId, deriveTrialId } = await import('@aic/graph');
  assert.equal(typeof deriveTrialId, 'function');
  assert.equal(typeof deriveEvidenceId, 'function');

  const trialInput = { runId: 'run-1', testId: 'test-1', attempt: 1 };
  const trialId = deriveTrialId(trialInput);
  assert.match(trialId, /^[a-f\d]{64}$/);
  assert.equal(deriveTrialId(trialInput), trialId);
  assert.notEqual(deriveTrialId({ ...trialInput, attempt: 2 }), trialId);

  const evidenceInput = { trialId, payloadFingerprint: 'payload-v1' };
  const evidenceId = deriveEvidenceId(evidenceInput);
  assert.match(evidenceId, /^[a-f\d]{64}$/);
  assert.equal(deriveEvidenceId(evidenceInput), evidenceId);
  assert.notEqual(
    deriveEvidenceId({ ...evidenceInput, payloadFingerprint: 'payload-v2' }),
    evidenceId,
  );
});

test(
  'resumes the persisted run after process death without duplicate records or budget drift',
  { timeout: 25_000 },
  async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-persistent-resume-'));
    const checkpointPath = join(temporaryRoot, 'checkpoints.sqlite');
    const runId = 'run-kill-resume';
    const testId = 'test-checkout';
    let firstWorker;
    let resumedWorker;

    try {
      firstWorker = spawnWorker(['start', checkpointPath, runId, testId]);
      const unfinished = await waitForMessage(firstWorker, 'inside-execute-investigation');
      assert.deepEqual(
        { runId: unfinished.runId, testId: unfinished.testId, attempt: unfinished.attempt },
        { runId, testId, attempt: 1 },
      );
      assert.equal(existsSync(checkpointPath), true, 'the pre-node checkpoint must be on disk');
      assert.ok(statSync(checkpointPath).size > 0, 'the SQLite checkpoint must contain data');

      assert.equal(firstWorker.child.kill('SIGKILL'), true, 'the test must kill the child process');
      const killed = await waitForExit(firstWorker);
      assert.equal(killed.signal, 'SIGKILL');

      resumedWorker = spawnWorker(['resume', checkpointPath, runId]);
      const replayed = await waitForMessage(resumedWorker, 'inside-execute-investigation');
      assert.deepEqual(
        { runId: replayed.runId, testId: replayed.testId, attempt: replayed.attempt },
        { runId, testId, attempt: 1 },
        'resume must recover the pending test from the checkpoint without start inputs',
      );
      const { result } = await waitForMessage(resumedWorker, 'completed');
      const resumedExit = await waitForExit(resumedWorker);
      assert.equal(resumedExit.code, 0, resumedWorker.diagnostics());

      const { INCIDENT_STATE_SCHEMA_VERSION } = await import('@aic/domain');
      const { deriveEvidenceId, deriveTrialId } = await import('@aic/graph');
      const expectedTrialId = deriveTrialId({ runId, testId, attempt: 1 });
      const expectedEvidenceId = deriveEvidenceId({
        trialId: expectedTrialId,
        payloadFingerprint: 'fixture-payload-v1',
      });

      assert.equal(result.runId, runId);
      assert.equal(result.threadId, runId, 'runId must be the LangGraph thread_id');
      assert.equal(
        result.schemaVersion,
        INCIDENT_STATE_SCHEMA_VERSION,
        'persisted state must carry the public schema version across resume',
      );
      assert.equal(result.trials.length, 1);
      assert.equal(result.trials[0].id, expectedTrialId);
      assert.equal(result.trials[0].runId, runId);
      assert.equal(result.trials[0].testId, testId);
      assert.equal(result.trials[0].attempt, 1);
      assert.equal(
        result.trials[0].tool,
        'fixture-tool',
        'Trial provenance must use the planned test tool, not executor-supplied metadata',
      );
      assert.deepEqual(
        result.trials[0].input,
        { service: 'checkout' },
        'Trial provenance must use the planned test input, not executor-supplied metadata',
      );
      assert.equal(result.evidence.length, 1);
      assert.equal(result.evidence[0].id, expectedEvidenceId);
      assert.equal(result.evidence[0].trialId, expectedTrialId);
      assert.equal(new Set(result.trials.map((trial) => trial.id)).size, 1);
      assert.equal(new Set(result.evidence.map((evidence) => evidence.id)).size, 1);
      assert.equal(result.logicalBudgetUsed, 1);
      assert.equal(
        result.logicalBudgetUsed,
        new Set(result.trials.map((trial) => trial.id)).size,
        'logical budget must derive from unique committed trials',
      );
    } finally {
      if (firstWorker?.child.exitCode === null && firstWorker.child.signalCode === null) {
        firstWorker.child.kill('SIGKILL');
      }
      if (resumedWorker?.child.exitCode === null && resumedWorker.child.signalCode === null) {
        resumedWorker.child.kill('SIGKILL');
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test('publishes separate CLI start and resume command contracts', () => {
  for (const command of ['start', 'resume']) {
    const args = [cliPath, command, '--help'];
    const result = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, commandDiagnostics(args, result));
    assert.match(result.stdout, new RegExp(`Usage: aic ${command}(?:\\s|$)`));
    assert.match(result.stdout, /--run-id(?:\s|$)/);
    assert.match(result.stdout, /--checkpoint(?:\s|$)/);
  }
});

test(
  'starts and resumes the same persisted run through the compiled CLI',
  { timeout: 20_000 },
  async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-cli-persistent-resume-'));
    const checkpointPath = join(temporaryRoot, 'checkpoints.sqlite');
    const runId = 'run-cli-resume';

    try {
      const results = [];
      for (const command of ['start', 'resume']) {
        const args = [
          cliPath,
          command,
          '--run-id',
          runId,
          '--checkpoint',
          checkpointPath,
        ];
        const executed = spawnSync(process.execPath, args, {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 8_000,
        });
        assert.equal(executed.status, 0, commandDiagnostics(args, executed));
        results.push(JSON.parse(executed.stdout));
      }

      const [started, resumed] = results;
      const { deriveEvidenceId, deriveTrialId } = await import('@aic/graph');
      const expectedTrialId = deriveTrialId({
        runId,
        testId: 'persistence-spike',
        attempt: 1,
      });

      for (const result of [started, resumed]) {
        assert.equal(result.runId, runId);
        assert.equal(result.threadId, runId);
        assert.equal(result.trials.length, 1);
        assert.equal(result.evidence.length, 1);
        assert.equal(result.trials[0].id, expectedTrialId);
        assert.equal(result.evidence[0].trialId, expectedTrialId);
        assert.equal(
          result.evidence[0].id,
          deriveEvidenceId({
            trialId: expectedTrialId,
            payloadFingerprint: JSON.stringify({
              runId,
              testId: 'persistence-spike',
              attempt: 1,
              tool: 'persistence-spike',
              input: result.trials[0].input,
            }),
          }),
        );
        assert.equal(result.logicalBudgetUsed, 1);
      }

      assert.equal(resumed.trials[0].id, started.trials[0].id);
      assert.equal(resumed.evidence[0].id, started.evidence[0].id);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

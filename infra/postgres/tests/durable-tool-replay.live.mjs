/**
 * AIC-56 slice D1's own acceptance row, on real PostgreSQL: "Kill between
 * result transaction and LangGraph checkpoint -> replay returns the exact
 * committed result and does not call LLM/tool twice", proven for the TOOL
 * half through a real `RunStore` claim, a real `RunWriteContext`, a real
 * lease takeover, and two separate child processes - nothing here is decided
 * from inside one process's own memory.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/postgres-checkpointer.live.mjs` (spawn/wait/kill
 * helpers) and `infra/postgres/tests/run-write-context.live.mjs` (schema
 * provisioning and truncation, force-expiring a lease with raw SQL and
 * sweeping) - see those files' headers for "why this file is not under
 * `test/`", "it refuses; it never skips", and "independent verification". Not
 * repeated here in full.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## The independent oracle
 *
 * Every "was the tool actually called" count comes from IPC messages the
 * child processes themselves send from inside `executeInvestigation` - never
 * from a count this file infers from the graph's own returned state. Every
 * claim about what got committed is read with a raw SQL query against
 * `store.pool`, independent of the write context's own `committed()` read
 * path (the same convention `run-write-context.live.mjs` uses throughout).
 * The resumed run's own Trial/Evidence ids are independently re-derived
 * through `@aic/graph`'s exported `deriveTrialId`/`deriveEvidenceId`, the same
 * way `test/persistent-resume.test.mjs` and `postgres-checkpointer.live.mjs`
 * already do, rather than trusted from the graph's own output.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import { deriveEvidenceId, deriveTrialId } from '@aic/graph';
import * as persistence from '@aic/persistence';

import { childEnv } from '../../../test/fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workerPath = resolve(projectRoot, 'infra/postgres/tests/fixtures/postgres-run-worker.mjs');

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place AIC-56's tool.trial
replay acceptance row is measured against a real PostgreSQL, a real lease
takeover and two real processes, so a skip would report it as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this row touches truncated, and the pool closed at the end of
 * the row - copied from run-write-context.live.mjs's own `freshStore`.
 */
async function freshStore(t, options = DEFAULT_OPTIONS) {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const store = await persistence.createRunStore(connectionString, options);
  t.after(async () => {
    await store.close();
  });
  await store.pool.query(
    'truncate table aic_app.runs, aic_app.node_results, aic_app.run_events, aic_app.run_event_counters, aic_app.run_trials, aic_app.run_evidence, aic_app.fence_rejections',
  );
  return store;
}

/* -------------------------------------------------------------------------- */
/* Spawning - copied in shape from postgres-checkpointer.live.mjs             */
/* -------------------------------------------------------------------------- */

function spawnWorker(args) {
  const child = spawn(process.execPath, [workerPath, ...args], {
    cwd: projectRoot,
    env: childEnv({ [CONNECTION_VARIABLE]: requireConnectionString() }),
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

function waitForMessage(worker, expectedType, timeoutMs = 20_000) {
  const { child, diagnostics, messages } = worker;

  const queued = messages.findIndex((message) => message?.type === expectedType || message?.type === 'worker-error');
  if (queued >= 0) {
    const [message] = messages.splice(queued, 1);
    return message.type === 'worker-error'
      ? Promise.reject(new Error(`${message.message}\n${message.stack ?? ''}\n${diagnostics()}`))
      : Promise.resolve(message);
  }

  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not send ${expectedType} within ${timeoutMs}ms\n${diagnostics()}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', reject);
    }

    function onMessage(message) {
      const index = messages.indexOf(message);
      if (index >= 0) messages.splice(index, 1);
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
      reject(new Error(`worker exited before ${expectedType}: code=${code} signal=${signal}\n${diagnostics()}`));
    }

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', reject);
  });
}

function waitForExit(worker, timeoutMs = 20_000) {
  const { child, diagnostics } = worker;
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`worker did not exit within ${timeoutMs}ms\n${diagnostics()}`));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    }
    child.once('exit', onExit);
    child.once('error', reject);
  });
}

function killIfAlive(worker) {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill('SIGKILL');
  }
}

/**
 * Every 'inside-execute-investigation' message a worker sent while this test
 * was waiting on other messages too - not only the one message
 * `waitForMessage` was told to look for. The acceptance count ("the real tool
 * ran exactly once in total") has to include a message that arrived early,
 * while this file was awaiting something else from the SAME worker.
 */
function countExecuteInvestigationMessages(worker) {
  return worker.messages.filter((message) => message?.type === 'inside-execute-investigation').length;
}

/* -------------------------------------------------------------------------- */
/* The row                                                                    */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

test(
  'kill between the result transaction and the LangGraph checkpoint: a second worker resumes through a fresh lease, the tool runs exactly once in total, and the resumed evidence matches the committed row',
  { timeout: 60_000 },
  async (t) => {
    const store = await freshStore(t);
    const runId = `run-tool-replay-${randomUUID()}`;
    const testId = 'test-checkout';

    // The checkpointer's OWN schema (`langgraph`, separate from `aic_app` -
    // see `@aic/persistence`'s `CHECKPOINTER_SCHEMA`) needs its own explicit
    // `setup()`, exactly like `postgres-checkpointer.live.mjs`'s own
    // `provisioned(t)` helper: neither worker process below calls it itself,
    // the same way neither claims to provision `aic_app` (that is `freshStore`
    // above, against the SAME database).
    const checkpointerForSetup = await persistence.createPostgresCheckpointer(requireConnectionString());
    await checkpointerForSetup.setup();
    await checkpointerForSetup.pool.end();

    await store.createRun({ runId, input: {} });

    let crashedWorker;
    let resumedWorker;

    try {
      crashedWorker = spawnWorker(['tool-replay-start', runId, testId]);
      const unfinished = await waitForMessage(crashedWorker, 'inside-execute-investigation');
      assert.deepEqual(
        { runId: unfinished.runId, testId: unfinished.testId, attempt: unfinished.attempt },
        { runId, testId, attempt: 1 },
      );

      const committed = await waitForMessage(crashedWorker, 'committed');
      const expectedExecKey = domain.buildExecKey('tool.trial', { runId, testId, trialAttempt: 1 });
      assert.equal(
        committed.execKey,
        expectedExecKey,
        'the worker must have committed under the documented tool.trial exec key before this test kills it',
      );

      assert.equal(crashedWorker.child.kill('SIGKILL'), true, 'the test must kill the child process');
      const killed = await waitForExit(crashedWorker);
      assert.equal(
        killed.signal,
        'SIGKILL',
        `the killed child reported no SIGKILL, which means it exited on its own before the kill landed; its own exit code was ${crashedWorker.child.exitCode}\n${crashedWorker.diagnostics()}`,
      );

      // Force-expire the lease and sweep, exactly like
      // run-write-context.live.mjs's own zombie-worker row: the crashed
      // worker's lease is real (30s), so nothing here waits it out.
      await store.pool.query(
        `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
        [runId],
      );
      const swept = await store.sweepExpired();
      assert.deepEqual(swept, [runId], 'sweepExpired must reclaim exactly this run');

      resumedWorker = spawnWorker(['tool-replay-resume', runId]);
      const { result } = await waitForMessage(resumedWorker, 'completed');
      const resumedExit = await waitForExit(resumedWorker);
      assert.equal(resumedExit.code, 0, resumedWorker.diagnostics());

      const totalExecuteInvestigationCalls =
        countExecuteInvestigationMessages(crashedWorker) + countExecuteInvestigationMessages(resumedWorker);
      assert.equal(
        totalExecuteInvestigationCalls,
        1,
        'the real tool must have been called exactly once in TOTAL across both worker processes: the resumed worker must reuse the committed result rather than re-observe',
      );

      // Independent oracle: read the committed row with a raw query against
      // store.pool, never through the write context's own committed() read path.
      const { rows: nodeResultRows } = await store.pool.query(
        'select result_json, produced_by_attempt from aic_app.node_results where run_id = $1 and exec_key = $2',
        [runId, expectedExecKey],
      );
      assert.equal(nodeResultRows.length, 1, 'exactly one node_results row may exist for this run and exec_key');
      assert.equal(
        Number(nodeResultRows[0].produced_by_attempt),
        1,
        'the committed row must have been produced by the FIRST worker (execution_attempt 1), never re-written by the second',
      );

      const committedResult = JSON.parse(nodeResultRows[0].result_json);
      assert.equal(
        committedResult.payloadFingerprint,
        'fixture-payload-v1',
        'the stored result must be the raw ExecuteInvestigationResult the first worker\'s executeInvestigation produced',
      );

      const expectedTrialId = deriveTrialId({ runId, testId, attempt: 1 });
      const expectedEvidenceId = deriveEvidenceId({
        trialId: expectedTrialId,
        payloadFingerprint: committedResult.payloadFingerprint,
      });

      assert.equal(result.trials.length, 1);
      assert.equal(result.evidence.length, 1);
      assert.deepEqual(
        result.trials[0],
        {
          id: expectedTrialId,
          runId,
          testId,
          attempt: 1,
          tool: 'fixture-tool',
          input: { service: 'checkout' },
          status: committedResult.trial.status,
          durationMs: committedResult.trial.durationMs,
          evidenceIds: [expectedEvidenceId],
        },
        'the resumed Trial must be derived from the row committed by the FIRST worker, independently re-derived here rather than trusted from the graph\'s own output',
      );
      assert.deepEqual(
        result.evidence[0],
        { ...committedResult.evidence, id: expectedEvidenceId, trialId: expectedTrialId },
        'the resumed Evidence must be derived from the row committed by the first worker',
      );

      const { rows: eventRows } = await store.pool.query(
        'select type, execution_attempt from aic_app.run_events where run_id = $1 order by seq',
        [runId],
      );
      const eventTypes = eventRows.map((row) => row.type);
      const committedIndex = eventTypes.indexOf('node_result.committed');
      const reusedIndex = eventTypes.indexOf('node_result.reused');
      assert.ok(
        committedIndex >= 0 && reusedIndex >= 0 && committedIndex < reusedIndex,
        `run_events must show node_result.committed (attempt 1) before node_result.reused (attempt 2), got: ${JSON.stringify(eventRows)}`,
      );
      assert.equal(Number(eventRows[committedIndex].execution_attempt), 1);
      assert.equal(Number(eventRows[reusedIndex].execution_attempt), 2);
    } finally {
      killIfAlive(crashedWorker);
      killIfAlive(resumedWorker);
    }
  },
);

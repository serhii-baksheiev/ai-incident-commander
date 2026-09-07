/**
 * AIC-55, the half that needs a real database: an existing v0.x run executes,
 * is interrupted, and resumes on the PostgreSQL checkpointer — and survives the
 * AIC process being restarted while it does.
 *
 * ## Why this file is not under `test/`
 *
 * Measured on node 22.23.2: `node --test` with no paths treats every `.mjs`
 * under a directory named `test` as a test file — not only `*.test.mjs`. A
 * database-dependent file placed at `test/infra/…` would therefore join
 * `npm test`, and through it `npm run check`, whatever it was called. So it
 * lives here, on its own line, exactly the way `incident-lab/tests/*.live.mjs`
 * does. `test/postgres-checkpointer.test.mjs` › "keeps the database-backed lane
 * out of npm test and npm run check" is what holds that separation in place.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *
 * ## It refuses; it never skips
 *
 * With no connection string every row here FAILS, loudly, saying what to start.
 * A skip would report green for a lane that ran nothing, and the acceptance
 * rows this file covers are the ones nothing else can cover — a green skip
 * would mean "PostgreSQL resumability is proven" while proving nothing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { childEnv } from '../../../test/fixtures/child-env.mjs';

import {
  APPLICATION_SCHEMA,
  CHECKPOINTER_MIGRATION_VERSION,
  CHECKPOINTER_SCHEMA,
  assertCheckpointerSchemaVersion,
  createPostgresCheckpointer,
} from '@aic/persistence';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workerPath = resolve(
  projectRoot,
  'infra/postgres/tests/fixtures/postgres-run-worker.mjs',
);

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place the "executes,
interrupts and resumes on PostgreSQL" and "restarting the process preserves
resumability" rows are measured, so a skip would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(
    typeof value === 'string' && value.trim() !== '',
    true,
    START_THE_SUBSTRATE,
  );
  return value;
}

/** A checkpointer for this process, with its pool closed at the end of the row. */
async function checkpointerFor(t) {
  const checkpointer = await createPostgresCheckpointer(requireConnectionString());
  t.after(async () => {
    await checkpointer.pool.end();
  });
  return checkpointer;
}

/**
 * The schema, provisioned once per row through the explicit step.
 *
 * Called per row rather than once per file because `setup()` is documented as
 * idempotent by its own `CREATE SCHEMA IF NOT EXISTS` / migration-version
 * design — calling it repeatedly across rows is therefore also a small standing
 * check that a second call on a provisioned database is not an error.
 */
async function provisioned(t) {
  const checkpointer = await checkpointerFor(t);
  await checkpointer.setup();
  return checkpointer;
}

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

function spawnWorker(args) {
  const child = spawn(process.execPath, [workerPath, ...args], {
    cwd: projectRoot,
    // The allow-list forwards PATH, HOME and NODE_* and nothing else, so the
    // connection string has to be named here. That is the design: a child of
    // this suite never inherits an operator's ambient LangSmith credentials.
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
  return {
    child,
    messages,
    diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}

function waitForMessage(worker, expectedType, timeoutMs = 20_000) {
  const { child, diagnostics, messages } = worker;

  const queued = messages.findIndex(
    (message) => message?.type === expectedType || message?.type === 'worker-error',
  );
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
      reject(
        new Error(`worker exited before ${expectedType}: code=${code} signal=${signal}\n${diagnostics()}`),
      );
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

/* -------------------------------------------------------------------------- */
/* The rows                                                                   */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();

  // 🔴 The subject is never the assertion's argument, and that is the whole
  // point of the shape below.
  //
  // `assert.match(connectionString, …)` puts the raw value in the
  // AssertionError's `actual`, and node:test's reporter prints `actual:`
  // whatever the custom message says. Measured: a value that merely misses the
  // scheme — a JDBC-style URL, a `.env` value still wrapped in quotes, a
  // leading newline from a secret manager — printed the entire connection
  // string, password included, into output this repository routinely pastes
  // into journals and PR bodies. Found by `security-scanner` at the AIC-55
  // gate. Asserting on a derived BOOLEAN leaves `actual: false`, and the
  // message carries only the scheme.
  //
  // `requireConnectionString` above already had this right; this row did not.
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

test('creates the checkpointer tables in their own schema, beside the application schema', async (t) => {
  const checkpointer = await provisioned(t);

  // Reading the catalog is not what acceptance row 3 forbids: that row is about
  // API and domain CODE reading checkpointer tables. This is the lane whose job
  // is to prove where those tables landed, and information_schema is the only
  // witness for it.
  const { rows } = await checkpointer.pool.query(
    `select table_schema, table_name
       from information_schema.tables
      where table_name in ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'checkpoint_migrations')
      order by table_schema, table_name`,
    [],
  );

  const inCheckpointerSchema = rows
    .filter((row) => row.table_schema === CHECKPOINTER_SCHEMA)
    .map((row) => row.table_name);

  assert.deepEqual(
    inCheckpointerSchema.sort(),
    ['checkpoint_blobs', 'checkpoint_migrations', 'checkpoint_writes', 'checkpoints'],
    `setup() must create all four checkpointer tables inside ${CHECKPOINTER_SCHEMA}: a missing one means the explicit provisioning step is not the whole story and something else is creating tables lazily`,
  );

  const elsewhere = rows
    .filter((row) => row.table_schema !== CHECKPOINTER_SCHEMA)
    .map((row) => `${row.table_schema}.${row.table_name}`);

  assert.deepEqual(
    elsewhere,
    [],
    `checkpointer tables exist outside ${CHECKPOINTER_SCHEMA}: acceptance row 4 asks for the checkpointer schema to live separately from ${APPLICATION_SCHEMA}, and a copy in public or in the application schema is the copy a later migration will collide with`,
  );
});

test(
  'executes, interrupts, and resumes the same run in a process that never saw the first one',
  { timeout: 90_000 },
  async (t) => {
    await provisioned(t);
    const runId = `run-postgres-review-${randomUUID()}`;
    let first;
    let second;

    try {
      first = spawnWorker(['interrupt', runId]);
      const interrupted = await waitForMessage(first, 'interrupted');
      const firstExit = await waitForExit(first);
      assert.equal(firstExit.code, 0, first.diagnostics());
      assert.deepEqual(
        interrupted.next,
        ['review_conclusion'],
        'the run must pause at the human review node: without a pause there is nothing for the second process to resume, and the row would pass by never testing resumability',
      );
      assert.equal(typeof interrupted.interruptId, 'string');
      assert.equal(interrupted.threadId, runId, 'runId must be the LangGraph thread_id');

      // Nothing of the first process survives here: it has exited, and the
      // second is handed two strings on a command line. Whatever it reads back
      // came out of PostgreSQL.
      second = spawnWorker(['confirm', runId, interrupted.interruptId]);
      const restored = await waitForMessage(second, 'restored');

      assert.deepEqual(
        {
          next: restored.next,
          conclusion: restored.conclusion,
          runIdInState: restored.runIdInState,
          humanReview: restored.humanReview,
          pendingInterruptIds: restored.pendingInterruptIds,
        },
        {
          next: ['review_conclusion'],
          conclusion: { kind: 'inconclusive', causes: [] },
          runIdInState: runId,
          humanReview: true,
          pendingInterruptIds: [interrupted.interruptId],
        },
        'a fresh process read back a different pending state than the one the first process persisted: the checkpointer is not carrying the run across a restart, which is the whole of acceptance row 2',
      );

      const completed = await waitForMessage(second, 'completed');
      const secondExit = await waitForExit(second);
      assert.equal(secondExit.code, 0, second.diagnostics());

      assert.deepEqual(
        {
          interrupted: completed.interrupted,
          conclusion: completed.conclusion,
          runIdInState: completed.runIdInState,
          next: completed.next,
          threadId: completed.threadId,
        },
        {
          interrupted: false,
          conclusion: { kind: 'inconclusive', causes: [] },
          runIdInState: runId,
          next: [],
          threadId: runId,
        },
        'the resumed run must reach END on the same thread with the conclusion the first process proposed — the same semantics test/hitl-conclusion-review.test.mjs › "confirm resumes the same run and thread and completes at END" pins on SQLite, which AIC-55 must not change',
      );
    } finally {
      killIfAlive(first);
      killIfAlive(second);
    }
  },
);

test(
  'recovers the pending test after the writing process is killed mid-execution',
  { timeout: 90_000 },
  async (t) => {
    await provisioned(t);
    const runId = `run-postgres-crash-${randomUUID()}`;
    const testId = 'test-checkout';
    let crashed;
    let resumed;

    try {
      crashed = spawnWorker(['start-hang', runId, testId]);
      const unfinished = await waitForMessage(crashed, 'inside-execute-investigation');
      assert.deepEqual(
        { runId: unfinished.runId, testId: unfinished.testId, attempt: unfinished.attempt },
        { runId, testId, attempt: 1 },
      );

      // A moment for the pre-node checkpoint to be committed before the kill.
      // Unlike the SQLite lane there is no file to stat, so this is where the
      // difference shows: if the write had not landed, the resume below finds
      // no pending test and fails with exactly that.
      await delay(250);

      assert.equal(crashed.child.kill('SIGKILL'), true, 'the test must kill the child process');
      const killed = await waitForExit(crashed);
      assert.equal(
        killed.signal,
        'SIGKILL',
        `the killed child reported no SIGKILL, which means it exited on its own before the kill landed; its own exit code was ${crashed.child.exitCode}\n${crashed.diagnostics()}`,
      );

      resumed = spawnWorker(['resume', runId]);
      const replayed = await waitForMessage(resumed, 'inside-execute-investigation');
      assert.deepEqual(
        { runId: replayed.runId, testId: replayed.testId, attempt: replayed.attempt },
        { runId, testId, attempt: 1 },
        'resume must recover the pending test from PostgreSQL without start inputs: a second attempt number here would mean the crashed attempt was lost and re-planned rather than resumed',
      );

      const { result } = await waitForMessage(resumed, 'completed');
      const resumedExit = await waitForExit(resumed);
      assert.equal(resumedExit.code, 0, resumed.diagnostics());

      const { INCIDENT_STATE_SCHEMA_VERSION } = await import('@aic/domain');
      const { deriveEvidenceId, deriveTrialId } = await import('@aic/graph');
      const expectedTrialId = deriveTrialId({ runId, testId, attempt: 1 });
      const expectedEvidenceId = deriveEvidenceId({
        trialId: expectedTrialId,
        payloadFingerprint: 'fixture-payload-v1',
      });

      assert.deepEqual(
        {
          runId: result.runId,
          threadId: result.threadId,
          schemaVersion: result.schemaVersion,
          trialIds: result.trials.map((trial) => trial.id),
          evidenceIds: result.evidence.map((evidence) => evidence.id),
          logicalBudgetUsed: result.logicalBudgetUsed,
        },
        {
          runId,
          threadId: runId,
          schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
          trialIds: [expectedTrialId],
          evidenceIds: [expectedEvidenceId],
          logicalBudgetUsed: 1,
        },
        'the resumed run must commit exactly one trial and one evidence record with the ids the frozen identity inputs derive — a duplicate here is the crash being replayed as new work, which is the budget drift test/persistent-resume.test.mjs › "resumes the persisted run after process death without duplicate records or budget drift" pins on SQLite',
      );
    } finally {
      killIfAlive(crashed);
      killIfAlive(resumed);
    }
  },
);

/**
 * The seam against a real migration ledger, not a structural stand-in.
 *
 * `test/postgres-checkpointer.test.mjs` pins the seam's logic with a fake
 * source; this row is the half that only a database can answer — that the
 * version the library actually writes during `setup()` is the number this
 * build expects. If a future checkpointer release adds a migration, that
 * constant is stale and this row is what says so.
 */
test('agrees with the migration version a real setup() writes, and refuses any other', async (t) => {
  const checkpointer = await checkpointerFor(t);
  await checkpointer.setup();

  await assertCheckpointerSchemaVersion(checkpointer.pool);

  const { rows } = await checkpointer.pool.query(
    `select max(v) as v from "${CHECKPOINTER_SCHEMA}".checkpoint_migrations`,
  );
  assert.equal(
    rows[0].v,
    CHECKPOINTER_MIGRATION_VERSION,
    'the constant this build refuses against must be the version setup() really reaches: a constant nobody measured is a check that passes for the wrong reason',
  );

  // A version the store could plausibly drift to, rather than an absurd one.
  await checkpointer.pool.query(
    `insert into "${CHECKPOINTER_SCHEMA}".checkpoint_migrations (v) values ($1)`,
    [CHECKPOINTER_MIGRATION_VERSION + 1],
  );
  await assert.rejects(
    () => assertCheckpointerSchemaVersion(checkpointer.pool),
    /migration version/,
    'a store one migration ahead of this build must refuse before execution rather than be read as if it were this version',
  );
});

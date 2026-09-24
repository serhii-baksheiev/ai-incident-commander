/**
 * AIC-56, slice B — the half that needs a real database: atomic claim under
 * concurrency, `FOR UPDATE SKIP LOCKED` actually excluding a row a concurrent
 * transaction holds, the sweeper reclaiming an expired lease, lease renewal
 * losing authority, bounded attempts moving a run to `failed`, and the
 * database's own CHECK enforcing decision 4 ("waiting for a human owns no
 * worker") independently of anything the store's TypeScript ever does.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/postgres-checkpointer.live.mjs`:
 *
 * ## Why this file is not under `test/`
 *
 * Measured on node 22.23.2: `node --test` with no paths treats every `.mjs`
 * under a directory named `test` as a test file — not only `*.test.mjs`. A
 * database-dependent file placed at `test/infra/…` would therefore join
 * `npm test`, and through it `npm run check`. So it lives here, on its own
 * line — the same separation `test/postgres-checkpointer.test.mjs` › "keeps
 * the database-backed lane out of npm test and npm run check" already proves
 * for every file matching `infra/postgres/tests/*.live.mjs`, this one
 * included; that assertion is not duplicated here.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## It refuses; it never skips
 *
 * With no connection string every row here FAILS, loudly, saying what to
 * start. A skip would report green for a lane that ran nothing, and the rows
 * below are the ones nothing else can cover — a green skip would mean "the run
 * store's concurrency semantics are proven" while proving nothing.
 *
 * ## Independent verification
 *
 * Where a row says "verified independently of the store", it queries
 * `store.pool` directly with raw SQL rather than through the store's own
 * `getRun`/`claimNext` methods — the same arrangement
 * `postgres-checkpointer.live.mjs` › "creates the checkpointer tables in their
 * own schema, beside the application schema" uses `checkpointer.pool.query`
 * for. The store's domain methods are exactly what is under test, so a check
 * that also went through them could not tell "the store thinks it succeeded"
 * from "it actually happened in the database".
 *
 * ## Isolation between rows
 *
 * Every row truncates `aic_app.runs` before it starts (`freshStore` below) —
 * `schema_migrations` is left alone, so the schema stays provisioned across
 * rows the same way `postgres-checkpointer.live.mjs`'s `provisioned()` treats
 * `setup()` as safe to call repeatedly.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place the run store's
concurrent-claim, sweep, renewal and bounded-attempt rows are measured against
a real PostgreSQL, so a skip would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * `aic_app.runs` truncated so this row starts from no rows at all, and the
 * pool closed at the end of the row.
 */
async function freshStore(t, options = DEFAULT_OPTIONS) {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const store = await persistence.createRunStore(connectionString, options);
  t.after(async () => {
    await store.close();
  });
  await store.pool.query('truncate table aic_app.runs');
  return store;
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  // See postgres-checkpointer.live.mjs's row of the same name for why the raw
  // value is never the assertion's subject: printing it risks pasting a
  // credential into a journal or PR body.
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 8 — setupApplicationSchema is idempotent                               */
/* -------------------------------------------------------------------------- */

test('setupApplicationSchema is idempotent, and assertApplicationSchemaVersion then matches', async (t) => {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  await persistence.setupApplicationSchema(connectionString);

  const store = await persistence.createRunStore(connectionString, DEFAULT_OPTIONS);
  t.after(() => store.close());

  await assert.doesNotReject(
    () => persistence.assertApplicationSchemaVersion(store.pool),
    'after two applications the application schema must report exactly APP_SCHEMA_VERSION, or the migration runner is not idempotent',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 9a — N queued runs, K concurrent store instances, each run claimed     */
/* exactly once, verified independently of the store                         */
/* -------------------------------------------------------------------------- */

test('N queued runs are each claimed exactly once across N concurrent store instances', async (t) => {
  const store = await freshStore(t);
  const runIds = Array.from({ length: 6 }, () => `run-concurrent-${randomUUID()}`);
  for (const runId of runIds) {
    await store.createRun({ runId, input: { runId } });
  }

  const workers = await Promise.all(
    runIds.map(() => persistence.createRunStore(requireConnectionString(), DEFAULT_OPTIONS)),
  );
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
  });

  const claims = await Promise.all(workers.map((worker, index) => worker.claimNext(`worker-${index}`)));

  for (const claim of claims) {
    assert.notEqual(claim, null, 'every one of N concurrent claimNext calls against N queued runs must claim something, not lose a run to contention');
  }
  assert.equal(
    new Set(claims.map((claim) => claim.runId)).size,
    runIds.length,
    'no two concurrent claims may return the same runId: each run must be claimed exactly once',
  );
  for (const claim of claims) {
    assert.equal(claim.executionAttempt, 1, `${claim.runId} must be claimed with executionAttempt 1, its first attempt`);
  }

  // Verified independently of the store: raw SQL against the table, not the
  // store's own getRun.
  const { rows } = await store.pool.query(
    `select run_id, status, owner_worker_id, execution_attempt from aic_app.runs where run_id = any($1::text[]) order by run_id`,
    [runIds],
  );
  assert.equal(rows.length, runIds.length);
  for (const row of rows) {
    const claim = claims.find((candidate) => candidate.runId === row.run_id);
    assert.ok(claim, `${row.run_id} must appear among the claims claimNext returned`);
    assert.equal(row.status, 'running', `${row.run_id} must be running in the database after being claimed`);
    assert.equal(Number(row.execution_attempt), 1);
    assert.equal(
      row.owner_worker_id,
      claim.ownerWorkerId,
      `the owner_worker_id column for ${row.run_id} must match the ownerWorkerId claimNext returned`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Row 9b — claimNext skips a row a concurrent transaction holds with          */
/* FOR UPDATE, deterministically                                              */
/* -------------------------------------------------------------------------- */

test('claimNext skips a row a concurrent transaction already holds with FOR UPDATE, and returns the next queued run', async (t) => {
  const store = await freshStore(t);
  const older = `run-lock-older-${randomUUID()}`;
  const newer = `run-lock-newer-${randomUUID()}`;

  await store.createRun({ runId: older, input: {} });
  // Force a deterministic queue order: `older` must be claimed before `newer`
  // in the absence of the lock below.
  await store.pool.query(`update aic_app.runs set created_at = created_at - interval '1 hour' where run_id = $1`, [
    older,
  ]);
  await store.createRun({ runId: newer, input: {} });

  // Released inside this test's own finally, not through `t.after`: the hooks
  // run in registration order, so a release queued after `freshStore`'s
  // `store.close()` would wait behind `pool.end()`, which waits for this very
  // client — the lane hangs rather than fails.
  const lockClient = await store.pool.connect();
  await lockClient.query('begin');
  const { rows: lockedRows } = await lockClient.query('select run_id from aic_app.runs where run_id = $1 for update', [
    older,
  ]);
  assert.equal(lockedRows[0]?.run_id, older, 'the test\'s own client must hold the lock on the older row before claimNext runs, or this row proves nothing');

  try {
    const claim = await store.claimNext('worker-skip-locked');
    assert.notEqual(claim, null, 'claimNext must not return null: the newer run is queued and unlocked');
    assert.equal(
      claim.runId,
      newer,
      'claimNext must SKIP the row a concurrent transaction holds with FOR UPDATE and claim the next queued run instead of blocking on it',
    );
  } finally {
    await lockClient.query('rollback');
    lockClient.release();
  }
});

/* -------------------------------------------------------------------------- */
/* sweepExpired's FOR UPDATE SKIP LOCKED skips a row a concurrent           */
/* transaction holds with a conflicting lock, and the next sweep reclaims it */
/* once that lock is released (AIC-57: the T-4 harness retries its sweep)    */
/* -------------------------------------------------------------------------- */

test('a sweep skips an expired run another transaction holds a row lock on, and the next sweep reclaims it', async (t) => {
  const store = await freshStore(t);
  const runId = `run-sweep-skip-locked-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext('worker-lock-holder');
  assert.equal(claim.runId, runId);

  // A separate client, in its own uncommitted transaction, holds FOR KEY
  // SHARE on the run's row. FOR KEY SHARE does not conflict with the FOR NO
  // KEY UPDATE lock this test's own UPDATE of lease_expires_at takes below,
  // but it DOES conflict with sweepExpired's inner `FOR UPDATE SKIP LOCKED` —
  // so the sweep must skip this row while the lock is held.
  const lockClient = await store.pool.connect();

  try {
    await lockClient.query('begin');
    const { rows: lockedRows } = await lockClient.query(
      'select run_id from aic_app.runs where run_id = $1 for key share',
      [runId],
    );
    assert.equal(
      lockedRows[0]?.run_id,
      runId,
      'the test\'s own client must hold the FOR KEY SHARE lock before the lease is expired, or this row proves nothing',
    );
    await store.pool.query(
      `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
      [runId],
    );

    const firstSweep = await store.sweepExpired();
    assert.deepEqual(
      firstSweep,
      [],
      'sweepExpired must SKIP a row a concurrent transaction holds with FOR KEY SHARE, rather than blocking on it or reclaiming it out from under the lock holder',
    );
  } finally {
    try {
      await lockClient.query('commit');
    } finally {
      lockClient.release();
    }
  }

  const secondSweep = await store.sweepExpired();
  assert.deepEqual(
    secondSweep,
    [runId],
    'once the lock is released, the very next sweepExpired call must reclaim the run the first sweep had to skip',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 10 — nothing queued returns null; a claimed run cannot be claimed again */
/* -------------------------------------------------------------------------- */

test('a second sequential claimNext with nothing queued returns null, and a claimed run cannot be claimed again', async (t) => {
  const store = await freshStore(t);
  const runId = `run-single-${randomUUID()}`;
  await store.createRun({ runId, input: {} });

  const first = await store.claimNext('worker-a');
  assert.equal(first?.runId, runId, 'the only queued run must be claimed');

  const second = await store.claimNext('worker-b');
  assert.equal(
    second,
    null,
    'the run is already running and nothing else is queued: a second claimNext must return null rather than reclaiming it',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 11 — sweepExpired requeues an expired lease and bumps recovery_count   */
/* -------------------------------------------------------------------------- */

test('sweepExpired requeues a run whose lease has expired, clearing owner and lease and incrementing recovery_count, and the next claim starts attempt 2', async (t) => {
  const store = await freshStore(t);
  const runId = `run-sweep-${randomUUID()}`;
  await store.createRun({ runId, input: {} });

  const claim = await store.claimNext('worker-a');
  assert.equal(claim.runId, runId);
  assert.equal(claim.executionAttempt, 1);

  // Force the lease to expire with test-side SQL — no sleeps.
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );

  const swept = await store.sweepExpired();
  assert.deepEqual(swept, [runId], 'sweepExpired must return exactly the run whose lease expired');

  const { rows } = await store.pool.query(
    'select status, owner_worker_id, lease_expires_at, recovery_count from aic_app.runs where run_id = $1',
    [runId],
  );
  assert.deepEqual(
    {
      status: rows[0].status,
      ownerWorkerId: rows[0].owner_worker_id,
      leaseExpiresAt: rows[0].lease_expires_at,
      recoveryCount: Number(rows[0].recovery_count),
    },
    { status: 'queued', ownerWorkerId: null, leaseExpiresAt: null, recoveryCount: 1 },
    'a swept run must be queued again with its owner and lease cleared and recovery_count incremented',
  );

  const reclaimed = await store.claimNext('worker-b');
  assert.equal(reclaimed?.runId, runId);
  assert.equal(reclaimed.executionAttempt, 2, 'the claim after a sweep must be a second execution attempt, not a repeat of the first');
});

/* -------------------------------------------------------------------------- */
/* Row 12 — renewLease: true for the current owner, false once authority is   */
/* lost, false for a mismatched worker id                                    */
/* -------------------------------------------------------------------------- */

test('renewLease returns true for the current owner, false for a mismatched worker id, and false once a sweep and reclaim have moved authority elsewhere', async (t) => {
  const store = await freshStore(t);
  const runId = `run-renew-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext('worker-a');

  assert.equal(
    await store.renewLease(claim),
    true,
    'the current owner, with a matching executionAttempt and an unexpired lease, must be able to renew',
  );

  assert.equal(
    await store.renewLease({ ...claim, ownerWorkerId: 'not-the-owner' }),
    false,
    'a mismatched worker id must not renew the lease, even for the same runId and executionAttempt',
  );

  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  await store.sweepExpired();
  const secondClaim = await store.claimNext('worker-b');
  assert.equal(secondClaim.runId, runId);
  assert.equal(secondClaim.executionAttempt, 2);

  assert.equal(
    await store.renewLease(claim),
    false,
    'the original claim\'s executionAttempt (1) no longer matches the run\'s current executionAttempt (2) after the sweep and reclaim: authority was lost, and renewLease must say so rather than extend a lease that is no longer this worker\'s to hold',
  );
});

/* -------------------------------------------------------------------------- */
/* Lease expiry and heartbeats                                                 */
/* -------------------------------------------------------------------------- */

test('renewLease refuses a lease that has already expired, even before any sweep has requeued the run', async (t) => {
  const store = await freshStore(t);
  const runId = `run-renew-expired-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext('worker-expired');
  assert.equal(claim?.runId, runId);

  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  assert.equal(
    await store.renewLease(claim),
    false,
    'an expired lease is lost authority (decision 3): renewing it would let a worker revive itself after another could have taken over',
  );
});

test('a claim records a heartbeat, and each renewal moves it forward', async (t) => {
  const store = await freshStore(t);
  const runId = `run-heartbeat-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext('worker-heartbeat');
  const heartbeatOf = async () =>
    (await store.pool.query('select heartbeat_at from aic_app.runs where run_id = $1', [runId])).rows[0].heartbeat_at;

  const first = await heartbeatOf();
  assert.ok(first instanceof Date, 'the claim must set heartbeat_at');
  await store.pool.query(
    `update aic_app.runs set heartbeat_at = heartbeat_at - interval '1 minute' where run_id = $1`,
    [runId],
  );
  const aged = await heartbeatOf();
  assert.equal(await store.renewLease(claim), true);
  const renewed = await heartbeatOf();
  assert.ok(renewed > aged, 'a renewal must move heartbeat_at forward');
  assert.deepEqual(
    (await store.getRun(runId)).heartbeatAt,
    renewed,
    'getRun must report the heartbeat the store maintains',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 13 — bounded attempts: exhaustion moves the run to failed              */
/* -------------------------------------------------------------------------- */

test('bounded attempts: once the next attempt would exceed maxExecutionAttempts, the run becomes failed with terminal_reason recovery_exhausted', async (t) => {
  const store = await freshStore(t, { leaseMs: 30_000, maxExecutionAttempts: 2 });
  const runId = `run-exhaust-${randomUUID()}`;
  await store.createRun({ runId, input: {} });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claim = await store.claimNext(`worker-attempt-${attempt}`);
    assert.equal(claim?.runId, runId, `attempt ${attempt} must claim the run`);
    assert.equal(claim.executionAttempt, attempt, `attempt ${attempt} must report executionAttempt ${attempt}`);

    await store.pool.query(
      `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
      [runId],
    );
    const swept = await store.sweepExpired();
    assert.deepEqual(swept, [runId], `attempt ${attempt}'s lease must be swept back to queued so the next attempt can be claimed`);
  }

  const exhausted = await store.claimNext('worker-attempt-3');
  assert.equal(
    exhausted,
    null,
    'a third attempt would exceed maxExecutionAttempts (2): claimNext must not hand the run out again',
  );

  const { rows } = await store.pool.query('select status, terminal_reason from aic_app.runs where run_id = $1', [
    runId,
  ]);
  assert.deepEqual(
    { status: rows[0].status, terminalReason: rows[0].terminal_reason },
    { status: 'failed', terminalReason: 'recovery_exhausted' },
    'the run must move queued->failed with terminal_reason recovery_exhausted once its bounded attempts are used up (docs/decisions/durable-run-execution.md, decision 13 and the Run lifecycle table\'s queued->failed row)',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 14 — the database's own CHECK enforces decision 4, independent of the  */
/* store's TypeScript                                                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Row 13 (AIC-56 slice C carry-over) — N exhausted runs and nothing          */
/* claimable: claimNext returns null and leaves all N failed/recovery_exhausted */
/* -------------------------------------------------------------------------- */

test('claimNext with N exhausted runs and nothing claimable returns null and leaves all N failed with recovery_exhausted', async (t) => {
  const store = await freshStore(t, { leaseMs: 30_000, maxExecutionAttempts: 2 });
  const runIds = Array.from({ length: 5 }, () => `run-all-exhausted-${randomUUID()}`);
  for (const runId of runIds) await store.createRun({ runId, input: {} });
  await store.pool.query(`update aic_app.runs set execution_attempt = 2 where run_id = any($1::text[])`, [runIds]);

  const claimed = await store.claimNext('worker-all-exhausted');
  assert.equal(
    claimed,
    null,
    'with N queued runs all already at maxExecutionAttempts and nothing else queued, claimNext must fail every one of them (its own loop-termination comment) and return null rather than looping forever or claiming one',
  );

  const { rows } = await store.pool.query(
    `select run_id, status, terminal_reason from aic_app.runs where run_id = any($1::text[]) order by run_id`,
    [runIds],
  );
  assert.equal(rows.length, runIds.length);
  for (const row of rows) {
    assert.deepEqual(
      { status: row.status, terminalReason: row.terminal_reason },
      { status: 'failed', terminalReason: 'recovery_exhausted' },
      `${row.run_id} must have been failed with recovery_exhausted by the single claimNext call that found nothing claimable`,
    );
  }
});

test('exhausted runs at the head of the queue do not hide claimable work behind a null', async (t) => {
  const store = await freshStore(t, { leaseMs: 30_000, maxExecutionAttempts: 2 });
  const exhaustedA = `run-exhausted-a-${randomUUID()}`;
  const exhaustedB = `run-exhausted-b-${randomUUID()}`;
  const fresh = `run-fresh-${randomUUID()}`;
  for (const runId of [exhaustedA, exhaustedB, fresh]) await store.createRun({ runId, input: {} });
  await store.pool.query(
    `update aic_app.runs set execution_attempt = 2, created_at = created_at - interval '1 hour' where run_id = any($1)`,
    [[exhaustedA, exhaustedB]],
  );

  const claim = await store.claimNext('worker-behind-exhausted');
  assert.equal(
    claim?.runId,
    fresh,
    'a null from claimNext must mean nothing is claimable; failing an exhausted run is not a reason to hand back null while a fresh run waits',
  );
  const { rows } = await store.pool.query(
    'select run_id, status, terminal_reason from aic_app.runs where run_id = any($1) order by run_id',
    [[exhaustedA, exhaustedB]],
  );
  assert.deepEqual(
    rows.map((row) => [row.status, row.terminal_reason]),
    [
      ['failed', 'recovery_exhausted'],
      ['failed', 'recovery_exhausted'],
    ],
  );
});

test('the database rejects a waiting_human row with an owner or lease, and a running row without them', async (t) => {
  const store = await freshStore(t);

  await assert.rejects(
    () =>
      store.pool.query(
        `insert into aic_app.runs (run_id, status, input, owner_worker_id, lease_expires_at)
         values ($1, 'waiting_human', '{}'::jsonb, 'worker-x', clock_timestamp() + interval '1 minute')`,
        [`run-check-waiting-${randomUUID()}`],
      ),
    /check/i,
    'a waiting_human row with an owner and a lease must violate the runs table\'s CHECK constraint: decision 4 says waiting_human holds no lease, as a database rule and not only as application discipline',
  );

  await assert.rejects(
    () =>
      store.pool.query(`insert into aic_app.runs (run_id, status, input) values ($1, 'running', '{}'::jsonb)`, [
        `run-check-running-${randomUUID()}`,
      ]),
    /check/i,
    'a running row with no owner and no lease must violate the runs table\'s CHECK constraint: running always holds a lease',
  );
});

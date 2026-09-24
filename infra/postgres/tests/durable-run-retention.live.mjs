/**
 * AIC-56 slice F (the last slice) — the half that needs a real database of
 * the two remaining acceptance rows:
 *
 *   - "node_results is not readable through product API/UI paths." There is
 *     no product API yet (AIC-43, v1.0); the stand-in this row measures is a
 *     read model, `readRunProductSnapshot(pool | store, runId)`, that returns
 *     the run's status/terminal reason/interaction id, its projected trials
 *     and evidence (`run_trials`, `run_evidence`, parsed back to domain
 *     objects) and its `run_events` — and NEVER reads `node_results`.
 *   - "Retention guards refuse pruning for non-terminal runs; terminal
 *     pruning leaves product API state unchanged." `pruneTerminalRun(store,
 *     runId, { checkpointer })`: locks the run row (`FOR UPDATE`); refuses
 *     (a named error) unless the status is `completed` or `failed`; for a
 *     terminal run deletes its `node_results` and calls
 *     `checkpointer.deleteThread(runId)`.
 *
 * Neither function exists yet — every row below is expected to fail today,
 * either on `typeof persistence.readRunProductSnapshot !== 'function'` /
 * `typeof persistence.pruneTerminalRun !== 'function'`, or (row 9) on the
 * PostgreSQL locking behaviour a not-yet-written implementation cannot
 * exhibit.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/run-write-context.live.mjs` and
 * `infra/postgres/tests/fenced-checkpointer.live.mjs` — see those files'
 * headers for "why this file is not under `test/`", "it refuses; it never
 * skips", and "independent verification" (raw SQL against `store.pool`, and
 * an UNFENCED `PostgresSaver`, rather than the functions under test). Not
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
 * ## Design choices this file assumes — none of these shapes is chosen yet
 *
 *   - `pruneTerminalRun`'s refusal for a non-terminal run is a NAMED error,
 *     `persistence.RunNotTerminalError` — this file's own choice of name;
 *     `test/durable-run-boundaries.test.mjs`'s export-list pin does not
 *     include it yet, precisely because it does not exist. A different name
 *     is a fine implementation choice — say so in the PR description.
 *   - `readRunProductSnapshot(pool | store, runId)` returns:
 *     `{ runId, status, terminalReason, interactionId, trials, evidence,
 *     events }` — `trials`/`evidence` are the domain `Trial`/`Evidence`
 *     objects `run_trials.body` / `run_evidence.body` parse back into
 *     (`@aic/domain`'s `TrialSchema`/`EvidenceSchema`); `events` is
 *     `run_events` projected as `{ seq, type, executionAttempt, payload }`,
 *     in ascending `seq` order. This file does not assert an order on
 *     `trials`/`evidence` beyond what a caller can already recover by
 *     sorting on the domain object's own `id` — it sorts both sides before
 *     comparing, so the implementation is free to return either order.
 *   - `pruneTerminalRun` takes an already-open `checkpointer` (an unfenced
 *     `createPostgresCheckpointer` instance is what every row here passes)
 *     and calls `checkpointer.deleteThread(runId)` — `runId` IS the
 *     checkpointer's `thread_id`, the same identification every other
 *     AIC-56 slice uses (see `fenced-checkpointer.live.mjs`'s
 *     `buildTrivialGraph` / `threadConfig`).
 *
 * If the implementation shapes any of these differently, that reason belongs
 * in the PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place pruneTerminalRun
and readRunProductSnapshot are measured against a real PostgreSQL, so a skip
would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this slice touches truncated, and the pool closed at the end of
 * the row — copied from run-write-context.live.mjs's own `freshStore`.
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

/** Creates one queued run and claims it, asserting the claim actually landed. */
async function createAndClaim(store, workerId) {
  const runId = `run-retention-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext(workerId);
  assert.equal(claim?.runId, runId, 'createAndClaim helper must actually claim the run it just created');
  return { runId, claim };
}

/** The checkpointer schema, provisioned once per row — copied from fenced-checkpointer.live.mjs. */
async function provisionCheckpointerSchema() {
  const setupSaver = await persistence.createPostgresCheckpointer(requireConnectionString());
  await setupSaver.setup();
  await setupSaver.pool.end();
}

/** An UNFENCED checkpointer, with its pool closed at the end of the row — the oracle every row here reads checkpoint state through. */
async function checkpointerFor(t) {
  const checkpointer = await persistence.createPostgresCheckpointer(requireConnectionString());
  t.after(async () => {
    await checkpointer.pool.end();
  });
  return checkpointer;
}

/** Writes one checkpoint for `runId`'s thread directly through the checkpointer — no graph needed for these rows. */
async function writeCheckpoint(checkpointer, runId) {
  const config = { configurable: { thread_id: runId } };
  await checkpointer.put(config, emptyCheckpoint(), { source: 'update', step: -1, parents: {} }, {});
  return config;
}

/** Inserts one node_results row directly, independent of a fenced `committed()` call — the setup this file's refusal rows need for statuses `committed()` cannot even be attempted against (queued has no claim at all). */
async function insertNodeResult(store, runId, execKey) {
  await store.pool.query(
    `insert into aic_app.node_results (run_id, exec_key, op, input_sha, result_json, result_sha, produced_by_attempt)
     values ($1, $2, 'tool.trial', null, '{"v":1}', 'deadbeef', 1)`,
    [runId, execKey],
  );
}

/** A domain `Trial` the way the graph builds one — copied from run-write-context.live.mjs. */
const domainTrial = (id, runId, evidenceIds = []) => ({
  id,
  runId,
  testId: `test-of-${id}`,
  attempt: 1,
  tool: 'logs.search',
  input: { query: 'error' },
  status: 'ok',
  durationMs: 5,
  evidenceIds,
});

/** A domain `Evidence` the way the graph builds one — copied from run-write-context.live.mjs. */
const domainEvidence = (id, trialId) => ({
  id,
  trialId,
  kind: 'log',
  source: 'fixture',
  observedAt: '2026-09-24T00:00:00.000Z',
  statement: 'an error was logged',
  rawRef: `raw-${id}`,
});

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6 — pruneTerminalRun refuses queued, running and waiting_human, and    */
/* leaves node_results and the checkpoint thread untouched                   */
/* -------------------------------------------------------------------------- */

test('pruneTerminalRun refuses a run in queued, running or waiting_human, and leaves node_results and the checkpoint thread untouched', async (t) => {
  await provisionCheckpointerSchema();
  const store = await freshStore(t);
  const checkpointer = await checkpointerFor(t);

  assert.equal(
    typeof persistence.pruneTerminalRun,
    'function',
    '@aic/persistence must export pruneTerminalRun(store, runId, { checkpointer }) — AIC-56 slice F, the retention guard the "Retention guards refuse pruning for non-terminal runs" acceptance row asks for',
  );

  const scenarios = [
    {
      status: 'queued',
      async prepare(workerId) {
        const runId = `run-retention-queued-${randomUUID()}`;
        await store.createRun({ runId, input: {} });
        return runId;
      },
    },
    {
      status: 'running',
      async prepare(workerId) {
        const { runId } = await createAndClaim(store, workerId);
        return runId;
      },
    },
    {
      status: 'waiting_human',
      async prepare(workerId) {
        const { runId, claim } = await createAndClaim(store, workerId);
        const context = await persistence.openRunWriteContext(store, claim);
        await context.markWaitingHuman(`interaction-${runId}`);
        return runId;
      },
    },
  ];

  for (const scenario of scenarios) {
    const runId = await scenario.prepare(`worker-retention-${scenario.status}`);
    const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'retention-refusal', trialAttempt: 1 });
    await insertNodeResult(store, runId, execKey);
    const threadConfig = await writeCheckpoint(checkpointer, runId);

    await assert.rejects(
      () => persistence.pruneTerminalRun(store, runId, { checkpointer }),
      (error) => error?.name === 'RunNotTerminalError',
      `pruneTerminalRun must refuse a run whose status is "${scenario.status}" with a named error (RunNotTerminalError)`,
    );

    const { rows: statusRows } = await store.pool.query('select status from aic_app.runs where run_id = $1', [runId]);
    assert.equal(statusRows[0].status, scenario.status, `sanity: run ${runId} must still be "${scenario.status}" after the refusal`);

    const { rows: resultRows } = await store.pool.query(
      'select 1 from aic_app.node_results where run_id = $1 and exec_key = $2',
      [runId, execKey],
    );
    assert.equal(resultRows.length, 1, `a refused prune of a "${scenario.status}" run must leave its node_results row untouched`);

    const tuple = await checkpointer.getTuple(threadConfig);
    assert.ok(tuple, `a refused prune of a "${scenario.status}" run must leave its checkpoint thread untouched (an unfenced PostgresSaver still finds a tuple)`);
  }
});

/* -------------------------------------------------------------------------- */
/* Row 7 — terminal pruning deletes node_results and the checkpoint thread,  */
/* and leaves the product API snapshot unchanged, for completed and failed  */
/* -------------------------------------------------------------------------- */

for (const [finish, status] of [
  [(context) => context.complete('done'), 'completed'],
  [(context) => context.fail('boom'), 'failed'],
]) {
  test(`pruneTerminalRun on a ${status} run deletes node_results and the checkpoint thread, and leaves the product API snapshot unchanged`, async (t) => {
    await provisionCheckpointerSchema();
    const store = await freshStore(t);
    const checkpointer = await checkpointerFor(t);

    assert.equal(
      typeof persistence.readRunProductSnapshot,
      'function',
      '@aic/persistence must export readRunProductSnapshot(pool | store, runId) — the read-model stand-in for the product API this row needs to compare before and after a prune',
    );

    const { runId, claim } = await createAndClaim(store, `worker-retention-${status}`);
    const context = await persistence.openRunWriteContext(store, claim);

    const trialId = `trial-retention-${status}`;
    const evidenceId = `evidence-retention-${status}`;
    const trial = domainTrial(trialId, runId, [evidenceId]);
    const evidence = domainEvidence(evidenceId, trialId);
    const project = () => ({ trials: [trial], evidence: [evidence] });
    const execKey = domain.buildExecKey('tool.trial', { runId, testId: `retention-${status}`, trialAttempt: 1 });
    await context.committed(execKey, async () => ({ observed: 'ok' }), { project });

    await finish(context);
    const threadConfig = await writeCheckpoint(checkpointer, runId);

    const { rows: beforeResultRows } = await store.pool.query(
      'select 1 from aic_app.node_results where run_id = $1',
      [runId],
    );
    assert.equal(beforeResultRows.length, 1, `sanity: the committed node result must exist before pruning ${status} run ${runId}`);
    const beforeTuple = await checkpointer.getTuple(threadConfig);
    assert.ok(beforeTuple, `sanity: the checkpoint thread must exist before pruning ${status} run ${runId}`);

    const before = await persistence.readRunProductSnapshot(store, runId);

    await persistence.pruneTerminalRun(store, runId, { checkpointer });

    const after = await persistence.readRunProductSnapshot(store, runId);
    assert.deepEqual(
      after,
      before,
      `pruning a terminal (${status}) run must leave the product API snapshot byte-for-byte unchanged: the snapshot never reads node_results or the checkpoint thread, so deleting either must not move it`,
    );

    const { rows: afterResultRows } = await store.pool.query(
      'select 1 from aic_app.node_results where run_id = $1',
      [runId],
    );
    assert.deepEqual(afterResultRows, [], `pruneTerminalRun must delete every node_results row for the pruned ${status} run`);

    const afterTuple = await checkpointer.getTuple(threadConfig);
    assert.equal(afterTuple, undefined, `pruneTerminalRun must delete the checkpoint thread for the pruned ${status} run (checkpointer.deleteThread(runId))`);
  });
}

/* -------------------------------------------------------------------------- */
/* Row 8 — readRunProductSnapshot: domain trials/evidence, events in seq     */
/* order, the run's own status — and never reads node_results               */
/* -------------------------------------------------------------------------- */

test('readRunProductSnapshot returns the projected trials/evidence as domain objects, events in seq order, and the run status', async (t) => {
  await provisionCheckpointerSchema();
  const store = await freshStore(t);

  assert.equal(
    typeof persistence.readRunProductSnapshot,
    'function',
    '@aic/persistence must export readRunProductSnapshot(pool | store, runId)',
  );

  const { runId, claim } = await createAndClaim(store, 'worker-snapshot-shape');
  const context = await persistence.openRunWriteContext(store, claim);

  const trialA = domainTrial('trial-snapshot-a', runId, ['evidence-snapshot-a']);
  const evidenceA = domainEvidence('evidence-snapshot-a', 'trial-snapshot-a');
  const trialB = domainTrial('trial-snapshot-b', runId, ['evidence-snapshot-b']);
  const evidenceB = domainEvidence('evidence-snapshot-b', 'trial-snapshot-b');
  for (const [t2, ev] of [
    [trialA, evidenceA],
    [trialB, evidenceB],
  ]) {
    assert.equal(domain.TrialSchema.safeParse(t2).success, true, 'the fixture must be a valid domain Trial');
    assert.equal(domain.EvidenceSchema.safeParse(ev).success, true, 'the fixture must be a valid domain Evidence');
  }

  await context.committed(
    domain.buildExecKey('tool.trial', { runId, testId: 'snapshot-a', trialAttempt: 1 }),
    async () => ({ observed: 'a' }),
    { project: () => ({ trials: [trialA], evidence: [evidenceA] }) },
  );
  await context.committed(
    domain.buildExecKey('tool.trial', { runId, testId: 'snapshot-b', trialAttempt: 1 }),
    async () => ({ observed: 'b' }),
    { project: () => ({ trials: [trialB], evidence: [evidenceB] }) },
  );
  await context.complete('all done');

  const snapshot = await persistence.readRunProductSnapshot(store, runId);

  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.status, 'completed', "the snapshot's status must be the run's current status");
  assert.equal(snapshot.terminalReason, 'all done', "the snapshot's terminalReason must be what complete() stored");

  assert.deepEqual(
    [...snapshot.trials].sort(byId),
    [trialA, trialB].sort(byId),
    'the snapshot must return the projected trials as domain objects equal to what project() wrote — this file sorts both sides by id, so the implementation may return either order',
  );
  assert.deepEqual(
    [...snapshot.evidence].sort(byId),
    [evidenceA, evidenceB].sort(byId),
    'the snapshot must return the projected evidence as domain objects equal to what project() wrote',
  );

  assert.ok(Array.isArray(snapshot.events), 'the snapshot must expose run_events as an array');
  const eventTypes = snapshot.events.map((event) => event.type);
  assert.deepEqual(
    eventTypes,
    ['node_result.committed', 'node_result.committed', 'run.completed'],
    'the snapshot must expose run_events in ascending seq order: two commits, then the completion',
  );
  const seqs = snapshot.events.map((event) => event.seq);
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `the snapshot's events must be strictly increasing by seq: ${seqs[i - 1]} then ${seqs[i]}`);
  }
});

test('readRunProductSnapshot never reads node_results: a tampered node_results row yields an identical snapshot', async (t) => {
  await provisionCheckpointerSchema();
  const store = await freshStore(t);

  assert.equal(
    typeof persistence.readRunProductSnapshot,
    'function',
    '@aic/persistence must export readRunProductSnapshot(pool | store, runId)',
  );

  const { runId, claim } = await createAndClaim(store, 'worker-snapshot-tamper');
  const context = await persistence.openRunWriteContext(store, claim);
  const trialId = 'trial-snapshot-tamper';
  const evidenceId = 'evidence-snapshot-tamper';
  const trial = domainTrial(trialId, runId, [evidenceId]);
  const evidence = domainEvidence(evidenceId, trialId);
  await context.committed(
    domain.buildExecKey('tool.trial', { runId, testId: 'snapshot-tamper', trialAttempt: 1 }),
    async () => ({ observed: 'ok' }),
    { project: () => ({ trials: [trial], evidence: [evidence] }) },
  );

  const before = await persistence.readRunProductSnapshot(store, runId);

  // Tampered into text that is not even valid JSON: if readRunProductSnapshot
  // ever read and parsed node_results, this would throw rather than merely
  // differ, so a passing row here is not a coincidence of the tampered value
  // happening to look like something harmless.
  await store.pool.query(
    `update aic_app.node_results set result_json = 'NOT VALID JSON AT ALL', result_sha = 'deadbeef' where run_id = $1`,
    [runId],
  );

  const after = await persistence.readRunProductSnapshot(store, runId);
  assert.deepEqual(
    after,
    before,
    'readRunProductSnapshot must never read node_results: a corrupted node_results row must not change the snapshot at all',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 9 — pruneTerminalRun locks the run row FOR UPDATE and waits rather    */
/* than acting on a status read outside that lock                            */
/* -------------------------------------------------------------------------- */

test('pruneTerminalRun waits for the run row lock rather than acting on a status read outside FOR UPDATE', async (t) => {
  await provisionCheckpointerSchema();
  const store = await freshStore(t);
  const checkpointer = await checkpointerFor(t);
  const { runId, claim } = await createAndClaim(store, 'worker-retention-lock');
  const context = await persistence.openRunWriteContext(store, claim);
  await context.complete('done');

  const lockClient = await store.pool.connect();
  let lockReleased = false;
  try {
    await lockClient.query('begin');
    await lockClient.query('select run_id from aic_app.runs where run_id = $1 for update', [runId]);

    let settled = false;
    const prunePromise = persistence
      .pruneTerminalRun(store, runId, { checkpointer })
      .then(() => {
        settled = true;
      });

    // Give a wrongly-unlocked implementation ample opportunity to finish.
    await delay(500);
    assert.equal(
      settled,
      false,
      'pruneTerminalRun resolved while another transaction still held the run row FOR UPDATE: it must lock the row itself and wait, not read the status outside a lock',
    );

    await lockClient.query('commit');
    lockReleased = true;
    lockClient.release();

    await prunePromise;
    assert.equal(settled, true, 'pruneTerminalRun must proceed once the competing lock is released');
  } finally {
    // Released inside this test's own finally, never via t.after: the same
    // reason run-write-context.live.mjs's "compute runs OUTSIDE any
    // transaction" row gives — t.after hooks run in registration order, and a
    // release queued after freshStore's own store.close() would wait behind
    // pool.end(), which waits for this very client.
    if (!lockReleased) {
      await lockClient.query('rollback');
      lockClient.release();
    }
  }
});

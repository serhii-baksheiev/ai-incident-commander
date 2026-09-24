/**
 * AIC-58, slice a — the half that needs a real database: `run_events` as an
 * append-only product timeline, and `createRunEventStreamSource`'s reconnect
 * contract (`Last-Event-ID = seq`) against a real PostgreSQL — reconnect
 * returns every committed later event exactly once in order, an event is
 * never streamed before its row commits, a process restart does not lose
 * history, `tail` ends when its signal aborts rather than hanging on the next
 * poll, and one run's stream never carries another run's events.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/run-write-context.live.mjs` — see that file's header
 * for "why this file is not under `test/`", "it refuses; it never skips", and
 * "independent verification" (raw SQL against `store.pool`, never through the
 * source under test — not repeated here in full).
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## Design choices this file assumes
 *
 * The ticket names `RunEventStreamSource` (domain, `test/run-event-stream-source-contract.test.mjs`),
 * `createRunEventStreamSource(pool, options?)`, `readAfter(runId, afterSeq, { limit })`
 * and `tail(runId, { lastEventId, signal, pollIntervalMs })`, but not every
 * internal detail. Stated here rather than discovered mid-assertion:
 *
 *   - `createRunEventStreamSource` takes the store's own `pg.Pool` directly —
 *     the same convention `openRunWriteContext(store, claim)` follows for
 *     reusing `store.pool` rather than dialing a second connection, and the
 *     one `retention.ts`'s `poolOf` already generalizes to "a `pg.Pool` or a
 *     `RunStore`". This file passes `store.pool`.
 *   - `readAfter`'s third argument is `{ limit }`, a plain options object,
 *     mirroring `CommittedOptions` in `run-write-context.ts`.
 *   - `tail`'s `lastEventId` option accepts exactly what `@aic/domain`'s
 *     `parseLastEventId` accepts: a non-negative integer OR its decimal
 *     STRING (the shape a real `Last-Event-ID` HTTP header arrives in) — this
 *     file passes a string at the reconnect row, mirroring the header, and a
 *     number `0` everywhere else, mirroring a fresh, never-reconnected client.
 *   - a yielded `RunEvent`'s `runId` field is populated even though a caller
 *     already knows which run they asked for — matching `@aic/domain`'s
 *     `RunEvent` shape pinned in `test/run-event-stream-source-contract.test.mjs`,
 *     and useful precisely for the isolation row below.
 *
 * If the implementation has a reason to shape any of these differently, that
 * reason belongs in the PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place run_events'
append-only durability and the reconnect-safe stream source are measured
against a real PostgreSQL, so a skip would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this row touches truncated, and the pool closed at the end of
 * the row — the same convention `run-write-context.live.mjs`'s `freshStore`
 * uses.
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
  const runId = `run-event-stream-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext(workerId);
  assert.equal(claim?.runId, runId, 'createAndClaim helper must actually claim the run it just created');
  return { runId, claim };
}

/** A project() that writes no projection rows. */
function noProjection() {
  return {};
}

function createRunEventStreamSourceFactory() {
  assert.equal(
    typeof persistence.createRunEventStreamSource,
    'function',
    '@aic/persistence must export createRunEventStreamSource(pool, options?) — implementation 1 of AIC-58: a durable tail/poll RunEventStreamSource over aic_app.run_events, with readAfter(runId, afterSeq, { limit }) and tail(runId, { lastEventId, signal, pollIntervalMs })',
  );
  return persistence.createRunEventStreamSource;
}

/**
 * Appends one `run_events` row on the caller's OWN client, inside whatever
 * transaction that client currently holds (or none, if it is a bare pool
 * query) — mirroring `run-write-context.ts`'s private `nextSeq` + its
 * `appendEvent`'s insert exactly, so this file can control commit/rollback
 * timing directly rather than only through a fenced write. Returns the seq it
 * used.
 */
async function appendEventRaw(client, runId, executionAttempt, type, payload) {
  const { rows } = await client.query(
    `INSERT INTO "${persistence.APPLICATION_SCHEMA}".run_event_counters (run_id, next_seq)
     VALUES ($1, 1)
     ON CONFLICT (run_id) DO UPDATE SET next_seq = "${persistence.APPLICATION_SCHEMA}".run_event_counters.next_seq + 1
     RETURNING next_seq`,
    [runId],
  );
  const seq = Number(rows[0].next_seq);
  await client.query(
    `INSERT INTO "${persistence.APPLICATION_SCHEMA}".run_events (run_id, seq, type, execution_attempt, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [runId, seq, type, executionAttempt, JSON.stringify(payload)],
  );
  return seq;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` until it is true or `timeoutMs` elapses; throws on timeout. */
async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Consumes `source.tail(...)` in the background until aborted, recording
 * every yielded event and (if the iterable ever throws) the error, rather
 * than the caller's own `await` — so the caller can poke state WHILE the tail
 * is live and inspect what has arrived so far.
 */
function backgroundTail(source, runId, options) {
  const controller = new AbortController();
  const collected = [];
  let failure;
  const done = (async () => {
    try {
      for await (const event of source.tail(runId, { ...options, signal: controller.signal })) {
        collected.push(event);
      }
    } catch (error) {
      failure = error;
    }
  })();
  return {
    controller,
    collected,
    done,
    assertNoFailure() {
      assert.equal(failure, undefined, `tail() must not throw: ${failure?.stack ?? failure}`);
    },
  };
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
/* Row 1 — reconnect: Last-Event-ID = seq returns every later event exactly   */
/* once, in order, at the API abstraction boundary                           */
/* -------------------------------------------------------------------------- */

test(
  'reconnecting with Last-Event-ID = the last seq seen (as the header string) returns exactly the later committed events, once each, in order',
  { timeout: 20_000 },
  async (t) => {
    const store = await freshStore(t);
    const { runId, claim } = await createAndClaim(store, 'worker-reconnect');
    const context = await persistence.openRunWriteContext(store, claim);

    const total = 5;
    for (let i = 0; i < total; i += 1) {
      const execKey = domain.buildExecKey('tool.trial', { runId, testId: `reconnect-${i}`, trialAttempt: 1 });
      await context.committed(execKey, async () => ({ i }), { project: noProjection });
    }

    // Independent oracle: the test's own SQL, never the source under test.
    const { rows: allRows } = await store.pool.query(
      'select seq, type, execution_attempt, payload from aic_app.run_events where run_id = $1 order by seq',
      [runId],
    );
    assert.equal(allRows.length, total, 'the fixture must actually have produced one event per commit, or this row proves nothing');

    const source = createRunEventStreamSourceFactory()(store.pool);

    // "Consume some": tail from the very start and stop after the first two.
    const consumeCount = 2;
    const firstSeen = [];
    const firstController = new AbortController();
    for await (const event of source.tail(runId, { lastEventId: 0, signal: firstController.signal, pollIntervalMs: 20 })) {
      firstSeen.push(event);
      if (firstSeen.length >= consumeCount) {
        firstController.abort();
        break;
      }
    }
    assert.equal(firstSeen.length, consumeCount);
    const lastSeenSeq = firstSeen[firstSeen.length - 1].seq;
    assert.equal(lastSeenSeq, Number(allRows[consumeCount - 1].seq));

    // "Disconnect, reconnect": a NEW tail call, Last-Event-ID passed as the
    // SSE header sends it — a decimal STRING, not a number.
    const rest = [];
    const secondController = new AbortController();
    for await (const event of source.tail(runId, {
      lastEventId: String(lastSeenSeq),
      signal: secondController.signal,
      pollIntervalMs: 20,
    })) {
      rest.push(event);
      if (rest.length >= total - consumeCount) {
        secondController.abort();
        break;
      }
    }

    assert.deepEqual(
      rest.map((event) => event.seq),
      allRows.slice(consumeCount).map((row) => Number(row.seq)),
      'reconnecting with Last-Event-ID = the last seq seen must return exactly the later events, once each, in order — never re-delivering an already-seen event and never skipping one',
    );
    for (const [index, event] of rest.entries()) {
      const expectedRow = allRows[consumeCount + index];
      assert.equal(event.runId, runId);
      assert.equal(event.type, expectedRow.type);
      assert.equal(event.executionAttempt, Number(expectedRow.execution_attempt));
      assert.deepEqual(event.payload, expectedRow.payload);
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Row 2 — an event is never streamed before its row commits; a rolled-back  */
/* write leaves no gap once a later commit reuses its seq                    */
/* -------------------------------------------------------------------------- */

test(
  'tail yields nothing for an open transaction\'s row, yields it once committed, and a rolled-back write\'s seq is reused with no gap or duplicate',
  { timeout: 20_000 },
  async (t) => {
    const store = await freshStore(t);
    const runId = `run-event-stream-durability-${randomUUID()}`;
    await store.createRun({ runId, input: {} });
    const source = createRunEventStreamSourceFactory()(store.pool);

    const bg = backgroundTail(source, runId, { lastEventId: 0, pollIntervalMs: 20 });
    t.after(async () => {
      bg.controller.abort();
      await bg.done;
    });

    // A separate client holds an open transaction that has already appended
    // an event row — driven with raw SQL mirroring run-write-context.ts's
    // appendEvent, since the point of this row is to control commit timing
    // directly.
    const openClient = await store.pool.connect();
    await openClient.query('begin');
    const uncommittedSeq = await appendEventRaw(openClient, runId, 1, 'test.uncommitted', { step: 1 });

    await sleep(150);
    bg.assertNoFailure();
    assert.deepEqual(bg.collected, [], 'an event whose row has not committed must never be yielded, however many polls have elapsed');

    await openClient.query('commit');

    await waitUntil(() => bg.collected.length >= 1, {
      timeoutMs: 5000,
      message: 'the newly committed event to be yielded',
    });
    bg.assertNoFailure();
    assert.equal(bg.collected.length, 1);
    assert.equal(bg.collected[0].seq, uncommittedSeq);
    assert.equal(bg.collected[0].type, 'test.uncommitted');
    assert.equal(bg.collected[0].runId, runId);

    // A second transaction appends and then ROLLS BACK — the counter
    // increment and the row insert are both undone together, since both ran
    // inside the same aborted transaction.
    const rolledBackClient = await store.pool.connect();
    await rolledBackClient.query('begin');
    const rolledBackSeq = await appendEventRaw(rolledBackClient, runId, 1, 'test.rolledback', { step: 2 });
    assert.equal(rolledBackSeq, uncommittedSeq + 1, 'seq must still advance for the rolled-back attempt before it is undone, or the reuse below proves nothing');

    await sleep(150);
    bg.assertNoFailure();
    assert.equal(bg.collected.length, 1, 'a row that is about to be rolled back must never be yielded while its transaction is still open');

    await rolledBackClient.query('rollback');
    openClient.release();
    rolledBackClient.release();

    await sleep(150);
    bg.assertNoFailure();
    assert.equal(bg.collected.length, 1, 'a rolled-back row must never be yielded after the rollback either');

    // A later committed write reuses the exact seq the rolled-back attempt
    // held — this is decision-level durability: the sequence never skips a
    // value that was never actually observed as committed.
    const laterClient = await store.pool.connect();
    await laterClient.query('begin');
    const laterSeq = await appendEventRaw(laterClient, runId, 1, 'test.after-rollback', { step: 3 });
    await laterClient.query('commit');
    laterClient.release();
    assert.equal(laterSeq, rolledBackSeq, 'the rolled-back seq must be reused by the next real commit, or run_events would carry a permanent gap');

    await waitUntil(() => bg.collected.length >= 2, {
      timeoutMs: 5000,
      message: 'the later committed event (reusing the rolled-back seq) to be yielded',
    });
    bg.assertNoFailure();

    assert.equal(bg.collected.length, 2, 'exactly two events total must ever be yielded: the rolled-back attempt must never appear as a third');
    assert.deepEqual(
      bg.collected.map((event) => event.seq),
      [uncommittedSeq, laterSeq],
      'the stream must show no gap (both seqs appear) and no duplicate (each appears exactly once), in commit order',
    );
    assert.equal(bg.collected[1].type, 'test.after-rollback');

    bg.controller.abort();
    await bg.done;
  },
);

/* -------------------------------------------------------------------------- */
/* Row 3 — process restart does not lose stream history                      */
/* -------------------------------------------------------------------------- */

test(
  'a brand-new pool and source reads the full history from lastEventId 0 after the first pool has been closed',
  { timeout: 20_000 },
  async (t) => {
    const connectionString = requireConnectionString();
    await persistence.setupApplicationSchema(connectionString);

    // AIC-58 review round 1, advisory finding 5: store1 is deliberately
    // closed mid-test (below, simulating a process restart) and so cannot be
    // registered with t.after the way freshStore's own store is — a second
    // close() on an already-ended pool throws. store1Closed tracks whether
    // the deliberate close already ran, so the finally block below still
    // guarantees a close if anything between construction and that point
    // throws, without double-closing on the ordinary path.
    const store1 = await persistence.createRunStore(connectionString, DEFAULT_OPTIONS);
    let store1Closed = false;
    try {
      await store1.pool.query(
        'truncate table aic_app.runs, aic_app.node_results, aic_app.run_events, aic_app.run_event_counters, aic_app.run_trials, aic_app.run_evidence, aic_app.fence_rejections',
      );

      const runId = `run-event-stream-restart-${randomUUID()}`;
      await store1.createRun({ runId, input: {} });
      const claim = await store1.claimNext('worker-restart');
      assert.equal(claim?.runId, runId);
      const context = await persistence.openRunWriteContext(store1, claim);

      const total = 4;
      for (let i = 0; i < total; i += 1) {
        const execKey = domain.buildExecKey('tool.trial', { runId, testId: `restart-${i}`, trialAttempt: 1 });
        await context.committed(execKey, async () => ({ i }), { project: noProjection });
      }
      await context.complete('done');

      // Independent oracle, read on the FIRST pool before it is ever closed.
      const { rows: expectedRows } = await store1.pool.query(
        'select seq, type, execution_attempt, payload, created_at from aic_app.run_events where run_id = $1 order by seq',
        [runId],
      );
      assert.equal(expectedRows.length, total + 1, 'the fixture must produce one event per commit plus one for complete(), or this row proves nothing');

      // Simulates a process restart: the pool that did the writing is fully closed.
      await store1.close();
      store1Closed = true;

      const store2 = await persistence.createRunStore(connectionString, DEFAULT_OPTIONS);
      t.after(async () => {
        await store2.close();
      });
      const source2 = createRunEventStreamSourceFactory()(store2.pool);

      const read = await source2.readAfter(runId, 0, { limit: 100 });

      assert.equal(
        read.length,
        expectedRows.length,
        'a brand-new pool and source must read every event a prior, now-closed pool committed: process restart must not lose stream history',
      );
      for (const [index, event] of read.entries()) {
        const expected = expectedRows[index];
        assert.equal(event.runId, runId);
        assert.equal(event.seq, Number(expected.seq));
        assert.equal(event.type, expected.type);
        assert.equal(event.executionAttempt, Number(expected.execution_attempt));
        assert.deepEqual(event.payload, expected.payload);
        assert.ok(event.createdAt instanceof Date, 'RunEvent.createdAt must be a Date');
        assert.equal(event.createdAt.toISOString(), new Date(expected.created_at).toISOString());
      }
    } finally {
      if (!store1Closed) {
        await store1.close();
      }
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Row 4 — tail is bounded by its signal: it ends rather than hanging        */
/* -------------------------------------------------------------------------- */

test(
  'tail with an already-aborted signal ends immediately rather than polling forever',
  { timeout: 10_000 },
  async (t) => {
    const store = await freshStore(t);
    const runId = `run-event-stream-preaborted-${randomUUID()}`;
    await store.createRun({ runId, input: {} });
    const source = createRunEventStreamSourceFactory()(store.pool);

    const controller = new AbortController();
    controller.abort();

    const collected = [];
    const drain = (async () => {
      for await (const event of source.tail(runId, { lastEventId: 0, signal: controller.signal, pollIntervalMs: 20 })) {
        collected.push(event);
      }
    })();

    let timer;
    const outcome = await Promise.race([
      drain.then(() => 'done'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 3000);
      }),
    ]);
    clearTimeout(timer);

    assert.equal(outcome, 'done', 'tail must end immediately when handed an already-aborted signal, never hang waiting on a first poll');
    assert.deepEqual(collected, [], 'no event exists for this run, so nothing should ever have been yielded');
  },
);

test(
  'tail ends shortly after its signal aborts mid-stream, rather than hanging on the next poll',
  { timeout: 10_000 },
  async (t) => {
    const store = await freshStore(t);
    const runId = `run-event-stream-abort-mid-${randomUUID()}`;
    await store.createRun({ runId, input: {} });
    const source = createRunEventStreamSourceFactory()(store.pool);

    const controller = new AbortController();
    const collected = [];
    const drain = (async () => {
      for await (const event of source.tail(runId, { lastEventId: 0, signal: controller.signal, pollIntervalMs: 20 })) {
        collected.push(event);
      }
    })();

    setTimeout(() => controller.abort(), 60);

    let timer;
    const outcome = await Promise.race([
      drain.then(() => 'done'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 3000);
      }),
    ]);
    clearTimeout(timer);

    assert.equal(outcome, 'done', 'tail must end shortly after its signal aborts, not hang waiting on a poll that will never be consumed');
    assert.deepEqual(collected, [], 'no event was ever written for this run, so nothing should have been yielded before the abort ended the iterable');
  },
);

/* -------------------------------------------------------------------------- */
/* Row 5 — isolation: another run's events never appear                      */
/* -------------------------------------------------------------------------- */

test(
  'events of another run never appear in this run\'s readAfter or tail',
  { timeout: 20_000 },
  async (t) => {
    const store = await freshStore(t);
    const { runId: runIdA, claim: claimA } = await createAndClaim(store, 'worker-isolation-a');
    const { runId: runIdB, claim: claimB } = await createAndClaim(store, 'worker-isolation-b');
    const contextA = await persistence.openRunWriteContext(store, claimA);
    const contextB = await persistence.openRunWriteContext(store, claimB);

    await contextA.committed(
      domain.buildExecKey('tool.trial', { runId: runIdA, testId: 'isolation-a', trialAttempt: 1 }),
      async () => ({ owner: 'a' }),
      { project: noProjection },
    );
    await contextB.committed(
      domain.buildExecKey('tool.trial', { runId: runIdB, testId: 'isolation-b1', trialAttempt: 1 }),
      async () => ({ owner: 'b1' }),
      { project: noProjection },
    );
    await contextB.committed(
      domain.buildExecKey('tool.trial', { runId: runIdB, testId: 'isolation-b2', trialAttempt: 1 }),
      async () => ({ owner: 'b2' }),
      { project: noProjection },
    );

    const source = createRunEventStreamSourceFactory()(store.pool);

    // Independent oracle for run A's own events.
    const { rows: expectedA } = await store.pool.query('select seq from aic_app.run_events where run_id = $1 order by seq', [
      runIdA,
    ]);
    assert.equal(expectedA.length, 1, 'run A must have produced exactly one event, or this row proves nothing about isolation');

    const readA = await source.readAfter(runIdA, 0, { limit: 100 });
    assert.deepEqual(
      readA.map((event) => event.seq),
      expectedA.map((row) => Number(row.seq)),
      'readAfter(runIdA, ...) must return exactly run A\'s own events',
    );
    assert.ok(
      readA.every((event) => event.runId === runIdA),
      'readAfter(runIdA, ...) must never carry an event belonging to run B',
    );

    const tailed = [];
    const controller = new AbortController();
    for await (const event of source.tail(runIdA, { lastEventId: 0, signal: controller.signal, pollIntervalMs: 20 })) {
      tailed.push(event);
      controller.abort();
      break;
    }
    assert.equal(tailed.length, 1);
    assert.ok(
      tailed.every((event) => event.runId === runIdA),
      'tail(runIdA, ...) must never yield an event belonging to run B, even though run B has two committed events of its own',
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Row 6 — LIVE correspondence: the storage column's own type vs.            */
/* MAX_RUN_EVENT_SEQ (AIC-58 review finding 1)                                */
/* -------------------------------------------------------------------------- */

test(
  'LIVE correspondence: aic_app.run_events.seq is PostgreSQL "integer" (int4), and @aic/domain.MAX_RUN_EVENT_SEQ equals int4\'s own maximum (2^31-1) — a later column widening, or a constant change with no matching migration, must redden this row in either direction',
  { timeout: 20_000 },
  async (t) => {
    const store = await freshStore(t);

    const { rows } = await store.pool.query(
      `select data_type from information_schema.columns
       where table_schema = 'aic_app' and table_name = 'run_events' and column_name = 'seq'`,
    );
    assert.equal(rows.length, 1, 'information_schema must report exactly one seq column on aic_app.run_events, or this row proves nothing about its type');
    assert.equal(
      rows[0].data_type,
      'integer',
      'run_events.seq must be PostgreSQL "integer" (int4, max 2147483647) for MAX_RUN_EVENT_SEQ to be a correct ceiling — if this column is ever widened (e.g. to bigint), MAX_RUN_EVENT_SEQ must widen with it, and this assertion must go red until it does',
    );

    // Independent literal, 2^31-1 — never domain.MAX_RUN_EVENT_SEQ read back
    // against itself, or a drifted constant would agree with itself here.
    assert.equal(
      domain.MAX_RUN_EVENT_SEQ,
      2147483647,
      'MAX_RUN_EVENT_SEQ must equal 2^31-1, the exact maximum PostgreSQL "integer" (int4) can hold — if the constant is ever changed with no matching column migration, this assertion must go red',
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Row 7 — readAfter's own limit pages a backlog exactly (AIC-58 review      */
/* finding 3a)                                                                */
/* -------------------------------------------------------------------------- */

test(
  'readAfter(runId, afterSeq, { limit }) pages a small backlog exactly: the first two committed events, then the remainder',
  { timeout: 20_000 },
  async (t) => {
    const store = await freshStore(t);
    const { runId, claim } = await createAndClaim(store, 'worker-limit-paging');
    const context = await persistence.openRunWriteContext(store, claim);

    const total = 3;
    for (let i = 0; i < total; i += 1) {
      const execKey = domain.buildExecKey('tool.trial', { runId, testId: `limit-paging-${i}`, trialAttempt: 1 });
      await context.committed(execKey, async () => ({ i }), { project: noProjection });
    }

    // Independent oracle: the test's own SQL, never the source under test.
    const { rows: allRows } = await store.pool.query('select seq from aic_app.run_events where run_id = $1 order by seq', [runId]);
    assert.equal(allRows.length, total, 'the fixture must produce one event per commit, or this row proves nothing about paging');

    const source = createRunEventStreamSourceFactory()(store.pool);

    const firstPage = await source.readAfter(runId, 0, { limit: 2 });
    assert.deepEqual(
      firstPage.map((event) => event.seq),
      allRows.slice(0, 2).map((row) => Number(row.seq)),
      'readAfter(runId, 0, { limit: 2 }) over 3 committed events must return exactly the first two, in order',
    );

    const secondPage = await source.readAfter(runId, firstPage.at(-1).seq, { limit: 2 });
    assert.deepEqual(
      secondPage.map((event) => event.seq),
      allRows.slice(2).map((row) => Number(row.seq)),
      'readAfter(runId, <last seq of the first page>, { limit: 2 }) must return exactly the remaining (third) event',
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Row 8 — tail's pageSize seam pages a backlog larger than one page         */
/* (AIC-58 review finding 3b)                                                 */
/* -------------------------------------------------------------------------- */

test(
  'createRunEventStreamSource(pool, { pageSize }) makes tail page a backlog larger than one page, yielding every committed event exactly once, in order',
  { timeout: 20_000 },
  async (t) => {
    const store = await freshStore(t);
    const { runId, claim } = await createAndClaim(store, 'worker-tail-paging');
    const context = await persistence.openRunWriteContext(store, claim);

    const total = 5;
    for (let i = 0; i < total; i += 1) {
      const execKey = domain.buildExecKey('tool.trial', { runId, testId: `tail-paging-${i}`, trialAttempt: 1 });
      await context.committed(execKey, async () => ({ i }), { project: noProjection });
    }

    // Independent oracle: the test's own SQL, never the source under test.
    const { rows: allRows } = await store.pool.query('select seq from aic_app.run_events where run_id = $1 order by seq', [runId]);
    assert.equal(allRows.length, total, 'the fixture must produce one event per commit, or this row proves nothing about paging');

    // Instrumentation, not the source under test: wraps the store's REAL
    // pool.query to record the LIMIT bound value of every run_events SELECT
    // tail issues, then restores it — proving tail actually paged in
    // pageSize-sized chunks, rather than fetching everything in one
    // DEFAULT_READ_LIMIT-sized poll (5 events comfortably fits in the
    // existing 500-row default, which is exactly why this seam needs its own
    // assertion: a green run without it would not prove paging happened).
    const pageSize = 2;
    const realQuery = store.pool.query.bind(store.pool);
    const limitsSeen = [];
    store.pool.query = (sql, params) => {
      if (typeof sql === 'string' && /from\s+"aic_app"\.run_events/i.test(sql) && Array.isArray(params) && params.length === 3) {
        limitsSeen.push(params[2]);
      }
      return realQuery(sql, params);
    };
    t.after(() => {
      store.pool.query = realQuery;
    });

    const source = createRunEventStreamSourceFactory()(store.pool, { pageSize });

    const collected = [];
    const controller = new AbortController();
    for await (const event of source.tail(runId, { lastEventId: 0, signal: controller.signal, pollIntervalMs: 20 })) {
      collected.push(event);
      if (collected.length >= total) {
        controller.abort();
        break;
      }
    }

    assert.deepEqual(
      collected.map((event) => event.seq),
      allRows.map((row) => Number(row.seq)),
      'tail must yield every committed event exactly once, in order, regardless of how many pages it took',
    );
    assert.ok(
      limitsSeen.length >= Math.ceil(total / pageSize),
      `tail({ pageSize: ${pageSize} }) over ${total} events must have issued at least ${Math.ceil(total / pageSize)} paged run_events queries, but issued ${limitsSeen.length}: ${JSON.stringify(limitsSeen)}`,
    );
    assert.ok(
      limitsSeen.every((limit) => limit === pageSize),
      `every run_events query tail issues must bound its LIMIT to the configured pageSize (${pageSize}), but saw ${JSON.stringify(limitsSeen)}`,
    );
  },
);

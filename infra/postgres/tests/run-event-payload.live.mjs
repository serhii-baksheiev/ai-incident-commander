/**
 * AIC-58, slice c — the half that needs a real database: a fenced write
 * (`fail`/`complete` on `RunWriteContext`) whose event payload breaks
 * `assertRunEventPayload`'s rule is refused, and the WHOLE transaction rolls
 * back — no `run_events` row, no `run_event_counters` increment, and the
 * `runs` row stays `running` rather than moving to its terminal status.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/run-write-context.live.mjs` (`freshStore`,
 * `createAndClaim`, "refuses rather than skips" — not repeated here in
 * full).
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5435/aic npm run test:live-postgres
 *
 * (container `aic-58a`; do not point this at 5432-5434 — those are other
 * slices' own containers.)
 *
 * ## Design choice this file assumes
 *
 * `assertRunEventPayload` is called from inside `appendEvent`, before either
 * of its own statements (`run_event_counters` upsert, then the `run_events`
 * INSERT) — so a refusal there aborts `appendEvent` before the counter is
 * touched at all, and `runFenced`'s own catch then rolls back everything
 * `work()` had done in the same transaction, including the `runs` UPDATE
 * `fail`/`complete` issue first. If the implementation instead validates
 * AFTER incrementing the counter (still inside the same transaction), the
 * rollback assertions below still hold — a rolled-back transaction undoes
 * the counter increment too — so this file does not depend on exactly where
 * inside `appendEvent` the check runs, only on the whole transaction being
 * atomic, which `runFenced` already guarantees for every other refusal path
 * in `run-write-context.live.mjs`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5435/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place a refused
run-event payload's transaction rollback is measured against a real
PostgreSQL, so a skip would report it as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this slice touches truncated. Copied from
 * run-write-context.live.mjs's own `freshStore`.
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
  const runId = `run-event-payload-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext(workerId);
  assert.equal(claim?.runId, runId, 'createAndClaim helper must actually claim the run it just created');
  return { runId, claim };
}

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

test('fail() with a reason one character past the cap is refused before any run_events row or counter increment lands, and the run stays running; exactly at the cap it is accepted', async (t) => {
  const store = await freshStore(t);

  // --- refusal: 257 characters, one past MAX_RUN_EVENT_PAYLOAD_STRING ---
  const { runId: refusedRunId, claim: refusedClaim } = await createAndClaim(store, 'worker-fail-over-cap');
  const context = await persistence.openRunWriteContext(store, refusedClaim);
  const overCapReason = 'a'.repeat((domain.MAX_RUN_EVENT_PAYLOAD_STRING ?? 256) + 1);

  await assert.rejects(
    () => context.fail(overCapReason),
    (error) => error instanceof domain.RunEventPayloadError,
    'fail() with a reason past MAX_RUN_EVENT_PAYLOAD_STRING must be refused with RunEventPayloadError, not silently accepted or a raw driver error',
  );

  const { rows: eventRows } = await store.pool.query('select 1 from aic_app.run_events where run_id = $1', [
    refusedRunId,
  ]);
  assert.equal(eventRows.length, 0, 'a refused fail() must leave no run_events row: the whole fenced transaction rolls back');

  const { rows: counterRows } = await store.pool.query(
    'select next_seq from aic_app.run_event_counters where run_id = $1',
    [refusedRunId],
  );
  assert.equal(
    counterRows.length,
    0,
    'a refused fail() must leave no run_event_counters row at all: the counter upsert is inside the same rolled-back transaction, so the seq sequence is never advanced for a rejected write',
  );

  const { rows: runRows } = await store.pool.query('select status, terminal_reason from aic_app.runs where run_id = $1', [
    refusedRunId,
  ]);
  assert.equal(runRows[0].status, 'running', 'a refused fail() must leave the run running, not failed: the runs UPDATE is in the same rolled-back transaction as the event append');
  assert.equal(runRows[0].terminal_reason, null, 'a refused fail() must never have written the oversized reason anywhere, including terminal_reason');

  // --- acceptance: exactly at the cap, 256 characters ---
  const { runId: acceptedRunId, claim: acceptedClaim } = await createAndClaim(store, 'worker-fail-at-cap');
  const acceptedContext = await persistence.openRunWriteContext(store, acceptedClaim);
  const atCapReason = 'a'.repeat(domain.MAX_RUN_EVENT_PAYLOAD_STRING ?? 256);

  await assert.doesNotReject(
    () => acceptedContext.fail(atCapReason),
    'fail() with a reason of exactly MAX_RUN_EVENT_PAYLOAD_STRING characters must be accepted — the cap is inclusive',
  );

  const { rows: acceptedEventRows } = await store.pool.query(
    "select type from aic_app.run_events where run_id = $1 and type = 'run.failed'",
    [acceptedRunId],
  );
  assert.equal(acceptedEventRows.length, 1, 'an accepted fail() must append exactly one run.failed event');

  const { rows: acceptedRunRows } = await store.pool.query('select status from aic_app.runs where run_id = $1', [
    acceptedRunId,
  ]);
  assert.equal(acceptedRunRows[0].status, 'failed', 'an accepted fail() must move the run to failed');
});

test('complete() with a reason one character past the cap is refused before any run_events row or counter increment lands, and the run stays running; exactly at the cap it is accepted', async (t) => {
  const store = await freshStore(t);

  // --- refusal: 257 characters ---
  const { runId: refusedRunId, claim: refusedClaim } = await createAndClaim(store, 'worker-complete-over-cap');
  const context = await persistence.openRunWriteContext(store, refusedClaim);
  const overCapReason = 'a'.repeat((domain.MAX_RUN_EVENT_PAYLOAD_STRING ?? 256) + 1);

  await assert.rejects(
    () => context.complete(overCapReason),
    (error) => error instanceof domain.RunEventPayloadError,
    'complete() with a reason past MAX_RUN_EVENT_PAYLOAD_STRING must be refused with RunEventPayloadError',
  );

  const { rows: eventRows } = await store.pool.query('select 1 from aic_app.run_events where run_id = $1', [
    refusedRunId,
  ]);
  assert.equal(eventRows.length, 0, 'a refused complete() must leave no run_events row: the whole fenced transaction rolls back');

  const { rows: counterRows } = await store.pool.query(
    'select next_seq from aic_app.run_event_counters where run_id = $1',
    [refusedRunId],
  );
  assert.equal(counterRows.length, 0, 'a refused complete() must leave no run_event_counters row at all');

  const { rows: runRows } = await store.pool.query('select status from aic_app.runs where run_id = $1', [refusedRunId]);
  assert.equal(runRows[0].status, 'running', 'a refused complete() must leave the run running, not completed');

  // --- acceptance: exactly at the cap ---
  const { runId: acceptedRunId, claim: acceptedClaim } = await createAndClaim(store, 'worker-complete-at-cap');
  const acceptedContext = await persistence.openRunWriteContext(store, acceptedClaim);
  const atCapReason = 'a'.repeat(domain.MAX_RUN_EVENT_PAYLOAD_STRING ?? 256);

  await assert.doesNotReject(
    () => acceptedContext.complete(atCapReason),
    'complete() with a reason of exactly MAX_RUN_EVENT_PAYLOAD_STRING characters must be accepted',
  );

  const { rows: acceptedEventRows } = await store.pool.query(
    "select type from aic_app.run_events where run_id = $1 and type = 'run.completed'",
    [acceptedRunId],
  );
  assert.equal(acceptedEventRows.length, 1, 'an accepted complete() must append exactly one run.completed event');

  const { rows: acceptedRunRows } = await store.pool.query('select status from aic_app.runs where run_id = $1', [
    acceptedRunId,
  ]);
  assert.equal(acceptedRunRows[0].status, 'completed', 'an accepted complete() must move the run to completed');
});

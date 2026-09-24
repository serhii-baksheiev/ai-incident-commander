/**
 * AIC-56 slice E — the half of `createFencedCheckpointer` that needs a real
 * database: a real zombie worker refused by a real `RunWriteContext` while
 * writing a checkpoint (not only a domain record), `fence_rejections`
 * gaining a `kind = 'checkpoint'` row for that refusal, the barrier seam
 * `beforeWrite` gives AIC-57 actually holding a passing write open before the
 * inner saver runs, and the spike runner
 * (`createPersistentInvestigationRunner`) running to completion on real
 * PostgreSQL through both the fenced checkpointer and a real
 * `RunWriteContext` at once.
 *
 * The half decidable without a database — the calling convention, ordering,
 * refusal and serde-identity behaviour against a fake context and
 * `MemorySaver` — lives in `test/fenced-checkpointer.test.mjs`.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/run-write-context.live.mjs` (schema provisioning and
 * truncation, force-expiring a lease with raw SQL and sweeping,
 * `createAndClaim`) and `infra/postgres/tests/durable-tool-replay.live.mjs`
 * (checkpointer schema setup beside `aic_app`, on the same database) — see
 * those files' headers for "why this file is not under `test/`", "it
 * refuses; it never skips", and "independent verification". Not repeated
 * here in full.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## Design choices this file assumes, beyond test/fenced-checkpointer.test.mjs
 *
 * - Every row here uses ONE process: the acceptance spec explicitly permits
 *   this for the spike-runner row ("a single process is enough"), and the
 *   zombie and barrier rows need no crash or IPC either — a lease
 *   force-expire + sweep + a second real claim, exactly like
 *   `run-write-context.live.mjs`'s own zombie-worker row, is enough to put
 *   two real `RunWriteContext`s at two different `execution_attempt`s in the
 *   same process.
 * - `context` passed to `createFencedCheckpointer` is a real
 *   `openRunWriteContext(store, claim)` — the same object every other
 *   `RunWriteContext` acceptance row in this repository already exercises.
 * - Row 6 below asks that a refused checkpoint write records a
 *   `fence_rejections` row with `kind = 'checkpoint'`. ⚠ As shipped today,
 *   `RunWriteContext.assertOwner()` (the one fencing primitive the exported
 *   `RunWriteContext` interface names with no arguments) does not itself call
 *   `recordFenceRejection` — only the `committed` / `markWaitingHuman` /
 *   `complete` / `fail` methods do, through the module-private `runFenced`.
 *   Satisfying this row is therefore a design question for the
 *   implementation, not something this file settles: either
 *   `RunWriteContext` gains a way for a caller to name its own `kind` when it
 *   fences (widening `assertOwner`, or a sibling primitive), or
 *   `createFencedCheckpointer` is built against something other than the
 *   literal, already-shipped `RunWriteContext.assertOwner()`. This row pins
 *   the OBSERVABLE contract the acceptance spec asks for; it does not
 *   prescribe which of those the implementation picks.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import * as domain from '@aic/domain';
import { createPersistentInvestigationRunner } from '@aic/graph';
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place the fenced
checkpointer's real-zombie, fence_rejections, barrier-seam and spike-runner
rows are measured against a real PostgreSQL, so a skip would report them as
met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

function fencedCheckpointerFactory() {
  assert.equal(
    typeof persistence.createFencedCheckpointer,
    'function',
    "@aic/persistence must export createFencedCheckpointer(inner, context, options?) — AIC-56 slice E's FencedCheckpointer (docs/decisions/durable-run-execution.md decision 9)",
  );
  return persistence.createFencedCheckpointer;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this row touches truncated, and the pool closed at the end of
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
  const runId = `run-fenced-checkpointer-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext(workerId);
  assert.equal(claim?.runId, runId, 'createAndClaim helper must actually claim the run it just created');
  return { runId, claim };
}

/** A checkpointer's own (`langgraph`) schema, provisioned once per row — copied from durable-tool-replay.live.mjs. */
async function provisionCheckpointerSchema(t) {
  const setupSaver = await persistence.createPostgresCheckpointer(requireConnectionString());
  await setupSaver.setup();
  await setupSaver.pool.end();
}

/** A one-node graph that does nothing but advance `value` — enough to exercise a checkpointer's put/list without any domain state. */
const TrivialState = Annotation.Root({ value: Annotation() });
function buildTrivialGraph(checkpointer) {
  return new StateGraph(TrivialState)
    .addNode('step', async (state) => ({ value: (state.value ?? 0) + 1 }))
    .addEdge(START, 'step')
    .addEdge('step', END)
    .compile({ checkpointer });
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
/* Row 6 — a real zombie: a checkpoint write is refused after a real          */
/* takeover, fence_rejections gains a kind = 'checkpoint' row, and B's own    */
/* checkpoint is unaffected                                                   */
/* -------------------------------------------------------------------------- */

test('a real zombie worker\'s checkpoint write is refused by a real RunWriteContext after a takeover, fence_rejections records it with kind = checkpoint, and B\'s checkpoint is unaffected', async (t) => {
  await provisionCheckpointerSchema(t);
  const store = await freshStore(t);
  const { runId, claim: claimA } = await createAndClaim(store, 'worker-fenced-zombie-a');

  const innerA = await persistence.createPostgresCheckpointer(requireConnectionString());
  t.after(() => innerA.pool.end());
  const contextA = await persistence.openRunWriteContext(store, claimA);
  const fencedA = fencedCheckpointerFactory()(innerA, contextA);
  const graphA = buildTrivialGraph(fencedA);
  const threadConfig = { configurable: { thread_id: runId } };

  // A writes one checkpoint successfully, while it still holds a valid lease.
  await graphA.invoke({ value: 0 }, threadConfig);

  // Force-expire A's lease and sweep — the same zombie-worker shape as
  // run-write-context.live.mjs's own row.
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  const swept = await store.sweepExpired();
  assert.deepEqual(swept, [runId], 'sweepExpired must reclaim exactly this run');

  const claimB = await store.claimNext('worker-fenced-zombie-b');
  assert.equal(claimB.runId, runId);
  assert.equal(claimB.executionAttempt, 2, 'the takeover must be a second attempt');

  const innerB = await persistence.createPostgresCheckpointer(requireConnectionString());
  t.after(() => innerB.pool.end());
  const contextB = await persistence.openRunWriteContext(store, claimB);
  const fencedB = fencedCheckpointerFactory()(innerB, contextB);
  const graphB = buildTrivialGraph(fencedB);

  // B, the new valid owner, writes its own checkpoint for the same thread.
  await graphB.invoke({ value: 1 }, threadConfig);
  const bTupleRightAfterWrite = await innerB.getTuple(threadConfig);
  assert.ok(bTupleRightAfterWrite, "B's own checkpoint write must have landed");

  // A, now stale, attempts a further checkpoint write and must be refused.
  await assert.rejects(
    () => graphA.invoke({ value: 99 }, threadConfig),
    (error) => error instanceof domain.StaleOwnerError,
    "A's checkpoint write after losing the lease and being superseded must throw StaleOwnerError",
  );

  const { rows: rejectionRows } = await store.pool.query(
    'select kind from aic_app.fence_rejections where run_id = $1 and owner_worker_id = $2 and execution_attempt = 1',
    [runId, claimA.ownerWorkerId],
  );
  assert.ok(
    rejectionRows.length > 0,
    "A's refused checkpoint write must record at least one fence_rejections row (decision 12: a fenced rejection is durable evidence, and this is the checkpoint write path, not only the domain-record path already covered by run-write-context.live.mjs)",
  );
  assert.ok(
    rejectionRows.every((row) => row.kind === 'checkpoint'),
    `every fence_rejections row for a refused checkpoint write must carry kind = 'checkpoint', got: ${JSON.stringify(rejectionRows)}`,
  );

  // Independent oracle: B's checkpoint, read through a FRESH, unfenced
  // PostgresSaver rather than through either fenced wrapper's own getTuple.
  const oracle = await persistence.createPostgresCheckpointer(requireConnectionString());
  t.after(() => oracle.pool.end());
  const oracleTuple = await oracle.getTuple(threadConfig);
  assert.ok(oracleTuple, "B's checkpoint must be visible to an independent, unfenced saver");
  assert.deepEqual(
    oracleTuple.checkpoint,
    bTupleRightAfterWrite.checkpoint,
    "B's latest checkpoint for the thread must be byte-for-byte unaffected by A's refused write attempt",
  );
});

/* -------------------------------------------------------------------------- */
/* Row 7 — the barrier seam: beforeWrite holds a PASSING write open before    */
/* the inner saver runs (the seam AIC-57 will drive a race through — no race  */
/* assertion here)                                                            */
/* -------------------------------------------------------------------------- */

test('the barrier seam: beforeWrite holds a passing write open, and no checkpoint lands until it is released', async (t) => {
  await provisionCheckpointerSchema(t);
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-fenced-barrier');

  const inner = await persistence.createPostgresCheckpointer(requireConnectionString());
  t.after(() => inner.pool.end());
  const context = await persistence.openRunWriteContext(store, claim);

  let releaseWrite;
  const gate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const fenced = fencedCheckpointerFactory()(inner, context, {
    beforeWrite: () => gate,
  });

  const threadConfig = { configurable: { thread_id: runId } };
  const graph = buildTrivialGraph(fenced);
  const invokePromise = graph.invoke({ value: 0 }, threadConfig);

  // The gate never resolves on its own: this is not a race against a timer,
  // it is a wait bounded only by this test's own patience. Any delay here
  // proves the same thing — the write cannot have landed while the gate is
  // held, because nothing else can release it.
  await delay(50);
  const duringHold = await inner.getTuple(threadConfig);
  assert.equal(
    duringHold,
    undefined,
    "while beforeWrite is held open, the checkpoint must not exist yet: the fence has already passed (this write is not a refusal) but the inner saver's put has not run — this is the exact window AIC-57 (decision 11) drives a race through",
  );

  releaseWrite();
  await invokePromise;

  const afterRelease = await inner.getTuple(threadConfig);
  assert.ok(afterRelease, 'once beforeWrite resolves, the held write must land in the inner saver');
});

/* -------------------------------------------------------------------------- */
/* Row 8 — the spike runner runs to completion on real PostgreSQL through    */
/* the fenced checkpointer AND a real RunWriteContext, for one claimed run    */
/* -------------------------------------------------------------------------- */

test('the spike runner runs to completion on PostgreSQL through the fenced checkpointer, for one claimed run', async (t) => {
  await provisionCheckpointerSchema(t);
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-fenced-spike');

  const inner = await persistence.createPostgresCheckpointer(requireConnectionString());
  t.after(() => inner.pool.end());
  const context = await persistence.openRunWriteContext(store, claim);
  const fenced = fencedCheckpointerFactory()(inner, context);

  const executeInvestigation = async () => ({
    trial: { status: 'ok', durationMs: 1 },
    evidence: {
      kind: 'log',
      source: 'fixture-tool',
      observedAt: '2026-09-24T00:00:00.000Z',
      statement: 'the fenced checkpointer runs a real graph to completion on real PostgreSQL',
      rawRef: 'fixture://fenced-checkpointer-postgres',
      reliability: 'high',
    },
    payloadFingerprint: 'fenced-checkpointer-postgres-v1',
  });

  const runner = createPersistentInvestigationRunner({
    checkpointer: fenced,
    execution: context,
    executeInvestigation,
  });

  const result = await runner.start({
    runId,
    test: { id: 'test-fenced-spike', tool: 'fixture-tool', input: {} },
  });

  assert.equal(result.trials.length, 1, 'the run must complete, producing exactly one Trial');
  assert.equal(result.evidence.length, 1);

  const threadConfig = { configurable: { thread_id: runId } };
  const checkpointTuple = await inner.getTuple(threadConfig);
  assert.ok(checkpointTuple, 'the fenced checkpointer must have actually written a checkpoint through the inner PostgreSQL saver');

  const { rows } = await store.pool.query('select 1 from aic_app.node_results where run_id = $1', [runId]);
  assert.equal(
    rows.length,
    1,
    "the committed execution port (the SAME real RunWriteContext the fenced checkpointer was built against) must have written its node_results row, proving both ports share one claim's fence",
  );
});

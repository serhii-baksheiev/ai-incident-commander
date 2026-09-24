/**
 * AIC-56 slice E: `createFencedCheckpointer(inner, context, { beforeWrite? })`
 * — decision 9 of docs/decisions/durable-run-execution.md, provisionally:
 * "the exclusion primitive is a fenced checkpointer" — writes through the
 * checkpointer are fenced by the same ownership identity as product commits.
 *
 * This file is the half decidable WITHOUT a database: the calling
 * convention (`getTuple`/`list` never fence, `put`/`putWrites`/`deleteThread`
 * always fence first), the ordering the seam AIC-57 will drive a barrier
 * through (fence, then `beforeWrite`, then the inner saver), what happens
 * when the fence itself refuses, and that the wrapped saver is a drop-in
 * checkpointer for a compiled graph. The half that needs a real PostgreSQL —
 * a real zombie worker refused by a real `RunWriteContext`, `fence_rejections`
 * gaining a `kind = 'checkpoint'` row, and the barrier seam actually holding a
 * write open — lives on its own line,
 * `infra/postgres/tests/fenced-checkpointer.live.mjs`.
 *
 * ## Design choices this file assumes
 *
 * The task spec names the intended API
 * (`createFencedCheckpointer(inner, context, { beforeWrite? })`) and the
 * calling convention, but not every internal shape. Two choices, stated here
 * rather than discovered mid-assertion:
 *
 *   - `context` is the narrowest shape the spec names, `{ assertOwner() }` —
 *     exactly the one method every `@aic/persistence` `RunWriteContext`
 *     already exposes (`run-write-context.ts`'s exported `RunWriteContext`
 *     interface), so a real one is a drop-in without widening anything. See
 *     `test/fixtures/fake-fence-context.mjs`.
 *   - `getTuple` and `list` are asserted to return exactly what the inner
 *     saver returns, and to never call `assertOwner()` — read against a real
 *     `MemorySaver` populated through an actual compiled graph, not a stub,
 *     so "returns what the inner saver returns" is checked against a real
 *     saver's real behaviour rather than a fake that always agrees with
 *     itself.
 *
 * If the implementation shapes either differently, that reason belongs in the
 * PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph-checkpoint';

import { StaleOwnerError } from '@aic/domain';
import { createPersistentInvestigationRunner } from '@aic/graph';
import * as persistence from '@aic/persistence';

import { createFakeFenceContext } from './fixtures/fake-fence-context.mjs';

/**
 * The factory, fetched through the namespace rather than a named import — a
 * named `import { createFencedCheckpointer }` of an export that does not yet
 * exist is a link-time error that takes the whole file down, the same reason
 * `test/postgres-checkpointer.test.mjs` and
 * `test/run-write-context.test.mjs` fetch their factories this way.
 */
function fencedCheckpointerFactory() {
  assert.equal(
    typeof persistence.createFencedCheckpointer,
    'function',
    "@aic/persistence must export createFencedCheckpointer(inner, context, options?) — AIC-56 slice E's FencedCheckpointer (docs/decisions/durable-run-execution.md decision 9): writes through the checkpointer are fenced by the same ownership identity as product commits",
  );
  return persistence.createFencedCheckpointer;
}

/** Drains an async generator (`list`'s return shape) into a plain array. */
async function collect(asyncIterable) {
  const items = [];
  for await (const item of asyncIterable) items.push(item);
  return items;
}

const ThreadState = Annotation.Root({ value: Annotation() });

/** A real MemorySaver with exactly one checkpoint already written, through a real compiled graph — not a hand-built Checkpoint object. */
async function buildInnerWithOneCheckpoint(threadId) {
  const inner = new MemorySaver();
  const graph = new StateGraph(ThreadState)
    .addNode('step', async (state) => ({ value: (state.value ?? 0) + 1 }))
    .addEdge(START, 'step')
    .addEdge('step', END)
    .compile({ checkpointer: inner });
  const config = { configurable: { thread_id: threadId } };
  await graph.invoke({ value: 0 }, config);
  return { inner, config };
}

/** A minimal stand-in for a BaseCheckpointSaver's writing surface, for rows that only need to observe call order or identity and must never actually reach a real saver's storage. */
function createInnerWriteStub(log) {
  return {
    serde: {},
    async getTuple() {
      return undefined;
    },
    async *list() {
      // no checkpoints
    },
    async put(config) {
      log.push('inner.put');
      return config;
    },
    async putWrites() {
      log.push('inner.putWrites');
    },
    async deleteThread() {
      log.push('inner.deleteThread');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Row 1 — reads pass through and never fence                                 */
/* -------------------------------------------------------------------------- */

test('getTuple and list return exactly what the inner saver returns, and never call the fence', async () => {
  const { inner, config } = await buildInnerWithOneCheckpoint('thread-reads');
  // Configured to fail: if a read ever reached the fence, this row would see
  // it fail loudly rather than pass by coincidence.
  const context = createFakeFenceContext({ fails: true });
  const fenced = fencedCheckpointerFactory()(inner, context);

  const expectedTuple = await inner.getTuple(config);
  const actualTuple = await fenced.getTuple(config);
  assert.deepEqual(
    actualTuple,
    expectedTuple,
    'getTuple must delegate to the inner saver and return exactly what it returns',
  );

  const expectedList = await collect(inner.list(config));
  const actualList = await collect(fenced.list(config));
  assert.deepEqual(
    actualList,
    expectedList,
    'list must delegate to the inner saver and return exactly what it returns',
  );

  assert.deepEqual(
    context.calls,
    [],
    'getTuple and list must never call the fence: only put, putWrites and deleteThread are writes',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 2 — writes fence, then beforeWrite, then the inner saver, in order     */
/* -------------------------------------------------------------------------- */

test('put, putWrites and deleteThread each run the fence, then beforeWrite, then the inner saver, in that order', async () => {
  const log = [];
  const context = createFakeFenceContext({ onAssertOwner: () => log.push('fence') });
  const inner = createInnerWriteStub(log);
  const beforeWrite = async () => {
    log.push('beforeWrite');
  };
  const fenced = fencedCheckpointerFactory()(inner, context, { beforeWrite });
  const config = { configurable: { thread_id: 'thread-order' } };

  log.length = 0;
  await fenced.put(config, {}, {}, {});
  assert.deepEqual(
    log,
    ['fence', 'beforeWrite', 'inner.put'],
    'put must check the fence, then run beforeWrite, then delegate to the inner saver — in that order',
  );

  log.length = 0;
  await fenced.putWrites(config, [], 'task-1');
  assert.deepEqual(
    log,
    ['fence', 'beforeWrite', 'inner.putWrites'],
    'putWrites must check the fence, then run beforeWrite, then delegate to the inner saver — in that order',
  );

  log.length = 0;
  await fenced.deleteThread('thread-order');
  assert.deepEqual(
    log,
    ['fence', 'beforeWrite', 'inner.deleteThread'],
    'deleteThread must check the fence, then run beforeWrite, then delegate to the inner saver — in that order',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 3 — a refusing fence rejects every write, beforeWrite never runs, and  */
/* the inner saver is never called                                           */
/* -------------------------------------------------------------------------- */

test('when the fence refuses, put/putWrites/deleteThread all reject with StaleOwnerError, beforeWrite never runs, and the inner MemorySaver is untouched', async () => {
  const inner = new MemorySaver();
  const context = createFakeFenceContext({ fails: true });
  let beforeWriteCalls = 0;
  const beforeWrite = async () => {
    beforeWriteCalls += 1;
  };
  const fenced = fencedCheckpointerFactory()(inner, context, { beforeWrite });

  const threadId = 'thread-refused';
  const config = { configurable: { thread_id: threadId } };
  const before = await collect(inner.list(config));
  assert.deepEqual(before, [], 'sanity: the inner saver starts with no checkpoints for this thread');

  await assert.rejects(
    () => fenced.put(config, {}, {}, {}),
    StaleOwnerError,
    'a refused fence must surface as StaleOwnerError from put, and the inner saver must not be called',
  );
  await assert.rejects(
    () => fenced.putWrites(config, [], 'task-1'),
    StaleOwnerError,
    'a refused fence must surface as StaleOwnerError from putWrites, and the inner saver must not be called',
  );
  await assert.rejects(
    () => fenced.deleteThread(threadId),
    StaleOwnerError,
    'a refused fence must surface as StaleOwnerError from deleteThread, and the inner saver must not be called',
  );

  assert.equal(
    beforeWriteCalls,
    0,
    'beforeWrite must never run when the fence refuses — it belongs strictly after a passing fence',
  );

  const after = await collect(inner.list(config));
  assert.deepEqual(
    after,
    [],
    'the inner MemorySaver must be untouched: no checkpoint may have been written by a refused put',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 4 — serde is the inner saver's own object, by identity                 */
/* -------------------------------------------------------------------------- */

test("serde is the inner saver's own object, by identity", () => {
  const innerSerde = {};
  const inner = createInnerWriteStub([]);
  inner.serde = innerSerde;
  const context = createFakeFenceContext();
  const fenced = fencedCheckpointerFactory()(inner, context);

  assert.equal(
    fenced.serde,
    innerSerde,
    "the fenced checkpointer's serde must be the SAME object as the inner saver's, by identity — not a copy or a re-wrap, so the own-value serde a PostgreSQL checkpointer carries (createPostgresCheckpointer's withDeclaredOwnValues wrapping) is kept exactly as constructed",
  );
});

/* -------------------------------------------------------------------------- */
/* Row 5 — a compiled graph runs to completion through the fenced            */
/* checkpointer when the fence passes: a drop-in replacement                 */
/* -------------------------------------------------------------------------- */

test('a graph compiled with the fenced checkpointer runs to completion when the fence passes', async () => {
  const inner = new MemorySaver();
  const context = createFakeFenceContext();
  const fenced = fencedCheckpointerFactory()(inner, context);

  const executeInvestigation = async () => ({
    trial: { status: 'ok', durationMs: 1 },
    evidence: {
      kind: 'log',
      source: 'fixture-tool',
      observedAt: '2026-09-24T00:00:00.000Z',
      statement: 'the fenced checkpointer is a drop-in for a compiled graph',
      rawRef: 'fixture://fenced-checkpointer',
      reliability: 'high',
    },
    payloadFingerprint: 'fenced-checkpointer-v1',
  });

  const runner = createPersistentInvestigationRunner({
    checkpointer: fenced,
    executeInvestigation,
  });

  const result = await runner.start({
    runId: 'run-fenced-checkpointer',
    test: { id: 'test-fenced', tool: 'fixture-tool', input: {} },
  });

  assert.equal(
    result.trials.length,
    1,
    'a graph compiled against the fenced checkpointer must run to completion, producing exactly one Trial',
  );
  assert.equal(result.evidence.length, 1);
  assert.ok(
    context.calls.length > 0,
    "the fence must actually have been exercised by the graph's own checkpoint writes — a passing fence with zero calls would not prove the fenced checkpointer is wired into the write path at all",
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6 (AIC-56 slice F carry-over) — getDeltaChannelHistory delegates to    */
/* the inner saver's own override, rather than falling back to the base      */
/* class's default (which reconstructs history through THIS wrapper's own    */
/* fenced getTuple instead of the inner saver's storage-aware shortcut)      */
/* -------------------------------------------------------------------------- */

/**
 * `BaseCheckpointSaver.getDeltaChannelHistory` (the base class both
 * `MemorySaver` and `FencedCheckpointer` extend) ships a DEFAULT
 * implementation, documented on the class itself as something "savers with
 * direct storage access (e.g. MemorySaver) override for performance".
 * Measured today: `MemorySaver.prototype` carries its own
 * `getDeltaChannelHistory`, and `FencedCheckpointer.prototype` does not — so
 * calling it on a fenced saver runs the INHERITED base default rather than
 * delegating to the inner `MemorySaver`'s own override, and the inner
 * override is never reached at all. Reads are not fenced (this file's own
 * header), so there is no ownership reason for the fenced wrapper to run a
 * different implementation than the one the inner saver chose for itself.
 */
test('getDeltaChannelHistory delegates to the inner saver, not to the inherited base-class default', async () => {
  const inner = new MemorySaver();
  const graph = new StateGraph(ThreadState)
    .addNode('step', async (state) => ({ value: (state.value ?? 0) + 1 }))
    .addEdge(START, 'step')
    .addEdge('step', END)
    .compile({ checkpointer: inner });
  const config = { configurable: { thread_id: 'thread-delta-history' } };
  await graph.invoke({ value: 0 }, config);

  let innerCalls = 0;
  const realGetDeltaChannelHistory = inner.getDeltaChannelHistory.bind(inner);
  inner.getDeltaChannelHistory = async (...args) => {
    innerCalls += 1;
    return realGetDeltaChannelHistory(...args);
  };

  const context = createFakeFenceContext();
  const fenced = fencedCheckpointerFactory()(inner, context);

  const expected = await realGetDeltaChannelHistory({ config, channels: ['value'] });
  const actual = await fenced.getDeltaChannelHistory({ config, channels: ['value'] });

  assert.deepEqual(
    actual,
    expected,
    'getDeltaChannelHistory on the fenced saver must return exactly what the inner saver returns',
  );
  assert.equal(
    innerCalls,
    1,
    "the inner MemorySaver's OWN getDeltaChannelHistory override was never called: the fenced wrapper ran the inherited BaseCheckpointSaver default instead of delegating, which is observable here as a call count of 0 rather than 1",
  );
});

/* -------------------------------------------------------------------------- */
/* Row 7 (AIC-56 slice F carry-over) — the base-class members the fenced      */
/* class does NOT override, as a computed, pinned sentinel                   */
/* -------------------------------------------------------------------------- */

/**
 * `BaseCheckpointSaver`'s own methods that are NOT abstract — `toJSON`,
 * `get`, `getDeltaChannelHistory`, `getNextVersion` (measured today via
 * `Object.getOwnPropertyNames(BaseCheckpointSaver.prototype)`, minus
 * `constructor`; `getTuple`/`list`/`put`/`putWrites`/`deleteThread` are
 * `abstract` in the TypeScript source and carry no compiled implementation on
 * the base prototype at all, so they never appear here regardless of what
 * `FencedCheckpointer` overrides).
 *
 * Of those four, `FencedCheckpointer` overrides `getNextVersion` only
 * (measured today). The other three — `toJSON`, `get`,
 * `getDeltaChannelHistory` — are inherited as-is, which is safe for `toJSON`
 * and `get` (read-only) and, per the row above, a real gap for
 * `getDeltaChannelHistory`.
 *
 * This row is the SENTINEL, not the fix: it pins the exact set the fenced
 * class leaves un-overridden, so a future base-class method this wrapper
 * silently inherits — one that turns out to WRITE — changes this list and
 * goes red here rather than shipping unfenced and unnoticed.
 */
test('pins the exact set of BaseCheckpointSaver members the fenced checkpointer does not override', () => {
  const baseMembers = Object.getOwnPropertyNames(BaseCheckpointSaver.prototype).filter(
    (name) => name !== 'constructor',
  );
  assert.ok(
    baseMembers.length > 0,
    'BaseCheckpointSaver.prototype carries no own member beyond constructor: the sentinel below would then pin an empty set and catch nothing',
  );

  const inner = createInnerWriteStub([]);
  const context = createFakeFenceContext();
  const fenced = fencedCheckpointerFactory()(inner, context);
  const fencedOwnMembers = new Set(
    Object.getOwnPropertyNames(Object.getPrototypeOf(fenced)).filter((name) => name !== 'constructor'),
  );

  const notOverridden = baseMembers.filter((name) => !fencedOwnMembers.has(name)).sort();

  assert.deepEqual(
    notOverridden,
    ['get', 'toJSON'],
    `the set of BaseCheckpointSaver members the fenced checkpointer inherits unfenced changed: found [${notOverridden.join(', ')}]. If a NEW member appears here, decide deliberately whether it needs fencing before updating this pin — that is the point of the sentinel`,
  );
});

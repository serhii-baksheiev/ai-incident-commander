/**
 * AIC-57's own T-4 race harness (`infra/postgres/tests/t4-race.live.mjs`)
 * names its S1-S6 release points against "B's first checkpoint write" and "B's
 * putWrites [...] and B's put" — phrasing that assumes a linear,
 * fully-sequential checkpointer call order. This file pins, without a
 * database, what `createPersistentInvestigationRunner`'s one-node graph
 * ("execute_investigation" -> END) actually does to an in-memory checkpointer
 * on one `start()` call, and the one fact about that order the acceptance item
 * gets WRONG: `putWrites` does not gate anything. LangGraph calls it but does
 * not await its result before issuing the next `put` — a `putWrites` that
 * never resolves at all still lets the run reach its next (and, in this
 * graph, final) checkpoint. `put`, by contrast, genuinely blocks: its return
 * value (the next `checkpoint_id`) is required before the run can proceed, so
 * a `put` held open holds the entire run open with it.
 *
 * ⚠ **This file's exact call ORDER is `MemorySaver`-specific, and does not
 * carry over to the real `PostgresSaver` the live lane uses.** Measured (with
 * a real database, not shown here): against `PostgresSaver`, `put`#1 and
 * `putWrites`#1 are DISPATCHED, then the node itself runs CONCURRENTLY with
 * those two calls' own network round trips — not strictly after `put`#2 the
 * way `MemorySaver`'s synchronous execution makes it look here (row 3 below).
 * `t4-race.live.mjs`'s own header explains this in full and states why its
 * harness gates on the commit itself landing, not on a `put`-call count, for
 * exactly this reason: a call-count barrier that is correct against
 * `MemorySaver` is not provably correct against the real saver the race
 * actually has to hold.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MemorySaver } from '@langchain/langgraph-checkpoint';

import { createPersistentInvestigationRunner } from '@aic/graph';

/**
 * Wraps `inner` in a `Proxy` that appends `{ method, id? }` to `calls` for
 * every `getTuple`/`put`/`putWrites` call, in call order, before delegating.
 * A `Proxy` rather than a hand-written stand-in: this file's whole point is
 * to observe what LangGraph itself calls on a REAL `MemorySaver`, not to
 * assert against a fake that could silently drift from the real saver's
 * shape.
 */
function withCallLog(inner, calls, { onPut, onPutWrites } = {}) {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'getTuple') {
        return async function (...args) {
          calls.push({ method: 'getTuple' });
          return value.apply(target, args);
        };
      }
      if (prop === 'put') {
        return async function (...args) {
          calls.push({ method: 'put', id: args[1]?.id });
          await onPut?.(calls.filter((call) => call.method === 'put').length);
          return value.apply(target, args);
        };
      }
      if (prop === 'putWrites') {
        return async function (...args) {
          calls.push({ method: 'putWrites', writeCount: args[1]?.length });
          const result = value.apply(target, args);
          onPutWrites?.(calls.filter((call) => call.method === 'putWrites').length);
          return result;
        };
      }
      return value;
    },
  });
}

function fixedExecuteInvestigation() {
  return async () => ({
    trial: { status: 'ok', durationMs: 1 },
    evidence: {
      kind: 'log',
      source: 'fixture-tool',
      observedAt: '2026-09-24T00:00:00.000Z',
      statement: 'checkpoint-sequence probe',
      rawRef: 'fixture://checkpoint-sequence',
      reliability: 'high',
    },
    payloadFingerprint: 'checkpoint-sequence-v1',
  });
}

/* -------------------------------------------------------------------------- */
/* The measured order for one start() call: getTuple, put, putWrites, put,   */
/* putWrites, put — never fewer or more                                      */
/* -------------------------------------------------------------------------- */

test('one start() call on the one-node graph calls the checkpointer in exactly this order: getTuple, put, putWrites, put, putWrites, put', async () => {
  const calls = [];
  const checkpointer = withCallLog(new MemorySaver(), calls);
  const runner = createPersistentInvestigationRunner({
    checkpointer,
    executeInvestigation: fixedExecuteInvestigation(),
  });

  await runner.start({
    runId: 'run-checkpoint-sequence-order',
    test: { id: 'test-checkpoint-sequence', tool: 'fixture-tool', input: {} },
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ['getTuple', 'put', 'putWrites', 'put', 'putWrites', 'put'],
    `the one-node graph's checkpointer call order changed from what t4-race.live.mjs is built against: ${JSON.stringify(calls)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* putWrites does not gate progress: a putWrites call that NEVER resolves    */
/* still lets the run reach its NEXT put, and finish                         */
/* -------------------------------------------------------------------------- */

test('a putWrites call does not block the next put: the next put is reached and lands while putWrites is still pending', async () => {
  const events = [];
  const inner = new MemorySaver();
  // A bounded real delay, not an eternally-dangling promise: this is not a
  // race against the timer (the same convention
  // infra/postgres/tests/fenced-checkpointer.live.mjs's own barrier row
  // documents for its `beforeWrite` gate) — 30ms is far longer than an
  // in-memory `put` needs to complete, so `put:called` landing before this
  // delay's `putWrites:resolved` proves LangGraph proceeded WITHOUT waiting
  // for putWrites, for any delay long enough to observe it; it does not
  // depend on 30ms being tuned exactly.
  const PUT_WRITES_DELAY_MS = 30;
  const checkpointer = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'putWrites') {
        return async function (...args) {
          events.push('putWrites:called');
          await new Promise((resolve) => setTimeout(resolve, PUT_WRITES_DELAY_MS));
          events.push('putWrites:resolved');
          return value.apply(target, args);
        };
      }
      if (prop === 'put') {
        return async function (...args) {
          events.push('put:called');
          const result = await value.apply(target, args);
          events.push('put:resolved');
          return result;
        };
      }
      if (prop === 'getTuple') {
        return async function (...args) {
          events.push('getTuple:called');
          return value.apply(target, args);
        };
      }
      return value;
    },
  });

  const runner = createPersistentInvestigationRunner({
    checkpointer,
    executeInvestigation: fixedExecuteInvestigation(),
  });

  const result = await runner.start({
    runId: 'run-checkpoint-sequence-putwrites-nonblocking',
    test: { id: 'test-checkpoint-sequence', tool: 'fixture-tool', input: {} },
  });

  assert.equal(result.trials.length, 1, 'start() must still resolve to a completed result');
  assert.deepEqual(
    events.filter((event) => event.endsWith(':called')),
    ['getTuple', 'put', 'putWrites', 'put', 'putWrites', 'put'].map((method) => `${method}:called`),
    'the call order itself must be unchanged by the delay',
  );

  const firstPutWritesResolvedIndex = events.indexOf('putWrites:resolved');
  const secondPutCalledIndex = events.indexOf(
    'put:called',
    events.indexOf('put:called') + 1, // skip the FIRST put, which precedes the commit entirely
  );
  assert.ok(
    secondPutCalledIndex >= 0 && secondPutCalledIndex < firstPutWritesResolvedIndex,
    `the SECOND put ("checkpoint 2", the first checkpoint write after the node's commit) must have already been called before the FIRST putWrites call's ${PUT_WRITES_DELAY_MS}ms delay elapsed — proving LangGraph does not await putWrites before proceeding. Observed order: ${JSON.stringify(events)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* put DOES gate progress: holding the SECOND put open holds the WHOLE run   */
/* open — no third put, and start() itself does not resolve — until released */
/* -------------------------------------------------------------------------- */

test('holding the second put open holds the whole run open: no third put happens, and start() does not resolve, until it is released', async () => {
  const calls = [];
  const inner = new MemorySaver();
  let putCount = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const checkpointer = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'put') {
        return async function (...args) {
          putCount += 1;
          const thisCall = putCount;
          calls.push({ method: 'put', id: args[1]?.id });
          if (thisCall === 2) {
            await gate;
          }
          return value.apply(target, args);
        };
      }
      if (prop === 'putWrites' || prop === 'getTuple') {
        return async function (...args) {
          calls.push({ method: prop });
          return value.apply(target, args);
        };
      }
      return value;
    },
  });

  const runner = createPersistentInvestigationRunner({
    checkpointer,
    executeInvestigation: fixedExecuteInvestigation(),
  });

  let settled = false;
  const startPromise = runner
    .start({
      runId: 'run-checkpoint-sequence-put-blocks',
      test: { id: 'test-checkpoint-sequence', tool: 'fixture-tool', input: {} },
    })
    .then((value) => {
      settled = true;
      return value;
    });

  // Not a race against this timer (the same convention
  // infra/postgres/tests/fenced-checkpointer.live.mjs's own barrier row
  // documents): the gate never resolves on its own, so ANY delay long enough
  // to let the run's own microtasks drain proves the same thing — the run
  // reached the held put and got no further, because nothing else could have
  // released it.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(
    calls.map((call) => call.method),
    // The SECOND putWrites is here even though the second put has not
    // resolved: putWrites is fire-and-forget with respect to put too, not
    // only with respect to itself (the row above) — measured, not assumed.
    // What holding put#2 DOES stop is the THIRD put: it never appears below.
    ['getTuple', 'put', 'putWrites', 'put', 'putWrites'],
    'while the second put is held, the run must have reached it and dispatched the second putWrites, but must not have reached a third put',
  );
  assert.equal(settled, false, 'start() must not have resolved while its second put is held open');

  release();
  const result = await startPromise;

  assert.equal(settled, true, 'start() must resolve once the held put is released');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['getTuple', 'put', 'putWrites', 'put', 'putWrites', 'put'],
    'once released, the run must reach its third and final put',
  );
  assert.equal(result.trials.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Where the node itself (and so `executeInvestigation`/the commit) falls in  */
/* that order, against MemorySaver specifically — see this file's own ⚠      */
/* above for why this does NOT carry over to the real PostgresSaver          */
/* -------------------------------------------------------------------------- */

test('against MemorySaver, executeInvestigation runs strictly between the second put and the second putWrites', async () => {
  const events = [];
  const inner = new MemorySaver();
  const checkpointer = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'put' || prop === 'putWrites' || prop === 'getTuple') {
        return async function (...args) {
          events.push(`${prop}:start`);
          const result = await value.apply(target, args);
          events.push(`${prop}:end`);
          return result;
        };
      }
      return value;
    },
  });

  const runner = createPersistentInvestigationRunner({
    checkpointer,
    async executeInvestigation(...args) {
      events.push('executeInvestigation:start');
      const result = await fixedExecuteInvestigation()(...args);
      events.push('executeInvestigation:end');
      return result;
    },
  });

  await runner.start({
    runId: 'run-checkpoint-sequence-commit-position',
    test: { id: 'test-checkpoint-sequence', tool: 'fixture-tool', input: {} },
  });

  assert.deepEqual(
    events,
    [
      'getTuple:start',
      'getTuple:end',
      'put:start',
      'put:end',
      'putWrites:start',
      'putWrites:end',
      'put:start',
      'put:end',
      'executeInvestigation:start',
      'executeInvestigation:end',
      'putWrites:start',
      'putWrites:end',
      'put:start',
      'put:end',
    ],
    `against MemorySaver specifically, the node (and so the commit) must run strictly after the SECOND put completes and strictly before the second putWrites starts: ${JSON.stringify(events)}`,
  );
});

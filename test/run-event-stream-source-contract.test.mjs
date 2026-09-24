/**
 * AIC-58, slice a: the pure domain half of the "append-only run_events and
 * reconnect-safe stream source" ticket — the `RunEventStreamSource` port and
 * `RunEvent` shape (compile-time, row 1 below), and `parseLastEventId`, the
 * runtime seam that turns a reconnecting client's `Last-Event-ID` header (a
 * STRING, per the SSE spec) into the `afterSeq` the port's `readAfter`/`tail`
 * take.
 *
 * The half that needs a real PostgreSQL — a real `createRunEventStreamSource`
 * actually tailing committed rows, never before commit, surviving a restart —
 * lives on its own line, `infra/postgres/tests/run-event-stream.live.mjs`, the
 * same separation `run-write-context.test.mjs` / `run-write-context.live.mjs`
 * already use for slice C.
 *
 * ## Design choices this file assumes
 *
 * The ticket names the shape (`RunEventStreamSource`, `RunEvent`,
 * `parseLastEventId`) but not every internal detail. Two choices are stated
 * here rather than discovered mid-assertion:
 *
 *   - `parseLastEventId` throws a named `InvalidLastEventIdError` (mirroring
 *     `@aic/domain`'s existing `StaleOwnerError` / `ExecutionIntegrityViolation`:
 *     an `Error` subclass with a stable `code` and a `.name` equal to its own
 *     class name) rather than a generic `Error` or a return-a-sentinel shape.
 *     Rows below check `instanceof` and `.name`/`.code`, not the exact message
 *     text, so a differently-worded refusal still passes.
 *   - `RunEvent.createdAt` is a `Date` (matching `RunRecord.leaseExpiresAt` /
 *     `.heartbeatAt` in `packages/persistence/src/run-store.ts`, which are
 *     also `Date | null` rather than an ISO string), not a raw driver value.
 *
 * If the implementation has a reason to shape either differently, that reason
 * belongs in the PR description, not in a silent rename here.
 *
 * ## AIC-58 review round 1 — four rows added/changed below
 *
 * Reviewers measured four defects against the slice-a implementation
 * (75fbc33):
 *
 *   1. BLOCKER, contract drift — `parseLastEventId` accepted up to
 *      `Number.MAX_SAFE_INTEGER`, but `aic_app.run_events.seq` is PostgreSQL
 *      `integer` (int4, max 2147483647): a reconnect with a `Last-Event-ID`
 *      above that fails with a raw pg "out of range for type integer" error
 *      rather than a domain refusal. Author's decision: clamp the domain
 *      bound to the storage's range. `MAX_RUN_EVENT_SEQ` (2147483647) replaces
 *      `Number.MAX_SAFE_INTEGER` as `parseLastEventId`'s ceiling — a
 *      deliberate contract change, not a bug fix to the old ceiling. The rows
 *      under "parseLastEventId — the MAX_RUN_EVENT_SEQ ceiling" below pin the
 *      new bound in both directions, including the row that used to be
 *      accepted and must now be refused.
 *   2. BLOCKER, second face — `readAfter` validated nothing: `readAfter(runId,
 *      -5)` silently streamed from the beginning while `tail` (which routes
 *      its `lastEventId` through `parseLastEventId`) refused the same -5.
 *      "readAfter validates its own afterSeq" below pins the same rule,
 *      checked BEFORE any query reaches the stub pool.
 *   3. BLOCKER, test integrity — `limit` and a full backlog larger than one
 *      poll page were never exercised. The paging/backlog rows live in
 *      `infra/postgres/tests/run-event-stream.live.mjs` (they need committed
 *      rows); `readAfter`'s own `limit` validation/clamp is decidable here,
 *      against a stub pool, and is pinned under "readAfter validates its own
 *      limit" below.
 *   4. Security advisory — `pollIntervalMs` had no floor: 0 or NaN drove an
 *      unthrottled poll loop (measured 176 queries/200ms). "tail's poll
 *      interval has a floor" below pins `MIN_RUN_EVENT_POLL_INTERVAL_MS`.
 *
 * `MAX_RUN_EVENT_SEQ` is asserted to be exported by `@aic/domain` (it is the
 * storage-column bound `parseLastEventId` itself enforces); `readAfter`'s
 * limit ceiling (`MAX_RUN_EVENT_READ_LIMIT`) and the poll floor
 * (`MIN_RUN_EVENT_POLL_INTERVAL_MS`) are asserted to be exported by
 * `@aic/persistence`, alongside `createRunEventStreamSource` itself — they
 * bound a SQL `LIMIT` and a poll `setTimeout`, both persistence-layer
 * concerns, not the domain port's own shape.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(projectRoot, 'test/fixtures/run-event-stream-source-type-contract.ts');

/* -------------------------------------------------------------------------- */
/* Row 1 — the compile-time port contract                                     */
/* -------------------------------------------------------------------------- */

test('compiles the run-event-stream-source type contract: a RunEvent-shaped literal satisfies RunEventStreamSource, and a value missing tail is refused', () => {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeContractFixture,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\n@aic/domain must export a RunEvent type ({ runId, seq, type, executionAttempt, payload, createdAt }) and a RunEventStreamSource port ({ readAfter(runId, afterSeq, options?), tail(runId, options?) }) for this fixture to compile — see test/fixtures/run-event-stream-source-type-contract.ts`,
  );
});

/* -------------------------------------------------------------------------- */
/* parseLastEventId — accepts                                                 */
/* -------------------------------------------------------------------------- */

function parseLastEventIdFactory() {
  assert.equal(
    typeof domain.parseLastEventId,
    'function',
    '@aic/domain must export parseLastEventId(value): the runtime seam that turns a reconnecting client\'s Last-Event-ID header into the afterSeq the RunEventStreamSource port takes',
  );
  return domain.parseLastEventId;
}

test('parseLastEventId accepts 0 as a number and returns 0', () => {
  assert.equal(parseLastEventIdFactory()(0), 0);
});

test('parseLastEventId accepts a positive integer number and returns it unchanged', () => {
  assert.equal(parseLastEventIdFactory()(42), 42);
});

test('parseLastEventId accepts "0" as a decimal string and returns the number 0', () => {
  assert.equal(parseLastEventIdFactory()('0'), 0);
});

test('parseLastEventId accepts a positive integer\'s decimal string, as the Last-Event-ID header sends it, and returns a number', () => {
  const parsed = parseLastEventIdFactory()('42');
  assert.equal(parsed, 42);
  assert.equal(typeof parsed, 'number', 'the header arrives as a string; the port\'s afterSeq is a number, so parseLastEventId must convert it');
});

/* -------------------------------------------------------------------------- */
/* parseLastEventId — the MAX_RUN_EVENT_SEQ ceiling (AIC-58 review finding 1) */
/* -------------------------------------------------------------------------- */

/**
 * The independent oracle here is the literal `2147483647` (2^31-1, PostgreSQL
 * `integer`'s own maximum) — never `domain.MAX_RUN_EVENT_SEQ` read back from
 * the module under test, or a mismatch between the constant and this literal
 * would agree with itself and prove nothing.
 */
const POSTGRES_INTEGER_MAX = 2147483647;

test('@aic/domain exports MAX_RUN_EVENT_SEQ equal to 2147483647 — the PostgreSQL "integer" ceiling backing aic_app.run_events.seq, not Number.MAX_SAFE_INTEGER', () => {
  assert.equal(
    typeof domain.MAX_RUN_EVENT_SEQ,
    'number',
    '@aic/domain must export MAX_RUN_EVENT_SEQ: the storage-column bound parseLastEventId enforces (AIC-58 review finding 1)',
  );
  assert.equal(
    domain.MAX_RUN_EVENT_SEQ,
    POSTGRES_INTEGER_MAX,
    'MAX_RUN_EVENT_SEQ must equal 2^31-1, the exact maximum of a PostgreSQL "integer" column — see infra/postgres/tests/run-event-stream.live.mjs\'s live correspondence row for the other half of this pin (the column\'s own information_schema type)',
  );
});

test('parseLastEventId accepts MAX_RUN_EVENT_SEQ (2147483647), both as a number and as its decimal string — deliberate contract change from Number.MAX_SAFE_INTEGER (AIC-58 review finding 1)', () => {
  assert.equal(parseLastEventIdFactory()(POSTGRES_INTEGER_MAX), POSTGRES_INTEGER_MAX);
  assert.equal(parseLastEventIdFactory()(String(POSTGRES_INTEGER_MAX)), POSTGRES_INTEGER_MAX);
});

/* -------------------------------------------------------------------------- */
/* parseLastEventId — refuses                                                 */
/* -------------------------------------------------------------------------- */

function invalidLastEventIdErrorFactory() {
  assert.equal(
    typeof domain.InvalidLastEventIdError,
    'function',
    '@aic/domain must export InvalidLastEventIdError (an Error subclass, mirroring StaleOwnerError / ExecutionIntegrityViolation in execution.ts): parseLastEventId\'s refusal must be a named, catchable error, not a bare Error or a return-a-sentinel shape',
  );
  return domain.InvalidLastEventIdError;
}

function assertRefused(value, description) {
  const InvalidLastEventIdError = invalidLastEventIdErrorFactory();
  assert.throws(
    () => parseLastEventIdFactory()(value),
    (error) =>
      error instanceof InvalidLastEventIdError &&
      error instanceof Error &&
      error.name === 'InvalidLastEventIdError' &&
      typeof error.code === 'string' &&
      error.code.length > 0,
    `parseLastEventId(${JSON.stringify(value)}) must throw a named InvalidLastEventIdError (${description})`,
  );
}

test('parseLastEventId refuses a negative integer number', () => {
  assertRefused(-1, 'negative');
});

test('parseLastEventId refuses a negative integer\'s decimal string', () => {
  assertRefused('-1', 'negative');
});

test('parseLastEventId refuses a fractional number', () => {
  assertRefused(1.5, 'fractional');
});

test('parseLastEventId refuses a fractional decimal string', () => {
  assertRefused('1.5', 'fractional');
});

test('parseLastEventId refuses a non-numeric string', () => {
  assertRefused('abc', 'non-numeric');
});

test('parseLastEventId refuses the empty string', () => {
  assertRefused('', 'empty');
});

test('parseLastEventId refuses a value one past MAX_RUN_EVENT_SEQ (2147483648), both as a number and as its decimal string — deliberate contract change: run_events.seq is a PostgreSQL integer (int4, max 2147483647), never bigint', () => {
  assertRefused(POSTGRES_INTEGER_MAX + 1, '> MAX_RUN_EVENT_SEQ (2147483647)');
  assertRefused(String(POSTGRES_INTEGER_MAX + 1), '> MAX_RUN_EVENT_SEQ (2147483647)');
});

test('parseLastEventId now refuses Number.MAX_SAFE_INTEGER itself, both as a number and as its decimal string — it exceeds the new MAX_RUN_EVENT_SEQ ceiling; the old, wider ceiling was exactly the contract drift AIC-58 review finding 1 measured against a real PostgreSQL "out of range for type integer" error', () => {
  assertRefused(Number.MAX_SAFE_INTEGER, 'exceeds MAX_RUN_EVENT_SEQ (2147483647)');
  assertRefused(String(Number.MAX_SAFE_INTEGER), 'exceeds MAX_RUN_EVENT_SEQ (2147483647)');
});

test('parseLastEventId refuses a decimal string far beyond MAX_RUN_EVENT_SEQ (never silently rounded through Number())', () => {
  assertRefused('99999999999999999999999999', 'far beyond MAX_RUN_EVENT_SEQ');
});

test('parseLastEventId refuses NaN and Infinity, which are numbers but never a valid sequence position', () => {
  assertRefused(Number.NaN, 'NaN');
  assertRefused(Number.POSITIVE_INFINITY, 'Infinity');
});

test('parseLastEventId refuses null, undefined, a boolean, an array and a plain object', () => {
  for (const value of [null, undefined, true, false, [], {}, [42]]) {
    assertRefused(value, `typeof ${typeof value}`);
  }
});

/* -------------------------------------------------------------------------- */
/* @aic/persistence's createRunEventStreamSource, against a STUB pool — the   */
/* half of AIC-58 review findings 2, 3 and 4 that needs no database: a fake   */
/* `{ query }` object is enough to prove readAfter validates BEFORE querying, */
/* clamps its limit, and that tail's poll floor bounds the query rate. The    */
/* paging/backlog rows that need real committed data live in                  */
/* infra/postgres/tests/run-event-stream.live.mjs.                            */
/* -------------------------------------------------------------------------- */

function createRunEventStreamSourceFactory() {
  assert.equal(
    typeof persistence.createRunEventStreamSource,
    'function',
    '@aic/persistence must export createRunEventStreamSource(pool, options?)',
  );
  return persistence.createRunEventStreamSource;
}

/**
 * A `pg.Pool`-shaped stub: `query` never touches a database, just records
 * every call (`sql`, `params`) and answers with `rows`. Good enough for
 * `createRunEventStreamSource`, which only ever calls `pool.query(sql,
 * params)` — never anything else on the pool.
 */
function stubPool(rows = []) {
  const calls = [];
  return {
    calls,
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows };
      },
    },
  };
}

/* ---- readAfter validates its own afterSeq (AIC-58 review finding 2) ------ */

test('readAfter refuses a negative, fractional, NaN or > MAX_RUN_EVENT_SEQ afterSeq with the same InvalidLastEventIdError tail\'s lastEventId is refused with — readAfter must not silently stream from the beginning', async () => {
  const InvalidLastEventIdError = invalidLastEventIdErrorFactory();
  const stub = stubPool();
  const source = createRunEventStreamSourceFactory()(stub.pool);

  for (const afterSeq of [-5, -1, 1.5, Number.NaN, POSTGRES_INTEGER_MAX + 1]) {
    await assert.rejects(
      () => source.readAfter('run-invalid-afterseq', afterSeq),
      (error) =>
        error instanceof InvalidLastEventIdError &&
        error.name === 'InvalidLastEventIdError' &&
        typeof error.code === 'string' &&
        error.code.length > 0,
      `readAfter(runId, ${afterSeq}) must refuse with InvalidLastEventIdError, not silently stream from the beginning the way it does today`,
    );
  }

  assert.equal(
    stub.calls.length,
    0,
    'every one of the afterSeq values above must be refused BEFORE any query reaches the pool — the bug this pins is readAfter(runId, -5) issuing a query at all',
  );
});

test('readAfter(runId, 0) — a valid afterSeq — does reach the pool, so the row above is not vacuously passing because every call is refused', async () => {
  const stub = stubPool();
  const source = createRunEventStreamSourceFactory()(stub.pool);

  await source.readAfter('run-valid-afterseq', 0);

  assert.equal(stub.calls.length, 1, 'a valid afterSeq must still issue exactly one query');
});

/* ---- readAfter validates its own limit (AIC-58 review finding 3c) -------- */

function maxRunEventReadLimitFactory() {
  assert.equal(
    typeof persistence.MAX_RUN_EVENT_READ_LIMIT,
    'number',
    '@aic/persistence must export MAX_RUN_EVENT_READ_LIMIT: the ceiling readAfter clamps an oversized caller-supplied limit to (AIC-58 review finding 3c)',
  );
  return persistence.MAX_RUN_EVENT_READ_LIMIT;
}

test('readAfter refuses a non-positive or non-integer limit before issuing any query', async () => {
  const stub = stubPool();
  const source = createRunEventStreamSourceFactory()(stub.pool);

  for (const limit of [0, -1, -100, 1.5, Number.NaN]) {
    await assert.rejects(
      () => source.readAfter('run-invalid-limit', 0, { limit }),
      `readAfter(runId, 0, { limit: ${limit} }) must be refused rather than silently issuing a nonsensical or unbounded query`,
    );
  }

  assert.equal(stub.calls.length, 0, 'a refused limit must never reach the pool');
});

test('readAfter clamps a limit above MAX_RUN_EVENT_READ_LIMIT to that ceiling, rather than passing the caller\'s oversized value straight into the SQL LIMIT parameter', async () => {
  const ceiling = maxRunEventReadLimitFactory();
  const stub = stubPool();
  const source = createRunEventStreamSourceFactory()(stub.pool);

  await source.readAfter('run-oversized-limit', 0, { limit: ceiling + 100_000 });

  assert.equal(stub.calls.length, 1, 'a within-range-after-clamping call must still issue exactly one query');
  assert.equal(
    stub.calls[0].params.at(-1),
    ceiling,
    'the query\'s own LIMIT parameter (the array\'s last bound value) must be clamped to MAX_RUN_EVENT_READ_LIMIT, never the caller\'s raw oversized value',
  );
});

/* ---- tail's poll interval has a floor (AIC-58 review finding 4) ---------- */

function minRunEventPollIntervalFactory() {
  assert.equal(
    typeof persistence.MIN_RUN_EVENT_POLL_INTERVAL_MS,
    'number',
    '@aic/persistence must export MIN_RUN_EVENT_POLL_INTERVAL_MS: the floor tail raises an unthrottled (0, negative or NaN) pollIntervalMs to (AIC-58 review finding 4 — a security advisory: measured 176 queries/200ms with no floor)',
  );
  assert.ok(
    persistence.MIN_RUN_EVENT_POLL_INTERVAL_MS <= 20,
    'MIN_RUN_EVENT_POLL_INTERVAL_MS must be <= 20 so every existing row using pollIntervalMs: 20 (the live suite\'s convention) keeps behaving as an explicit, unfloored interval rather than being silently raised further',
  );
  return persistence.MIN_RUN_EVENT_POLL_INTERVAL_MS;
}

/** An empty-forever pool: `tail` never yields, so it only ever sleeps and re-polls. */
function stubEmptyPool() {
  return stubPool([]);
}

test(
  'tail given pollIntervalMs 0 is raised to MIN_RUN_EVENT_POLL_INTERVAL_MS, bounding its poll rate rather than looping unthrottled (measured before this floor: 176 queries/200ms)',
  { timeout: 10_000 },
  async () => {
    const floor = minRunEventPollIntervalFactory();
    const stub = stubEmptyPool();
    const source = createRunEventStreamSourceFactory()(stub.pool);

    const controller = new AbortController();
    const windowMs = 200;
    const drain = (async () => {
      for await (const _event of source.tail('run-unthrottled', { lastEventId: 0, pollIntervalMs: 0, signal: controller.signal })) {
        // the stub pool never returns a row, so this body never runs
      }
    })();

    await new Promise((resolve) => {
      setTimeout(resolve, windowMs);
    });
    controller.abort();
    await drain;

    // A small, explicit slack on top of the floor-derived bound — not a magic
    // number: window/floor is the number of polls a perfectly-floored loop
    // fits in windowMs, +5 covers scheduling jitter around the boundary.
    const bound = Math.ceil(windowMs / floor) + 5;
    assert.ok(
      stub.calls.length <= bound,
      `tail({ pollIntervalMs: 0 }) issued ${stub.calls.length} queries in ${windowMs}ms; expected at most ${bound} once 0 is raised to MIN_RUN_EVENT_POLL_INTERVAL_MS (${floor}ms) — an unfloored interval measured 176 queries/200ms`,
    );
  },
);

/**
 * AIC-58 review round 2 (security-scanner advisory): the floor alone bounded
 * the poll rate from below only. `setTimeout` treats any delay above
 * 2147483647 ms (and a non-finite one) as 1 ms, so a pollIntervalMs of
 * Infinity or past that limit looped almost unthrottled. The same bound as the
 * floor rows applies to those values too.
 */
test(
  'tail given Infinity or a pollIntervalMs past setTimeout\'s 2147483647 ms limit is still bounded, never treated as a 1 ms sleep',
  { timeout: 10_000 },
  async () => {
    const floor = minRunEventPollIntervalFactory();

    for (const pollIntervalMs of [Number.POSITIVE_INFINITY, 2147483648, 1e12]) {
      const stub = stubEmptyPool();
      const source = createRunEventStreamSourceFactory()(stub.pool);
      const controller = new AbortController();
      const windowMs = 150;
      const drain = (async () => {
        for await (const _event of source.tail('run-unthrottled-3', { lastEventId: 0, pollIntervalMs, signal: controller.signal })) {
          // the stub pool never returns a row, so this body never runs
        }
      })();

      await new Promise((resolve) => {
        setTimeout(resolve, windowMs);
      });
      controller.abort();
      await drain;

      const bound = Math.ceil(windowMs / floor) + 5;
      assert.ok(
        stub.calls.length <= bound,
        `tail({ pollIntervalMs: ${pollIntervalMs} }) issued ${stub.calls.length} queries in ${windowMs}ms; expected at most ${bound} — setTimeout must never see a delay it would turn into 1ms`,
      );
    }
  },
);

test(
  'tail given a negative or NaN pollIntervalMs is also raised to MIN_RUN_EVENT_POLL_INTERVAL_MS, the same as 0',
  { timeout: 10_000 },
  async () => {
    const floor = minRunEventPollIntervalFactory();

    for (const pollIntervalMs of [-1, Number.NaN]) {
      const stub = stubEmptyPool();
      const source = createRunEventStreamSourceFactory()(stub.pool);
      const controller = new AbortController();
      const windowMs = 150;
      const drain = (async () => {
          for await (const _event of source.tail('run-unthrottled-2', { lastEventId: 0, pollIntervalMs, signal: controller.signal })) {
          // the stub pool never returns a row, so this body never runs
        }
      })();

      await new Promise((resolve) => {
        setTimeout(resolve, windowMs);
      });
      controller.abort();
      await drain;

      const bound = Math.ceil(windowMs / floor) + 5;
      assert.ok(
        stub.calls.length <= bound,
        `tail({ pollIntervalMs: ${pollIntervalMs} }) issued ${stub.calls.length} queries in ${windowMs}ms; expected at most ${bound} once it is raised to MIN_RUN_EVENT_POLL_INTERVAL_MS (${floor}ms)`,
      );
    }
  },
);

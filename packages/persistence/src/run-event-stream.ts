import type { Pool } from 'pg';

import { parseLastEventId, type RunEvent, type RunEventStreamSource } from '@aic/domain';

import { APPLICATION_SCHEMA } from './app-schema.js';

/**
 * AIC-58, slice a: a durable, tail/poll `RunEventStreamSource` over
 * `aic_app.run_events` (append-only, `PRIMARY KEY (run_id, seq)`). See
 * test/run-event-stream-source-contract.test.mjs (the domain port this
 * implements) and infra/postgres/tests/run-event-stream.live.mjs (this
 * module's own spec: the reconnect protocol, commit-visibility ordering,
 * process-restart durability, signal-bounded `tail`, and run isolation).
 *
 * The exactly-once, in-order guarantee `tail`/`readAfter` present rests
 * entirely on the writer's side: `run-write-context.ts`'s `appendEvent`
 * allocates each row's `seq` from the run's own `run_event_counters` row in
 * the SAME transaction that inserts the `run_events` row, so this module
 * never has to detect or paper over a gap — it only ever reads what already
 * committed in strictly increasing order.
 *
 * No `LISTEN`/`NOTIFY` in this slice — `tail` polls `readAfter` on an
 * interval, which is the simplest thing that satisfies the ticket; a
 * push-based follow-up is a later slice's decision, not this one's.
 */

/** `createRunEventStreamSource`'s own options. */
export interface RunEventStreamSourceOptions {
  /** `tail`'s poll interval when its own call does not specify one. Default 250ms, bounded by `normalizePollIntervalMs` (the floor `MIN_RUN_EVENT_POLL_INTERVAL_MS`, and the timer limit). */
  readonly pollIntervalMs?: number;
  /** Bounds every poll `tail` issues internally (validated/clamped like `readAfter`'s own `limit`). Default `DEFAULT_READ_LIMIT`. */
  readonly pageSize?: number;
}

/** `readAfter`'s own options. */
interface ReadAfterOptions {
  readonly limit?: number;
}

/** `tail`'s own options. */
interface TailOptions {
  readonly lastEventId?: number | string;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
}

/** Bounds a single `readAfter` call, and a single poll inside `tail`, when the caller names no limit/pageSize of its own. */
const DEFAULT_READ_LIMIT = 500;

const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * The ceiling `readAfter`'s own `limit` (and `createRunEventStreamSource`'s
 * `pageSize`) is clamped to — never passed straight into the SQL `LIMIT`
 * parameter uncapped (AIC-58 review round 1, finding 3c).
 */
export const MAX_RUN_EVENT_READ_LIMIT = 1000;

/**
 * The floor `tail` raises an unthrottled (0, negative or `NaN`)
 * `pollIntervalMs` to, bounding its poll rate (AIC-58 review round 1, finding
 * 4 — a security advisory). Kept
 * `<= 20` so every existing row using `pollIntervalMs: 20` (the live suite's
 * convention) keeps behaving as an explicit, unfloored interval.
 */
export const MIN_RUN_EVENT_POLL_INTERVAL_MS = 10;

/**
 * Validates a caller-supplied `readAfter`/`pageSize` limit (a positive
 * integer, or `undefined` for the default), then clamps it to `ceiling` —
 * never letting an oversized value reach the SQL `LIMIT` parameter uncapped.
 *
 * @throws {Error} when `limit` is not a positive integer.
 */
function normalizeReadLimit(limit: number | undefined, ceiling: number): number {
  if (limit === undefined) return Math.min(DEFAULT_READ_LIMIT, ceiling);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`invalid limit: ${JSON.stringify(limit)} — must be a positive integer`);
  }
  return Math.min(limit, ceiling);
}

/** The largest delay `setTimeout` honours; above it (or non-finite) it sleeps 1 ms instead. */
const MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Raises a non-finite, negative or below-floor poll interval to `floor`, and
 * lowers one past `MAX_TIMER_DELAY_MS` to it, so `setTimeout` never receives a
 * delay it would turn into a 1 ms sleep.
 */
function normalizePollIntervalMs(pollIntervalMs: number, floor: number): number {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < floor) return floor;
  return Math.min(pollIntervalMs, MAX_TIMER_DELAY_MS);
}

function toRunEvent(row: {
  run_id: string;
  seq: number;
  type: string;
  execution_attempt: number;
  payload: unknown;
  created_at: Date;
}): RunEvent {
  return {
    runId: row.run_id,
    seq: Number(row.seq),
    type: row.type,
    executionAttempt: Number(row.execution_attempt),
    payload: row.payload,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

/**
 * One parameterized `SELECT` on `aic_app.run_events`, served by the table's
 * own primary key (`run_id, seq`): every committed event of `runId` strictly
 * after `afterSeq`, in ascending `seq` order, bounded by `limit`
 * (`DEFAULT_READ_LIMIT` when the caller names none, clamped to
 * `MAX_RUN_EVENT_READ_LIMIT` either way — no unbounded read).
 *
 * `afterSeq` is validated with the same rule `parseLastEventId` enforces on a
 * reconnecting client's `Last-Event-ID` header — reused, not reimplemented —
 * BEFORE any query reaches the pool (AIC-58 review round 1, finding 2).
 *
 * @throws {import('@aic/domain').InvalidLastEventIdError} when `afterSeq` is invalid.
 * @throws {Error} when `options.limit` is not a positive integer.
 */
async function readAfter(pool: Pool, runId: string, afterSeq: number, options: ReadAfterOptions = {}): Promise<readonly RunEvent[]> {
  const validatedAfterSeq = parseLastEventId(afterSeq);
  const limit = normalizeReadLimit(options.limit, MAX_RUN_EVENT_READ_LIMIT);
  const { rows } = await pool.query<{
    run_id: string;
    seq: number;
    type: string;
    execution_attempt: number;
    payload: unknown;
    created_at: Date;
  }>(
    `SELECT run_id, seq, type, execution_attempt, payload, created_at
     FROM "${APPLICATION_SCHEMA}".run_events
     WHERE run_id = $1 AND seq > $2
     ORDER BY seq
     LIMIT $3`,
    [runId, validatedAfterSeq, limit],
  );
  return rows.map(toRunEvent);
}

/** Resolves after `ms`, or immediately once `signal` aborts — never leaving `tail` waiting out a poll it can no longer deliver to. */
function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resumes exactly after `options.lastEventId` (parsed by `parseLastEventId` —
 * a non-negative integer or its decimal string, defaulting to 0: a fresh,
 * never-reconnected client), yielding each newly committed event once, in
 * order, advancing its cursor as it goes, and sleeping `pollIntervalMs`
 * (bounded by `normalizePollIntervalMs`) between empty polls. Each
 * poll is one bounded `readAfter` call, limited to `pageSize` — no unbounded
 * buffering, and a backlog larger than one page is paged rather than read in
 * a single unbounded poll. Ends promptly once `options.signal` aborts,
 * whether already aborted before the first poll or aborted mid-sleep.
 */
async function* tail(
  pool: Pool,
  runId: string,
  options: TailOptions,
  defaultPollIntervalMs: number,
  pageSize: number,
): AsyncGenerator<RunEvent, void, void> {
  const { signal } = options;
  const pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs ?? defaultPollIntervalMs, MIN_RUN_EVENT_POLL_INTERVAL_MS);
  let cursor = parseLastEventId(options.lastEventId ?? 0);

  for (;;) {
    if (signal?.aborted) return;

    const events = await readAfter(pool, runId, cursor, { limit: pageSize });
    for (const event of events) {
      if (signal?.aborted) return;
      yield event;
      cursor = event.seq;
    }

    if (signal?.aborted) return;
    if (events.length === 0) {
      await sleepOrAbort(pollIntervalMs, signal);
    }
  }
}

/**
 * Builds a `RunEventStreamSource` over `pool` (the store's own `pg.Pool`,
 * reused rather than dialing a second one — the same convention
 * `openRunWriteContext(store, claim)` follows).
 */
export function createRunEventStreamSource(pool: Pool, options: RunEventStreamSourceOptions = {}): RunEventStreamSource {
  const defaultPollIntervalMs = normalizePollIntervalMs(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    MIN_RUN_EVENT_POLL_INTERVAL_MS,
  );
  const pageSize = normalizeReadLimit(options.pageSize, MAX_RUN_EVENT_READ_LIMIT);
  return {
    readAfter: (runId, afterSeq, readOptions) => readAfter(pool, runId, afterSeq, readOptions ?? {}),
    tail: (runId, tailOptions) => tail(pool, runId, tailOptions ?? {}, defaultPollIntervalMs, pageSize),
  };
}

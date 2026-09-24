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
 * No `LISTEN`/`NOTIFY` in this slice — `tail` polls `readAfter` on an
 * interval, which is the simplest thing that satisfies the ticket; a
 * push-based follow-up is a later slice's decision, not this one's.
 */

/** `createRunEventStreamSource`'s own options. */
export interface RunEventStreamSourceOptions {
  /** `tail`'s poll interval when its own call does not specify one. Default 250ms. */
  readonly pollIntervalMs?: number;
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

/** Bounds a single `readAfter` call, and a single poll inside `tail`, when the caller names no limit of its own. */
const DEFAULT_READ_LIMIT = 500;

const DEFAULT_POLL_INTERVAL_MS = 250;

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
 * (`DEFAULT_READ_LIMIT` when the caller names none — no unbounded read).
 */
async function readAfter(pool: Pool, runId: string, afterSeq: number, options: ReadAfterOptions = {}): Promise<readonly RunEvent[]> {
  const limit = options.limit ?? DEFAULT_READ_LIMIT;
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
    [runId, afterSeq, limit],
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
 * between empty polls. Each poll is one bounded `readAfter` call — no
 * unbounded buffering. Ends promptly once `options.signal` aborts, whether
 * already aborted before the first poll or aborted mid-sleep.
 */
async function* tail(pool: Pool, runId: string, options: TailOptions, defaultPollIntervalMs: number): AsyncGenerator<RunEvent, void, void> {
  const { signal, pollIntervalMs = defaultPollIntervalMs } = options;
  let cursor = parseLastEventId(options.lastEventId ?? 0);

  for (;;) {
    if (signal?.aborted) return;

    const events = await readAfter(pool, runId, cursor, { limit: DEFAULT_READ_LIMIT });
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
  const defaultPollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return {
    readAfter: (runId, afterSeq, readOptions) => readAfter(pool, runId, afterSeq, readOptions ?? {}),
    tail: (runId, tailOptions) => tail(pool, runId, tailOptions ?? {}, defaultPollIntervalMs),
  };
}

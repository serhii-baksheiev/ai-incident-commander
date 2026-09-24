/**
 * AIC-58, slice a: the pure domain half of "an append-only run timeline and a
 * reconnect-safe stream source" — the `RunEvent` shape, the
 * `RunEventStreamSource` port, and `parseLastEventId`, the runtime seam that
 * turns a reconnecting client's `Last-Event-ID` header (a STRING, per the SSE
 * spec) into the `afterSeq` the port's `readAfter`/`tail` take.
 *
 * `@aic/persistence`'s `createRunEventStreamSource(pool, options?)` is the
 * storage-backed implementation; see
 * test/run-event-stream-source-contract.test.mjs (this file's spec, the half
 * decidable without a database) and
 * infra/postgres/tests/run-event-stream.live.mjs (the half that needs one).
 *
 * `RunEvent.createdAt` is a `Date`, matching `RunRecord.leaseExpiresAt` /
 * `.heartbeatAt` in `packages/persistence/src/run-store.ts` — a raw driver
 * value never crosses this port.
 */

/** One row of a run's append-only event timeline. */
export interface RunEvent {
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly executionAttempt: number;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/**
 * The port through which a caller reads or tails one run's committed event
 * timeline (`RunEvent`, above). `readAfter` is a single bounded read;
 * `tail` is a long-lived, reconnect-safe stream that resumes exactly after
 * `options.lastEventId` (accepting the same shapes `parseLastEventId` does)
 * and ends when `options.signal` aborts.
 */
export interface RunEventStreamSource {
  readAfter(
    runId: string,
    afterSeq: number,
    options?: { readonly limit?: number },
  ): Promise<readonly RunEvent[]>;
  tail(
    runId: string,
    options?: {
      readonly lastEventId?: number | string;
      readonly signal?: AbortSignal;
      readonly pollIntervalMs?: number;
    },
  ): AsyncGenerator<RunEvent, void, void>;
}

/**
 * Raised by `parseLastEventId` for any value that is not a non-negative
 * integer within `Number.MAX_SAFE_INTEGER`, whether given as a number or as
 * its decimal string (mirroring `StaleOwnerError` / `ExecutionIntegrityViolation`
 * in `execution.ts`: a named, catchable `Error` subclass with a stable
 * `code`, never a bare `Error` or a return-a-sentinel shape). See
 * test/run-event-stream-source-contract.test.mjs's "parseLastEventId
 * refuses" block.
 */
export class InvalidLastEventIdError extends Error {
  readonly code = 'run_event_stream.invalid_last_event_id' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidLastEventIdError';
  }
}

/** A caller-supplied value as a refusal message may echo it, bounded and safe to stringify. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return `<unprintable ${typeof value}>`;
  }
}

const NON_NEGATIVE_INTEGER_DECIMAL = /^(?:0|[1-9]\d*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Turns a reconnecting client's `Last-Event-ID` header into the `afterSeq`
 * value `RunEventStreamSource.readAfter`/`.tail` take: accepts a
 * non-negative integer number, or its decimal string exactly as the header
 * sends it, up to `Number.MAX_SAFE_INTEGER`. A decimal string beyond that
 * bound is refused outright — never rounded through `Number()`, which would
 * silently accept a value it cannot represent exactly; the comparison runs
 * on `BigInt` instead. Refuses a negative or fractional value, `NaN` and
 * `Infinity`, and anything that is not a number or a string (`null`,
 * `undefined`, a boolean, an array, a plain object).
 *
 * See test/run-event-stream-source-contract.test.mjs's "parseLastEventId
 * accepts" and "parseLastEventId refuses" blocks.
 *
 * @throws {InvalidLastEventIdError} when `value` is not a valid Last-Event-ID.
 */
export function parseLastEventId(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new InvalidLastEventIdError(`invalid Last-Event-ID: ${describe(value)}`);
  }

  if (typeof value === 'string') {
    if (NON_NEGATIVE_INTEGER_DECIMAL.test(value)) {
      const asBigInt = BigInt(value);
      if (asBigInt <= MAX_SAFE_INTEGER_BIGINT) return Number(asBigInt);
    }
    throw new InvalidLastEventIdError(`invalid Last-Event-ID: ${describe(value)}`);
  }

  throw new InvalidLastEventIdError(`invalid Last-Event-ID: ${describe(value)}`);
}

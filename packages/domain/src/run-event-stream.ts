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
 * integer within `MAX_RUN_EVENT_SEQ`, whether given as a number or as
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

/**
 * The storage-column bound `parseLastEventId` enforces: the application
 * schema's own sequence column for this port is PostgreSQL `integer` (int4),
 * whose maximum is 2^31-1, not `bigint` — see
 * `infra/postgres/tests/run-event-stream.live.mjs`'s "LIVE correspondence" row,
 * which reddens in either direction if the column or this constant ever
 * drifts from the other (AIC-58 review round 1, finding 1). This module names
 * no table: `packages/persistence` owns that boundary
 * (test/postgres-checkpointer.test.mjs's storage-surface scan).
 */
export const MAX_RUN_EVENT_SEQ = 2147483647;
const MAX_RUN_EVENT_SEQ_BIGINT = BigInt(MAX_RUN_EVENT_SEQ);

/**
 * Turns a reconnecting client's `Last-Event-ID` header into the `afterSeq`
 * value `RunEventStreamSource.readAfter`/`.tail` take: accepts a
 * non-negative integer number, or its decimal string exactly as the header
 * sends it, up to `MAX_RUN_EVENT_SEQ` (2147483647 — the storage column's own
 * PostgreSQL `integer` maximum, not `Number.MAX_SAFE_INTEGER`). A decimal
 * string beyond that bound is refused outright — never rounded through
 * `Number()`, which would silently accept a value it cannot represent
 * exactly; the comparison runs on `BigInt` instead. Refuses a negative or
 * fractional value, `NaN` and `Infinity`, and anything that is not a number
 * or a string (`null`, `undefined`, a boolean, an array, a plain object).
 *
 * See test/run-event-stream-source-contract.test.mjs's "parseLastEventId
 * accepts" and "parseLastEventId refuses" blocks.
 *
 * @throws {InvalidLastEventIdError} when `value` is not a valid Last-Event-ID.
 */
export function parseLastEventId(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_RUN_EVENT_SEQ) return value;
    throw new InvalidLastEventIdError(`invalid Last-Event-ID: ${describe(value)}`);
  }

  if (typeof value === 'string') {
    if (NON_NEGATIVE_INTEGER_DECIMAL.test(value)) {
      const asBigInt = BigInt(value);
      if (asBigInt <= MAX_RUN_EVENT_SEQ_BIGINT) return Number(asBigInt);
    }
    throw new InvalidLastEventIdError(`invalid Last-Event-ID: ${describe(value)}`);
  }

  throw new InvalidLastEventIdError(`invalid Last-Event-ID: ${describe(value)}`);
}

/**
 * AIC-58, slice c: "payloads reference IDs, never raw bodies" — a closed
 * registry naming, for each event `type` `run-write-context.ts` writes today,
 * exactly the keys its payload may carry. The registry names the ALLOWED keys
 * per type, not the required ones: `execution.integrity_violation` is written
 * with two different literal shapes (`{execKey, reason}` and `{execKey,
 * storedResultSha, computedResultSha}`), so its entry is the union of both.
 * See test/run-event-payload-contract.test.mjs, whose correspondence rows
 * scan `run-write-context.ts`'s own source text (never this registry's logic)
 * in both directions, so this list and what production actually writes can
 * never silently drift apart. This module names no table — see
 * `MAX_RUN_EVENT_SEQ`'s own comment above.
 */
export const RUN_EVENT_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'node_result.committed': Object.freeze(['execKey']),
  'node_result.reused': Object.freeze(['execKey']),
  'execution.integrity_violation': Object.freeze(['execKey', 'reason', 'storedResultSha', 'computedResultSha']),
  'run.waiting_human': Object.freeze(['interactionId']),
  'run.completed': Object.freeze(['reason']),
  'run.failed': Object.freeze(['reason']),
});

/**
 * The cap `assertRunEventPayload` enforces on each individual STRING VALUE of
 * a run event's payload — not a total serialized-size budget. The ticket
 * calls out oversized strings ("a string longer than an exported cap"), not a
 * total-byte budget. Inclusive: a string of exactly this many characters is
 * accepted.
 */
export const MAX_RUN_EVENT_PAYLOAD_STRING = 256;

/**
 * Raised by `assertRunEventPayload` for any refused payload, whatever the
 * reason — mirroring `InvalidLastEventIdError`'s one-code-per-class
 * convention: a single stable `.code` (`'run_event_payload.invalid'`) across
 * every refusal shape, with reasons distinguished only in the message text.
 * See test/run-event-payload-contract.test.mjs.
 *
 * Its message never echoes an unbounded value: a refused oversized string is
 * named by its type, its key and its length, never by its own text — the
 * cross-cutting rule `.claude/rules/invariants.md` states for a refusal that
 * can see attacker- or user-supplied data.
 */
export class RunEventPayloadError extends Error {
  readonly code = 'run_event_payload.invalid' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunEventPayloadError';
  }
}

/** A bounded, safe-to-print label for a value's kind — never its own content. */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * The refusal seam every run event write routes through before it is
 * appended (`run-write-context.ts`'s `appendEvent`, before `nextSeq`, so a
 * refusal here throws inside the fenced transaction and the whole write rolls
 * back — see infra/postgres/tests/run-event-payload.live.mjs). Refuses: a
 * `type` outside `RUN_EVENT_PAYLOAD_KEYS`, a `payload` that is not a plain
 * object, a key outside the registered set for that `type` (including a key
 * borrowed from a different type), a value that is neither a string nor
 * `null`, and a string value past `MAX_RUN_EVENT_PAYLOAD_STRING` (the cap is
 * inclusive). See test/run-event-payload-contract.test.mjs.
 *
 * @throws {RunEventPayloadError} when `payload` is not valid for `type`.
 */
export function assertRunEventPayload(type: string, payload: unknown): void {
  const allowedKeys = RUN_EVENT_PAYLOAD_KEYS[type];
  if (allowedKeys === undefined) {
    throw new RunEventPayloadError(`run event: unknown event type ${JSON.stringify(type)}`);
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new RunEventPayloadError(
      `run event: payload for "${type}" must be a plain object, got ${describeKind(payload)}`,
    );
  }

  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (!allowedKeys.includes(key)) {
      throw new RunEventPayloadError(`run event: payload for "${type}" does not allow key "${key}"`);
    }

    const value = (payload as Record<string, unknown>)[key];
    if (typeof value !== 'string' && value !== null) {
      throw new RunEventPayloadError(
        `run event: payload for "${type}" key "${key}" must be a string or null, got ${describeKind(value)}`,
      );
    }
    if (typeof value === 'string' && value.length > MAX_RUN_EVENT_PAYLOAD_STRING) {
      throw new RunEventPayloadError(
        `run event: payload for "${type}" key "${key}" is ${value.length} characters long, exceeding MAX_RUN_EVENT_PAYLOAD_STRING (${MAX_RUN_EVENT_PAYLOAD_STRING})`,
      );
    }
  }
}

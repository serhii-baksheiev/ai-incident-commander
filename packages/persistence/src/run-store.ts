import { Pool } from 'pg';

import { assertRunTransition, type RunStatus } from '@aic/domain';

import { APPLICATION_SCHEMA } from './app-schema.js';

export interface RunStoreOptions {
  readonly leaseMs: number;
  readonly maxExecutionAttempts: number;
}

/** What `claimNext` hands back, and what `renewLease` is called with. */
export interface RunClaim {
  readonly runId: string;
  readonly ownerWorkerId: string;
  readonly executionAttempt: number;
}

export interface RunRecord {
  readonly runId: string;
  readonly status: RunStatus;
  readonly input: unknown;
  readonly ownerWorkerId: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly executionAttempt: number;
  readonly recoveryCount: number;
  readonly terminalReason: string | null;
}

/**
 * `createRunStore`'s return shape. `.pool` and `.SQL_STATEMENTS` are exposed
 * for the same reason `createPostgresCheckpointer`'s `saver.pool` and
 * `saver.SQL_STATEMENTS` are (`index.ts`): so a caller — and the ordinary and
 * live test lanes — has something to watch, to close, and to read the actual
 * SQL from rather than trusting a comment to describe it correctly.
 */
export interface RunStore {
  readonly pool: Pool;
  readonly SQL_STATEMENTS: Readonly<Record<'claimNext' | 'sweepExpired' | 'renewLease', string>>;
  createRun(run: { runId: string; input: unknown }): Promise<void>;
  claimNext(workerId: string): Promise<RunClaim | null>;
  renewLease(claim: RunClaim): Promise<boolean>;
  sweepExpired(): Promise<string[]>;
  getRun(runId: string): Promise<RunRecord | null>;
  close(): Promise<void>;
}

/**
 * The { from, to } pairs the store's own SQL statements perform: `claimNext`
 * (`queued->running`, and bounded exhaustion's `queued->failed`) and
 * `sweepExpired` (`running->queued`). Checked against the domain's own
 * `assertRunTransition` below, at module load — not only in a test — so a pair
 * added here that the domain refuses fails as soon as this module is imported.
 * See run-store.test.mjs › "every status transition the store's statements
 * perform is allowed by assertRunTransition".
 */
export const RUN_STORE_TRANSITIONS: ReadonlyArray<{ readonly from: RunStatus; readonly to: RunStatus }> =
  Object.freeze([
    Object.freeze({ from: 'queued', to: 'running' }),
    Object.freeze({ from: 'queued', to: 'failed' }),
    Object.freeze({ from: 'running', to: 'queued' }),
  ]);

for (const { from, to } of RUN_STORE_TRANSITIONS) {
  assertRunTransition(from, to);
}

/** Decision 13 of docs/decisions/durable-run-execution.md: bounded recovery. */
const TERMINAL_REASON_RECOVERY_EXHAUSTED = 'recovery_exhausted';

/**
 * The three SQL statements this store runs, built once per store against its
 * own connection string's schema constant.
 *
 * Each pass of `claimNext` is ONE statement: a `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`
 * candidate, materialized so two later CTEs can each read it exactly once,
 * feeding either an `exhausted` branch (decision 13: the next attempt would
 * exceed `maxExecutionAttempts`, so the run moves straight to `failed` with
 * `terminal_reason = 'recovery_exhausted'`) or a `claimed` branch (the run
 * moves to `running`, records the claiming worker, and starts a fresh lease).
 * Exactly one of the two branches can match a given candidate, because their
 * `WHERE` clauses on `execution_attempt` are complements of each other.
 *
 * `sweepExpired` reclaims every `running` row whose lease has passed
 * `clock_timestamp()`, skipping any row a concurrent claim or sweep already
 * holds with `FOR UPDATE SKIP LOCKED` in its inner `SELECT`.
 *
 * `renewLease` extends the lease only for the exact `(runId, ownerWorkerId,
 * executionAttempt)` triple a claim was issued for — the fencing check decision
 * 3 asks for: a worker whose attempt has been superseded by a sweep and a
 * reclaim no longer matches `executionAttempt`, even if it still believes
 * itself the owner. It also refuses a lease that has already expired, before
 * any sweep: see run-store.live.mjs › "renewLease refuses a lease that has
 * already expired, even before any sweep has requeued the run". A claim and
 * each renewal set `heartbeat_at`: see run-store.live.mjs › "a claim records
 * a heartbeat, and each renewal moves it forward".
 *
 * All three compare against `clock_timestamp()`, never `now()`: `now()` is
 * fixed for the whole transaction, so a lease check inside one would compare
 * against the transaction's start time rather than the actual current
 * instant. See run-store.test.mjs › "the claim and sweep statements use FOR
 * UPDATE SKIP LOCKED, and renewal and claim compare against clock_timestamp()
 * rather than now()".
 */
function buildSqlStatements(): RunStore['SQL_STATEMENTS'] {
  return Object.freeze({
    claimNext: `
      WITH candidate AS MATERIALIZED (
        SELECT run_id
        FROM "${APPLICATION_SCHEMA}".runs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ),
      exhausted AS (
        UPDATE "${APPLICATION_SCHEMA}".runs AS r
        SET status = 'failed',
            terminal_reason = '${TERMINAL_REASON_RECOVERY_EXHAUSTED}'
        FROM candidate
        WHERE r.run_id = candidate.run_id
          AND r.execution_attempt >= $2
        RETURNING r.run_id
      ),
      claimed AS (
        UPDATE "${APPLICATION_SCHEMA}".runs AS r
        SET status = 'running',
            owner_worker_id = $1,
            execution_attempt = r.execution_attempt + 1,
            lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
            heartbeat_at = clock_timestamp()
        FROM candidate
        WHERE r.run_id = candidate.run_id
          AND r.execution_attempt < $2
        RETURNING r.run_id AS run_id, r.owner_worker_id AS owner_worker_id, r.execution_attempt AS execution_attempt
      )
      SELECT run_id, owner_worker_id, execution_attempt, false AS exhausted FROM claimed
      UNION ALL
      SELECT run_id, NULL, NULL, true AS exhausted FROM exhausted
    `,
    sweepExpired: `
      UPDATE "${APPLICATION_SCHEMA}".runs
      SET status = 'queued',
          owner_worker_id = NULL,
          lease_expires_at = NULL,
          recovery_count = recovery_count + 1
      WHERE run_id IN (
        SELECT run_id
        FROM "${APPLICATION_SCHEMA}".runs
        WHERE status = 'running'
          AND lease_expires_at < clock_timestamp()
        FOR UPDATE SKIP LOCKED
      )
      RETURNING run_id
    `,
    renewLease: `
      UPDATE "${APPLICATION_SCHEMA}".runs
      SET lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
          heartbeat_at = clock_timestamp()
      WHERE run_id = $1
        AND owner_worker_id = $2
        AND execution_attempt = $3
        AND status = 'running'
        AND lease_expires_at > clock_timestamp()
      RETURNING run_id
    `,
  });
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Builds a run store against `connectionString`. Construction touches
 * nothing: `pg.Pool` is lazy (measured — the same laziness
 * `createPostgresCheckpointer` relies on in `index.ts`), so no connection is
 * opened until the first call. Provisioning is `setupApplicationSchema`'s
 * explicit step, not this factory's. See run-store.test.mjs › "constructing
 * the run store opens no connection".
 */
export function createRunStore(connectionString: string, options: RunStoreOptions): RunStore {
  const leaseMs = assertPositiveInteger(options?.leaseMs, 'leaseMs');
  const maxExecutionAttempts = assertPositiveInteger(options?.maxExecutionAttempts, 'maxExecutionAttempts');

  const pool = new Pool({ connectionString });
  // An idle client can emit its own 'error' (e.g. the backend closing a
  // connection this pool is not currently using) — with no listener, `pg`
  // rethrows it as an uncaught exception on the process rather than a
  // rejected promise a caller could catch. See app-schema.ts's own
  // `setupApplicationSchema` for the security advisory this mirrors.
  pool.on('error', () => {
    // Nothing to reconcile here: no query is in flight against this idle
    // client, and the pool discards it and opens a fresh one on next use.
  });
  const SQL_STATEMENTS = buildSqlStatements();

  return {
    pool,
    SQL_STATEMENTS,

    async createRun({ runId, input }) {
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new Error(`createRun requires a non-empty runId, got ${JSON.stringify(runId)}`);
      }
      await pool.query(`INSERT INTO "${APPLICATION_SCHEMA}".runs (run_id, status, input) VALUES ($1, 'queued', $2::jsonb)`, [
        runId,
        JSON.stringify(input),
      ]);
    },

    async claimNext(workerId) {
      // Each statement either claims one run, fails one exhausted run, or finds
      // nothing queued; only the last is a null. Failing a run does not end the
      // call, so an exhausted run ahead of claimable work is never read as an
      // empty queue — see run-store.live.mjs › "exhausted runs at the head of the
      // queue do not hide claimable work behind a null". Each pass removes a
      // queued run, so the loop ends.
      for (;;) {
        const { rows } = await pool.query<{
          run_id: string;
          owner_worker_id: string | null;
          execution_attempt: number | null;
          exhausted: boolean;
        }>(SQL_STATEMENTS.claimNext, [workerId, maxExecutionAttempts, leaseMs]);
        const row = rows[0];
        if (!row) return null;
        if (row.exhausted) continue;
        return {
          runId: row.run_id,
          ownerWorkerId: row.owner_worker_id as string,
          executionAttempt: Number(row.execution_attempt),
        };
      }
    },

    async renewLease(claim) {
      const { rows } = await pool.query(SQL_STATEMENTS.renewLease, [
        claim.runId,
        claim.ownerWorkerId,
        claim.executionAttempt,
        leaseMs,
      ]);
      return rows.length > 0;
    },

    async sweepExpired() {
      const { rows } = await pool.query<{ run_id: string }>(SQL_STATEMENTS.sweepExpired);
      return rows.map((row) => row.run_id);
    },

    async getRun(runId) {
      const { rows } = await pool.query<{
        run_id: string;
        status: RunStatus;
        input: unknown;
        owner_worker_id: string | null;
        lease_expires_at: Date | null;
        heartbeat_at: Date | null;
        execution_attempt: number;
        recovery_count: number;
        terminal_reason: string | null;
      }>(
        `SELECT run_id, status, input, owner_worker_id, lease_expires_at, heartbeat_at, execution_attempt, recovery_count, terminal_reason
         FROM "${APPLICATION_SCHEMA}".runs WHERE run_id = $1`,
        [runId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        runId: row.run_id,
        status: row.status,
        input: row.input,
        ownerWorkerId: row.owner_worker_id,
        leaseExpiresAt: row.lease_expires_at,
        heartbeatAt: row.heartbeat_at,
        executionAttempt: Number(row.execution_attempt),
        recoveryCount: Number(row.recovery_count),
        terminalReason: row.terminal_reason,
      };
    },

    async close() {
      await pool.end();
    },
  };
}

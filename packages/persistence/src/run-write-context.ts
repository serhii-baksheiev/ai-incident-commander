import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  assertRunTransition,
  canonicalJson,
  ExecKeySchema,
  ExecutionIntegrityViolation,
  StaleOwnerError,
  type Evidence,
  type Trial,
} from '@aic/domain';

import { APPLICATION_SCHEMA } from './app-schema.js';
import type { RunClaim, RunStore } from './run-store.js';

/**
 * AIC-56 slice C: the fenced write context every run-scoped write goes
 * through, built on top of slice B's `RunStore`. See
 * test/run-write-context.test.mjs (the shape decidable without a database)
 * and infra/postgres/tests/run-write-context.live.mjs (the replay/integrity/
 * fencing protocol, which needs one) for the spec this module is built
 * against.
 */

/** What a `project()` callback hands `committed` to write beside the result. */
export interface CommittedProjection {
  readonly trials?: readonly Trial[];
  readonly evidence?: readonly Evidence[];
}

export interface CommittedOptions {
  readonly project?: () => CommittedProjection | undefined;
  readonly inputFingerprint?: string;
}

/**
 * The five methods `openRunWriteContext` returns, plus the `pool` it reused
 * from the store (see run-write-context.test.mjs › "opening a write context
 * opens no connection: it reuses the store's own pool rather than dialing a
 * second one").
 */
export interface RunWriteContext {
  readonly pool: Pool;
  committed<T>(execKey: string, compute: () => Promise<T>, options?: CommittedOptions): Promise<T>;
  markWaitingHuman(interactionId: string): Promise<void>;
  complete(reason?: string): Promise<void>;
  fail(reason: string): Promise<void>;
  assertOwner(): Promise<void>;
}

/**
 * The fence every run-scoped write performs first, in the same transaction as
 * the write it guards (decision 3: ownership is lease-based and fenced). A
 * `FOR SHARE` lock, not `FOR UPDATE`: this is a check that the caller's claim
 * is still the run's valid owner, not exclusive possession of the row for the
 * whole transaction. Exported as data — see run-write-context.test.mjs › "the
 * fence statement text contains FOR SHARE, all four predicates, and never
 * now()" — for the same reason `RunStore.SQL_STATEMENTS` is: a claim about SQL
 * text belongs in the text itself, not only in a comment describing it.
 */
export const RUN_WRITE_CONTEXT_FENCE_SQL = `
  SELECT 1
  FROM "${APPLICATION_SCHEMA}".runs
  WHERE run_id = $1
    AND owner_worker_id = $2
    AND execution_attempt = $3
    AND status = 'running'
    AND lease_expires_at > clock_timestamp()
  FOR SHARE
`;

/**
 * Marks an already-thrown error as one whose transaction was deliberately
 * committed before the throw (the `committed`'s losing-race branch below,
 * decision 12: the rejection itself is durable evidence). `runFenced`'s catch
 * reads this instead of rolling back a transaction that has already landed.
 * Module-private: nothing outside this file ever needs to set or read it.
 */
const COMMITTED_BEFORE_THROW = Symbol('run-write-context.committed-before-throw');
interface PossiblyCommittedError extends Error {
  [COMMITTED_BEFORE_THROW]?: true;
}

function fenceRefusalMessage(claim: RunClaim, kind: string): string {
  return `run ${claim.runId}: owner_worker_id ${claim.ownerWorkerId} at execution_attempt ${claim.executionAttempt} no longer holds a valid running lease for ${kind}`;
}

/**
 * Decision 12's durable evidence of a refused write: recorded in its own
 * statement, against the pool rather than the refusing (already rolled back)
 * transaction's client. See run-write-context.live.mjs › "a zombie worker
 * after lease loss cannot write domain records or events, and
 * fence_rejections records the attempts".
 */
async function recordFenceRejection(pool: Pool, claim: RunClaim, kind: string): Promise<void> {
  await pool.query(
    `INSERT INTO "${APPLICATION_SCHEMA}".fence_rejections (run_id, owner_worker_id, execution_attempt, kind)
     VALUES ($1, $2, $3, $4)`,
    [claim.runId, claim.ownerWorkerId, claim.executionAttempt, kind],
  );
}

/**
 * Runs `work` inside one transaction that has already passed the fence
 * (`RUN_WRITE_CONTEXT_FENCE_SQL`) — the shape every run-scoped write in this
 * module shares. On a fence failure: ROLLBACK, record the rejection (its own
 * statement, see `recordFenceRejection`), throw `StaleOwnerError`; never a
 * `run_events` row for a stale attempt. On any other failure the transaction
 * is rolled back and the client released as broken (the slice-B pattern —
 * `packages/persistence/src/app-schema.ts`'s `setupApplicationSchema`), except
 * when `work` has already committed before throwing (see
 * `COMMITTED_BEFORE_THROW` above), in which case nothing here undoes it.
 */
async function runFenced<T>(
  pool: Pool,
  claim: RunClaim,
  kind: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query(RUN_WRITE_CONTEXT_FENCE_SQL, [
        claim.runId,
        claim.ownerWorkerId,
        claim.executionAttempt,
      ]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        await recordFenceRejection(pool, claim, kind);
        throw new StaleOwnerError(fenceRefusalMessage(claim, kind));
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (error instanceof StaleOwnerError || (error as PossiblyCommittedError)?.[COMMITTED_BEFORE_THROW]) {
        throw error;
      }
      failure = error;
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what gets reported; a connection that cannot
        // even roll back is released as broken below.
      }
      throw error;
    }
  } finally {
    client.release(failure);
  }
}

/**
 * `run_event_counters` upsert-increment: the source of `run_events.seq`,
 * strictly increasing per run because it is read and written inside the same
 * fenced transaction as the event it numbers. See run-write-context.live.mjs
 * › "each fenced write appends an event with a strictly increasing seq per
 * run".
 */
async function nextSeq(client: PoolClient, runId: string): Promise<number> {
  const { rows } = await client.query<{ next_seq: number }>(
    `INSERT INTO "${APPLICATION_SCHEMA}".run_event_counters (run_id, next_seq)
     VALUES ($1, 1)
     ON CONFLICT (run_id) DO UPDATE SET next_seq = "${APPLICATION_SCHEMA}".run_event_counters.next_seq + 1
     RETURNING next_seq`,
    [runId],
  );
  return Number(rows[0]!.next_seq);
}

/** Appends one `run_events` row inside the caller's already-fenced transaction. */
async function appendEvent(
  client: PoolClient,
  runId: string,
  executionAttempt: number,
  type: string,
  payload: unknown,
): Promise<void> {
  const seq = await nextSeq(client, runId);
  await client.query(
    `INSERT INTO "${APPLICATION_SCHEMA}".run_events (run_id, seq, type, execution_attempt, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [runId, seq, type, executionAttempt, JSON.stringify(canonicalJson(payload))],
  );
}

/**
 * `committed`'s protocol (decisions 5-8 and 12):
 *
 * 1. Validate `execKey` against `ExecKeySchema`.
 * 2. A fenced read of `node_results`. Found: an `inputFingerprint` mismatch
 *    against the stored `input_sha` is `ExecutionIntegrityViolation` (before
 *    `compute` is ever called again — see run-write-context.live.mjs › "a
 *    different inputFingerprint for an already-committed key throws
 *    ExecutionIntegrityViolation before calling compute again, and leaves the
 *    stored row unchanged"); otherwise append a fenced `node_result.reused`
 *    event and return the stored result, never calling `compute`.
 * 3. Not found: call `compute()` with no transaction open and no connection
 *    checked out (see run-write-context.live.mjs › "compute runs OUTSIDE any
 *    transaction: a concurrent FOR UPDATE on the run row is not blocked while
 *    compute is pending").
 * 4. One fenced transaction: `INSERT ... ON CONFLICT (run_id, exec_key) DO
 *    NOTHING`. Won the race: write the projection (`ON CONFLICT DO NOTHING`,
 *    each row keyed by its own domain id) and append `node_result.committed`.
 *    Lost the race: compare `result_sha` against the row that won — equal is
 *    idempotent (return the stored result); different appends
 *    `execution.integrity_violation` (naming the key and both shas, never the
 *    result bodies), COMMITS, and throws `ExecutionIntegrityViolation` — see
 *    run-write-context.live.mjs › "a concurrent commit for the same key with a
 *    DIFFERENT result throws ExecutionIntegrityViolation, leaves the stored
 *    bytes unchanged, and records an execution.integrity_violation event" and
 *    › "a concurrent commit for the same key with the SAME result is
 *    idempotent: no throw, the stored result is returned, and no second row is
 *    written". `node_results` is never UPDATEd.
 */
async function committed<T>(
  pool: Pool,
  claim: RunClaim,
  execKey: string,
  compute: () => Promise<T>,
  options: CommittedOptions,
): Promise<T> {
  ExecKeySchema.parse(execKey);
  const { project, inputFingerprint } = options;
  const normalizedInputSha = inputFingerprint ?? null;

  const peek = await runFenced(pool, claim, 'committed', async (client) => {
    const { rows } = await client.query<{
      result_json: string;
      result_sha: string;
      input_sha: string | null;
    }>(
      `SELECT result_json, result_sha, input_sha FROM "${APPLICATION_SCHEMA}".node_results
       WHERE run_id = $1 AND exec_key = $2`,
      [claim.runId, execKey],
    );
    const existing = rows[0];
    if (!existing) {
      return { found: false as const };
    }
    if (existing.input_sha !== normalizedInputSha) {
      // Recorded before it is thrown, like the concurrent-commit case below: an
      // integrity violation is durable evidence (decision 12), not only an
      // exception a caller may drop. see run-write-context.live.mjs › "a
      // different inputFingerprint for an already-committed key throws
      // ExecutionIntegrityViolation before calling compute again, and leaves
      // the stored row unchanged"
      await appendEvent(client, claim.runId, claim.executionAttempt, 'execution.integrity_violation', {
        execKey,
        reason: 'input_fingerprint_mismatch',
      });
      await client.query('COMMIT');
      const violation: PossiblyCommittedError = new ExecutionIntegrityViolation(
        `execKey ${execKey} was already committed with a different inputFingerprint`,
        { execKey },
      );
      violation[COMMITTED_BEFORE_THROW] = true;
      throw violation;
    }
    await appendEvent(client, claim.runId, claim.executionAttempt, 'node_result.reused', { execKey });
    return { found: true as const, value: JSON.parse(existing.result_json) as T };
  });

  if (peek.found) {
    return peek.value;
  }

  const op = execKey.slice(0, execKey.indexOf('/sha256:'));
  const computedValue = await compute();
  const resultJsonText = JSON.stringify(canonicalJson(computedValue));
  const resultSha = createHash('sha256').update(resultJsonText).digest('hex');

  return runFenced(pool, claim, 'committed', async (client) => {
    const { rows: insertedRows } = await client.query<{ result_json: string }>(
      `INSERT INTO "${APPLICATION_SCHEMA}".node_results
         (run_id, exec_key, op, input_sha, result_json, result_sha, produced_by_attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (run_id, exec_key) DO NOTHING
       RETURNING result_json`,
      [claim.runId, execKey, op, normalizedInputSha, resultJsonText, resultSha, claim.executionAttempt],
    );

    if (insertedRows.length === 0) {
      const { rows: storedRows } = await client.query<{ result_json: string; result_sha: string }>(
        `SELECT result_json, result_sha FROM "${APPLICATION_SCHEMA}".node_results
         WHERE run_id = $1 AND exec_key = $2`,
        [claim.runId, execKey],
      );
      const stored = storedRows[0]!;
      if (stored.result_sha === resultSha) {
        return JSON.parse(stored.result_json) as T;
      }
      await appendEvent(client, claim.runId, claim.executionAttempt, 'execution.integrity_violation', {
        execKey,
        storedResultSha: stored.result_sha,
        computedResultSha: resultSha,
      });
      await client.query('COMMIT');
      const violation: PossiblyCommittedError = new ExecutionIntegrityViolation(
        `a concurrent commit for ${execKey} produced a result different from the one already stored`,
        { execKey },
      );
      violation[COMMITTED_BEFORE_THROW] = true;
      throw violation;
    }

    const projection = project?.() ?? {};
    for (const trial of projection.trials ?? []) {
      await client.query(
        `INSERT INTO "${APPLICATION_SCHEMA}".run_trials (run_id, trial_id, body)
         VALUES ($1, $2, $3)
         ON CONFLICT (run_id, trial_id) DO NOTHING`,
        [claim.runId, trial.id, JSON.stringify(canonicalJson(trial))],
      );
    }
    for (const evidence of projection.evidence ?? []) {
      await client.query(
        `INSERT INTO "${APPLICATION_SCHEMA}".run_evidence (run_id, evidence_id, trial_id, body)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, evidence_id) DO NOTHING`,
        [claim.runId, evidence.id, evidence.trialId, JSON.stringify(canonicalJson(evidence))],
      );
    }

    await appendEvent(client, claim.runId, claim.executionAttempt, 'node_result.committed', { execKey });
    return JSON.parse(insertedRows[0]!.result_json) as T;
  });
}

/**
 * `running` -> `waiting_human` (decision 4: waiting for a human owns no
 * worker) — clears `owner_worker_id` and `lease_expires_at`, stores
 * `interactionId`. See run-write-context.live.mjs › "markWaitingHuman moves
 * running to waiting_human, clears owner and lease, and stores the
 * interaction id".
 */
async function markWaitingHuman(pool: Pool, claim: RunClaim, interactionId: string): Promise<void> {
  await runFenced(pool, claim, 'markWaitingHuman', async (client) => {
    assertRunTransition('running', 'waiting_human');
    await client.query(
      `UPDATE "${APPLICATION_SCHEMA}".runs
       SET status = 'waiting_human', owner_worker_id = NULL, lease_expires_at = NULL, interaction_id = $2
       WHERE run_id = $1`,
      [claim.runId, interactionId],
    );
    await appendEvent(client, claim.runId, claim.executionAttempt, 'run.waiting_human', { interactionId });
  });
}

/**
 * `running` -> `completed`. See run-write-context.live.mjs › "complete moves
 * running to completed".
 */
async function complete(pool: Pool, claim: RunClaim, reason: string | undefined): Promise<void> {
  await runFenced(pool, claim, 'complete', async (client) => {
    assertRunTransition('running', 'completed');
    await client.query(
      `UPDATE "${APPLICATION_SCHEMA}".runs SET status = 'completed', terminal_reason = $2 WHERE run_id = $1`,
      [claim.runId, reason ?? null],
    );
    await appendEvent(client, claim.runId, claim.executionAttempt, 'run.completed', { reason: reason ?? null });
  });
}

/**
 * `running` -> `failed`, storing `reason` as `terminal_reason`. See
 * run-write-context.live.mjs › "fail moves running to failed and stores the
 * given reason".
 */
async function fail(pool: Pool, claim: RunClaim, reason: string): Promise<void> {
  await runFenced(pool, claim, 'fail', async (client) => {
    assertRunTransition('running', 'failed');
    await client.query(
      `UPDATE "${APPLICATION_SCHEMA}".runs SET status = 'failed', terminal_reason = $2 WHERE run_id = $1`,
      [claim.runId, reason],
    );
    await appendEvent(client, claim.runId, claim.executionAttempt, 'run.failed', { reason });
  });
}

/**
 * The fence alone, with no transaction and no write: refuses the instant a
 * lease has expired, independent of whether `sweepExpired` has run yet. See
 * run-write-context.live.mjs › "a context whose lease merely expired, with no
 * sweep yet, is refused too".
 */
async function assertOwner(pool: Pool, claim: RunClaim): Promise<void> {
  const { rows } = await pool.query(RUN_WRITE_CONTEXT_FENCE_SQL, [
    claim.runId,
    claim.ownerWorkerId,
    claim.executionAttempt,
  ]);
  if (rows.length === 0) {
    throw new StaleOwnerError(fenceRefusalMessage(claim, 'assertOwner'));
  }
}

/**
 * Opens a fenced write context for one claim, reusing `store`'s own `pg.Pool`
 * rather than dialing a second one (mirroring one `RunStore` holding exactly
 * one pool across every claim it hands out). Touches nothing: every method
 * below opens its own connection lazily. See run-write-context.test.mjs ›
 * "opening a write context opens no connection: it reuses the store's own
 * pool rather than dialing a second one".
 */
export function openRunWriteContext(store: RunStore, claim: RunClaim): RunWriteContext {
  const { pool } = store;
  return {
    pool,
    committed: (execKey, compute, options = {}) => committed(pool, claim, execKey, compute, options),
    markWaitingHuman: (interactionId) => markWaitingHuman(pool, claim, interactionId),
    complete: (reason) => complete(pool, claim, reason),
    fail: (reason) => fail(pool, claim, reason),
    assertOwner: () => assertOwner(pool, claim),
  };
}

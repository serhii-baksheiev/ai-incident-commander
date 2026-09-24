import type { Pool, PoolClient } from 'pg';

import { EvidenceSchema, TrialSchema, type Evidence, type Trial } from '@aic/domain';

import { APPLICATION_SCHEMA } from './app-schema.js';
import type { RunStore } from './run-store.js';

/**
 * AIC-56 slice F: the retention boundary — a read model that never reads
 * `node_results` (the product-API stand-in this repository has before AIC-43),
 * and the guard that prunes a terminal run's `node_results` and checkpoint
 * thread without moving that read model at all. See
 * test/durable-run-boundaries.test.mjs (the half decidable without a
 * database) and infra/postgres/tests/durable-run-retention.live.mjs (the half
 * that needs one) for the spec this module is built against.
 */

/** `pruneTerminalRun`'s refusal for a run that is not `completed` or `failed`. */
export class RunNotTerminalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunNotTerminalError';
  }
}

/** `readRunProductSnapshot`'s return shape — see this file's header for the spec. */
export interface RunProductSnapshot {
  readonly runId: string;
  readonly status: string;
  readonly terminalReason: string | null;
  readonly interactionId: string | null;
  readonly trials: readonly Trial[];
  readonly evidence: readonly Evidence[];
  readonly events: ReadonlyArray<{
    readonly seq: number;
    readonly type: string;
    readonly executionAttempt: number;
    readonly payload: unknown;
  }>;
}

/** What `pruneTerminalRun` calls once the run's `node_results` are gone. */
export interface RetentionCheckpointer {
  deleteThread(threadId: string): Promise<void>;
}

/** Accepts either a `pg.Pool` or a `RunStore`, the same `pool | store` convention the live suite's helpers pass through. */
function poolOf(poolOrStore: Pool | RunStore): Pool {
  return 'pool' in poolOrStore ? poolOrStore.pool : poolOrStore;
}

/**
 * The product-API stand-in this repository has before AIC-43: status,
 * terminal reason, interaction id, the projected `Trial`/`Evidence` domain
 * objects, and `run_events` in ascending `seq` order. Never reads
 * `node_results`: everything here comes from `runs`, `run_trials`,
 * `run_evidence` and `run_events`, so a `node_results` row that is corrupted,
 * pruned or never existed cannot move this snapshot at all — see
 * durable-run-retention.live.mjs › "readRunProductSnapshot never reads
 * node_results: a tampered node_results row yields an identical snapshot".
 */
export async function readRunProductSnapshot(
  poolOrStore: Pool | RunStore,
  runId: string,
): Promise<RunProductSnapshot> {
  const pool = poolOf(poolOrStore);

  const { rows: runRows } = await pool.query<{
    status: string;
    terminal_reason: string | null;
    interaction_id: string | null;
  }>(
    `SELECT status, terminal_reason, interaction_id FROM "${APPLICATION_SCHEMA}".runs WHERE run_id = $1`,
    [runId],
  );
  const run = runRows[0];
  if (!run) {
    throw new Error(`readRunProductSnapshot: no run ${runId}`);
  }

  const { rows: trialRows } = await pool.query<{ body: string }>(
    `SELECT body FROM "${APPLICATION_SCHEMA}".run_trials WHERE run_id = $1`,
    [runId],
  );
  const { rows: evidenceRows } = await pool.query<{ body: string }>(
    `SELECT body FROM "${APPLICATION_SCHEMA}".run_evidence WHERE run_id = $1`,
    [runId],
  );
  const { rows: eventRows } = await pool.query<{
    seq: number;
    type: string;
    execution_attempt: number;
    payload: unknown;
  }>(
    `SELECT seq, type, execution_attempt, payload FROM "${APPLICATION_SCHEMA}".run_events
     WHERE run_id = $1 ORDER BY seq ASC`,
    [runId],
  );

  return {
    runId,
    status: run.status,
    terminalReason: run.terminal_reason,
    interactionId: run.interaction_id,
    trials: trialRows.map((row) => TrialSchema.parse(JSON.parse(row.body))),
    evidence: evidenceRows.map((row) => EvidenceSchema.parse(JSON.parse(row.body))),
    events: eventRows.map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      executionAttempt: Number(row.execution_attempt),
      payload: row.payload,
    })),
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * Prunes a terminal run's `node_results` and its checkpoint thread, leaving
 * the product-API snapshot above untouched (it never reads either).
 *
 * One transaction locks the run row with `SELECT ... FOR UPDATE` — exclusive,
 * unlike `RUN_WRITE_CONTEXT_FENCE_SQL`'s `FOR SHARE`, because this is a
 * destructive action against the run and must wait out any concurrent writer
 * rather than merely check a fencing identity — see
 * durable-run-retention.live.mjs › "pruneTerminalRun waits for the run row
 * lock rather than acting on a status read outside FOR UPDATE". A status
 * outside `completed`/`failed` refuses with `RunNotTerminalError` and rolls
 * back, leaving `node_results` and the checkpoint thread untouched; a
 * terminal status deletes `node_results` and commits.
 *
 * `checkpointer.deleteThread(runId)` runs AFTER that commit, not inside it —
 * a deliberate choice, stated here because the two writes are on separate
 * connections (the checkpointer owns its own pool) and so can never be one
 * atomic unit regardless of ordering. Committing the `node_results` deletion
 * first means a failure between the two steps leaves a run whose
 * `node_results` are gone but whose checkpoint thread still exists: harmless,
 * because the product snapshot reads neither, and both this function's
 * DELETE and `deleteThread` are idempotent, so re-invoking `pruneTerminalRun`
 * after such a failure finishes the job. Running `deleteThread` before the
 * commit would risk the opposite gap — a deleted checkpoint thread whose
 * `node_results` deletion then failed to commit at all — which is the
 * ordering that would leave the run "looking un-pruned" in a misleading way,
 * since a fresh `pruneTerminalRun` retry would still find and delete
 * `node_results` in that case, but a failed-and-rolled-back attempt in THIS
 * order can never have deleted the checkpoint thread without the
 * `node_results` deletion having already landed.
 */
export async function pruneTerminalRun(
  store: RunStore,
  runId: string,
  options: { readonly checkpointer: RetentionCheckpointer },
): Promise<void> {
  const { pool } = store;
  const client: PoolClient = await pool.connect();
  let failure: unknown;
  // Set only for a refusal (an expected outcome, not a broken connection —
  // see run-write-context.ts's runFenced for the same convention: the client
  // is released clean below and the error is thrown only after it goes back
  // to the pool.
  let refusedStatus: string | undefined;
  try {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM "${APPLICATION_SCHEMA}".runs WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      const status = rows[0]?.status;
      if (status === undefined || !TERMINAL_STATUSES.has(status)) {
        await client.query('ROLLBACK');
        refusedStatus = status ?? 'not found';
      } else {
        await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".node_results WHERE run_id = $1`, [runId]);
        await client.query('COMMIT');
      }
    } catch (error) {
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

  if (refusedStatus !== undefined) {
    throw new RunNotTerminalError(
      `run ${runId} is not terminal (status: ${refusedStatus}): pruneTerminalRun only prunes a completed or failed run`,
    );
  }

  await options.checkpointer.deleteThread(runId);
}

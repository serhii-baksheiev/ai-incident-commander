/**
 * AIC-56, slice C (the half decidable WITHOUT a database): the fenced write
 * context's shape, and the migration-2 data `setupApplicationSchema` will
 * apply — everything that can be pinned by reading exported constants and SQL
 * text, mirroring how test/run-store.test.mjs proves slice B's schema and
 * transition shape before any connection exists.
 *
 * The half that needs a real PostgreSQL — the fence actually excluding a
 * stale attempt, `committed`'s replay/integrity protocol, the zombie-worker
 * acceptance row, `compute` running outside the transaction — cannot be
 * decided here and lives on its own line,
 * `infra/postgres/tests/run-write-context.live.mjs`, run through `npm run
 * test:live-postgres` (kept out of `npm test` and `npm run check` by the
 * existing assertion in test/postgres-checkpointer.test.mjs › "keeps the
 * database-backed lane out of npm test and npm run check", which already
 * covers every file under `infra/postgres/tests/*.live.mjs`).
 *
 * ## Design choices this file assumes
 *
 * The task spec names `openRunWriteContext(store, claim)` and its five
 * methods (`committed`, `markWaitingHuman`, `complete`, `fail`,
 * `assertOwner`), but not every internal surface a row here needs to inspect
 * WITHOUT connecting. Two choices are assumed, stated here rather than
 * discovered mid-assertion, both chosen for consistency with the run store
 * this slice is built on (`packages/persistence/src/run-store.ts`):
 *
 *   - `openRunWriteContext` reuses the store's own `pg.Pool` rather than
 *     opening a second one — mirroring how one `RunStore` holds exactly one
 *     pool across every claim it hands out. Row 1 checks this by identity
 *     (`context.pool === store.pool`) as well as by watching the pool's own
 *     connection stats, the same way run-store.test.mjs's "constructing the
 *     run store opens no connection" does.
 *   - the fenced `SELECT ... FOR SHARE` every run-scoped write performs first
 *     is exported as a plain string, `RUN_WRITE_CONTEXT_FENCE_SQL`, from
 *     `@aic/persistence` — mirroring how `APPLICATION_MIGRATIONS` exposes
 *     migration SQL as data and `RunStore.SQL_STATEMENTS` exposes the run
 *     store's own statement text, both for the same reason: "the fence
 *     statement text contains FOR SHARE and four predicates" can only be
 *     checked mechanically if the text is exposed as data rather than trusted
 *     from a comment.
 *
 * If the implementation has a reason to shape either differently, that reason
 * belongs in the PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as persistence from '@aic/persistence';

/**
 * A connection string that resolves and never answers: port 1 on loopback.
 * Copied from test/run-store.test.mjs's `UNREACHABLE_CONNECTION_STRING` —
 * nothing in this file dials it, which is the point: a row that started
 * connecting by accident fails loudly here instead of quietly reaching
 * whatever PostgreSQL the developer happens to be running.
 */
const UNREACHABLE_CONNECTION_STRING = 'postgresql://aic@127.0.0.1:1/aic_app_store_write_context';

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/** A syntactically plausible RunClaim; nothing in this file dials the database, so its values never need to resolve to a real row. */
const FAKE_CLAIM = Object.freeze({ runId: 'run-fake', ownerWorkerId: 'worker-fake', executionAttempt: 1 });

function runStoreFactory() {
  assert.equal(
    typeof persistence.createRunStore,
    'function',
    '@aic/persistence must already export createRunStore (slice B) for this file to build a store to open a write context against',
  );
  return persistence.createRunStore;
}

function openRunWriteContextFactory() {
  assert.equal(
    typeof persistence.openRunWriteContext,
    'function',
    '@aic/persistence must export openRunWriteContext(store, claim) — the intended API this slice adds (see this file\'s header for the two additional design choices it assumes)',
  );
  return persistence.openRunWriteContext;
}

async function buildRunStore(t, options = DEFAULT_OPTIONS) {
  const store = await runStoreFactory()(UNREACHABLE_CONNECTION_STRING, options);
  t.after(async () => {
    await store?.close?.();
  });
  return store;
}

/* -------------------------------------------------------------------------- */
/* Row 1 — opening a write context touches nothing                            */
/* -------------------------------------------------------------------------- */

test('opening a write context opens no connection: it reuses the store\'s own pool rather than dialing a second one', async (t) => {
  const store = await buildRunStore(t);

  const context = await openRunWriteContextFactory()(store, FAKE_CLAIM);

  assert.equal(
    typeof context?.committed,
    'function',
    'openRunWriteContext must return an object exposing a committed(execKey, compute, options?) method',
  );

  assert.equal(
    context.pool,
    store.pool,
    'openRunWriteContext is assumed to reuse the store\'s own pg.Pool rather than opening a second one — see this file\'s header; if the implementation opens its own pool for a stated reason, this identity check is the one line to change, with that reason in the PR description',
  );

  assert.deepEqual(
    { totalCount: store.pool.totalCount, idleCount: store.pool.idleCount, waitingCount: store.pool.waitingCount },
    { totalCount: 0, idleCount: 0, waitingCount: 0 },
    'opening a write context against an unreachable connection string must not touch the database — construction is lazy, the same way constructing the run store itself is (run-store.test.mjs › "constructing the run store opens no connection")',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 2 — the fence statement text                                           */
/* -------------------------------------------------------------------------- */

test('the fence statement text contains FOR SHARE, all four predicates, and never now()', () => {
  const fenceSql = persistence.RUN_WRITE_CONTEXT_FENCE_SQL;
  assert.equal(
    typeof fenceSql,
    'string',
    '@aic/persistence must export RUN_WRITE_CONTEXT_FENCE_SQL as the SQL text of the SELECT ... FOR SHARE every run-scoped write performs first (see this file\'s header for why this is exposed as data)',
  );

  assert.match(
    fenceSql,
    /for\s+share/i,
    'the fence must take a FOR SHARE lock on the run row, not FOR UPDATE and not a plain SELECT — decision 3 asks a fencing check, not exclusive ownership of the row for the whole transaction',
  );
  assert.match(fenceSql, /\bowner_worker_id\s*=/i, 'the fence must compare owner_worker_id');
  assert.match(fenceSql, /\bexecution_attempt\s*=/i, 'the fence must compare execution_attempt');
  assert.match(
    fenceSql,
    /\bstatus\s*=\s*'running'/i,
    'the fence must require status = \'running\': a run that has moved to waiting_human, completed or failed holds no valid write authority',
  );
  assert.match(
    fenceSql,
    /lease_expires_at\s*>\s*clock_timestamp\s*\(\s*\)/i,
    'the fence must compare lease_expires_at against clock_timestamp(), the actual current instant, not a fixed column read',
  );

  const withoutClockTimestamp = fenceSql.replace(/clock_timestamp\s*\(\s*\)/gi, '');
  assert.doesNotMatch(
    withoutClockTimestamp,
    /\bnow\s*\(\s*\)/i,
    'the fence must never use now(): now() is fixed for the whole transaction, so a lease check inside one would compare against the transaction\'s start time rather than the actual current instant — the same reason run-store.ts\'s own statements avoid it',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 3 — APP_SCHEMA_VERSION is 2, migration 1 is untouched, migration 2     */
/* exists                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The independent oracle here is a pinned sha256 of migration 1's SQL string,
 * measured against `origin/main`'s copy of app-schema.ts on 2026-09-24 (the
 * day this row was written) — not a re-derivation of the hash from the
 * module under test. `git show origin/main:packages/persistence/src/app-schema.ts`
 * was byte-identical to the working tree's copy at that moment, so the pin is
 * exactly what shipped in #97, unchanged. A migration's SQL never changes
 * after it ships (app-schema.ts's own module doc says so); this row is what
 * makes that a checked fact rather than a convention nobody verifies once
 * migration 2 is added beside it.
 */
const MIGRATION_1_SQL_SHA256 = 'ab61a5f11df15634d138700b555508bec50abb1bbc788cbe73c38f22d0a8d670';

test('APP_SCHEMA_VERSION is 2, migration 1\'s SQL is byte-identical to what shipped in #97, and migration 2 exists', () => {
  assert.equal(
    persistence.APP_SCHEMA_VERSION,
    2,
    'slice C adds migration 2 (node_results, run_events, run_event_counters, run_trials, run_evidence, fence_rejections, and runs.interaction_id): APP_SCHEMA_VERSION must become 2, and migration 1 must stay exactly as shipped',
  );

  const migrations = persistence.APPLICATION_MIGRATIONS;
  assert.equal(Array.isArray(migrations), true, '@aic/persistence must export APPLICATION_MIGRATIONS');

  const migration1 = migrations.find((migration) => migration?.version === 1);
  assert.ok(migration1, 'APPLICATION_MIGRATIONS must still carry a version-1 entry');
  assert.equal(
    createHash('sha256').update(migration1.sql).digest('hex'),
    MIGRATION_1_SQL_SHA256,
    'migration 1\'s SQL text must be byte-identical to what #97 shipped: a migration never changes after it ships (app-schema.ts\'s own module doc) — new tables belong in migration 2, never in an edit to migration 1',
  );

  const migration2 = migrations.find((migration) => migration?.version === 2);
  assert.ok(migration2, 'APPLICATION_MIGRATIONS must carry a version-2 entry for slice C\'s new tables and the runs.interaction_id column');
  assert.equal(typeof migration2.sql, 'string', 'migration 2\'s sql must be a non-empty string');
  assert.ok(migration2.sql.trim().length > 0, 'migration 2\'s sql must not be empty');
});

/* -------------------------------------------------------------------------- */
/* Row 4 — "every write statement is only issued through the fenced path"     */
/* -------------------------------------------------------------------------- */

/**
 * Skipped, as the spec's own row 4 permits ("if you cannot make this
 * non-vacuous without dictating internals, say so and skip"): nothing in
 * `@aic/persistence` exists yet that names an exported statement set for the
 * write context's INSERT/UPDATE statements the way `RunStore.SQL_STATEMENTS`
 * does for the run store's three. Any assertion this file could write ("no
 * INSERT INTO node_results outside the module") would have to grep the
 * implementation's own source file for a pattern this file invents, which is
 * inventing an internal shape rather than testing a documented one. If the
 * implementation ships an analogous exported statement set, this row should
 * be added back against it; until then it stays a stated gap rather than a
 * vacuous assertion that would pass however the write path is built.
 */

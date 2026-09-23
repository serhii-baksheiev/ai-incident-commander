/**
 * AIC-56, slice B (the half decidable WITHOUT a database): the `aic_app`
 * application schema, its in-house migration runner, and the run store's
 * shape — everything `test/postgres-checkpointer.test.mjs` already proves for
 * the checkpointer's own schema seam, mirrored for the application schema this
 * slice adds beside it.
 *
 * The half that needs a real PostgreSQL — atomic claim under concurrency,
 * `FOR UPDATE SKIP LOCKED` actually excluding a locked row, the sweeper, bounded
 * attempts — cannot be decided here and lives on its own line,
 * `infra/postgres/tests/run-store.live.mjs`, run through `npm run
 * test:live-postgres`, and kept out of `npm test` and `npm run check` by the
 * existing assertion in
 * test/postgres-checkpointer.test.mjs › "keeps the database-backed lane out of
 * npm test and npm run check" already covers every file under
 * `infra/postgres/tests/*.live.mjs`, this one included, so it is not repeated
 * here).
 *
 * Two design choices this file assumes, because the spec names the store's
 * public methods but not every internal surface a row needs to inspect
 * WITHOUT connecting — both are declared here rather than left to be
 * discovered mid-assertion, and both are chosen for consistency with the
 * PostgreSQL checkpointer this package already builds
 * (`packages/persistence/src/index.ts`, `createPostgresCheckpointer`):
 *
 *   - `createRunStore(...)` returns an object exposing `.pool`, the `pg` Pool
 *     it owns — mirroring `saver.pool` — so this file (and the live lane's
 *     independent-oracle queries) has something to watch and to close.
 *   - the returned store also exposes `.SQL_STATEMENTS` — mirroring
 *     `saver.SQL_STATEMENTS` — a plain object keyed at least by `claimNext`,
 *     `sweepExpired` and `renewLease`, each the SQL text of that statement.
 *     Without it, "the claim and sweep statements use FOR UPDATE SKIP LOCKED"
 *     could only be read off a comment, which is the thing that would be
 *     wrong.
 *
 * If the implementation has a reason to shape either differently, that reason
 * belongs in the PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A connection string that resolves and never answers: port 1 on loopback.
 * Copied from test/postgres-checkpointer.test.mjs's
 * `UNREACHABLE_CONNECTION_STRING` — nothing in this file dials it, which is
 * the point: a row that started connecting by accident fails loudly here
 * instead of quietly reaching whatever PostgreSQL the developer happens to be
 * running.
 */
const UNREACHABLE_CONNECTION_STRING = 'postgresql://aic@127.0.0.1:1/aic_app_store';

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * The factory, fetched through the namespace rather than a named import — the
 * same reason `test/postgres-checkpointer.test.mjs`'s `checkpointerFactory`
 * gives: a named import of an export that does not exist yet is a link-time
 * error that takes the WHOLE file down, including rows that have nothing to do
 * with it.
 */
function runStoreFactory() {
  assert.equal(
    typeof persistence.createRunStore,
    'function',
    '@aic/persistence must export createRunStore(connectionString, { leaseMs, maxExecutionAttempts }) — the intended API this slice adds',
  );
  return persistence.createRunStore;
}

/** Builds a run store against the unreachable address and registers it for shutdown. */
async function buildRunStore(t, options = DEFAULT_OPTIONS) {
  const store = await runStoreFactory()(UNREACHABLE_CONNECTION_STRING, options);
  t.after(async () => {
    await store?.close?.();
  });
  return store;
}

/** The pg pool the store owns, asserted rather than assumed (see file header). */
function poolOf(store) {
  assert.equal(
    typeof store?.pool,
    'object',
    'createRunStore must expose the pg Pool it owns, the same way createPostgresCheckpointer exposes saver.pool: without it this row (and the live lane) have nothing to watch or close',
  );
  return store.pool;
}

/* -------------------------------------------------------------------------- */
/* Row 1 — construction touches nothing                                       */
/* -------------------------------------------------------------------------- */

test('constructing the run store opens no connection', async (t) => {
  const store = await buildRunStore(t);
  const pool = poolOf(store);

  assert.deepEqual(
    { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount },
    { totalCount: 0, idleCount: 0, waitingCount: 0 },
    'constructing the run store must not reach the database — provisioning is setupApplicationSchema\'s explicit step — mirroring test/postgres-checkpointer.test.mjs › "opens no connection and issues no statement while the checkpointer is being built"',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 2 — the schemaVersion validation seam, mirroring the checkpointer's     */
/* -------------------------------------------------------------------------- */

test('assertApplicationSchemaVersion refuses a mismatched and a missing version on a fake source, and accepts the current one', async () => {
  const { assertApplicationSchemaVersion, APP_SCHEMA_VERSION, APPLICATION_SCHEMA } = persistence;

  assert.equal(
    typeof assertApplicationSchemaVersion,
    'function',
    '@aic/persistence must export assertApplicationSchemaVersion(source), the same structural-port shape as assertCheckpointerSchemaVersion',
  );
  assert.equal(
    Number.isInteger(APP_SCHEMA_VERSION) && APP_SCHEMA_VERSION > 0,
    true,
    '@aic/persistence must export APP_SCHEMA_VERSION as a positive integer, measured against a real setupApplicationSchema() rather than a placeholder',
  );
  assert.equal(
    typeof APPLICATION_SCHEMA,
    'string',
    'this row reads the already-exported APPLICATION_SCHEMA constant (aic_app) to check that the seam queries it, qualified',
  );

  const asked = [];
  const sourceAt = (v) => ({
    async query(sql) {
      asked.push(sql);
      return { rows: [{ v }] };
    },
  });

  await assert.rejects(
    () => assertApplicationSchemaVersion(sourceAt(APP_SCHEMA_VERSION + 1)),
    (error) =>
      error instanceof Error &&
      error.message.includes(String(APP_SCHEMA_VERSION + 1)) &&
      error.message.includes(String(APP_SCHEMA_VERSION)),
    'a store one version ahead must be refused before execution, and the refusal must name BOTH the version found and the version this build expects',
  );
  await assert.rejects(
    () => assertApplicationSchemaVersion(sourceAt(null)),
    (error) => error instanceof Error && error.message.includes(String(APP_SCHEMA_VERSION)),
    'an unprovisioned application schema reports no version at all, and that must refuse rather than pass as "nothing to check"',
  );

  // The matching version is the only one that may pass, and it must still have
  // asked — a seam that never queries would satisfy the two rejections above.
  await assertApplicationSchemaVersion(sourceAt(APP_SCHEMA_VERSION));
  assert.equal(asked.length, 3, 'the seam must read the version rather than assume it: three calls, three queries');
  assert.match(
    asked[0],
    new RegExp(`"${APPLICATION_SCHEMA}"\\.`),
    'the seam must read the migration ledger of the application schema, qualified — an unqualified read resolves through search_path',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 3 — the status CHECK constraint matches RUN_STATUSES exactly            */
/* -------------------------------------------------------------------------- */

/**
 * A correspondence check, in both directions
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"): a
 * status the migration's CHECK constraint lists that the domain does not
 * recognize, and a domain status the constraint does not list, are both
 * failures — the first lets the database accept a row the domain refuses to
 * transition into, the second refuses at the database a row the domain
 * considers valid.
 */
test('the migration\'s status CHECK constraint lists exactly RUN_STATUSES', () => {
  const { APPLICATION_MIGRATIONS } = persistence;

  assert.equal(
    Array.isArray(APPLICATION_MIGRATIONS),
    true,
    '@aic/persistence must export APPLICATION_MIGRATIONS: the ordered list of migrations setupApplicationSchema applies, in one transaction, so this row (and an operator) can read what will be created without connecting to a database',
  );
  assert.ok(APPLICATION_MIGRATIONS.length > 0, 'APPLICATION_MIGRATIONS must not be empty');
  for (const migration of APPLICATION_MIGRATIONS) {
    assert.equal(
      typeof migration?.sql,
      'string',
      'each entry of APPLICATION_MIGRATIONS must carry its SQL text as migration.sql',
    );
  }

  const allSql = APPLICATION_MIGRATIONS.map((migration) => migration.sql).join('\n');
  const match = allSql.match(/\bstatus\b[\s\S]{0,120}?check\s*\(\s*status\s+in\s*\(([^)]*)\)\s*\)/i);
  assert.notEqual(
    match,
    null,
    'no CHECK (status IN (...)) constraint found across APPLICATION_MIGRATIONS: this row cannot compare against a constraint it cannot find, which would silently pass by looking at nothing — the runs table must CHECK status against the domain\'s exact status list',
  );

  const listed = new Set(
    match[1]
      .split(',')
      .map((value) => value.trim().replace(/^'|'$/g, ''))
      .filter((value) => value.length > 0),
  );
  const documented = new Set(domain.RUN_STATUSES);

  for (const status of documented) {
    assert.ok(listed.has(status), `RUN_STATUSES has "${status}"; the migration's CHECK constraint does not list it`);
  }
  for (const status of listed) {
    assert.ok(documented.has(status), `the migration's CHECK constraint lists "${status}"; RUN_STATUSES does not have it`);
  }
});

/* -------------------------------------------------------------------------- */
/* Row 4 — every transition the store performs is allowed by the domain       */
/* -------------------------------------------------------------------------- */

test('every status transition the store\'s statements perform is allowed by assertRunTransition', () => {
  const { RUN_STORE_TRANSITIONS } = persistence;

  assert.equal(
    Array.isArray(RUN_STORE_TRANSITIONS),
    true,
    '@aic/persistence must export RUN_STORE_TRANSITIONS: the { from, to } pairs the store\'s own SQL performs (claim, bounded exhaustion, sweep), exposed as data so this row can check each against the domain instead of trusting the SQL text to have gotten it right',
  );
  for (const transition of RUN_STORE_TRANSITIONS) {
    assert.equal(typeof transition?.from, 'string', 'each RUN_STORE_TRANSITIONS entry must carry a string "from"');
    assert.equal(typeof transition?.to, 'string', 'each RUN_STORE_TRANSITIONS entry must carry a string "to"');
    assert.doesNotThrow(
      () => domain.assertRunTransition(transition.from, transition.to),
      `the run store performs ${transition.from}->${transition.to}; the domain refuses it`,
    );
  }

  const pairs = new Set(RUN_STORE_TRANSITIONS.map(({ from, to }) => `${from}->${to}`));
  for (const expected of ['queued->running', 'queued->failed', 'running->queued']) {
    assert.ok(
      pairs.has(expected),
      `RUN_STORE_TRANSITIONS must name ${expected} (claim, bounded exhaustion and sweep respectively)`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Row 5 — claim and sweep exclude locked rows; leases compare against the    */
/* actual current instant, not the transaction's start time                   */
/* -------------------------------------------------------------------------- */

test('the claim and sweep statements use FOR UPDATE SKIP LOCKED, and renewal and claim compare against clock_timestamp() rather than now()', async (t) => {
  const store = await buildRunStore(t);

  assert.equal(
    typeof store.SQL_STATEMENTS,
    'object',
    'createRunStore must expose the SQL statements it will run as store.SQL_STATEMENTS (see this file\'s header for why), mirroring createPostgresCheckpointer\'s saver.SQL_STATEMENTS',
  );

  for (const name of ['claimNext', 'sweepExpired']) {
    assert.equal(typeof store.SQL_STATEMENTS[name], 'string', `SQL_STATEMENTS.${name} must be present`);
    assert.match(
      store.SQL_STATEMENTS[name],
      /for\s+update\s+skip\s+locked/i,
      `${name} must use FOR UPDATE SKIP LOCKED, so a concurrent claim or sweep skips a row another worker or sweep already holds instead of blocking on it`,
    );
  }

  for (const name of ['claimNext', 'renewLease']) {
    assert.equal(typeof store.SQL_STATEMENTS[name], 'string', `SQL_STATEMENTS.${name} must be present`);
    assert.match(
      store.SQL_STATEMENTS[name],
      /clock_timestamp\s*\(\s*\)/i,
      `${name} must compare against clock_timestamp(): now() is fixed for the whole transaction, so a lease check inside one would compare against the transaction's start time rather than the actual current instant`,
    );
    const withoutClockTimestamp = store.SQL_STATEMENTS[name].replace(/clock_timestamp\s*\(\s*\)/gi, '');
    assert.doesNotMatch(
      withoutClockTimestamp,
      /\bnow\s*\(\s*\)/i,
      `${name} must not fall back to now() anywhere in the statement`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Row 6 — the dependency manifest                                            */
/* -------------------------------------------------------------------------- */

test('packages/persistence/package.json declares pg at exactly the version package-lock.json resolves, and declares @aic/domain', () => {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'packages/persistence/package.json'), 'utf8'));
  const dependencies = manifest.dependencies ?? {};

  const lock = JSON.parse(readFileSync(resolve(projectRoot, 'package-lock.json'), 'utf8'));
  const resolvedPgVersion = lock.packages?.['node_modules/pg']?.version;
  assert.equal(
    typeof resolvedPgVersion,
    'string',
    'package-lock.json must resolve node_modules/pg for this row to compare against — an independent oracle, not a second copy of the manifest under test',
  );

  assert.equal(
    dependencies.pg,
    resolvedPgVersion,
    `packages/persistence/package.json must declare "pg": "${resolvedPgVersion}" — pg is already installed once, at this exact version, as a transitive dependency of the PostgreSQL checkpointer; declaring a different version installs a second copy, and a range lets a later npm install resolve a different one on another machine`,
  );
  assert.match(
    String(dependencies.pg),
    /^\d+\.\d+\.\d+$/,
    'pg must be pinned with no ^ or ~, the style row 6 of test/postgres-checkpointer.test.mjs already holds both checkpointer dependencies to',
  );

  assert.equal(
    dependencies['@aic/domain'],
    '0.0.0',
    'packages/persistence/package.json must declare @aic/domain: the run store checks its own statements against domain.RUN_STATUSES and domain.assertRunTransition (rows 3 and 4 above), and a package that imports @aic/domain without declaring it relies on hoisting rather than its own manifest — packages/graph/package.json and packages/tools/package.json both declare it the same way',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 14 (AIC-56 slice C carry-over) — createRun refuses an empty runId      */
/* before touching the database                                               */
/* -------------------------------------------------------------------------- */

test('createRun refuses an empty runId before touching the database', async (t) => {
  const store = await buildRunStore(t);

  await assert.rejects(
    () => store.createRun({ runId: '', input: {} }),
    (error) => {
      assert.ok(error instanceof Error, 'createRun must reject with an Error');
      assert.doesNotMatch(
        error.message,
        /econnrefused|connect|timeout/i,
        `createRun with an empty runId must refuse synchronously, before ever dialing the database — a connection-shaped error message ("${error.message}") means it tried to reach the unreachable address first instead of validating runId`,
      );
      assert.match(
        error.message,
        /runId/,
        'the refusal must name runId as the reason, not surface an unrelated failure',
      );
      return true;
    },
    'an empty runId is never a valid run identity; createRun must refuse it before issuing any SQL',
  );

  assert.deepEqual(
    { totalCount: store.pool.totalCount, idleCount: store.pool.idleCount, waitingCount: store.pool.waitingCount },
    { totalCount: 0, idleCount: 0, waitingCount: 0 },
    'refusing an empty runId must not have touched the pool at all: the unreachable connection string means any real attempt would show up here',
  );
});

test('the migration indexes the claim scan over queued runs and the sweep scan over running leases', () => {
  const sql = persistence.APPLICATION_MIGRATIONS.map((migration) => migration.sql).join('\n');
  assert.match(
    sql,
    /CREATE INDEX[^;]*ON "aic_app"\.runs\s*\(\s*created_at\s*\)\s*WHERE status = 'queued'/i,
    'claimNext orders queued runs by created_at; without a partial index every claim sorts the whole queue',
  );
  assert.match(
    sql,
    /CREATE INDEX[^;]*ON "aic_app"\.runs\s*\(\s*lease_expires_at\s*\)\s*WHERE status = 'running'/i,
    'sweepExpired scans running runs by lease_expires_at; without a partial index every sweep is a sequential scan',
  );
});

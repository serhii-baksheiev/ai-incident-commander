/**
 * AIC-99, slice c (the half decidable WITHOUT a database): migration 3's SQL
 * text shape — the normalized registry tables and the append-only audit the
 * owner's 2026-09-25 ruling asks for
 * (docs/decisions/integration-boundary.md), read the same way
 * test/run-store.test.mjs and test/run-write-context.test.mjs prove migrations
 * 1 and 2 before any connection exists: as exported data
 * (`APPLICATION_MIGRATIONS`), never as a comment trusted to describe the SQL
 * correctly.
 *
 * The half that needs a real PostgreSQL — a registry mutation actually
 * refusing an invalid RegistrySnapshot, `removeEnvironment` cascading, the
 * concurrent-add race, the append-only `registry_events` ledger, and that no
 * secret value is ever stored — cannot be decided here and lives on its own
 * line, `infra/postgres/tests/registry-store.live.mjs`, run through `npm run
 * test:live-postgres` (kept out of `npm test` and `npm run check` by the
 * existing assertion in test/postgres-checkpointer.test.mjs › "keeps the
 * database-backed lane out of npm test and npm run check", which already
 * covers every file under `infra/postgres/tests/*.live.mjs`).
 *
 * ## Design choices this file assumes
 *
 * The task spec names the seven tables and their columns but not how this
 * file slices migration 3's one SQL string into per-table fragments to check
 * each shape in isolation. Two choices, stated here rather than discovered
 * mid-assertion:
 *
 *   - each table's own `CREATE TABLE ... (...)` fragment is extracted with a
 *     small brace-balanced scan from the literal `CREATE TABLE ... "<name>"`
 *     marker to its closing `)`, rather than a single regex that could span
 *     into a neighbouring table's definition. Two tables sharing a substring
 *     of SQL keyword text (`"aic_app".incidents` vs. `"aic_app".registry_events`)
 *     must never let one table's fragment leak into the assertion meant for
 *     the other.
 *   - "incidents has no FK" is read as: the `incidents` table's own fragment
 *     contains no `REFERENCES` keyword at all — the design decision is that
 *     `incidents` carries `primary_service_id` / `primary_environment_id` as
 *     plain columns with no foreign key, precisely so that removing a Service
 *     or Environment (`removeEnvironment` / `removeService`) never cascades
 *     into deleting an Incident.
 *
 * If the implementation has a reason to shape either differently, that reason
 * belongs in the PR description, not in a silent rename here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as persistence from '@aic/persistence';

/**
 * Extracts the `CREATE TABLE ... "<tableName>" ( ... )` fragment for
 * `tableName` out of `sql`, by counting parentheses from the first `(` after
 * the table's own `CREATE TABLE` marker to the matching close — so a nested
 * `CHECK (...)` or a column list containing its own parens never truncates
 * the scan early, and the fragment never runs past this table's own closing
 * paren into whatever follows it in the migration.
 */
function extractCreateTable(sql, tableName) {
  const marker = new RegExp(`CREATE TABLE[^(]*"${tableName}"\\s*\\(`, 'i');
  const match = marker.exec(sql);
  assert.ok(match, `migration 3 must contain "CREATE TABLE ... "${tableName}" (...)"`);

  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex, i + 1);
    }
  }
  throw new Error(`unbalanced parentheses scanning "${tableName}"'s CREATE TABLE fragment`);
}

function migration3Sql() {
  const migrations = persistence.APPLICATION_MIGRATIONS;
  assert.equal(Array.isArray(migrations), true, '@aic/persistence must export APPLICATION_MIGRATIONS');

  const migration3 = migrations.find((migration) => migration?.version === 3);
  assert.ok(
    migration3,
    'APPLICATION_MIGRATIONS must carry a version-3 entry for AIC-99 slice c\'s registry tables (services, environments, credential_refs, source_bindings, action_policies, incidents, registry_events)',
  );
  assert.equal(typeof migration3.sql, 'string', 'migration 3\'s sql must be a non-empty string');
  return migration3.sql;
}

/* -------------------------------------------------------------------------- */
/* Every table migration 3 must create                                        */
/* -------------------------------------------------------------------------- */

test('migration 3 creates all seven registry tables: services, environments, credential_refs, source_bindings, action_policies, incidents, registry_events', () => {
  const sql = migration3Sql();
  for (const tableName of [
    'services',
    'environments',
    'credential_refs',
    'source_bindings',
    'action_policies',
    'incidents',
    'registry_events',
  ]) {
    assert.doesNotThrow(
      () => extractCreateTable(sql, tableName),
      `migration 3 must create "aic_app".${tableName}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* incidents carries no foreign key to services or environments               */
/* -------------------------------------------------------------------------- */

test('incidents has no foreign key to services or environments, so removing either never cascades into deleting an incident', () => {
  const incidentsFragment = extractCreateTable(migration3Sql(), 'incidents');

  assert.doesNotMatch(
    incidentsFragment,
    /REFERENCES/i,
    'incidents.primary_service_id and incidents.primary_environment_id must be plain columns with no REFERENCES clause: docs/decisions/integration-boundary.md rules that removing an Environment preserves incidents, runs and Evidence, and a foreign key to services/environments would let a registry removal cascade into an incident instead',
  );
  assert.match(
    incidentsFragment,
    /\bidempotency_key\b/i,
    'incidents must carry an idempotency_key column: intake carries idempotencyKey so repeated intake does not create a second Incident',
  );
  assert.match(
    incidentsFragment,
    /idempotency_key[^,]*\bUNIQUE\b/i,
    'incidents.idempotency_key must be UNIQUE: repeated intake with the same key must not create a second row',
  );
});

/* -------------------------------------------------------------------------- */
/* source_bindings.credential_ref_id is nullable                              */
/* -------------------------------------------------------------------------- */

test('source_bindings.credential_ref_id is nullable, so a credential-less adapter (e.g. lab@1) can bind with no CredentialRef', () => {
  const sourceBindingsFragment = extractCreateTable(migration3Sql(), 'source_bindings');

  const columnMatch = /credential_ref_id\s+uuid\b([^,]*)/i.exec(sourceBindingsFragment);
  assert.ok(
    columnMatch,
    'source_bindings must declare a credential_ref_id uuid column',
  );
  assert.doesNotMatch(
    columnMatch[1],
    /NOT NULL/i,
    'source_bindings.credential_ref_id must be nullable (no NOT NULL): the domain SourceBinding.credentialRefId is `RegistryIdSchema.nullable()` (packages/domain/src/scope.ts), and a null names a credential-less adapter like lab@1',
  );
  assert.match(
    sourceBindingsFragment,
    /credential_ref_id.*REFERENCES\s+(?:"?aic_app"?\.)?"?credential_refs"?/is,
    'source_bindings.credential_ref_id must reference credential_refs when it is not null, whether or not the REFERENCES target is schema-qualified',
  );
});

/* -------------------------------------------------------------------------- */
/* migration 3 never relies on SET LOCAL search_path                          */
/* -------------------------------------------------------------------------- */

test('migration 3 never sets search_path: every REFERENCES target is schema-qualified instead', () => {
  const sql = migration3Sql();

  assert.doesNotMatch(
    sql,
    /search_path/i,
    'migration 3 must not rely on SET LOCAL search_path to resolve its unqualified REFERENCES targets: a migration\'s statements are self-contained SQL text (app-schema.ts\'s own module doc), so every REFERENCES target here must be schema-qualified ("aic_app"."<table>") instead of depending on a session-level search_path that a caller\'s own connection settings could override',
  );
});

/* -------------------------------------------------------------------------- */
/* registry_events is append-only shaped: a bigserial sequence, no update     */
/* target other tables carry (a status column, a foreign key back to a       */
/* mutable row) that would let a row be revised in place                     */
/* -------------------------------------------------------------------------- */

test('registry_events is shaped append-only: a bigserial primary key sequence and a body column, with no foreign key of its own', () => {
  const registryEventsFragment = extractCreateTable(migration3Sql(), 'registry_events');

  assert.match(
    registryEventsFragment,
    /\bseq\b[^,]*bigserial[^,]*PRIMARY KEY/i,
    'registry_events must key its append-only sequence off a bigserial seq PRIMARY KEY, the same shape fence_rejections (migration 2) already uses for its own append-only ledger',
  );
  assert.match(
    registryEventsFragment,
    /\bbody\s+jsonb\s+NOT NULL\b/i,
    'registry_events must carry a body jsonb NOT NULL column recording what the mutation did',
  );
  assert.doesNotMatch(
    registryEventsFragment,
    /REFERENCES/i,
    'registry_events must carry no foreign key: an event about a Service, Environment or other registry row must remain readable after that row (and, for an Environment, its dependents) is removed',
  );
});

/* -------------------------------------------------------------------------- */
/* action_policies allows at most one row per environment                     */
/* -------------------------------------------------------------------------- */

test('action_policies.environment_id is UNIQUE: at most one ActionPolicy per Environment, mirroring RegistrySnapshotSchema\'s own rule', () => {
  const actionPoliciesFragment = extractCreateTable(migration3Sql(), 'action_policies');

  assert.match(
    actionPoliciesFragment,
    /environment_id[^,]*UNIQUE/i,
    'action_policies.environment_id must be UNIQUE: the domain\'s RegistrySnapshotSchema already refuses a second ActionPolicy for one Environment (scope.ts, "at most one ActionPolicy may exist per Environment"), and the database should enforce the same rule independently',
  );
});

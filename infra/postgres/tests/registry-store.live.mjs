/**
 * AIC-99, slice c — the half that needs a real database of the registry
 * storage the owner's 2026-09-25 ruling approved: migration 3 actually
 * reaching a live PostgreSQL, `createRegistryStore(pool)`'s transactional
 * mutations actually refusing an invalid resulting `RegistrySnapshot` or a
 * duplicate name, `removeEnvironment` actually cascading through its own
 * dependents while leaving an Incident (and every run table) untouched, the
 * append-only `registry_events` ledger actually recording a removal, a
 * concurrent add actually leaving one row rather than two, and that the raw
 * `credential_refs` table never carries anything but a secret's NAME.
 *
 * The half decidable WITHOUT a database — migration 3's SQL text shape
 * (`incidents` has no FK, `source_bindings.credential_ref_id` is nullable,
 * `registry_events` exists) — lives in `test/registry-schema.test.mjs`.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/run-store.live.mjs` and
 * `infra/postgres/tests/durable-run-retention.live.mjs` — see those files'
 * headers for "why this file is not under `test/`", "it refuses; it never
 * skips", and "independent verification" (raw SQL against the store's own
 * pool, never through the methods under test). Not repeated here in full.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## Design choices this file assumes — none of these shapes is chosen yet
 *
 * The task spec names `createRegistryStore(pool)`'s methods but leaves a few
 * things open; each is stated here rather than discovered mid-assertion, and
 * each is a fine implementation choice to shape differently as long as the
 * PR description says so:
 *
 *   - `createRegistryStore` takes an already-open `pg.Pool`, unlike
 *     `createRunStore`'s connection string — this file builds its own `Pool`
 *     from `AIC_POSTGRES_URL` and passes it in, the same pool it also queries
 *     directly for independent verification.
 *   - a mutation that would leave the registry's `RegistrySnapshotSchema`
 *     invalid (a write CredentialRef on a SourceBinding, a CredentialRef from
 *     another Environment, and so on) is refused with a named error,
 *     `RegistryValidationError`, carrying the zod issues as `.issues` — never
 *     the bare database CHECK/FK error those same constraints would otherwise
 *     raise.
 *   - adding an item whose name already exists in its scope is refused with a
 *     second named error, `RegistryConflictError` — distinct from
 *     `RegistryValidationError` because a duplicate name is a conflict with
 *     an existing row, not a shape the resulting snapshot fails to validate.
 *   - `removeService` is chosen to REFUSE (with `RegistryValidationError`)
 *     while the Service still has an Environment, rather than cascading
 *     through `removeEnvironment` for each one — the task spec asks for one
 *     of the two, pinned here as the more conservative of the two for a
 *     Tier-2 storage change (`.claude/rules/autonomy.md`): removing a Service
 *     never silently deletes an Environment's SourceBindings, ActionPolicy
 *     and CredentialRefs as a side effect of removing its owning Service.
 *   - `registry_events.kind` is free text (migration 3's own column has no
 *     CHECK); rows below assert only that a removal's `kind` mentions removal
 *     (`/remov/i`), not an exact literal, so this file does not pin a naming
 *     scheme the acceptance work has not chosen.
 *
 * ## A note on the fixture values below
 *
 * A CredentialRef's `secretName` is itself an UPPERCASE_WITH_UNDERSCORES
 * identifier (`SecretNameSchema`, `packages/domain/src/scope.ts`) — the exact
 * shape `guard-secret-file`'s `assigned-secret` pattern watches for next to a
 * `secretName:` key, even though it never carries an actual secret VALUE
 * (docs/decisions/integration-boundary.md, "Trust boundary"). `secretName(...)`
 * below assembles that identifier from parts at runtime rather than writing it
 * as a literal, the same "assemble credential-shaped strings from pieces"
 * convention the task brief for this slice names.
 *
 * ## Isolation between rows
 *
 * Every row truncates every table migration 3 adds before it starts —
 * `services`, `environments`, `credential_refs`, `source_bindings`,
 * `action_policies`, `incidents`, `registry_events` — the same
 * truncate-before-each-row isolation `run-store.live.mjs`'s `freshStore`
 * uses for `aic_app.runs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place the registry
store's transactional mutations, cascading removal and concurrency behaviour
are measured against a real PostgreSQL, so a skip would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

/** See this file's header, "A note on the fixture values below". */
const secretName = (...parts) => parts.join('_');

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every registry table truncated, and the pool closed at the end of the row —
 * copied in shape from run-store.live.mjs's own `freshStore`.
 */
async function freshRegistryStore(t) {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const pool = new Pool({ connectionString });
  t.after(async () => {
    await pool.end();
  });
  await pool.query(
    `truncate table aic_app.registry_events, aic_app.incidents, aic_app.action_policies,
       aic_app.source_bindings, aic_app.credential_refs, aic_app.environments, aic_app.services
     restart identity cascade`,
  );
  const store = persistence.createRegistryStore(pool);
  return { store, pool };
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* Migration 3 actually reaches a live PostgreSQL, idempotently              */
/* -------------------------------------------------------------------------- */

test('migrating an empty database reaches APP_SCHEMA_VERSION 3, and re-running setupApplicationSchema is idempotent', async (t) => {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  await persistence.setupApplicationSchema(connectionString);

  const pool = new Pool({ connectionString });
  t.after(() => pool.end());

  // Asserted directly against the literal 3, not only against
  // `persistence.APP_SCHEMA_VERSION`: `assertApplicationSchemaVersion` compares
  // the applied version to whatever that constant currently is, so a build that
  // has not yet added migration 3 (APP_SCHEMA_VERSION still 2) would pass the
  // doesNotReject below vacuously — both sides would read 2. This row is
  // specifically about reaching 3, so it pins the number independently of the
  // constant under test (test/run-write-context.test.mjs pins the same number
  // without a database).
  assert.equal(
    persistence.APP_SCHEMA_VERSION,
    3,
    'AIC-99 slice c\'s migration 3 must exist: APP_SCHEMA_VERSION must be 3, not the pre-slice-c value',
  );

  const { rows } = await pool.query(`select max(version) as v from "${persistence.APPLICATION_SCHEMA}".schema_migrations`);
  assert.equal(
    Number(rows[0]?.v),
    3,
    'after setupApplicationSchema, aic_app.schema_migrations must report that migration 3 has actually been applied to this database, not only that the build declares it',
  );

  await assert.doesNotReject(
    () => persistence.assertApplicationSchemaVersion(pool),
    'after two applications the application schema must report exactly APP_SCHEMA_VERSION, or the migration runner is not idempotent',
  );
});

/* -------------------------------------------------------------------------- */
/* addSourceBinding refuses a write CredentialRef                             */
/* -------------------------------------------------------------------------- */

test('addSourceBinding refuses a binding whose credentialRefName names a write-access CredentialRef', async (t) => {
  const { store } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });
  await store.addCredentialRef({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'deploy-write',
    access: 'write',
    secretName: secretName('DEPLOY', 'WRITE', 'TOKEN'),
  });

  await assert.rejects(
    () =>
      store.addSourceBinding({
        serviceName: 'checkout',
        environmentName: 'staging',
        name: 'github-source',
        adapterId: 'github',
        adapterVersion: '1',
        config: { owner: 'my-org', repo: 'checkout' },
        credentialRefName: 'deploy-write',
      }),
    (error) => {
      assert.equal(
        error.name,
        'RegistryValidationError',
        'a SourceBinding.credentialRefId must name a read CredentialRef (RegistrySnapshotSchema, scope.ts); a write CredentialRef must be refused with the typed validation error, not a bare database error',
      );
      assert.ok(
        Array.isArray(error.issues) && error.issues.length > 0,
        'RegistryValidationError must carry the zod issues describing what failed',
      );
      return true;
    },
    'addSourceBinding must refuse rather than store a binding whose resulting RegistrySnapshot would be invalid',
  );
});

/* -------------------------------------------------------------------------- */
/* addSourceBinding refuses another environment's credential name             */
/* -------------------------------------------------------------------------- */

test('addSourceBinding refuses a credentialRefName that exists only in another Environment', async (t) => {
  const { store } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });
  await store.addEnvironment({ serviceName: 'checkout', name: 'production' });
  await store.addCredentialRef({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'github-read',
    access: 'read',
    secretName: secretName('GITHUB', 'READ', 'TOKEN'),
  });

  await assert.rejects(
    () =>
      store.addSourceBinding({
        serviceName: 'checkout',
        environmentName: 'production',
        name: 'github-source',
        adapterId: 'github',
        adapterVersion: '1',
        config: { owner: 'my-org', repo: 'checkout' },
        credentialRefName: 'github-read',
      }),
    (error) => {
      assert.equal(
        error.name,
        'RegistryValidationError',
        'github-read exists only in staging: production\'s addSourceBinding must not resolve a credentialRefName belonging to a sibling Environment',
      );
      return true;
    },
    'a CredentialRef name is scoped to the Environment it was added in, and a binding in a different Environment naming it must be refused',
  );
});

/* -------------------------------------------------------------------------- */
/* addSourceBinding refuses a duplicate name within one Environment, and      */
/* accepts the same name in a different Environment                          */
/* -------------------------------------------------------------------------- */

test('addSourceBinding refuses a duplicate name within one Environment, and accepts the same name in a different Environment', async (t) => {
  const { store } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });
  await store.addEnvironment({ serviceName: 'checkout', name: 'production' });

  await store.addSourceBinding({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'lab-source',
    adapterId: 'lab',
    adapterVersion: '1',
    config: {},
    credentialRefName: null,
  });

  await assert.rejects(
    () =>
      store.addSourceBinding({
        serviceName: 'checkout',
        environmentName: 'staging',
        name: 'lab-source',
        adapterId: 'lab',
        adapterVersion: '1',
        config: {},
        credentialRefName: null,
      }),
    (error) => {
      assert.equal(
        error.name,
        'RegistryConflictError',
        'a second SourceBinding named lab-source in the same Environment must be refused as already existing, so the create path is not silently idempotent',
      );
      return true;
    },
  );

  await assert.doesNotReject(
    () =>
      store.addSourceBinding({
        serviceName: 'checkout',
        environmentName: 'production',
        name: 'lab-source',
        adapterId: 'lab',
        adapterVersion: '1',
        config: {},
        credentialRefName: null,
      }),
    'the same SourceBinding name in a different Environment must be accepted: RegistrySnapshotSchema scopes name uniqueness per Environment, not globally',
  );
});

/* -------------------------------------------------------------------------- */
/* Adding a Service or Environment that already exists by name is refused    */
/* -------------------------------------------------------------------------- */

test('addService and addEnvironment refuse a duplicate name with the typed conflict error rather than silently succeeding', async (t) => {
  const { store } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });

  await assert.rejects(
    () => store.addService({ name: 'checkout', repositoryAliases: [] }),
    (error) => {
      assert.equal(error.name, 'RegistryConflictError');
      return true;
    },
    'adding a Service whose name already exists must be refused: the create path is not silently idempotent (idempotent apply belongs to a later slice)',
  );

  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });
  await assert.rejects(
    () => store.addEnvironment({ serviceName: 'checkout', name: 'staging' }),
    (error) => {
      assert.equal(error.name, 'RegistryConflictError');
      return true;
    },
    'adding an Environment whose name already exists within its Service must be refused',
  );
});

/* -------------------------------------------------------------------------- */
/* snapshot() round-trips a credential-less binding and a configured one      */
/* -------------------------------------------------------------------------- */

test('snapshot() round-trips a lab binding with credentialRefName: null and a github binding with config {owner, repo}, and the result parses as a RegistrySnapshot', async (t) => {
  const { store } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: ['org/checkout'] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });
  await store.addCredentialRef({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'github-read',
    access: 'read',
    secretName: secretName('GITHUB', 'READ', 'TOKEN'),
  });
  await store.addSourceBinding({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'lab-source',
    adapterId: 'lab',
    adapterVersion: '1',
    config: {},
    credentialRefName: null,
  });
  await store.addSourceBinding({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'github-source',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: 'my-org', repo: 'checkout' },
    credentialRefName: 'github-read',
  });

  const snapshot = await store.snapshot();

  assert.doesNotThrow(
    () => domain.RegistrySnapshotSchema.parse(snapshot),
    'snapshot() must return a value RegistrySnapshotSchema.parse accepts — the independent oracle for "the whole resulting snapshot validates"',
  );

  const labBinding = snapshot.sourceBindings.find((binding) => binding.name === 'lab-source');
  const githubBinding = snapshot.sourceBindings.find((binding) => binding.name === 'github-source');
  const githubCredential = snapshot.credentialRefs.find((ref) => ref.name === 'github-read');

  assert.ok(labBinding, 'snapshot() must include the lab-source SourceBinding');
  assert.equal(labBinding.credentialRefId, null, 'lab-source was added with credentialRefName: null and must round-trip with credentialRefId: null');

  assert.ok(githubBinding, 'snapshot() must include the github-source SourceBinding');
  assert.deepEqual(
    githubBinding.config,
    { owner: 'my-org', repo: 'checkout' },
    'github-source\'s config must round-trip exactly as added',
  );
  assert.ok(githubCredential, 'snapshot() must include the github-read CredentialRef');
  assert.equal(
    githubBinding.credentialRefId,
    githubCredential.id,
    'github-source\'s credentialRefId must round-trip to github-read\'s server-assigned id',
  );
});

/* -------------------------------------------------------------------------- */
/* removeEnvironment cascades to its own dependents, preserves an incident,   */
/* and records the removal in registry_events                                */
/* -------------------------------------------------------------------------- */

test('removeEnvironment deletes its bindings, policy and credential refs, keeps an incident inserted for that scope, and records the removal in registry_events', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'billing', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'billing', name: 'production' });
  await store.addCredentialRef({
    serviceName: 'billing',
    environmentName: 'production',
    name: 'billing-read',
    access: 'read',
    secretName: secretName('BILLING', 'READ', 'TOKEN'),
  });
  await store.addCredentialRef({
    serviceName: 'billing',
    environmentName: 'production',
    name: 'billing-write',
    access: 'write',
    secretName: secretName('BILLING', 'WRITE', 'TOKEN'),
  });
  await store.addSourceBinding({
    serviceName: 'billing',
    environmentName: 'production',
    name: 'github-source',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: 'my-org', repo: 'billing' },
    credentialRefName: 'billing-read',
  });
  await store.setActionPolicy({
    serviceName: 'billing',
    environmentName: 'production',
    allowedActionTypes: ['restart-pod'],
    writeCredentialRefNames: ['billing-write'],
  });

  const beforeRemoval = await store.snapshot();
  const service = beforeRemoval.services.find((candidate) => candidate.name === 'billing');
  const environment = beforeRemoval.environments.find((candidate) => candidate.name === 'production');
  assert.ok(service && environment, 'the registry must carry the Service and Environment this row just built');

  // Inserted directly with SQL: incidents carries no foreign key to services
  // or environments (test/registry-schema.test.mjs), so this row does not go
  // through the registry store at all — it proves the table survives a
  // removal it has no referential link to.
  const incidentId = 'incident-scope-preserved';
  await pool.query(
    `insert into aic_app.incidents (id, idempotency_key, primary_service_id, primary_environment_id, body)
     values ($1, $2, $3, $4, '{}'::jsonb)`,
    [incidentId, 'sha256:' + '0'.repeat(64), service.id, environment.id],
  );

  await store.removeEnvironment({ serviceName: 'billing', environmentName: 'production' });

  const afterRemoval = await store.snapshot();
  assert.equal(
    afterRemoval.environments.some((candidate) => candidate.id === environment.id),
    false,
    'the removed Environment must be gone from the snapshot',
  );
  assert.equal(
    afterRemoval.sourceBindings.some((binding) => binding.environmentId === environment.id),
    false,
    'removeEnvironment must delete the Environment\'s SourceBindings',
  );
  assert.equal(
    afterRemoval.credentialRefs.some((ref) => ref.environmentId === environment.id),
    false,
    'removeEnvironment must delete the Environment\'s CredentialRefs',
  );
  assert.equal(
    afterRemoval.actionPolicies.some((policy) => policy.environmentId === environment.id),
    false,
    'removeEnvironment must delete the Environment\'s ActionPolicy',
  );

  const { rows: incidentRows } = await pool.query('select id from aic_app.incidents where id = $1', [incidentId]);
  assert.equal(
    incidentRows.length,
    1,
    'docs/decisions/integration-boundary.md rules that removing an Environment preserves incidents: the directly-inserted incident must still be present',
  );

  const { rows: eventRows } = await pool.query(
    `select kind, subject_id from aic_app.registry_events where subject_id = $1 order by seq`,
    [environment.id],
  );
  assert.ok(
    eventRows.some((row) => /remov/i.test(row.kind)),
    'registry_events must record removeEnvironment\'s removal, with the removed Environment as subject_id',
  );
});

/* -------------------------------------------------------------------------- */
/* removeService refuses while the Service still has an Environment          */
/* -------------------------------------------------------------------------- */

test('removeService refuses while the Service still has an Environment', async (t) => {
  const { store } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });

  await assert.rejects(
    () => store.removeService({ serviceName: 'checkout' }),
    (error) => {
      assert.equal(
        error.name,
        'RegistryValidationError',
        'this file\'s header pins removeService to refuse-while-non-empty (not cascading through removeEnvironment): removing a Service must be refused while it still has an Environment',
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Concurrent addSourceBinding calls with the same name: exactly one row      */
/* survives, and the loser gets the typed conflict error                     */
/* -------------------------------------------------------------------------- */

test('concurrent addSourceBinding calls with the same name in the same Environment leave exactly one row, and the loser gets the typed conflict error', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });

  const attempt = () =>
    store.addSourceBinding({
      serviceName: 'checkout',
      environmentName: 'staging',
      name: 'race-source',
      adapterId: 'lab',
      adapterVersion: '1',
      config: {},
      credentialRefName: null,
    });

  const results = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(
    fulfilled.length,
    1,
    'exactly one of two concurrent addSourceBinding calls racing on the same name must succeed: every mutation runs in one transaction serialized by a transaction-scoped advisory lock, so this must be deterministic rather than "usually one"',
  );
  assert.equal(rejected.length, 1, 'the other concurrent call must be refused rather than the two silently producing two rows');
  assert.equal(
    rejected[0].reason?.name,
    'RegistryConflictError',
    'the losing concurrent call must fail with the typed already-exists error, not a raw database unique-constraint violation',
  );

  const { rows } = await pool.query(`select count(*)::int as n from aic_app.source_bindings where name = 'race-source'`);
  assert.equal(rows[0].n, 1, 'exactly one source_bindings row named race-source must exist after the race, never zero and never two');
});

/* -------------------------------------------------------------------------- */
/* No secret value is ever stored: CredentialRef stores only secretName       */
/* -------------------------------------------------------------------------- */

test('credential_refs stores only a secretName, never a secret value: verified by reading the raw table and its columns', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'checkout', name: 'staging' });
  const expectedSecretName = secretName('GITHUB', 'READ', 'TOKEN');
  await store.addCredentialRef({
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'github-read',
    access: 'read',
    secretName: expectedSecretName,
  });

  const { rows: columnRows } = await pool.query(
    `select column_name from information_schema.columns where table_schema = 'aic_app' and table_name = 'credential_refs' order by column_name`,
  );
  const columnNames = columnRows.map((row) => row.column_name).sort();
  assert.deepEqual(
    columnNames,
    ['access', 'environment_id', 'id', 'name', 'secret_name'].sort(),
    'aic_app.credential_refs must carry exactly id, environment_id, name, access and secret_name — no column exists anywhere in this table shaped to hold an actual secret value',
  );

  const { rows: dataRows } = await pool.query(
    `select access, secret_name from aic_app.credential_refs where name = 'github-read'`,
  );
  assert.deepEqual(
    dataRows,
    [{ access: 'read', secret_name: expectedSecretName }],
    'the raw row must carry exactly the secretName passed to addCredentialRef, never a value derived from or resembling a real secret',
  );
});

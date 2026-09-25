/**
 * AIC-99, slice c — the half that needs a real database of the registry
 * storage the owner's 2026-09-25 ruling approved: migration 3 actually
 * reaching a live PostgreSQL, `createRegistryStore(pool)`'s transactional
 * mutations actually refusing an invalid resulting `RegistrySnapshot` or a
 * duplicate name, `removeEnvironment` actually cascading through its own
 * dependents, `removeService` actually cascading through every one of its
 * Environments and each of THEIR dependents in turn (the owner's 2026-09-25
 * Jira AIC-99 comment 20973 ruling: CASCADE, not refuse-while-non-empty),
 * both leaving `incidents`, `runs`, `node_results`, `run_event_counters`,
 * `run_events`, `run_trials`, `run_evidence` and `fence_rejections` untouched
 * for the removed scope, the append-only `registry_events` ledger actually
 * recording each removal, a concurrent add actually leaving one row rather
 * than two, and that the raw `credential_refs` table never carries anything
 * but a secret's NAME.
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
 * ## Design choices this file pins
 *
 * The task spec names `createRegistryStore(pool)`'s methods but leaves a few
 * things open; each is stated here rather than discovered mid-assertion:
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
 *   - `removeService` CASCADES through every Environment the Service still
 *     has, and through each of THEIR own SourceBindings, CredentialRefs and
 *     ActionPolicy in turn — the owner's 2026-09-25 ruling on Jira AIC-99
 *     comment 20973, which supersedes this file's earlier round-1 choice to
 *     refuse while non-empty. Removal must never leave an Environment active
 *     under a removed Service, so the cascade is unconditional: `removeService`
 *     given a Service with Environments deletes the Service, every one of
 *     those Environments, and every SourceBinding, CredentialRef and
 *     ActionPolicy that belonged to any of them.
 *   - `registry_events.kind` is free text (migration 3's own column has no
 *     CHECK); rows below assert only that a removal's `kind` mentions removal
 *     (`/remov/i`), not an exact literal, so this file does not pin a naming
 *     scheme the acceptance work has not chosen.
 *   - `removeEnvironment` / `removeService` given a `serviceName` /
 *     `environmentName` that names nothing must REFUSE with
 *     `RegistryValidationError`, the same typed error every other invalid
 *     mutation in this file already carries, rather than treating the call as
 *     a no-op: `resolve*` in `registry-store.ts` hands an unresolved name a
 *     fresh, never-matching id precisely so a resulting snapshot that still
 *     references it fails `RegistrySnapshotSchema`'s cross-reference checks —
 *     but a *removal* built from that same fresh id never lands in any such
 *     snapshot: filtering by an id nothing carries removes nothing, so the
 *     mutation's own generic validate-the-result step sees no change at all
 *     and lets it through. Each row below in "refuses an unresolved name"
 *     also checks that no `registry_events` row was appended for the id that
 *     was never real.
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
 * uses for `aic_app.runs`. `incidents` is migration 3's own table and is
 * truncated with the rest; the migration-2 run tables
 * (`runs`, `node_results`, `run_event_counters`, `run_events`, `run_trials`,
 * `run_evidence`, `fence_rejections`) are NOT truncated between rows — a
 * removal must never touch them regardless of what else already lives there,
 * so the two rows below that seed one (`insertHistoricalAuditRows`) key every
 * inserted row on a scope-specific `run_id`/`id`, unique per row, rather than
 * relying on the tables starting empty.
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
 * The eight tables that carry historical audit material: `incidents`
 * (migration 3) plus the seven run tables migration 2 added. None of the
 * seven carries a foreign key to `services`/`environments`/`incidents`
 * (test/registry-schema.test.mjs), so a removal has no referential path to
 * any of them — this is what `insertHistoricalAuditRows` /
 * `assertHistoricalAuditRowsUnchanged` below exist to prove directly, rather
 * than by omission.
 */
const AUDIT_TABLE_READS = Object.freeze({
  incidents: (pool, ids) => pool.query('select * from aic_app.incidents where id = $1', [ids.incidentId]),
  runs: (pool, ids) => pool.query('select * from aic_app.runs where run_id = $1', [ids.runId]),
  node_results: (pool, ids) => pool.query('select * from aic_app.node_results where run_id = $1', [ids.runId]),
  run_event_counters: (pool, ids) =>
    pool.query('select * from aic_app.run_event_counters where run_id = $1', [ids.runId]),
  run_events: (pool, ids) => pool.query('select * from aic_app.run_events where run_id = $1', [ids.runId]),
  run_trials: (pool, ids) => pool.query('select * from aic_app.run_trials where run_id = $1', [ids.runId]),
  run_evidence: (pool, ids) => pool.query('select * from aic_app.run_evidence where run_id = $1', [ids.runId]),
  fence_rejections: (pool, ids) => pool.query('select * from aic_app.fence_rejections where run_id = $1', [ids.runId]),
});

/**
 * Seeds one row in every table `AUDIT_TABLE_READS` names, directly with SQL
 * (never through `RegistryStore` — none of these tables is one it writes),
 * keyed on a `scopeName`-derived `incidentId`/`runId` unique to the calling
 * row so two rows in this file never collide on the same run/incident id.
 * `fence_rejections` is populated the same way `run-write-context.live.mjs`
 * populates it: one row recording a refused write attempt, not tied to a
 * completed run's own lifecycle.
 */
async function insertHistoricalAuditRows(pool, scopeName) {
  const incidentId = `incident-${scopeName}`;
  const runId = `run-${scopeName}`;
  await pool.query(
    `insert into aic_app.incidents (id, idempotency_key, primary_service_id, primary_environment_id, body)
     values ($1, $2, null, null, '{}'::jsonb)`,
    [incidentId, `idempotency-key-${scopeName}`],
  );
  await pool.query(`insert into aic_app.runs (run_id, status, input) values ($1, 'completed', '{}'::jsonb)`, [runId]);
  await pool.query(
    `insert into aic_app.node_results (run_id, exec_key, op, result_json, result_sha, produced_by_attempt)
     values ($1, 'exec-1', 'op', '{}', 'sha-1', 1)`,
    [runId],
  );
  await pool.query(`insert into aic_app.run_event_counters (run_id, next_seq) values ($1, 1)`, [runId]);
  await pool.query(
    `insert into aic_app.run_events (run_id, seq, type, execution_attempt) values ($1, 0, 'started', 1)`,
    [runId],
  );
  await pool.query(`insert into aic_app.run_trials (run_id, trial_id, body) values ($1, 'trial-1', '{}')`, [runId]);
  await pool.query(
    `insert into aic_app.run_evidence (run_id, evidence_id, trial_id, body) values ($1, 'evidence-1', 'trial-1', '{}')`,
    [runId],
  );
  await pool.query(
    `insert into aic_app.fence_rejections (run_id, owner_worker_id, execution_attempt, kind) values ($1, 'worker-1', 1, 'lease-lost')`,
    [runId],
  );
  return { incidentId, runId };
}

/** Reads all eight audit tables' rows for `ids` in one shot, for a before/after comparison. */
async function captureHistoricalAuditRows(pool, ids) {
  const captured = {};
  for (const [table, read] of Object.entries(AUDIT_TABLE_READS)) {
    captured[table] = (await read(pool, ids)).rows;
  }
  return captured;
}

/**
 * Asserts every one of the eight audit tables still carries exactly the one
 * row `insertHistoricalAuditRows` seeded for `ids`, byte-for-byte unchanged —
 * this is the independent oracle for "a removal touched none of them": it
 * reads the raw tables again rather than trusting that the store's own
 * mutation stayed inside the rows it names.
 */
async function assertHistoricalAuditRowsUnchanged(pool, ids, before, removalDescription) {
  const after = await captureHistoricalAuditRows(pool, ids);
  for (const table of Object.keys(AUDIT_TABLE_READS)) {
    assert.equal(
      after[table].length,
      1,
      `${removalDescription} must leave exactly the one aic_app.${table} row this row seeded for the removed scope, found ${after[table].length}`,
    );
    assert.deepEqual(
      after[table],
      before[table],
      `${removalDescription} must leave aic_app.${table}'s row for the removed scope byte-for-byte unchanged`,
    );
  }
}

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
/* removeEnvironment cascades to its own dependents, preserves every         */
/* historical audit table's row for that scope, and records the removal in  */
/* registry_events                                                           */
/* -------------------------------------------------------------------------- */

test('removeEnvironment deletes its bindings, policy and credential refs, keeps every historical audit table\'s row for that scope byte-for-byte unchanged, and records the removal in registry_events', async (t) => {
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

  // Seeded directly with SQL, one row in every one of the eight audit tables
  // this file's header names — see "Isolation between rows" for why these
  // tables are not truncated, and this file's header for why none carries a
  // foreign key to services/environments.
  const auditIds = await insertHistoricalAuditRows(pool, 'environment-removal');
  const auditRowsBefore = await captureHistoricalAuditRows(pool, auditIds);
  for (const table of Object.keys(auditRowsBefore)) {
    assert.equal(auditRowsBefore[table].length, 1, `this row must have seeded exactly one aic_app.${table} row before removal`);
  }

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

  await assertHistoricalAuditRowsUnchanged(
    pool,
    auditIds,
    auditRowsBefore,
    'docs/decisions/integration-boundary.md rules that removing an Environment preserves incidents, runs, Evidence and action history: removeEnvironment',
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
/* removeService CASCADES through every Environment it still has, and       */
/* through each of THEIR SourceBindings, CredentialRefs and ActionPolicy —  */
/* the owner's 2026-09-25 ruling (Jira AIC-99 comment 20973). Historical    */
/* audit material for the removed scope survives, and an unrelated Service  */
/* is untouched.                                                            */
/* -------------------------------------------------------------------------- */

test('removeService cascades through both of a Service\'s Environments and their SourceBindings, CredentialRefs and ActionPolicy, records one environment.removed per Environment plus one service.removed, keeps every historical audit table\'s row for that scope byte-for-byte unchanged, and leaves an unrelated Service and its Environment untouched', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'checkout', repositoryAliases: [] });

  for (const environmentName of ['staging', 'production']) {
    await store.addEnvironment({ serviceName: 'checkout', name: environmentName });
    await store.addCredentialRef({
      serviceName: 'checkout',
      environmentName,
      name: `${environmentName}-read`,
      access: 'read',
      secretName: secretName('CHECKOUT', environmentName.toUpperCase(), 'READ', 'TOKEN'),
    });
    await store.addCredentialRef({
      serviceName: 'checkout',
      environmentName,
      name: `${environmentName}-write`,
      access: 'write',
      secretName: secretName('CHECKOUT', environmentName.toUpperCase(), 'WRITE', 'TOKEN'),
    });
    await store.addSourceBinding({
      serviceName: 'checkout',
      environmentName,
      name: `${environmentName}-source`,
      adapterId: 'github',
      adapterVersion: '1',
      config: { owner: 'my-org', repo: 'checkout' },
      credentialRefName: `${environmentName}-read`,
    });
    await store.setActionPolicy({
      serviceName: 'checkout',
      environmentName,
      allowedActionTypes: ['restart-pod'],
      writeCredentialRefNames: [`${environmentName}-write`],
    });
  }

  // An unrelated Service (and its Environment) this removal must never touch.
  await store.addService({ name: 'reporting', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'reporting', name: 'production' });

  const beforeRemoval = await store.snapshot();
  const service = beforeRemoval.services.find((candidate) => candidate.name === 'checkout');
  const removedEnvironments = beforeRemoval.environments.filter((candidate) => candidate.serviceId === service.id);
  assert.equal(
    removedEnvironments.length,
    2,
    'this row must have built exactly two Environments under checkout to prove the cascade reaches both, not merely one',
  );
  const removedEnvironmentIds = removedEnvironments.map((environment) => environment.id);
  const removedSourceBindingIds = beforeRemoval.sourceBindings
    .filter((binding) => removedEnvironmentIds.includes(binding.environmentId))
    .map((binding) => binding.id);
  const removedCredentialRefIds = beforeRemoval.credentialRefs
    .filter((ref) => removedEnvironmentIds.includes(ref.environmentId))
    .map((ref) => ref.id);
  const removedActionPolicyIds = beforeRemoval.actionPolicies
    .filter((policy) => removedEnvironmentIds.includes(policy.environmentId))
    .map((policy) => policy.id);
  assert.equal(removedSourceBindingIds.length, 2, 'each of the two Environments must own exactly one SourceBinding before removal');
  assert.equal(removedCredentialRefIds.length, 4, 'each of the two Environments must own exactly one read and one write CredentialRef before removal');
  assert.equal(removedActionPolicyIds.length, 2, 'each of the two Environments must own exactly one ActionPolicy before removal');

  const reportingService = beforeRemoval.services.find((candidate) => candidate.name === 'reporting');
  const reportingEnvironment = beforeRemoval.environments.find((candidate) => candidate.serviceId === reportingService.id);

  // Seeded directly with SQL, one row in every one of the eight audit tables
  // this file's header names, keyed to the removed scope.
  const auditIds = await insertHistoricalAuditRows(pool, 'service-cascade-removal');
  const auditRowsBefore = await captureHistoricalAuditRows(pool, auditIds);
  for (const table of Object.keys(auditRowsBefore)) {
    assert.equal(auditRowsBefore[table].length, 1, `this row must have seeded exactly one aic_app.${table} row before removal`);
  }

  // registry_events is append-only, and addService/addEnvironment above
  // already appended their own service.added/environment.added rows naming
  // these same subject_ids — so a query scoped by subject_id would also
  // match those earlier rows, not only the ones this removal is about to
  // append. Reading the ledger's own high-water mark immediately before the
  // removal, and later selecting only what landed after it, isolates
  // exactly the events removeService itself appends.
  const { rows: seqRowsBefore } = await pool.query(
    'select coalesce(max(seq), 0) as seq from aic_app.registry_events',
  );
  const seqBeforeRemoval = Number(seqRowsBefore[0].seq);

  await store.removeService({ serviceName: 'checkout' });

  // Independent of snapshot(): the raw tables must carry none of the removed
  // scope's rows.
  const { rows: serviceRows } = await pool.query('select id from aic_app.services where id = $1', [service.id]);
  assert.equal(serviceRows.length, 0, 'removeService must delete the Service row itself');

  const { rows: environmentRows } = await pool.query('select id from aic_app.environments where service_id = $1', [
    service.id,
  ]);
  assert.equal(
    environmentRows.length,
    0,
    'removeService must delete every Environment of the removed Service — the owner\'s ruling is CASCADE, not refuse-while-non-empty',
  );

  const { rows: sourceBindingRows } = await pool.query(
    'select id from aic_app.source_bindings where environment_id = any($1::uuid[])',
    [removedEnvironmentIds],
  );
  assert.equal(sourceBindingRows.length, 0, 'removeService must delete every SourceBinding of every cascaded Environment');

  const { rows: credentialRefRows } = await pool.query(
    'select id from aic_app.credential_refs where environment_id = any($1::uuid[])',
    [removedEnvironmentIds],
  );
  assert.equal(
    credentialRefRows.length,
    0,
    'removeService must delete every CredentialRef (both read- and write-access) of every cascaded Environment',
  );

  const { rows: actionPolicyRows } = await pool.query(
    'select id from aic_app.action_policies where environment_id = any($1::uuid[])',
    [removedEnvironmentIds],
  );
  assert.equal(actionPolicyRows.length, 0, 'removeService must delete every ActionPolicy of every cascaded Environment');

  // snapshot() must carry none of the removed scope either.
  const afterRemoval = await store.snapshot();
  assert.equal(
    afterRemoval.services.some((candidate) => candidate.id === service.id),
    false,
    'snapshot() must not carry the removed Service',
  );
  assert.equal(
    afterRemoval.environments.some((candidate) => removedEnvironmentIds.includes(candidate.id)),
    false,
    'snapshot() must not carry a cascaded Environment',
  );
  assert.equal(
    afterRemoval.sourceBindings.some((binding) => removedSourceBindingIds.includes(binding.id)),
    false,
    'snapshot() must not carry a cascaded Environment\'s SourceBinding',
  );
  assert.equal(
    afterRemoval.credentialRefs.some((ref) => removedCredentialRefIds.includes(ref.id)),
    false,
    'snapshot() must not carry a cascaded Environment\'s CredentialRef',
  );
  assert.equal(
    afterRemoval.actionPolicies.some((policy) => removedActionPolicyIds.includes(policy.id)),
    false,
    'snapshot() must not carry a cascaded Environment\'s ActionPolicy',
  );

  // registry_events: exactly one event per cascaded Environment plus one for
  // the Service — this file's design choice keeps `kind` a free-text mention
  // of "remov" (see this file's header), so the shape pinned here is the
  // COUNT and the SUBJECT of each event, not a literal string. Scoped by
  // seq > seqBeforeRemoval rather than by subject_id: the ledger is
  // append-only, and addService/addEnvironment above already appended
  // service.added/environment.added rows naming these same subject_ids, so a
  // subject_id filter would also match those earlier rows. Scoping by seq
  // isolates exactly the events this removal appended, and — being unfiltered
  // by subject_id — also catches a stray event about any other subject.
  const { rows: eventRows } = await pool.query(
    `select kind, subject_id from aic_app.registry_events where seq > $1 order by seq`,
    [seqBeforeRemoval],
  );
  const environmentRemovalEvents = eventRows.filter((row) => removedEnvironmentIds.includes(row.subject_id));
  const serviceRemovalEvents = eventRows.filter((row) => row.subject_id === service.id);
  assert.equal(
    eventRows.length,
    removedEnvironmentIds.length + 1,
    'registry_events must record exactly one event per cascaded Environment plus one for the Service, no more and no fewer',
  );
  assert.equal(
    environmentRemovalEvents.length,
    removedEnvironmentIds.length,
    'registry_events must record exactly one event per cascaded Environment, each naming that Environment as subject_id',
  );
  assert.ok(
    environmentRemovalEvents.every((row) => /remov/i.test(row.kind)),
    'each cascaded Environment\'s event must mention a removal',
  );
  assert.equal(serviceRemovalEvents.length, 1, 'registry_events must record exactly one event naming the removed Service as subject_id');
  assert.ok(/remov/i.test(serviceRemovalEvents[0].kind), 'the Service\'s own event must mention a removal');

  await assertHistoricalAuditRowsUnchanged(
    pool,
    auditIds,
    auditRowsBefore,
    'the owner\'s ruling preserves incidents, runs, Evidence and action history through a cascading removeService: removeService',
  );

  // An unrelated Service (and its Environment) must survive untouched.
  const { rows: survivingServiceRows } = await pool.query('select id, name from aic_app.services where id = $1', [
    reportingService.id,
  ]);
  assert.deepEqual(
    survivingServiceRows,
    [{ id: reportingService.id, name: 'reporting' }],
    'an unrelated Service must survive removeService\'s cascade untouched',
  );
  const { rows: survivingEnvironmentRows } = await pool.query(
    'select id, name from aic_app.environments where id = $1',
    [reportingEnvironment.id],
  );
  assert.deepEqual(
    survivingEnvironmentRows,
    [{ id: reportingEnvironment.id, name: 'production' }],
    'an unrelated Service\'s Environment must survive removeService\'s cascade untouched',
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

/* -------------------------------------------------------------------------- */
/* removeEnvironment refuses an unresolved environmentName, and changes       */
/* nothing: no cascade, no registry_events row                                */
/* -------------------------------------------------------------------------- */

test('removeEnvironment refuses an environmentName that names no Environment of the Service, and leaves the real Environment\'s write CredentialRef, ActionPolicy and registry_events untouched', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'billing', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'billing', name: 'production' });
  const writeCredential = await store.addCredentialRef({
    serviceName: 'billing',
    environmentName: 'production',
    name: 'billing-write',
    access: 'write',
    secretName: secretName('BILLING', 'WRITE', 'TOKEN'),
  });
  await store.setActionPolicy({
    serviceName: 'billing',
    environmentName: 'production',
    allowedActionTypes: ['restart-pod'],
    writeCredentialRefNames: ['billing-write'],
  });

  const { rows: eventsBefore } = await pool.query('select count(*)::int as n from aic_app.registry_events');

  await assert.rejects(
    () => store.removeEnvironment({ serviceName: 'billing', environmentName: 'production-typo' }),
    (error) => {
      assert.equal(
        error.name,
        'RegistryValidationError',
        '"production-typo" names no Environment of "billing": removeEnvironment must refuse rather than resolving it to a fresh id that matches no row and then reporting success for a removal that removed nothing',
      );
      return true;
    },
    'removeEnvironment given a misspelled environmentName must reject rather than resolve to fulfilled',
  );

  const snapshot = await store.snapshot();
  const survivingCredential = snapshot.credentialRefs.find((ref) => ref.id === writeCredential.id);
  assert.ok(
    survivingCredential,
    'the real Environment\'s write CredentialRef must still exist after the refused removal',
  );
  const survivingPolicy = snapshot.actionPolicies.find(
    (policy) => policy.environmentId === survivingCredential.environmentId,
  );
  assert.ok(survivingPolicy, 'the real Environment\'s ActionPolicy must still exist after the refused removal');

  const { rows: eventsAfter } = await pool.query('select count(*)::int as n from aic_app.registry_events');
  assert.equal(
    eventsAfter[0].n,
    eventsBefore[0].n,
    'a refused removeEnvironment must append no registry_events row for the environmentName that named nothing',
  );
});

/* -------------------------------------------------------------------------- */
/* removeService refuses an unresolved serviceName, and changes nothing       */
/* -------------------------------------------------------------------------- */

test('removeService refuses a serviceName that names no Service, and leaves the real Service and registry_events untouched', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'billing', repositoryAliases: [] });

  const { rows: eventsBefore } = await pool.query('select count(*)::int as n from aic_app.registry_events');

  await assert.rejects(
    () => store.removeService({ serviceName: 'billing-typo' }),
    (error) => {
      assert.equal(
        error.name,
        'RegistryValidationError',
        '"billing-typo" names no Service: removeService must refuse rather than resolving it to a fresh id that matches no row and then reporting success for a removal that removed nothing',
      );
      return true;
    },
    'removeService given a misspelled serviceName must reject rather than resolve to fulfilled',
  );

  const snapshot = await store.snapshot();
  assert.ok(
    snapshot.services.some((service) => service.name === 'billing'),
    'the real Service must still exist after the refused removal',
  );

  const { rows: eventsAfter } = await pool.query('select count(*)::int as n from aic_app.registry_events');
  assert.equal(
    eventsAfter[0].n,
    eventsBefore[0].n,
    'a refused removeService must append no registry_events row for the serviceName that named nothing',
  );
});

/* -------------------------------------------------------------------------- */
/* snapshot() is a consistent read across its five underlying SELECTs         */
/* -------------------------------------------------------------------------- */

/**
 * This row must keep discriminating a consistent read from an inconsistent
 * one NO MATTER which connection surface `snapshot()`'s five reads end up
 * using: one valid implementation runs them as five bare `pool.query(...)`
 * calls; an equally valid one opens one dedicated client (`pool.connect()`)
 * and wraps them in their own `BEGIN … COMMIT`. If this row interposed only
 * `pool.query`, that second shape would move every read behind a
 * `client.query` this row never
 * sees, the interposed removeEnvironment below would never fire, and the row
 * would pass whether or not the read is actually consistent — green for the
 * wrong reason, indistinguishable from a real fix. So BOTH surfaces on the
 * SAME `pool` object the store under test holds are wrapped: `pool.query`
 * directly, and `pool.connect()` so that whatever `PoolClient` it hands back
 * also has its own `.query` wrapped before the caller ever sees it. Either
 * shape is caught by the shared `afterSelect` counter below, keyed on which
 * registry table a SELECT names rather than on a raw call count, so it does
 * not care how many other statements (a lock acquisition, a `BEGIN`) an
 * implementation interleaves.
 *
 * The removeEnvironment that must land mid-read runs on a SEPARATE `Pool`
 * (`writerPool` / `writerStore`) this wrapper never touches — calling it
 * through the store under test would recurse into the very wrapper we are
 * using to observe it, since that store's own internal mutation also opens a
 * client via `pool.connect()`.
 *
 * Finally, two assertions below exist only to keep this row honest: if
 * `snapshot()`'s reads ever stopped naming a registry table in a SELECT this
 * matcher recognises (or moved off `pool` entirely), the race would silently
 * stop firing and the row would again pass vacuously. `sawSourceBindingsSelect`
 * and `removalCommitted` fail loudly instead of letting that happen quietly.
 */
test('snapshot() never returns a SourceBinding whose credentialRefId survives from before a removeEnvironment that fully commits partway through the read', async (t) => {
  const connectionString = requireConnectionString();
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
  await store.addSourceBinding({
    serviceName: 'billing',
    environmentName: 'production',
    name: 'github-source',
    adapterId: 'github',
    adapterVersion: '1',
    config: {},
    credentialRefName: 'billing-read',
  });

  // A pool the wrapping below never touches: the interposed removeEnvironment
  // races the read on a connection of its own, exactly as an unrelated
  // concurrent caller would.
  const writerPool = new Pool({ connectionString });
  const writerStore = persistence.createRegistryStore(writerPool);
  t.after(() => writerPool.end());

  const REGISTRY_TABLES = ['source_bindings', 'credential_refs', 'action_policies', 'environments', 'services'];
  function selectedRegistryTable(sql) {
    if (typeof sql !== 'string' || !/^\s*select/i.test(sql)) return null;
    return REGISTRY_TABLES.find((table) => new RegExp(`\\b${table}\\b`, 'i').test(sql)) ?? null;
  }

  function withTimeout(promise, ms, message) {
    let timer;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
  }

  let sawSourceBindingsSelect = false;
  let removalCommitted = false;
  let triggered = false;

  async function afterSelect(sql) {
    if (triggered || selectedRegistryTable(sql) !== 'source_bindings') return;
    triggered = true;
    sawSourceBindingsSelect = true;
    await withTimeout(
      writerStore.removeEnvironment({ serviceName: 'billing', environmentName: 'production' }),
      5000,
      'the interposed removeEnvironment did not commit within 5s of the source_bindings SELECT: this row cannot prove anything about snapshot() consistency without that commit actually landing mid-read',
    );
    removalCommitted = true;
  }

  // A client `pool.connect()` hands out is a plain pg `Client`, whose own
  // `.query` supports both call shapes pg itself uses: promise style
  // (`client.query(text, values)`, what a dedicated-client snapshot()
  // implementation would use) and callback style (`client.query(text, values,
  // cb)`, what `pg`'s OWN `Pool.prototype.query` uses internally on the client
  // it checks out — see node_modules/pg's `lib/pool.js`). Both must be
  // wrapped, or the callback-style path used internally by plain
  // `pool.query()` calls would fire `afterSelect` before the real query even
  // starts (awaiting a callback-style call's `undefined` return resolves
  // immediately), which would trigger the interposed removal too early and
  // break every timing guarantee this row depends on. `__snapshotRaceWrapped`
  // guards against re-wrapping the same client twice: `pg.Pool` reuses a
  // checked-in client for a later `connect()`/`query()` call, and wrapping an
  // already-wrapped `.query` a second time would fire `afterSelect` twice.
  function wrapClientQuery(client) {
    if (!client || client.__snapshotRaceWrapped) return;
    client.__snapshotRaceWrapped = true;
    const originalClientQuery = client.query.bind(client);
    client.query = (...queryArgs) => {
      const maybeCallback = queryArgs[queryArgs.length - 1];
      if (typeof maybeCallback === 'function') {
        return originalClientQuery(...queryArgs.slice(0, -1), (err, res, ...rest) => {
          if (err) return maybeCallback(err, res, ...rest);
          afterSelect(queryArgs[0])
            .then(() => maybeCallback(err, res, ...rest))
            .catch((hookError) => maybeCallback(hookError));
        });
      }
      return (async () => {
        const result = await originalClientQuery(...queryArgs);
        await afterSelect(queryArgs[0]);
        return result;
      })();
    };
  }

  const originalPoolQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    const result = await originalPoolQuery(...args);
    await afterSelect(args[0]);
    return result;
  };

  // `pool.connect()` is itself dual-shaped: promise style when called with no
  // callback (what this file's own setup and `mutate()` use), and callback
  // style when `pg`'s own `Pool.prototype.query` calls `this.connect(cb)`
  // internally to service the plain, argument-only `pool.query(text, values)`
  // form wrapped above. Both branches route the client they hand back through
  // the same `wrapClientQuery`.
  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args) => {
    const maybeCallback = args[args.length - 1];
    if (typeof maybeCallback === 'function') {
      return originalConnect(...args.slice(0, -1), (err, client, release) => {
        wrapClientQuery(client);
        maybeCallback(err, client, release);
      });
    }
    return (async () => {
      const client = await originalConnect(...args);
      wrapClientQuery(client);
      return client;
    })();
  };

  t.after(() => {
    pool.query = originalPoolQuery;
    pool.connect = originalConnect;
  });

  const snapshot = await store.snapshot();

  assert.equal(
    sawSourceBindingsSelect,
    true,
    'this row never observed a SELECT against source_bindings on either connection surface of the pool under test, so it never exercised the race it exists to prove: snapshot() must be reading source_bindings through `pool` (directly or via `pool.connect()`), not through some other connection this wrapper cannot see',
  );
  assert.equal(
    removalCommitted,
    true,
    'the interposed removeEnvironment must have fully committed mid-read for this row to prove anything about snapshot() consistency',
  );
  assert.doesNotThrow(
    () => domain.RegistrySnapshotSchema.parse(snapshot),
    'snapshot() must read the registry as of one instant: a removeEnvironment that fully committed right after the source_bindings read must not surface, later in the SAME read, as a SourceBinding.credentialRefId naming a CredentialRef the credential_refs read no longer carries — which RegistrySnapshotSchema refuses as "SourceBinding.credentialRefId does not name a known CredentialRef" — proof that this read spanned two different, inconsistent states of the registry',
  );
});

/* -------------------------------------------------------------------------- */
/* removeService on a Service with no Environment deletes it and records the  */
/* removal                                                                    */
/* -------------------------------------------------------------------------- */

test('removeService deletes a Service that has no Environment, and records the removal in registry_events', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  const service = await store.addService({ name: 'reporting', repositoryAliases: [] });

  await store.removeService({ serviceName: 'reporting' });

  const snapshot = await store.snapshot();
  assert.equal(
    snapshot.services.some((candidate) => candidate.id === service.id),
    false,
    'removeService must delete the Service row once it has no Environment left to protect',
  );

  const { rows: eventRows } = await pool.query(
    `select kind from aic_app.registry_events where subject_id = $1 order by seq`,
    [service.id],
  );
  assert.ok(
    eventRows.some((row) => /remov/i.test(row.kind)),
    'registry_events must record removeService\'s removal, with the removed Service as subject_id',
  );
});

/* -------------------------------------------------------------------------- */
/* setActionPolicy called twice for one Environment leaves exactly one row,   */
/* carrying the second call's content                                        */
/* -------------------------------------------------------------------------- */

test('setActionPolicy called twice for the same Environment leaves exactly one action_policies row, carrying the second call\'s content', async (t) => {
  const { store, pool } = await freshRegistryStore(t);
  await store.addService({ name: 'billing', repositoryAliases: [] });
  await store.addEnvironment({ serviceName: 'billing', name: 'production' });
  await store.addCredentialRef({
    serviceName: 'billing',
    environmentName: 'production',
    name: 'billing-write',
    access: 'write',
    secretName: secretName('BILLING', 'WRITE', 'TOKEN'),
  });

  await store.setActionPolicy({
    serviceName: 'billing',
    environmentName: 'production',
    allowedActionTypes: ['restart-pod'],
    writeCredentialRefNames: [],
  });
  const secondPolicy = await store.setActionPolicy({
    serviceName: 'billing',
    environmentName: 'production',
    allowedActionTypes: ['rotate-credential'],
    writeCredentialRefNames: ['billing-write'],
  });

  const { rows } = await pool.query(
    `select id, allowed_action_types, write_credential_ref_ids from aic_app.action_policies where environment_id = $1`,
    [secondPolicy.environmentId],
  );
  assert.equal(
    rows.length,
    1,
    'two setActionPolicy calls for the same Environment must leave exactly one action_policies row, never two',
  );
  assert.equal(
    rows[0].id,
    secondPolicy.id,
    'the surviving row must be the second call\'s own row',
  );
  assert.deepEqual(
    rows[0].allowed_action_types,
    ['rotate-credential'],
    'the surviving row must carry the second call\'s allowed_action_types, not the first call\'s',
  );
  assert.deepEqual(
    rows[0].write_credential_ref_ids,
    [secondPolicy.writeCredentialRefIds[0]],
    'the surviving row must carry the second call\'s write_credential_ref_ids, not the first call\'s (empty)',
  );
});

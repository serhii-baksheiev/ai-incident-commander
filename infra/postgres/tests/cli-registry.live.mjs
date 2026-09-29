/**
 * AIC-99 slice d — the half that needs a real database: `aic db migrate`
 * actually reaching `APP_SCHEMA_VERSION` from an empty (schema-less)
 * database through the BUILT CLI, the full onboarding pipeline (`service
 * add` → `env add` → `credential add` → `source add` → `policy set`)
 * landing exactly the rows `createRegistryStore(pool).snapshot()` reports,
 * `service remove` cascading through its Environment's own SourceBinding,
 * CredentialRef and ActionPolicy, and a registry command refusing — naming
 * `aic db migrate` — when `AIC_POSTGRES_URL` is set but the `aic_app` schema
 * is not at `APP_SCHEMA_VERSION`.
 *
 * `test/cli-registry-commands.test.mjs` pins `runRegistryCommand(noun, argv,
 * deps)`'s own argv-parsing and store-call contract against a FAKE store,
 * with no database — including the `AIC_POSTGRES_URL`-absent refusal, which
 * needs no live PostgreSQL either. This file is the other half: the same
 * commands, spawned as the real `apps/cli/dist/index.js` process, over a
 * real `createRegistryStore(pool)`. Not repeated here in full — see that
 * file's own header for the full design-choice list (stdout shapes, error
 * propagation, `--config` credential-shape refusal).
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/registry-store.live.mjs` — see that file's header
 * for "why this file is not under `test/`", "it refuses; it never skips",
 * "independent verification" and "a note on the fixture values below" (a
 * CredentialRef's `secretName` is itself an UPPERCASE_WITH_UNDERSCORES
 * identifier, assembled from parts at runtime rather than written as a
 * literal). Not repeated here.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## Isolation between rows
 *
 * Every row that needs a known-empty `aic_app` starts by dropping the whole
 * schema (`DROP SCHEMA IF EXISTS "aic_app" CASCADE`) rather than truncating
 * its tables — the schema-not-migrated row needs the schema itself absent,
 * not merely empty, and every other row needs `aic db migrate` to have
 * actually done the provisioning it is under test for. A row that drops the
 * schema and does not itself re-migrate restores it in `t.after`
 * (`persistence.setupApplicationSchema`), so a later row — in this file or a
 * sibling `*.live.mjs` run in the same `npm run test:live-postgres` — never
 * finds the schema missing on account of this file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import * as persistence from '@aic/persistence';
import { childEnv } from '../../../test/fixtures/child-env.mjs';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place aic db migrate,
the registry onboarding pipeline and the schema-not-migrated refusal are
measured against a real, spawned CLI process and a real PostgreSQL, so a skip
would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

/** See registry-store.live.mjs's header, "A note on the fixture values below". */
const secretName = (...parts) => parts.join('_');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

/**
 * The minimal env a spawned `aic` process needs for this file's rows: `PATH`
 * (to find node's own runtime dependencies) and `AIC_POSTGRES_URL`. Unlike
 * `test/fixtures/child-env.mjs`'s own allow-list (built for the no-network,
 * no-tracing suite under `npm test`), this file's spawn always needs a real
 * outbound PostgreSQL connection, so it is not reused here — but it still
 * never inherits the parent's ambient environment wholesale, for the same
 * "an override replaces rather than merges" reasoning that fixture's own
 * header gives.
 */
function runCli(args, connectionString) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: childEnv(connectionString === undefined ? {} : { [CONNECTION_VARIABLE]: connectionString }),
  });
}

function commandDiagnostics(args, result) {
  return `aic ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

async function dropApplicationSchema(pool) {
  await pool.query('DROP SCHEMA IF EXISTS "aic_app" CASCADE');
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
/* aic db migrate, from nothing, then the full onboarding pipeline            */
/* -------------------------------------------------------------------------- */

test('aic db migrate reaches APP_SCHEMA_VERSION from an empty (schema-less) database, and the pipeline service add / env add / credential add / source add / policy set lands exactly the rows createRegistryStore(pool).snapshot() reports', async (t) => {
  const connectionString = requireConnectionString();
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());

  await dropApplicationSchema(pool);

  const migrateArgs = ['db', 'migrate'];
  const migrateResult = runCli(migrateArgs, connectionString);
  assert.equal(migrateResult.status, 0, commandDiagnostics(migrateArgs, migrateResult));
  assert.deepEqual(
    JSON.parse(migrateResult.stdout),
    { migrated: { schemaVersion: persistence.APP_SCHEMA_VERSION } },
    commandDiagnostics(migrateArgs, migrateResult),
  );

  const { rows: migrationRows } = await pool.query(
    'select max(version) as v from "aic_app".schema_migrations',
  );
  assert.equal(
    Number(migrationRows[0]?.v),
    persistence.APP_SCHEMA_VERSION,
    'aic db migrate must actually reach APP_SCHEMA_VERSION on this database, not only report success',
  );

  const addServiceArgs = ['service', 'add', 'checkout', '--repository-alias', 'org/checkout'];
  const addServiceResult = runCli(addServiceArgs, connectionString);
  assert.equal(addServiceResult.status, 0, commandDiagnostics(addServiceArgs, addServiceResult));
  const addedService = JSON.parse(addServiceResult.stdout);
  assert.equal(addedService.name, 'checkout');

  const addEnvArgs = ['env', 'add', 'checkout', 'staging'];
  const addEnvResult = runCli(addEnvArgs, connectionString);
  assert.equal(addEnvResult.status, 0, commandDiagnostics(addEnvArgs, addEnvResult));
  const addedEnvironment = JSON.parse(addEnvResult.stdout);
  assert.equal(addedEnvironment.name, 'staging');
  assert.equal(addedEnvironment.serviceId, addedService.id);

  const addCredentialArgs = [
    'credential',
    'add',
    'checkout',
    'staging',
    'github-read',
    '--secret',
    secretName('GITHUB', 'READ', 'TOKEN'),
  ];
  const addCredentialResult = runCli(addCredentialArgs, connectionString);
  assert.equal(addCredentialResult.status, 0, commandDiagnostics(addCredentialArgs, addCredentialResult));
  const addedCredential = JSON.parse(addCredentialResult.stdout);
  assert.equal(addedCredential.access, 'read');
  assert.equal(addedCredential.environmentId, addedEnvironment.id);

  const addSourceArgs = [
    'source',
    'add',
    'checkout',
    'staging',
    'github-source',
    '--adapter',
    'github@1',
    '--config',
    'owner=my-org',
    '--config',
    'repo=checkout',
    '--credential',
    'github-read',
  ];
  const addSourceResult = runCli(addSourceArgs, connectionString);
  assert.equal(addSourceResult.status, 0, commandDiagnostics(addSourceArgs, addSourceResult));
  const addedSource = JSON.parse(addSourceResult.stdout);
  assert.equal(addedSource.adapterId, 'github');
  assert.equal(addedSource.adapterVersion, '1');
  assert.deepEqual(addedSource.config, { owner: 'my-org', repo: 'checkout' });
  assert.equal(addedSource.credentialRefId, addedCredential.id);

  const setPolicyArgs = ['policy', 'set', 'checkout', 'staging', '--allow', 'restart-pod'];
  const setPolicyResult = runCli(setPolicyArgs, connectionString);
  assert.equal(setPolicyResult.status, 0, commandDiagnostics(setPolicyArgs, setPolicyResult));
  const setPolicy = JSON.parse(setPolicyResult.stdout);
  assert.equal(setPolicy.environmentId, addedEnvironment.id);

  // Independent verification: read the registry back through
  // createRegistryStore(pool).snapshot() — never through the CLI's own
  // stdout again — the same "the store's own methods are what is under
  // test" separation registry-store.live.mjs's header names.
  const store = persistence.createRegistryStore(pool);
  const snapshot = await store.snapshot();

  const service = snapshot.services.find((candidate) => candidate.id === addedService.id);
  assert.ok(service, 'the registry must carry the Service the CLI just added');
  assert.equal(service.name, 'checkout');
  assert.deepEqual(service.repositoryAliases, ['org/checkout']);

  const environment = snapshot.environments.find((candidate) => candidate.id === addedEnvironment.id);
  assert.ok(environment, 'the registry must carry the Environment the CLI just added');
  assert.equal(environment.serviceId, service.id);

  const credential = snapshot.credentialRefs.find((candidate) => candidate.id === addedCredential.id);
  assert.ok(credential, 'the registry must carry the CredentialRef the CLI just added');
  assert.equal(credential.environmentId, environment.id);
  assert.equal(credential.access, 'read');
  assert.equal(credential.secretName, secretName('GITHUB', 'READ', 'TOKEN'));

  const binding = snapshot.sourceBindings.find((candidate) => candidate.id === addedSource.id);
  assert.ok(binding, 'the registry must carry the SourceBinding the CLI just added');
  assert.equal(binding.environmentId, environment.id);
  assert.equal(binding.adapterId, 'github');
  assert.equal(binding.adapterVersion, '1');
  assert.deepEqual(binding.config, { owner: 'my-org', repo: 'checkout' });
  assert.equal(binding.credentialRefId, credential.id);

  const policy = snapshot.actionPolicies.find((candidate) => candidate.id === setPolicy.id);
  assert.ok(policy, 'the registry must carry the ActionPolicy the CLI just set');
  assert.equal(policy.environmentId, environment.id);
  assert.deepEqual(policy.allowedActionTypes, ['restart-pod']);
});

/* -------------------------------------------------------------------------- */
/* aic service remove cascades through its Environment's own dependents       */
/* -------------------------------------------------------------------------- */

test('aic service remove cascades: the Environment, its SourceBinding, CredentialRef and ActionPolicy are all gone from createRegistryStore(pool).snapshot() afterward', async (t) => {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query(
    `truncate table aic_app.registry_events, aic_app.incidents, aic_app.action_policies,
       aic_app.source_bindings, aic_app.credential_refs, aic_app.environments, aic_app.services
     restart identity cascade`,
  );

  // Seeded directly through the store (never through the CLI): this row's
  // own focus is `aic service remove`'s cascade, not re-proving the add
  // pipeline the row above already covers.
  const store = persistence.createRegistryStore(pool);
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
    name: 'billing-source',
    adapterId: 'lab',
    adapterVersion: '1',
    config: {},
    credentialRefName: null,
  });
  await store.setActionPolicy({
    serviceName: 'billing',
    environmentName: 'production',
    allowedActionTypes: ['restart-pod'],
    writeCredentialRefNames: [],
  });

  const removeArgs = ['service', 'remove', 'billing'];
  const removeResult = runCli(removeArgs, connectionString);
  assert.equal(removeResult.status, 0, commandDiagnostics(removeArgs, removeResult));
  assert.deepEqual(JSON.parse(removeResult.stdout), { removed: { service: 'billing' } }, commandDiagnostics(removeArgs, removeResult));

  const snapshot = await store.snapshot();
  assert.equal(snapshot.services.some((candidate) => candidate.name === 'billing'), false, 'the removed Service must be gone');
  assert.equal(snapshot.environments.length, 0, 'the cascaded Environment must be gone');
  assert.equal(snapshot.sourceBindings.length, 0, "the cascaded Environment's SourceBinding must be gone");
  assert.equal(snapshot.credentialRefs.length, 0, "the cascaded Environment's CredentialRef must be gone");
  assert.equal(snapshot.actionPolicies.length, 0, "the cascaded Environment's ActionPolicy must be gone");
});

/* -------------------------------------------------------------------------- */
/* AIC_POSTGRES_URL present, but the schema is not at APP_SCHEMA_VERSION      */
/* -------------------------------------------------------------------------- */

test('a registry command with AIC_POSTGRES_URL set but no aic_app schema at all exits non-zero, writes nothing to stdout, and tells the operator to run aic db migrate', async (t) => {
  const connectionString = requireConnectionString();
  const pool = new Pool({ connectionString });
  t.after(async () => {
    // Restores the schema so a later row in this file, or a sibling
    // `*.live.mjs` run in the same `npm run test:live-postgres` invocation,
    // never finds it missing on account of this row.
    await persistence.setupApplicationSchema(connectionString);
    await pool.end();
  });

  await dropApplicationSchema(pool);

  const args = ['service', 'add', 'checkout'];
  const result = runCli(args, connectionString);

  assert.notEqual(result.status, 0, commandDiagnostics(args, result));
  assert.equal(result.stdout, '', commandDiagnostics(args, result));
  assert.match(result.stderr, /aic db migrate/i, commandDiagnostics(args, result));
});

/* -------------------------------------------------------------------------- */
/* AIC_POSTGRES_URL absent: refused by name before any database is reached. */
/* -------------------------------------------------------------------------- */

test('aic service add with no AIC_POSTGRES_URL in the environment exits non-zero, writes nothing to stdout, and names AIC_POSTGRES_URL on stderr', () => {
  const env = childEnv();
  assert.ok(
    !('AIC_POSTGRES_URL' in env),
    'fixture sanity: childEnv() with no overrides must carry no AIC_POSTGRES_URL',
  );

  const args = ['service', 'add', 'checkout'];
  const result = runCli(args, undefined);

  assert.notEqual(result.status, 0, commandDiagnostics(args, result));
  assert.equal(result.stdout, '', commandDiagnostics(args, result));
  assert.match(result.stderr, /AIC_POSTGRES_URL/, commandDiagnostics(args, result));
});

test('aic db migrate with no AIC_POSTGRES_URL in the environment exits non-zero, writes nothing to stdout, and names AIC_POSTGRES_URL on stderr', () => {
  const args = ['db', 'migrate'];
  const result = runCli(args, undefined);

  assert.notEqual(result.status, 0, commandDiagnostics(args, result));
  assert.equal(result.stdout, '', commandDiagnostics(args, result));
  assert.match(result.stderr, /AIC_POSTGRES_URL/, commandDiagnostics(args, result));
});

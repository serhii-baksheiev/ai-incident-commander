/**
 * AIC-99 slice g — the half that needs a real database: `aic apply -f <file>`
 * through the BUILT CLI over a real `createRegistryStore(pool)`. Two things a
 * fake store cannot show: that applying the same manifest twice against an
 * actually-migrated schema reports every entity `unchanged` the second time,
 * and that editing the manifest's policy and re-applying reports `drift`,
 * then `updated` with `--overwrite`, each reflected in
 * `createRegistryStore(pool).snapshot()` afterward.
 *
 * `test/cli-apply.test.mjs` pins `runApplyCommand(argv, deps)`'s own
 * manifest-parsing, drift-detection and store-call contract against a FAKE
 * store, with no database — see that file's header for the full pinned
 * JSON-line shape, field-name vocabulary and `--overwrite` limits, not
 * repeated here. This file is the other half: the same command, spawned as
 * the real `apps/cli/dist/index.js` process, over a real
 * `createRegistryStore(pool)`.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/cli-registry.live.mjs` — see that file's header for
 * "why this file is not under `test/`", "it refuses; it never skips", and "a
 * note on the fixture values below" (a CredentialRef's `secretName` is itself
 * an UPPERCASE_WITH_UNDERSCORES identifier, assembled from parts at runtime
 * rather than written as a literal). Not repeated here.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import * as persistence from '@aic/persistence';
import { childEnv } from '../../../test/fixtures/child-env.mjs';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place aic apply is
measured against a real, spawned CLI process and a real PostgreSQL, so a skip
would report it as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

/** See registry-store.live.mjs's header, "A note on the fixture values below". */
const secretName = (...parts) => parts.join('_');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

const CLI_TIMEOUT_MS = 30_000;

function runCli(args, connectionString) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: childEnv(connectionString === undefined ? {} : { [CONNECTION_VARIABLE]: connectionString }),
  });
}

function commandDiagnostics(args, result) {
  return `aic ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function parseLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function dropApplicationSchema(pool) {
  await pool.query('DROP SCHEMA IF EXISTS "aic_app" CASCADE');
}

/**
 * A manifest with exactly one Service/Environment/CredentialRef/SourceBinding
 * /ActionPolicy — `policyAllow` is the one field the rows below vary, to
 * drive the drift/updated row without touching anything else.
 */
function manifestYaml({ policyAllow = ['restart-pod'] } = {}) {
  const allowYaml = policyAllow.map((entry) => `            - ${entry}`).join('\n');
  return `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
        credentials:
          - name: github-read
            secret: ${secretName('GITHUB', 'READ', 'TOKEN')}
            access: read
        sources:
          - name: github-source
            adapter: github@1
            config:
              owner: my-org
              repo: checkout
            credential: github-read
        policy:
          allow:
${allowYaml}
          writeCredentials: []
`;
}

function withManifestFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-cli-apply-live-'));
  const filePath = join(dir, 'manifest.yaml');
  writeFileSync(filePath, content, 'utf8');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
/* apply twice: the second run is all unchanged                              */
/* -------------------------------------------------------------------------- */

test('aic apply against a freshly migrated schema creates every entity, and re-applying the identical manifest reports every entity unchanged', async (t) => {
  const connectionString = requireConnectionString();
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());

  await dropApplicationSchema(pool);
  const migrateResult = runCli(['db', 'migrate'], connectionString);
  assert.equal(migrateResult.status, 0, commandDiagnostics(['db', 'migrate'], migrateResult));

  withManifestFile(manifestYaml(), (filePath) => {
    const firstArgs = ['apply', '-f', filePath];
    const firstResult = runCli(firstArgs, connectionString);
    assert.equal(firstResult.status, 0, commandDiagnostics(firstArgs, firstResult));
    const firstLines = parseLines(firstResult.stdout);
    assert.deepEqual(
      firstLines.map((line) => line.action),
      ['created', 'created', 'created', 'created', 'created'],
      commandDiagnostics(firstArgs, firstResult),
    );

    const secondArgs = ['apply', '-f', filePath];
    const secondResult = runCli(secondArgs, connectionString);
    assert.equal(secondResult.status, 0, commandDiagnostics(secondArgs, secondResult));
    const secondLines = parseLines(secondResult.stdout);
    assert.deepEqual(
      secondLines.map((line) => line.action),
      ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged'],
      commandDiagnostics(secondArgs, secondResult),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* editing the manifest's policy: drift, then --overwrite -> updated         */
/* -------------------------------------------------------------------------- */

test('editing the manifest\'s policy allow list and re-applying reports drift without --overwrite, and updated with --overwrite, reflected in createRegistryStore(pool).snapshot() afterward', async (t) => {
  const connectionString = requireConnectionString();
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());

  await dropApplicationSchema(pool);
  const migrateResult = runCli(['db', 'migrate'], connectionString);
  assert.equal(migrateResult.status, 0, commandDiagnostics(['db', 'migrate'], migrateResult));

  await withManifestFile(manifestYaml(), async (filePath) => {
    const createArgs = ['apply', '-f', filePath];
    const createResult = runCli(createArgs, connectionString);
    assert.equal(createResult.status, 0, commandDiagnostics(createArgs, createResult));

    const editedManifest = manifestYaml({ policyAllow: ['restart-pod', 'scale-up'] });
    writeFileSync(filePath, editedManifest, 'utf8');

    const driftArgs = ['apply', '-f', filePath];
    const driftResult = runCli(driftArgs, connectionString);
    assert.notEqual(driftResult.status, 0, commandDiagnostics(driftArgs, driftResult));
    const driftLines = parseLines(driftResult.stdout);
    const driftPolicyLine = driftLines.find((line) => line.entity === 'policy');
    assert.deepEqual(
      driftPolicyLine,
      {
        action: 'drift',
        entity: 'policy',
        service: 'checkout',
        environment: 'staging',
        name: null,
        fields: ['allow'],
      },
      commandDiagnostics(driftArgs, driftResult),
    );

    const overwriteArgs = ['apply', '-f', filePath, '--overwrite'];
    const overwriteResult = runCli(overwriteArgs, connectionString);
    assert.equal(overwriteResult.status, 0, commandDiagnostics(overwriteArgs, overwriteResult));
    const overwriteLines = parseLines(overwriteResult.stdout);
    const updatedPolicyLine = overwriteLines.find((line) => line.entity === 'policy');
    assert.deepEqual(
      updatedPolicyLine,
      {
        action: 'updated',
        entity: 'policy',
        service: 'checkout',
        environment: 'staging',
        name: null,
        fields: ['allow'],
      },
      commandDiagnostics(overwriteArgs, overwriteResult),
    );

    // Independent verification: read the registry back through
    // createRegistryStore(pool).snapshot() — never through the CLI's own
    // stdout again — the same separation registry-store.live.mjs's header
    // names.
    const store = persistence.createRegistryStore(pool);
    const snapshot = await store.snapshot();
    const service = snapshot.services.find((candidate) => candidate.name === 'checkout');
    const environment = snapshot.environments.find(
      (candidate) => candidate.serviceId === service.id && candidate.name === 'staging',
    );
    const policy = snapshot.actionPolicies.find((candidate) => candidate.environmentId === environment.id);
    assert.deepEqual(policy.allowedActionTypes, ['restart-pod', 'scale-up']);
  });
});

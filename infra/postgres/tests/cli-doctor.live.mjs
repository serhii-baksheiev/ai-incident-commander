/**
 * AIC-99 slice e, end to end: `aic doctor` and `aic source check` through the
 * built CLI against a real PostgreSQL registry. The unit rows
 * (test/cli-doctor.test.mjs, test/cli-source-check.test.mjs) pin the
 * classification against a fake store and a fake fetch; this file shows the
 * same words come out of the real process, the real registry and the real
 * directory secret resolver: a lab@1 source whose base URL nothing listens on
 * is `unreachable`, and a github@1 source whose secret file is missing is
 * `absent` — two different words for two different operator problems.
 *
 * No network leaves the machine: the lab source points at a loopback port
 * nothing listens on, and the github source is refused before any request
 * because its secret file does not exist.
 *
 * Runs under `npm run test:live-postgres` only, like its sibling
 * `cli-registry.live.mjs`, whose header explains why this lane lives outside
 * `test/`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { childEnv } from '../../../test/fixtures/child-env.mjs';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');
const CLI_TIMEOUT_MS = 30_000;

/** A secret NAME, assembled from parts (the guard-secret-file convention). */
const secretName = (...parts) => parts.join('_');

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, `set ${CONNECTION_VARIABLE} (see cli-registry.live.mjs)`);
  return value;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: childEnv(env),
  });
}

function diagnostics(args, result) {
  return `aic ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function jsonLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test('aic doctor and aic source check tell an unreachable source from a missing secret, through the real registry and the directory secret resolver', async (t) => {
  const connectionString = requireConnectionString();
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA IF EXISTS "aic_app" CASCADE');

  const secretsDir = mkdtempSync(join(tmpdir(), 'aic-doctor-live-'));
  t.after(() => rmSync(secretsDir, { recursive: true, force: true }));

  const env = { [CONNECTION_VARIABLE]: connectionString, AIC_SECRETS_DIR: secretsDir };
  const setup = [
    ['db', 'migrate'],
    ['service', 'add', 'probe'],
    ['env', 'add', 'probe', 'prod'],
    ['source', 'add', 'probe', 'prod', 'lab-src', '--adapter', 'lab@1', '--config', 'baseUrl=http://127.0.0.1:1'],
    ['credential', 'add', 'probe', 'prod', 'gh', '--secret', secretName('GITHUB', 'READ', 'TOKEN')],
    ['source', 'add', 'probe', 'prod', 'gh-src', '--adapter', 'github@1', '--config', 'owner=octo', '--config', 'repo=demo', '--credential', 'gh'],
  ];
  for (const args of setup) {
    const result = runCli(args, env);
    assert.equal(result.status, 0, diagnostics(args, result));
  }

  const doctorArgs = ['doctor', 'probe', 'prod'];
  const doctor = runCli(doctorArgs, env);
  assert.notEqual(doctor.status, 0, diagnostics(doctorArgs, doctor));
  const rows = jsonLines(doctor.stdout);
  const byBinding = Object.fromEntries(rows.filter((row) => 'binding' in row).map((row) => [row.binding, row.status]));
  assert.deepEqual(byBinding, { 'lab-src': 'unreachable', 'gh-src': 'absent' }, diagnostics(doctorArgs, doctor));
  assert.ok(
    rows.some((row) => row.environment === 'prod' && row.actionPolicy === false),
    `doctor reports that prod has no ActionPolicy: ${diagnostics(doctorArgs, doctor)}`,
  );

  const checkArgs = ['source', 'check', 'probe', 'prod', 'lab-src'];
  const check = runCli(checkArgs, env);
  assert.notEqual(check.status, 0, diagnostics(checkArgs, check));
  assert.deepEqual(
    jsonLines(check.stdout).map((row) => [row.binding, row.status]),
    [['lab-src', 'unreachable']],
    diagnostics(checkArgs, check),
  );
});

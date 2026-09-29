/**
 * AIC-99 slice h: the single-user Compose stack, end to end, against a real
 * Docker daemon. `test/single-user-compose.test.mjs` pins the static shape —
 * no ports beyond the lab's own, a Docker secret rather than an environment
 * value, exactly six services — without Docker; this file drives it: build
 * the shared CLI/migrate image, bring postgres up, run migrate against an
 * empty database, watch `aic doctor` move from an unresolved scope to naming
 * a service `service add` just created, and tear the project down again.
 *
 * ## It refuses; it never skips
 *
 * Every Docker-backed lane in this repository — `infra/postgres/tests/*.live.mjs`
 * and `incident-lab/tests/*.live.mjs` — refuses when its precondition is
 * absent rather than skipping. See
 * `infra/postgres/tests/postgres-checkpointer.live.mjs`'s header, "It
 * refuses; it never skips": a skip reports green for a lane that ran
 * nothing, and this is the only place the single-user stack is measured
 * against a real Docker daemon, so a skip here would report it as met the
 * same way a skip over an absent connection string would there. The missing
 * precondition differs — Docker instead of a connection string — but the
 * cost of silently reporting a lane that ran nothing is identical, so this
 * file follows the sibling convention rather than a bare `t.skip`.
 *
 * Runs only through `npm run test:live-single-user`; never `npm test` or
 * `npm run check` (see `test/single-user-compose.test.mjs`'s package.json
 * row).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from '../../../test/fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeFile = resolve(projectRoot, 'infra/single-user/compose.yaml');

const BUILD_TIMEOUT_MS = 300_000;
const COMPOSE_TIMEOUT_MS = 120_000;

const START_DOCKER =
  'start Docker (or the daemon this machine uses) and retry: this lane is the only place the single-user Compose stack is measured end to end, so a skip would report it as met';

function dockerAvailable() {
  const probe = spawnSync('docker', ['info'], { encoding: 'utf8', env: childEnv() });
  return probe.status === 0;
}

function requireDocker() {
  assert.equal(dockerAvailable(), true, START_DOCKER);
}

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

function runCompose(projectName, args, extraEnv, timeout = COMPOSE_TIMEOUT_MS) {
  return spawnSync(
    'docker',
    ['compose', '--file', composeFile, '--project-name', projectName, ...args],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout,
      env: childEnv(extraEnv),
    },
  );
}

function diagnostics(args, result) {
  return `docker compose ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function jsonLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without Docker available instead of skipping', () => {
  requireDocker();
});

/* -------------------------------------------------------------------------- */
/* The full stack, end to end                                                 */
/* -------------------------------------------------------------------------- */

test(
  'builds the CLI image, migrates an empty database, and aic doctor moves from an unresolved scope to naming a service just added',
  { timeout: BUILD_TIMEOUT_MS + 4 * COMPOSE_TIMEOUT_MS },
  async (t) => {
    requireDocker();

    const projectName = `aic-su-${randomBytes(4).toString('hex')}`;
    const tempRoot = mkdtempSync(join(tmpdir(), 'aic-su-live-'));
    t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

    const passwordFile = join(tempRoot, 'password');
    writeFileSync(passwordFile, randomBytes(24).toString('hex'), { mode: 0o600 });
    const secretsHostDir = join(tempRoot, 'secrets');
    mkdirSync(secretsHostDir);
    const labHostPort = await reserveFreePort();

    const stackEnv = {
      AIC_DB_PASSWORD_FILE: passwordFile,
      AIC_SECRETS_HOST_DIR: secretsHostDir,
      AIC_LAB_HOST_PORT: String(labHostPort),
    };

    t.after(() => {
      const down = runCompose(projectName, ['down', '--volumes', '--remove-orphans', '--timeout', '10'], stackEnv);
      assert.equal(down.status, 0, diagnostics(['down'], down));
    });

    const build = runCompose(projectName, ['build', 'cli'], stackEnv, BUILD_TIMEOUT_MS);
    assert.equal(build.status, 0, diagnostics(['build', 'cli'], build));

    const up = runCompose(projectName, ['up', '--detach', '--wait', 'postgres'], stackEnv);
    assert.equal(up.status, 0, diagnostics(['up', '--detach', '--wait', 'postgres'], up));

    const migrate = runCompose(projectName, ['run', '--rm', 'migrate'], stackEnv);
    assert.equal(migrate.status, 0, diagnostics(['run', '--rm', 'migrate'], migrate));

    const firstDoctor = runCompose(projectName, ['run', '--rm', 'cli', 'doctor'], stackEnv);
    assert.notEqual(firstDoctor.status, 0, diagnostics(['run', '--rm', 'cli', 'doctor'], firstDoctor));
    assert.deepEqual(
      jsonLines(firstDoctor.stdout),
      [{ service: null, environment: null, binding: null, status: 'absent' }],
      'an empty registry must report one unresolved-scope row and nothing else',
    );

    const serviceName = 'single-user-probe';
    const serviceAdd = runCompose(projectName, ['run', '--rm', 'cli', 'service', 'add', serviceName], stackEnv);
    assert.equal(serviceAdd.status, 0, diagnostics(['run', '--rm', 'cli', 'service', 'add', serviceName], serviceAdd));

    const secondDoctor = runCompose(projectName, ['run', '--rm', 'cli', 'doctor'], stackEnv);
    assert.notEqual(secondDoctor.status, 0, diagnostics(['run', '--rm', 'cli', 'doctor'], secondDoctor));
    assert.deepEqual(
      jsonLines(secondDoctor.stdout),
      [{ service: serviceName, environment: null, binding: null, status: 'absent' }],
      'doctor must now name the added service, still absent because it carries no Environment yet',
    );
  },
);

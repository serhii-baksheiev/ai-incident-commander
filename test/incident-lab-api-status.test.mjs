import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { childEnv } from './fixtures/child-env.mjs';

const READINESS_DEADLINE_MS = 30_000;

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function startApiWithUnavailableDependencies(t) {
  const port = await reserveFreePort();
  const fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'aic16-api-status-'));
  const apiPath = resolve(fixtureDirectory, 'api.mjs');
  await Promise.all([
    copyFile(resolve('incident-lab/services/api.mjs'), apiPath),
    copyFile(
      resolve('incident-lab/scenario-definitions.mjs'),
      resolve(fixtureDirectory, 'scenario-definitions.mjs'),
    ),
  ]);
  const child = spawn(process.execPath, [apiPath], {
    cwd: resolve('.'),
    env: childEnv({
      PORT: String(port),
      PAYMENTS_BASE_URL: 'http://127.0.0.1:1',
      INVENTORY_BASE_URL: 'http://127.0.0.1:1',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise((resolveClose) => child.once('close', resolveClose));
      child.kill('SIGTERM');
      await closed;
    }
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  // A wall-clock deadline, not an attempt count: a fixed 50 x 20 ms loop gave
  // the child about one second, and under concurrent suite load it needs
  // several, which made this row fail with no fault in the lab API.
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  let waitMs = 20;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      assert.fail(`lab API exited before readiness: ${stderr}`);
    }
    try {
      const response = await fetch(new URL('/control/reset', baseUrl), {
        method: 'POST',
      });
      if (response.ok) return { baseUrl };
    } catch {
      // The child has not bound its loopback socket yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    waitMs = Math.min(waitMs * 2, 250);
  }
  assert.fail(
    `lab API did not become ready within ${READINESS_DEADLINE_MS} ms: ${stderr}`,
  );
}

test('returns service unavailable when health dependencies cannot be reached', async (t) => {
  const { baseUrl } = await startApiWithUnavailableDependencies(t);

  const response = await fetch(new URL('/health', baseUrl));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable' });
});

test('returns service unavailable when an internal observation dependency fails', async (t) => {
  const { baseUrl } = await startApiWithUnavailableDependencies(t);
  const startResponse = await fetch(
    new URL('/control/scenarios/deployment-caused-incident-a/start', baseUrl),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioVersion: 1 }),
    },
  );
  assert.equal(startResponse.status, 200);

  const response = await fetch(
    new URL(
      '/observations/dependencies?service=payments&window=incident',
      baseUrl,
    ),
  );

  assert.equal(response.status, 503);
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  recordScenarioCandidate,
  resetLiveLab,
  startLiveScenario,
} from '../incident-lab/src/scenario-candidates.mjs';

async function startServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function assertRefusesRedirect(t, operation, redirectedBody) {
  const redirectedRequests = [];
  const redirectedBaseUrl = await startServer(t, (request, response) => {
    redirectedRequests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify(redirectedBody)}\n`);
  });
  const redirectingBaseUrl = await startServer(t, (request, response) => {
    response.writeHead(302, {
      location: new URL('/captured', redirectedBaseUrl).href,
    });
    response.end();
  });

  const outcome = await operation(redirectingBaseUrl).then(
    () => ({ status: 'resolved' }),
    (error) => ({ status: 'rejected', error }),
  );

  assert.deepEqual(
    {
      outcome: outcome.status,
      redirectedRequests: redirectedRequests.length,
    },
    {
      outcome: 'rejected',
      redirectedRequests: 0,
    },
    'lab requests must use redirect:error so a loopback base URL cannot cross origins',
  );
}

test('refuses a cross-origin reset redirect', async (t) => {
  await assertRefusesRedirect(
    t,
    (baseUrl) => resetLiveLab({ baseUrl }),
    { activeIncident: false },
  );
});

test('refuses a cross-origin scenario-start redirect', async (t) => {
  await assertRefusesRedirect(
    t,
    (baseUrl) => startLiveScenario({
      baseUrl,
      scenarioId: 'bad-deployment',
      scenarioVersion: 1,
    }),
    {
      activeIncident: true,
      scenarioId: 'bad-deployment',
      scenarioVersion: 1,
    },
  );
});

test('refuses a cross-origin observation redirect', async (t) => {
  const candidateDirectory = await mkdtemp(resolve(tmpdir(), 'aic16-redirect-'));
  t.after(() => rm(candidateDirectory, { recursive: true, force: true }));
  await assertRefusesRedirect(
    t,
    (baseUrl) => recordScenarioCandidate({
      baseUrl,
      scenarioId: 'bad-deployment',
      scenarioVersion: 1,
      candidateDirectory,
    }),
    [],
  );
});

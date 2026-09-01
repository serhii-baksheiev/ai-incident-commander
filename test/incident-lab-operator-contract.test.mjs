import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  regenerateV01Candidates,
} from '../incident-lab/src/scenario-candidates.mjs';
import {
  findLiveScenario,
  findScenarioObservation,
  LIVE_SCENARIOS,
} from '../incident-lab/scenario-definitions.mjs';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function startRecordingLab(t) {
  const events = [];
  let activeScenario;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && requestUrl.pathname === '/control/reset') {
      events.push('reset');
      activeScenario = undefined;
      sendJson(response, 200, { activeIncident: false });
      return;
    }

    const startMatch = requestUrl.pathname.match(
      /^\/control\/scenarios\/([^/]+)\/start$/,
    );
    if (request.method === 'POST' && startMatch) {
      activeScenario = findLiveScenario(decodeURIComponent(startMatch[1]));
      assert.ok(activeScenario);
      events.push(`start:${activeScenario.id}`);
      sendJson(response, 200, {
        activeIncident: true,
        scenarioId: activeScenario.id,
        scenarioVersion: activeScenario.version,
      });
      return;
    }

    const observationMatch = requestUrl.pathname.match(/^\/observations\/([^/]+)$/);
    if (request.method === 'GET' && observationMatch) {
      assert.ok(activeScenario, 'an observation must never happen before scenario start');
      const toolId = decodeURIComponent(observationMatch[1]);
      const input = Object.fromEntries(requestUrl.searchParams.entries());
      const observation = findScenarioObservation(activeScenario, toolId, input);
      assert.ok(observation);
      events.push(
        `observe:${activeScenario.id}:${toolId}:${JSON.stringify(input)}`,
      );
      sendJson(response, 200, observation.output);
      return;
    }

    sendJson(response, 404, { error: 'unexpected fake-lab request' });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(
    () => new Promise((resolveClose) => server.close(resolveClose)),
  );
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    events,
  };
}

test('resets before every scenario in the five-scenario regeneration sequence', async (t) => {
  const candidateDirectory = await mkdtemp(
    resolve(tmpdir(), 'aic16-reset-sequence-'),
  );
  t.after(() => rm(candidateDirectory, { recursive: true, force: true }));
  const lab = await startRecordingLab(t);

  await regenerateV01Candidates({
    baseUrl: lab.baseUrl,
    candidateDirectory,
  });

  const expected = [];
  for (const scenario of LIVE_SCENARIOS) {
    expected.push('reset', `start:${scenario.id}`);
    for (const { toolId, input } of scenario.observations) {
      expected.push(
        `observe:${scenario.id}:${toolId}:${JSON.stringify(input)}`,
      );
    }
  }
  expected.push('reset');
  assert.deepEqual(
    lab.events,
    expected,
    'removing any per-scenario reset must make the observed sequence fail',
  );
});

test('keeps Docker live work outside ordinary test and check lanes', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  for (const scriptName of ['test', 'check']) {
    assert.doesNotMatch(manifest.scripts[scriptName], /test:live-lab|docker/i);
  }
});

test('exposes review commands without an automatic promotion command', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(typeof manifest.scripts['live-lab:regenerate'], 'string');
  assert.equal(typeof manifest.scripts['live-lab:validate-candidates'], 'string');
  assert.deepEqual(
    Object.keys(manifest.scripts).filter((scriptName) => /promot/i.test(scriptName)),
    [],
    'candidate promotion must remain a separate human-reviewed repository change',
  );
});

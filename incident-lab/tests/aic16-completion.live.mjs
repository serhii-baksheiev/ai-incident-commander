import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { REPLAY_SCENARIOS } from '@aic/evals';
import { createReplayFixtureKey } from '@aic/tools';
import {
  ReplayToolAdapter,
  REPLAY_FIXTURE_VERSION,
} from '@aic/tools/replay';

import { childEnv } from '../../test/fixtures/child-env.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeFile = resolve(projectRoot, 'incident-lab/compose.yaml');

const V01_SCENARIO_IDS = Object.freeze([
  'bad-deployment',
  'db-pool-exhaustion',
  'false-alert',
  'deployment-caused-incident-a',
  'dependency-caused-incident-b',
]);
const acceptedScenarios = V01_SCENARIO_IDS.map((scenarioId) => {
  const scenario = REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
  assert.ok(scenario, `missing frozen v0.1 scenario: ${scenarioId}`);
  return scenario;
});

const LAB_BUDGET = Object.freeze({
  composeStartTimeoutMs: 60_000,
  commandTimeoutMs: 60_000,
  stageTimeoutMs: 15_000,
  teardownTimeoutMs: 45_000,
  runTimeoutMs: 240_000,
});

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

async function requestJson(baseUrl, pathname, init) {
  const response = await fetch(new URL(pathname, baseUrl), init);
  const body = await response.json();
  return { response, body };
}

function observationPath({ toolId, input }) {
  return `/observations/${toolId}?${new URLSearchParams(input).toString()}`;
}

async function readCandidateSet(candidateDirectory) {
  const names = (await readdir(candidateDirectory)).sort();
  const entries = await Promise.all(
    names.map(async (name) => {
      const text = await readFile(resolve(candidateDirectory, name), 'utf8');
      return [name, { text, candidate: JSON.parse(text) }];
    }),
  );
  return new Map(entries);
}

function assertCandidate(candidate, acceptedScenario) {
  assert.deepEqual(
    {
      schemaVersion: candidate.schemaVersion,
      scenarioId: candidate.scenarioId,
      scenarioVersion: candidate.scenarioVersion,
      labTopologyVersion: candidate.labTopologyVersion,
      replayFixtureVersion: candidate.replayFixture?.version,
    },
    {
      schemaVersion: 1,
      scenarioId: acceptedScenario.id,
      scenarioVersion: 1,
      labTopologyVersion: 2,
      replayFixtureVersion: REPLAY_FIXTURE_VERSION,
    },
  );
  assert.equal(candidate.recordedCalls.length, acceptedScenario.fixture.entries.length);
  assert.deepEqual(
    candidate.recordedCalls.map(({ toolId, input }) => ({ toolId, input })),
    acceptedScenario.fixture.entries.map(({ toolId, input }) => ({ toolId, input })),
  );
  for (const call of candidate.recordedCalls) {
    assert.deepEqual(
      candidate.replayFixture.responses[
        createReplayFixtureKey(call.toolId, call.input)
      ],
      call.result,
      `${candidate.scenarioId} must retain tool-call provenance in its replay fixture`,
    );
  }
}

test('declares the bounded three-service topology and publishes only the loopback API', async () => {
  const hostPort = await reserveFreePort();
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '--file', composeFile, 'config', '--format', 'json'],
    {
      cwd: projectRoot,
      env: childEnv({ AIC_LAB_HOST_PORT: String(hostPort) }),
      timeout: LAB_BUDGET.stageTimeoutMs,
    },
  );
  const config = JSON.parse(stdout);

  assert.deepEqual(Object.keys(config.services).sort(), [
    'api',
    'inventory',
    'payments',
  ]);
  assert.equal(config.services.api.ports.length, 1);
  assert.equal(config.services.api.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.services.payments.ports, undefined);
  assert.equal(config.services.inventory.ports, undefined);
});

test(
  'regenerates one byte-stable replayable candidate per frozen v0.1 scenario after isolated resets',
  { timeout: LAB_BUDGET.runTimeoutMs },
  async (t) => {
    const hostPort = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    const composeProject = `aic16-completion-${process.pid}-${randomUUID().slice(0, 8)}`;
    const candidateRoot = await mkdtemp(resolve(tmpdir(), 'aic16-completion-'));
    const firstDirectory = resolve(candidateRoot, 'first');
    const repeatedDirectory = resolve(candidateRoot, 'repeated');
    const acceptedReplaySourcePath = resolve(
      projectRoot,
      'packages/evals/src/replay-scenarios.ts',
    );
    const acceptedReplaySourceBefore = await readFile(
      acceptedReplaySourcePath,
      'utf8',
    );
    await mkdir(firstDirectory);
    await mkdir(repeatedDirectory);

    const environment = childEnv({ AIC_LAB_HOST_PORT: String(hostPort) });
    const composeArguments = [
      'compose',
      '--ansi',
      'never',
      '--file',
      composeFile,
      '--project-name',
      composeProject,
    ];

    t.after(async () => {
      let teardownError;
      try {
        await execFileAsync(
          'docker',
          [...composeArguments, 'down', '--volumes', '--remove-orphans', '--timeout', '10'],
          {
            cwd: projectRoot,
            env: environment,
            timeout: LAB_BUDGET.teardownTimeoutMs,
          },
        );
      } catch (error) {
        teardownError = error;
      } finally {
        await rm(candidateRoot, { recursive: true, force: true });
      }
      if (teardownError) {
        throw new Error(`[teardown down] ${teardownError.message}`, {
          cause: teardownError,
        });
      }
    });

    await execFileAsync('docker', [...composeArguments, 'up', '--detach', '--wait'], {
      cwd: projectRoot,
      env: environment,
      timeout: LAB_BUDGET.composeStartTimeoutMs,
    });

    const runRegeneration = (candidateDirectory) =>
      execFileAsync(
        'npm',
        [
          'run',
          'live-lab:regenerate',
          '--',
          '--base-url',
          baseUrl,
          '--candidate-directory',
          candidateDirectory,
        ],
        {
          cwd: projectRoot,
          env: environment,
          timeout: LAB_BUDGET.commandTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    const runValidation = (candidateDirectory) =>
      execFileAsync(
        'npm',
        [
          'run',
          'live-lab:validate-candidates',
          '--',
          '--candidate-directory',
          candidateDirectory,
        ],
        {
          cwd: projectRoot,
          env: environment,
          timeout: LAB_BUDGET.commandTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        },
      );

    await runRegeneration(firstDirectory);
    await runRegeneration(repeatedDirectory);

    const firstSet = await readCandidateSet(firstDirectory);
    const repeatedSet = await readCandidateSet(repeatedDirectory);
    const expectedNames = V01_SCENARIO_IDS.map(
      (scenarioId) => `${scenarioId}.v1.candidate.json`,
    ).sort();
    assert.deepEqual([...firstSet.keys()], expectedNames);
    assert.deepEqual([...repeatedSet.keys()], expectedNames);

    for (const acceptedScenario of acceptedScenarios) {
      const candidateName = `${acceptedScenario.id}.v1.candidate.json`;
      const first = firstSet.get(candidateName);
      const repeated = repeatedSet.get(candidateName);
      assert.ok(first);
      assert.ok(repeated);
      assert.equal(
        repeated.text,
        first.text,
        `${acceptedScenario.id} must be byte-stable after reset/start/record`,
      );
      assertCandidate(first.candidate, acceptedScenario);

      const replay = new ReplayToolAdapter(first.candidate.replayFixture);
      for (const call of first.candidate.recordedCalls) {
        assert.deepEqual(await replay.execute(call.toolId, call.input), call.result);
      }
    }

    const bytesBeforeOverwriteAttempt = new Map(
      [...firstSet].map(([name, { text }]) => [name, text]),
    );
    await assert.rejects(
      runRegeneration(firstDirectory),
      /already exists|refus(?:e|es|ed).*overwrite/i,
    );
    const bytesAfterOverwriteAttempt = await readCandidateSet(firstDirectory);
    assert.deepEqual(
      new Map(
        [...bytesAfterOverwriteAttempt].map(([name, { text }]) => [name, text]),
      ),
      bytesBeforeOverwriteAttempt,
    );

    await runValidation(firstDirectory);

    const falseAlertName = 'false-alert.v1.candidate.json';
    const falseAlertCandidate = structuredClone(
      firstSet.get(falseAlertName)?.candidate,
    );
    assert.ok(falseAlertCandidate);
    const changedCall = falseAlertCandidate.recordedCalls[0];
    changedCall.result = {
      status: 'unavailable',
      reason: 'controlled live metric drift',
    };
    falseAlertCandidate.replayFixture.responses[
      createReplayFixtureKey(changedCall.toolId, changedCall.input)
    ] = changedCall.result;
    await writeFile(
      resolve(firstDirectory, falseAlertName),
      `${JSON.stringify(falseAlertCandidate, null, 2)}\n`,
    );

    await assert.rejects(runValidation(firstDirectory), (error) => {
      const diagnostics = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(diagnostics, /false-alert/i);
      assert.match(diagnostics, /metrics/i);
      assert.match(diagnostics, /error_rate/i);
      return true;
    });
    assert.equal(
      await readFile(acceptedReplaySourcePath, 'utf8'),
      acceptedReplaySourceBefore,
      'candidate validation must never modify or promote accepted replay fixtures',
    );

    const reset = await requestJson(baseUrl, '/control/reset', { method: 'POST' });
    assert.equal(reset.response.status, 200);
    for (const scenario of acceptedScenarios) {
      for (const entry of scenario.fixture.entries) {
        const inactive = await requestJson(baseUrl, observationPath(entry));
        assert.equal(
          inactive.response.status,
          409,
          `${scenario.id}/${entry.toolId} must be unavailable after reset`,
        );
      }
    }
  },
);

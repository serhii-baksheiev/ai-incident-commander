import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createReplayFixtureKey } from '@aic/tools';
import {
  ReplayToolAdapter,
  REPLAY_FIXTURE_VERSION,
} from '@aic/tools/replay';

import { childEnv } from '../../test/fixtures/child-env.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeFile = resolve(projectRoot, 'incident-lab/compose.yaml');

const LAB_BUDGET = Object.freeze({
  composeStartTimeoutMs: 60_000,
  stageTimeoutMs: 15_000,
  runTimeoutMs: 150_000,
  scenarioRuns: 2,
  observationsPerRun: 2,
});

const OBSERVATION_REQUESTS = Object.freeze([
  Object.freeze({
    toolId: 'deployments',
    input: Object.freeze({ service: 'checkout', window: 'incident' }),
  }),
  Object.freeze({
    toolId: 'logs',
    input: Object.freeze({ service: 'checkout', query: 'startup-errors' }),
  }),
]);

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

async function withinStage(stage, operation, timeoutMs = LAB_BUDGET.stageTimeoutMs) {
  let timeout;

  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`exceeded ${timeoutMs} ms budget`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    throw new Error(`[${stage}] ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function assertCandidateEnvelope(candidate) {
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
      scenarioId: 'bad-deployment',
      scenarioVersion: 1,
      labTopologyVersion: 1,
      replayFixtureVersion: REPLAY_FIXTURE_VERSION,
    },
  );

  assert.equal(typeof candidate.replayFixture.responses, 'object');
  assert.notEqual(candidate.replayFixture.responses, null);
  assert.equal(candidate.recordedCalls.length, LAB_BUDGET.observationsPerRun);
  assert.deepEqual(
    candidate.recordedCalls.map(({ toolId, input }) => ({ toolId, input })),
    OBSERVATION_REQUESTS,
  );

  for (const call of candidate.recordedCalls) {
    assert.equal(call.result.status, 'ok');
    assert.deepEqual(
      candidate.replayFixture.responses[
        createReplayFixtureKey(call.toolId, call.input)
      ],
      call.result,
    );
  }
}

test(
  'records a reviewable bad-deployment candidate that replays after isolated resets',
  { timeout: LAB_BUDGET.runTimeoutMs },
  async (t) => {
    const hostPort = await reserveFreePort();
    const composeProject = `aic16-${process.pid}-${randomUUID().slice(0, 8)}`;
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    const candidateRoot = await mkdtemp(resolve(tmpdir(), 'aic16-bad-deployment-'));
    const firstCandidateDirectory = resolve(candidateRoot, 'first');
    const repeatedCandidateDirectory = resolve(candidateRoot, 'repeated');
    const composeEnvironment = childEnv({
      AIC_LAB_HOST_PORT: String(hostPort),
    });
    const composeArguments = [
      'compose',
      '--ansi',
      'never',
      '--file',
      composeFile,
      '--project-name',
      composeProject,
    ];
    let primaryFailure = false;
    let composeDiagnostics = '';

    await mkdir(firstCandidateDirectory);
    await mkdir(repeatedCandidateDirectory);

    t.after(async () => {
      const teardownErrors = [];

      try {
        const result = await execFileAsync(
          'docker',
          [...composeArguments, 'logs', '--no-color', '--timestamps'],
          {
            cwd: projectRoot,
            env: composeEnvironment,
            timeout: LAB_BUDGET.stageTimeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        composeDiagnostics = `${result.stdout}${result.stderr}`;
      } catch (error) {
        composeDiagnostics = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        teardownErrors.push(
          new Error(`[teardown logs] ${error.message}`, { cause: error }),
        );
      }

      try {
        await execFileAsync(
          'docker',
          [
            ...composeArguments,
            'down',
            '--volumes',
            '--remove-orphans',
            '--timeout',
            '10',
          ],
          {
            cwd: projectRoot,
            env: composeEnvironment,
            timeout: LAB_BUDGET.stageTimeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      } catch (error) {
        teardownErrors.push(
          new Error(`[teardown down] ${error.message}`, { cause: error }),
        );
      }

      await rm(candidateRoot, { recursive: true, force: true });

      if (teardownErrors.length > 0 && !primaryFailure) {
        throw new AggregateError(
          teardownErrors,
          `[teardown] compose cleanup failed\n${composeDiagnostics}`,
        );
      }
      if (teardownErrors.length > 0) {
        process.stderr.write(
          `[teardown diagnostics for ${composeProject}]\n${composeDiagnostics}\n`,
        );
      }
    });

    try {
      const composeConfig = await withinStage(
        'compose security config',
        async () => {
          const result = await execFileAsync(
            'docker',
            [...composeArguments, 'config', '--format', 'json'],
            {
              cwd: projectRoot,
              env: composeEnvironment,
              timeout: LAB_BUDGET.stageTimeoutMs,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
          return JSON.parse(result.stdout);
        },
      );
      assert.equal(
        composeConfig.services.checkout.ports[0].host_ip,
        '127.0.0.1',
        'the unauthenticated lab control API must bind only to loopback',
      );

      await withinStage(
        'compose start',
        () =>
          execFileAsync(
            'docker',
            [...composeArguments, 'up', '--detach', '--wait'],
            {
              cwd: projectRoot,
              env: composeEnvironment,
              timeout: LAB_BUDGET.composeStartTimeoutMs,
              maxBuffer: 4 * 1024 * 1024,
            },
          ),
        LAB_BUDGET.composeStartTimeoutMs,
      );

      const {
        recordBadDeploymentCandidate,
        resetBadDeploymentLab,
        startBadDeploymentScenario,
      } = await withinStage(
        'observation/recording API load',
        () => import('../src/bad-deployment.mjs'),
      );

      const resetState = await withinStage(
        'reset',
        () => resetBadDeploymentLab({ baseUrl }),
      );
      assert.equal(resetState.activeIncident, false);

      const startedState = await withinStage(
        'scenario start',
        () => startBadDeploymentScenario({ baseUrl, scenarioVersion: 1 }),
      );
      assert.equal(startedState.scenarioId, 'bad-deployment');
      assert.equal(startedState.scenarioVersion, 1);
      assert.equal(startedState.activeIncident, true);

      const firstRecord = await withinStage(
        'observation/recording',
        () => recordBadDeploymentCandidate({
          baseUrl,
          scenarioVersion: 1,
          candidateDirectory: firstCandidateDirectory,
        }),
      );
      const firstText = await readFile(firstRecord.candidatePath, 'utf8');
      const firstCandidate = JSON.parse(firstText);
      assertCandidateEnvelope(firstCandidate);
      assert.equal(firstText, `${JSON.stringify(firstCandidate, null, 2)}\n`);

      await withinStage('observation/recording overwrite refusal', () =>
        assert.rejects(
          recordBadDeploymentCandidate({
            baseUrl,
            scenarioVersion: 1,
            candidateDirectory: firstCandidateDirectory,
          }),
          /already exists|refus(?:e|es|ed).*overwrite/i,
        ));
      assert.equal(await readFile(firstRecord.candidatePath, 'utf8'), firstText);

      const repeatedResetState = await withinStage(
        'reset',
        () => resetBadDeploymentLab({ baseUrl }),
      );
      assert.equal(repeatedResetState.activeIncident, false);

      await withinStage(
        'scenario start',
        () => startBadDeploymentScenario({ baseUrl, scenarioVersion: 1 }),
      );
      const repeatedRecord = await withinStage(
        'observation/recording',
        () => recordBadDeploymentCandidate({
          baseUrl,
          scenarioVersion: 1,
          candidateDirectory: repeatedCandidateDirectory,
        }),
      );
      const repeatedText = await readFile(repeatedRecord.candidatePath, 'utf8');
      const repeatedCandidate = JSON.parse(repeatedText);
      assertCandidateEnvelope(repeatedCandidate);
      assert.equal(repeatedText, firstText);

      const finalResetState = await withinStage(
        'reset isolation',
        () => resetBadDeploymentLab({ baseUrl }),
      );
      assert.equal(finalResetState.activeIncident, false);

      await withinStage('reset observation isolation', () =>
        assert.rejects(
          recordBadDeploymentCandidate({
            baseUrl,
            scenarioVersion: 1,
            candidateDirectory: resolve(candidateRoot, 'after-reset'),
          }),
          /live observation failed for deployments: error/,
        ));

      await withinStage('replay', async () => {
        const replay = new ReplayToolAdapter(firstCandidate.replayFixture);

        for (const call of firstCandidate.recordedCalls) {
          assert.deepEqual(
            await replay.execute(call.toolId, call.input),
            call.result,
          );
        }
      });
    } catch (error) {
      primaryFailure = true;
      throw error;
    }
  },
);

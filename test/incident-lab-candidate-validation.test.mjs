import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { REPLAY_SCENARIOS } from '@aic/evals';
import { createReplayFixtureKey } from '@aic/tools';
import { REPLAY_FIXTURE_VERSION } from '@aic/tools/replay';

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

async function requireCandidateValidationApi() {
  try {
    const candidateValidation = await import(
      '../incident-lab/src/candidate-validation.mjs'
    );
    assert.equal(
      typeof candidateValidation.validateCandidateDirectory,
      'function',
      'candidate validation must export validateCandidateDirectory(options)',
    );
    return candidateValidation;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail(
        'candidate validation contract is missing: incident-lab/src/candidate-validation.mjs',
      );
    }
    throw error;
  }
}

function candidateFromScenario(scenario) {
  const recordedCalls = scenario.fixture.entries.map(({ toolId, input, result }) => ({
    toolId,
    input,
    result,
  }));
  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    scenarioVersion: 1,
    labTopologyVersion: 2,
    recordedCalls,
    replayFixture: {
      version: REPLAY_FIXTURE_VERSION,
      responses: Object.fromEntries(
        recordedCalls.map(({ toolId, input, result }) => [
          createReplayFixtureKey(toolId, input),
          result,
        ]),
      ),
    },
  };
}

async function writeCandidate(directory, candidate) {
  const candidatePath = resolve(
    directory,
    `${candidate.scenarioId}.v${candidate.scenarioVersion}.candidate.json`,
  );
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  return candidatePath;
}

async function withCandidateDirectory(t) {
  const candidateDirectory = await mkdtemp(
    resolve(tmpdir(), 'aic16-candidate-validation-'),
  );
  t.after(() => rm(candidateDirectory, { recursive: true, force: true }));
  return candidateDirectory;
}

test('accepts exactly the five matching v0.1 candidates without changing accepted replay fixtures', async (t) => {
  const candidateDirectory = await withCandidateDirectory(t);
  const acceptedBefore = JSON.stringify(acceptedScenarios);
  for (const scenario of acceptedScenarios) {
    await writeCandidate(candidateDirectory, candidateFromScenario(scenario));
  }

  const { validateCandidateDirectory } = await requireCandidateValidationApi();
  const report = await validateCandidateDirectory({
    candidateDirectory,
    acceptedScenarios,
  });

  assert.deepEqual(report, {
    status: 'match',
    scenarios: V01_SCENARIO_IDS.map((scenarioId) => ({
      scenarioId,
      status: 'match',
      differences: [],
    })),
  });
  assert.equal(
    JSON.stringify(acceptedScenarios),
    acceptedBefore,
    'validation must never mutate or promote accepted replay fixtures',
  );
});

test('reports replay drift against the affected scenario and observation', async (t) => {
  const candidateDirectory = await withCandidateDirectory(t);
  for (const scenario of acceptedScenarios) {
    const candidate = candidateFromScenario(scenario);
    if (scenario.id === 'false-alert') {
      const changedCall = candidate.recordedCalls[0];
      changedCall.result = {
        status: 'unavailable',
        reason: 'live metric was unavailable',
      };
      candidate.replayFixture.responses[
        createReplayFixtureKey(changedCall.toolId, changedCall.input)
      ] = changedCall.result;
    }
    await writeCandidate(candidateDirectory, candidate);
  }

  const { validateCandidateDirectory } = await requireCandidateValidationApi();
  const report = await validateCandidateDirectory({
    candidateDirectory,
    acceptedScenarios,
  });
  const falseAlert = report.scenarios.find(
    ({ scenarioId }) => scenarioId === 'false-alert',
  );

  assert.equal(report.status, 'drift');
  assert.equal(falseAlert?.status, 'drift');
  assert.ok(
    falseAlert.differences.some(
      (difference) =>
        difference.includes('metrics') && difference.includes('error_rate'),
    ),
    'drift must identify the observation that differs without hiding it in a composite result',
  );
  for (const scenarioId of V01_SCENARIO_IDS.filter(
    (scenarioId) => scenarioId !== 'false-alert',
  )) {
    assert.equal(
      report.scenarios.find((scenario) => scenario.scenarioId === scenarioId)
        ?.status,
      'match',
      `${scenarioId} must remain independently attributable`,
    );
  }
});

test('reports an embedded replay response that has no recorded live call', async (t) => {
  const candidateDirectory = await withCandidateDirectory(t);
  for (const scenario of acceptedScenarios) {
    const candidate = candidateFromScenario(scenario);
    if (scenario.id === 'false-alert') {
      candidate.replayFixture.responses[
        createReplayFixtureKey('metrics', {
          service: 'checkout',
          metric: 'unrecorded_metric',
        })
      ] = {
        status: 'unavailable',
        reason: 'this response has no recorded live call',
      };
    }
    await writeCandidate(candidateDirectory, candidate);
  }

  const { validateCandidateDirectory } = await requireCandidateValidationApi();
  const report = await validateCandidateDirectory({
    candidateDirectory,
    acceptedScenarios,
  });
  const falseAlert = report.scenarios.find(
    ({ scenarioId }) => scenarioId === 'false-alert',
  );

  assert.equal(report.status, 'drift');
  assert.equal(falseAlert?.status, 'drift');
  assert.ok(
    falseAlert.differences.some(
      (difference) =>
        /unrecorded|without.*recorded|extra replay/i.test(difference)
        && difference.includes('unrecorded_metric'),
    ),
    'every replay response must be attributable to one recorded LiveToolAdapter call',
  );
});

test('rejects an incomplete candidate set instead of validating a partial corpus', async (t) => {
  const candidateDirectory = await withCandidateDirectory(t);
  for (const scenario of acceptedScenarios.slice(0, -1)) {
    await writeCandidate(candidateDirectory, candidateFromScenario(scenario));
  }

  const { validateCandidateDirectory } = await requireCandidateValidationApi();
  await assert.rejects(
    validateCandidateDirectory({ candidateDirectory, acceptedScenarios }),
    /missing candidate.*dependency-caused-incident-b/i,
  );
});

test('rejects an extra candidate instead of silently widening the accepted corpus', async (t) => {
  const candidateDirectory = await withCandidateDirectory(t);
  for (const scenario of acceptedScenarios) {
    await writeCandidate(candidateDirectory, candidateFromScenario(scenario));
  }
  await writeCandidate(candidateDirectory, {
    ...candidateFromScenario(acceptedScenarios[0]),
    scenarioId: 'unreviewed-live-scenario',
  });

  const { validateCandidateDirectory } = await requireCandidateValidationApi();
  await assert.rejects(
    validateCandidateDirectory({ candidateDirectory, acceptedScenarios }),
    /unexpected candidate.*unreviewed-live-scenario/i,
  );

  const acceptedSource = await readFile(
    resolve('packages/evals/src/replay-scenarios.ts'),
    'utf8',
  );
  assert.equal(
    acceptedSource.includes('unreviewed-live-scenario'),
    false,
    'validation must not promote an extra candidate',
  );
});

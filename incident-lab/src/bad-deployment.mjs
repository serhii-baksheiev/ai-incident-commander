import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createReplayFixtureKey } from '@aic/tools';
import { LiveToolAdapter } from '@aic/tools/live';
import { REPLAY_FIXTURE_VERSION } from '@aic/tools/replay';

const SCENARIO_ID = 'bad-deployment';
const SCENARIO_VERSION = 1;
const LAB_TOPOLOGY_VERSION = 1;
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

async function requestJson(baseUrl, pathname, init) {
  const response = await fetch(new URL(pathname, baseUrl), init);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      `lab request failed (${response.status}): ${body.error ?? 'unknown error'}`,
    );
  }
  return body;
}

function assertScenarioVersion(scenarioVersion) {
  if (scenarioVersion !== SCENARIO_VERSION) {
    throw new Error(
      `unsupported bad-deployment scenario version: ${scenarioVersion}`,
    );
  }
}

function createObservationTool(baseUrl, toolId) {
  return {
    id: toolId,
    risk: 'read',
    async execute(input) {
      const query = new URLSearchParams(input);
      const output = await requestJson(
        baseUrl,
        `/observations/${toolId}?${query.toString()}`,
      );
      return { status: 'ok', output };
    },
  };
}

export async function resetBadDeploymentLab({ baseUrl }) {
  return requestJson(baseUrl, '/control/reset', { method: 'POST' });
}

export async function startBadDeploymentScenario({ baseUrl, scenarioVersion }) {
  assertScenarioVersion(scenarioVersion);
  return requestJson(baseUrl, '/control/scenarios/bad-deployment/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioVersion }),
  });
}

export async function recordBadDeploymentCandidate({
  baseUrl,
  scenarioVersion,
  candidateDirectory,
}) {
  assertScenarioVersion(scenarioVersion);
  const adapter = new LiveToolAdapter([
    createObservationTool(baseUrl, 'deployments'),
    createObservationTool(baseUrl, 'logs'),
  ]);
  const recordedCalls = [];
  const responses = {};

  for (const { toolId, input } of OBSERVATION_REQUESTS) {
    const result = await adapter.execute(toolId, input);
    if (result.status !== 'ok') {
      throw new Error(`live observation failed for ${toolId}: ${result.status}`);
    }
    const call = { toolId, input, result };
    recordedCalls.push(call);
    responses[createReplayFixtureKey(toolId, input)] = result;
  }

  const candidate = {
    schemaVersion: 1,
    scenarioId: SCENARIO_ID,
    scenarioVersion: SCENARIO_VERSION,
    labTopologyVersion: LAB_TOPOLOGY_VERSION,
    recordedCalls,
    replayFixture: {
      version: REPLAY_FIXTURE_VERSION,
      responses,
    },
  };
  const candidatePath = resolve(
    candidateDirectory,
    `${SCENARIO_ID}.v${SCENARIO_VERSION}.candidate.json`,
  );

  await mkdir(candidateDirectory, { recursive: true });
  try {
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        `candidate already exists; refusing overwrite: ${candidatePath}`,
      );
    }
    throw error;
  }

  return { candidatePath, candidate };
}

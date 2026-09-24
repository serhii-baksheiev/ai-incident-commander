import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createBoundSourceRegistry,
  createLabEvidenceSource,
  createMemoryReplayStore,
  createReplayFixtureKey,
} from '@aic/tools';
import { REPLAY_FIXTURE_VERSION } from '@aic/tools/replay';

import {
  findLiveScenario,
  LAB_TOPOLOGY_VERSION,
  LIVE_SCENARIOS,
} from '../scenario-definitions.mjs';

async function requestJson(baseUrl, pathname, init) {
  const response = await fetch(new URL(pathname, baseUrl), {
    ...init,
    redirect: 'error',
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `lab request failed (${response.status}): ${body.error ?? 'unknown error'}`,
    );
  }
  return body;
}

function requireScenario(scenarioId, scenarioVersion) {
  const scenario = findLiveScenario(scenarioId);
  if (!scenario) throw new Error(`unsupported live scenario: ${scenarioId}`);
  if (scenarioVersion !== scenario.version) {
    throw new Error(
      `unsupported ${scenarioId} scenario version: ${scenarioVersion}`,
    );
  }
  return scenario;
}

function candidatePath(candidateDirectory, scenario) {
  return resolve(
    candidateDirectory,
    `${scenario.id}.v${scenario.version}.candidate.json`,
  );
}

function createLiveObservationRegistry(baseUrl) {
  return createBoundSourceRegistry({
    mode: 'live',
    bindings: [
      {
        sourceBindingId: 'incident-lab',
        source: createLabEvidenceSource({ baseUrl }),
        credentialRefId: null,
        expectedAdapter: 'lab@1',
      },
    ],
    store: createMemoryReplayStore(),
    clock: () => new Date(),
  });
}

async function buildCandidate({ baseUrl, scenario }) {
  const registry = createLiveObservationRegistry(baseUrl);
  const recordedCalls = [];
  const responses = {};
  for (const { toolId, input } of scenario.observations) {
    const outcome = await registry.execute('incident-lab', toolId, input);
    if (outcome.status !== 'ok') {
      throw new Error(`live observation failed for ${toolId}: ${outcome.reason}`);
    }
    const result = { status: 'ok', output: outcome.output };
    recordedCalls.push({ toolId, input, result });
    responses[createReplayFixtureKey(toolId, input)] = result;
  }
  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    labTopologyVersion: LAB_TOPOLOGY_VERSION,
    recordedCalls,
    replayFixture: {
      version: REPLAY_FIXTURE_VERSION,
      responses,
    },
  };
}

async function writeCandidateExclusive(path, candidate) {
  try {
    await writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`candidate already exists; refusing overwrite: ${path}`);
    }
    throw error;
  }
}

async function writeCandidateSetExclusive(records) {
  const reservations = [];
  try {
    for (const record of records) {
      reservations.push({
        ...record,
        handle: await open(record.candidatePath, 'wx'),
      });
    }
    for (const { handle, candidate } of reservations) {
      await handle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    await Promise.allSettled(reservations.map(({ handle }) => handle.close()));
    await Promise.allSettled(
      reservations.map(({ candidatePath: path }) => unlink(path)),
    );
    if (error.code === 'EEXIST') {
      throw new Error('candidate already exists; refusing overwrite');
    }
    throw error;
  }
  await Promise.all(reservations.map(({ handle }) => handle.close()));
}

export async function resetLiveLab({ baseUrl }) {
  return requestJson(baseUrl, '/control/reset', { method: 'POST' });
}

export async function startLiveScenario({
  baseUrl,
  scenarioId,
  scenarioVersion,
}) {
  const scenario = requireScenario(scenarioId, scenarioVersion);
  return requestJson(baseUrl, `/control/scenarios/${scenario.id}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioVersion: scenario.version }),
  });
}

export async function recordScenarioCandidate({
  baseUrl,
  scenarioId,
  scenarioVersion,
  candidateDirectory,
}) {
  const scenario = requireScenario(scenarioId, scenarioVersion);
  const candidate = await buildCandidate({ baseUrl, scenario });
  const path = candidatePath(candidateDirectory, scenario);
  await mkdir(candidateDirectory, { recursive: true });
  await writeCandidateExclusive(path, candidate);
  return { candidatePath: path, candidate };
}

export async function regenerateV01Candidates({ baseUrl, candidateDirectory }) {
  await mkdir(candidateDirectory, { recursive: true });
  const records = [];
  try {
    for (const scenario of LIVE_SCENARIOS) {
      await resetLiveLab({ baseUrl });
      await startLiveScenario({
        baseUrl,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
      });
      records.push({
        candidatePath: candidatePath(candidateDirectory, scenario),
        candidate: await buildCandidate({ baseUrl, scenario }),
      });
    }
  } finally {
    await resetLiveLab({ baseUrl });
  }
  await writeCandidateSetExclusive(records);
  return records;
}

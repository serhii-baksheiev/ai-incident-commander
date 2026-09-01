import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createReplayFixtureKey } from '@aic/tools';
import { REPLAY_FIXTURE_VERSION } from '@aic/tools/replay';

import { LAB_TOPOLOGY_VERSION } from '../scenario-definitions.mjs';

function candidateName(scenario) {
  return `${scenario.id}.v1.candidate.json`;
}

function differenceLabel(entry, detail) {
  return `${entry.toolId} ${JSON.stringify(entry.input)}: ${detail}`;
}

function compareScenario(candidate, acceptedScenario) {
  const differences = [];
  if (
    candidate.schemaVersion !== 1
    || candidate.scenarioId !== acceptedScenario.id
    || candidate.scenarioVersion !== 1
    || candidate.labTopologyVersion !== LAB_TOPOLOGY_VERSION
    || candidate.replayFixture?.version !== REPLAY_FIXTURE_VERSION
  ) {
    differences.push('candidate provenance does not match the declared v0.1 lab contract');
  }

  const recordedCalls = Array.isArray(candidate.recordedCalls)
    ? candidate.recordedCalls
    : [];
  const acceptedEntries = acceptedScenario.fixture.entries;
  if (recordedCalls.length !== acceptedEntries.length) {
    differences.push(
      `recorded call count ${recordedCalls.length} does not match accepted count ${acceptedEntries.length}`,
    );
  }

  for (let index = 0; index < acceptedEntries.length; index += 1) {
    const acceptedEntry = acceptedEntries[index];
    const recordedCall = recordedCalls[index];
    if (!recordedCall) {
      differences.push(differenceLabel(acceptedEntry, 'observation is missing'));
      continue;
    }
    if (
      recordedCall.toolId !== acceptedEntry.toolId
      || !isDeepStrictEqual(recordedCall.input, acceptedEntry.input)
    ) {
      differences.push(
        differenceLabel(acceptedEntry, 'tool id or input does not match'),
      );
      continue;
    }
    if (!isDeepStrictEqual(recordedCall.result, acceptedEntry.result)) {
      differences.push(
        differenceLabel(acceptedEntry, 'live result differs from accepted replay'),
      );
    }
    const replayResult = candidate.replayFixture?.responses?.[
      createReplayFixtureKey(recordedCall.toolId, recordedCall.input)
    ];
    if (!isDeepStrictEqual(replayResult, recordedCall.result)) {
      differences.push(
        differenceLabel(acceptedEntry, 'embedded replay differs from recorded call'),
      );
    }
  }
  const recordedReplayKeys = new Set(
    recordedCalls.map(({ toolId, input }) =>
      createReplayFixtureKey(toolId, input),
    ),
  );
  for (const replayKey of Object.keys(candidate.replayFixture?.responses ?? {})) {
    if (!recordedReplayKeys.has(replayKey)) {
      differences.push(
        `extra replay response without a recorded live call: ${replayKey}`,
      );
    }
  }
  return differences;
}

export async function validateCandidateDirectory({
  candidateDirectory,
  acceptedScenarios,
}) {
  const expectedNames = new Set(acceptedScenarios.map(candidateName));
  const actualNames = (await readdir(candidateDirectory)).filter((name) =>
    name.endsWith('.candidate.json'),
  );
  for (const expectedName of expectedNames) {
    if (!actualNames.includes(expectedName)) {
      throw new Error(`missing candidate: ${expectedName}`);
    }
  }
  for (const actualName of actualNames) {
    if (!expectedNames.has(actualName)) {
      throw new Error(`unexpected candidate: ${actualName}`);
    }
  }

  const scenarios = [];
  for (const acceptedScenario of acceptedScenarios) {
    const candidate = JSON.parse(
      await readFile(
        resolve(candidateDirectory, candidateName(acceptedScenario)),
        'utf8',
      ),
    );
    const differences = compareScenario(candidate, acceptedScenario);
    scenarios.push({
      scenarioId: acceptedScenario.id,
      status: differences.length === 0 ? 'match' : 'drift',
      differences,
    });
  }
  return {
    status: scenarios.every(({ status }) => status === 'match')
      ? 'match'
      : 'drift',
    scenarios,
  };
}

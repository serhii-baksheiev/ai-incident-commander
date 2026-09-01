import {
  recordScenarioCandidate,
  resetLiveLab,
  startLiveScenario,
} from './scenario-candidates.mjs';

const SCENARIO_ID = 'bad-deployment';

export async function resetBadDeploymentLab({ baseUrl }) {
  return resetLiveLab({ baseUrl });
}

export async function startBadDeploymentScenario({ baseUrl, scenarioVersion }) {
  return startLiveScenario({
    baseUrl,
    scenarioId: SCENARIO_ID,
    scenarioVersion,
  });
}

export async function recordBadDeploymentCandidate({
  baseUrl,
  scenarioVersion,
  candidateDirectory,
}) {
  return recordScenarioCandidate({
    baseUrl,
    scenarioId: SCENARIO_ID,
    scenarioVersion,
    candidateDirectory,
  });
}

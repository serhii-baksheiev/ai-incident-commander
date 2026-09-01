import { REPLAY_SCENARIOS } from '@aic/evals';

import { LIVE_SCENARIO_IDS } from '../scenario-definitions.mjs';
import { validateCandidateDirectory } from '../src/candidate-validation.mjs';

function parseCandidateDirectory(arguments_) {
  if (
    arguments_.length !== 2
    || arguments_[0] !== '--candidate-directory'
    || !arguments_[1]
  ) {
    throw new Error('usage: --candidate-directory <directory>');
  }
  return arguments_[1];
}

try {
  const acceptedScenarios = LIVE_SCENARIO_IDS.map((scenarioId) => {
    const scenario = REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
    if (!scenario) throw new Error(`missing accepted v0.1 scenario: ${scenarioId}`);
    return scenario;
  });
  const report = await validateCandidateDirectory({
    candidateDirectory: parseCandidateDirectory(process.argv.slice(2)),
    acceptedScenarios,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (report.status === 'match') {
    process.stdout.write(output);
  } else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

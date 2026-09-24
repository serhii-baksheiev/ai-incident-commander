#!/usr/bin/env node
/**
 * The oracle positive control, as a report.
 *
 * `node --import ./test/fixtures/no-ambient-tracing.mjs scripts/eval-oracle.mjs`
 *
 * Runs the oracle arm (`@aic/evals/oracle`) over the CALIBRATION partition and
 * prints, per scenario and per metric, what the evaluator scores an answer that
 * was projected from ground truth — and which metrics that answer cannot bring
 * to their best value. The committed copy of this output under
 * `docs/evidence/oracle/` is the measurement the evaluator repair is read
 * against, and a test keeps the two equal:
 * see oracle-positive-control.test.mjs › "scripts/eval-oracle.mjs prints JSON
 * on stdout that deep-equals the committed evidence file"
 *
 * Calibration only. The hold-out is not run here, and not read: this report
 * guides evaluator repair, and repair guidance never comes from the hold-out.
 * see oracle-positive-control.test.mjs › "never runs or scores a hold-out scenario"
 *
 * `providerCalls` counts calls to the global `fetch` binding during the run:
 * it is replaced by a function that counts and refuses, and restored after.
 * That is the transport the provider port uses today
 * (`packages/roles/src/reference-model-port.ts`); a call made through
 * `node:http`, a socket or a child process would not be counted.
 *
 * `npm run eval:oracle` builds first and runs this with the same preload.
 */
import { realpathSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { STATUS_RULES_VERSION } from '@aic/domain';
import * as evals from '@aic/evals';
import { ORACLE_ARM, oracleAnswerFor, runOracleBenchmarkExperiment } from '@aic/evals/oracle';

const RUNS_PER_SCENARIO = 3;

/**
 * `--evaluator-version <id>` picks the evaluator the oracle is scored by — and
 * the ground-truth vocabulary it projects. Without it, the accepted
 * `behavior-evaluators-v0.2`, so the first measurement stays reproducible.
 */
function evaluatorVersionFromArgs() {
  const index = argv.indexOf('--evaluator-version');
  return index < 0 ? evals.BEHAVIOR_EVALUATOR_VERSION : argv[index + 1];
}

const baseMetadata = Object.freeze({
  graphVersion: 'none-oracle',
  promptVersion: 'none-oracle',
  toolsetVersion: 'toolset-v0.1',
  statusRulesVersion: STATUS_RULES_VERSION,
  toolMode: 'replay',
  knowledgeSetVersion: 'knowledge-none-v0.1',
  memoryEnabled: false,
  temperature: 0,
  docsAvailable: false,
});

function metricsOf(result) {
  const metrics = {};
  for (const [key, { score }] of Object.entries(result.metrics)) {
    metrics[key] = { score };
  }
  for (const [key, { score, reason }] of Object.entries(result.behaviorMetrics)) {
    metrics[key] = { score, reason };
  }
  return metrics;
}

/**
 * Which metrics reached their best value on every scenario that emitted them.
 * A metric no scenario emitted was not measured, so it is not reached.
 * see oracle-positive-control.test.mjs › "reachesBest does not count a metric no
 * scenario emitted as reached"
 */
export function reachesBestOf(scenarios, bestValues) {
  const reachesBest = {};
  for (const [key, best] of Object.entries(bestValues)) {
    const emitted = scenarios.some(({ metrics }) => Object.hasOwn(metrics, key));
    const scenariosBelowBest = scenarios
      .filter(({ metrics }) => Object.hasOwn(metrics, key) && metrics[key].score !== best)
      .map(({ scenarioId }) => scenarioId);
    reachesBest[key] = { reached: emitted && scenariosBelowBest.length === 0, scenariosBelowBest };
  }
  return reachesBest;
}

export async function buildOracleReport(evaluatorVersion = evals.BEHAVIOR_EVALUATOR_VERSION) {
  const metadata = { ...baseMetadata, evaluatorVersion };
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error('the oracle positive control may not reach a provider');
  };

  const byScenario = new Map();
  try {
    await runOracleBenchmarkExperiment({
      experimentId: 'aic-113-oracle-positive-control',
      scenarioSet: 'calibration',
      runsPerScenario: RUNS_PER_SCENARIO,
      metadata,
      async recordEvaluation({ record, result }) {
        const runs = byScenario.get(record.scenario.id) ?? [];
        runs.push(metricsOf(result));
        byScenario.set(record.scenario.id, runs);
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const scenariosById = new Map(evals.REPLAY_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  const scenarios = evals.BENCHMARK_SCENARIO_PARTITIONS.calibration.map((scenarioId) => {
    const runs = byScenario.get(scenarioId) ?? [];
    if (runs.length !== RUNS_PER_SCENARIO) {
      throw new Error(`${scenarioId} produced ${runs.length} runs, expected ${RUNS_PER_SCENARIO}`);
    }
    // The oracle is deterministic, so its runs must agree. A disagreement is a
    // defect to find, not a variance to average away.
    for (const run of runs.slice(1)) {
      if (JSON.stringify(run) !== JSON.stringify(runs[0])) {
        throw new Error(`${scenarioId}: the oracle's runs disagree, which a deterministic arm cannot do`);
      }
    }
    const { answer } = oracleAnswerFor(scenariosById.get(scenarioId), evaluatorVersion);
    return {
      scenarioId,
      claimCount: answer.conclusion.causes.length,
      metrics: runs[0],
    };
  });

  const reachesBest = reachesBestOf(scenarios, evals.METRIC_BEST_VALUES);

  return {
    evaluatorVersion,
    partition: 'calibration',
    arm: { ...ORACLE_ARM },
    providerCalls,
    runsPerScenario: RUNS_PER_SCENARIO,
    bestValues: { ...evals.METRIC_BEST_VALUES },
    scenarios,
    reachesBest,
  };
}

/**
 * Compared by realpath, for the reason `scripts/eval-live-model.mjs` records at
 * its own copy of this guard: a checkout reached through a symlink otherwise
 * runs nothing and exits 0.
 */
const invokedDirectly = () => {
  if (!argv[1]) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(argv[1]);
};

if (invokedDirectly()) {
  buildOracleReport(evaluatorVersionFromArgs())
    .then((report) => stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      stderr.write(`${error.name}: ${error.message}\n`);
      exit(1);
    });
}

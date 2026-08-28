import { isDeepStrictEqual } from 'node:util';

import {
  BENCHMARK_METRIC_KEYS,
  type BenchmarkEvaluation,
  type BenchmarkExperiment,
  type BenchmarkMetricKey,
  type BenchmarkRecord,
} from './benchmark-evaluation.js';

export interface BenchmarkGateResult {
  readonly passed: boolean;
  readonly failingExampleIds: readonly string[];
}

export interface BenchmarkMetricGate {
  readonly requiredScore: number;
  readonly baseline: BenchmarkGateResult;
  readonly mutation: BenchmarkGateResult;
}

export interface BenchmarkRegressionProof {
  readonly testedHeadSha: string;
  readonly experiments: Readonly<{
    baseline: string;
    mutation: string;
  }>;
  readonly exampleIds: readonly string[];
  readonly metrics: Readonly<Record<BenchmarkMetricKey, BenchmarkMetricGate>>;
}

interface IndexedExperiment {
  readonly experimentId: string;
  readonly exampleIds: readonly string[];
  readonly runIds: readonly string[];
  readonly recordsByExampleId: ReadonlyMap<string, BenchmarkRecord>;
  readonly resultsByExampleId: ReadonlyMap<string, BenchmarkEvaluation>;
}

function indexExperiment(
  experiment: BenchmarkExperiment,
  label: string,
): IndexedExperiment {
  if (
    experiment.records.length === 0 ||
    experiment.records.length !== experiment.results.length
  ) {
    throw new Error(`${label} experiment must pair every record with a result`);
  }

  const experimentId = experiment.records[0]?.experimentId;
  if (
    experimentId === undefined ||
    experiment.records.some((record) => record.experimentId !== experimentId)
  ) {
    throw new Error(`${label} records must belong to one experiment`);
  }

  const scenarioCounts = new Map<string, number>();
  for (const record of experiment.records) {
    if (record.scenario.id !== record.metadata.scenarioId) {
      throw new Error(
        `${label} record scenario.id must match metadata.scenarioId`,
      );
    }
    if (record.runId !== record.metadata.runId) {
      throw new Error(`${label} record.runId must match metadata.runId`);
    }
    if (record.threadId !== record.runId) {
      throw new Error(`${label} record threadId must match runId`);
    }
    scenarioCounts.set(
      record.scenario.id,
      (scenarioCounts.get(record.scenario.id) ?? 0) + 1,
    );
  }
  if (
    scenarioCounts.size !== 5 ||
    [...scenarioCounts.values()].some((count) => count < 3)
  ) {
    throw new Error(
      `${label} benchmark must contain five scenarios with at least three runs each`,
    );
  }

  const recordsByExampleId = new Map(
    experiment.records.map((record) => [record.exampleId, record]),
  );
  const runIds = experiment.records.map(({ runId }) => runId);
  if (
    recordsByExampleId.size !== experiment.records.length ||
    new Set(runIds).size !== runIds.length
  ) {
    throw new Error(`${label} records must have unique example and run identities`);
  }

  const resultsByExampleId = new Map<string, BenchmarkEvaluation>();
  for (const result of experiment.results) {
    const record = recordsByExampleId.get(result.exampleId);
    if (
      record === undefined ||
      result.experimentId !== record.experimentId ||
      resultsByExampleId.has(result.exampleId)
    ) {
      throw new Error(`${label} results must uniquely match their experiment`);
    }
    if (result.runId !== record.runId) {
      throw new Error(`${label} result runId must match its benchmark record`);
    }
    resultsByExampleId.set(result.exampleId, result);
  }

  const exampleIds = experiment.records.map(({ exampleId }) => exampleId);
  if (exampleIds.some((exampleId) => !resultsByExampleId.has(exampleId))) {
    throw new Error(`${label} results must match every stable example`);
  }

  return {
    experimentId,
    exampleIds,
    runIds,
    recordsByExampleId,
    resultsByExampleId,
  };
}

function requireMetricScore(score: unknown): asserts score is number {
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1
  ) {
    throw new Error(
      'benchmark metric score must be a finite number between 0 and 1',
    );
  }
}

function gateMetric(
  experiment: IndexedExperiment,
  metricKey: BenchmarkMetricKey,
  requiredScore: number,
): BenchmarkGateResult {
  requireMetricScore(requiredScore);

  const failingExampleIds = experiment.exampleIds.filter((exampleId) => {
    const metric = experiment.resultsByExampleId.get(exampleId)?.metrics[metricKey];
    if (metric === undefined || metric.key !== metricKey) {
      throw new Error(`benchmark result is missing metric: ${metricKey}`);
    }
    requireMetricScore(metric.score);
    return metric.score !== requiredScore;
  });

  return {
    passed: failingExampleIds.length === 0,
    failingExampleIds,
  };
}

function requireSameBenchmark(
  baseline: IndexedExperiment,
  mutation: IndexedExperiment,
): void {
  if (
    baseline.exampleIds.length !== mutation.exampleIds.length ||
    baseline.exampleIds.some(
      (exampleId, index) => mutation.exampleIds[index] !== exampleId,
    )
  ) {
    throw new Error('baseline and mutation must share stable example identities');
  }

  for (const exampleId of baseline.exampleIds) {
    const baselineScenario = baseline.recordsByExampleId.get(exampleId)?.scenario;
    const mutationScenario = mutation.recordsByExampleId.get(exampleId)?.scenario;
    if (baselineScenario?.id !== mutationScenario?.id) {
      throw new Error('scenario identity must match for each stable example');
    }
    if (!isDeepStrictEqual(baselineScenario?.groundTruth, mutationScenario?.groundTruth)) {
      throw new Error('ground truth must match for each stable example');
    }
    if (!isDeepStrictEqual(baselineScenario?.fixture, mutationScenario?.fixture)) {
      throw new Error('scenario fixture must match for each stable example');
    }
  }
}

export function compareBenchmarkExperiments({
  testedHeadSha,
  baseline,
  mutation,
  expectedScores,
  expectedMutationMetric,
}: Readonly<{
  testedHeadSha: string;
  baseline: BenchmarkExperiment;
  mutation: BenchmarkExperiment;
  expectedScores: Readonly<Record<BenchmarkMetricKey, number>>;
  expectedMutationMetric: BenchmarkMetricKey;
}>): BenchmarkRegressionProof {
  if (!/^[0-9a-f]{40}$/i.test(testedHeadSha)) {
    throw new Error('testedHeadSha must be a full Git commit SHA');
  }
  if (!BENCHMARK_METRIC_KEYS.includes(expectedMutationMetric)) {
    throw new Error('expected mutation metric must be a v0.1 benchmark metric');
  }

  const baselineIndex = indexExperiment(baseline, 'baseline');
  const mutationIndex = indexExperiment(mutation, 'mutation');
  if (baselineIndex.experimentId === mutationIndex.experimentId) {
    throw new Error('baseline and mutation experiment references must differ');
  }
  const baselineRunIds = new Set(baselineIndex.runIds);
  if (mutationIndex.runIds.some((runId) => baselineRunIds.has(runId))) {
    throw new Error('baseline and mutation run IDs must not overlap');
  }
  requireSameBenchmark(baselineIndex, mutationIndex);

  const metrics = Object.fromEntries(
    BENCHMARK_METRIC_KEYS.map((metricKey) => {
      const requiredScore = expectedScores[metricKey];
      return [
        metricKey,
        {
          requiredScore,
          baseline: gateMetric(baselineIndex, metricKey, requiredScore),
          mutation: gateMetric(mutationIndex, metricKey, requiredScore),
        },
      ];
    }),
  ) as Record<BenchmarkMetricKey, BenchmarkMetricGate>;

  if (BENCHMARK_METRIC_KEYS.some((metricKey) => !metrics[metricKey].baseline.passed)) {
    throw new Error('baseline must pass every v0.1 metric');
  }
  if (metrics[expectedMutationMetric].mutation.passed) {
    throw new Error(`mutation must turn ${expectedMutationMetric} red`);
  }
  for (const metricKey of BENCHMARK_METRIC_KEYS) {
    if (
      metricKey !== expectedMutationMetric &&
      !metrics[metricKey].mutation.passed
    ) {
      throw new Error(`mutation must keep undeclared metric ${metricKey} green`);
    }
  }

  return {
    testedHeadSha,
    experiments: {
      baseline: baselineIndex.experimentId,
      mutation: mutationIndex.experimentId,
    },
    exampleIds: baselineIndex.exampleIds,
    metrics,
  };
}

import { isDeepStrictEqual } from 'node:util';

import {
  BENCHMARK_METRIC_KEYS,
  type BenchmarkEvaluation,
  type BenchmarkExperiment,
  type BenchmarkMetricKey,
  type BenchmarkRecord,
} from './benchmark-evaluation.js';
import {
  BEHAVIOR_METRIC_KEYS,
  type BehaviorMetricKey,
} from './behavior-evaluators.js';

/**
 * Every metric this gate compares — the v0.1 three plus every declared
 * behavior metric.
 *
 * DERIVED from the two canonical arrays rather than listed again, so a new
 * entry in either one reaches the comparison with no edit here. A canonical
 * metric nothing emits reddens benchmark-evaluation.test.mjs › "compares
 * exactly the union of the v0.1 and the behavior metric keys"; a key added
 * HERE and nowhere else does not reach that test at all — `tsc` refuses it
 * first. Both directions are covered by `npm run check`, not by the one test.
 *
 * A second hand-written list here would be a copy that drifts, and the
 * drifting copy is the one nobody is looking at.
 */
export const GATE_METRIC_KEYS = [
  ...BENCHMARK_METRIC_KEYS,
  ...BEHAVIOR_METRIC_KEYS,
] as const;

export type GateMetricKey = BenchmarkMetricKey | BehaviorMetricKey;

const isBehaviorMetricKey = (key: GateMetricKey): key is BehaviorMetricKey =>
  (BEHAVIOR_METRIC_KEYS as readonly string[]).includes(key);

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
  // One entry per metric, each keeping its own per-example failures. There is
  // deliberately no aggregate anywhere in this proof: one number standing for
  // every metric is exactly the thing that lets a red example read as green.
  readonly metrics: Readonly<Record<GateMetricKey, BenchmarkMetricGate>>;
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

/**
 * Is this behavior metric recorded for this example?
 *
 * Behavior metrics are CONDITIONAL: `evaluateBenchmarkRecord` emits each one
 * only where the scenario's ground truth asks the question it answers, so an
 * absent metric is the normal shape of an example the question does not apply
 * to — never a missing measurement.
 *
 * 🔴 **An OWN-property read, and the whole presence check rests on it.** A
 * prototype-chain read would let one entry on `Object.prototype` answer yes for
 * every example, so a mutation that DROPPED a metric would compare as though it
 * still declared it — the regression this gate exists to catch, returning a
 * passing proof. Spelled `Object.hasOwn` to match
 * `benchmark-evaluation.ts`, and pinned by benchmark-evaluation.test.mjs ›
 * "refuses a dropped behavior metric that only the prototype declares".
 */
function declaresBehaviorMetric(
  experiment: IndexedExperiment,
  exampleId: string,
  metricKey: BehaviorMetricKey,
): boolean {
  const behaviorMetrics = experiment.resultsByExampleId.get(exampleId)?.behaviorMetrics;
  return behaviorMetrics !== undefined && Object.hasOwn(behaviorMetrics, metricKey);
}

/**
 * Gate one behavior metric across the examples that declare it.
 *
 * 🔴 **Presence is compared before scores are.** A metric the baseline declares
 * for an example and the mutation does not is refused, and so is the reverse.
 * Without that, the cheapest way to pass this gate with a behavior regression
 * is to stop emitting the metric: absent would read as "not applicable here"
 * and the red score would leave the comparison entirely. That is the failure
 * this whole item exists to close, so it is a refusal rather than a skip —
 * see benchmark-evaluation.test.mjs › "rejects a behavior metric the mutation
 * stops declaring" and › "rejects a behavior metric only the mutation
 * declares".
 *
 * A metric NEITHER side declares gates nothing and fails nothing: it passes
 * vacuously, which is what keeps an accepted v0.1 experiment — which declares
 * no behavior metric at all — comparable under its own contract
 * (› "treats a behavior metric neither experiment declares as inert").
 */
function gateBehaviorMetric(
  baseline: IndexedExperiment,
  mutation: IndexedExperiment,
  metricKey: BehaviorMetricKey,
  requiredScore: number,
): Readonly<{ baseline: BenchmarkGateResult; mutation: BenchmarkGateResult }> {
  requireMetricScore(requiredScore);

  const baselineFailing: string[] = [];
  const mutationFailing: string[] = [];

  for (const exampleId of baseline.exampleIds) {
    const inBaseline = declaresBehaviorMetric(baseline, exampleId, metricKey);
    const inMutation = declaresBehaviorMetric(mutation, exampleId, metricKey);
    if (inBaseline !== inMutation) {
      throw new Error(
        `baseline and mutation must declare ${metricKey} for the same examples: ` +
          `${exampleId} declares it in the ${inBaseline ? 'baseline' : 'mutation'} only`,
      );
    }
    if (!inBaseline) continue;

    for (const [experiment, failing] of [
      [baseline, baselineFailing],
      [mutation, mutationFailing],
    ] as const) {
      const metric = experiment.resultsByExampleId.get(exampleId)
        ?.behaviorMetrics[metricKey];
      if (metric === undefined || metric.key !== metricKey) {
        throw new Error(`benchmark result is missing metric: ${metricKey}`);
      }
      requireMetricScore(metric.score);
      if (metric.score !== requiredScore) failing.push(exampleId);
    }
  }

  return {
    baseline: {
      passed: baselineFailing.length === 0,
      failingExampleIds: baselineFailing,
    },
    mutation: {
      passed: mutationFailing.length === 0,
      failingExampleIds: mutationFailing,
    },
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
  // Every key of the union. ⚠ The record type is not what enforces that:
  // this function has no TypeScript caller — it is off the public @aic/evals
  // surface and reached from an untyped .mjs suite through the compiled dist —
  // so the loop below is what actually refuses an incomplete set, pinned by
  // benchmark-evaluation.test.mjs › "rejects expected scores that omit a
  // declared behavior metric".
  expectedScores: Readonly<Record<GateMetricKey, number>>;
  expectedMutationMetric: GateMetricKey;
}>): BenchmarkRegressionProof {
  if (!/^[0-9a-f]{40}$/i.test(testedHeadSha)) {
    throw new Error('testedHeadSha must be a full Git commit SHA');
  }
  if (!(GATE_METRIC_KEYS as readonly string[]).includes(expectedMutationMetric)) {
    throw new Error(
      'expected mutation metric must be a declared benchmark or behavior metric',
    );
  }
  // Refused here rather than where the score is used: `requireMetricScore`
  // would also throw on the `undefined`, but from inside one metric's gate and
  // without naming which metric was never declared.
  for (const metricKey of GATE_METRIC_KEYS) {
    if (expectedScores[metricKey] === undefined) {
      throw new Error(`expected scores must declare every metric: ${metricKey}`);
    }
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
    GATE_METRIC_KEYS.map((metricKey) => {
      const requiredScore = expectedScores[metricKey];
      if (isBehaviorMetricKey(metricKey)) {
        return [
          metricKey,
          {
            requiredScore,
            ...gateBehaviorMetric(
              baselineIndex,
              mutationIndex,
              metricKey,
              requiredScore,
            ),
          },
        ];
      }
      return [
        metricKey,
        {
          requiredScore,
          baseline: gateMetric(baselineIndex, metricKey, requiredScore),
          mutation: gateMetric(mutationIndex, metricKey, requiredScore),
        },
      ];
    }),
  ) as Record<GateMetricKey, BenchmarkMetricGate>;

  if (GATE_METRIC_KEYS.some((metricKey) => !metrics[metricKey].baseline.passed)) {
    throw new Error('baseline must pass every metric');
  }
  if (metrics[expectedMutationMetric].mutation.passed) {
    throw new Error(`mutation must turn ${expectedMutationMetric} red`);
  }
  for (const metricKey of GATE_METRIC_KEYS) {
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

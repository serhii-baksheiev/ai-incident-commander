import {
  MODEL_API_KEY_VARIABLE,
  requireModelConfig,
  type ModelUsageTotals,
} from '@aic/roles';

import {
  BENCHMARK_METRIC_KEYS,
  createFinalEvaluationBenchmarkPlan,
  type BenchmarkExperiment,
  type BenchmarkVersions,
} from './benchmark-evaluation.js';
import { BEHAVIOR_METRIC_KEYS } from './behavior-evaluators.js';
import { BENCHMARK_SCENARIO_PARTITIONS } from './replay-scenarios.js';
import type { GateMetricKey } from './benchmark-regression-gate.js';

/**
 * The bounded live-model evaluation lane.
 *
 * ## What it is for
 *
 * Two arms over ONE corpus, at ONE commit, in ONE process: a SCRIPTED control
 * arm and a MODEL arm. Reported separately, never merged. That separation is the
 * whole point of the lane — without a control arm, a metric that moved could be
 * the model getting worse or the harness changing underneath it, and those two
 * findings have opposite remedies.
 * see live-model-lane.test.mjs › "reports a moved control arm as a harness
 * regression and withholds the model numbers"
 *
 * ## The corpus is the accepted hold-out policy, not a new one
 *
 * The plan comes from `createFinalEvaluationBenchmarkPlan`, which derives its
 * scenarios from `BENCHMARK_SCENARIO_PARTITIONS` and REFUSES caller-supplied
 * ones. This module builds no second partition and takes none.
 *
 * ## 🔴 What this lane cannot demonstrate in this repository
 *
 * There is no provider credential in this environment. Every test of this module
 * drives injected arms, so nothing here has ever executed a model. The lane is
 * built so that it runs the moment a key exists; it is not evidence that it has.
 * The credential-absent path is the part that IS demonstrated:
 * see live-model-lane.test.mjs › "refuses the lane with the named variable and
 * touches nothing when no credential is set"
 *
 * ## Limits
 *
 *   - **No retry on a publication refusal.** LangSmith ingestion can refuse a
 *     write — an exhausted tenant quota is one way — and a refused publication
 *     PROPAGATES here: a lane that retried until it succeeded would report a
 *     published experiment that was never published.
 *     see live-model-lane.test.mjs › "reports a publication refusal as a failure
 *     rather than as a published lane"
 *   - **`publish` is optional**, so the lane produces its per-metric evidence
 *     locally with no LangSmith involvement at all.
 *   - **The control baseline is declared, not discovered.** With none, the lane
 *     runs and reports, and marks the model arm unreportable — it cannot tell a
 *     harness move from a model move without one.
 *     see live-model-lane.test.mjs › "refuses to report model quality when no
 *     control baseline was declared"
 *   - 🔴 **The control arm's sensitivity is the sensitivity of whatever nodes
 *     the caller passes as the control, and the one this repository wires up is
 *     at the floor on EVERY metric it emits.** Measured, not counted: the
 *     replay-backed control scores a single value of zero on all six, and zero
 *     is the worst score for five of them. So the control arm can catch a
 *     harness change that moves a metric UP or that stops emitting one, and it
 *     cannot catch one that pushes any metric further down — there is no
 *     further down. Read every `harness-regression` verdict as covering that
 *     first direction only.
 *     see live-model-lane.test.mjs › "measures the harness zero that makes
 *     evidence_coverage unreportable"
 */

/** Runs per scenario, at the plan's own minimum. */
export const LIVE_MODEL_LANE_RUNS_PER_SCENARIO = 3 as const;

/**
 * The run cap for ONE arm, derived from the accepted partition rather than typed
 * beside it: a scenario added to the hold-out policy raises this cap with it,
 * and a hand-written number would have silently capped the new scenario out.
 * see live-model-lane.test.mjs › "publishes the two caps it runs under rather
 * than leaving them implicit"
 */
export const LIVE_MODEL_LANE_MAX_MODEL_RUNS =
  (BENCHMARK_SCENARIO_PARTITIONS.calibration.length +
    BENCHMARK_SCENARIO_PARTITIONS.holdout.length) *
  LIVE_MODEL_LANE_RUNS_PER_SCENARIO;

/**
 * The completion cap for ONE lane execution, spent through the usage ledger.
 *
 * Five completions per run times the run cap: one `generate_hypotheses`, plus
 * headroom for the graph's evidence loop and its challenge rounds, each of which
 * re-enters a model-backed role.
 *
 * It is a CEILING chosen to bound spend, not a forecast of it, and nothing here
 * claims a run costs five. The ledger refuses the call that would cross the
 * total, so a run that turns out to need more STOPS rather than spending past
 * the bound — which is the property that makes this number safe to pick without
 * having measured a live run.
 * see roles-port-contract.test.mjs › "stops at the declared call cap before
 * issuing the request"
 */
export const LIVE_MODEL_LANE_MAX_MODEL_CALLS =
  LIVE_MODEL_LANE_MAX_MODEL_RUNS * 5;

/**
 * The metric this lane refuses to publish as model quality, and why.
 *
 * `evaluateEvidenceCoverage` compares an exact `[kind, source, predicate]`
 * triple, where the expected `predicate` is hand-written ground-truth prose and
 * the observed one is a fixture evidence `statement`. Those two strings are
 * never equal in this corpus, so ANY graph-executed run scores
 * `evidence_coverage = 0` for a harness reason that has nothing to do with the
 * model. Publishing that zero beside model metrics would be exactly the
 * harness-vs-model confound this lane exists to prevent, so it is withheld from
 * BOTH arms with the reason attached.
 *
 * This is a real pre-existing defect in the evaluator, filed separately and out
 * of scope here. Withholding is not a fix: the day the fingerprints are made
 * comparable, this entry is deleted and the metric reports normally.
 * see live-model-lane.test.mjs › "withholds evidence_coverage from model quality
 * and says why"
 * see live-model-lane.test.mjs › "measures the harness zero that makes
 * evidence_coverage unreportable"
 */
export const LIVE_MODEL_LANE_WITHHELD_METRICS: Readonly<
  Partial<Record<GateMetricKey, string>>
> = Object.freeze({
  evidence_coverage:
    'withheld: evidence_coverage compares the ground truth predicate against the evidence statement as an exact fingerprint, and those strings never match in this corpus, so a graph-executed run scores zero for a harness reason rather than a model one',
});

const COMPARED_METRIC_KEYS: readonly GateMetricKey[] = [
  ...BENCHMARK_METRIC_KEYS,
  ...BEHAVIOR_METRIC_KEYS,
];

export interface LiveModelLanePlan {
  readonly scenarioSet: 'final-evaluation';
  readonly runsPerScenario: number;
  readonly metadata: BenchmarkVersions;
}

export interface LiveModelLaneMetric {
  readonly key: GateMetricKey;
  readonly mean: number;
  readonly exampleCount: number;
}

export type LiveModelLaneMetrics = Readonly<
  Partial<Record<GateMetricKey, LiveModelLaneMetric>>
>;

export interface LiveModelLaneControlArm {
  readonly arm: 'scripted-control';
  readonly metrics: LiveModelLaneMetrics;
  /** What this arm scored, in the shape a baseline is declared in. */
  readonly observedBaseline: Readonly<Partial<Record<GateMetricKey, number>>>;
  /** Every metric whose mean differs from the declared baseline. */
  readonly movedMetrics: readonly GateMetricKey[];
}

export interface LiveModelLaneModelArm {
  readonly arm: 'model';
  readonly metrics: LiveModelLaneMetrics;
  readonly reportable: boolean;
  readonly unreportableReason?: string;
  readonly usage?: ModelUsageTotals;
}

export type LiveModelLaneVerdict =
  | 'model-quality'
  | 'harness-regression'
  | 'control-baseline-undeclared';

export interface LiveModelLaneReport {
  readonly headSha: string;
  readonly experimentId: string;
  readonly credential: Readonly<{ variable: string; provider: string; modelId: string }>;
  readonly plan: LiveModelLanePlan;
  readonly caps: Readonly<{ maxModelRuns: number; maxModelCalls: number }>;
  readonly exampleIds: readonly string[];
  readonly arms: Readonly<{
    control: LiveModelLaneControlArm;
    model: LiveModelLaneModelArm;
  }>;
  readonly withheld: Readonly<Partial<Record<GateMetricKey, string>>>;
  readonly verdict: LiveModelLaneVerdict;
}

export interface LiveModelLaneOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly experimentId: string;
  /** The exact commit both arms ran at — a comparison across commits is none. */
  readonly headSha: string;
  readonly runsPerScenario?: number;
  readonly metadata: BenchmarkVersions;
  readonly controlBaseline?: Readonly<Partial<Record<GateMetricKey, number>>>;
  runControlArm(plan: LiveModelLanePlan): Promise<BenchmarkExperiment>;
  runModelArm(plan: LiveModelLanePlan): Promise<BenchmarkExperiment>;
  /** Read AFTER the model arm, from the ledger the runner owns. */
  modelUsage?(): ModelUsageTotals;
  publish?(report: LiveModelLaneReport): Promise<void>;
}

function metricScores(
  experiment: BenchmarkExperiment,
): Map<GateMetricKey, number[]> {
  const scores = new Map<GateMetricKey, number[]>();
  for (const result of experiment.results) {
    for (const key of COMPARED_METRIC_KEYS) {
      const metric =
        key in result.metrics
          ? (result.metrics as Record<string, { score: number }>)[key]
          : (result.behaviorMetrics as Record<string, { score: number } | undefined>)[key];
      if (metric === undefined) continue;
      const bucket = scores.get(key) ?? [];
      bucket.push(metric.score);
      scores.set(key, bucket);
    }
  }
  return scores;
}

/**
 * Per-metric means, one entry per metric and nothing that stands for all of
 * them. Withheld metrics never enter the result at all, so no caller can read
 * one off the report by accident.
 */
function summarize(experiment: BenchmarkExperiment): LiveModelLaneMetrics {
  const summary: Record<string, LiveModelLaneMetric> = {};
  for (const [key, scores] of metricScores(experiment)) {
    if (key in LIVE_MODEL_LANE_WITHHELD_METRICS) continue;
    const total = scores.reduce((sum, score) => sum + score, 0);
    summary[key] = {
      key,
      mean: total / scores.length,
      exampleCount: scores.length,
    };
  }
  return summary;
}

function baselineOf(
  metrics: LiveModelLaneMetrics,
): Record<string, number> {
  const observed: Record<string, number> = {};
  for (const metric of Object.values(metrics)) {
    if (metric !== undefined) observed[metric.key] = metric.mean;
  }
  return observed;
}

/**
 * Which declared control metrics moved — including the ones that vanished.
 *
 * 🔴 **Presence is compared before scores are, in both directions.** The first
 * version of this walked the metrics the control arm HAPPENED TO EMIT and asked
 * whether the baseline disagreed, so a metric the baseline declares and the arm
 * stopped producing was never visited: the harness had moved, `movedMetrics`
 * was empty, and the model arm was published as reportable on that basis.
 *
 * That is the same defect `benchmark-regression-gate.ts` refuses one layer
 * along — "the cheapest way to pass this gate with a behavior regression is to
 * stop emitting the metric" — which AIC-81 turned from a skip into a refusal.
 * Reintroducing it in the lane whose whole purpose is telling a harness
 * regression from a model one would have been the worst place for it.
 *
 * A key the baseline declares that this lane does not compare is REFUSED rather
 * than ignored, because a baseline pinning a metric nobody reads is a baseline
 * that cannot fail.
 * see live-model-lane.test.mjs › "treats a declared control metric the arm
 * stopped emitting as a move, not as a match" and › "refuses a control baseline
 * naming a metric this lane does not compare"
 */
function movesAgainst(
  declared: Readonly<Partial<Record<GateMetricKey, number>>>,
  observed: Record<string, number>,
): GateMetricKey[] {
  const comparable = new Set<string>(COMPARED_METRIC_KEYS);
  const unknown = Object.keys(declared).filter(
    (key) => !comparable.has(key) || key in LIVE_MODEL_LANE_WITHHELD_METRICS,
  );
  if (unknown.length > 0) {
    throw new Error(
      `the control baseline declares metrics this lane does not compare: ${unknown.sort().join(', ')}`,
    );
  }

  const moved: GateMetricKey[] = [];
  for (const key of Object.keys(declared) as GateMetricKey[]) {
    const expected = declared[key];
    if (expected === undefined) continue;
    if (!Object.hasOwn(observed, key)) {
      moved.push(key);
      continue;
    }
    if (observed[key] !== expected) moved.push(key);
  }
  return moved.sort();
}

function exampleIdsOf(experiment: BenchmarkExperiment): string[] {
  return experiment.records.map(({ exampleId }) => exampleId).sort();
}

/**
 * Run the lane.
 *
 * Order is load-bearing: the credential is required and the caps are checked
 * BEFORE either arm is invoked, so an unconfigured or over-budget lane creates
 * no dataset, no project and no run.
 */
export async function runLiveModelLane(
  options: LiveModelLaneOptions,
): Promise<LiveModelLaneReport> {
  const config = requireModelConfig(options.env);

  const runsPerScenario =
    options.runsPerScenario ?? LIVE_MODEL_LANE_RUNS_PER_SCENARIO;
  const scenarioCount =
    BENCHMARK_SCENARIO_PARTITIONS.calibration.length +
    BENCHMARK_SCENARIO_PARTITIONS.holdout.length;
  const plannedRuns = scenarioCount * runsPerScenario;
  if (plannedRuns > LIVE_MODEL_LANE_MAX_MODEL_RUNS) {
    throw new Error(
      `live model lane run cap exceeded: ${plannedRuns} runs requested, cap is ${LIVE_MODEL_LANE_MAX_MODEL_RUNS}`,
    );
  }

  const plan: LiveModelLanePlan = {
    scenarioSet: 'final-evaluation',
    runsPerScenario,
    metadata: options.metadata,
  };
  // Built here as well as inside each arm, so the lane knows the corpus it is
  // comparing over rather than inferring it from whichever arm answered first.
  const declaredExampleIds = createFinalEvaluationBenchmarkPlan({
    experimentId: options.experimentId,
    runsPerScenario,
    metadata: options.metadata,
  })
    .map(({ exampleId }) => exampleId)
    .sort();

  const control = await options.runControlArm(plan);
  const model = await options.runModelArm(plan);

  const controlExampleIds = exampleIdsOf(control);
  const modelExampleIds = exampleIdsOf(model);
  if (
    controlExampleIds.join('|') !== modelExampleIds.join('|') ||
    controlExampleIds.join('|') !== declaredExampleIds.join('|')
  ) {
    throw new Error(
      'the control and model arms must cover the same examples as the declared plan: a comparison across two corpora is not a comparison',
    );
  }

  const controlMetrics = summarize(control);
  const observedBaseline = baselineOf(controlMetrics);
  const declaredBaseline = options.controlBaseline;
  const movedMetrics =
    declaredBaseline === undefined ? [] : movesAgainst(declaredBaseline, observedBaseline);

  let verdict: LiveModelLaneVerdict = 'model-quality';
  let unreportableReason: string | undefined;
  if (declaredBaseline === undefined) {
    verdict = 'control-baseline-undeclared';
    unreportableReason =
      'no control baseline was declared, so a metric that moved cannot be attributed to the model rather than to the harness';
  } else if (movedMetrics.length > 0) {
    verdict = 'harness-regression';
    unreportableReason = `the scripted control arm moved against its own baseline (${movedMetrics.join(', ')}), so the regression is in the harness and the model arm's numbers are not reportable`;
  }

  const usage = options.modelUsage?.();
  const report: LiveModelLaneReport = {
    headSha: options.headSha,
    experimentId: options.experimentId,
    credential: {
      variable: MODEL_API_KEY_VARIABLE,
      provider: config.provider,
      modelId: config.modelId,
    },
    plan,
    caps: {
      maxModelRuns: LIVE_MODEL_LANE_MAX_MODEL_RUNS,
      maxModelCalls: LIVE_MODEL_LANE_MAX_MODEL_CALLS,
    },
    exampleIds: declaredExampleIds,
    arms: {
      control: {
        arm: 'scripted-control',
        metrics: controlMetrics,
        observedBaseline,
        movedMetrics,
      },
      model: {
        arm: 'model',
        metrics: summarize(model),
        reportable: unreportableReason === undefined,
        ...(unreportableReason === undefined ? {} : { unreportableReason }),
        ...(usage === undefined ? {} : { usage }),
      },
    },
    withheld: LIVE_MODEL_LANE_WITHHELD_METRICS,
    verdict,
  };

  // Never wrapped in a retry and never swallowed: a refused publication is a
  // failed lane, not a lane that published.
  await options.publish?.(report);
  return report;
}

import { isDeepStrictEqual } from 'node:util';

import {
  MODEL_API_KEY_VARIABLE,
  requireModelConfig,
  type ModelUsageTotals,
} from '@aic/roles';

import { METRIC_BEST_VALUES } from './arm-answer.js';
import {
  BENCHMARK_METRIC_KEYS,
  createCalibrationBenchmarkPlan,
  createFinalEvaluationBenchmarkPlan,
  type BenchmarkExperiment,
  type BenchmarkVersions,
  type NotApplicableMetrics,
} from './benchmark-evaluation.js';
import { BEHAVIOR_METRIC_KEYS, STRUCTURAL_EVALUATOR_VERSION } from './behavior-evaluators.js';
import { BENCHMARK_BUDGET_POLICY } from './budget-policy.js';
import { BENCHMARK_SCENARIO_PARTITIONS } from './replay-scenarios.js';
import type { GateMetricKey } from './benchmark-regression-gate.js';

/**
 * The bounded live-model evaluation lane.
 *
 * ## What it is for
 *
 * Four arms over ONE corpus, at ONE commit, in ONE process: a SCRIPTED control
 * arm, an OPTIONAL oracle positive control, an OPTIONAL naive single-shot arm,
 * and the MODEL (graph) arm. Reported separately, never merged. The
 * control/model separation is the whole point of the lane — without a control
 * arm, a metric that moved could be the model getting worse or the harness
 * changing underneath it, and those two findings have opposite remedies.
 * see live-model-lane.test.mjs › "reports a moved control arm as a harness regression and marks the model numbers unreportable"
 * ⚠ MARKS, not withholds: `arms.model.metrics` still carries every model mean
 * on that verdict and only `reportable` flips. The `--publish` path is what
 * gates on it, so nothing reaches LangSmith — but a consumer reading
 * `metrics` without checking `reportable` gets numbers an earlier wording
 * here said were withheld. Corrected at the AIC-94 gate.
 *
 * Oracle and naive are declared through `runOracleArm`/`runNaiveArm`, both
 * optional. This slice (AIC-117a) defines their report shape and the
 * comparisons they unlock; wiring a real oracle or naive port into the
 * shipped scripts is a later slice.
 * see four-arm-lane.test.mjs › "still returns not-run oracle and naive arms, with model and control unchanged apart from the new fields, when the caller supplies only the two original arms"
 *
 * ## The corpus is the accepted hold-out policy, not a new one
 *
 * The plan comes from `createFinalEvaluationBenchmarkPlan`, which derives its
 * scenarios from `BENCHMARK_SCENARIO_PARTITIONS` and REFUSES caller-supplied
 * ones. This module builds no second partition and takes none.
 *
 * ## 🔴 What this lane's TESTS cannot demonstrate
 *
 * Every test of this module drives injected arms, so no test here executes a
 * model and a green suite is not evidence that a real model's output satisfies
 * the domain schemas.
 *
 * ⚠ **This paragraph used to say "nothing here has ever executed a model", and
 * that stopped being true.** A model has since executed these roles: the
 * committed records under `docs/evidence/final-evaluation/` carry the calls. The
 * sentence survived because nothing edited this file, so nothing rechecked it —
 * found by `prose-reviewer` at the AIC-19 gate, in the same round that found two
 * more copies of it elsewhere. The claim that holds is about the SUITE, not about
 * the repository.
 * The credential-absent path is the part that IS demonstrated:
 * see live-model-lane.test.mjs › "refuses the lane with the named variable and touches nothing when no credential is set"
 *
 * ## Limits
 *
 *   - **No retry on a publication refusal.** LangSmith ingestion can refuse a
 *     write — an exhausted tenant quota is one way — and a refused publication
 *     PROPAGATES here: a lane that retried until it succeeded would report a
 *     published experiment that was never published.
 *     see live-model-lane.test.mjs › "reports a publication refusal as a failure rather than as a published lane"
 *   - **`publish` is optional**, so the lane produces its per-metric evidence
 *     locally with no LangSmith involvement at all.
 *   - **The control baseline is declared, not discovered.** With none, the lane
 *     runs and reports, and marks the model arm unreportable — it cannot tell a
 *     harness move from a model move without one.
 *     see live-model-lane.test.mjs › "refuses to report model quality when no control baseline was declared"
 *   - 🔴 **The control arm's sensitivity is the sensitivity of whatever nodes
 *     the caller passes as the control, and the one this repository wires up is
 *     at the floor on EVERY metric it emits.** Measured, not counted: the
 *     replay-backed control scores a single value of zero on all six, and zero
 *     is the worst score for five of them. So the control arm can catch a
 *     harness change that moves a metric UP or that stops emitting one, and it
 *     cannot catch one that pushes any metric further down — there is no
 *     further down. Read every `harness-regression` verdict as covering that
 *     first direction only.
 *     see live-model-lane.test.mjs › "measures the harness zero that makes evidence_coverage unreportable"
 */

/** Runs per scenario, at the plan's own minimum. */
export const LIVE_MODEL_LANE_RUNS_PER_SCENARIO = 3 as const;

/**
 * The run cap for ONE arm, derived from the accepted partition rather than typed
 * beside it: a scenario added to the hold-out policy raises this cap with it,
 * and a hand-written number would have silently capped the new scenario out.
 * see live-model-lane.test.mjs › "publishes every cap a run is under rather than leaving one implicit"
 */
export const LIVE_MODEL_LANE_MAX_MODEL_RUNS =
  (BENCHMARK_SCENARIO_PARTITIONS.calibration.length +
    BENCHMARK_SCENARIO_PARTITIONS.holdout.length) *
  LIVE_MODEL_LANE_RUNS_PER_SCENARIO;

/**
 * The graph arm's completion ceiling for ONE run, read off the budget policy:
 * one `generate_hypotheses`, one `interpret_residual_evidence` per iteration,
 * and per challenge round two — `challenge_hypothesis`, then the
 * `interpret_residual_evidence` its edge leads back to through
 * `execute_investigation` (`packages/graph/src/investigation.ts`, the
 * `challenge_hypothesis` edge). A ceiling for the ledger, not a forecast.
 * see four-arm-lane.test.mjs › "derives the per-run and total model-call caps from the budget policy and the partition lengths"
 */
export const LIVE_MODEL_LANE_GRAPH_MODEL_CALLS_PER_RUN =
  1 +
  BENCHMARK_BUDGET_POLICY.maxIterations +
  2 * BENCHMARK_BUDGET_POLICY.reservedChallengeBudget;

/**
 * The naive arm's completion budget for ONE run: a single prompt, a single
 * completion, no iteration and no challenge round.
 * see four-arm-lane.test.mjs › "derives the per-run and total model-call caps from the budget policy and the partition lengths"
 */
export const LIVE_MODEL_LANE_NAIVE_MODEL_CALLS_PER_RUN = 1 as const;

/**
 * The completion cap for ONE lane execution, spent through the usage ledger:
 * every run pays for both a graph-arm run and a naive-arm run.
 *
 * It is a CEILING chosen to bound spend, not a forecast of it, and nothing here
 * claims a run costs this much. The ledger refuses the call that would cross the
 * total, so a run that turns out to need more STOPS rather than spending past
 * the bound — which is the property that makes this number safe to pick without
 * having measured a live run.
 * see roles-port-contract.test.mjs › "stops at the declared call cap before issuing the request"
 */
export const LIVE_MODEL_LANE_MAX_MODEL_CALLS =
  LIVE_MODEL_LANE_MAX_MODEL_RUNS *
  (LIVE_MODEL_LANE_GRAPH_MODEL_CALLS_PER_RUN + LIVE_MODEL_LANE_NAIVE_MODEL_CALLS_PER_RUN);

/**
 * The OUTPUT-TOKEN cap for one lane execution — a second bound, because the
 * first one counts the wrong thing.
 *
 * `LIVE_MODEL_LANE_MAX_MODEL_CALLS` bounds completions. It does not bound spend:
 * the per-call token budget sits underneath it and moved, from 4096 to 16000, in
 * the change that raised it for a real reason. Worst case under the call cap
 * alone went from roughly 614k to 2.4M output tokens, and nothing tracked the
 * quantity that had changed.
 *
 * The number is a CEILING chosen to bound a RUNAWAY run, not a forecast of a
 * normal one, and no figure for its margin is written here. Two earlier versions
 * of this comment got that wrong in different ways: the first named a run that
 * was not the largest and derived a factor that did not follow, and the second
 * compared the ceiling against a recorded TOTAL — which is the wrong comparison
 * for a cap that throws MID-RUN: a recorded run can finish inside the call cap
 * and still cost more than a ceiling chosen to clear its TOTAL. No figure for
 * the largest recorded run is written here — the version that named one was
 * already false when it was written, refuted by a record this same branch had
 * committed earlier.
 *
 * What has to hold is that a legitimate full-length run finishes. That is
 * MEASURED against the committed evidence — the heaviest per-call rate on record,
 * projected over the call cap — so it cannot drift as runs are added, and it
 * reddens if a future run approaches the ceiling.
 * see final-evaluation-command.test.mjs › "leaves the output-token ceiling above every live run this repository has recorded"
 *
 * A run that needs more STOPS at the next reservation rather than spending past
 * the bound — the same property that makes the call cap safe to pick.
 * see roles-port-contract.test.mjs › "stops reserving once the declared output-token budget is spent, not only once the calls are"
 */
// Raised with the derived call cap (owner decision, 2026-09-24).
// see four-arm-lane.test.mjs › "sets the output-token ceiling at the raised bound (owner decision 2026-09-24)"
export const LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS = 1_200_000;

/**
 * The report schema version, carried as `schemaVersion` on every report. The
 * committed v1 reports under `docs/evidence/final-evaluation` carry none;
 * nothing here reads them.
 * see four-arm-lane.test.mjs › "carries the report schema version as an own property, at the exported value"
 */
export const LIVE_MODEL_LANE_REPORT_SCHEMA_VERSION = 2 as const;

/**
 * The metric this lane refuses to publish as model quality under the accepted
 * `behavior-evaluators-v0.2` evaluator, and why.
 *
 * Under that version, `evaluateEvidenceCoverage` compares an exact `[kind,
 * source, predicate]` triple, where the expected `predicate` is hand-written
 * ground-truth prose and the observed one is a fixture evidence `statement`.
 * Those two strings are never equal in this corpus, so ANY graph-executed run
 * scored under that version scores `evidence_coverage = 0` for a harness
 * reason that has nothing to do with the model. `behavior-evaluators-v0.3`
 * matches by evidence id instead, and under that version this lane reports
 * `evidence_coverage` rather than withholding it.
 * see four-arm-lane.test.mjs › "reports evidence_coverage under behavior-evaluators-v0.3, with withheld empty"
 *
 * This is a real pre-existing defect in the v0.2 evaluator, filed separately
 * and out of scope here. Withholding is not a fix for a record still declaring
 * that version.
 * see live-model-lane.test.mjs › "withholds evidence_coverage from model quality and says why"
 * see live-model-lane.test.mjs › "measures the harness zero that makes evidence_coverage unreportable"
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

/** The two corpora a lane may declare. There is no third, and no default. */
export type LiveModelLaneScenarioSet = 'calibration' | 'final-evaluation';

export interface LiveModelLanePlan {
  readonly scenarioSet: LiveModelLaneScenarioSet;
  readonly runsPerScenario: number;
  readonly metadata: BenchmarkVersions;
}

/** One metric's per-scenario scores, in run order, and their mean. */
export interface LiveModelLanePerScenarioMetric {
  readonly scores: readonly number[];
  readonly mean: number;
  /** `unsupported_claim_rate` only: claims counted per run, in run order. */
  readonly claimCounts?: readonly number[];
}

export interface LiveModelLaneMetric {
  readonly key: GateMetricKey;
  readonly mean: number;
  readonly exampleCount: number;
  readonly perScenario: Readonly<Record<string, LiveModelLanePerScenarioMetric>>;
  /** `unsupported_claim_rate` only: claims counted, summed over every run. */
  readonly claimCount?: number;
}

export type LiveModelLaneMetrics = Readonly<
  Partial<Record<GateMetricKey, LiveModelLaneMetric>>
>;

export interface LiveModelLaneControlArm {
  readonly arm: 'scripted-control';
  /** Always completed: a control arm that throws aborts the lane instead. */
  readonly status: 'completed';
  readonly metrics: LiveModelLaneMetrics;
  /** What this arm scored, in the shape a baseline is declared in. */
  readonly observedBaseline: Readonly<Partial<Record<GateMetricKey, number>>>;
  /** Every metric whose mean differs from the declared baseline. */
  readonly movedMetrics: readonly GateMetricKey[];
}

/** The shape of an arm the caller did not supply: not run, and never scored. */
export interface LiveModelLaneArmNotRun<Arm extends string> {
  readonly arm: Arm;
  readonly status: 'not-run';
  readonly reason: string;
}

export interface LiveModelLaneOracleArmCompleted {
  readonly arm: 'oracle';
  readonly status: 'completed';
  readonly metrics: LiveModelLaneMetrics;
  readonly notApplicable?: NotApplicableMetrics;
}

/**
 * The oracle never carries a `refused` state: a throw from `runOracleArm`
 * propagates out of the lane instead, because a positive control that cannot
 * run is a harness defect rather than a measurement.
 * see four-arm-lane.test.mjs › "throws when the oracle arm throws, and never invokes naive or model"
 */
export type LiveModelLaneOracleArm =
  | LiveModelLaneArmNotRun<'oracle'>
  | LiveModelLaneOracleArmCompleted;

export interface LiveModelLaneNaiveArmRefused {
  readonly arm: 'naive';
  readonly status: 'refused';
  readonly refusalReason: string;
  readonly reportable: false;
  readonly model: Readonly<{ provider: string; modelId: string }>;
  readonly usage?: ModelUsageTotals;
}

export interface LiveModelLaneNaiveArmCompleted {
  readonly arm: 'naive';
  readonly status: 'completed';
  readonly metrics: LiveModelLaneMetrics;
  readonly reportable: boolean;
  readonly unreportableReason?: string;
  readonly notApplicable?: NotApplicableMetrics;
  readonly model: Readonly<{ provider: string; modelId: string }>;
  readonly usage?: ModelUsageTotals;
}

export type LiveModelLaneNaiveArm =
  | LiveModelLaneArmNotRun<'naive'>
  | LiveModelLaneNaiveArmRefused
  | LiveModelLaneNaiveArmCompleted;

export interface LiveModelLaneModelArm {
  readonly arm: 'model';
  readonly status: 'completed' | 'refused';
  /**
   * ⚠ ABSENT when the arm refused, never zeroed. An arm that produced no score
   * did not score zero on six axes, and six zeroes read as a model that
   * answered badly rather than one that did not answer.
   * see live-model-lane.test.mjs › "records a model arm that refused as unreportable rather than losing the run"
   */
  readonly metrics?: LiveModelLaneMetrics;
  readonly reportable: boolean;
  readonly unreportableReason?: string;
  readonly notApplicable?: NotApplicableMetrics;
  readonly model: Readonly<{ provider: string; modelId: string }>;
  readonly usage?: ModelUsageTotals;
}

export type LiveModelLaneVerdict =
  | 'model-quality'
  | 'harness-regression'
  | 'control-baseline-undeclared'
  /**
   * 🔴 The model arm threw rather than finishing — a role refused the model's
   * answer, a provider call failed, a cap was hit mid-arm. This is a
   * MEASUREMENT and not a lost run: `investigation-roles.ts` refuses a repair
   * round on purpose, because "a role that could re-ask on a refused answer
   * would hide the model-quality signal the lane is measuring". Before this
   * verdict existed the refusal propagated out of the lane and destroyed the
   * control arm's completed work along with it.
   */
  | 'model-arm-refused';

/** One metric's comparability to the oracle positive control. */
export interface LiveModelLaneComparabilityEntry {
  readonly best: number;
  readonly oracleMean: number;
  readonly comparable: boolean;
}

/** One metric's win/tie/loss count between the graph and the naive arm. */
export interface LiveModelLaneGraphVsNaiveEntry {
  readonly win: number;
  readonly tie: number;
  readonly loss: number;
}

export interface LiveModelLaneReport {
  readonly schemaVersion: typeof LIVE_MODEL_LANE_REPORT_SCHEMA_VERSION;
  readonly informationMode: 'full-dump';
  readonly headSha: string;
  readonly experimentId: string;
  readonly credential: Readonly<{ variable: string; provider: string; modelId: string }>;
  readonly plan: LiveModelLanePlan;
  readonly caps: Readonly<{
    maxModelRuns: number;
    maxModelCalls: number;
    maxOutputTokens: number;
    graphModelCallsPerRun: number;
    naiveModelCallsPerRun: number;
  }>;
  readonly exampleIds: readonly string[];
  readonly arms: Readonly<{
    control: LiveModelLaneControlArm;
    oracle: LiveModelLaneOracleArm;
    naive: LiveModelLaneNaiveArm;
    model: LiveModelLaneModelArm;
  }>;
  readonly withheld: Readonly<Partial<Record<GateMetricKey, string>>>;
  readonly verdict: LiveModelLaneVerdict;
  /** Present only when the oracle arm completed. */
  readonly comparability?: Readonly<Partial<Record<GateMetricKey, LiveModelLaneComparabilityEntry>>>;
  /** Present only when the oracle, the naive arm and the model arm all completed. */
  readonly graphVsNaive?: Readonly<Partial<Record<GateMetricKey, LiveModelLaneGraphVsNaiveEntry>>>;
}

export interface LiveModelLaneOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly experimentId: string;
  /** The exact commit both arms ran at — a comparison across commits is none. */
  readonly headSha: string;
  /**
   * 🔴 **Which corpus, declared by the caller, with no default.**
   *
   * This was the literal `'final-evaluation'` — so every invocation of the
   * shipped `eval:live-model` command spent the hold-out, repeatably and with
   * nothing guarding it. It had never happened here only because no provider
   * credential existed, which is an accident of an environment rather than a
   * mechanism.
   *
   * An OMITTED value is refused rather than defaulted, for the reason
   * `createExecutionBenchmarkPlan` already refuses one: a corpus nobody wrote
   * down is a corpus nobody chose, and the cheaper of the two mistakes to make
   * silently is the one that spends the hold-out.
   * see live-model-lane.test.mjs › "refuses a lane whose scenario set the caller did not declare"
   * see live-model-lane.test.mjs › "touches no hold-out scenario when the caller declares calibration"
   */
  readonly scenarioSet?: LiveModelLaneScenarioSet;
  readonly runsPerScenario?: number;
  readonly metadata: BenchmarkVersions;
  readonly controlBaseline?: Readonly<Partial<Record<GateMetricKey, number>>>;
  runControlArm(plan: LiveModelLanePlan): Promise<BenchmarkExperiment>;
  /** Optional positive control. A throw here propagates out of the lane. */
  runOracleArm?(plan: LiveModelLanePlan): Promise<BenchmarkExperiment>;
  /** Optional single-shot arm. A throw here is caught, like the model arm's. */
  runNaiveArm?(plan: LiveModelLanePlan): Promise<BenchmarkExperiment>;
  runModelArm(plan: LiveModelLanePlan): Promise<BenchmarkExperiment>;
  /**
   * The ledger the runner owns, read before and after each paid arm; each
   * arm's usage is the difference. It must return a fresh snapshot per call —
   * a live reference would read the same object twice and record zero.
   */
  modelUsage?(): ModelUsageTotals;
  publish?(report: LiveModelLaneReport): Promise<void>;
}

/**
 * Reads an optional arm callback at runtime rather than trusting the type: a
 * JavaScript caller can hand this a non-function regardless of what the type
 * declares, and the refusal has to fire before any arm — including
 * control — runs.
 * see four-arm-lane.test.mjs › "refuses a non-function runOracleArm before any arm runs"
 * see four-arm-lane.test.mjs › "refuses a non-function runNaiveArm before control runs"
 */
function requireOptionalArm(
  options: LiveModelLaneOptions,
  name: 'runOracleArm' | 'runNaiveArm',
): ((plan: LiveModelLanePlan) => Promise<BenchmarkExperiment>) | undefined {
  if (!Object.hasOwn(options, name)) return undefined;
  const value = (options as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'function') {
    throw new Error(`${name} must be a function when supplied`);
  }
  return value as (plan: LiveModelLanePlan) => Promise<BenchmarkExperiment>;
}

/** Which metrics this lane withholds for the corpus's declared evaluator version. */
function withheldMetricsFor(
  metadata: BenchmarkVersions,
): Readonly<Partial<Record<GateMetricKey, string>>> {
  // Spelled so that a version this lane does not recognise withholds.
  return metadata.evaluatorVersion === STRUCTURAL_EVALUATOR_VERSION
    ? {}
    : LIVE_MODEL_LANE_WITHHELD_METRICS;
}

interface MetricSample {
  readonly key: GateMetricKey;
  readonly score: number;
  readonly claimCount?: number;
  readonly scenarioId: string;
}

function metricSamples(experiment: BenchmarkExperiment): MetricSample[] {
  const scenarioByExampleId = new Map(
    experiment.records.map((record) => [record.exampleId, record.scenario.id]),
  );
  const samples: MetricSample[] = [];
  for (const result of experiment.results) {
    const scenarioId = scenarioByExampleId.get(result.exampleId);
    if (scenarioId === undefined) continue;
    for (const key of COMPARED_METRIC_KEYS) {
      const metric =
        key in result.metrics
          ? (result.metrics as Record<string, { score: number; claimCount?: number }>)[key]
          : (result.behaviorMetrics as Record<string, { score: number } | undefined>)[key];
      if (metric === undefined) continue;
      const claimCount = (metric as { claimCount?: unknown }).claimCount;
      samples.push({
        key,
        score: metric.score,
        scenarioId,
        ...(typeof claimCount === 'number' ? { claimCount } : {}),
      });
    }
  }
  return samples;
}

/**
 * Per-metric means, one entry per metric and nothing that stands for all of
 * them, each with its per-scenario, run-ordered breakdown. Withheld metrics
 * never enter the result at all, so no caller can read one off the report by
 * accident.
 */
function summarize(
  experiment: BenchmarkExperiment,
  withheld: Readonly<Partial<Record<GateMetricKey, string>>>,
): LiveModelLaneMetrics {
  const byKey = new Map<GateMetricKey, MetricSample[]>();
  for (const sample of metricSamples(experiment)) {
    if (Object.hasOwn(withheld, sample.key)) continue;
    const bucket = byKey.get(sample.key) ?? [];
    bucket.push(sample);
    byKey.set(sample.key, bucket);
  }

  const summary: Record<string, LiveModelLaneMetric> = {};
  for (const [key, samples] of byKey) {
    const scores = samples.map((sample) => sample.score);
    const total = scores.reduce((sum, score) => sum + score, 0);
    const byScenario = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      const bucket = byScenario.get(sample.scenarioId) ?? [];
      bucket.push(sample);
      byScenario.set(sample.scenarioId, bucket);
    }
    // Present only when EVERY sample of this metric carried a claimCount, so a
    // partially-instrumented fixture publishes neither a misleading sum nor a
    // perScenario array shorter than its scores.
    const carriesClaimCounts = samples.every(
      (sample) => typeof sample.claimCount === 'number',
    );
    const perScenario: Record<string, LiveModelLanePerScenarioMetric> = {};
    for (const [scenarioId, scenarioSamples] of byScenario) {
      const scenarioScores = scenarioSamples.map((sample) => sample.score);
      const scenarioTotal = scenarioScores.reduce((sum, score) => sum + score, 0);
      perScenario[scenarioId] = {
        scores: scenarioScores,
        mean: scenarioTotal / scenarioScores.length,
        ...(carriesClaimCounts
          ? { claimCounts: scenarioSamples.map((sample) => sample.claimCount as number) }
          : {}),
      };
    }
    summary[key] = {
      key,
      mean: total / scores.length,
      exampleCount: scores.length,
      perScenario,
      ...(carriesClaimCounts
        ? {
            claimCount: samples.reduce(
              (sum, sample) => sum + (sample.claimCount as number),
              0,
            ),
          }
        : {}),
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
 * that cannot fail. `withheld` is the declared corpus's own withheld set
 * (AIC-117: version-dependent), not the static export, so a metric this run
 * actually reports is never refused as if it were withheld.
 * see live-model-lane.test.mjs › "treats a declared control metric the arm stopped emitting as a move, not as a match"
 * and › "refuses a control baseline
 * naming a metric this lane does not compare"
 */
function movesAgainst(
  declared: Readonly<Partial<Record<GateMetricKey, number>>>,
  observed: Record<string, number>,
  withheld: Readonly<Partial<Record<GateMetricKey, string>>>,
): GateMetricKey[] {
  // Two refusals, not one, because the remedies differ and
  // `.claude/rules/invariants.md` asks the remedy to be decided where the
  // reason is. An unknown key is a typo or a renamed metric — fix the name. A
  // WITHHELD key is a real metric this lane deliberately does not publish, so
  // the entry has to go; keeping it pins a number nothing can ever compare,
  // which is worse than a typo because the name looks right.
  const comparable = new Set<string>(COMPARED_METRIC_KEYS);
  const declaredKeys = Object.keys(declared);
  const unknown = declaredKeys.filter((key) => !comparable.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `the control baseline declares metrics this lane does not compare: ${unknown.join(', ')} — check the spelling against the metric keys this lane reports`,
    );
  }
  const withheldKeys = declaredKeys
    .filter((key) => Object.hasOwn(withheld, key))
    .sort();
  if (withheldKeys.length > 0) {
    throw new Error(
      `the control baseline declares metrics this lane withholds: ${withheldKeys.join(', ')} — remove the entry, because a withheld metric never reaches the comparison and a baseline that pins one cannot fail`,
    );
  }

  // 🔴 The third refusal, and the one that was missing: declaring too LITTLE.
  //
  // The two above cover declaring too much — a key the lane cannot compare, and
  // a key it withholds. But this function walks the DECLARED keys, so an axis
  // the control arm OBSERVED and the baseline omits is compared against nothing
  // and can move freely. Measured at the AIC-19 gate by executing the lane: the
  // committed baseline pinned two axes while the control arm emitted five, and a
  // control arm whose `challenge_effect` had moved off its floor still produced
  // `movedMetrics: []`, verdict `model-quality`, model arm reportable. That is a
  // harness regression published as a model result — the single confound this
  // whole lane exists to prevent, reached through the baseline rather than
  // through the arms.
  //
  // Judged against what the run OBSERVED, not against the full metric union: an
  // axis this corpus never produced is not one the baseline failed to cover, and
  // demanding it would refuse honest runs on smaller corpora.
  // see live-model-lane.test.mjs › "refuses a control baseline that leaves an observed axis undeclared, naming the axes and what to do"
  const undeclared = Object.keys(observed)
    .filter(
      (key) =>
        comparable.has(key) &&
        !Object.hasOwn(withheld, key) &&
        !Object.hasOwn(declared, key),
    )
    .sort();
  if (undeclared.length > 0) {
    throw new Error(
      `the control baseline does not declare metrics the control arm observed: ${undeclared.join(', ')} — add an entry for each, because this comparison walks the declared keys and an observed axis with no declared expectation can move without the lane noticing`,
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
 * caps a refusal message at four hundred characters, plus an ellipsis.
 *
 * The value is quoted from whatever `runNaiveArm`/`runModelArm` threw, so it
 * is caller-supplied text: `ModelCompletionError` may embed a provider HTTP
 * error body, and this capped string reaches `unreportableReason`/
 * `refusalReason` — which the one-shot command writes into a COMMITTED
 * evidence record, to stdout and to `--out`. The cap bounds what a remote
 * party can put into this repository's history; it does not sanitise.
 */
function capRefusalMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}

function usageDelta(
  before: ModelUsageTotals,
  after: ModelUsageTotals,
): ModelUsageTotals {
  return {
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
  };
}

/**
 * Lifts a consistent `notApplicable` map from every result of an arm onto the
 * arm itself, refusing an arm whose results disagree (including "some declare
 * it, others don't", which `isDeepStrictEqual` treats as a mismatch against
 * `undefined`) — an arm's applicability is a property of the ARM, not of one
 * run within it.
 *
 * A metric the lane withholds is stripped afterward: `withheld` is the
 * lane-level statement and takes precedence over a per-result declaration.
 * see four-arm-lane.test.mjs › "never lets a withheld metric appear in an arm's notApplicable, even when a result declared it"
 */
function liftNotApplicable(
  armLabel: string,
  experiment: BenchmarkExperiment,
  withheld: Readonly<Partial<Record<GateMetricKey, string>>>,
): NotApplicableMetrics | undefined {
  const [first, ...rest] = experiment.results;
  if (first === undefined) return undefined;
  for (const result of rest) {
    if (!isDeepStrictEqual(result.notApplicable, first.notApplicable)) {
      throw new Error(
        `the ${armLabel} arm's results disagree about notApplicable: every result of one arm must carry the same map`,
      );
    }
  }
  if (first.notApplicable === undefined) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(first.notApplicable).filter(([key]) => !Object.hasOwn(withheld, key)),
  );
  return Object.keys(filtered).length === 0
    ? undefined
    : (Object.freeze(filtered) as NotApplicableMetrics);
}

/**
 * The same reportable rule for whichever paid arm is asking: an arm that never
 * finished outranks a harness question it cannot be judged against, an
 * undeclared baseline outranks a comparison it cannot be trusted to make, and
 * a moved control outranks the arm's own numbers.
 * see four-arm-lane.test.mjs › "applies the same reportable rules to a completed naive arm as to the model arm"
 */
function armReportable(
  armLabel: string,
  refusal: string | undefined,
  experiment: BenchmarkExperiment | undefined,
  declaredBaseline: Readonly<Partial<Record<GateMetricKey, number>>> | undefined,
  movedMetrics: readonly GateMetricKey[],
): Readonly<{ reportable: boolean; unreportableReason?: string }> {
  if (refusal !== undefined || experiment === undefined) {
    return {
      reportable: false,
      unreportableReason:
        refusal === undefined
          ? `the ${armLabel} arm returned no experiment: a lane with no ${armLabel} measurement is not a model-quality result, whatever the control arm did`
          : `the ${armLabel} arm did not finish: ${refusal}`,
    };
  }
  if (declaredBaseline === undefined) {
    return {
      reportable: false,
      unreportableReason:
        'no control baseline was declared, so a metric that moved cannot be attributed to the model rather than to the harness',
    };
  }
  if (movedMetrics.length > 0) {
    return {
      reportable: false,
      unreportableReason: `the scripted control arm moved against its own baseline (${movedMetrics.join(', ')}), so the regression is in the harness and the ${armLabel} arm's numbers are not reportable`,
    };
  }
  return { reportable: true };
}

/** Every metric the oracle positive control reached, and whether it hit best. */
function comparabilityFor(
  oracleMetrics: LiveModelLaneMetrics,
): Readonly<Partial<Record<GateMetricKey, LiveModelLaneComparabilityEntry>>> {
  const comparability: Record<string, LiveModelLaneComparabilityEntry> = {};
  for (const metric of Object.values(oracleMetrics)) {
    if (metric === undefined) continue;
    const best = METRIC_BEST_VALUES[metric.key];
    comparability[metric.key] = {
      best,
      oracleMean: metric.mean,
      comparable: metric.mean === best,
    };
  }
  return comparability;
}

/**
 * Win/tie/loss between the graph (model) arm and the naive arm, scenario by
 * scenario, over every metric the oracle marked comparable and neither arm
 * marked not-applicable.
 * see four-arm-lane.test.mjs › "counts win, tie and loss per metric between the graph and the naive arm, against the oracle"
 */
function graphVsNaiveFor({
  comparability,
  naiveMetrics,
  naiveNotApplicable,
  modelMetrics,
  modelNotApplicable,
}: Readonly<{
  comparability: Readonly<Partial<Record<GateMetricKey, LiveModelLaneComparabilityEntry>>>;
  naiveMetrics: LiveModelLaneMetrics;
  naiveNotApplicable: NotApplicableMetrics | undefined;
  modelMetrics: LiveModelLaneMetrics;
  modelNotApplicable: NotApplicableMetrics | undefined;
}>): Readonly<Partial<Record<GateMetricKey, LiveModelLaneGraphVsNaiveEntry>>> {
  const result: Record<string, LiveModelLaneGraphVsNaiveEntry> = {};
  for (const [key, entry] of Object.entries(comparability)) {
    if (entry === undefined || !entry.comparable) continue;
    if (Object.hasOwn(naiveNotApplicable ?? {}, key)) continue;
    if (Object.hasOwn(modelNotApplicable ?? {}, key)) continue;
    const naiveMetric = naiveMetrics[key as GateMetricKey];
    const modelMetric = modelMetrics[key as GateMetricKey];
    if (naiveMetric === undefined || modelMetric === undefined) continue;

    let win = 0;
    let tie = 0;
    let loss = 0;
    for (const [scenarioId, naiveScenario] of Object.entries(naiveMetric.perScenario)) {
      const modelScenario = modelMetric.perScenario[scenarioId];
      if (modelScenario === undefined) continue;
      const naiveDistance = Math.abs(naiveScenario.mean - entry.best);
      const modelDistance = Math.abs(modelScenario.mean - entry.best);
      if (modelDistance < naiveDistance) win += 1;
      else if (modelDistance === naiveDistance) tie += 1;
      else loss += 1;
    }
    result[key] = { win, tie, loss };
  }
  return result;
}

/**
 * Run the lane.
 *
 * Order is load-bearing: the credential is required and the caps are checked
 * BEFORE any arm is invoked, so an unconfigured or over-budget lane creates no
 * dataset, no project and no run. A malformed `runOracleArm`/`runNaiveArm` is
 * refused the same way, before even the control arm runs.
 *
 * Arm order after that is control, then the baseline judgement (decidable the
 * moment the deterministic control arm returns), then oracle, then naive, then
 * model — all over the same declared plan.
 */
export async function runLiveModelLane(
  options: LiveModelLaneOptions,
): Promise<LiveModelLaneReport> {
  const config = requireModelConfig(options.env);

  // Read own-only and refused when absent, BEFORE either arm is invoked, so a
  // lane that did not say which corpus it wanted runs nothing at all.
  const declaredScenarioSet = Object.hasOwn(options, 'scenarioSet')
    ? options.scenarioSet
    : undefined;
  if (
    declaredScenarioSet !== 'calibration' &&
    declaredScenarioSet !== 'final-evaluation'
  ) {
    throw new Error(
      'the live model lane requires an explicit calibration or final-evaluation scenarioSet: the final-evaluation corpus includes the hold-out, and a corpus nobody declared is one nobody chose',
    );
  }

  const runsPerScenario =
    options.runsPerScenario ?? LIVE_MODEL_LANE_RUNS_PER_SCENARIO;
  const scenarioCount =
    declaredScenarioSet === 'calibration'
      ? BENCHMARK_SCENARIO_PARTITIONS.calibration.length
      : BENCHMARK_SCENARIO_PARTITIONS.calibration.length +
        BENCHMARK_SCENARIO_PARTITIONS.holdout.length;
  const plannedRuns = scenarioCount * runsPerScenario;
  if (plannedRuns > LIVE_MODEL_LANE_MAX_MODEL_RUNS) {
    throw new Error(
      `live model lane run cap exceeded: ${plannedRuns} runs requested, cap is ${LIVE_MODEL_LANE_MAX_MODEL_RUNS}`,
    );
  }

  const runOracleArm = requireOptionalArm(options, 'runOracleArm');
  const runNaiveArm = requireOptionalArm(options, 'runNaiveArm');

  const plan: LiveModelLanePlan = {
    scenarioSet: declaredScenarioSet,
    runsPerScenario,
    metadata: options.metadata,
  };
  // Built here as well as inside each arm, so the lane knows the corpus it is
  // comparing over rather than inferring it from whichever arm answered first.
  const buildPlan =
    declaredScenarioSet === 'calibration'
      ? createCalibrationBenchmarkPlan
      : createFinalEvaluationBenchmarkPlan;
  const declaredExampleIds = buildPlan({
    experimentId: options.experimentId,
    runsPerScenario,
    metadata: options.metadata,
  })
    .map(({ exampleId }) => exampleId)
    .sort();

  const withheld = withheldMetricsFor(options.metadata);

  const control = await options.runControlArm(plan);
  const controlExampleIds = exampleIdsOf(control);
  // Checked before any paid arm: a control short of the plan is visible for free.
  // see four-arm-lane.test.mjs › "rejects a control arm that missed the declared plan before any paid arm runs"
  if (controlExampleIds.join('|') !== declaredExampleIds.join('|')) {
    throw new Error(
      'the control arm must cover the declared plan: a comparison across two corpora is not a comparison',
    );
  }

  // 🔴 The baseline is judged against the control arm BEFORE any paid arm runs.
  //
  // Everything this needs is known the moment the deterministic control arm
  // returns, and every refusal `movesAgainst` can raise — an unknown key, a
  // withheld key, an axis the baseline does not declare — is a defect in the
  // COMMITTED baseline file rather than anything the model did. Evaluated after
  // a paid arm, each of them destroyed a claimed one-shot hold-out to report a
  // mistake that was already visible for free.
  // see live-model-lane.test.mjs › "judges the declared baseline before the paid arm runs, so a bad declaration costs no model call"
  const controlMetrics = summarize(control, withheld);
  const observedBaseline = baselineOf(controlMetrics);
  const declaredBaseline = options.controlBaseline;
  const movedMetrics =
    declaredBaseline === undefined ? [] : movesAgainst(declaredBaseline, observedBaseline, withheld);

  // Oracle: a throw here is a harness defect, not a measurement, so it is
  // never caught. The paid arms below must never spend on top of a control
  // that could not run.
  // see four-arm-lane.test.mjs › "throws when the oracle arm throws, and never invokes naive or model"
  let oracleExperiment: BenchmarkExperiment | undefined;
  let oracleNotApplicable: NotApplicableMetrics | undefined;
  if (runOracleArm !== undefined) {
    oracleExperiment = await runOracleArm(plan);
    if (exampleIdsOf(oracleExperiment).join('|') !== declaredExampleIds.join('|')) {
      throw new Error(
        'the oracle arm must cover the declared plan: a comparison across two corpora is not a comparison',
      );
    }
    // Decided here, before any paid arm, for the same reason as the baseline.
    // see four-arm-lane.test.mjs › "rejects before any paid arm runs when the oracle arms own results disagree about notApplicable"
    oracleNotApplicable = liftNotApplicable('oracle', oracleExperiment, withheld);
  }

  // Naive: caught exactly like the model arm's throw, below — a refused paid
  // arm is evidence, not a lost run, and it must not stop the model arm.
  let naiveExperiment: BenchmarkExperiment | undefined;
  let naiveRefusal: string | undefined;
  let naiveUsage: ModelUsageTotals | undefined;
  let naiveNotApplicable: NotApplicableMetrics | undefined;
  if (runNaiveArm !== undefined) {
    const before = options.modelUsage?.();
    try {
      naiveExperiment = await runNaiveArm(plan);
    } catch (error) {
      naiveRefusal = capRefusalMessage(error);
    }
    const after = options.modelUsage?.();
    if (before !== undefined && after !== undefined) {
      naiveUsage = usageDelta(before, after);
    }
    if (naiveExperiment !== undefined) {
      if (exampleIdsOf(naiveExperiment).join('|') !== declaredExampleIds.join('|')) {
        throw new Error(
          'the naive arm must cover the declared plan: a comparison across two corpora is not a comparison',
        );
      }
      // see four-arm-lane.test.mjs › "rejects before the model arm runs when the naive arms own results disagree about notApplicable"
      naiveNotApplicable = liftNotApplicable('naive', naiveExperiment, withheld);
    }
  }

  // 🔴 The model arm is the one that can refuse, and its refusal is evidence.
  // Caught HERE and nowhere deeper: a per-record catch would change what a
  // benchmark result can be, and a retry would hide the very signal the roles
  // decline to repair. The control arm has already finished at this point, and
  // losing its work to the model's answer is the defect this catch removes.
  let model: BenchmarkExperiment | undefined;
  let armRefusal: string | undefined;
  let modelUsage: ModelUsageTotals | undefined;
  {
    const before = options.modelUsage?.();
    try {
      model = await options.runModelArm(plan);
    } catch (error) {
      armRefusal = capRefusalMessage(error);
    }
    const after = options.modelUsage?.();
    if (before !== undefined && after !== undefined) {
      modelUsage = usageDelta(before, after);
    }
  }

  if (model !== undefined && exampleIdsOf(model).join('|') !== controlExampleIds.join('|')) {
    throw new Error(
      'the control and model arms must cover the same examples as the declared plan: a comparison across two corpora is not a comparison',
    );
  }

  // 🔴 `model === undefined` as well as a thrown refusal. `metrics` keyed off
  // the arm being absent while `reportable` keyed only off a THROW would let an
  // arm that RETURNED a non-experiment produce `verdict: 'model-quality'` with
  // no metrics and `reportable: true` — a report saying the lane measured model
  // quality while carrying nothing but the control arm.
  // see live-model-lane.test.mjs › "refuses to call a lane reportable when the model arm returned no experiment"
  let verdict: LiveModelLaneVerdict;
  if (armRefusal !== undefined || model === undefined) {
    verdict = 'model-arm-refused';
  } else if (declaredBaseline === undefined) {
    verdict = 'control-baseline-undeclared';
  } else if (movedMetrics.length > 0) {
    verdict = 'harness-regression';
  } else {
    verdict = 'model-quality';
  }
  const modelReportable = armReportable('model', armRefusal, model, declaredBaseline, movedMetrics);

  const credentialFields = { provider: config.provider, modelId: config.modelId };
  const maxOutputBudget = LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS;

  const oracleSummary =
    oracleExperiment === undefined ? undefined : summarize(oracleExperiment, withheld);
  const oracleArm: LiveModelLaneOracleArm =
    runOracleArm === undefined
      ? { arm: 'oracle', status: 'not-run', reason: 'the caller supplied no oracle arm' }
      : {
          arm: 'oracle',
          status: 'completed',
          metrics: oracleSummary as LiveModelLaneMetrics,
          ...(oracleNotApplicable === undefined ? {} : { notApplicable: oracleNotApplicable }),
        };

  const naiveFailed = runNaiveArm !== undefined && naiveExperiment === undefined;
  const naiveSummary =
    naiveExperiment === undefined ? undefined : summarize(naiveExperiment, withheld);
  const naiveReportable = armReportable('naive', naiveRefusal, naiveExperiment, declaredBaseline, movedMetrics);
  const naiveArm: LiveModelLaneNaiveArm =
    runNaiveArm === undefined
      ? { arm: 'naive', status: 'not-run', reason: 'the caller supplied no naive arm' }
      : naiveFailed
        ? {
            arm: 'naive',
            status: 'refused',
            refusalReason: naiveRefusal ?? 'the naive arm returned no experiment',
            reportable: false,
            model: credentialFields,
            ...(naiveUsage === undefined ? {} : { usage: naiveUsage }),
          }
        : {
            arm: 'naive',
            status: 'completed',
            metrics: naiveSummary as LiveModelLaneMetrics,
            reportable: naiveReportable.reportable,
            ...(naiveReportable.unreportableReason === undefined
              ? {}
              : { unreportableReason: naiveReportable.unreportableReason }),
            ...(naiveNotApplicable === undefined ? {} : { notApplicable: naiveNotApplicable }),
            model: credentialFields,
            ...(naiveUsage === undefined ? {} : { usage: naiveUsage }),
          };

  const modelNotApplicable =
    model === undefined ? undefined : liftNotApplicable('model', model, withheld);
  const modelSummary = model === undefined ? undefined : summarize(model, withheld);
  const modelArm: LiveModelLaneModelArm = {
    arm: 'model',
    status: model === undefined ? 'refused' : 'completed',
    ...(modelSummary === undefined ? {} : { metrics: modelSummary }),
    reportable: modelReportable.reportable,
    ...(modelReportable.unreportableReason === undefined
      ? {}
      : { unreportableReason: modelReportable.unreportableReason }),
    ...(modelNotApplicable === undefined ? {} : { notApplicable: modelNotApplicable }),
    model: credentialFields,
    ...(modelUsage === undefined ? {} : { usage: modelUsage }),
  };

  const comparability =
    oracleSummary === undefined ? undefined : comparabilityFor(oracleSummary);
  const graphVsNaive =
    comparability !== undefined && naiveSummary !== undefined && modelSummary !== undefined
      ? graphVsNaiveFor({
          comparability,
          naiveMetrics: naiveSummary,
          naiveNotApplicable,
          modelMetrics: modelSummary,
          modelNotApplicable,
        })
      : undefined;

  const report: LiveModelLaneReport = {
    schemaVersion: LIVE_MODEL_LANE_REPORT_SCHEMA_VERSION,
    informationMode: 'full-dump',
    headSha: options.headSha,
    experimentId: options.experimentId,
    credential: {
      variable: MODEL_API_KEY_VARIABLE,
      ...credentialFields,
    },
    plan,
    caps: {
      maxModelRuns: LIVE_MODEL_LANE_MAX_MODEL_RUNS,
      maxModelCalls: LIVE_MODEL_LANE_MAX_MODEL_CALLS,
      // Published even though the LEDGER enforces it rather than this lane: a
      // committed record that names two of the three bounds a run was under
      // cannot be read to know what the third was. Added when a third bound
      // appeared and this block did not move with it.
      maxOutputTokens: maxOutputBudget,
      graphModelCallsPerRun: LIVE_MODEL_LANE_GRAPH_MODEL_CALLS_PER_RUN,
      naiveModelCallsPerRun: LIVE_MODEL_LANE_NAIVE_MODEL_CALLS_PER_RUN,
    },
    exampleIds: declaredExampleIds,
    arms: {
      control: {
        arm: 'scripted-control',
        status: 'completed',
        metrics: controlMetrics,
        observedBaseline,
        movedMetrics,
      },
      oracle: oracleArm,
      naive: naiveArm,
      model: modelArm,
    },
    withheld,
    verdict,
    ...(comparability === undefined ? {} : { comparability }),
    ...(graphVsNaive === undefined ? {} : { graphVsNaive }),
  };

  // Never wrapped in a retry and never swallowed: a refused publication is a
  // failed lane, not a lane that published.
  await options.publish?.(report);
  return report;
}

import {
  MODEL_API_KEY_VARIABLE,
  requireModelConfig,
  type ModelUsageTotals,
} from '@aic/roles';

import {
  BENCHMARK_METRIC_KEYS,
  createCalibrationBenchmarkPlan,
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
 * regression and marks the model numbers unreportable"
 * ⚠ MARKS, not withholds: `arms.model.metrics` still carries every model mean
 * on that verdict and only `reportable` flips. The `--publish` path is what
 * gates on it, so nothing reaches LangSmith — but a consumer reading
 * `metrics` without checking `reportable` gets numbers an earlier wording
 * here said were withheld. Corrected at the AIC-94 gate.
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
 * see live-model-lane.test.mjs › "publishes every cap a run is under rather than leaving one implicit"
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
 * for a cap that throws MID-RUN. The largest recorded run is 47 calls against a
 * 150-call cap, so a ceiling that clears its total can still abort a
 * full-length one.
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
export const LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS = 800_000;

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

/** The two corpora a lane may declare. There is no third, and no default. */
export type LiveModelLaneScenarioSet = 'calibration' | 'final-evaluation';

export interface LiveModelLanePlan {
  readonly scenarioSet: LiveModelLaneScenarioSet;
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
  /**
   * ⚠ ABSENT when the arm refused, never zeroed. An arm that produced no score
   * did not score zero on six axes, and six zeroes read as a model that
   * answered badly rather than one that did not answer.
   * see live-model-lane.test.mjs › "records a model arm that refused as unreportable rather than losing the run"
   */
  readonly metrics?: LiveModelLaneMetrics;
  readonly reportable: boolean;
  readonly unreportableReason?: string;
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

export interface LiveModelLaneReport {
  readonly headSha: string;
  readonly experimentId: string;
  readonly credential: Readonly<{ variable: string; provider: string; modelId: string }>;
  readonly plan: LiveModelLanePlan;
  readonly caps: Readonly<{
    maxModelRuns: number;
    maxModelCalls: number;
    maxOutputTokens: number;
  }>;
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
  const withheld = declaredKeys
    .filter((key) => Object.hasOwn(LIVE_MODEL_LANE_WITHHELD_METRICS, key))
    .sort();
  if (withheld.length > 0) {
    throw new Error(
      `the control baseline declares metrics this lane withholds: ${withheld.join(', ')} — remove the entry, because a withheld metric never reaches the comparison and a baseline that pins one cannot fail`,
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
        !Object.hasOwn(LIVE_MODEL_LANE_WITHHELD_METRICS, key) &&
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

  const control = await options.runControlArm(plan);

  // 🔴 The baseline is judged against the control arm BEFORE the paid arm runs.
  //
  // Everything this needs is known the moment the deterministic control arm
  // returns, and every refusal `movesAgainst` can raise — an unknown key, a
  // withheld key, an axis the baseline does not declare — is a defect in the
  // COMMITTED baseline file rather than anything the model did. Evaluated after
  // the model arm, as the first version was, each of them destroyed a claimed
  // one-shot hold-out to report a mistake that was already visible for free.
  // Found by `security-scanner` at the AIC-19 gate.
  // see live-model-lane.test.mjs › "judges the declared baseline before the paid arm runs, so a bad declaration costs no model call"
  const controlMetrics = summarize(control);
  const observedBaseline = baselineOf(controlMetrics);
  const declaredBaseline = options.controlBaseline;
  const movedMetrics =
    declaredBaseline === undefined ? [] : movesAgainst(declaredBaseline, observedBaseline);

  // 🔴 The model arm is the one that can refuse, and its refusal is evidence.
  // Caught HERE and nowhere deeper: a per-record catch would change what a
  // benchmark result can be, and a retry would hide the very signal the roles
  // decline to repair. The control arm has already finished at this point, and
  // losing its work to the model's answer is the defect this catch removes.
  let model;
  let armRefusal;
  try {
    model = await options.runModelArm(plan);
  } catch (error) {
    // ⚠ Capped, because this string is PROVIDER-QUOTED and now persists.
    // `ModelCompletionError` embeds up to 400 characters of the provider's HTTP
    // error body, and this value reaches `unreportableReason` — which the
    // one-shot command writes into a COMMITTED evidence record, to stdout and
    // to `--out`. Before the arm-level catch that text reached stderr only. The
    // cap bounds what a remote party can put into this repository's history; it
    // does not sanitise, and the evidence README says the field is quoted from
    // the provider rather than authored here.
    const raw = error instanceof Error ? error.message : String(error);
    armRefusal = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
  }

  const controlExampleIds = exampleIdsOf(control);
  if (model !== undefined) {
    const modelExampleIds = exampleIdsOf(model);
    if (
      controlExampleIds.join('|') !== modelExampleIds.join('|') ||
      controlExampleIds.join('|') !== declaredExampleIds.join('|')
    ) {
      throw new Error(
        'the control and model arms must cover the same examples as the declared plan: a comparison across two corpora is not a comparison',
      );
    }
  } else if (controlExampleIds.join('|') !== declaredExampleIds.join('|')) {
    // The control arm is still held to the declared corpus. A refused model arm
    // excuses the comparison, never the arm that did finish.
    throw new Error(
      'the control arm must cover the declared plan: a comparison across two corpora is not a comparison',
    );
  }

  let verdict: LiveModelLaneVerdict = 'model-quality';
  let unreportableReason: string | undefined;
  if (armRefusal !== undefined || model === undefined) {
    // First, because it outranks the other two: an arm that never finished
    // cannot be judged against a baseline it never reached.
    // 🔴 `model === undefined` as well as a thrown refusal. `metrics` keyed off
    // the arm being absent while `reportable` keyed only off a THROW, so an arm
    // that RETURNED a non-experiment produced `verdict: 'model-quality'` with no
    // metrics and `reportable: true` — a report saying the lane measured model
    // quality while carrying nothing but the control arm. That is the
    // harness-only-as-model-quality shape AIC-19 forbids by name, and it became
    // an evidence record whose acceptance row read `met: true`.
    //
    // On `main` this failed closed by accident: `exampleIdsOf(model)` threw a
    // TypeError before any of it. Making the arm optional removed that accident,
    // so the property is asserted here instead.
    // see live-model-lane.test.mjs › "refuses to call a lane reportable when the model arm returned no experiment"
    verdict = 'model-arm-refused';
    unreportableReason =
      armRefusal === undefined
        ? 'the model arm returned no experiment: a lane with no model measurement is not a model-quality result, whatever the control arm did'
        : `the model arm did not finish: ${armRefusal}`;
  } else if (declaredBaseline === undefined) {
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
      // Published even though the LEDGER enforces it rather than this lane: a
      // committed record that names two of the three bounds a run was under
      // cannot be read to know what the third was. Added when a third bound
      // appeared and this block did not move with it.
      maxOutputTokens: LIVE_MODEL_LANE_MAX_OUTPUT_TOKENS,
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
        ...(model === undefined ? {} : { metrics: summarize(model) }),
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

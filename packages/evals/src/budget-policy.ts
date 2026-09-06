/**
 * The benchmark's investigation budgets, as one versioned decision.
 *
 * They used to be three literals inside a module-private function
 * (`initialBenchmarkState`), which had two costs. Changing one read as a
 * refactor rather than as a decision, and nothing could vary them: measuring
 * whether a budget matters required patching the source of a shipped package.
 *
 * 🔴 **What the sweep found, and why these values did not move.** AIC-18 asked
 * for these three to be tuned from benchmark evidence. Measured over the
 * calibration partition, the evidence does not respond to two of them at all:
 * `maxIterations` and `llmCallBudget` are read on ONE edge — the
 * `need-more-evidence` route out of `termination_check` — and no node outside
 * `test/` returns that route, so `0 / 0` publishes evidence identical to the
 * shipped `4 / 8` on every axis the comparison keeps — which is all of them
 * except `wallClockDurationMs`, excluded as nondeterministic. `reservedChallengeBudget` is reached, but the challenge
 * cap is two rounds and this corpus uses one, so `1`, `2` and `8` are
 * indistinguishable; only `0` differs, and it stops every run
 * `budget-exhausted`, which moves the accepted v0.1 outcome and is therefore
 * refused as a candidate rather than accepted as a cheaper policy.
 *
 * So the values here are **not** calibrated numbers. `summarizeBudgetPolicyEvidence`
 * says which of them evidence chose and which it did not, per budget, and that
 * statement is the point of publishing a version alongside them.
 * see budget-policy.test.mjs ›
 * "publishes identical evidence at zero logical budget, because nothing reaches that edge"
 * see budget-policy.test.mjs ›
 * "states in the report that llmCallBudget is not empirically calibrated, and why"
 */

/** A budget policy: what a run is ALLOWED to spend, and the version that says so. */
export interface BenchmarkBudgetPolicy {
  readonly policyVersion: string;
  readonly maxIterations: number;
  readonly llmCallBudget: number;
  readonly reservedChallengeBudget: number;
}

/**
 * The three budget names, in one place, so nothing below spells them twice.
 *
 * Frozen for the reason `GRAPH_OWNED_CONTROL_FIELDS` is: `as const` is erased at
 * compile time, so an exported array is ordinary mutable runtime state that any
 * importer can splice — and an entry removed from here is a budget that stops
 * being validated and stops being reported.
 */
export const BENCHMARK_BUDGET_FIELDS = Object.freeze([
  'maxIterations',
  'llmCallBudget',
  'reservedChallengeBudget',
] as const);

export type BenchmarkBudgetField = (typeof BENCHMARK_BUDGET_FIELDS)[number];

/**
 * The shipped policy. Frozen, and the values are the ones the accepted v0.1
 * baseline was measured under — they are unchanged by AIC-18 on purpose.
 */
export const BENCHMARK_BUDGET_POLICY: BenchmarkBudgetPolicy = Object.freeze({
  policyVersion: 'budget-policy-v0.2',
  maxIterations: 4,
  llmCallBudget: 8,
  reservedChallengeBudget: 2,
});

const isLogicalCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Parse a caller-supplied policy, or refuse it.
 *
 * ⚠ **Fails closed, and that is the whole contract.** A policy that cannot be
 * read is not replaced by the shipped one: a run that silently falls back
 * publishes evidence under a version it did not execute, which is worse than no
 * evidence because it looks like a measurement. Every refusal names the field,
 * so the caller is told which number to fix rather than that "something" was
 * wrong.
 * see budget-policy.test.mjs › "refuses a fractional budget instead of falling back to the shipped one"
 */
export function parseBenchmarkBudgetPolicy(
  candidate: unknown,
): BenchmarkBudgetPolicy {
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(
      `budget policy must be an object carrying ${BENCHMARK_BUDGET_FIELDS.join(', ')} and a policyVersion`,
    );
  }

  const record = candidate as Record<string, unknown>;
  const policyVersion = record['policyVersion'];
  if (typeof policyVersion !== 'string' || policyVersion.trim().length === 0) {
    throw new Error(
      'budget policy requires a non-empty policyVersion: evidence published under an unnamed policy cannot be compared with anything',
    );
  }

  const budgets: Record<string, number> = {};
  for (const field of BENCHMARK_BUDGET_FIELDS) {
    const value = record[field];
    if (!isLogicalCount(value)) {
      throw new Error(
        `budget policy field ${field} must be a non-negative integer, received ${String(value)}`,
      );
    }
    budgets[field] = value;
  }

  return Object.freeze({
    policyVersion,
    maxIterations: budgets['maxIterations'] as number,
    llmCallBudget: budgets['llmCallBudget'] as number,
    reservedChallengeBudget: budgets['reservedChallengeBudget'] as number,
  });
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

/** One measured figure: what it is, its mean, and how many runs are behind it. */
export interface BudgetPolicyAxisEntry {
  readonly key: string;
  readonly mean: number;
  readonly exampleCount: number;
}

/** Whether evidence chose a budget's value, and the reason either way. */
export interface BudgetCalibrationStatement {
  readonly empiricallyCalibrated: boolean;
  readonly reason: string;
}

export interface BudgetPolicyArmReport {
  readonly policyVersion: string;
  readonly budgets: Readonly<Record<BenchmarkBudgetField, number>>;
  readonly runCount: number;
  readonly stopKindDistribution: Readonly<Record<string, number>>;
  readonly metrics: Readonly<Record<string, BudgetPolicyAxisEntry>>;
  readonly resourceAxes: Readonly<Record<string, BudgetPolicyAxisEntry>>;
}

export interface BudgetPolicyEvidenceReport {
  readonly arms: readonly BudgetPolicyArmReport[];
  readonly calibration: Readonly<
    Record<BenchmarkBudgetField, BudgetCalibrationStatement>
  >;
}

/**
 * 🔴 **Why every dimension keeps its own row, and there is no summary number.**
 *
 * A single figure blending quality with spend can fall while quality falls with
 * it, which is exactly the reading this item was told not to produce: "no
 * individual quality regression is masked by aggregate cost improvement". So
 * this report has no composite, no weighted total and no efficiency ratio, and
 * that absence is asserted by walking every key at every depth rather than by
 * checking three names — the failure guarded against is a key ADDED later.
 * see budget-policy.test.mjs › "publishes no composite or aggregate score anywhere in the report"
 *
 * The same separation applies inside the resource axes: `retryCount` and
 * `resumeCount` are recovery overhead and stay their own rows rather than being
 * folded into the logical spend, and a BUDGET (what a policy allowed) is
 * reported apart from an AXIS (what a run spent).
 */
const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const axisEntry = (key: string, values: readonly number[]): BudgetPolicyAxisEntry => ({
  key,
  mean: mean(values),
  exampleCount: values.length,
});

/**
 * The calibration statements, which are the honest core of this report.
 *
 * They differ per budget because the sweep found different things about each,
 * and one reason repeated three times would be a placeholder rather than
 * evidence. Both statements about the unreached budgets say *unreached*, not
 * *unimportant*: the value still bounds a run that ever takes that edge.
 */
const CALIBRATION: Readonly<
  Record<BenchmarkBudgetField, BudgetCalibrationStatement>
> = Object.freeze({
  maxIterations: Object.freeze({
    empiricallyCalibrated: false,
    reason:
      'read only on the need-more-evidence edge out of termination_check, which no node outside the test tree returns, so every value from 0 upwards publishes identical evidence on this corpus: the number was chosen, not measured, and it still bounds a run that ever takes that edge',
  }),
  llmCallBudget: Object.freeze({
    empiricallyCalibrated: false,
    reason:
      'a versioned safety cap. It shares the unreached need-more-evidence edge with maxIterations, and no run on this corpus declares an llm call, so declaredLlmCallsUsed is 0 on every one: nothing measured this value and no benchmark evidence can, until a model-backed arm both declares calls and reaches that edge',
  }),
  reservedChallengeBudget: Object.freeze({
    empiricallyCalibrated: false,
    reason:
      'the only budget this corpus reaches, and it still does not calibrate: the challenge cap is two rounds and the corpus uses one, so 1, 2 and 8 are indistinguishable, while 0 stops every run budget-exhausted and moves the accepted v0.1 stop kind — a candidate refused rather than a cheaper policy found',
  }),
});

/**
 * Summarise one or more policy arms, per axis, per policy version.
 *
 * Each arm is `{ policy, experiment }` — the policy it ran under and the
 * experiment it produced. Arms are reported in the order given, and two arms
 * declaring one version are refused: rows that cannot be told apart are not
 * evidence about either policy.
 */
export interface BudgetPolicyArmResult {
  readonly metrics: Readonly<Record<string, Readonly<{ score: number }>>>;
  readonly resources?: Readonly<Record<string, number>>;
}

export interface BudgetPolicyArmExperiment {
  readonly results: readonly BudgetPolicyArmResult[];
  readonly stopKindDistribution: Readonly<Record<string, number>>;
}

export interface BudgetPolicyArmInput {
  readonly policy: BenchmarkBudgetPolicy;
  readonly experiment: BudgetPolicyArmExperiment;
}

export function summarizeBudgetPolicyEvidence({
  arms,
}: Readonly<{
  arms: readonly BudgetPolicyArmInput[];
}>): BudgetPolicyEvidenceReport {
  // Not `Array.isArray(arms)`: its guard is `arg is any[]`, which would narrow
  // an already-typed readonly array to `any[]` and silently erase the element
  // type for everything below.
  if (arms.length === 0) {
    throw new Error('budget policy evidence requires at least one arm');
  }

  const seen = new Set<string>();
  const reported = arms.map(({ policy, experiment }) => {
    const parsed = parseBenchmarkBudgetPolicy(policy);
    if (seen.has(parsed.policyVersion)) {
      throw new Error(
        `budget policy version ${parsed.policyVersion} appears on two arms: two rows under one version cannot be told apart`,
      );
    }
    seen.add(parsed.policyVersion);

    const results = experiment.results;
    const metricKeys: string[] = [
      ...new Set<string>(
        results.flatMap((result) => Object.keys(result.metrics)),
      ),
    ].sort();
    // Derived from what the runs published rather than from a list here, so an
    // axis added to the resource schema is reported without editing this file.
    // `schemaVersion` is the evidence's own version, not a measured axis.
    const axisKeys: string[] = [
      ...new Set<string>(
        results.flatMap((result) =>
          Object.keys(result.resources ?? {}).filter(
            (key) => key !== 'schemaVersion',
          ),
        ),
      ),
    ].sort();

    return {
      policyVersion: parsed.policyVersion,
      budgets: Object.freeze({
        maxIterations: parsed.maxIterations,
        llmCallBudget: parsed.llmCallBudget,
        reservedChallengeBudget: parsed.reservedChallengeBudget,
      }),
      runCount: results.length,
      stopKindDistribution: experiment.stopKindDistribution,
      metrics: Object.fromEntries(
        metricKeys.map((key) => [
          key,
          axisEntry(
            key,
            results.map((result) => result.metrics[key]?.score ?? 0),
          ),
        ]),
      ),
      resourceAxes: Object.fromEntries(
        axisKeys.map((key) => [
          key,
          axisEntry(
            key,
            results.map((result) => result.resources?.[key] ?? 0),
          ),
        ]),
      ),
    };
  });

  return { arms: reported, calibration: CALIBRATION };
}

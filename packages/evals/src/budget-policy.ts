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
 * except `wallClockDurationMs`, excluded as nondeterministic.
 *
 * ⚠ Those are two claims with two different lifetimes, and only one is about a
 * corpus. The identical evidence is a fact about the calibration runs. "No node
 * outside `test/` returns that route" is a fact about the TREE, and it is what
 * makes the conclusion outlive this corpus — swapping the corpus changes nothing
 * while the fixture supplies `termination_check`. The sweep rows watch the
 * fixture and cannot see the tree; a separate row does.
 * see budget-policy.test.mjs › "names every non-test file that mentions the route this conclusion depends on"
 *
 * `reservedChallengeBudget` is reached, but the challenge
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
 * importer can splice.
 *
 * ⚠ This list and the calibration statements below are two spellings of "which
 * budgets exist". Measured at this head, the compiler makes them agree in both
 * directions: removing an entry is `TS2345` where the parser names that field as
 * a literal, and adding one without a statement is `TS2741` on the calibration
 * record. That is the enforcement; the correspondence row is the runtime check
 * beside it.
 *
 * An earlier version of this sentence said a removed entry "stops being
 * validated and stops being reported". Only the first half was true: the report
 * went on publishing a statement for a field the validator no longer knew, which
 * is the opposite of the reassurance. Recorded because that sentence survived
 * two passes before it was measured.
 * see budget-policy.test.mjs › "carries one calibration statement per declared budget field, and no other"
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
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

/**
 * The slot as the caller OWNS it, never as a `[[Get]]` would report it.
 *
 * 🔴 A budget policy is caller-supplied input whose version string keys every
 * row published from it, so a field read through the prototype chain is a
 * measurement claim about a run nobody declared. Measured before this was here:
 * under a polluted `Object.prototype`, `parse({})` returned a fully valid
 * policy carrying the SHIPPED version string with every budget at 0, and
 * driving it through the graph runner flipped the whole calibration corpus from
 * `sufficient` to `budget-exhausted` while publishing under that version.
 *
 * An own ACCESSOR answers `present: false` too: a value a getter computes is
 * not a value the caller wrote down. Same shape as
 * `packages/persistence/src/own-value-serde.ts` and the graph's own refusal
 * sites, which is the convention AIC-67 and AIC-69 left behind.
 * see budget-policy.test.mjs › "refuses a policy whose version exists only on the prototype"
 */
const readOwnValue = (
  source: object,
  key: string,
): { present: boolean; value?: unknown } => {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return { present: false };
  }
  return { present: true, value: descriptor.value };
};

/**
 * Parse a caller-supplied policy, or refuse it.
 *
 * ⚠ **Fails closed, and that is the whole contract.** A policy that cannot be
 * read is not replaced by the shipped one: a run that silently falls back
 * publishes evidence under a version it did not execute, which is worse than no
 * evidence because it looks like a measurement. Every refusal names the field,
 * so the caller is told which number to fix rather than that "something" was
 * wrong.
 * The refusal rows are generated from a table, so their full names are not
 * greppable: see budget-policy.test.mjs, the MALFORMED_POLICIES table, whose
 * labels ("a fractional budget", "an explicitly null policy") a grep does find.
 */
export function parseBenchmarkBudgetPolicy(
  candidate: unknown,
): BenchmarkBudgetPolicy {
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(
      `budget policy must be an object carrying ${BENCHMARK_BUDGET_FIELDS.join(', ')} and a policyVersion`,
    );
  }

  const version = readOwnValue(candidate, 'policyVersion');
  if (
    !version.present ||
    typeof version.value !== 'string' ||
    version.value.trim().length === 0
  ) {
    throw new Error(
      'budget policy requires a non-empty own policyVersion: evidence published under an unnamed or inherited policy cannot be compared with anything',
    );
  }

  // Read into locals and build the result literal from them. An accumulator
  // object assigned into with `budgets[field] = value` writes THROUGH the
  // prototype: an inherited setter swallows the validated number and the
  // read-back returns the getter's, so a policy that passed validation is
  // published as a different one. An object literal is CreateDataProperty and
  // cannot be intercepted.
  // see budget-policy.test.mjs › "keeps a validated budget even when an inherited accessor tries to swallow it"
  const read = (field: BenchmarkBudgetField): number => {
    const slot = readOwnValue(candidate, field);
    if (!slot.present || !isLogicalCount(slot.value)) {
      throw new Error(
        `budget policy field ${field} must be an own non-negative safe integer, received ${slot.present ? String(slot.value) : '(absent, or inherited)'}`,
      );
    }
    return slot.value;
  };

  return Object.freeze({
    policyVersion: version.value,
    maxIterations: read('maxIterations'),
    llmCallBudget: read('llmCallBudget'),
    reservedChallengeBudget: read('reservedChallengeBudget'),
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

export function summarizeBudgetPolicyEvidence(
  input: Readonly<{ arms: readonly BudgetPolicyArmInput[] }>,
): BudgetPolicyEvidenceReport {
  // A named parameter rather than a destructure: `{ arms }` in the signature
  // performs a `[[Get]]` on the argument BEFORE the guard below runs, so an
  // inherited getter fires on a call the guard then refuses. It also forced the
  // real read to go through `arguments`, which breaks silently if anyone
  // converts this to an arrow — and `packages/evals` is outside the eslint
  // configuration that would catch it.
  if (input === null || typeof input !== 'object') {
    throw new Error(
      'budget policy evidence requires an options object carrying an arms list',
    );
  }
  // Read from what the caller OWNS, for the reason `readOwnValue` states: an
  // arm list inherited from `Object.prototype` publishes a report about runs
  // nobody handed over. Measured: `summarize({})` under a polluted prototype
  // returned a full evidence report instead of refusing.
  // see budget-policy.test.mjs › "refuses a report whose arms exist only on the prototype"
  const declaredArms = readOwnValue(input, 'arms');
  if (!declaredArms.present || !Array.isArray(declaredArms.value)) {
    throw new Error(
      'budget policy evidence requires an own arms list: an inherited one is a report about runs the caller never declared',
    );
  }
  if (declaredArms.value.length === 0) {
    throw new Error('budget policy evidence requires at least one arm');
  }

  const seen = new Set<string>();
  const reported = (declaredArms.value as readonly BudgetPolicyArmInput[]).map((entry) => {
    const armPolicy = readOwnValue(entry as object, 'policy');
    const armExperiment = readOwnValue(entry as object, 'experiment');
    if (!armPolicy.present || !armExperiment.present) {
      throw new Error(
        'each budget policy arm must own both a policy and an experiment: an inherited one describes an arm that was never run',
      );
    }
    const experiment = armExperiment.value as BudgetPolicyArmExperiment;
    const parsed = parseBenchmarkBudgetPolicy(armPolicy.value);
    if (seen.has(parsed.policyVersion)) {
      throw new Error(
        `budget policy version ${parsed.policyVersion} appears on two arms: two rows under one version cannot be told apart`,
      );
    }
    seen.add(parsed.policyVersion);

    // 🔴 The own-read goes down to the NUMBERS, not just to the policy label. A
    // report that hardened which policy it names while reading its measurements
    // through the prototype chain would carry the convention's wording and not
    // its property — measured before this was here: with `results` and
    // `stopKindDistribution` planted on `Object.prototype`, an experiment owning
    // nothing published runCount 1, a fabricated stop-kind distribution and a
    // metric mean of 42.
    // see budget-policy.test.mjs › "refuses an experiment whose measurements exist only on the prototype"
    const ownResults = readOwnValue(experiment as object, 'results');
    const ownStopKinds = readOwnValue(experiment as object, 'stopKindDistribution');
    if (!ownResults.present || !Array.isArray(ownResults.value)) {
      throw new Error(
        `budget policy arm ${parsed.policyVersion} must own a results array: an inherited one is a measurement of runs the caller never handed over`,
      );
    }
    if (!ownStopKinds.present) {
      throw new Error(
        `budget policy arm ${parsed.policyVersion} must own a stopKindDistribution: a distribution read off the prototype describes runs that did not happen`,
      );
    }
    const results = ownResults.value as readonly BudgetPolicyArmResult[];
    const stopKindDistribution = ownStopKinds.value as Readonly<
      Record<string, number>
    >;

    /** An own record, or nothing — never a container the run did not carry. */
    const ownRecord = (source: unknown, key: string): object | undefined => {
      if (source === null || typeof source !== 'object') return undefined;
      const slot = readOwnValue(source, key);
      return slot.present && slot.value !== null && typeof slot.value === 'object'
        ? (slot.value as object)
        : undefined;
    };
    /** An own measured number, or nothing. */
    const ownNumber = (source: unknown, key: string): number | undefined => {
      if (source === null || typeof source !== 'object') return undefined;
      const slot = readOwnValue(source, key);
      return typeof slot.value === 'number' ? slot.value : undefined;
    };
    const metricKeys: string[] = [
      ...new Set<string>(
        results.flatMap((result) => Object.keys(ownRecord(result, 'metrics') ?? {})),
      ),
    ].sort();
    // Derived from what the runs published rather than from a list here, so an
    // axis added to the resource schema is reported without editing this file.
    // `schemaVersion` is the evidence's own version, not a measured axis.
    const axisKeys: string[] = [
      ...new Set<string>(
        results.flatMap((result) =>
          Object.keys(ownRecord(result, 'resources') ?? {}).filter(
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
      stopKindDistribution,
      // ⚠ A run that did not publish a key contributes NOTHING to that key's
      // mean, rather than contributing a zero. `?? 0` would manufacture the
      // "spent nothing on that axis" reading that `benchmark-evaluation.ts`
      // refuses by name for `retryCount` — and it would do it while
      // `exampleCount` still counted the run, so the count would say the mean
      // rests on evidence it does not have. Every key is uniform across runs on
      // today's corpus, so this is latent rather than active.
      metrics: Object.fromEntries(
        metricKeys.map((key) => [
          key,
          axisEntry(
            key,
            results
              .map((result) =>
                ownNumber(ownRecord(ownRecord(result, 'metrics'), key), 'score'),
              )
              .filter((score): score is number => typeof score === 'number'),
          ),
        ]),
      ),
      resourceAxes: Object.fromEntries(
        axisKeys.map((key) => [
          key,
          axisEntry(
            key,
            results
              .map((result) => ownNumber(ownRecord(result, 'resources'), key))
              .filter((value): value is number => typeof value === 'number'),
          ),
        ]),
      ),
    };
  });

  // Derived from BENCHMARK_BUDGET_FIELDS rather than returned as the literal: a
  // statement about a budget the validator no longer knows is a claim about a
  // number nobody checks, and a budget with no statement is a number published
  // with no word about where it came from. Both are refused here.
  //
  // ⚠ What pins what, stated exactly, because a mutation showed the obvious
  // reading is wrong: the correspondence row below catches the two lists having
  // DIVERGED, and it is what would go red if a field lost its statement.
  // Removing this derivation alone reddens nothing, because with the lists
  // intact the literal and the derived record are equal — making them diverge
  // means editing a module constant, which no test does. So this block is the
  // module refusing rather than publishing, and the row is the thing that
  // notices. Neither is redundant; only the row is pinned.
  // see budget-policy.test.mjs › "carries one calibration statement per declared budget field, and no other"
  const calibration = Object.fromEntries(
    BENCHMARK_BUDGET_FIELDS.map((field) => {
      const statement = CALIBRATION[field];
      if (statement === undefined) {
        throw new Error(
          `budget policy field ${field} has no calibration statement: a budget cannot be published without saying whether evidence chose its value`,
        );
      }
      return [field, statement];
    }),
  ) as Readonly<Record<BenchmarkBudgetField, BudgetCalibrationStatement>>;

  return { arms: reported, calibration };
}

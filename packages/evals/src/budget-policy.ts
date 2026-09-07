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

import { LogicalCountSchema } from '@aic/domain';

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
 * budgets exist", and the compiler closes **one and a half** of the two
 * directions. Measured with `tsc` on a scratch copy of this file: removing an
 * entry from the list is `TS2345` where the parser names that field as a
 * literal, and adding an entry without a statement is `TS2741` on the
 * calibration record — but adding a STATEMENT for a budget the list does not
 * declare compiles clean, and is then dropped from every report, because
 * `calibration` is derived from this list by construction.
 *
 * A previous version of this sentence said "the compiler makes them agree in
 * both directions". It does not, and the runtime row could not see the gap
 * either: with `calibration`'s keys derived from this list, asserting that they
 * equal this list is a tautology. The direction the compiler misses is covered
 * by a row that reads this file's source instead.
 * see budget-policy.test.mjs › "declares a calibration statement for exactly the budgets the field list carries"
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

/**
 * Not restated here. `LogicalCountSchema` is what the domain exports and what
 * the graph enforces these same three fields with, and a second hand-written
 * spelling of it is a defect this repository has already paid for once:
 * `packages/graph/src/investigation.ts` removed its own copy
 * (`Number.isSafeInteger(x) && x >= 0`) with the note that it "agreed with the
 * schema by luck rather than by construction". A policy `evals` accepted and
 * `IncidentStateSchema.parse` then refused would fail halfway through a corpus,
 * with runs already recorded under its version.
 * see budget-policy.test.mjs › "accepts a budget exactly when the shared logical-count schema accepts it"
 */
const isLogicalCount = (value: unknown): value is number =>
  LogicalCountSchema.safeParse(value).success;

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
 * Every element the caller actually wrote down, or a refusal that names the
 * index — never `Array.prototype.map`'s answer.
 *
 * 🔴 The own-read convention stopped at the CONTAINER, and the defect it was
 * written to prevent walked in one level below it. `map`, `flatMap` and
 * `filter` decide whether an index exists with `HasProperty`, which walks the
 * prototype chain: a hole is not skipped when `Object.prototype` carries the
 * matching index, it is FILLED from it. Measured before this was here, with
 * `Object.prototype['0']` planted: `{ arms: new Array(1) }` published a whole
 * arm carrying a fabricated `policyVersion` and a metric mean of 99, and
 * `results: new Array(3)` published `runCount: 3` with a mean of 42 — which is
 * verbatim the scenario the comment on the results own-read below claims to
 * have closed.
 *
 * The cheaper half needs no attacker at all: `{ arms: new Array(2) }` passed
 * the length check and published two `null` arms — rows never parsed, never
 * version-checked, never deduplicated.
 *
 * 🔴 **It returns what it checked, and that is the whole point of the second
 * version of this function.** The first read the element with `Object.hasOwn`
 * plus `values[index]` and returned `void`, so the summarizer read the index
 * AGAIN — and `Object.hasOwn` is true for an own accessor, which `[[Get]]` then
 * invokes. A getter answering with a valid arm and then with `null` produced
 * `TypeError: Cannot convert undefined or null to object`, which is verbatim
 * the bare throw this comment claimed to prevent, reached through the guard.
 * The checked value and the consumed value are now the same value.
 *
 * An own ACCESSOR is refused exactly as a hole is, which is `readOwnValue`'s
 * rule everywhere else in this module: a value a getter computes is not a value
 * the caller wrote down.
 * see budget-policy.test.mjs › "refuses an arms element whose own accessor answers a different value on the second read"
 *
 * ⚠ One forward pass, bounded by the array's own `length`, which is the caller's
 * number: `Array.isArray` is true for a `Proxy` of an array, so `length` can be
 * anything a trap says.
 *
 * **A claimed length alone does not get past this loop.** The descriptor read
 * falls through to the proxy's target, so the first index the target does not
 * own is refused — measured, a one-element target claiming `5e8` throws at index
 * 1. Reaching a claimed length needs a proxy that ALSO fabricates an own
 * descriptor at every index, and that shape does allocate one entry per index.
 * It is a real exposure, stated rather than closed: every caller of this
 * summarizer is in-process, so this is not a trust boundary, and a length cap
 * cheap enough to add here would refuse an honest corpus larger than today's.
 * The two-trap shape is the one the suite builds, one `length` trap short of it:
 * see budget-policy.test.mjs › "publishes the arm its descriptor carried, never the one a second read answers with"
 *
 * ⚠ **This paragraph carried a fabricated figure twice, and the figure it
 * carries now has a row behind it.** The first version said `2**32 - 1` and
 * "run for minutes"; the second said a `length` trap claiming `5e8` exhausts
 * the heap, having measured a proxy with two traps and described one with a
 * single trap. Both were a limits note wider than its measurement, which is the
 * one thing a limits note must never be — it is the guard's own claim about how
 * far it can be trusted.
 *
 * A third version said it had dropped every number while the paragraph above
 * still carried three (`5e8`, `index 1`, `0 ms`), which is the same defect
 * wearing an apology. Two of those are true and now pinned; the timing figure
 * is gone, because the row below bounds the walk and does not pin a duration:
 * see budget-policy.test.mjs › "refuses a proxied arms list at the first unowned index, whatever length it claims"
 * see budget-policy.test.mjs › "refuses an arms list with a hole in it, naming the index"
 * see budget-policy.test.mjs › "refuses a results list whose hole is answered by the prototype, naming the index"
 */
const ownElements = (values: readonly unknown[], what: string): readonly object[] => {
  const owned: object[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(
        `budget policy ${what} has no own value at index ${index}: a hole is answered by the prototype chain, and an accessor answers with whatever it computes — neither is ${what} the caller wrote down`,
      );
    }
    const element = descriptor.value as unknown;
    if (element === null || typeof element !== 'object') {
      throw new Error(
        `budget policy ${what} at index ${index} is ${element === null ? 'null' : typeof element}, not an object: it cannot be read as ${what} and must not be counted as one`,
      );
    }
    owned.push(element);
  }
  return owned;
};

/*
 * Module scope, not per-arm: neither closes over anything, and the summarizer
 * needs `ownNumber` above the stop-kind copy as well as below it.
 */
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
  // `slot.present` as well as the type, symmetric with `ownRecord` above.
  // Correct without it today only because an absent slot carries no `value`
  // key at all — which makes this a guard resting on a detail of another
  // function's return shape rather than on its own check.
  //
  // 🔴 `Number.isFinite`, not `typeof === 'number'`. `NaN` and `Infinity`
  // are numbers, and both serialise to `null` — so admitting them published
  // `mean: null` against a non-zero `exampleCount`, which the comment on
  // `axisEntry` calls the reading this whole report exists to refuse. An
  // unreadable measurement contributes nothing, exactly as an inherited one
  // does, and a key left with no values gets no row.
  // see budget-policy.test.mjs › "excludes a non-finite metric score from the mean it publishes"
  return slot.present && typeof slot.value === 'number' && Number.isFinite(slot.value)
    ? slot.value
    : undefined;
};

/** How long any caller-supplied string may make the refusal that reports it. */
const REFUSED_VALUE_LIMIT = 120;

/**
 * A caller string, cut to the bound without splitting a character.
 *
 * 🔴 One forward pass over CODE POINTS, and it stops at the bound rather than
 * measuring the input first — so a ten-million-character argument costs the
 * same as a short one. Slicing by code UNIT instead cut an astral character in
 * half and left a lone high surrogate in the message: measured, a refusal
 * carrying `'A' + '😀'.repeat(200)` came back with `isWellFormed()` false,
 * which survives an assertion but not a re-encode.
 * see budget-policy.test.mjs › "keeps a truncated refusal well-formed when the value is not ASCII"
 */
const truncateForRefusal = (text: string): string => {
  if (text.length <= REFUSED_VALUE_LIMIT) return text;
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > REFUSED_VALUE_LIMIT) break;
    kept += character;
  }
  return `${kept}…`;
};

/**
 * Name a refused value without asking the caller how it prints.
 *
 * 🔴 **The refusal message is a call site the caller controls, and this is the
 * only one that runs the caller's CODE.** `String(value)` runs `toString`/`Symbol.toPrimitive`
 * — caller code, invoked inside the branch whose whole job is to reject that
 * caller. Three consequences, each measured on the built module before this
 * existed: a null-prototype object threw `TypeError: Cannot convert object to
 * primitive value` and named no field, so the parser's own contract two
 * paragraphs below was false for it; a throwing `Symbol.toPrimitive` replaced
 * the refusal with the caller's own error; and a `toString` returning ten
 * million characters made the refusal ten million characters long.
 *
 * So only values with a string form the caller cannot choose are printed as
 * themselves. Everything else is reported by TYPE, which is what the caller
 * needs anyway — `object` says the field is not a number as surely as any
 * rendering of it would, and a string is truncated because its length is the
 * caller's to pick.
 * see budget-policy.test.mjs › "names the field when a budget value cannot be turned into a string"
 * see budget-policy.test.mjs › "refuses a budget without running the caller code that would describe it"
 * see budget-policy.test.mjs › "keeps a refusal short when the caller decides how its value prints"
 */
const describeRefusedValue = (value: unknown): string => {
  if (value === null) return 'null';
  const type = typeof value;
  // `number` and `boolean` are bounded BY THEIR TYPE — the longest
  // `String(number)` is 24 characters (`-1.7976931348623157e+308`), a boolean
  // is 5, `null` is 4 — so printing them costs nothing the caller chooses.
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'string') return truncateForRefusal(value as string);
  // 🔴 A BIGINT is reported by type, and the first version of this helper got
  // that wrong: it grouped bigint with number as "a string form the caller
  // cannot choose". A bigint's digits are exactly what the caller wrote —
  // measured, `2n ** 20000000n` produced a 6 020 685-character refusal in
  // 1529 ms, the same defect this helper exists to close. Truncating after
  // `toString()` would still ALLOCATE those six megabytes, so the bound has to
  // come before the rendering, and a bigint is never a budget anyway: the
  // caller's whole diagnostic need is the category, which is what every other
  // wrong-category value here already gets.
  // see budget-policy.test.mjs › "bounds a refusal whose value is a bigint the caller sized"
  return type;
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
        `budget policy field ${field} must be an own non-negative safe integer, received ${slot.present ? describeRefusedValue(slot.value) : '(absent, or inherited)'}`,
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
/**
 * ⚠ **Neither arithmetic form is safe on every input this module accepts, and a
 * round was spent learning that.** Sum-then-divide turns `MAX_VALUE` twice into
 * `Infinity`; the running form below turns `MAX_VALUE, -MAX_VALUE` into
 * `-Infinity` and a third reading after them into `NaN`. Both publish a row
 * saying runs measured nothing while they measured something.
 *
 * So the guarantee does not live in the arithmetic. It lives on the OUTPUT, in
 * `axisEntry`: a computed mean that is not finite yields no row, exactly as a
 * key with no owned values yields no row. That is the same rule `ownNumber`
 * applies to inputs, applied where it can actually hold.
 *
 * The running form is kept because it is right on the case a row already pins,
 * not because it is universally right.
 * see budget-policy.test.mjs › "publishes a finite mean when two readings overflow the sum they are averaged through"
 * see budget-policy.test.mjs › "publishes a finite metric mean, or no metric row, when two scores cancel"
 */
const mean = (values: readonly number[]): number =>
  values.reduce(
    (running, value, index) => running + (value - running) / (index + 1),
    0,
  );

/**
 * An entry for a key the runs actually measured, or nothing.
 *
 * ⚠ A key with no owned value is **not reported**, and the length check below
 * is the ONLY thing that holds that — the finite check beside it does not.
 * Measured: the running `mean` returns **`0`** for an empty list, not `NaN`, so
 * dropping the length guard publishes `{ mean: 0, exampleCount: 0 }` — a row
 * asserting a run spent nothing on an axis no run measured. That is worse than
 * the `null` it used to publish, because it is finite and reads as a real zero.
 *
 * This sentence said `mean: NaN` until it was measured. That was true of the
 * sum-then-divide form and stopped being true when the arithmetic changed one
 * round earlier — the hazard it named was the one the finite check would have
 * caught, and the hazard that is actually here is the one it does not.
 * see budget-policy.test.mjs › "reports no row for a key whose every value was inherited"
 */
const axisEntry = (
  key: string,
  values: readonly number[],
): BudgetPolicyAxisEntry | undefined => {
  if (values.length === 0) return undefined;
  const measured = mean(values);
  // The output guard, not a second input guard: `ownNumber` already refused
  // every non-finite READING, and finite readings can still average to one.
  if (!Number.isFinite(measured)) return undefined;
  return { key, mean: measured, exampleCount: values.length };
};

/** Drop the keys that measured nothing, so no empty row is published. */
const measuredEntries = (
  entries: readonly (readonly [string, BudgetPolicyAxisEntry | undefined])[],
): Readonly<Record<string, BudgetPolicyAxisEntry>> =>
  Object.freeze(
    Object.fromEntries(
      entries
        .filter(
          (entry): entry is readonly [string, BudgetPolicyAxisEntry] =>
            entry[1] !== undefined,
        )
        // The row too, not only the record holding it: an unfrozen entry lets a
        // caller assign over a published mean, which is the same rewrite the
        // record-level freeze refuses one level up.
        .map(([key, entry]) => [key, Object.freeze(entry)] as const),
    ),
  );

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
      'a versioned safety cap. It shares the unreached need-more-evidence edge with maxIterations, and the replay-backed arm this benchmark ships declares no llm call, so declaredLlmCallsUsed is 0 on every run OF THAT ARM (see budget-policy.test.mjs \u203a "measures a declared llm call count of zero on every run of the shipped arm") — not on every run the corpus can be driven through, which a wider wording here claimed until it was measured: a fixture that declares drives the same 8 calibration scenarios to a non-zero count on all 24 runs. Nothing measured this value and no benchmark evidence can, until an arm both declares calls and reaches that edge',
  }),
  reservedChallengeBudget: Object.freeze({
    empiricallyCalibrated: false,
    reason:
      'the only budget this corpus reaches, and it still does not calibrate: the challenge cap is two rounds and the corpus uses one, so 1, 2 and 8 are indistinguishable, while 0 stops every run budget-exhausted and moves the accepted v0.1 stop kind — a candidate refused rather than a cheaper policy found',
  }),
});

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

/**
 * Summarise one or more policy arms, per axis, per policy version.
 *
 * Each arm is `{ policy, experiment }` — the policy it ran under and the
 * experiment it produced. Arms are reported in the order given, and two arms
 * declaring one version are refused: rows that cannot be told apart are not
 * evidence about either policy.
 *
 * ⚠ **The limit this function cannot close, stated because it is the widest
 * one here.** That the experiment really ran under the policy beside it is
 * ASSERTED BY THE CALLER, not checked. `BenchmarkExperiment` carries no policy
 * identity, so `{ policy: A, experiment: ranUnderB }` publishes B's runs keyed
 * by A's `policyVersion` and nothing below can detect it — which is the same
 * outcome `parseBenchmarkBudgetPolicy` refuses a fallback to prevent, arriving
 * one layer above where it looks. Every own-read in this file defends against a
 * caller inheriting a value; none defends against a caller mislabelling one.
 *
 * The suite closes it for the arms it runs, outside this module, by observing
 * the control block from inside the graph:
 * see budget-policy.test.mjs › "starts the graph from a caller-supplied budget policy"
 * Closing it HERE means returning the parsed policy from
 * `runGraphBenchmarkExperiment` and reading it off the experiment, which widens
 * a public return type; that is AIC-112, not this function.
 */
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
  const armInputs = ownElements(declaredArms.value, 'arm');

  const seen = new Set<string>();
  const reported = (armInputs as readonly BudgetPolicyArmInput[]).map((entry) => {
    const armPolicy = readOwnValue(entry as object, 'policy');
    const armExperiment = readOwnValue(entry as object, 'experiment');
    if (!armPolicy.present || !armExperiment.present) {
      throw new Error(
        'each budget policy arm must own both a policy and an experiment: an inherited one describes an arm that was never run',
      );
    }
    // 🔴 Present is not readable, and this guard is the difference. `present`
    // is true for an own `experiment: null`, and the field reads below go
    // straight to `Object.getOwnPropertyDescriptor(null, …)` — which threw
    // `TypeError: Cannot convert undefined or null to object`, verbatim the
    // bare throw `ownElements`'s comment above says its second version
    // eliminated. It did, for the arms list; this is the same throw one field
    // over, and the caller learned nothing about which arm to fix.
    // see budget-policy.test.mjs › "names the arm whose experiment is present but is not a readable object"
    if (armExperiment.value === null || typeof armExperiment.value !== 'object') {
      throw new Error(
        `each budget policy arm must own an experiment object: an arm whose experiment is ${describeRefusedValue(armExperiment.value)} declares the field and carries no run under it`,
      );
    }
    const experiment = armExperiment.value as BudgetPolicyArmExperiment;
    const parsed = parseBenchmarkBudgetPolicy(armPolicy.value);
    // 🔴 The version is a CALLER string and it names five refusals below, so an
    // unbounded one lets the caller pick this repository's log line. Measured
    // before this bound: a ten-million-character version produced a 10 000 091
    // -character duplicate-version refusal. Bound once here rather than at each
    // site, so a refusal added later cannot forget it.
    // see budget-policy.test.mjs › "bounds every refusal that names a caller-supplied string"
    const armName = truncateForRefusal(parsed.policyVersion);
    if (seen.has(parsed.policyVersion)) {
      throw new Error(
        `budget policy version ${armName} appears on two arms: two rows under one version cannot be told apart`,
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
        `budget policy arm ${armName} must own a results array: an inherited one is a measurement of runs the caller never handed over`,
      );
    }
    if (
      !ownStopKinds.present ||
      ownStopKinds.value === null ||
      typeof ownStopKinds.value !== 'object' ||
      Array.isArray(ownStopKinds.value)
    ) {
      throw new Error(
        `budget policy arm ${armName} must own a stopKindDistribution record: a distribution read off the prototype describes runs that did not happen, and an owned non-record is republished verbatim under a field declared as a record of counts`,
      );
    }

    const results = ownElements(ownResults.value, 'result') as readonly BudgetPolicyArmResult[];

    // 🔴 The array refusal beside `stopKindDistribution` states its reason
    // generally — an owned non-record "is republished verbatim under a field
    // declared as a record of counts" — and guarded one of the three fields
    // that reason covers. Measured before this loop existed:
    // `resources: [7, 9]` published `resourceAxes` keyed `"0"` and `"1"`, each
    // carrying a mean. An axis named `"0"` is not an axis anybody measured —
    // the name is a position in a list — so the report carried a measurement
    // under a key no run produced, which is the fabricated-measurement reading
    // every own-read here exists to refuse, reached without a prototype.
    // Refused once per result rather than at the four read sites below, so the
    // key-derivation and value paths cannot disagree about it.
    // see budget-policy.test.mjs › "refuses a result whose measurements are a list instead of a record"
    //
    // ⚠ `Array.isArray` sees a real array and nothing else. An array-LIKE object
    // reaches the same outcome by a route this does not close: measured,
    // `resources: { 0: 7, length: 1 }` publishes axes named `"0"` and `"length"`,
    // each with a mean. That predates this loop and is unchanged by it — stated
    // rather than closed, because the shape has no honest producer here and a
    // duck-typed check would start guessing at which records are lists.
    for (const [index, result] of results.entries()) {
      for (const field of ['metrics', 'resources'] as const) {
        const slot = readOwnValue(result as object, field);
        if (slot.present && Array.isArray(slot.value)) {
          throw new Error(
            `budget policy arm ${armName} has a result at index ${index} whose ${field} is a list: a record of measurements keyed by name is not a list of them, and republishing one keys the report by position instead of by what was measured`,
          );
        }
      }
    }
    /**
     * 🔴 The report's OWN copy, with every count checked, not the caller's
     * container republished.
     *
     * Three things were wrong with republishing it, all measured: an ARRAY
     * passed the container check above and came back verbatim under a field
     * declared `Readonly<Record<string, number>>`; the values inside a real
     * object were never checked at all, so `{ sufficient: 'lots' }` came back
     * unchanged; and the returned object was `===` the caller's, unfrozen, so a
     * key added after the report was produced appeared in the published
     * evidence — a record of what happened that keeps changing after it was
     * written.
     *
     * ⚠ The width of what this buys, stated so nobody reads it wider: the
     * report does not change when the CALLER'S object changes. It is an
     * ordinary object, so a key planted on `Object.prototype` afterwards reads
     * through it — as it does through `metrics`, `resourceAxes`, `budgets` and
     * `calibration`, which are ordinary records too. Pollution of the reader's
     * own realm is not something any record in this report defends against.
     * see budget-policy.test.mjs › "publishes the stop-kind distribution as the report's own frozen copy"
     */
    const stopKindDistribution: Readonly<Record<string, number>> = Object.freeze(
      Object.fromEntries(
        Object.keys(ownStopKinds.value).map((stopKind) => {
          // 🔴 `isLogicalCount`, not `ownNumber`. The message below asserts
          // COUNTHOOD — "how many runs stopped each way" — and `ownNumber` asks
          // only for a finite own number, so `-1` and `1.5` were accepted and
          // republished: an arm published `runCount: 3` beside a distribution
          // summing to `0.5`, a report whose own two halves disagree and which
          // no reader can catch from the report alone. The predicate that means
          // what the message says is the one the three budgets already use, and
          // it is defined at the top of this file.
          // see budget-policy.test.mjs › "refuses a stop-kind count that is a finite number but not a count"
          const count = ownNumber(ownStopKinds.value as object, stopKind);
          if (count === undefined || !isLogicalCount(count)) {
            throw new Error(
              `budget policy arm ${armName} has a stopKindDistribution entry ${truncateForRefusal(stopKind)} that is not an own count: a stop-kind distribution is how many runs stopped each way, and anything else republished is a measurement-shaped value the report's own type forbids`,
            );
          }
          return [stopKind, count];
        }),
      ),
    );

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
      metrics: measuredEntries(
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
      resourceAxes: measuredEntries(
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
  // The record as well as the statements in it. Each statement is already
  // frozen where CALIBRATION is declared, so an in-place flip of
  // `empiricallyCalibrated` never took — but this record was not, so the whole
  // entry could be REPLACED, which reaches the same published lie by a route
  // the in-place attempt does not. Measured before this line existed.
  // see budget-policy.test.mjs › "keeps a calibration statement when a caller replaces the whole entry"
  Object.freeze(calibration);

  // Frozen at every level this function builds, for the reason each arm's
  // `budgets` and `stopKindDistribution` are: a report is a record of what
  // happened, and a caller that can rewrite it after it was produced turns
  // published evidence into a working object. An earlier version of this
  // sentence said "at the levels this function builds" while `metrics`,
  // `resourceAxes`, their entries and `calibration` were all left mutable — a
  // caller set a published mean to 999 and injected a metric row no run
  // produced. The row below walks the report rather than naming levels, so a
  // level added later is covered without editing a list.
  // see budget-policy.test.mjs › "freezes every level of a published report, not only the levels named where the freeze is written"
  return Object.freeze({
    arms: Object.freeze(reported.map((arm) => Object.freeze(arm))),
    calibration,
  });
}

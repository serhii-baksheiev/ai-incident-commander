import { ModelCallBudgetExceededError } from './model-errors.js';

/**
 * What one completion spent, as the provider reported it.
 *
 * One axis per field and no axis derived from another — the same rule
 * `BenchmarkResourceEvidence` states in `packages/evals`: a blended number can
 * fall while quality falls with it.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelUsageTotals extends ModelUsage {
  readonly calls: number;
}

export interface ModelUsageLedger {
  /**
   * Refuse the next completion when the cap is spent, without counting anything.
   *
   * Called BEFORE the request is issued, which is what makes the cap a bound on
   * spend rather than a report of it: a lane that checked afterwards would have
   * already paid for the call it then refuses to count.
   * see roles-port-contract.test.mjs › "stops at the declared call cap before
   * issuing the request"
   */
  /**
   * Claim capacity for one completion BEFORE the request goes out.
   *
   * `perCallOutputTokens` is the caller's own budget for the call it is about to
   * make. It is optional and absent means zero, so a caller that does not
   * declare one is bounded by calls alone — a missing measurement is never
   * treated as a real number here.
   */
  reserve(perCallOutputTokens?: number): void;
  /** Charge one completed call. Refuses past the cap for the same reason. */
  record(usage: ModelUsage): void;
  read(): ModelUsageTotals;
}

/**
 * The out-of-band channel through which model consumption reaches the lane.
 *
 * 🔴 **Why out-of-band, and it is a limit rather than a preference.**
 * `declaredLlmCalls` is the ONE channel a lifecycle node reports LLM consumption
 * through, and `preserveGraphOwnedControl` wraps only the ten ordinary lifecycle
 * nodes. `termination_check` and `challenge_hypothesis` return their own
 * decision types and are not wrapped, so `challenge_hypothesis` has no
 * declaration channel at all — `packages/graph/src/investigation.ts` states that
 * as a limit of `InvestigationNodeResult`. Widening the node-result contract to
 * give it one is a Tier-2 change to `GRAPH_OWNED_CONTROL_FIELDS`, pinned by the
 * whole `graph-owned-control-contract.test.mjs` suite, and this item does not
 * make it.
 *
 * So consumption travels twice, asymmetrically, and both halves are real:
 * `generate_hypotheses` and `interpret_residual_evidence` declare through
 * `declaredLlmCalls` as the graph expects AND land in this ledger, while
 * `challenge_hypothesis` lands here only. A lane reading `llmCallsUsed` alone
 * therefore under-reports every challenge round.
 * see roles-model-nodes.test.mjs › "records the challenge role usage in the
 * ledger while the graph counter cannot see it"
 *
 * The cap is enforced here rather than in the lane for the reason the invariants
 * rule gives about bounded work: a budget checked after the spend is a report,
 * not a bound.
 */
export function createModelUsageLedger({
  maxCalls,
  maxOutputTokens,
}: Readonly<{ maxCalls: number; maxOutputTokens?: number }>): ModelUsageLedger {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new Error('a model call cap must be a non-negative safe integer');
  }
  // 🔴 Optional, and ABSENT means unbounded rather than zero.
  //
  // A default here would refuse honest runs nobody asked to bound, and this
  // repository's standing rule is that a missing measurement never becomes a
  // zero. The bound exists because the cap counted CALLS while the per-call
  // token budget was raised beneath it: `DEFAULT_MAX_OUTPUT_TOKENS` went
  // 4096 → 16000 at the AIC-19 gate, taking one hold-out's worst-case output
  // spend from roughly 614k to 2.4M tokens with nothing tracking the quantity
  // that moved. Observed by `security-scanner` and `code-reviewer` separately.
  // see roles-port-contract.test.mjs › "stops reserving once the declared output-token budget is spent, not only once the calls are"
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0)
  ) {
    throw new Error('a model output-token cap must be a non-negative safe integer');
  }

  // 🔴 TWO counters, and the split is the whole point.
  //
  // `reserved` is what the CAP is checked against and `reserve` increments it
  // BEFORE the request. It used to only read `calls`, which nothing incremented
  // until after a response came back, so the cap held for a sequential caller
  // and for no other: N concurrent completions would each see the same
  // pre-request count and all pass. Today's callers are strictly sequential, so
  // that was never a live overrun — but a cap whose correctness depends on how
  // its caller happens to loop is not a cap.
  // Found by `security-scanner` at the AIC-94 gate.
  //
  // `calls` stays what it was: completions this lane may REPORT. A request the
  // provider refused consumed a reservation — it reached the provider and may
  // have been billed — and is deliberately not reported as a completion, which
  // is the distinction the refusal row below pins.
  // see roles-port-contract.test.mjs › "reports a provider refusal as a failed
  // completion rather than an empty one" and › "refuses the call past the
  // declared cap instead of spending it"
  let reserved = 0;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // The token half of the `reserved`/`calls` split above, for the same reason.
  // An in-flight completion has no recorded cost yet, so a cap that reads only
  // `outputTokens` cannot see it: measured at the AIC-19 gate, fifty concurrent
  // reservations against a 1000-token cap were all granted. `reservedOutputTokens`
  // carries the callers' own declared per-call budgets until `record` replaces
  // each estimate with what the completion actually cost.
  let reservedOutputTokens = 0;
  // The estimates awaiting reconciliation, oldest first. Reservations and
  // records pair up in order, so `record` retires the oldest estimate rather
  // than subtracting what the completion cost — subtracting the ACTUAL cost
  // leaves the difference reserved forever, which a first version did: three
  // calls budgeted at 400 and costing 10 stranded 1,170 tokens of headroom.
  // Bounded by `maxCalls`, which is validated above.
  const pendingOutputTokens: number[] = [];

  return {
    reserve(perCallOutputTokens) {
      if (reserved >= maxCalls) throw new ModelCallBudgetExceededError(maxCalls);
      if (maxOutputTokens !== undefined) {
        // The caller's declared budget for the call it is about to make. Absent,
        // the estimate is zero and the bound degrades to the post-hoc check —
        // which is why the port passes it. A pessimistic estimate can only
        // refuse EARLY, never late, and `record` gives the headroom back.
        const estimate =
          perCallOutputTokens === undefined || !Number.isSafeInteger(perCallOutputTokens)
            ? 0
            : Math.max(0, perCallOutputTokens);
        const committed = outputTokens + reservedOutputTokens + estimate;
        if (committed > maxOutputTokens) {
          throw new Error(
            `the declared output-token budget is spent (${outputTokens} recorded plus ${reservedOutputTokens + estimate} reserved, against ${maxOutputTokens}, across ${calls} completions): refusing the next call rather than continuing, because the per-call token budget is not what bounds a run's cost`,
          );
        }
        reservedOutputTokens += estimate;
        pendingOutputTokens.push(estimate);
      }
      reserved += 1;
    },
    record(usage) {
      // 🔴 Validated here, not trusted. A negative count drives the accumulator
      // backwards and disables the token bound permanently — measured at the
      // AIC-19 gate. The real caller validates first (`requireOwnCount` in the
      // port), so this is the guard for every OTHER caller, present and future.
      for (const key of ['inputTokens', 'outputTokens'] as const) {
        const value = usage[key];
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(
            `a model usage record needs a non-negative safe integer ${key}: a count that is not one cannot be added to a total that bounds spend`,
          );
        }
      }
      // A caller that records without reserving still cannot exceed the CALL
      // cap. It can exceed the token cap, because nothing reserved for it — the
      // token bound is enforced at reservation, which is the only point before
      // the money is spent.
      if (calls >= maxCalls) throw new ModelCallBudgetExceededError(maxCalls);
      if (reserved <= calls) reserved = calls + 1;
      calls += 1;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      // Retire the oldest outstanding estimate — this completion's — so the
      // headroom it held returns. Never below zero: a caller that recorded
      // without reserving must not mine headroom out of other reservations.
      const estimate = pendingOutputTokens.shift() ?? 0;
      reservedOutputTokens = Math.max(0, reservedOutputTokens - estimate);
    },
    read() {
      return { calls, inputTokens, outputTokens };
    },
  };
}

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
  reserve(): void;
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
}: Readonly<{ maxCalls: number }>): ModelUsageLedger {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new Error('a model call cap must be a non-negative safe integer');
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

  return {
    reserve() {
      if (reserved >= maxCalls) throw new ModelCallBudgetExceededError(maxCalls);
      reserved += 1;
    },
    record(usage) {
      // A caller that records without reserving still cannot exceed the cap.
      if (calls >= maxCalls) throw new ModelCallBudgetExceededError(maxCalls);
      if (reserved <= calls) reserved = calls + 1;
      calls += 1;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    },
    read() {
      return { calls, inputTokens, outputTokens };
    },
  };
}

import {
  deriveHypothesisStatus,
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
  type HypothesisStatus,
  type IncidentState,
} from '@aic/domain';
import {
  createInvestigationGraph,
  type InvestigationNodes,
} from '@aic/graph';

import {
  BENCHMARK_PRIMARY_SCOPE,
  opaqueIncidentId,
  runBenchmarkExperiment,
  type BenchmarkEvaluation,
  type BenchmarkExecutionInput,
  type BenchmarkExperiment,
  type BenchmarkOutcome,
  type BenchmarkPlanOptions,
  type BenchmarkRecord,
  type BenchmarkScenarioSelection,
  type MeasuredBenchmarkResources,
} from './benchmark-evaluation.js';
import type { ChallengeEffectObservation } from './behavior-evaluators.js';
import {
  BENCHMARK_BUDGET_POLICY,
  parseBenchmarkBudgetPolicy,
  type BenchmarkBudgetPolicy,
} from './budget-policy.js';

/**
 * The graph arm's benchmark runner: the investigation graph executed over a
 * benchmark record, and its final state projected into the outcome the
 * evaluators score.
 *
 * A module of its own so that the generic runner and the evaluators in
 * `benchmark-evaluation.ts` import no orchestration code: the naive arm is
 * built on them and must not reach the graph.
 * see naive-arm.test.mjs › "packages/evals/src/benchmark-evaluation.ts imports no @aic/graph"
 */

function initialBenchmarkState(
  input: BenchmarkExecutionInput,
  budgetPolicy: BenchmarkBudgetPolicy,
): IncidentState {
  if (input.metadata.statusRulesVersion !== STATUS_RULES_VERSION) {
    throw new Error('benchmark status-rules version does not match the graph');
  }

  return {
    incident: {
      id: opaqueIncidentId(input.runId),
      primaryScope: BENCHMARK_PRIMARY_SCOPE,
    },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: input.runId,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'normalizing',
      // From the policy the experiment declared, not from three literals here:
      // a budget nobody can vary is a budget nobody can measure, which is how
      // these three came to be unexamined in the first place (AIC-18).
      maxIterations: budgetPolicy.maxIterations,
      llmCallBudget: budgetPolicy.llmCallBudget,
      reservedChallengeBudget: budgetPolicy.reservedChallengeBudget,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

function outcomeFromGraphState(
  state: IncidentState,
  challengeEffect?: ChallengeEffectObservation,
): BenchmarkOutcome {
  if (state.control.stopKind === undefined || state.conclusion === undefined) {
    throw new Error('benchmark graph must produce a stop kind and conclusion');
  }

  const observedEvidenceIds = new Set(state.evidence.map(({ id }) => id));
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  // What the run referenced, as opposed to what it collected: the graph replays
  // every fixture entry, so collection alone would credit every run with every
  // item. Causes first, then assessments, deduplicated in first-reference order.
  const referencedEvidenceIds = [
    ...new Set(
      [
        ...state.conclusion.causes.flatMap(({ evidenceIds }) => evidenceIds),
        ...state.assessments.map(({ evidenceId }) => evidenceId),
      ].filter((evidenceId) => observedEvidenceIds.has(evidenceId)),
    ),
  ];
  return {
    claims: state.conclusion.causes.map(({ evidenceIds }) => ({ evidenceIds })),
    supportingEvidenceIds: state.conclusion.causes.flatMap(({ evidenceIds }) =>
      evidenceIds.filter((evidenceId) => observedEvidenceIds.has(evidenceId)),
    ),
    evidenceFingerprints: state.evidence.map(({ kind, source, statement }) => ({
      kind,
      source,
      predicate: statement,
    })),
    referencedEvidenceIds,
    stopKind: state.control.stopKind,
    conclusionKind: state.conclusion.kind,
    rootCause: state.conclusion.causes[0]?.cause,
    rootCauseHypothesisId: state.conclusion.causes[0]?.hypothesisId,
    evidenceAssessments: state.assessments.flatMap((assessment) => {
      const evidence = evidenceById.get(assessment.evidenceId);
      return evidence === undefined
        ? []
        : [{
            fingerprint: {
              kind: evidence.kind,
              source: evidence.source,
              predicate: evidence.statement,
            },
            evidenceId: evidence.id,
            hypothesisId: assessment.hypothesisId,
            effect: assessment.effect,
          }];
    }),
    challengeEffect,
  };
}

function hypothesisStatus(
  state: IncidentState,
  hypothesisId: string | undefined,
): HypothesisStatus | undefined {
  if (
    hypothesisId === undefined ||
    !state.hypotheses.some(({ id }) => id === hypothesisId)
  ) {
    return undefined;
  }
  return deriveHypothesisStatus({
    hypothesisId,
    predictions: state.predictions,
    assessments: state.assessments,
    evidence: state.evidence,
  });
}

export type GraphBenchmarkExperimentOptions = BenchmarkPlanOptions &
  BenchmarkScenarioSelection &
  Readonly<{
    /**
     * What this experiment allows a run to spend. Omitted, inherited rather than
     * owned, or supplied as an own `undefined` — which is the same thing while
     * this project does not set `exactOptionalPropertyTypes` — it is the
     * shipped `BENCHMARK_BUDGET_POLICY`.
     * An own ACCESSOR is refused outright, before any parse and whatever it
     * would have computed: a policy a getter produces is not one this caller
     * wrote down, and the version it keys published rows by would name a run
     * nobody declared. Any other value is parsed and refused if it cannot be
     * read; `null` in particular is a refusal, not a default.
     *
     * Four states, and the block at the read site says why each is what it is.
     *
     * ⚠ Only the GRAPH runner takes this. `runBenchmarkExperiment` drives an
     * opaque `investigate` callback and starts no graph, so a policy handed to
     * it would reach no control block and could not be observed — an option
     * that silently does nothing is worse than one that does not exist.
     */
    budgetPolicy?: BenchmarkBudgetPolicy;
    createNodes(input: BenchmarkExecutionInput): InvestigationNodes;
    recordEvaluation(payload: Readonly<{
      record: BenchmarkRecord;
      result: BenchmarkEvaluation;
    }>): Promise<void>;
  }>;

export async function runGraphBenchmarkExperiment(
  options: GraphBenchmarkExperimentOptions,
): Promise<BenchmarkExperiment> {
  // Parsed BEFORE anything runs: a malformed policy must not be discovered
  // halfway through a corpus, with some runs already recorded under a version
  // the experiment never executed.
  // The refusal rows are generated from a table, so grep the MALFORMED_POLICIES
  // labels in budget-policy.test.mjs rather than a whole test name.
  //
  // `Object.hasOwn` rather than `??`: an ABSENT option is the fail-open case and
  // takes the shipped policy, while an option PRESENT in a shape this runner
  // cannot read is the refusal case. `?? BENCHMARK_BUDGET_POLICY` cannot tell
  // those apart, so an explicit `null` ran the whole corpus under a policy the
  // caller never asked for -- measured, and it is why these two states are now
  // separated.
  // see the MALFORMED_POLICIES label "an explicitly null policy" in budget-policy.test.mjs
  // ⚠ Four states, not two, and each of the last three cost a review round.
  //
  //   ABSENT (omitted, or inherited)  -> the shipped policy. Nothing was asked
  //                                      for, so there is nothing to refuse.
  //   own `undefined`                 -> also absent. Without
  //                                      `exactOptionalPropertyTypes` this is
  //                                      TypeScript's own spelling of an
  //                                      omitted optional property, so refusing
  //                                      it makes the declared type lie — and
  //                                      the suite's own helper had to spread
  //                                      around the refusal, which is the trap
  //                                      showing itself.
  //   own ACCESSOR                    -> REFUSED. A getter is present in a shape
  //                                      this reader does not accept, and
  //                                      `.claude/rules/invariants.md` calls that
  //                                      the refusal case. It was silently
  //                                      treated as absent until a review round
  //                                      measured it: the seam never asked the
  //                                      getter, and the corpus ran under the
  //                                      shipped policy while the caller
  //                                      believed it had supplied one.
  //   own `null`, or any other value  -> PARSED, and refused if unreadable. A
  //                                      caller that computed a policy and got
  //                                      `null` asked for something; running the
  //                                      corpus under the shipped policy while
  //                                      it believes otherwise is the fail-open
  //                                      this seam already had once.
  //
  // Own-read for the same reason the policy's own fields are own-read.
  // see the MALFORMED_POLICIES label "an explicitly null policy" in budget-policy.test.mjs
  // see budget-policy.test.mjs › "starts from the shipped policy when budgetPolicy is present but undefined"
  // see budget-policy.test.mjs › "starts from the shipped policy when budgetPolicy is only inherited"
  // see budget-policy.test.mjs › "refuses a budgetPolicy option that is an own accessor"
  const declaredPolicy = Object.getOwnPropertyDescriptor(options, 'budgetPolicy');
  if (declaredPolicy !== undefined && !Object.hasOwn(declaredPolicy, 'value')) {
    throw new Error(
      'budget policy option must be a value this caller wrote down, not an accessor: a policy a getter computes is not a policy the experiment can publish a version for',
    );
  }
  const budgetPolicy =
    declaredPolicy === undefined || declaredPolicy.value === undefined
      ? BENCHMARK_BUDGET_POLICY
      : parseBenchmarkBudgetPolicy(declaredPolicy.value);

  // Keyed by runId rather than returned through `investigate`, so the evidence
  // travels a path the opaque callback contract cannot reach.
  const measuredByRunId = new Map<string, MeasuredBenchmarkResources>();

  return runBenchmarkExperiment({
    ...options,
    collectResources: (input) => measuredByRunId.get(input.runId),
    async investigate(input) {
      const nodes = options.createNodes(input);
      let challengeInvocationCount = 0;
      let leaderBeforeChallengeId: string | undefined;
      let leaderAfterChallengeId: string | undefined;
      let leaderStatusBeforeChallenge: HypothesisStatus | undefined;
      let leaderStatusAfterChallenge: HypothesisStatus | undefined;
      const discriminatingTestIds = new Set<string>();
      const graph = createInvestigationGraph({
        nodes: {
          ...nodes,
          async termination_check(state) {
            const decision = await nodes.termination_check(state);
            const isPreChallengeDecision =
              decision.route === 'challenge-required' ||
              (decision.route === 'terminal' &&
                decision.stopKind === 'sufficient' &&
                state.control.challengeRounds === 0);
            if (isPreChallengeDecision && leaderBeforeChallengeId === undefined) {
              leaderBeforeChallengeId = decision.leaderId;
              leaderStatusBeforeChallenge = hypothesisStatus(
                state,
                decision.leaderId,
              );
            }
            if (
              decision.route === 'terminal' &&
              decision.stopKind === 'sufficient' &&
              state.control.challengeRounds > 0
            ) {
              leaderAfterChallengeId = decision.leaderId;
              leaderStatusAfterChallenge = hypothesisStatus(
                state,
                decision.leaderId,
              );
            }
            return decision;
          },
          async challenge_hypothesis(state, leaderId) {
            challengeInvocationCount += 1;
            const result = await nodes.challenge_hypothesis(state, leaderId);
            for (const test of result.discriminatingTests) {
              discriminatingTestIds.add(test.id);
            }
            return result;
          },
        },
      });
      const finalState = await graph.execute({
        kind: 'start',
        state: initialBenchmarkState(input, budgetPolicy),
      });
      measuredByRunId.set(input.runId, {
        // The line that matters is WHO ORIGINATED THE NUMBER, not which channel
        // the graph owns — the graph owns the control block either way.
        //
        // Originated by the graph, and therefore an observation: this one and
        // `resumeCount` below. The graph increments both itself and a node's
        // update cannot write either.
        logicalIterationsUsed: finalState.control.iterationsUsed,
        // ⚠ Originated by the NODE. The graph owns the accumulation and
        // validates each addition, but the number added is whatever the node
        // declared — `declaredLlmCalls` is a declaration, not a write. In a
        // benchmark the node is the system under test, so this axis is as
        // trustworthy as the fixture, exactly like `toolCallsUsed` below. It is
        // recorded because a declared count is the only honest thing to record
        // while no provider exists to observe instead.
        declaredLlmCallsUsed: finalState.control.llmCallsUsed,
        // ⚠ Also node-originated, and more directly: `trials` is a node-written
        // channel — `execute_investigation` puts them there and the reducer
        // upserts them unparsed. Measured here because the item asks for "tool
        // calls/trials used" and this graph has no independent tool-call channel
        // to read instead.
        //
        // What this counts is trials, so its meaning depends on the producer's
        // trial-id convention: a trial retried under one id upserts in place and
        // counts once, while a fresh id per attempt counts each. Stated because
        // the number this axis reports once a retry path lands is decided by
        // that convention, not by this code.
        toolCallsUsed: finalState.trials.length,
        // Derived from the executed state, not asserted: a literal zero would
        // keep reading zero on the day a retry path lands, which is the
        // "spent nothing on that axis" reading this evidence must never
        // manufacture. It is zero today because nothing retries.
        retryCount: finalState.trials.filter(({ attempt }) => attempt > 1).length,
        resumeCount: finalState.control.resumeCount,
      });
      return outcomeFromGraphState(finalState, {
        challengeNodeExecuted: challengeInvocationCount > 0,
        challengeInvocationCount,
        leaderBeforeChallengeId,
        leaderAfterChallengeId,
        leaderStatusBeforeChallenge,
        leaderStatusAfterChallenge,
        // Counted only when the trial SUCCEEDED. `Trial.status` is
        // 'ok' | 'unavailable' | 'error', and only `ok` produced evidence the
        // investigation could act on — a tool that was unavailable, or errored,
        // discriminated nothing. The evaluator reads a non-zero count as "the
        // challenge changed the investigation" on its own axis
        // (`evaluateChallengeEffect`, behavior-evaluators.ts), so counting a
        // failed trial here credits a challenge that produced no evidence —
        // see behavior-evaluators.test.mjs › "does not credit a discriminating
        // trial that ended in error" and › "does not credit a discriminating
        // trial whose tool was unavailable", one per status this excludes.
        //
        // Deliberately narrower than `toolCallsUsed` above, which counts every
        // trial because a failed attempt still SPENT the resource it reports.
        // Success is the question here; spend is the question there.
        executedDiscriminatingTrialCount: finalState.trials.filter(
          ({ testId, status }) =>
            status === 'ok' && discriminatingTestIds.has(testId),
        ).length,
      });
    },
  });
}


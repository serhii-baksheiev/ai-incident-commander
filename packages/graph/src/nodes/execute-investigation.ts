import {
  InvestigationTestSchema,
  TrialSchema,
  type Evidence,
  type EvidenceProvenance,
  type IncidentState,
  type InvestigationTest,
  type Trial,
} from '@aic/domain';

import { ingestEvidence } from '../evidence-ingestion.js';
import { deriveTrialId } from '../identity.js';
import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';
import type { ExecuteInvestigationContext } from '../index.js';

/**
 * The three outcomes one `execute` call can report — the same shape as
 * `ToolResult<Evidence[]>` in `packages/tools/src/contracts.ts`, restated here
 * rather than imported, because `@aic/graph` does not build against
 * `@aic/tools`: `packages/graph/package.json` declares no such dependency and
 * `packages/graph/tsconfig.json` references no tools project, so an import
 * fails the build. The two copies are held together by a compiled
 * correspondence check — see execute-investigation-outcome-type-contract.test.mjs
 * › "keeps the executor port's outcome type in step with the tool adapters'
 * ToolResult: every tool result is accepted and both name the same statuses".
 */
export type ExecuteInvestigationOutcome =
  | { status: 'ok'; output: readonly Evidence[]; provenance?: EvidenceProvenance }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string };

/**
 * AIC-125 slice B: the canonical `execute_investigation` node.
 *
 * It runs only the tests still in state `planned`, in state order, and never
 * calls `execute` for a test in any other status — see
 * investigation-execution.test.mjs › "createExecuteInvestigation({execute})
 * calls execute for nothing and returns empty tests, trials and evidence when
 * no test is planned" and › "runs only the tests with status planned, in
 * state order, and never calls execute for executed, unavailable or failed
 * tests".
 *
 * Each executed test's trial identity comes from `deriveTrialId`
 * (`../identity.js`, exported by `@aic/graph`), with `attempt` one more
 * than the highest attempt already in state for that test's id, so a new
 * trial never lands on an existing trial id — see › "derives attempt as 1
 * plus the highest attempt already in state for that test's id", › "derives
 * attempt past the highest recorded attempt when a test's attempts are not
 * contiguous, so a new trial never lands on an existing trial id" and ›
 * "derives the trial id from the same identity formula
 * deriveTrialId uses: sha256 of JSON.stringify([runId, testId, attempt])" and
 * › "two planned tests sharing the same tool and input get distinct trial ids,
 * derived from their own test id".
 *
 * The three `ExecuteInvestigationOutcome` variants map onto a trial, a test
 * status and an evidence list exactly matching `projectToolResult`'s
 * `test.status` transitions in `packages/tools/src/contracts.ts` (`ok` ->
 * `executed`, `unavailable` -> `unavailable`, `error` -> `failed`) — but this
 * node never derives predictions or assessments, unlike that function's
 * `unavailable` arm: this slice's executor is deliberately silent on both
 * keys — see › "on an ok result: records an ok trial, emits new evidence
 * re-stamped with the trial id, marks the test executed, and touches neither
 * predictions nor assessments", › "on an ok result naming no evidence:
 * records an ok trial with empty evidenceIds and emits no evidence", › "on an
 * unavailable result: records an unavailable trial with no evidenceIds, emits
 * no evidence, and marks the test unavailable" and › "on an error result:
 * records an error trial with no evidenceIds, emits no evidence, and marks
 * the test failed". `durationMs` is always 0: a replay measures nothing, and
 * this node has no clock of its own to measure a live call with either.
 *
 * Every newly emitted evidence item is re-stamped with the trial id that
 * produced it, and an evidence id already held in state — or already claimed
 * earlier in this same call, by an earlier test's trial — is never re-emitted
 * and never credited to a second trial: that is what keeps
 * `trialEvidenceViolations` (`@aic/domain`) finding nothing on the result —
 * see › "on an ok result: an evidence item already held in state is not
 * re-emitted and keeps its original trialId", › "two planned tests with the
 * same tool and input: when execute returns evidence sharing a
 * content-derived id for both, only the first test's trial claims it and the
 * second's evidenceIds is empty" and › "applying the first call's result to
 * state by id (upsert) and calling again is idempotent: the second call
 * executes nothing, and trialEvidenceViolations over the resulting state
 * finds no violations".
 *
 * A thrown `execute` error propagates rather than being swallowed — see ›
 * "propagates a thrown error from execute instead of swallowing it".
 *
 * Lane wiring — which graph edge calls this node — is a later slice's
 * concern, not this one's, matching `createDerivePredictions` and
 * `createEvaluatePredictions` (`./derive-predictions.js`,
 * `./evaluate-predictions.js`).
 */
export function createExecuteInvestigation({
  execute,
}: Readonly<{
  execute(context: ExecuteInvestigationContext): Promise<ExecuteInvestigationOutcome>;
}>): InvestigationNode {
  return async (state: IncidentState): Promise<InvestigationNodeResult> => {
    const plannedTests = state.tests.filter((test) => test.status === 'planned');
    if (plannedTests.length === 0) {
      return { tests: [], trials: [], evidence: [] };
    }

    const highestAttemptByTestId = new Map<string, number>();
    for (const trial of state.trials) {
      highestAttemptByTestId.set(
        trial.testId,
        Math.max(highestAttemptByTestId.get(trial.testId) ?? 0, trial.attempt),
      );
    }

    // Evidence already held in state, plus every id claimed earlier in this
    // same call — both must be excluded from re-emission and from a second
    // trial's evidenceIds, or a replayed/duplicated tool answer would be
    // credited to two trials at once.
    const claimedEvidenceIds = new Set(state.evidence.map((item) => item.id));

    const tests: InvestigationTest[] = [];
    const trials: Trial[] = [];
    const evidence: Evidence[] = [];

    for (const test of plannedTests) {
      const attempt = (highestAttemptByTestId.get(test.id) ?? 0) + 1;
      const trialId = deriveTrialId({ runId: state.control.runId, testId: test.id, attempt });
      const trialBase = {
        id: trialId,
        runId: state.control.runId,
        testId: test.id,
        attempt,
        tool: test.tool,
        input: test.input,
        // A replay measures nothing, and this node has no clock of its own
        // to measure a live call with either.
        durationMs: 0,
      };

      const outcome = await execute({
        runId: state.control.runId,
        testId: test.id,
        attempt,
        tool: test.tool,
        input: test.input,
      });

      if (outcome.status === 'ok') {
        const evidenceIds: string[] = [];
        for (const item of outcome.output) {
          if (claimedEvidenceIds.has(item.id)) continue;
          claimedEvidenceIds.add(item.id);
          evidenceIds.push(item.id);
          // Provenance travels alongside the outcome, never inside an item:
          // an item carrying its own `provenance` is refused outright by
          // `ingestEvidence`, and a well-formed `outcome.provenance` is
          // stamped onto every newly recorded item exactly as given — see
          // investigation-execution.test.mjs › "on an ok result: an evidence
          // item carrying its own provenance is refused, naming the evidence
          // id, and nothing is recorded (AIC-146 b2)" and › "on an ok result:
          // a well-formed provenance block on the outcome is stamped onto
          // every newly recorded evidence item, exactly as given (AIC-146
          // b2)".
          evidence.push(ingestEvidence({ item, trialId, provenanceSource: outcome }));
        }
        trials.push(TrialSchema.parse({ ...trialBase, status: 'ok', evidenceIds }));
        tests.push(InvestigationTestSchema.parse({ ...test, status: 'executed' }));
        continue;
      }

      if (outcome.status === 'unavailable') {
        trials.push(TrialSchema.parse({ ...trialBase, status: 'unavailable', evidenceIds: [] }));
        tests.push(InvestigationTestSchema.parse({ ...test, status: 'unavailable' }));
        continue;
      }

      trials.push(TrialSchema.parse({ ...trialBase, status: 'error', evidenceIds: [] }));
      tests.push(InvestigationTestSchema.parse({ ...test, status: 'failed' }));
    }

    return { tests, trials, evidence };
  };
}

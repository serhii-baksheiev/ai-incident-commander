import { deriveHypothesisStatus, type IncidentState } from '@aic/domain';

/**
 * The six-key summary object `aic investigate` prints on completion — moved
 * out of `investigate.ts`'s `runInvestigate` (AIC-146 slice c4a) so the
 * upcoming `aic incident investigate` command (slice c4b) prints the same
 * shape without a second copy of it
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 * see cli-shared-pieces.test.mjs › "summarizeInvestigation(runId, finalState)
 * returns exactly the six keys runId, stopKind, trials, evidence,
 * hypotheses, conclusion, in that order, for a final state with no
 * hypotheses"
 */
export function summarizeInvestigation(runId: string, finalState: IncidentState) {
  const hypotheses = finalState.hypotheses.map((hypothesis) => ({
    id: hypothesis.id,
    status: deriveHypothesisStatus({
      hypothesisId: hypothesis.id,
      predictions: finalState.predictions,
      assessments: finalState.assessments,
      evidence: finalState.evidence,
      rulesVersion: finalState.control.statusRulesVersion,
    }),
  }));

  return {
    runId,
    stopKind: finalState.control.stopKind ?? null,
    trials: finalState.trials.length,
    evidence: finalState.evidence.map((item) => item.id),
    hypotheses,
    conclusion: finalState.conclusion ?? null,
  };
}

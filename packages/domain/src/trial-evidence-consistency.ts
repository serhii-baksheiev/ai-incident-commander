import type { Evidence, Trial } from './contracts.js';
import { quoteModelText } from './conclusion-rules.js';

/**
 * AIC-125 slice B: the pure checker for `Trial.evidenceIds` <-> `Evidence.trialId`
 * consistency an `IncidentState`'s `trials` and `evidence` channels must always
 * satisfy. Given both arrays, it reports every place they disagree about which
 * trial produced which evidence item and nothing else — it never throws on
 * well-shaped input, and an empty result means the two channels are consistent.
 *
 * Three disagreements are reported, one violation string per finding:
 *
 * - an evidence item whose `trialId` names no trial in `trials` — see
 *   investigation-execution.test.mjs › "trialEvidenceViolations reports an
 *   evidence item whose trialId names no trial in the given trials";
 * - a trial whose `evidenceIds` names an id absent from `evidence` — see
 *   investigation-execution.test.mjs › "trialEvidenceViolations reports a
 *   trial whose evidenceIds lists an id not present in the given evidence";
 * - a trial claiming an evidence item whose own `trialId` names a different
 *   trial — see investigation-execution.test.mjs › "trialEvidenceViolations
 *   reports a trial listing an evidence item whose trialId names a different
 *   trial".
 *
 * A consistent pair, and the empty-input case, report nothing — see
 * investigation-execution.test.mjs › "trialEvidenceViolations returns no
 * violations for a mutually consistent set of trials and evidence" and ›
 * "trialEvidenceViolations returns no violations when there are no trials and
 * no evidence at all".
 *
 * Every id named in a violation is escaped and truncated with the same
 * domain-wide convention `conclusion-rules.ts`'s `quoteModelText` already
 * uses for a model-supplied value, so a hostile trial or evidence id can
 * neither inject text into the message nor make it unbounded — see
 * investigation-execution.test.mjs › "trialEvidenceViolations escapes and
 * truncates a hostile trialId in its message, the same way other domain
 * refusals do".
 */
export function trialEvidenceViolations({
  trials,
  evidence,
}: Readonly<{
  trials: readonly Trial[];
  evidence: readonly Evidence[];
}>): string[] {
  const violations: string[] = [];
  const trialsById = new Map(trials.map((trial) => [trial.id, trial]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  for (const item of evidence) {
    if (!trialsById.has(item.trialId)) {
      violations.push(
        `evidence ${quoteModelText(item.id)} points at trial ${quoteModelText(item.trialId)}, which is not among the given trials`,
      );
    }
  }

  for (const trial of trials) {
    for (const evidenceId of trial.evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (item === undefined) {
        violations.push(
          `trial ${quoteModelText(trial.id)} claims evidence ${quoteModelText(evidenceId)}, which is not among the given evidence`,
        );
        continue;
      }
      if (item.trialId !== trial.id) {
        violations.push(
          `trial ${quoteModelText(trial.id)} claims evidence ${quoteModelText(evidenceId)}, but that evidence names trial ${quoteModelText(item.trialId)} instead`,
        );
      }
    }
  }

  return violations;
}

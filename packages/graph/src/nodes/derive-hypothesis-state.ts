import {
  assessmentReferenceViolation,
  deriveHypothesisStanding,
  type IncidentState,
} from '@aic/domain';

import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';

/**
 * AIC-119 slice 2 (owner ruling D1, item 4; plan section 2e): the canonical
 * `derive_hypothesis_state` node.
 *
 * It calls `deriveHypothesisStanding` (`@aic/domain`) under
 * `state.control.statusRulesVersion`, so `derive_hypothesis_state` and
 * `termination_check` (`./termination.js`) read the same status and leader
 * rather than each deriving its own (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation").
 *
 * It returns `{}`: there is no status channel on `IncidentState`, and adding
 * one would be a schema version bump this slice deliberately does not make
 * (plan section 2e).
 *
 * Before deriving, it refuses state whose assessments name evidence, a
 * hypothesis, or a prediction of that hypothesis that the investigation does
 * not hold, through the domain's `assessmentReferenceViolation`. The refusal
 * names the offending id escaped and truncated, because an assessment id can
 * originate from a model role. Checking first, rather than reading the id out
 * of whatever the derivation throws, also covers the unknown hypothesis, which
 * the derivation skips silently.
 * see derive-hypothesis-state.test.mjs › "derive_hypothesis_state refuses an assessment naming evidence the state does not carry, naming the id escaped"
 * see derive-hypothesis-state.test.mjs › "derive_hypothesis_state refuses an assessment naming a hypothesis the state does not carry, which status derivation alone would skip"
 * see derive-hypothesis-state.test.mjs › "derive_hypothesis_state refuses an assessment naming a prediction that belongs to another hypothesis"
 */
export function createDeriveHypothesisState(): InvestigationNode {
  return (state: IncidentState): InvestigationNodeResult => {
    const violation = assessmentReferenceViolation(state);
    if (violation !== undefined) {
      throw new Error(`derive_hypothesis_state: ${violation}`);
    }

    deriveHypothesisStanding(
      {
        hypotheses: state.hypotheses,
        predictions: state.predictions,
        assessments: state.assessments,
        evidence: state.evidence,
      },
      { rulesVersion: state.control.statusRulesVersion },
    );

    return {};
  };
}

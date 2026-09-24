import { deriveHypothesisStanding, quoteModelText, type IncidentState } from '@aic/domain';

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
 * (plan section 2e). The node exists to fail loudly, once, on a dangling
 * reference — an assessment naming an evidence or prediction id the state
 * does not carry — before `termination_check` would otherwise have to
 * re-derive the same standing and hit the same domain error itself.
 *
 * `deriveHypothesisStatus` (`evaluation.ts`) throws a plain `Error` on a
 * dangling reference, with the offending id appended after the message's
 * last `": "`. This node extracts exactly that id and re-throws with it
 * escaped and truncated through `quoteModelText` (`@aic/domain`) — the same
 * treatment every other model-supplied value gets before it is named in a
 * thrown message, because an assessment id can originate from a model role
 * and must not inject text into the failure it is reported through. Any
 * other domain error (for example an unrecognised status-rules version) does
 * not match that shape and is re-thrown unchanged.
 */

const DANGLING_REFERENCE_ID_PATTERN = /: ([^:]+)$/;

function danglingReferenceIdOf(message: string): string | undefined {
  return DANGLING_REFERENCE_ID_PATTERN.exec(message)?.[1];
}

export function createDeriveHypothesisState(): InvestigationNode {
  return (state: IncidentState): InvestigationNodeResult => {
    try {
      deriveHypothesisStanding(
        {
          hypotheses: state.hypotheses,
          predictions: state.predictions,
          assessments: state.assessments,
          evidence: state.evidence,
        },
        { rulesVersion: state.control.statusRulesVersion },
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;

      const danglingId = danglingReferenceIdOf(error.message);
      if (danglingId === undefined) throw error;

      throw new Error(
        `derive_hypothesis_state: dangling reference ${quoteModelText(danglingId)}`,
      );
    }

    return {};
  };
}

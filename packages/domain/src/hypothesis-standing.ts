import { deriveHypothesisStatus } from './evaluation.js';
import { STATUS_RULES, type StatusRulesVersion } from './status-rules.js';
import type {
  Evidence,
  EvidenceAssessment,
  Hypothesis,
  HypothesisStatus,
  Prediction,
} from './contracts.js';

/**
 * AIC-119 slice 2 (owner ruling D1, item 4; plan section 2a): the ONE place
 * a hypothesis's derived status is turned into a ranking and a leader, so
 * `derive_hypothesis_state` and `termination_check`
 * (`packages/graph/src/nodes`) read the same answer rather than each keeping
 * its own ranking rule (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation").
 *
 * Pure: no clock, env or I/O — every input is a plain value already on
 * `IncidentState`, and the status per hypothesis is delegated to the
 * existing `deriveHypothesisStatus`, never re-derived by hand.
 */

export interface DeriveHypothesisStandingInput {
  readonly hypotheses: readonly Hypothesis[];
  readonly predictions: readonly Prediction[];
  readonly assessments: readonly EvidenceAssessment[];
  readonly evidence: readonly Evidence[];
}

export interface DeriveHypothesisStandingOptions {
  readonly rulesVersion: StatusRulesVersion;
}

export interface HypothesisStanding {
  readonly id: string;
  readonly status: HypothesisStatus;
}

export interface HypothesisStandingResult {
  readonly standings: readonly HypothesisStanding[];
  readonly leaderId: string | undefined;
}

/**
 * Rank order used to name a leader among derived hypothesis statuses,
 * highest to lowest: supported, corroborated, candidate, weakened, rejected.
 * A PROCEDURAL target for naming which hypothesis a challenge or a
 * sufficiency decision names, never a confidence score.
 * see hypothesis-standing.test.mjs › "ranks every hypothesis status from
 * supported down to rejected and leads with the highest-ranked one,
 * regardless of state order"
 */
const STANDING_RANK: Readonly<Record<HypothesisStatus, number>> = {
  supported: 0,
  corroborated: 1,
  candidate: 2,
  weakened: 3,
  rejected: 4,
};

/**
 * Derives every hypothesis's status under `rulesVersion` and names the
 * leader: the highest-ranked hypothesis by `STANDING_RANK`, ties going to
 * the earlier hypothesis in `hypotheses` order (never to the hypothesis id)
 * — see hypothesis-standing.test.mjs › "keeps the earlier hypothesis in
 * state order as leader when ranks tie, never breaking the tie by id". An
 * unrecognised `rulesVersion` throws rather than silently falling back to a
 * default table, matching `deriveHypothesisStatus`'s own refusal — see
 * hypothesis-standing.test.mjs › "refuses a rulesVersion that is not one of
 * STATUS_RULES's published versions".
 */
export function deriveHypothesisStanding(
  { hypotheses, predictions, assessments, evidence }: DeriveHypothesisStandingInput,
  { rulesVersion }: DeriveHypothesisStandingOptions,
): HypothesisStandingResult {
  const requestedVersion: string = rulesVersion;
  if (!Object.hasOwn(STATUS_RULES, requestedVersion)) {
    throw new Error(
      `deriveHypothesisStanding: unknown status-rules version '${requestedVersion}'`,
    );
  }

  let leaderId: string | undefined;
  let leaderRank = Number.POSITIVE_INFINITY;

  const standings = hypotheses.map((hypothesis) => {
    const status = deriveHypothesisStatus({
      hypothesisId: hypothesis.id,
      predictions,
      assessments,
      evidence,
      rulesVersion,
    });

    const rank = STANDING_RANK[status];
    if (rank < leaderRank) {
      leaderRank = rank;
      leaderId = hypothesis.id;
    }

    return { id: hypothesis.id, status };
  });

  return { standings, leaderId };
}

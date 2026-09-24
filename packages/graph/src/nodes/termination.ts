import { deriveHypothesisStanding, type HypothesisStatus, type IncidentState } from '@aic/domain';

import { MAX_CHALLENGE_ROUNDS, type TerminationDecision } from '../investigation.js';

/**
 * AIC-119 slice 2 (owner ruling D1, item 4; plan section 2c): the canonical
 * `termination_check` node, deciding state-driven termination purely from
 * `hypotheses`, `predictions`, `assessments`, `evidence`, `trials` and
 * `control.challengeRounds` — no clock, no scenario text, nothing else on
 * `IncidentState`. Statuses and the leader come from `deriveHypothesisStanding`
 * (`@aic/domain`) under `state.control.statusRulesVersion`, the one place a
 * status ranking is computed (`.claude/rules/invariants.md`, "one mechanism,
 * one implementation").
 *
 * Definitions (plan section 2c): `S` is the hypotheses whose status is in
 * `COMPETING_STATUSES`; `L` is the leader `deriveHypothesisStanding` names;
 * `r` is `control.challengeRounds`.
 *
 *   T0: evidence empty, trials non-empty, no trial ok         -> terminal tools-unavailable
 *   T1: no hypotheses                                          -> terminal stalled
 *   T2: r === 0                                                -> challenge-required(L)
 *   T3: r >= 1 and |S| >= 2                                     -> challenge-required(L)
 *   T4: r >= 1, r < MAX_CHALLENGE_ROUNDS, and L is the newest
 *       createdBy: 'challenge' hypothesis                       -> challenge-required(L)
 *   T5: r >= 1 and |S| === 1 with L in S                        -> terminal sufficient(L)
 *   T6: otherwise                                                -> terminal stalled
 *
 * `MAX_CHALLENGE_ROUNDS` is read from `../investigation.js`, where the kernel
 * already defines it, and never restated as a separate literal.
 *
 * "contradicted" and "no-leader" are not domain outcomes (`InvestigationStop`
 * has no such member); both honestly map to `stalled` here, per T1 and T6.
 * No new stop kind is introduced, and the route this check never returns is
 * banned outside `test/` by `budget-policy.test.mjs`'s own file sweep.
 *
 * Deliberate limit in T4: it proxies "leadership changed" as "the leader is
 * the newest `createdBy: 'challenge'` hypothesis" — a change of leadership
 * back to a different, earlier hypothesis (initial or an older challenge
 * round) is not distinguished from no change at all. Detecting that would
 * need the challenge target stored in state, which is a schema change this
 * slice does not make (plan section 2c).
 *
 * `COMPETING_STATUSES` is the decision point AIC-122 may refine (plan
 * section 2d): conservative here, it is exactly `{supported, corroborated}`
 * for any leader, so a supported leader facing a corroborated competitor is
 * not read as sufficient.
 */
const COMPETING_STATUSES: ReadonlySet<HypothesisStatus> = new Set([
  'supported',
  'corroborated',
]);

export function createStateTerminationCheck() {
  return (state: IncidentState): TerminationDecision => {
    const { hypotheses, predictions, assessments, evidence, trials, control } = state;

    // T0
    if (
      evidence.length === 0 &&
      trials.length > 0 &&
      !trials.some((trial) => trial.status === 'ok')
    ) {
      return { route: 'terminal', stopKind: 'tools-unavailable' };
    }

    // T1
    if (hypotheses.length === 0) {
      return { route: 'terminal', stopKind: 'stalled' };
    }

    const { standings, leaderId } = deriveHypothesisStanding(
      { hypotheses, predictions, assessments, evidence },
      { rulesVersion: control.statusRulesVersion },
    );
    // hypotheses is non-empty here (T1 above), so deriveHypothesisStanding
    // always names a leader.
    const leader = leaderId as string;
    const r = control.challengeRounds;

    // T2
    if (r === 0) {
      return { route: 'challenge-required', leaderId: leader };
    }

    const competing = standings.filter((standing) =>
      COMPETING_STATUSES.has(standing.status),
    );

    // T3
    if (competing.length >= 2) {
      return { route: 'challenge-required', leaderId: leader };
    }

    // T4
    const newestChallengeHypothesis = [...hypotheses]
      .reverse()
      .find((hypothesis) => hypothesis.createdBy === 'challenge');
    if (
      r < MAX_CHALLENGE_ROUNDS &&
      newestChallengeHypothesis !== undefined &&
      newestChallengeHypothesis.id === leader
    ) {
      return { route: 'challenge-required', leaderId: leader };
    }

    // T5
    if (competing.length === 1 && competing[0]?.id === leader) {
      return { route: 'terminal', stopKind: 'sufficient', leaderId: leader };
    }

    // T6
    return { route: 'terminal', stopKind: 'stalled' };
  };
}

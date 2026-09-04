/**
 * The conclusion-review decisions, DERIVED from the schema rather than listed.
 *
 * Two test files used to enumerate the three union members by hand, and nothing
 * held either list against `ConclusionReviewDecisionSchema`. Measured before
 * AIC-77, on this repository: adding a fourth member and handling it in
 * `reviewConclusion` left the whole suite green at 522/522. The compiler does
 * catch a member the graph has not handled yet — so the silence begins exactly
 * when someone finishes the graph work and looks to the tests for what else to
 * update.
 *
 * `decisionFixtureFor` is the forcing function: it throws on an action it has
 * no fixture for, so a fourth member reddens every file that builds its table
 * through here, and the failure names the action rather than a count.
 */
import { ConclusionReviewDecisionSchema } from '@aic/domain';

/**
 * Every `action` the schema declares, read off the discriminated union's own
 * options. Not a copy: if the union changes, this changes with it.
 */
export const CONCLUSION_REVIEW_ACTIONS = Object.freeze(
  ConclusionReviewDecisionSchema.options.map(
    (option) => option.shape.action.value,
  ),
);

/**
 * The one action that carries a payload, also read from the schema rather than
 * remembered — an option whose shape has keys beyond the discriminant needs a
 * fixture that supplies them.
 */
const ACTIONS_CARRYING_A_PAYLOAD = Object.freeze(
  ConclusionReviewDecisionSchema.options
    .filter((option) => Object.keys(option.shape).length > 1)
    .map((option) => option.shape.action.value),
);

/**
 * A valid decision for `action`, or a throw naming the action when this file
 * has not been taught about it.
 *
 * `hypothesis` is required for the payload-carrying actions and refused for the
 * others, so a caller cannot quietly hand a payload to a member that would
 * reject it under `strictObject`.
 */
export function decisionFixtureFor(action, { hypothesis } = {}) {
  if (!CONCLUSION_REVIEW_ACTIONS.includes(action)) {
    throw new Error(
      `unknown conclusion review action: ${String(action)} — the schema declares ${CONCLUSION_REVIEW_ACTIONS.join(', ')}`,
    );
  }

  if (ACTIONS_CARRYING_A_PAYLOAD.includes(action)) {
    if (hypothesis === undefined) {
      throw new Error(
        `conclusion review action ${action} carries a payload, so this fixture needs a hypothesis`,
      );
    }
    return { action, hypothesis };
  }

  if (action === 'confirm' || action === 'reject') {
    return { action };
  }

  // A member that carries no payload and is neither confirm nor reject is one
  // this file has never seen. Refusing here is the point: the alternative is
  // silently treating it as a bare `{ action }` that may not be valid.
  throw new Error(
    `conclusion review action ${action} has no fixture: add one when the schema gains a member`,
  );
}

/**
 * The full decision table, one entry per action the schema declares.
 *
 * `makeHypothesis(round)` supplies the payload for the actions that need one;
 * pass it only if the caller exercises those.
 */
export function conclusionReviewDecisions(makeHypothesis) {
  return CONCLUSION_REVIEW_ACTIONS.map((action) => ({
    label: action,
    decision: (round = 1) =>
      decisionFixtureFor(action, {
        hypothesis: ACTIONS_CARRYING_A_PAYLOAD.includes(action)
          ? makeHypothesis?.(round)
          : undefined,
      }),
  }));
}

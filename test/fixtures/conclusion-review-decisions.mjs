/**
 * The conclusion-review decisions, DERIVED from the schema rather than listed.
 *
 * Two test files used to enumerate the three union members by hand, and nothing
 * held either list against `ConclusionReviewDecisionSchema`. Measured before
 * AIC-77, on this repository: adding a fourth member and handling it in
 * `reviewConclusion` left the whole suite green at 522/522. The compiler does
 * catch a member the graph has not handled yet — a fourth member added to the
 * schema alone fails the build at `investigation.ts` — so the silence begins
 * exactly when someone finishes the graph work and looks to the tests for what
 * else to update.
 *
 * This module refuses rather than guesses. Every shape it does not already know
 * how to build throws BY NAME, so a new union member reddens every file that
 * builds its table through here and the failure says which member and why.
 */
import { ConclusionReviewDecisionSchema } from '@aic/domain';

/**
 * The `action` literal of one union option.
 *
 * `.values` rather than `.value`: zod 4 annotates the singular as `@legacy`,
 * and the plural is a `Set` carrying the same single literal for these options.
 */
function actionOf(option) {
  const [action] = [...option.shape.action.values];
  return action;
}

/** The shape this module knows how to build a fixture for, by its keys. */
const KNOWN_SHAPES = Object.freeze({
  'action': ({ action }) => ({ action }),
  'action,hypothesis': ({ action, hypothesis }) => {
    if (hypothesis === undefined) {
      throw new Error(
        `conclusion review action ${action} carries a hypothesis, so this fixture needs one`,
      );
    }
    return { action, hypothesis };
  },
});

const shapeKeyOf = (option) => Object.keys(option.shape).sort().join(',');

const OPTIONS_BY_ACTION = Object.freeze(
  Object.fromEntries(
    ConclusionReviewDecisionSchema.options.map((option) => [
      actionOf(option),
      option,
    ]),
  ),
);

/**
 * Every `action` the schema declares, read off the discriminated union's own
 * options. Not a copy: if the union changes, this changes with it.
 *
 * Empty would make every loop over it vacuous while staying green — measured,
 * an empty list silently drops `hitl-resume-contract.test.mjs` from 47 tests to
 * 26 — so it is refused HERE, once, rather than guarded in each caller.
 */
export const CONCLUSION_REVIEW_ACTIONS = Object.freeze(
  Object.keys(OPTIONS_BY_ACTION),
);

if (CONCLUSION_REVIEW_ACTIONS.length === 0) {
  throw new Error(
    'ConclusionReviewDecisionSchema declares no actions: every table derived from it would be vacuous',
  );
}

/**
 * A valid decision for `action`, or a throw naming the action.
 *
 * Two refusals, and both are the point rather than defensive noise:
 *
 *   - an action the schema does not declare;
 *   - an action whose OPTION SHAPE this module has never seen. A member added
 *     with a payload under some other name — `{ action, assignee }` — would
 *     otherwise be handed a `hypothesis` it does not declare and rejected by
 *     `strictObject` deep inside a graph run, surfacing as the opaque
 *     `invalid investigation execution input` rather than as a missing fixture.
 *
 * A payload passed for an action that declares none is refused too, rather than
 * dropped: silently discarding it would let a caller believe it was used.
 */
export function decisionFixtureFor(action, { hypothesis } = {}) {
  const option = OPTIONS_BY_ACTION[action];
  if (option === undefined) {
    throw new Error(
      `unknown conclusion review action: ${String(action)} — the schema declares ${CONCLUSION_REVIEW_ACTIONS.join(', ')}`,
    );
  }

  const shapeKey = shapeKeyOf(option);
  const build = KNOWN_SHAPES[shapeKey];
  if (build === undefined) {
    throw new Error(
      `conclusion review action ${action} has an unfamiliar shape {${shapeKey}}: teach this fixture how to build it`,
    );
  }

  if (shapeKey === 'action' && hypothesis !== undefined) {
    throw new Error(
      `conclusion review action ${action} declares no hypothesis, so passing one would be discarded rather than used`,
    );
  }

  return build({ action, hypothesis });
}

/**
 * The full decision table, one entry per action the schema declares.
 *
 * `makeHypothesis(round)` supplies the payload. Every caller that iterates the
 * whole table needs it while the schema has a payload-carrying member, and
 * `decisionFixtureFor` says so by name if it is missing.
 */
export function conclusionReviewDecisions(makeHypothesis) {
  return CONCLUSION_REVIEW_ACTIONS.map((action) => ({
    label: action,
    decision: (round = 1) =>
      decisionFixtureFor(action, {
        hypothesis:
          shapeKeyOf(OPTIONS_BY_ACTION[action]) === 'action,hypothesis'
            ? makeHypothesis?.(round)
            : undefined,
      }),
  }));
}

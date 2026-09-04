/**
 * The conclusion-review decisions, DERIVED from the schema rather than listed.
 *
 * Two test files used to enumerate the three union members by hand, and nothing
 * held either list against `ConclusionReviewDecisionSchema`. Measured before
 * AIC-77: adding a fourth member and handling it in `reviewConclusion` left the
 * whole suite green at 522/522.
 *
 * What this module gives, stated as narrowly as it is true — every sentence
 * below is pinned in conclusion-review-decision-fixture.test.mjs:
 *
 *   - a member the schema declares appears in `CONCLUSION_REVIEW_ACTIONS`
 *     automatically, so every table built through here grows with the union;
 *   - a member whose option shape has a KEY SET this module has not been taught
 *     throws by name, rather than being handed a payload it does not declare;
 *   - an empty union throws at import, because every derived table would
 *     otherwise be vacuous and green.
 *
 * ⚠ And what it does NOT give, because dispatch is on the key set alone: a
 * member declaring `{ action, hypothesis }` with a DIFFERENT hypothesis type is
 * a familiar key set, gets the standard fixture, and fails downstream as the
 * opaque `invalid investigation execution input` rather than as a fixture
 * problem. Type-aware dispatch would mean restating the schema here, which is
 * the duplication this module exists to remove — so the limit is pinned instead
 * of closed: › "reports an unfamiliar payload TYPE only downstream, which is
 * this module's stated limit".
 */
import { ConclusionReviewDecisionSchema } from '@aic/domain';

/**
 * The `action` literal of one union option.
 *
 * `.values` rather than `.value`: zod 4 annotates the singular as `@legacy`.
 * The plural is a `Set`, and a discriminant CAN carry more than one value —
 * `z.literal(['a', 'b'])` is a supported overload that `discriminatedUnion`
 * accepts. Taking the first would then drop an action the schema really
 * accepts, silently, so more than one is refused rather than truncated.
 */
function actionOf(option) {
  const declared = option.shape.action?.values;
  if (declared === undefined || typeof declared[Symbol.iterator] !== 'function') {
    throw new Error(
      'conclusion review discriminant is not a literal with values: this fixture reads the union through option.shape.action.values',
    );
  }
  const values = [...declared];
  if (values.length !== 1) {
    throw new Error(
      `conclusion review discriminant declares ${values.length} values (${values.join(', ')}): this fixture builds one decision per action and would drop the rest`,
    );
  }
  return values[0];
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
 * Three refusals, and each is the point rather than defensive noise:
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
  // `Object.hasOwn`, not a bare index: `decisionFixtureFor('constructor')`
  // would otherwise find `Object.prototype.constructor` and fail with a
  // TypeError instead of this module's by-name refusal.
  const option = Object.hasOwn(OPTIONS_BY_ACTION, action)
    ? OPTIONS_BY_ACTION[action]
    : undefined;
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

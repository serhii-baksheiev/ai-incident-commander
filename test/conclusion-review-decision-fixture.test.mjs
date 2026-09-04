/**
 * The fixture module's own refusals, which nothing tested until this file.
 *
 * Measured before it existed: checking out the previous, defective fixture over
 * the repaired one left `npm run check` at 523/523. The suite could not tell the
 * two apart, so every guarantee the module's header stated was unbacked — and
 * two of those sentences turned out to be false when a reviewer measured them.
 *
 * Each test here is one sentence of that header.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ConclusionReviewDecisionSchema } from '@aic/domain';

import {
  CONCLUSION_REVIEW_ACTIONS,
  conclusionReviewDecisions,
  decisionFixtureFor,
} from './fixtures/conclusion-review-decisions.mjs';

const aHypothesis = () => ({
  id: 'human-hypothesis',
  statement: 'A human-supplied alternative',
  createdBy: 'initial',
});

test('derives every action the schema declares, and nothing else', () => {
  const fromSchema = ConclusionReviewDecisionSchema.options.map(
    (option) => [...option.shape.action.values][0],
  );

  assert.deepStrictEqual([...CONCLUSION_REVIEW_ACTIONS], fromSchema);
  assert.equal(
    CONCLUSION_REVIEW_ACTIONS.length > 0,
    true,
    'an empty list would make every table built from it vacuous',
  );
});

test('refuses an action the schema does not declare, naming what it does', () => {
  assert.throws(
    () => decisionFixtureFor('defer'),
    (error) => {
      assert.match(error.message, /unknown conclusion review action: defer/);
      for (const action of CONCLUSION_REVIEW_ACTIONS) {
        assert.match(
          error.message,
          new RegExp(action),
          'the refusal must list what the schema does declare',
        );
      }
      return true;
    },
  );
});

test('refuses an inherited property name rather than reading the prototype chain', () => {
  // A bare `OPTIONS_BY_ACTION[action]` finds Object.prototype.constructor and
  // fails with a TypeError that names nothing.
  for (const inherited of ['constructor', 'toString', '__proto__']) {
    assert.throws(
      () => decisionFixtureFor(inherited),
      /unknown conclusion review action/,
      `${inherited} must be refused as an unknown action`,
    );
  }
});

test('refuses a payload for an action that declares none, rather than dropping it', () => {
  const payloadFree = CONCLUSION_REVIEW_ACTIONS.filter(
    (action) =>
      Object.keys(
        ConclusionReviewDecisionSchema.options.find(
          (option) => [...option.shape.action.values][0] === action,
        ).shape,
      ).length === 1,
  );
  assert.equal(
    payloadFree.length > 0,
    true,
    'the schema must still declare a payload-free action for this to test anything',
  );

  for (const action of payloadFree) {
    assert.throws(
      () => decisionFixtureFor(action, { hypothesis: aHypothesis() }),
      /declares no hypothesis, so passing one would be discarded rather than used/,
      `${action} takes no payload, so a payload must be refused and not silently dropped`,
    );
  }
});

test('refuses a payload-carrying action with no payload supplied', () => {
  const carriesPayload = CONCLUSION_REVIEW_ACTIONS.filter(
    (action) =>
      Object.keys(
        ConclusionReviewDecisionSchema.options.find(
          (option) => [...option.shape.action.values][0] === action,
        ).shape,
      ).length > 1,
  );
  assert.equal(carriesPayload.length > 0, true);

  for (const action of carriesPayload) {
    assert.throws(
      () => decisionFixtureFor(action),
      /carries a hypothesis, so this fixture needs one/,
      `${action} needs its payload named rather than built as a bare action`,
    );
  }
});

test('builds a decision the schema accepts for every action it derives', () => {
  for (const { label, decision } of conclusionReviewDecisions(aHypothesis)) {
    assert.equal(
      ConclusionReviewDecisionSchema.safeParse(decision()).success,
      true,
      `the fixture for ${label} must parse`,
    );
  }
});

test('reports an unfamiliar payload TYPE only downstream, which is this module\'s stated limit', () => {
  // Dispatch is on the option's KEY SET. A member declaring { action,
  // hypothesis } with a different hypothesis type is a familiar key set, so
  // this module builds the standard fixture and the mismatch surfaces wherever
  // the decision is parsed — not here. Pinned rather than closed: closing it
  // means restating the schema's field types in this file, which is the
  // duplication the module exists to remove.
  //
  // The check is against the schema directly, because the real case needs a
  // fourth union member and this file must not mutate the domain package.
  const builtForAKnownShape = decisionFixtureFor('add_hypothesis', {
    hypothesis: aHypothesis(),
  });
  assert.deepStrictEqual(Object.keys(builtForAKnownShape).sort(), [
    'action',
    'hypothesis',
  ]);

  const wouldNotBeCaughtHere = { ...builtForAKnownShape, hypothesis: 'a string' };
  assert.equal(
    ConclusionReviewDecisionSchema.safeParse(wouldNotBeCaughtHere).success,
    false,
    'a wrong payload type is refused by the schema, and only by the schema',
  );
});

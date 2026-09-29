import type { RequestVocabulary } from '@aic/domain';

/**
 * The one sentence `createModelChallengeHypothesis`'s system prompt carries
 * to name the closed request vocabulary a discriminating test may use
 * (AIC-143): the route table's admissible tool ids, each with its exact input
 * keys, and — where the key is closed — every value it may take. A key with
 * no `values` (the observation's `subject`) is shown as `<service>` rather
 * than a real service name, since `RequestVocabulary` never carries one.
 * Same pattern as `describeMechanismVocabulary` (`./mechanism-vocabulary.ts`):
 * one implementation, so a wording change lands once rather than in every
 * caller by hand (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation").
 * see cause-emitting-roles.test.mjs › "describeRequestVocabulary returns the
 * exact sentence for the INVESTIGATION_ROUTES vocabulary"
 * see cause-emitting-roles.test.mjs › "challenge_hypothesis' system prompt
 * contains describeRequestVocabulary(v) for the vocabulary it was given"
 */
export function describeRequestVocabulary(vocabulary: RequestVocabulary): string {
  const shapes = vocabulary.map((shape) => {
    const inputs = shape.input
      .map((inputKey) =>
        inputKey.values === undefined ? `${inputKey.key}: <service>` : `${inputKey.key}: ${inputKey.values.join('|')}`,
      )
      .join(', ');
    return `${shape.tool} {${inputs}}`;
  });
  return `Each discriminating test must be one of these requests, with exactly these input keys: ${shapes.join('; ')}.`;
}

/**
 * The one sentence every mechanism-vocabulary role's system prompt carries
 * (AIC-123 slice 2): `propose_conclusion` and `naive-role.ts`'s naive
 * investigation already showed it, worded by hand in each role; this module
 * is the one implementation the four roles now share, so a wording change
 * cannot land in three prompts and miss the fourth
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 * see cause-emitting-roles.test.mjs › "describeMechanismVocabulary returns the exact sentence every mechanism-vocabulary role must show"
 * see cause-emitting-roles.test.mjs › "generate_hypotheses' system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given"
 * see cause-emitting-roles.test.mjs › "challenge_hypothesis' system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given"
 * see cause-emitting-roles.test.mjs › "propose_conclusion's system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given"
 * see cause-emitting-roles.test.mjs › "the naive role's system prompt contains describeMechanismVocabulary(vocabulary) for the vocabulary it was given"
 */
export function describeMechanismVocabulary(vocabulary: readonly string[]): string {
  return `Classify each cause's mechanism as one of: ${vocabulary.join(', ')}.`;
}

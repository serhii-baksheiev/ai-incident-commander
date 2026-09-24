import type { Evidence, Hypothesis, IncidentConclusion, InvestigationStop } from './contracts.js';

/**
 * The pure validation rule for a model-composed `IncidentConclusion`.
 *
 * AIC-119 adds a fourth model role — evidence-constrained conclusion
 * composition — whose answer must be checked deterministically the same way
 * every other model-backed role in this system is: a schema-valid but
 * self-contradictory conclusion is a measured refusal, never passed through.
 * This module holds the rule once, in the layer both the naive role
 * (`packages/roles/src/naive-role.ts`) and the future graph conclusion role
 * can import, per `.claude/rules/invariants.md` ("one mechanism, one
 * implementation").
 *
 * It is pure: no fs, env, clock or randomness, and it never throws on
 * well-typed input — every check returns a reason string or `undefined`.
 */

const NAME_TRUNCATE_LENGTH = 80;

/**
 * Names a model-supplied value the same way `naive-role.ts`'s
 * `refuseUnknownKeys` names an unknown key: JSON-escaped, and truncated to 80
 * characters first, so a hostile value can neither inject text into the
 * reason nor make it unbounded.
 * see conclusion-rules.test.mjs › "conclusionViolation: a hostile fabricated hypothesisId (quotes, newline, 500 chars) is named escaped and truncated to 80 chars"
 */
function nameValue(value: string): string {
  return JSON.stringify(value.slice(0, NAME_TRUNCATE_LENGTH));
}

/** The four `kind` members `IncidentConclusionSchema` declares today. */
const KNOWN_CONCLUSION_KINDS: ReadonlySet<string> = new Set([
  'root-cause',
  'multiple-causes',
  'inconclusive',
  'no-incident',
]);

/**
 * The cause-count rule alone: how many causes a conclusion of each `kind` may
 * name. Exported on its own because `naive-role.ts`'s `requireCauseCount`
 * enforced exactly this before this module existed, and must keep reporting
 * the identical text now that it delegates here.
 *
 * Default-deny on a `kind` outside the four the schema declares (AIC-119
 * slice D hardening): this module's precondition is schema-parsed own data
 * (see the module header), so a caller that skips `IncidentConclusionSchema.parse`
 * is the only way an unrecognised `kind` reaches here, but a validation rule
 * that fell through every `if` and returned `undefined` for it was
 * default-ALLOW on an enum field regardless of how it was reached — the wrong
 * direction for a refusal to fail in.
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a root-cause conclusion with exactly one cause is valid"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: an inconclusive conclusion naming one cause reports the exact naive-role text"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a no-incident conclusion naming two causes reports the exact naive-role text"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a root-cause conclusion naming zero causes reports the exact naive-role text"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a root-cause conclusion naming two causes reports the exact naive-role text"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a multiple-causes conclusion naming zero causes reports the exact naive-role text"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a multiple-causes conclusion naming one cause reports the exact naive-role text"
 * see conclusion-rules.test.mjs › "conclusionCauseCountViolation: a kind outside the four-member enum is refused, not silently accepted (default-deny)"
 * see conclusion-rules.test.mjs › "conclusionViolation: a kind outside the four-member enum is refused rather than silently accepted (default-deny)"
 */
export function conclusionCauseCountViolation(
  conclusion: IncidentConclusion,
): string | undefined {
  if (!KNOWN_CONCLUSION_KINDS.has(conclusion.kind)) {
    return `a conclusion names a kind this domain does not declare: ${nameValue(conclusion.kind)}`;
  }
  const count = conclusion.causes.length;
  if ((conclusion.kind === 'no-incident' || conclusion.kind === 'inconclusive') && count !== 0) {
    return `a ${conclusion.kind} conclusion names no cause, and this one names ${count}`;
  }
  if (conclusion.kind === 'root-cause' && count !== 1) {
    return `a root-cause conclusion names exactly one cause, and this one names ${count}`;
  }
  if (conclusion.kind === 'multiple-causes' && count < 2) {
    return `a multiple-causes conclusion names at least two causes, and this one names ${count}`;
  }
  return undefined;
}

export interface ConclusionViolationInput {
  readonly conclusion: IncidentConclusion;
  readonly hypotheses: readonly Hypothesis[];
  readonly evidence: readonly Evidence[];
  readonly stopKind: InvestigationStop;
}

/**
 * The full conclusion rule: the first violation found, checked in order —
 * (1) cause count (which itself default-denies a `kind` outside the four
 * `IncidentConclusionSchema` declares, delegated from
 * `conclusionCauseCountViolation`), (2) a hypothesisId named by two causes,
 * (3) a hypothesisId naming no given hypothesis, (4) a cause with no cited
 * evidence, (5) an evidenceId naming no given evidence, (6) `no-incident`
 * under `stopKind: 'tools-unavailable'`, which docs/incident-commander-architecture-v1.md
 * (section 8, rule 4) forbids: a run whose tools were unavailable never
 * reports "no incident" as though it had looked.
 * see conclusion-rules.test.mjs › "conclusionViolation: a valid root-cause conclusion is undefined"
 * see conclusion-rules.test.mjs › "conclusionViolation (1): a cause-count mismatch is reported, with the same text as conclusionCauseCountViolation"
 * see conclusion-rules.test.mjs › "conclusionViolation (2): the same hypothesisId named by two causes is refused"
 * see conclusion-rules.test.mjs › "conclusionViolation (3): a cause whose hypothesisId names no given hypothesis is refused"
 * see conclusion-rules.test.mjs › "conclusionViolation (4): a cause with an empty evidenceIds is refused"
 * see conclusion-rules.test.mjs › "conclusionViolation (5): an evidence id that names no given evidence item is refused"
 * see conclusion-rules.test.mjs › "conclusionViolation (6): kind 'no-incident' under stopKind 'tools-unavailable' is refused — tools-unavailable is never 'problem absent' (docs/incident-commander-architecture-v1.md section 8 rule 4)"
 * see conclusion-rules.test.mjs › "conclusionViolation: a conclusion violating both (1) cause-count and (5) a fabricated evidence id reports (1) first"
 */
export function conclusionViolation({
  conclusion,
  hypotheses,
  evidence,
  stopKind,
}: ConclusionViolationInput): string | undefined {
  const causeCount = conclusionCauseCountViolation(conclusion);
  if (causeCount !== undefined) return causeCount;

  const hypothesisIds = new Set(hypotheses.map((hypothesis) => hypothesis.id));
  const evidenceIds = new Set(evidence.map((item) => item.id));

  const seenHypothesisIds = new Set<string>();
  for (const cause of conclusion.causes) {
    if (seenHypothesisIds.has(cause.hypothesisId)) {
      return `two causes name the same hypothesis ${nameValue(cause.hypothesisId)}`;
    }
    seenHypothesisIds.add(cause.hypothesisId);
  }

  for (const cause of conclusion.causes) {
    if (!hypothesisIds.has(cause.hypothesisId)) {
      return `a cause names a hypothesis that was not given: ${nameValue(cause.hypothesisId)}`;
    }
  }

  for (const cause of conclusion.causes) {
    if (cause.evidenceIds.length === 0) {
      return `a cause for hypothesis ${nameValue(cause.hypothesisId)} cites no evidence`;
    }
  }

  for (const cause of conclusion.causes) {
    for (const evidenceId of cause.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        return `a cause cites evidence that was not given: ${nameValue(evidenceId)}`;
      }
    }
  }

  if (conclusion.kind === 'no-incident' && stopKind === 'tools-unavailable') {
    return "a 'no-incident' conclusion is never reported under stopKind 'tools-unavailable'";
  }

  return undefined;
}

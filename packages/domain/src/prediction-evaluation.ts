import { createHash } from 'node:crypto';

import {
  observedPresence,
  type Evidence,
  type EvidenceAssessment,
  type ExpectedObservation,
  type ObservedFact,
  type Prediction,
} from './contracts.js';
import { canonicalJson } from './execution.js';

/**
 * AIC-124 slice a: `evaluatePredictionObservations`, the pure half of
 * "typed `ExpectedObservation` vs typed `ObservedFact` becomes a verdict".
 * No LLM judge — every `EvidenceAssessment` this module produces has
 * `producedBy: 'rule'` and carries no `promptVersion`. The graph node that
 * calls this belongs to slice b (`packages/graph`).
 *
 * Rules, in application order, for one prediction:
 *
 * 1. **Decided predictions are final and monotone.** A prediction whose
 *    `status` is already `'confirmed'` or `'refuted'` is returned unchanged,
 *    and contributes no assessments, however the new evidence reads — see
 *    prediction-path-domain.test.mjs › "returns confirmed and refuted
 *    predictions unchanged and produces no assessments for them, even when
 *    new evidence contradicts them". `'untested'` and `'untestable'` are not
 *    final and are re-evaluated from scratch every call — see ›
 *    "re-evaluates an untestable prediction, unlike confirmed and refuted,
 *    and can resolve it to confirmed".
 * 2. **Rule (b): the as-of cut.** Only evidence with an `observation` field
 *    whose `observedAt` parses to a timestamp `<= asOf` is read; evidence
 *    with no `observation`, an unparseable `observedAt`, or an `observedAt`
 *    after `asOf` contributes nothing and never throws — see ›
 *    "counts evidence observed exactly at asOf", › "ignores evidence
 *    observed one millisecond after asOf", › "ignores evidence carrying an
 *    unparseable observedAt" and › "evidence with no observation field
 *    contributes nothing and does not throw". `asOf` itself must parse; an
 *    unparseable `asOf` throws rather than silently reading as "no cut" —
 *    see › "throws on an unparseable asOf".
 * 3. **A fact matches an observation only on an exact shape.** Same `form`,
 *    the same `subject` (case- and whitespace-insensitive — see ›
 *    "matches a subject regardless of surrounding whitespace or letter
 *    case"), the same `window`, and the form's own discriminant
 *    (`logClass`, or `signal`). Anything less is not a match at all and
 *    leaves the prediction's status untouched — see › "leaves a prediction
 *    status unchanged (untested) on a subject mismatch…", "…window
 *    mismatch…" and "…signal mismatch…".
 * 4. **A presence-form match (`deployment-in-window`,
 *    `log-class-in-window`) is read through `observedPresence`** (this
 *    package's own rule (a): partial coverage never proves absence, so a
 *    zero count under partial coverage reads `'unknown'`, not `'absent'`).
 *    `'unknown'` never confirms or refutes on its own — see › "leaves a
 *    prediction untestable, not refuted, when a zero count is observed
 *    under partial coverage (rule a: partial coverage never proves
 *    absence)" and › "the identical zero-count fact refutes once coverage
 *    is complete, proving the coverage bit is load-bearing". A
 *    `signal-state` match compares `state` directly; there is no `'unknown'`
 *    reading for it — see › "confirms a prediction when the observed signal
 *    state equals the expected state" and › "refutes a prediction when the
 *    observed signal state differs from the expected state".
 * 5. **`expectedIfFalse` is read before `expectedIfTrue`, and decisively.**
 *    If any `expectedIfFalse` observation is matched and holds (the
 *    false-case condition was observed), the prediction is `'refuted'` on
 *    that alone — `expectedIfTrue` is never independently evaluated for the
 *    same call, so a fact that would also read as a direct contradiction of
 *    an `expectedIfTrue` entry contributes exactly one assessment, not two
 *    — see › "refutes a prediction when an expectedIfFalse observation
 *    holds, even while expectedIfTrue is unresolved".
 * 6. **`expectedIfTrue` confirms only once every observation in it holds**,
 *    and an empty `expectedIfTrue` never confirms — see › "never confirms a
 *    prediction whose expectedIfTrue list is empty, whatever evidence is
 *    supplied, and keeps its input status". Each observation holds from its
 *    own matching evidence — see › "leaves a prediction
 *    status unchanged when only one of two expectedIfTrue observations
 *    holds and nothing matches the other" and › "confirms a prediction only
 *    once every expectedIfTrue observation holds, and produces one
 *    assessment per contributing evidence item". A single matched
 *    observation read as the opposite of expected refutes the whole
 *    prediction immediately — see › "refutes a prediction when the
 *    observed presence is the opposite of the expected presence under
 *    complete coverage, and produces one contradicts assessment".
 * 7. **Conflicting evidence is `'untestable'`, not a tie-break.** When one
 *    fact holds an observation and another fact (for the same observation)
 *    contradicts it, the prediction is `'untestable'` and produces no
 *    assessments at all — see › "leaves a prediction untestable when the
 *    evidence conflicts: one fact holds an observation and another
 *    contradicts the same observation".
 * 8. **No fact settling anything leaves the status unchanged**, not reset to
 *    `'untested'` — the input prediction's own `status` is returned when
 *    nothing above decided the call, which is what makes rule 1 sound for a
 *    reopened `'untestable'` prediction that still finds nothing — see ›
 *    "leaves an untestable prediction untestable, not reset to untested,
 *    when no evidence matches anything (rule 8: no fact settling anything
 *    leaves the status unchanged)".
 *
 * One assessment per contributing evidence item, never per observation — an
 * evidence item that settles two observations of the same prediction still
 * contributes one assessment — see › "confirms a prediction from a single
 * evidence item whose observation carries facts settling both expectedIfTrue
 * observations, producing exactly one assessment for that evidence item".
 * Assessment ids are deterministic:
 * `'rule-' + sha256 hex of JSON.stringify(canonicalJson([predictionId,
 * evidenceId, PREDICTION_EVALUATION_VERSION]))`, and every rationale names
 * `PREDICTION_EVALUATION_VERSION` — see › "confirms a prediction when the
 * observed presence equals the expected presence, and produces one supports
 * assessment".
 *
 * Order-independent and pure: the predictions in `predictions` keep their
 * input order in the result, the assessments for a given call are the same
 * set regardless of `evidence`'s order, no input is mutated, and an
 * identical call twice produces a deep-equal result — see › "keeps output
 * predictions in the same order as the input predictions", › "gives the
 * same set of assessments regardless of the evidence input order", › "does
 * not mutate its predictions or evidence inputs" and › "is pure: an
 * identical call twice produces deepEqual output".
 */
export const PREDICTION_EVALUATION_VERSION = 'prediction-evaluation-v1' as const;

export interface EvaluatePredictionObservationsInput {
  readonly predictions: readonly Prediction[];
  readonly evidence: readonly Evidence[];
  readonly asOf: string;
}

export interface EvaluatePredictionObservationsResult {
  readonly predictions: Prediction[];
  readonly assessments: EvidenceAssessment[];
}

type FactVerdict = 'holds' | 'contradicts' | 'unknown';

interface ObservationMatch {
  readonly evidence: Evidence;
  readonly verdict: FactVerdict;
}

interface ObservationSummary {
  readonly holds: readonly ObservationMatch[];
  readonly contradicts: readonly ObservationMatch[];
  readonly unknown: readonly ObservationMatch[];
}

interface SinglePredictionVerdict {
  readonly status: Prediction['status'];
  readonly effect: 'supports' | 'contradicts' | undefined;
  readonly contributingEvidence: readonly Evidence[];
  readonly rationaleSuffix: string;
}

/**
 * The one place a subject is case- and whitespace-normalized (trim +
 * lowercase) before comparison — exported so a caller outside this module
 * (`packages/tools/replay/index.ts`'s `createPlannedReplayExecutor` quantity
 * match) applies the exact same rule rather than a second copy of it
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 */
export function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase();
}

function presenceVerdict(
  observed: ReturnType<typeof observedPresence>,
  expected: 'present' | 'absent',
): FactVerdict {
  if (observed === 'unknown') return 'unknown';
  return observed === expected ? 'holds' : 'contradicts';
}

function matchFact(observation: ExpectedObservation, fact: ObservedFact): FactVerdict | undefined {
  if (normalizeSubject(fact.subject) !== normalizeSubject(observation.subject)) return undefined;
  if (fact.window !== observation.window) return undefined;

  switch (observation.form) {
    case 'deployment-in-window':
      if (fact.form !== 'deployment-in-window') return undefined;
      return presenceVerdict(observedPresence(fact), observation.presence);
    case 'log-class-in-window':
      if (fact.form !== 'log-class-in-window') return undefined;
      if (fact.logClass !== observation.logClass) return undefined;
      return presenceVerdict(observedPresence(fact), observation.presence);
    case 'signal-state':
      if (fact.form !== 'signal-state') return undefined;
      if (fact.signal !== observation.signal) return undefined;
      return fact.state === observation.state ? 'holds' : 'contradicts';
  }
}

function summarizeObservation(
  observation: ExpectedObservation,
  evidenceItems: readonly Evidence[],
): ObservationSummary {
  const matches: ObservationMatch[] = [];
  for (const evidenceItem of evidenceItems) {
    for (const fact of evidenceItem.observation?.facts ?? []) {
      const verdict = matchFact(observation, fact);
      if (verdict !== undefined) matches.push({ evidence: evidenceItem, verdict });
    }
  }

  return {
    holds: matches.filter((match) => match.verdict === 'holds'),
    contradicts: matches.filter((match) => match.verdict === 'contradicts'),
    unknown: matches.filter((match) => match.verdict === 'unknown'),
  };
}

function dedupeByEvidence(matches: readonly ObservationMatch[]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const match of matches) {
    if (!seen.has(match.evidence.id)) seen.set(match.evidence.id, match.evidence);
  }
  return [...seen.values()];
}

const UNTESTABLE_NO_CONTRIBUTION = {
  effect: undefined,
  contributingEvidence: [],
} as const;

function evaluateSinglePrediction(
  prediction: Prediction,
  evidenceItems: readonly Evidence[],
): SinglePredictionVerdict {
  const falseSummaries = prediction.expectedIfFalse.map((observation) =>
    summarizeObservation(observation, evidenceItems),
  );
  if (falseSummaries.some((summary) => summary.holds.length > 0 && summary.contradicts.length > 0)) {
    return {
      status: 'untestable',
      ...UNTESTABLE_NO_CONTRIBUTION,
      rationaleSuffix: 'conflicting evidence for an expectedIfFalse observation',
    };
  }

  const falseHolding = falseSummaries.flatMap((summary) => summary.holds);
  if (falseHolding.length > 0) {
    return {
      status: 'refuted',
      effect: 'contradicts',
      contributingEvidence: dedupeByEvidence(falseHolding),
      rationaleSuffix: 'an expectedIfFalse observation was observed to hold',
    };
  }

  if (falseSummaries.some((summary) => summary.unknown.length > 0)) {
    return {
      status: 'untestable',
      ...UNTESTABLE_NO_CONTRIBUTION,
      rationaleSuffix: 'an expectedIfFalse observation is ambiguous under partial coverage',
    };
  }

  const trueSummaries = prediction.expectedIfTrue.map((observation) =>
    summarizeObservation(observation, evidenceItems),
  );
  if (trueSummaries.some((summary) => summary.holds.length > 0 && summary.contradicts.length > 0)) {
    return {
      status: 'untestable',
      ...UNTESTABLE_NO_CONTRIBUTION,
      rationaleSuffix: 'conflicting evidence for an expectedIfTrue observation',
    };
  }

  const trueContradicting = trueSummaries.flatMap((summary) => summary.contradicts);
  if (trueContradicting.length > 0) {
    return {
      status: 'refuted',
      effect: 'contradicts',
      contributingEvidence: dedupeByEvidence(trueContradicting),
      rationaleSuffix: 'an expectedIfTrue observation was observed as the opposite of expected',
    };
  }

  if (trueSummaries.some((summary) => summary.unknown.length > 0)) {
    return {
      status: 'untestable',
      ...UNTESTABLE_NO_CONTRIBUTION,
      rationaleSuffix: 'an expectedIfTrue observation is ambiguous under partial coverage (rule a)',
    };
  }

  if (trueSummaries.length > 0 && trueSummaries.every((summary) => summary.holds.length > 0)) {
    return {
      status: 'confirmed',
      effect: 'supports',
      contributingEvidence: dedupeByEvidence(trueSummaries.flatMap((summary) => summary.holds)),
      rationaleSuffix: 'every expectedIfTrue observation was observed to hold',
    };
  }

  return {
    status: prediction.status,
    ...UNTESTABLE_NO_CONTRIBUTION,
    rationaleSuffix: 'no fact settled this prediction',
  };
}

function buildAssessmentId(predictionId: string, evidenceId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalJson([predictionId, evidenceId, PREDICTION_EVALUATION_VERSION])))
    .digest('hex');
  return `rule-${digest}`;
}

function buildAssessments(
  prediction: Prediction,
  verdict: SinglePredictionVerdict,
  asOf: string,
): EvidenceAssessment[] {
  if (verdict.effect === undefined) return [];

  const effect = verdict.effect;
  return verdict.contributingEvidence.map((evidenceItem) => ({
    id: buildAssessmentId(prediction.id, evidenceItem.id),
    evidenceId: evidenceItem.id,
    hypothesisId: prediction.hypothesisId,
    predictionId: prediction.id,
    effect,
    strength: 'medium',
    rationale: `${PREDICTION_EVALUATION_VERSION}: ${verdict.rationaleSuffix} (evidence ${evidenceItem.id})`,
    producedBy: 'rule',
    at: asOf,
  }));
}

function parseTimestamp(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function evaluatePredictionObservations({
  predictions,
  evidence,
  asOf,
}: EvaluatePredictionObservationsInput): EvaluatePredictionObservationsResult {
  const asOfMs = parseTimestamp(asOf);
  if (asOfMs === undefined) {
    throw new Error(`evaluatePredictionObservations: asOf is not a parseable timestamp: ${JSON.stringify(asOf)}`);
  }

  const qualifyingEvidence = evidence.filter((item) => {
    if (item.observation === undefined) return false;
    const observedMs = parseTimestamp(item.observedAt);
    return observedMs !== undefined && observedMs <= asOfMs;
  });

  const assessments: EvidenceAssessment[] = [];
  const outPredictions = predictions.map((prediction) => {
    if (prediction.status === 'confirmed' || prediction.status === 'refuted') {
      return prediction;
    }

    const verdict = evaluateSinglePrediction(prediction, qualifyingEvidence);
    assessments.push(...buildAssessments(prediction, verdict, asOf));
    return verdict.status === prediction.status ? prediction : { ...prediction, status: verdict.status };
  });

  return { predictions: outPredictions, assessments };
}

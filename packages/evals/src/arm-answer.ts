import type {
  Evidence,
  EvidenceAssessment,
  IncidentConclusion,
  InvestigationStop,
} from '@aic/domain';

import type { BenchmarkOutcome } from './benchmark-evaluation.js';
import type {
  ChallengeEffectObservation,
  EvidenceAssessmentObservation,
} from './behavior-evaluators.js';
import type {
  EvidenceFingerprint,
  ScenarioReplayFixture,
} from './replay-scenarios.js';

/**
 * What an arm that does NOT run the graph answers: its hypotheses, how it read
 * the evidence, its conclusion and where it stopped.
 *
 * One shape for every non-graph arm, so they are all projected into a
 * `BenchmarkOutcome` by the same function below and scored by the same
 * evaluators — a second projection per arm would be a second place for one arm
 * to be credited with something another is not.
 *
 * `hypotheses` is not read by `outcomeFromArmAnswer`: no metric scores a
 * hypothesis list. It is carried so an answer can be checked for self-reference
 * — every hypothesis id a cause or an assessment names is one it declared.
 */
export interface ArmAnswer {
  readonly hypotheses: readonly Readonly<{ id: string; statement: string }>[];
  readonly assessments: readonly Readonly<{
    evidenceId: string;
    hypothesisId: string;
    effect: EvidenceAssessment['effect'];
  }>[];
  readonly conclusion: IncidentConclusion;
  readonly stopKind: InvestigationStop;
}

/**
 * The best value of every metric the benchmark publishes: the value a perfect
 * run scores. `unsupported_claim_rate` is a rate of failures, so its best is 0;
 * every other metric is a success score whose best is 1.
 *
 * A metric may be compared across arms only where the oracle positive control
 * reaches this value — see oracle-positive-control.test.mjs › "scores the
 * calibration partition exactly as hand-derived from behavior-evaluators.ts and
 * replay-scenarios.ts".
 */
export const METRIC_BEST_VALUES = Object.freeze({
  unsupported_claim_rate: 0,
  evidence_coverage: 1,
  termination_correctness: 1,
  misleading_evidence_handling: 1,
  false_alert_correctness: 1,
  challenge_effect: 1,
} as const);

/**
 * The evidence a fixture shows: every `ok` entry's output, in entry order. An
 * `unavailable` or `error` entry produced no evidence and contributes none.
 */
export function shownEvidenceOf(fixture: ScenarioReplayFixture): Evidence[] {
  return fixture.entries.flatMap(({ result }) =>
    result.status === 'ok' ? [...result.output] : [],
  );
}

function fingerprintOf({ kind, source, statement }: Evidence): EvidenceFingerprint {
  return { kind, source, predicate: statement };
}

/**
 * Project an arm's answer into the outcome the evaluators score.
 *
 * 🔴 Evidence counts as investigated only when the answer REFERENCED it — by a
 * cause or an assessment. Evidence that was merely shown is not fingerprinted:
 * an arm handed every piece of telemetry would otherwise be credited with
 * investigating all of it, including the misleading item, for having read the
 * prompt.
 * see oracle-positive-control.test.mjs › "outcomeFromArmAnswer fingerprints
 * only evidence a cause or an assessment referenced, never evidence shown but
 * uncited"
 *
 * A referenced id the fixture never showed supports nothing and is
 * fingerprinted as nothing — the claim still counts, and counts as unsupported.
 */
export function outcomeFromArmAnswer({
  answer,
  fixture,
  challengeEffect,
}: Readonly<{
  answer: ArmAnswer;
  fixture: ScenarioReplayFixture;
  challengeEffect?: ChallengeEffectObservation;
}>): BenchmarkOutcome {
  const shownById = new Map(
    shownEvidenceOf(fixture).map((evidence) => [evidence.id, evidence]),
  );
  const { causes } = answer.conclusion;

  const referenced: Evidence[] = [];
  const seen = new Set<string>();
  for (const evidenceId of [
    ...causes.flatMap(({ evidenceIds }) => evidenceIds),
    ...answer.assessments.map(({ evidenceId }) => evidenceId),
  ]) {
    const evidence = shownById.get(evidenceId);
    if (evidence === undefined || seen.has(evidenceId)) continue;
    seen.add(evidenceId);
    referenced.push(evidence);
  }

  const evidenceAssessments: EvidenceAssessmentObservation[] =
    answer.assessments.flatMap(({ evidenceId, hypothesisId, effect }) => {
      const evidence = shownById.get(evidenceId);
      return evidence === undefined
        ? []
        : [{ fingerprint: fingerprintOf(evidence), hypothesisId, effect }];
    });

  return {
    claims: causes.map(({ evidenceIds }) => ({ evidenceIds })),
    supportingEvidenceIds: causes.flatMap(({ evidenceIds }) =>
      evidenceIds.filter((evidenceId) => shownById.has(evidenceId)),
    ),
    evidenceFingerprints: referenced.map(fingerprintOf),
    stopKind: answer.stopKind,
    conclusionKind: answer.conclusion.kind,
    rootCause: causes[0]?.cause,
    rootCauseHypothesisId: causes[0]?.hypothesisId,
    evidenceAssessments,
    ...(challengeEffect === undefined ? {} : { challengeEffect }),
  };
}

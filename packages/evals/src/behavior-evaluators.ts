import { isDeepStrictEqual } from 'node:util';

import type {
  CauseClaim,
  EvidenceAssessment,
  HypothesisStatus,
  IncidentConclusion,
  InvestigationStop,
} from '@aic/domain';

import type { EvidenceFingerprint } from './replay-scenarios.js';
import {
  matchesRootCause,
  type StructuralGroundTruthEntry,
} from './structural-ground-truth.js';

/**
 * The accepted evaluator version: evidence matched by `[kind, source,
 * predicate]` fingerprint and root cause by deep equality with the accepted
 * prose. The v0.1 baseline and every committed record were scored under it, and
 * its semantics do not change.
 */
export const BEHAVIOR_EVALUATOR_VERSION =
  'behavior-evaluators-v0.2' as const;

/**
 * The structural evaluator version (AIC-105): evidence matched by the fixture
 * ids an arm referenced, root cause by `matchesRootCause` against
 * `STRUCTURAL_GROUND_TRUTH`. Additive: a record declares which version scored
 * it, and `evaluateBenchmarkRecord` refuses any version it does not know.
 * see structural-evaluator.test.mjs › "the same outcome scores by whichever
 * evaluatorVersion the record declares, and v0.2 semantics are unchanged"
 */
export const STRUCTURAL_EVALUATOR_VERSION =
  'behavior-evaluators-v0.3' as const;

/**
 * The discriminating-challenge evaluator version (AIC-138): identical to
 * `behavior-evaluators-v0.3` except in `challenge_effect`, which now requires
 * at least one executed discriminating trial to pass — a leader or
 * leader-status change with zero such trials is judgement over evidence the
 * run already had, not investigation, and scores 0 with reason
 * `no-discriminating-trial`. Every other metric, and every other version,
 * keeps its exact semantics.
 * see challenge-effect-discriminating-evaluator.test.mjs › "DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION is pinned to behavior-evaluators-v0.4, and v0.2 and v0.3 do not move"
 */
export const DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION =
  'behavior-evaluators-v0.4' as const;

export type BehaviorEvaluatorVersion =
  | typeof BEHAVIOR_EVALUATOR_VERSION
  | typeof STRUCTURAL_EVALUATOR_VERSION
  | typeof DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION;

/** Every evaluator version `evaluateBenchmarkRecord` and its peers accept. */
export const KNOWN_BEHAVIOR_EVALUATOR_VERSIONS: readonly BehaviorEvaluatorVersion[] =
  [
    BEHAVIOR_EVALUATOR_VERSION,
    STRUCTURAL_EVALUATOR_VERSION,
    DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION,
  ];

/** Every version scored structurally: v0.3 and v0.4, which differ only in `challenge_effect`. */
export type StructuralEvaluatorVersion =
  | typeof STRUCTURAL_EVALUATOR_VERSION
  | typeof DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION;

/**
 * True for every version scored structurally (evidence matched by id against
 * `STRUCTURAL_GROUND_TRUTH`, root cause by `matchesRootCause`) — v0.3 and
 * v0.4, which differ only in `challenge_effect`. The one predicate every
 * dispatch site (`benchmark-evaluation.ts`, `oracle-arm.ts`,
 * `live-model-lane.ts`, `scripts/eval-oracle.mjs`) uses instead of comparing
 * against `STRUCTURAL_EVALUATOR_VERSION` alone.
 */
export function scoresStructurally(
  evaluatorVersion: string,
): evaluatorVersion is StructuralEvaluatorVersion {
  return (
    evaluatorVersion === STRUCTURAL_EVALUATOR_VERSION ||
    evaluatorVersion === DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION
  );
}

/**
 * The one spelling of "which versions this evaluator accepts", for every
 * refusal message that names them (`evaluateBenchmarkRecord`,
 * `scripts/eval-oracle.mjs`) — so the list is never hand-copied into a second
 * string that can drift from `KNOWN_BEHAVIOR_EVALUATOR_VERSIONS`.
 */
export function knownVersionsMessage(): string {
  const versions = [...KNOWN_BEHAVIOR_EVALUATOR_VERSIONS];
  const last = versions[versions.length - 1];
  return `${versions.slice(0, -1).join(', ')} or ${last}`;
}

export const BEHAVIOR_METRIC_KEYS = [
  'misleading_evidence_handling',
  'false_alert_correctness',
  'challenge_effect',
] as const;

export type BehaviorMetricKey = (typeof BEHAVIOR_METRIC_KEYS)[number];

export interface BehaviorMetric<Key extends BehaviorMetricKey> {
  readonly evaluatorVersion: BehaviorEvaluatorVersion;
  readonly key: Key;
  readonly score: 0 | 1;
  readonly reason: string;
}

interface VersionedEvaluatorInput {
  readonly evaluatorVersion: string;
}

export type RootCause = CauseClaim['cause'];

export interface EvidenceAssessmentObservation {
  readonly fingerprint: EvidenceFingerprint;
  /** The assessed evidence's own id: what the structural evaluator matches on. */
  readonly evidenceId?: string;
  readonly hypothesisId: string;
  readonly effect: EvidenceAssessment['effect'];
}

export interface ChallengeEffectObservation {
  readonly challengeNodeExecuted: boolean;
  readonly challengeInvocationCount: number;
  readonly leaderBeforeChallengeId?: string;
  readonly leaderAfterChallengeId?: string;
  readonly leaderStatusBeforeChallenge?: HypothesisStatus;
  readonly leaderStatusAfterChallenge?: HypothesisStatus;
  readonly executedDiscriminatingTrialCount: number;
}

function fingerprintKey({
  kind,
  source,
  predicate,
}: EvidenceFingerprint): string {
  return JSON.stringify([kind, source, predicate]);
}

function includesEveryFingerprint(
  observed: readonly EvidenceFingerprint[],
  expected: readonly EvidenceFingerprint[],
): boolean {
  const observedKeys = new Set(observed.map(fingerprintKey));
  return expected.every((fingerprint) =>
    observedKeys.has(fingerprintKey(fingerprint)),
  );
}

function requireEvaluatorVersion(input: VersionedEvaluatorInput): void {
  if (input.evaluatorVersion !== BEHAVIOR_EVALUATOR_VERSION) {
    throw new Error(
      `evaluator version must be ${BEHAVIOR_EVALUATOR_VERSION}`,
    );
  }
}

function behaviorMetric<Key extends BehaviorMetricKey>(
  key: Key,
  score: 0 | 1,
  reason: string,
  evaluatorVersion: BehaviorEvaluatorVersion = BEHAVIOR_EVALUATOR_VERSION,
): BehaviorMetric<Key> {
  return {
    evaluatorVersion,
    key,
    score,
    reason,
  };
}

export function evaluateMisleadingEvidenceHandling(
  input: VersionedEvaluatorInput &
    Readonly<{
      groundTruth: Readonly<{
        rootCause: RootCause;
        expectedEvidence: readonly EvidenceFingerprint[];
        misleadingEvidence: readonly EvidenceFingerprint[];
      }>;
      outcome: Readonly<{
        rootCause?: RootCause;
        rootCauseHypothesisId?: string;
        evidenceFingerprints: readonly EvidenceFingerprint[];
        evidenceAssessments: readonly EvidenceAssessmentObservation[];
      }>;
    }>,
): BehaviorMetric<'misleading_evidence_handling'> {
  requireEvaluatorVersion(input);
  const { groundTruth, outcome } = input;

  if (
    !includesEveryFingerprint(
      outcome.evidenceFingerprints,
      groundTruth.misleadingEvidence,
    )
  ) {
    return behaviorMetric(
      'misleading_evidence_handling',
      0,
      'misleading-evidence-not-investigated',
    );
  }
  if (
    !includesEveryFingerprint(
      outcome.evidenceFingerprints,
      groundTruth.expectedEvidence,
    )
  ) {
    return behaviorMetric(
      'misleading_evidence_handling',
      0,
      'expected-evidence-missing',
    );
  }
  if (!isDeepStrictEqual(outcome.rootCause, groundTruth.rootCause)) {
    return behaviorMetric('misleading_evidence_handling', 0, 'root-cause-mismatch');
  }
  const reconcilesMisleadingEvidence =
    outcome.rootCauseHypothesisId !== undefined &&
    groundTruth.misleadingEvidence.every((fingerprint) =>
      outcome.evidenceAssessments.some(
        (assessment) =>
          fingerprintKey(assessment.fingerprint) ===
            fingerprintKey(fingerprint) &&
          assessment.hypothesisId === outcome.rootCauseHypothesisId &&
          assessment.effect !== 'supports',
      ),
    );
  if (!reconcilesMisleadingEvidence) {
    return behaviorMetric(
      'misleading_evidence_handling',
      0,
      'misleading-evidence-not-reconciled',
    );
  }
  return behaviorMetric('misleading_evidence_handling', 1, 'passed');
}

export function evaluateFalseAlertOutcome(
  input: VersionedEvaluatorInput &
    Readonly<{
      groundTruth: Readonly<{
        expectedStopKind: InvestigationStop;
        expectedConclusionKind: IncidentConclusion['kind'];
        expectedEvidence: readonly EvidenceFingerprint[];
      }>;
      outcome: Readonly<{
        stopKind: InvestigationStop;
        conclusionKind: IncidentConclusion['kind'];
        evidenceFingerprints: readonly EvidenceFingerprint[];
      }>;
    }>,
): BehaviorMetric<'false_alert_correctness'> {
  requireEvaluatorVersion(input);
  const { groundTruth, outcome } = input;

  if (outcome.stopKind !== groundTruth.expectedStopKind) {
    return behaviorMetric('false_alert_correctness', 0, 'insufficient-investigation');
  }
  if (
    !includesEveryFingerprint(
      outcome.evidenceFingerprints,
      groundTruth.expectedEvidence,
    )
  ) {
    return behaviorMetric('false_alert_correctness', 0, 'expected-evidence-missing');
  }
  if (outcome.conclusionKind !== groundTruth.expectedConclusionKind) {
    return behaviorMetric('false_alert_correctness', 0, 'incorrect-outcome');
  }
  return behaviorMetric('false_alert_correctness', 1, 'passed');
}

export function evaluateChallengeEffect(
  input: VersionedEvaluatorInput &
    Readonly<{
      groundTruth: Readonly<{
        expectedLeaderChangeAfterChallenge: boolean;
      }>;
      outcome: ChallengeEffectObservation;
    }>,
): BehaviorMetric<'challenge_effect'> {
  requireEvaluatorVersion(input);
  return scoreChallengeEffect(input, BEHAVIOR_EVALUATOR_VERSION);
}

// One scoring of the challenge effect for both versions: the structural
// version changed how evidence and root causes are matched, not this.
function scoreChallengeEffect(
  input: Readonly<{
    groundTruth: Readonly<{ expectedLeaderChangeAfterChallenge: boolean }>;
    outcome: ChallengeEffectObservation;
  }>,
  evaluatorVersion: BehaviorEvaluatorVersion,
): BehaviorMetric<'challenge_effect'> {
  const metric = (score: 0 | 1, reason: string) =>
    behaviorMetric('challenge_effect', score, reason, evaluatorVersion);
  const { groundTruth, outcome } = input;

  if (!outcome.challengeNodeExecuted || outcome.challengeInvocationCount < 1) {
    return metric(0, 'challenge-not-observed');
  }
  if (
    outcome.leaderBeforeChallengeId === undefined ||
    outcome.leaderAfterChallengeId === undefined
  ) {
    return metric(0, 'leader-observation-missing');
  }

  const leaderChanged =
    outcome.leaderBeforeChallengeId !== outcome.leaderAfterChallengeId;
  const statusChanged =
    outcome.leaderStatusBeforeChallenge !== undefined &&
    outcome.leaderStatusAfterChallenge !== undefined &&
    outcome.leaderStatusBeforeChallenge !== outcome.leaderStatusAfterChallenge;
  const discriminatingTrialExecuted =
    outcome.executedDiscriminatingTrialCount > 0;

  if (!leaderChanged && !statusChanged && !discriminatingTrialExecuted) {
    return metric(0, 'no-investigation-change');
  }
  // AIC-138: only behavior-evaluators-v0.4 demands the change be backed by a
  // discriminating trial the challenge round actually executed. v0.2 and v0.3
  // stay exactly as they were — a matching leader or status change with zero
  // trials still passes under both.
  // see challenge-effect-discriminating-evaluator.test.mjs › "under behavior-evaluators-v0.4, a challenge that changes the leader as expected with no executed discriminating trial scores 0 with reason no-discriminating-trial"
  // see challenge-effect-discriminating-evaluator.test.mjs › "the leader-change-without-trial observation still scores 1 passed under behavior-evaluators-v0.3 and behavior-evaluators-v0.2"
  if (
    evaluatorVersion === DISCRIMINATING_CHALLENGE_EVALUATOR_VERSION &&
    !discriminatingTrialExecuted
  ) {
    return metric(0, 'no-discriminating-trial');
  }
  if (
    leaderChanged !== groundTruth.expectedLeaderChangeAfterChallenge
  ) {
    return metric(0, 'leader-change-mismatch');
  }
  return metric(1, 'passed');
}

/**
 * The structural (`behavior-evaluators-v0.3`) behaviour metrics.
 *
 * Same questions as the accepted evaluators above, answered from
 * `STRUCTURAL_GROUND_TRUTH`: evidence counts as investigated only when the arm
 * REFERENCED its id — shown or collected is not enough — and the root cause is
 * compared with `matchesRootCause`, never by prose.
 */
function referencesEvery(
  referenced: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  const ids = new Set(referenced ?? []);
  return expected.every((id) => ids.has(id));
}

export function evaluateStructuralMisleadingEvidenceHandling(
  input: Readonly<{
    truth: StructuralGroundTruthEntry;
    outcome: Readonly<{
      rootCause?: RootCause;
      rootCauseHypothesisId?: string;
      referencedEvidenceIds?: readonly string[];
      evidenceAssessments?: readonly EvidenceAssessmentObservation[];
    }>;
  }>,
  evaluatorVersion: StructuralEvaluatorVersion = STRUCTURAL_EVALUATOR_VERSION,
): BehaviorMetric<'misleading_evidence_handling'> {
  const { truth, outcome } = input;
  const metric = (score: 0 | 1, reason: string) =>
    behaviorMetric('misleading_evidence_handling', score, reason, evaluatorVersion);
  const misleading = truth.misleadingEvidenceIds ?? [];
  if (truth.rootCause === undefined) {
    throw new Error('structural misleading-evidence handling needs a structural root cause');
  }

  if (!referencesEvery(outcome.referencedEvidenceIds, misleading)) {
    return metric(0, 'misleading-evidence-not-investigated');
  }
  if (!referencesEvery(outcome.referencedEvidenceIds, truth.expectedEvidenceIds)) {
    return metric(0, 'expected-evidence-missing');
  }
  if (!matchesRootCause(truth.rootCause, outcome.rootCause)) {
    return metric(0, 'root-cause-mismatch');
  }
  const assessments = outcome.evidenceAssessments ?? [];
  const reconciled =
    outcome.rootCauseHypothesisId !== undefined &&
    misleading.every((evidenceId) =>
      assessments.some(
        (assessment) =>
          assessment.evidenceId === evidenceId &&
          assessment.hypothesisId === outcome.rootCauseHypothesisId &&
          assessment.effect !== 'supports',
      ),
    );
  if (!reconciled) return metric(0, 'misleading-evidence-not-reconciled');
  return metric(1, 'passed');
}

export function evaluateStructuralFalseAlertOutcome(
  input: Readonly<{
    truth: StructuralGroundTruthEntry;
    expectedStopKind: InvestigationStop;
    expectedConclusionKind: IncidentConclusion['kind'];
    outcome: Readonly<{
      stopKind: InvestigationStop;
      conclusionKind: IncidentConclusion['kind'];
      referencedEvidenceIds?: readonly string[];
    }>;
  }>,
  evaluatorVersion: StructuralEvaluatorVersion = STRUCTURAL_EVALUATOR_VERSION,
): BehaviorMetric<'false_alert_correctness'> {
  const { truth, outcome } = input;
  const metric = (score: 0 | 1, reason: string) =>
    behaviorMetric('false_alert_correctness', score, reason, evaluatorVersion);
  if (outcome.stopKind !== input.expectedStopKind) {
    return metric(0, 'insufficient-investigation');
  }
  if (!referencesEvery(outcome.referencedEvidenceIds, truth.expectedEvidenceIds)) {
    return metric(0, 'expected-evidence-missing');
  }
  if (outcome.conclusionKind !== input.expectedConclusionKind) {
    return metric(0, 'incorrect-outcome');
  }
  return metric(1, 'passed');
}

export function evaluateStructuralChallengeEffect(
  input: Readonly<{
    groundTruth: Readonly<{ expectedLeaderChangeAfterChallenge: boolean }>;
    outcome: ChallengeEffectObservation;
  }>,
  evaluatorVersion: StructuralEvaluatorVersion = STRUCTURAL_EVALUATOR_VERSION,
): BehaviorMetric<'challenge_effect'> {
  return scoreChallengeEffect(input, evaluatorVersion);
}

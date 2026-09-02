import { isDeepStrictEqual } from 'node:util';

import type {
  CauseClaim,
  EvidenceAssessment,
  HypothesisStatus,
  IncidentConclusion,
  InvestigationStop,
} from '@aic/domain';

import type { EvidenceFingerprint } from './replay-scenarios.js';

export const BEHAVIOR_EVALUATOR_VERSION =
  'behavior-evaluators-v0.2' as const;

export const BEHAVIOR_METRIC_KEYS = [
  'misleading_evidence_handling',
  'false_alert_correctness',
  'challenge_effect',
] as const;

export type BehaviorMetricKey = (typeof BEHAVIOR_METRIC_KEYS)[number];

export interface BehaviorMetric<Key extends BehaviorMetricKey> {
  readonly evaluatorVersion: typeof BEHAVIOR_EVALUATOR_VERSION;
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

function metric<Key extends BehaviorMetricKey>(
  key: Key,
  score: 0 | 1,
  reason: string,
): BehaviorMetric<Key> {
  return {
    evaluatorVersion: BEHAVIOR_EVALUATOR_VERSION,
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
    return metric(
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
    return metric(
      'misleading_evidence_handling',
      0,
      'expected-evidence-missing',
    );
  }
  if (!isDeepStrictEqual(outcome.rootCause, groundTruth.rootCause)) {
    return metric('misleading_evidence_handling', 0, 'root-cause-mismatch');
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
    return metric(
      'misleading_evidence_handling',
      0,
      'misleading-evidence-not-reconciled',
    );
  }
  return metric('misleading_evidence_handling', 1, 'passed');
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
    return metric('false_alert_correctness', 0, 'insufficient-investigation');
  }
  if (
    !includesEveryFingerprint(
      outcome.evidenceFingerprints,
      groundTruth.expectedEvidence,
    )
  ) {
    return metric('false_alert_correctness', 0, 'expected-evidence-missing');
  }
  if (outcome.conclusionKind !== groundTruth.expectedConclusionKind) {
    return metric('false_alert_correctness', 0, 'incorrect-outcome');
  }
  return metric('false_alert_correctness', 1, 'passed');
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
  const { groundTruth, outcome } = input;

  if (!outcome.challengeNodeExecuted || outcome.challengeInvocationCount < 1) {
    return metric('challenge_effect', 0, 'challenge-not-observed');
  }
  if (
    outcome.leaderBeforeChallengeId === undefined ||
    outcome.leaderAfterChallengeId === undefined
  ) {
    return metric('challenge_effect', 0, 'leader-observation-missing');
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
    return metric('challenge_effect', 0, 'no-investigation-change');
  }
  if (
    leaderChanged !== groundTruth.expectedLeaderChangeAfterChallenge
  ) {
    return metric('challenge_effect', 0, 'leader-change-mismatch');
  }
  return metric('challenge_effect', 1, 'passed');
}

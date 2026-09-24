import {
  EvidenceAssessmentSchema,
  type Evidence,
  type EvidenceAssessment,
  type HypothesisStatus,
  type Prediction,
} from './contracts.js';
import { quoteModelText } from './conclusion-rules.js';
import {
  STATUS_RULES,
  STATUS_RULES_VERSION,
  type StatusRulesVersion,
} from './status-rules.js';

export interface PredictionEvidencePair {
  readonly prediction: Prediction;
  readonly evidence: Evidence;
}

export interface EvaluatePredictionsOptions {
  readonly predictions: readonly Prediction[];
  readonly evidence: readonly Evidence[];
  readonly evaluateRule: (
    input: PredictionEvidencePair,
  ) => EvidenceAssessment | null;
}

export interface EvaluatePredictionsResult {
  readonly assessments: EvidenceAssessment[];
  readonly residual: PredictionEvidencePair[];
}

export interface InterpretResidualEvidenceOptions {
  readonly residual: readonly PredictionEvidencePair[];
  readonly evaluateSemantic: (
    input: PredictionEvidencePair,
  ) => EvidenceAssessment | Promise<EvidenceAssessment>;
}

export interface DeriveHypothesisStatusOptions {
  readonly hypothesisId: string;
  readonly predictions: readonly Prediction[];
  readonly assessments: readonly EvidenceAssessment[];
  readonly evidence: readonly Evidence[];
  /**
   * Which `STATUS_RULES` table to derive under. Defaults to the current
   * `STATUS_RULES_VERSION` so ordinary callers get today's rules; pinning an
   * older version (e.g. `'v0.1'`) keeps historical evidence and evaluation
   * meaning what they meant when it was recorded. An unrecognised version
   * throws rather than silently falling back — see status-rules-v02.test.mjs
   * › "throws on an unknown status-rules version instead of silently falling
   * back".
   */
  readonly rulesVersion?: StatusRulesVersion;
}

function requireRuleAssessment(
  assessment: EvidenceAssessment,
  pair: PredictionEvidencePair,
): EvidenceAssessment {
  const parsed = EvidenceAssessmentSchema.parse(assessment);

  if (parsed.producedBy !== 'rule') {
    throw new Error('evaluateRule assessment producedBy must be rule');
  }

  return requireMatchingPair(parsed, pair);
}

function requireSemanticAssessment(
  assessment: EvidenceAssessment,
  pair: PredictionEvidencePair,
): EvidenceAssessment {
  const parsed = EvidenceAssessmentSchema.parse(assessment);

  if (parsed.producedBy !== 'llm') {
    throw new Error('evaluateSemantic assessment producedBy must be llm');
  }

  if (parsed.promptVersion === undefined) {
    throw new Error('evaluateSemantic assessment requires promptVersion');
  }

  return requireMatchingPair(parsed, pair);
}

function requireMatchingPair(
  assessment: EvidenceAssessment,
  pair: PredictionEvidencePair,
): EvidenceAssessment {
  if (assessment.evidenceId !== pair.evidence.id) {
    throw new Error('assessment evidenceId must match the evaluated evidence');
  }

  if (assessment.predictionId !== pair.prediction.id) {
    throw new Error('assessment predictionId must match the evaluated prediction');
  }

  if (assessment.hypothesisId !== pair.prediction.hypothesisId) {
    throw new Error('assessment hypothesisId must match the evaluated hypothesis');
  }

  return assessment;
}

export function evaluatePredictions({
  predictions,
  evidence,
  evaluateRule,
}: EvaluatePredictionsOptions): EvaluatePredictionsResult {
  const assessments: EvidenceAssessment[] = [];
  const residual: PredictionEvidencePair[] = [];

  for (const prediction of predictions) {
    for (const evidenceItem of evidence) {
      const input = { prediction, evidence: evidenceItem };
      const ruleAssessment = evaluateRule(input);

      if (ruleAssessment !== null) {
        assessments.push(requireRuleAssessment(ruleAssessment, input));
      } else {
        residual.push(input);
      }
    }
  }

  return { assessments, residual };
}

export async function interpretResidualEvidence({
  residual,
  evaluateSemantic,
}: InterpretResidualEvidenceOptions): Promise<EvidenceAssessment[]> {
  const assessments: EvidenceAssessment[] = [];

  for (const pair of residual) {
    const assessment = await evaluateSemantic(pair);
    assessments.push(requireSemanticAssessment(assessment, pair));
  }

  return assessments;
}

function includesStrength(
  strengths: readonly string[],
  strength: EvidenceAssessment['strength'],
): boolean {
  return strengths.includes(strength);
}

export function deriveHypothesisStatus({
  hypothesisId,
  predictions,
  assessments,
  evidence,
  rulesVersion = STATUS_RULES_VERSION,
}: DeriveHypothesisStatusOptions): HypothesisStatus {
  const requestedVersion: string = rulesVersion;
  const table: (typeof STATUS_RULES)[StatusRulesVersion] | undefined = (
    STATUS_RULES as Record<string, (typeof STATUS_RULES)[StatusRulesVersion]>
  )[requestedVersion];

  if (table === undefined) {
    throw new Error(
      `deriveHypothesisStatus: unknown status-rules version ${quoteModelText(requestedVersion)}`,
    );
  }

  const rules = table.hypothesis.rules;
  const hypothesisPredictions = predictions.filter(
    (prediction) => prediction.hypothesisId === hypothesisId,
  );
  const hypothesisAssessments = assessments.filter(
    (assessment) => assessment.hypothesisId === hypothesisId,
  );
  const predictionsById = new Map(
    hypothesisPredictions.map((prediction) => [prediction.id, prediction]),
  );
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  for (const assessment of hypothesisAssessments) {
    if (!evidenceById.has(assessment.evidenceId)) {
      throw new Error(
        `assessment evidenceId does not reference supplied evidence: ${quoteModelText(assessment.evidenceId)}`,
      );
    }

    if (
      assessment.predictionId !== undefined &&
      !predictionsById.has(assessment.predictionId)
    ) {
      throw new Error(
        `assessment predictionId does not reference this hypothesis: ${quoteModelText(assessment.predictionId)}`,
      );
    }
  }

  const isRejected = hypothesisAssessments.some((assessment) => {
    if (
      assessment.effect !== 'contradicts' ||
      assessment.predictionId === undefined
    ) {
      return false;
    }

    return (
      predictionsById.get(assessment.predictionId)?.status ===
        rules.rejected.predictionStatus &&
      evidenceById.get(assessment.evidenceId)?.reliability ===
        rules.rejected.evidenceReliability
    );
  });

  if (isRejected) return 'rejected';

  const hasMaterialContradiction = hypothesisAssessments.some(
    (assessment) =>
      assessment.effect === 'contradicts' &&
      includesStrength(
        rules.weakened.contradictionStrengths,
        assessment.strength,
      ),
  );

  if (hasMaterialContradiction) return 'weakened';

  const independentSupports = new Set(
    hypothesisAssessments
      .filter(
        (assessment) =>
          assessment.effect === 'supports' &&
          includesStrength(
            rules.supported.supportStrengths,
            assessment.strength,
          ),
      )
      .map((assessment) => assessment.evidenceId),
  );
  const confirmedPredictions = hypothesisPredictions.filter(
    (prediction) => prediction.status === 'confirmed',
  ).length;
  const hasForbiddenContradiction = hypothesisAssessments.some(
    (assessment) =>
      assessment.effect === 'contradicts' &&
      includesStrength(
        rules.supported.forbiddenContradictionStrengths,
        assessment.strength,
      ),
  );

  const meetsCorroborationShape =
    independentSupports.size >= rules.supported.minimumIndependentSupports &&
    !hasForbiddenContradiction;

  if (
    meetsCorroborationShape &&
    confirmedPredictions >= rules.supported.minimumConfirmedPredictions
  ) {
    return 'supported';
  }

  if (
    'corroborated' in rules &&
    meetsCorroborationShape &&
    confirmedPredictions <= rules.corroborated.maximumConfirmedPredictions
  ) {
    return 'corroborated';
  }

  return 'candidate';
}

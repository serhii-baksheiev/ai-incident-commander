import {
  canonicalJson,
  evaluatePredictionObservations,
  type EvidenceAssessment,
  type IncidentState,
  type Prediction,
} from '@aic/domain';

import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';

/**
 * AIC-124 slice b: the canonical `evaluate_predictions` node.
 *
 * It evaluates the predictions already in `state.predictions` against
 * `state.evidence` as of `asOf()` (`evaluatePredictionObservations`,
 * `@aic/domain`, slice a). It never derives: a prediction exists only once
 * `derive_predictions` created it, so a test can be planned for it before it
 * is graded — see prediction-nodes.test.mjs › "the evaluate node never
 * derives predictions itself: a hypothesis with a cause and a matching fact
 * but no predictions in state yields no predictions and no assessments".
 *
 * `asOf` is injected rather than read from the clock, so this node stays free
 * of ambient I/O the way every other lifecycle node in this package is.
 *
 * The reducer for both `predictions` and `assessments`
 * (`InvestigationStateAnnotation` in `../investigation.js`) is `upsertById`,
 * so this node returns only what changed: a prediction whose value differs
 * from the state's record at the same id, and an assessment not already
 * present in `state.assessments` with an identical value — see
 * prediction-nodes.test.mjs › "does not re-emit an already-decided prediction
 * of one hypothesis while newly confirming another hypothesis's untested
 * prediction, both derived beforehand" and › "calling the node twice,
 * applying the first result to the state by id (upsert) between calls, is
 * idempotent: the second call finds no further changes". The comparison is
 * structural (`canonicalJson`, `@aic/domain`), because an equal but distinct
 * value must still read as unchanged.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

export function createEvaluatePredictions({
  asOf,
}: Readonly<{ asOf: () => string }>): InvestigationNode {
  return (state: IncidentState): InvestigationNodeResult => {
    const { predictions: evaluated, assessments } = evaluatePredictionObservations({
      predictions: state.predictions,
      evidence: state.evidence,
      asOf: asOf(),
    });

    const existingPredictionsById = new Map<string, Prediction>(
      state.predictions.map((prediction) => [prediction.id, prediction]),
    );
    const predictions = evaluated.filter((prediction) => {
      const existing = existingPredictionsById.get(prediction.id);
      return existing === undefined || !sameValue(existing, prediction);
    });

    const existingAssessmentsById = new Map<string, EvidenceAssessment>(
      state.assessments.map((assessment) => [assessment.id, assessment]),
    );
    const filteredAssessments = assessments.filter((assessment) => {
      const existing = existingAssessmentsById.get(assessment.id);
      return existing === undefined || !sameValue(existing, assessment);
    });

    return { predictions, assessments: filteredAssessments };
  };
}

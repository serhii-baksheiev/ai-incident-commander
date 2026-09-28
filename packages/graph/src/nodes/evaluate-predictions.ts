import {
  canonicalJson,
  derivePredictions,
  evaluatePredictionObservations,
  type EvidenceAssessment,
  type IncidentState,
  type Prediction,
  type PredictionTemplateSet,
} from '@aic/domain';

import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';
import { PREDICTION_TEMPLATES } from '../prediction-templates.js';

/**
 * AIC-124 slice b: the canonical `evaluate_predictions` node.
 *
 * It derives predictions for every hypothesis still eligible (`derivePredictions`,
 * `@aic/domain`, slice a) and evaluates the combined set — `state.predictions`
 * plus what it just derived — against `state.evidence` as of `asOf()`
 * (`evaluatePredictionObservations`, same module). Doing both in one call,
 * rather than relying on a separate `derive_predictions` edge, is what gives a
 * challenge alternative — created with no predictions of its own — a
 * prediction and a verdict in the same pass: see prediction-nodes.test.mjs ›
 * "derives and evaluates predictions for an alternative hypothesis created
 * without predictions, in the same call, without re-emitting an
 * already-decided prediction of another hypothesis".
 *
 * `asOf` is injected rather than read from the clock, so this node stays free
 * of ambient I/O the way every other lifecycle node in this package is.
 *
 * The reducer for both `predictions` and `assessments`
 * (`InvestigationStateAnnotation` in `../investigation.js`) is `upsertById`,
 * so this node returns only what actually changed: a prediction that is
 * newly derived this call, or whose value differs from the state's record at
 * the same id, and an assessment not already present in `state.assessments`
 * with an identical value. Emitting the unchanged remainder as well would
 * still be correct under `upsertById` (a no-op write), but would make the
 * node's own output an unreliable signal of what changed — see
 * prediction-nodes.test.mjs › "calling the node twice, applying the first
 * result to the state by id (upsert) between calls, is idempotent: the
 * second call finds no further changes". The comparison is structural
 * (`canonicalJson`, `@aic/domain`) rather than by reference, since
 * `evaluatePredictionObservations` returns the same prediction object back
 * unchanged only when nothing decided it (rule 8 of that module) — anything
 * else that produces an equal-but-distinct value must still be read as
 * unchanged.
 *
 * Result shape is always `{ predictions, assessments }`, even when both are
 * empty — see prediction-nodes.test.mjs › "a hypothesis with no cause gets no
 * predictions and no assessments".
 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

export function createEvaluatePredictions({
  asOf,
  templates = PREDICTION_TEMPLATES,
}: Readonly<{ asOf: () => string; templates?: PredictionTemplateSet }>): InvestigationNode {
  return (state: IncidentState): InvestigationNodeResult => {
    const derived = derivePredictions({
      hypotheses: state.hypotheses,
      predictions: state.predictions,
      templates,
    });

    const { predictions: evaluated, assessments } = evaluatePredictionObservations({
      predictions: [...state.predictions, ...derived],
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

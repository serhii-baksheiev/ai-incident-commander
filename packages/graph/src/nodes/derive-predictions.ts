import { derivePredictions, type IncidentState, type PredictionTemplateSet } from '@aic/domain';

import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';
import { PREDICTION_TEMPLATES } from '../prediction-templates.js';

/**
 * AIC-124 slice b: the canonical `derive_predictions` node. A thin wrapper
 * over the pure `derivePredictions` (`@aic/domain`, slice a), supplying
 * `PREDICTION_TEMPLATES` (`../prediction-templates.js`) as the default
 * mechanism -> template table — see prediction-nodes.test.mjs ›
 * "createDerivePredictions() returns an InvestigationNode whose predictions
 * deepEqual derivePredictions over the same state, using PREDICTION_TEMPLATES
 * by default".
 *
 * `templates` is a caller-supplied override rather than a hard-coded import,
 * so a test can exercise the wiring against a small table instead of the
 * production one — see prediction-nodes.test.mjs › "createDerivePredictions
 * accepts a caller-supplied templates option, overriding the default table".
 *
 * Lane wiring — which graph edge calls this node — is a later slice's
 * concern, not this one's.
 */
export function createDerivePredictions({
  templates = PREDICTION_TEMPLATES,
}: Readonly<{ templates?: PredictionTemplateSet }> = {}): InvestigationNode {
  return (state: IncidentState): InvestigationNodeResult => {
    const predictions = derivePredictions({
      hypotheses: state.hypotheses,
      predictions: state.predictions,
      templates,
    });
    return { predictions };
  };
}

import { planInvestigation, type IncidentState, type InvestigationRouteTable } from '@aic/domain';

import type { InvestigationNode, InvestigationNodeResult } from '../investigation.js';
import { INVESTIGATION_ROUTES } from '../investigation-routes.js';

/**
 * AIC-125 slice a: the canonical `plan_investigation` node. A thin wrapper
 * over the pure `planInvestigation` (`@aic/domain`), supplying
 * `INVESTIGATION_ROUTES` (`../investigation-routes.js`) as the default
 * observation-form -> tool request table — see investigation-routes.test.mjs
 * › "createPlanInvestigation() returns an InvestigationNode whose tests
 * deepEqual planInvestigation over the same state, using INVESTIGATION_ROUTES
 * by default" and › "createPlanInvestigation() returns tests: [] when every
 * prediction is decided".
 *
 * `routes` is a caller-supplied override rather than a hard-coded import, so
 * a test can exercise the wiring against a small table instead of the
 * production one — see investigation-routes.test.mjs › "accepts a
 * caller-supplied routes option, overriding the default table".
 *
 * Lane wiring — which graph edge calls this node — is a later slice's
 * concern, not this one's.
 */
export function createPlanInvestigation({
  routes = INVESTIGATION_ROUTES,
}: Readonly<{ routes?: InvestigationRouteTable }> = {}): InvestigationNode {
  return (state: IncidentState): InvestigationNodeResult => {
    const tests = planInvestigation({
      predictions: state.predictions,
      tests: state.tests,
      routes,
    });
    return { tests };
  };
}

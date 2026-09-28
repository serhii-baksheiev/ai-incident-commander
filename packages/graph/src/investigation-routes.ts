import type { InvestigationRouteEntry, InvestigationRouteTable } from '@aic/domain';

/**
 * AIC-125 slice a: `INVESTIGATION_ROUTES`, the observation-form -> tool
 * request table `createPlanInvestigation` (`./nodes/plan-investigation.ts`)
 * defaults to. `planInvestigation` (`@aic/domain`, the domain half of this
 * slice) takes the table as a caller-supplied parameter; this is the one
 * production table this package registers.
 *
 * `@aic/graph` cannot import `@aic/tools` or `@aic/evals` in production —
 * either would create a dependency this package does not carry —
 * `investigation-routes.test.mjs` can import both and is the independent
 * check that every `tool` id this table names is a registered id in
 * `READ_ONLY_TOOL_REGISTRY` (`@aic/tools`), and that the table names no
 * replay-corpus value (a scenario id, an evidence id, an
 * `OBSERVATION_ANNOTATIONS` subject, or a recorded input value from
 * `REPLAY_SCENARIOS`, `@aic/evals`) — see investigation-routes.test.mjs ›
 * "every tool id in INVESTIGATION_ROUTES is a registered read-only tool
 * (READ_ONLY_TOOL_REGISTRY, @aic/tools)" and › "INVESTIGATION_ROUTES names no
 * replay-corpus value: no scenario id, evidence id, annotation subject, or
 * recorded input value".
 *
 * Each entry's `input` mapping names, per request field, which of the three
 * `ExpectedObservation` forms' own fields (`@aic/domain`) supplies it — a
 * request-vocabulary fact, never a corpus value. `byForm` names exactly the
 * three forms `ExpectedObservationSchema` declares, in both directions — see
 * investigation-routes.test.mjs › "every form of the ExpectedObservation
 * union is routed" — and every observation `PREDICTION_TEMPLATES`
 * (`./prediction-templates.ts`) registers is routable through this table —
 * see investigation-routes.test.mjs › "every observation of every
 * PREDICTION_TEMPLATES template is routable through INVESTIGATION_ROUTES".
 *
 * Deeply frozen so no caller can mutate a shared default out from under
 * another — see investigation-routes.test.mjs › "INVESTIGATION_ROUTES is
 * deeply frozen".
 */

function route(value: InvestigationRouteEntry): InvestigationRouteEntry {
  return Object.freeze({ ...value, input: Object.freeze({ ...value.input }) });
}

export const INVESTIGATION_ROUTES: InvestigationRouteTable = Object.freeze({
  version: 'investigation-routes-v1',
  byForm: Object.freeze({
    'deployment-in-window': route({
      tool: 'deployments',
      input: { service: 'subject', window: 'window' },
    }),
    'signal-state': route({
      tool: 'metrics',
      input: { service: 'subject', window: 'window', metric: 'signal' },
    }),
    'log-class-in-window': route({
      tool: 'logs',
      input: { service: 'subject', window: 'window', query: 'logClass' },
    }),
  }),
});

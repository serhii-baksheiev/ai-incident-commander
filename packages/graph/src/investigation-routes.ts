import type {
  InvestigationRouteEntry,
  InvestigationRouteRefusal,
  InvestigationRouteTable,
} from '@aic/domain';

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
 *
 * (AIC-142) `signal-state` is semantically broader than one source family, so
 * its `byForm` entry is a per-signal selector (`bySignal`) rather than one
 * flat route — the owner-ruled policy (AIC-142 design, "Semantic route
 * policy"):
 *
 * | signal | route | reason |
 * | --- | --- | --- |
 * | error-rate | metrics | the subject's own request error rate: a service-level metric (RED "errors") |
 * | connection-pool | metrics | occupancy of the subject's own pool: a resource-saturation metric of the subject |
 * | worker-saturation | metrics | occupancy of the subject's own workers: a resource-saturation metric of the subject |
 * | dependency-health | dependencies | health of the subject as a dependency, a dependency-graph quantity no metrics series names; the frozen reviewed vocabulary places every such fact on the dependency source |
 * | latency | REFUSED | latency is metric-native for a service's own requests (RED "duration"), yet the frozen reviewed vocabulary records "latency of X" observed from the dependency source; the vocabulary carries no vantage field, so "latency of X" names two source families |
 *
 * All four routed signals share one input mapping (`METRICS_SIGNAL_INPUT`),
 * so a `dependencies` request is expressible within the challenge role's
 * closed input keys — see investigation-routes.test.mjs › "pins the exact
 * route table content: version and byForm for every form and every signal,
 * except the free-text latency refusal reason", › "every SignalKind appears
 * in INVESTIGATION_ROUTES.byForm['signal-state'].bySignal exactly once, as a
 * route or a refusal, and bySignal names no key outside SignalKindSchema —
 * both directions", the per-signal routing rows and › "latency is an explicit
 * refusal: bySignal.latency carries a refusal reason and no tool, and
 * planInvestigation plans no test for a latency observation, never falling
 * back to metrics or any other tool".
 *
 * No `PREDICTION_TEMPLATES` template (`./prediction-templates.ts`) currently
 * derives a `dependency-health` or a `latency` signal-state observation — see
 * investigation-routes.test.mjs's own template-routability sweep, which only
 * ever exercises error-rate, connection-pool and worker-saturation. Repairing
 * routing alone therefore changes no template-derived reachability today; it
 * changes what a typed `dependency-health` request (from a future template or
 * a challenge role's own discriminating test) can reach.
 */

const METRICS_SIGNAL_INPUT = Object.freeze({ service: 'subject', window: 'window', metric: 'signal' });

function route(value: InvestigationRouteEntry): InvestigationRouteEntry {
  return Object.freeze({ ...value, input: Object.freeze({ ...value.input }) });
}

function refusal(value: InvestigationRouteRefusal): InvestigationRouteRefusal {
  return Object.freeze({ ...value });
}

export const INVESTIGATION_ROUTES: InvestigationRouteTable = Object.freeze({
  version: 'investigation-routes-v2',
  byForm: Object.freeze({
    'deployment-in-window': route({
      tool: 'deployments',
      input: { service: 'subject', window: 'window' },
    }),
    'signal-state': Object.freeze({
      bySignal: Object.freeze({
        'error-rate': route({ tool: 'metrics', input: METRICS_SIGNAL_INPUT }),
        'connection-pool': route({ tool: 'metrics', input: METRICS_SIGNAL_INPUT }),
        'worker-saturation': route({ tool: 'metrics', input: METRICS_SIGNAL_INPUT }),
        'dependency-health': route({ tool: 'dependencies', input: METRICS_SIGNAL_INPUT }),
        latency: refusal({
          refused:
            'latency is metric-native for a service\'s own requests, yet the frozen ' +
            'reviewed vocabulary also records "latency of X" observed from the ' +
            'dependency source; the vocabulary carries no vantage field, so latency ' +
            'names two source families and no route picks between them',
        }),
      }),
    }),
    'log-class-in-window': route({
      tool: 'logs',
      input: { service: 'subject', window: 'window', query: 'logClass' },
    }),
  }),
});

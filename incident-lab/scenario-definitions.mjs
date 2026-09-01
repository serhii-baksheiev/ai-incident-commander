import { isDeepStrictEqual } from 'node:util';

export const LAB_TOPOLOGY_VERSION = 2;

const observedAt = '2026-08-26T15:00:00.000Z';

function evidence(id, kind, source, statement) {
  return Object.freeze({
    id,
    trialId: `trial-${id}`,
    kind,
    source,
    observedAt,
    statement,
    rawRef: `replay://${source}/${id}`,
  });
}

function observation(toolId, input, output, owner = 'api') {
  return Object.freeze({
    toolId,
    input: Object.freeze(input),
    output: Object.freeze(output),
    owner,
  });
}

export const LIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'bad-deployment',
    version: 1,
    observations: Object.freeze([
      observation('deployments', { service: 'checkout', window: 'incident' }, [
        evidence(
          'checkout-deploy-v42',
          'deploy',
          'deployments/checkout',
          'checkout-v42 changed the database endpoint configuration',
        ),
      ]),
      observation('logs', { service: 'checkout', query: 'startup-errors' }, [
        evidence(
          'checkout-invalid-database-endpoint',
          'log',
          'logs/checkout',
          'checkout rejected the database endpoint after checkout-v42',
        ),
      ]),
    ]),
  }),
  Object.freeze({
    id: 'db-pool-exhaustion',
    version: 1,
    observations: Object.freeze([
      observation('metrics', { service: 'checkout', metric: 'db_pool_active' }, [
        evidence(
          'checkout-db-pool-active',
          'metric',
          'metrics/checkout-db-pool',
          'active connections equalled the configured pool maximum',
        ),
      ]),
      observation('logs', { service: 'checkout', query: 'connection-timeout' }, [
        evidence(
          'checkout-db-pool-timeout',
          'log',
          'logs/checkout',
          'requests timed out while acquiring a database connection',
        ),
      ]),
    ]),
  }),
  Object.freeze({
    id: 'false-alert',
    version: 1,
    observations: Object.freeze([
      observation('metrics', { service: 'checkout', metric: 'error_rate' }, [
        evidence(
          'checkout-normal-error-rate',
          'metric',
          'metrics/checkout',
          'the error rate remained below the incident threshold',
        ),
      ]),
      observation('logs', { service: 'checkout', query: 'server-errors' }, [
        evidence(
          'checkout-no-server-errors',
          'log',
          'logs/checkout',
          'no matching server errors were recorded',
        ),
      ]),
    ]),
  }),
  Object.freeze({
    id: 'deployment-caused-incident-a',
    version: 1,
    observations: Object.freeze([
      observation('deployments', { service: 'payments', window: 'incident' }, [
        evidence(
          'confirmation-deploy-v17',
          'deploy',
          'deployments/payments',
          'payments-v17 completed five minutes before the first alert',
        ),
      ], 'payments'),
      observation('dependencies', { service: 'payments', window: 'incident' }, [
        evidence(
          'payments-dependencies-healthy',
          'dependency',
          'dependencies/payments',
          'payments dependencies stayed healthy during the incident window',
        ),
      ], 'payments'),
    ]),
  }),
  Object.freeze({
    id: 'dependency-caused-incident-b',
    version: 1,
    observations: Object.freeze([
      observation('deployments', { service: 'payments', window: 'incident' }, [
        evidence(
          'confirmation-deploy-v17',
          'deploy',
          'deployments/payments',
          'payments-v17 completed five minutes before the first alert',
        ),
      ], 'payments'),
      observation('dependencies', { service: 'payments', window: 'incident' }, [
        evidence(
          'inventory-api-pool-saturation',
          'dependency',
          'dependencies/payments',
          'inventory-api reported connection pool saturation',
        ),
      ], 'inventory'),
    ]),
  }),
]);

export const LIVE_SCENARIO_IDS = Object.freeze(
  LIVE_SCENARIOS.map(({ id }) => id),
);

export function findLiveScenario(scenarioId) {
  return LIVE_SCENARIOS.find(({ id }) => id === scenarioId);
}

export function findScenarioObservation(scenario, toolId, input) {
  return scenario.observations.find(
    (candidate) =>
      candidate.toolId === toolId
      && isDeepStrictEqual(candidate.input, input),
  );
}

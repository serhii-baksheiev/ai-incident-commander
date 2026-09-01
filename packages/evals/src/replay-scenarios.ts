import { randomUUID } from 'node:crypto';

import type {
  Evidence,
  IncidentConclusion,
  InvestigationStop,
  ToolId,
} from '@aic/domain';

const SCENARIO_FIXTURE_VERSION = 1 as const;

export interface EvidenceFingerprint {
  readonly kind: Evidence['kind'];
  readonly source: string;
  readonly predicate: string;
}

export interface IncidentScenario {
  readonly id: string;
  readonly groundTruth: Readonly<{
    rootCause?: Readonly<{
      component: string;
      mechanism: string;
      trigger?: string;
    }>;
    expectedStopKind: InvestigationStop;
    expectedConclusionKind: IncidentConclusion['kind'];
    expectedEvidence: readonly EvidenceFingerprint[];
    misleadingEvidence?: readonly EvidenceFingerprint[];
  }>;
  readonly fixture: ScenarioReplayFixture;
}

export interface BenchmarkInvocation {
  readonly scenario: IncidentScenario;
  readonly runId: string;
  readonly threadId: string;
  readonly humanReview: false;
}

export type RecordedToolResult =
  | Readonly<{ status: 'ok'; output: Evidence[] }>
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'error'; message: string }>;

export type ScenarioReplayEntry = Readonly<{
  toolId: ToolId;
  input: unknown;
  result: RecordedToolResult;
}>;

export interface ScenarioReplayFixture {
  readonly version: typeof SCENARIO_FIXTURE_VERSION;
  readonly entries: readonly ScenarioReplayEntry[];
}

const replayFixture = (
  ...entries: readonly ScenarioReplayEntry[]
): ScenarioReplayFixture => ({
  version: SCENARIO_FIXTURE_VERSION,
  entries,
});

const evidence = (
  id: string,
  kind: Evidence['kind'],
  source: string,
  statement: string,
): Evidence => ({
  id,
  trialId: `trial-${id}`,
  kind,
  source,
  observedAt: '2026-08-26T15:00:00.000Z',
  statement,
  rawRef: `replay://${source}/${id}`,
});

const ok = (...output: readonly Evidence[]): RecordedToolResult => ({
  status: 'ok',
  output: [...output],
});

const confirmationDeploymentFingerprint: EvidenceFingerprint = {
  kind: 'deploy',
  source: 'deployments/payments',
  predicate: 'version == payments-v17 during the incident window',
};

const confirmationDeploymentEntry: ScenarioReplayEntry = {
  toolId: 'deployments',
  input: { service: 'payments', window: 'incident' },
  result: ok(
    evidence(
      'confirmation-deploy-v17',
      'deploy',
      'deployments/payments',
      'payments-v17 completed five minutes before the first alert',
    ),
  ),
};

export const REPLAY_SCENARIOS: readonly IncidentScenario[] = [
  {
    id: 'bad-deployment',
    groundTruth: {
      rootCause: {
        component: 'checkout',
        mechanism: 'invalid database endpoint introduced by deployment',
        trigger: 'checkout-v42',
      },
      expectedStopKind: 'sufficient',
      expectedConclusionKind: 'root-cause',
      expectedEvidence: [
        {
          kind: 'deploy',
          source: 'deployments/checkout',
          predicate: 'version == checkout-v42 during the incident window',
        },
        {
          kind: 'log',
          source: 'logs/checkout',
          predicate: 'contains database endpoint validation failures',
        },
      ],
    },
    fixture: replayFixture(
      {
        toolId: 'deployments',
        input: { service: 'checkout', window: 'incident' },
        result: ok(
          evidence(
            'checkout-deploy-v42',
            'deploy',
            'deployments/checkout',
            'checkout-v42 changed the database endpoint configuration',
          ),
        ),
      },
      {
        toolId: 'logs',
        input: { service: 'checkout', query: 'startup-errors' },
        result: ok(
          evidence(
            'checkout-invalid-database-endpoint',
            'log',
            'logs/checkout',
            'checkout rejected the database endpoint after checkout-v42',
          ),
        ),
      },
    ),
  },
  {
    id: 'db-pool-exhaustion',
    groundTruth: {
      rootCause: {
        component: 'checkout-db-pool',
        mechanism: 'all database connections remained occupied',
        trigger: 'traffic spike',
      },
      expectedStopKind: 'sufficient',
      expectedConclusionKind: 'root-cause',
      expectedEvidence: [
        {
          kind: 'metric',
          source: 'metrics/checkout-db-pool',
          predicate: 'active_connections == max_connections',
        },
        {
          kind: 'log',
          source: 'logs/checkout',
          predicate: 'contains connection acquisition timeouts',
        },
      ],
    },
    fixture: replayFixture(
      {
        toolId: 'metrics',
        input: { service: 'checkout', metric: 'db_pool_active' },
        result: ok(
          evidence(
            'checkout-db-pool-active',
            'metric',
            'metrics/checkout-db-pool',
            'active connections equalled the configured pool maximum',
          ),
        ),
      },
      {
        toolId: 'logs',
        input: { service: 'checkout', query: 'connection-timeout' },
        result: ok(
          evidence(
            'checkout-db-pool-timeout',
            'log',
            'logs/checkout',
            'requests timed out while acquiring a database connection',
          ),
        ),
      },
    ),
  },
  {
    id: 'false-alert',
    groundTruth: {
      expectedStopKind: 'sufficient',
      expectedConclusionKind: 'no-incident',
      expectedEvidence: [
        {
          kind: 'metric',
          source: 'metrics/checkout',
          predicate: 'error_rate remains below the incident threshold',
        },
        {
          kind: 'log',
          source: 'logs/checkout',
          predicate: 'contains no matching server errors',
        },
      ],
    },
    fixture: replayFixture(
      {
        toolId: 'metrics',
        input: { service: 'checkout', metric: 'error_rate' },
        result: ok(
          evidence(
            'checkout-normal-error-rate',
            'metric',
            'metrics/checkout',
            'the error rate remained below the incident threshold',
          ),
        ),
      },
      {
        toolId: 'logs',
        input: { service: 'checkout', query: 'server-errors' },
        result: ok(
          evidence(
            'checkout-no-server-errors',
            'log',
            'logs/checkout',
            'no matching server errors were recorded',
          ),
        ),
      },
    ),
  },
  {
    id: 'deployment-caused-incident-a',
    groundTruth: {
      rootCause: {
        component: 'payments',
        mechanism: 'request timeout regression introduced by deployment',
        trigger: 'payments-v17',
      },
      expectedStopKind: 'sufficient',
      expectedConclusionKind: 'root-cause',
      expectedEvidence: [confirmationDeploymentFingerprint],
    },
    fixture: replayFixture(
      confirmationDeploymentEntry,
      {
        toolId: 'dependencies',
        input: { service: 'payments', window: 'incident' },
        result: ok(
          evidence(
            'payments-dependencies-healthy',
            'dependency',
            'dependencies/payments',
            'payments dependencies stayed healthy during the incident window',
          ),
        ),
      },
    ),
  },
  {
    id: 'dependency-caused-incident-b',
    groundTruth: {
      rootCause: {
        component: 'inventory-api',
        mechanism: 'dependency connection pool saturation',
        trigger: 'traffic spike',
      },
      expectedStopKind: 'sufficient',
      expectedConclusionKind: 'root-cause',
      expectedEvidence: [
        {
          kind: 'dependency',
          source: 'dependencies/payments',
          predicate: 'inventory-api reports connection pool saturation',
        },
      ],
      misleadingEvidence: [confirmationDeploymentFingerprint],
    },
    fixture: replayFixture(
      confirmationDeploymentEntry,
      {
        toolId: 'dependencies',
        input: { service: 'payments', window: 'incident' },
        result: ok(
          evidence(
            'inventory-api-pool-saturation',
            'dependency',
            'dependencies/payments',
            'inventory-api reported connection pool saturation',
          ),
        ),
      },
    ),
  },
];

export function createBenchmarkInvocation(
  scenario: IncidentScenario,
): BenchmarkInvocation {
  const runId = randomUUID();
  return { scenario, runId, threadId: runId, humanReview: false };
}

import { createHash } from 'node:crypto';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
  type IncidentConclusion,
  type IncidentState,
  type InvestigationStop,
} from '@aic/domain';
import {
  createInvestigationGraph,
  type InvestigationNodes,
} from '@aic/graph';

import {
  BENCHMARK_SCENARIO_PARTITIONS,
  REPLAY_SCENARIOS,
  createBenchmarkInvocation,
  type EvidenceFingerprint,
  type IncidentScenario,
} from './replay-scenarios.js';

export const BENCHMARK_METRIC_KEYS = [
  'unsupported_claim_rate',
  'evidence_coverage',
  'termination_correctness',
] as const;

export type BenchmarkMetricKey = (typeof BENCHMARK_METRIC_KEYS)[number];

export interface BenchmarkVersions {
  readonly graphVersion: string;
  readonly promptVersion: string;
  readonly toolsetVersion: string;
  readonly statusRulesVersion: string;
  readonly toolMode: 'live' | 'replay';
  readonly knowledgeSetVersion: string;
  readonly memoryEnabled: boolean;
  readonly temperature: number;
  readonly seed?: number;
  readonly docsAvailable?: boolean;
}

export interface BenchmarkRunMetadata extends BenchmarkVersions {
  readonly runId: string;
  readonly scenarioId: string;
  readonly humanReview: false;
}

export interface BenchmarkRecord {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly scenario: IncidentScenario;
  readonly runId: string;
  readonly threadId: string;
  readonly metadata: BenchmarkRunMetadata;
}

export interface BenchmarkMetric<Key extends BenchmarkMetricKey> {
  readonly key: Key;
  readonly score: number;
}

export type BenchmarkMetrics = Readonly<{
  unsupported_claim_rate: BenchmarkMetric<'unsupported_claim_rate'>;
  evidence_coverage: BenchmarkMetric<'evidence_coverage'>;
  termination_correctness: BenchmarkMetric<'termination_correctness'>;
}>;

export interface BenchmarkOutcome {
  readonly claims: readonly Readonly<{ evidenceIds: readonly string[] }>[];
  readonly supportingEvidenceIds: readonly string[];
  readonly evidenceFingerprints: readonly EvidenceFingerprint[];
  readonly stopKind: InvestigationStop;
  readonly conclusionKind: IncidentConclusion['kind'];
}

export interface BenchmarkEvaluation {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly actualStopKind: InvestigationStop;
  readonly metrics: BenchmarkMetrics;
}

export interface BenchmarkExperiment {
  readonly records: readonly BenchmarkRecord[];
  readonly results: readonly BenchmarkEvaluation[];
  readonly stopKindDistribution: Partial<Record<InvestigationStop, number>>;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
}

function stableExampleId(scenarioId: string, runNumber: number): string {
  const bytes = createHash('sha256')
    .update(`aic-v0.1:${scenarioId}:${runNumber}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

interface BenchmarkPlanOptions {
  readonly experimentId: string;
  readonly runsPerScenario: number;
  readonly metadata: BenchmarkVersions;
}

interface BenchmarkPlanWithScenarios extends BenchmarkPlanOptions {
  readonly scenarios: readonly IncidentScenario[];
}

function buildBenchmarkPlan({
  experimentId,
  scenarios,
  runsPerScenario,
  metadata,
}: BenchmarkPlanWithScenarios): BenchmarkRecord[] {
  requireNonEmpty(experimentId, 'experimentId');
  if (!Number.isSafeInteger(runsPerScenario) || runsPerScenario < 3) {
    throw new Error('the v0.1 benchmark requires at least three runs per scenario');
  }

  return scenarios.flatMap((scenario) =>
    Array.from({ length: runsPerScenario }, (_, index) => {
      const invocation = createBenchmarkInvocation(scenario);
      return {
        experimentId,
        exampleId: stableExampleId(scenario.id, index + 1),
        scenario,
        runId: invocation.runId,
        threadId: invocation.threadId,
        metadata: {
          ...metadata,
          runId: invocation.runId,
          scenarioId: scenario.id,
          humanReview: false,
        },
      };
    }),
  );
}

export function createBenchmarkPlan(
  options: BenchmarkPlanWithScenarios,
): BenchmarkRecord[] {
  if (options.scenarios.length !== 5) {
    throw new Error('the v0.1 benchmark requires exactly five scenarios');
  }
  return buildBenchmarkPlan(options);
}

function scenariosForPartition(
  scenarioIds: readonly string[],
): IncidentScenario[] {
  const scenariosById = new Map(
    REPLAY_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );
  return scenarioIds.map((scenarioId) => {
    const scenario = scenariosById.get(scenarioId);
    if (scenario === undefined) {
      throw new Error(`benchmark partition names unknown scenario: ${scenarioId}`);
    }
    return scenario;
  });
}

export function createCalibrationBenchmarkPlan(
  options: BenchmarkPlanOptions,
): BenchmarkRecord[] {
  return buildBenchmarkPlan({
    ...options,
    scenarios: scenariosForPartition(
      BENCHMARK_SCENARIO_PARTITIONS.calibration,
    ),
  });
}

export function createFinalEvaluationBenchmarkPlan(
  options: BenchmarkPlanOptions,
): BenchmarkRecord[] {
  return buildBenchmarkPlan({
    ...options,
    scenarios: scenariosForPartition([
      ...BENCHMARK_SCENARIO_PARTITIONS.calibration,
      ...BENCHMARK_SCENARIO_PARTITIONS.holdout,
    ]),
  });
}

export function evaluateUnsupportedClaimRate({
  claims,
  supportingEvidenceIds,
}: Readonly<{
  claims: readonly Readonly<{ evidenceIds: readonly string[] }>[];
  supportingEvidenceIds: readonly string[];
}>): BenchmarkMetric<'unsupported_claim_rate'> {
  const supporting = new Set(supportingEvidenceIds);
  const unsupported = claims.filter(
    ({ evidenceIds }) =>
      evidenceIds.length === 0 ||
      !evidenceIds.some((evidenceId) => supporting.has(evidenceId)),
  ).length;

  return {
    key: 'unsupported_claim_rate',
    score: claims.length === 0 ? 0 : unsupported / claims.length,
  };
}

function fingerprintKey({
  kind,
  source,
  predicate,
}: EvidenceFingerprint): string {
  return JSON.stringify([kind, source, predicate]);
}

export function evaluateEvidenceCoverage({
  expectedFingerprints,
  evidenceFingerprints,
}: Readonly<{
  expectedFingerprints: readonly EvidenceFingerprint[];
  evidenceFingerprints: readonly EvidenceFingerprint[];
}>): BenchmarkMetric<'evidence_coverage'> {
  const observed = new Set(evidenceFingerprints.map(fingerprintKey));
  const covered = expectedFingerprints.filter((fingerprint) =>
    observed.has(fingerprintKey(fingerprint)),
  ).length;

  return {
    key: 'evidence_coverage',
    score:
      expectedFingerprints.length === 0
        ? 1
        : covered / expectedFingerprints.length,
  };
}

export function evaluateTerminationCorrectness({
  expectedStopKind,
  expectedConclusionKind,
  stopKind,
  conclusionKind,
}: Readonly<{
  expectedStopKind: InvestigationStop;
  expectedConclusionKind: IncidentConclusion['kind'];
  stopKind: InvestigationStop;
  conclusionKind: IncidentConclusion['kind'];
}>): BenchmarkMetric<'termination_correctness'> {
  return {
    key: 'termination_correctness',
    score:
      stopKind === expectedStopKind &&
      conclusionKind === expectedConclusionKind
        ? 1
        : 0,
  };
}

export function evaluateBenchmarkRecord({
  record,
  outcome,
}: Readonly<{
  record: BenchmarkRecord;
  outcome: BenchmarkOutcome;
}>): BenchmarkEvaluation {
  const unsupportedClaimRate = evaluateUnsupportedClaimRate(outcome);
  const evidenceCoverage = evaluateEvidenceCoverage({
    expectedFingerprints: record.scenario.groundTruth.expectedEvidence,
    evidenceFingerprints: outcome.evidenceFingerprints,
  });
  const terminationCorrectness = evaluateTerminationCorrectness({
    expectedStopKind: record.scenario.groundTruth.expectedStopKind,
    expectedConclusionKind:
      record.scenario.groundTruth.expectedConclusionKind,
    stopKind: outcome.stopKind,
    conclusionKind: outcome.conclusionKind,
  });

  return {
    experimentId: record.experimentId,
    exampleId: record.exampleId,
    runId: record.runId,
    actualStopKind: outcome.stopKind,
    metrics: {
      [unsupportedClaimRate.key]: unsupportedClaimRate,
      [evidenceCoverage.key]: evidenceCoverage,
      [terminationCorrectness.key]: terminationCorrectness,
    },
  };
}

export async function runBenchmarkExperiment({
  experimentId,
  scenarios,
  runsPerScenario,
  metadata,
  investigate,
  recordEvaluation,
}: Readonly<{
  experimentId: string;
  scenarios: readonly IncidentScenario[];
  runsPerScenario: number;
  metadata: BenchmarkVersions;
  investigate(record: BenchmarkRecord): Promise<BenchmarkOutcome>;
  recordEvaluation(payload: Readonly<{
    record: BenchmarkRecord;
    result: BenchmarkEvaluation;
  }>): Promise<void>;
}>): Promise<BenchmarkExperiment> {
  const records = createBenchmarkPlan({
    experimentId,
    scenarios,
    runsPerScenario,
    metadata,
  });
  const results: BenchmarkEvaluation[] = [];

  for (const record of records) {
    const result = evaluateBenchmarkRecord({
      record,
      outcome: await investigate(record),
    });
    await recordEvaluation({ record, result });
    results.push(result);
  }

  return {
    records,
    results,
    stopKindDistribution: summarizeStopKindDistribution(results),
  };
}

function initialBenchmarkState(record: BenchmarkRecord): IncidentState {
  if (record.metadata.statusRulesVersion !== STATUS_RULES_VERSION) {
    throw new Error('benchmark status-rules version does not match the graph');
  }

  return {
    incident: { id: record.scenario.id },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: record.runId,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      humanReview: false,
    },
  };
}

function outcomeFromGraphState(state: IncidentState): BenchmarkOutcome {
  if (state.control.stopKind === undefined || state.conclusion === undefined) {
    throw new Error('benchmark graph must produce a stop kind and conclusion');
  }

  const observedEvidenceIds = new Set(state.evidence.map(({ id }) => id));
  return {
    claims: state.conclusion.causes.map(({ evidenceIds }) => ({ evidenceIds })),
    supportingEvidenceIds: state.conclusion.causes.flatMap(({ evidenceIds }) =>
      evidenceIds.filter((evidenceId) => observedEvidenceIds.has(evidenceId)),
    ),
    evidenceFingerprints: state.evidence.map(({ kind, source, statement }) => ({
      kind,
      source,
      predicate: statement,
    })),
    stopKind: state.control.stopKind,
    conclusionKind: state.conclusion.kind,
  };
}

export async function runGraphBenchmarkExperiment({
  experimentId,
  scenarios,
  runsPerScenario,
  metadata,
  createNodes,
  recordEvaluation,
}: Readonly<{
  experimentId: string;
  scenarios: readonly IncidentScenario[];
  runsPerScenario: number;
  metadata: BenchmarkVersions;
  createNodes(record: BenchmarkRecord): InvestigationNodes;
  recordEvaluation(payload: Readonly<{
    record: BenchmarkRecord;
    result: BenchmarkEvaluation;
  }>): Promise<void>;
}>): Promise<BenchmarkExperiment> {
  return runBenchmarkExperiment({
    experimentId,
    scenarios,
    runsPerScenario,
    metadata,
    async investigate(record) {
      const graph = createInvestigationGraph({ nodes: createNodes(record) });
      const finalState = await graph.execute({
        kind: 'start',
        state: initialBenchmarkState(record),
      });
      return outcomeFromGraphState(finalState);
    },
    recordEvaluation,
  });
}

export function summarizeStopKindDistribution(
  results: readonly BenchmarkEvaluation[],
): Partial<Record<InvestigationStop, number>> {
  const distribution: Partial<Record<InvestigationStop, number>> = {};
  for (const { actualStopKind } of results) {
    distribution[actualStopKind] =
      (distribution[actualStopKind] ?? 0) + 1;
  }
  return distribution;
}

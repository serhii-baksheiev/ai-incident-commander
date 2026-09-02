import { createHash } from 'node:crypto';

import {
  deriveHypothesisStatus,
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
  type HypothesisStatus,
  type IncidentConclusion,
  type IncidentState,
  type InvestigationStop,
} from '@aic/domain';
import {
  createInvestigationGraph,
  type InvestigationNodes,
} from '@aic/graph';

import {
  evaluateChallengeEffect,
  evaluateFalseAlertOutcome,
  evaluateMisleadingEvidenceHandling,
  type BehaviorMetric,
  type ChallengeEffectObservation,
  type EvidenceAssessmentObservation,
  type RootCause,
} from './behavior-evaluators.js';
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
  readonly evaluatorVersion: string;
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

export interface BenchmarkExecutionInput {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly scenarioId: string;
  readonly fixture: IncidentScenario['fixture'];
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
  readonly rootCause?: RootCause;
  readonly rootCauseHypothesisId?: string;
  readonly evidenceAssessments?: readonly EvidenceAssessmentObservation[];
  readonly challengeEffect?: ChallengeEffectObservation;
}

export type BehaviorMetrics = Partial<{
  misleading_evidence_handling: BehaviorMetric<'misleading_evidence_handling'>;
  false_alert_correctness: BehaviorMetric<'false_alert_correctness'>;
  challenge_effect: BehaviorMetric<'challenge_effect'>;
}>;

export interface BenchmarkEvaluation {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly actualStopKind: InvestigationStop;
  readonly metrics: BenchmarkMetrics;
  readonly behaviorMetrics: BehaviorMetrics;
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

export type BenchmarkScenarioSet =
  | 'ad-hoc'
  | 'calibration'
  | 'final-evaluation';

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

type BenchmarkScenarioSelection =
  | Readonly<{
      scenarioSet: 'ad-hoc';
      scenarios: readonly IncidentScenario[];
    }>
  | Readonly<{
      scenarioSet: 'calibration' | 'final-evaluation';
      scenarios?: never;
    }>;

function createExecutionBenchmarkPlan(
  options: BenchmarkPlanOptions & BenchmarkScenarioSelection,
): BenchmarkRecord[] {
  if (
    options.scenarioSet !== 'ad-hoc' &&
    options.scenarioSet !== 'calibration' &&
    options.scenarioSet !== 'final-evaluation'
  ) {
    throw new Error(
      'benchmark execution requires an explicit ad-hoc, calibration, or final-evaluation scenarioSet',
    );
  }
  if (options.scenarioSet === 'ad-hoc') {
    return createBenchmarkPlan(options);
  }
  if (Object.hasOwn(options, 'scenarios')) {
    throw new Error(
      `${options.scenarioSet} benchmark derives its scenarios from the declared partition and rejects caller-supplied scenarios that could bypass the hold-out policy`,
    );
  }
  return options.scenarioSet === 'calibration'
    ? createCalibrationBenchmarkPlan(options)
    : createFinalEvaluationBenchmarkPlan(options);
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
  const behaviorMetrics: BehaviorMetrics = {};
  const { groundTruth } = record.scenario;

  if (
    groundTruth.rootCause !== undefined &&
    groundTruth.misleadingEvidence !== undefined
  ) {
    const result = evaluateMisleadingEvidenceHandling({
      evaluatorVersion: record.metadata.evaluatorVersion,
      groundTruth: {
        rootCause: groundTruth.rootCause,
        expectedEvidence: groundTruth.expectedEvidence,
        misleadingEvidence: groundTruth.misleadingEvidence,
      },
      outcome: {
        ...outcome,
        evidenceAssessments: outcome.evidenceAssessments ?? [],
      },
    });
    behaviorMetrics[result.key] = result;
  }
  if (groundTruth.expectedConclusionKind === 'no-incident') {
    const result = evaluateFalseAlertOutcome({
      evaluatorVersion: record.metadata.evaluatorVersion,
      groundTruth,
      outcome,
    });
    behaviorMetrics[result.key] = result;
  }
  if (groundTruth.expectedLeaderChangeAfterChallenge !== undefined) {
    const result = evaluateChallengeEffect({
      evaluatorVersion: record.metadata.evaluatorVersion,
      groundTruth: {
        expectedLeaderChangeAfterChallenge:
          groundTruth.expectedLeaderChangeAfterChallenge,
      },
      outcome: outcome.challengeEffect ?? {
        challengeNodeExecuted: false,
        challengeInvocationCount: 0,
        executedDiscriminatingTrialCount: 0,
      },
    });
    behaviorMetrics[result.key] = result;
  }

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
    behaviorMetrics,
  };
}

type BenchmarkExperimentOptions = BenchmarkPlanOptions &
  BenchmarkScenarioSelection &
  Readonly<{
    investigate(input: BenchmarkExecutionInput): Promise<BenchmarkOutcome>;
    recordEvaluation(payload: Readonly<{
      record: BenchmarkRecord;
      result: BenchmarkEvaluation;
    }>): Promise<void>;
  }>;

export async function runBenchmarkExperiment(
  options: BenchmarkExperimentOptions,
): Promise<BenchmarkExperiment> {
  const records = createExecutionBenchmarkPlan(options);
  const results: BenchmarkEvaluation[] = [];

  for (const record of records) {
    const executionInput: BenchmarkExecutionInput = {
      experimentId: record.experimentId,
      exampleId: record.exampleId,
      scenarioId: record.scenario.id,
      fixture: record.scenario.fixture,
      runId: record.runId,
      threadId: record.threadId,
      metadata: record.metadata,
    };
    const result = evaluateBenchmarkRecord({
      record,
      outcome: await options.investigate(executionInput),
    });
    await options.recordEvaluation({ record, result });
    results.push(result);
  }

  return {
    records,
    results,
    stopKindDistribution: summarizeStopKindDistribution(results),
  };
}

function initialBenchmarkState(input: BenchmarkExecutionInput): IncidentState {
  if (input.metadata.statusRulesVersion !== STATUS_RULES_VERSION) {
    throw new Error('benchmark status-rules version does not match the graph');
  }

  return {
    incident: { id: input.scenarioId },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId: input.runId,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      humanReview: false,
    },
  };
}

function outcomeFromGraphState(
  state: IncidentState,
  challengeEffect?: ChallengeEffectObservation,
): BenchmarkOutcome {
  if (state.control.stopKind === undefined || state.conclusion === undefined) {
    throw new Error('benchmark graph must produce a stop kind and conclusion');
  }

  const observedEvidenceIds = new Set(state.evidence.map(({ id }) => id));
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
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
    rootCause: state.conclusion.causes[0]?.cause,
    rootCauseHypothesisId: state.conclusion.causes[0]?.hypothesisId,
    evidenceAssessments: state.assessments.flatMap((assessment) => {
      const evidence = evidenceById.get(assessment.evidenceId);
      return evidence === undefined
        ? []
        : [{
            fingerprint: {
              kind: evidence.kind,
              source: evidence.source,
              predicate: evidence.statement,
            },
            hypothesisId: assessment.hypothesisId,
            effect: assessment.effect,
          }];
    }),
    challengeEffect,
  };
}

function hypothesisStatus(
  state: IncidentState,
  hypothesisId: string | undefined,
): HypothesisStatus | undefined {
  if (
    hypothesisId === undefined ||
    !state.hypotheses.some(({ id }) => id === hypothesisId)
  ) {
    return undefined;
  }
  return deriveHypothesisStatus({
    hypothesisId,
    predictions: state.predictions,
    assessments: state.assessments,
    evidence: state.evidence,
  });
}

type GraphBenchmarkExperimentOptions = BenchmarkPlanOptions &
  BenchmarkScenarioSelection &
  Readonly<{
    createNodes(input: BenchmarkExecutionInput): InvestigationNodes;
    recordEvaluation(payload: Readonly<{
      record: BenchmarkRecord;
      result: BenchmarkEvaluation;
    }>): Promise<void>;
  }>;

export async function runGraphBenchmarkExperiment(
  options: GraphBenchmarkExperimentOptions,
): Promise<BenchmarkExperiment> {
  return runBenchmarkExperiment({
    ...options,
    async investigate(input) {
      const nodes = options.createNodes(input);
      let challengeInvocationCount = 0;
      let leaderBeforeChallengeId: string | undefined;
      let leaderAfterChallengeId: string | undefined;
      let leaderStatusBeforeChallenge: HypothesisStatus | undefined;
      let leaderStatusAfterChallenge: HypothesisStatus | undefined;
      const discriminatingTestIds = new Set<string>();
      const graph = createInvestigationGraph({
        nodes: {
          ...nodes,
          async termination_check(state) {
            const decision = await nodes.termination_check(state);
            const isPreChallengeDecision =
              decision.route === 'challenge-required' ||
              (decision.route === 'terminal' &&
                decision.stopKind === 'sufficient' &&
                state.control.challengeRounds === 0);
            if (isPreChallengeDecision && leaderBeforeChallengeId === undefined) {
              leaderBeforeChallengeId = decision.leaderId;
              leaderStatusBeforeChallenge = hypothesisStatus(
                state,
                decision.leaderId,
              );
            }
            if (
              decision.route === 'terminal' &&
              decision.stopKind === 'sufficient' &&
              state.control.challengeRounds > 0
            ) {
              leaderAfterChallengeId = decision.leaderId;
              leaderStatusAfterChallenge = hypothesisStatus(
                state,
                decision.leaderId,
              );
            }
            return decision;
          },
          async challenge_hypothesis(state, leaderId) {
            challengeInvocationCount += 1;
            const result = await nodes.challenge_hypothesis(state, leaderId);
            for (const test of result.discriminatingTests) {
              discriminatingTestIds.add(test.id);
            }
            return result;
          },
        },
      });
      const finalState = await graph.execute({
        kind: 'start',
        state: initialBenchmarkState(input),
      });
      return outcomeFromGraphState(finalState, {
        challengeNodeExecuted: challengeInvocationCount > 0,
        challengeInvocationCount,
        leaderBeforeChallengeId,
        leaderAfterChallengeId,
        leaderStatusBeforeChallenge,
        leaderStatusAfterChallenge,
        executedDiscriminatingTrialCount: finalState.trials.filter(({ testId }) =>
          discriminatingTestIds.has(testId),
        ).length,
      });
    },
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

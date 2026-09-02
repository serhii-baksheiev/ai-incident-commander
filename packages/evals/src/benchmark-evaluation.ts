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

/**
 * The version of the resource-evidence shape below. Separate from the state
 * schema version on purpose: this one describes what a BENCHMARK publishes,
 * which moves for different reasons than what the graph persists.
 */
export const BENCHMARK_RESOURCE_SCHEMA_VERSION = 1 as const;

/**
 * What a run SPENT, one axis per field and nothing derived.
 *
 * There is deliberately no composite and no "recovery overhead" figure: a
 * single number that blends logical investigation work with recovery work can
 * fall while quality falls with it, which is the comparison this evidence
 * exists to make impossible to fake.
 *
 * `retryCount` is DERIVED from the executed state — the trials past their first
 * attempt — rather than asserted. It reads zero today because nothing in this
 * repository retries, but it is a measurement, so the day a retry path lands it
 * reports without anyone remembering to change it. A literal zero would have
 * gone on reading zero, which is the "spent nothing on that axis" claim this
 * evidence must never manufacture.
 * see benchmark-resource-evidence.test.mjs › "counts the trials past their first
 * attempt rather than publishing a constant retry count"
 *
 * ⚠ `resumeCount` reads zero in every benchmark run for a structural reason,
 * not a measured one: the benchmark sets `humanReview: false`, so the node that
 * counts resumes is unreachable there. The axis is real on an interactive run.
 * see benchmark-resource-evidence.test.mjs › "pins resumeCount at zero for every
 * benchmark run, because the benchmark never enables human review"
 */
export interface BenchmarkResourceEvidence {
  readonly schemaVersion: number;
  readonly logicalIterationsUsed: number;
  readonly declaredLlmCallsUsed: number;
  readonly toolCallsUsed: number;
  readonly wallClockDurationMs: number;
  readonly retryCount: number;
  readonly resumeCount: number;
}

/**
 * What a caller that actually EXECUTED the graph can attest to. The runner
 * supplies `schemaVersion` and times `wallClockDurationMs` itself, so neither
 * can be reported by whoever ran the investigation.
 */
export type MeasuredBenchmarkResources = Omit<
  BenchmarkResourceEvidence,
  'schemaVersion' | 'wallClockDurationMs'
>;

export interface BenchmarkEvaluation {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly actualStopKind: InvestigationStop;
  readonly metrics: BenchmarkMetrics;
  readonly behaviorMetrics: BehaviorMetrics;
  // Absent unless a caller MEASURED the run. An opaque `investigate` callback
  // cannot put anything here — see `runBenchmarkExperiment`.
  readonly resources?: BenchmarkResourceEvidence;
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
  resources,
}: Readonly<{
  record: BenchmarkRecord;
  outcome: BenchmarkOutcome;
  resources?: BenchmarkResourceEvidence;
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
    // Omitted entirely when nothing measured this run — which is what every
    // v0.1 record looks like, and what the generic path must keep looking like.
    ...(resources === undefined ? {} : { resources }),
  };
}

type BenchmarkExperimentOptions = BenchmarkPlanOptions &
  BenchmarkScenarioSelection &
  Readonly<{
    investigate(input: BenchmarkExecutionInput): Promise<BenchmarkOutcome>;
    /**
     * The ONE way resource evidence enters an evaluation, and it is separate
     * from `investigate` on purpose: `investigate` is an opaque callback, so
     * anything it returns about its own spend is self-reported. Only a caller
     * that executed and observed the graph implements this.
     */
    collectResources?(
      input: BenchmarkExecutionInput,
    ): MeasuredBenchmarkResources | undefined;
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
    // Timed by the runner, never by the investigation: a callback reporting its
    // own duration is reporting a number nobody checked.
    const startedAt = Date.now();
    const outcome = await options.investigate(executionInput);
    const wallClockDurationMs = Date.now() - startedAt;
    const measured = options.collectResources?.(executionInput);
    const result = evaluateBenchmarkRecord({
      record,
      // `outcome.resources`, if the callback invented one, is not read here and
      // is not forwarded — see the `collectResources` note above.
      outcome,
      resources:
        measured === undefined
          ? undefined
          : {
              schemaVersion: BENCHMARK_RESOURCE_SCHEMA_VERSION,
              ...measured,
              wallClockDurationMs,
            },
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
      resumeCount: 0,
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
  // Keyed by runId rather than returned through `investigate`, so the evidence
  // travels a path the opaque callback contract cannot reach.
  const measuredByRunId = new Map<string, MeasuredBenchmarkResources>();

  return runBenchmarkExperiment({
    ...options,
    collectResources: (input) => measuredByRunId.get(input.runId),
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
      measuredByRunId.set(input.runId, {
        // These two, and `resumeCount` below, are read off the executed control
        // block: the graph owns it and a node's update cannot write it, so they
        // are observations rather than self-reports.
        logicalIterationsUsed: finalState.control.iterationsUsed,
        declaredLlmCallsUsed: finalState.control.llmCallsUsed,
        // ⚠ NOT covered by the sentence above, and the difference is the whole
        // point of it. `trials` is a node-written channel — `execute_investigation`
        // puts them there and the reducer upserts them unparsed — and in a
        // benchmark that node IS the system under test. So this axis is as
        // trustworthy as the fixture that produced it, which is exactly the
        // provenance the generic path refuses to publish at all. It is measured
        // here because the item asks for "tool calls/trials used" and this graph
        // has no independent tool-call channel to read instead.
        toolCallsUsed: finalState.trials.length,
        // Derived from the executed state, not asserted: a literal zero would
        // keep reading zero on the day a retry path lands, which is the
        // "spent nothing on that axis" reading this evidence must never
        // manufacture. It is zero today because nothing retries.
        retryCount: finalState.trials.filter(({ attempt }) => attempt > 1).length,
        resumeCount: finalState.control.resumeCount,
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

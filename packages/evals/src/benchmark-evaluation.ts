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
import {
  BENCHMARK_BUDGET_POLICY,
  parseBenchmarkBudgetPolicy,
  type BenchmarkBudgetPolicy,
} from './budget-policy.js';

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
  /**
   * Which model produced the run, and whose.
   *
   * Optional because the deterministic path has no model: a scripted or replay
   * run declares neither, and a run that declared `modelId: 'none'` would be
   * asserting a model identity nobody chose. Absent means "no model executed a
   * role here", which is the honest reading for every v0.1 record and for the
   * scripted control arm of the live lane.
   *
   * `modelProvider` is separate from `modelId` rather than folded into it: two
   * providers can serve the same model name, and a comparison across them is
   * exactly what a reference-model evaluation must not make by accident.
   * see model-run-identity-correspondence.test.mjs › "carries every declared
   * run-metadata field in one of the two metadata allowlists"
   */
  readonly modelId?: string;
  readonly modelProvider?: string;
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
export const BENCHMARK_RESOURCE_SCHEMA_VERSION = 2 as const;

/**
 * What a run SPENT, one axis per field and no axis computed FROM ANOTHER AXIS.
 *
 * "Nothing derived" means exactly that and no more: an axis may perfectly well
 * be derived from executed state — `retryCount` below is — but no axis may be a
 * function of other axes, because that is the composite this evidence exists to
 * refuse.
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
  /**
   * What the model actually consumed, as the provider reported it.
   *
   * OPTIONAL, and that is the whole design of these two axes. Every other axis
   * here is measurable on any run; these two exist only where a model ran, and a
   * scripted run that published `inputTokensUsed: 0` would be claiming a
   * measured zero rather than an absent measurement — the reading this evidence
   * exists to refuse everywhere else in this file. Absent means "no model
   * executed a role", which is what the deterministic path is.
   *
   * 🔴 NOTHING PRODUCES THEM YET. They are declared and validated — a present
   * value must be a count, and an absent one stays absent — but no code path
   * assigns either. `MeasuredBenchmarkResources` is an `Omit` of this type — it
   * leaves seven properties, the five REQUIRED axes and these two optional ones
   * — and its only producer sets the five required axes —
   * `logicalIterationsUsed`, `declaredLlmCallsUsed`, `toolCallsUsed`,
   * `retryCount`, `resumeCount` — and neither of these. `wallClockDurationMs`
   * is the runner's, not the producer's. So a fully credentialed live run
   * publishes no token count on any record.
   * ⚠ That is a statement about the tree as it stands, re-measured at the
   * AIC-94 gate after an earlier version of this paragraph said "six". It is
   * not pinned by a row, and a producer added tomorrow will silently falsify
   * it — read it as an observation with a date on it, not as a guarantee. Do not read the declaration as a
   * measurement: that conflation is the exact failure this item exists to
   * prevent, and an earlier version of this comment described a data flow from
   * the usage ledger that does not exist. `code-reviewer` and `prose-reviewer`
   * both measured it at the AIC-94 gate. Wiring it needs PER-RUN accounting the
   * ledger does not offer — `read()` returns lane-cumulative totals — which is
   * why it is a separate item rather than a line here.
   *
   * Where token evidence DOES exist today is the lane report's
   * `arms.model.usage`, which is lane-cumulative and is what acceptance row 5
   * is satisfied by.
   *
   * They are kept separate from `declaredLlmCallsUsed` because those count
   * different things and neither can be derived from the other:
   * `declaredLlmCallsUsed` counts only what a WRAPPED lifecycle node declared,
   * and `challenge_hypothesis` has no declaration channel at all.
   * see roles-model-nodes.test.mjs › "records the challenge role usage in the
   * ledger while the graph counter cannot see it"
   */
  readonly inputTokensUsed?: number;
  readonly outputTokensUsed?: number;
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
  /**
   * Behavior metrics are recorded with CreateDataProperty semantics, never with
   * `behaviorMetrics[result.key] = result`.
   *
   * That assignment is an ordinary `[[Set]]`: it walks the prototype chain, and
   * an inherited accessor named like a metric swallows it — no own property is
   * created, and the metric is gone one layer ABOVE the hardened persistence
   * projection, before that projection is ever reached. The failure is silent
   * in the worst way: the object stays `{}` rather than becoming `undefined`,
   * so the persistence layer's paired-declaration guard does not fire either,
   * and the record publishes a declared `evaluatorVersion` with zero behavior
   * metrics — an investigation that reads as never having been measured.
   */
  const recordBehaviorMetric = (
    metric: NonNullable<BehaviorMetrics[keyof BehaviorMetrics]>,
  ): void => {
    Object.defineProperty(behaviorMetrics, metric.key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: metric,
    });
  };
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
    recordBehaviorMetric(result);
  }
  if (groundTruth.expectedConclusionKind === 'no-incident') {
    const result = evaluateFalseAlertOutcome({
      evaluatorVersion: record.metadata.evaluatorVersion,
      groundTruth,
      outcome,
    });
    recordBehaviorMetric(result);
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
    recordBehaviorMetric(result);
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
    //
    // `performance.now()` rather than `Date.now()` because the outbound boundary
    // refuses a negative count: a backwards clock step mid-run would otherwise
    // turn a clock anomaly into a failed persist that loses every later record
    // of a finished experiment. A monotonic clock makes the delta non-negative
    // by construction, so the strict check can never fire on an honest run.
    const startedAt = performance.now();
    const outcome = await options.investigate(executionInput);
    const wallClockDurationMs = Math.round(performance.now() - startedAt);
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

function initialBenchmarkState(
  input: BenchmarkExecutionInput,
  budgetPolicy: BenchmarkBudgetPolicy,
): IncidentState {
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
      // From the policy the experiment declared, not from three literals here:
      // a budget nobody can vary is a budget nobody can measure, which is how
      // these three came to be unexamined in the first place (AIC-18).
      maxIterations: budgetPolicy.maxIterations,
      llmCallBudget: budgetPolicy.llmCallBudget,
      reservedChallengeBudget: budgetPolicy.reservedChallengeBudget,
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
    /**
     * What this experiment allows a run to spend. Omitted — or supplied as an
     * own `undefined`, which is the same thing while this project does not set
     * `exactOptionalPropertyTypes` — it is the shipped `BENCHMARK_BUDGET_POLICY`.
     * An own ACCESSOR is refused outright, before any parse and whatever it
     * would have computed: a policy a getter produces is not one this caller
     * wrote down, and the version it keys published rows by would name a run
     * nobody declared. Any other value is parsed and refused if it cannot be
     * read; `null` in particular is a refusal, not a default.
     *
     * Four states, and the block at the read site says why each is what it is.
     *
     * ⚠ Only the GRAPH runner takes this. `runBenchmarkExperiment` drives an
     * opaque `investigate` callback and starts no graph, so a policy handed to
     * it would reach no control block and could not be observed — an option
     * that silently does nothing is worse than one that does not exist.
     */
    budgetPolicy?: BenchmarkBudgetPolicy;
    createNodes(input: BenchmarkExecutionInput): InvestigationNodes;
    recordEvaluation(payload: Readonly<{
      record: BenchmarkRecord;
      result: BenchmarkEvaluation;
    }>): Promise<void>;
  }>;

export async function runGraphBenchmarkExperiment(
  options: GraphBenchmarkExperimentOptions,
): Promise<BenchmarkExperiment> {
  // Parsed BEFORE anything runs: a malformed policy must not be discovered
  // halfway through a corpus, with some runs already recorded under a version
  // the experiment never executed.
  // The refusal rows are generated from a table, so grep the MALFORMED_POLICIES
  // labels in budget-policy.test.mjs rather than a whole test name.
  //
  // `Object.hasOwn` rather than `??`: an ABSENT option is the fail-open case and
  // takes the shipped policy, while an option PRESENT in a shape this runner
  // cannot read is the refusal case. `?? BENCHMARK_BUDGET_POLICY` cannot tell
  // those apart, so an explicit `null` ran the whole corpus under a policy the
  // caller never asked for -- measured, and it is why these two states are now
  // separated.
  // see the MALFORMED_POLICIES label "an explicitly null policy" in budget-policy.test.mjs
  // ⚠ Four states, not two, and each of the last three cost a review round.
  //
  //   ABSENT (omitted, or inherited)  -> the shipped policy. Nothing was asked
  //                                      for, so there is nothing to refuse.
  //   own `undefined`                 -> also absent. Without
  //                                      `exactOptionalPropertyTypes` this is
  //                                      TypeScript's own spelling of an
  //                                      omitted optional property, so refusing
  //                                      it makes the declared type lie — and
  //                                      the suite's own helper had to spread
  //                                      around the refusal, which is the trap
  //                                      showing itself.
  //   own ACCESSOR                    -> REFUSED. A getter is present in a shape
  //                                      this reader does not accept, and
  //                                      `.claude/rules/invariants.md` calls that
  //                                      the refusal case. It was silently
  //                                      treated as absent until a review round
  //                                      measured it: the seam never asked the
  //                                      getter, and the corpus ran under the
  //                                      shipped policy while the caller
  //                                      believed it had supplied one.
  //   own `null`, or any other value  -> PARSED, and refused if unreadable. A
  //                                      caller that computed a policy and got
  //                                      `null` asked for something; running the
  //                                      corpus under the shipped policy while
  //                                      it believes otherwise is the fail-open
  //                                      this seam already had once.
  //
  // Own-read for the same reason the policy's own fields are own-read.
  // see the MALFORMED_POLICIES label "an explicitly null policy" in budget-policy.test.mjs
  // see budget-policy.test.mjs › "starts from the shipped policy when budgetPolicy is present but undefined"
  // see budget-policy.test.mjs › "starts from the shipped policy when budgetPolicy is only inherited"
  // see budget-policy.test.mjs › "refuses a budgetPolicy option that is an own accessor"
  const declaredPolicy = Object.getOwnPropertyDescriptor(options, 'budgetPolicy');
  if (declaredPolicy !== undefined && !Object.hasOwn(declaredPolicy, 'value')) {
    throw new Error(
      'budget policy option must be a value this caller wrote down, not an accessor: a policy a getter computes is not a policy the experiment can publish a version for',
    );
  }
  const budgetPolicy =
    declaredPolicy === undefined || declaredPolicy.value === undefined
      ? BENCHMARK_BUDGET_POLICY
      : parseBenchmarkBudgetPolicy(declaredPolicy.value);

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
        state: initialBenchmarkState(input, budgetPolicy),
      });
      measuredByRunId.set(input.runId, {
        // The line that matters is WHO ORIGINATED THE NUMBER, not which channel
        // the graph owns — the graph owns the control block either way.
        //
        // Originated by the graph, and therefore an observation: this one and
        // `resumeCount` below. The graph increments both itself and a node's
        // update cannot write either.
        logicalIterationsUsed: finalState.control.iterationsUsed,
        // ⚠ Originated by the NODE. The graph owns the accumulation and
        // validates each addition, but the number added is whatever the node
        // declared — `declaredLlmCalls` is a declaration, not a write. In a
        // benchmark the node is the system under test, so this axis is as
        // trustworthy as the fixture, exactly like `toolCallsUsed` below. It is
        // recorded because a declared count is the only honest thing to record
        // while no provider exists to observe instead.
        declaredLlmCallsUsed: finalState.control.llmCallsUsed,
        // ⚠ Also node-originated, and more directly: `trials` is a node-written
        // channel — `execute_investigation` puts them there and the reducer
        // upserts them unparsed. Measured here because the item asks for "tool
        // calls/trials used" and this graph has no independent tool-call channel
        // to read instead.
        //
        // What this counts is trials, so its meaning depends on the producer's
        // trial-id convention: a trial retried under one id upserts in place and
        // counts once, while a fresh id per attempt counts each. Stated because
        // the number this axis reports once a retry path lands is decided by
        // that convention, not by this code.
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
        // Counted only when the trial SUCCEEDED. `Trial.status` is
        // 'ok' | 'unavailable' | 'error', and only `ok` produced evidence the
        // investigation could act on — a tool that was unavailable, or errored,
        // discriminated nothing. The evaluator reads a non-zero count as "the
        // challenge changed the investigation" on its own axis
        // (`evaluateChallengeEffect`, behavior-evaluators.ts), so counting a
        // failed trial here credits a challenge that produced no evidence —
        // see behavior-evaluators.test.mjs › "does not credit a discriminating
        // trial that ended in error" and › "does not credit a discriminating
        // trial whose tool was unavailable", one per status this excludes.
        //
        // Deliberately narrower than `toolCallsUsed` above, which counts every
        // trial because a failed attempt still SPENT the resource it reports.
        // Success is the question here; spend is the question there.
        executedDiscriminatingTrialCount: finalState.trials.filter(
          ({ testId, status }) =>
            status === 'ok' && discriminatingTestIds.has(testId),
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

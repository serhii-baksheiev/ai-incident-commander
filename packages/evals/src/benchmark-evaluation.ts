import { createHash } from 'node:crypto';

import {
  type IncidentConclusion,
  type InvestigationStop,
  type PrimaryScope,
} from '@aic/domain';

import {
  BEHAVIOR_EVALUATOR_VERSION,
  BEHAVIOR_METRIC_KEYS,
  STRUCTURAL_EVALUATOR_VERSION,
  evaluateChallengeEffect,
  evaluateFalseAlertOutcome,
  evaluateMisleadingEvidenceHandling,
  evaluateStructuralChallengeEffect,
  evaluateStructuralFalseAlertOutcome,
  evaluateStructuralMisleadingEvidenceHandling,
  type BehaviorMetric,
  type BehaviorMetricKey,
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
import type { PredictionGap } from './prediction-gap.js';
import { structuralGroundTruthFor } from './structural-ground-truth.js';

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
  /**
   * Absent when no sampling temperature is sent, which is every role today.
   * see naive-role.test.mjs › "sends no temperature field, so the naive arm samples exactly as the graph arm does"
   */
  readonly temperature?: number;
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

/**
 * `unsupported_claim_rate` additionally carries how many claims it counted —
 * the denominator the rate was computed over — so a reader of one run's
 * metric does not have to re-derive it from the raw outcome.
 * see four-arm-lane.test.mjs › "evaluateUnsupportedClaimRate reports how many claims it counted"
 */
export interface UnsupportedClaimRateMetric
  extends BenchmarkMetric<'unsupported_claim_rate'> {
  readonly claimCount: number;
}

export type BenchmarkMetrics = Readonly<{
  unsupported_claim_rate: UnsupportedClaimRateMetric;
  evidence_coverage: BenchmarkMetric<'evidence_coverage'>;
  termination_correctness: BenchmarkMetric<'termination_correctness'>;
}>;

export interface BenchmarkOutcome {
  readonly claims: readonly Readonly<{ evidenceIds: readonly string[] }>[];
  readonly supportingEvidenceIds: readonly string[];
  readonly evidenceFingerprints: readonly EvidenceFingerprint[];
  /**
   * The ids of the evidence the run REFERENCED — cited by a cause or assessed —
   * which is what the structural evaluator counts as investigated. Absent reads
   * as none: a run is not credited for evidence it only collected or was shown.
   */
  readonly referencedEvidenceIds?: readonly string[];
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
  /**
   * Metrics that do not apply to how this run was produced, each with the
   * reason — distinct from a score of zero, from a withheld metric and from a
   * refusal. A metric named here is not computed at all.
   * see naive-arm.test.mjs › "evaluateBenchmarkRecord omits a metric named in notApplicable, and the result carries the map"
   */
  readonly notApplicable?: NotApplicableMetrics;
  /**
   * AIC-119 slice 4 (owner ruling D1, item 7): present only on a result the
   * GRAPH arm produced (`runGraphBenchmarkExperiment` attaches it from the
   * run's final state) — the naive and oracle runners never execute the graph
   * and so never set it.
   * see prediction-gap.test.mjs › "runGraphBenchmarkExperiment attaches
   * predictionGap, computed from finalState, to every result"
   * see prediction-gap.test.mjs › "predictionGap is absent from every result
   * the naive arm and the oracle arm produce"
   */
  readonly predictionGap?: PredictionGap;
}

export type NotApplicableMetrics = Readonly<Partial<Record<BehaviorMetricKey, string>>>;

function requireNotApplicable(
  notApplicable: NotApplicableMetrics | undefined,
): ReadonlySet<string> {
  if (notApplicable === undefined) return new Set();
  // see naive-arm.test.mjs › "evaluateBenchmarkRecord given notApplicable: null throws a named refusal rather than a TypeError from Object.entries"
  if (notApplicable === null || typeof notApplicable !== 'object' || Array.isArray(notApplicable)) {
    throw new Error('notApplicable must be an object mapping a behavior metric to its reason');
  }
  const behaviorKeys = new Set<string>(BEHAVIOR_METRIC_KEYS);
  for (const [key, reason] of Object.entries(notApplicable)) {
    if (!behaviorKeys.has(key)) {
      throw new Error(`only a behavior metric can be not applicable, and ${key} is not one`);
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error(`a not-applicable metric needs its reason: ${key}`);
    }
  }
  return new Set(Object.keys(notApplicable));
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

export interface BenchmarkPlanOptions {
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

export type BenchmarkScenarioSelection =
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
}>): UnsupportedClaimRateMetric {
  const supporting = new Set(supportingEvidenceIds);
  const unsupported = claims.filter(
    ({ evidenceIds }) =>
      evidenceIds.length === 0 ||
      !evidenceIds.some((evidenceId) => supporting.has(evidenceId)),
  ).length;

  return {
    key: 'unsupported_claim_rate',
    score: claims.length === 0 ? 0 : unsupported / claims.length,
    claimCount: claims.length,
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
  notApplicable,
}: Readonly<{
  record: BenchmarkRecord;
  outcome: BenchmarkOutcome;
  resources?: BenchmarkResourceEvidence;
  notApplicable?: NotApplicableMetrics;
}>): BenchmarkEvaluation {
  const skipped = requireNotApplicable(notApplicable);
  // Which evaluator scored this record is the record's own declaration, and an
  // undeclared or unknown version is refused rather than scored the default
  // way: two records with one version must mean one set of semantics.
  // see structural-evaluator.test.mjs › "evaluateBenchmarkRecord refuses an
  // unknown evaluator version even on a scenario with no behavior metric"
  const { evaluatorVersion } = record.metadata;
  if (evaluatorVersion === STRUCTURAL_EVALUATOR_VERSION) {
    return evaluateStructuralRecord({ record, outcome, resources, notApplicable, skipped });
  }
  if (evaluatorVersion !== BEHAVIOR_EVALUATOR_VERSION) {
    throw new Error(
      `evaluator version must be ${BEHAVIOR_EVALUATOR_VERSION} or ${STRUCTURAL_EVALUATOR_VERSION}`,
    );
  }
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
  ): void => defineBehaviorMetric(behaviorMetrics, metric);
  const { groundTruth } = record.scenario;

  if (
    groundTruth.rootCause !== undefined &&
    groundTruth.misleadingEvidence !== undefined &&
    !skipped.has('misleading_evidence_handling')
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
  if (groundTruth.expectedConclusionKind === 'no-incident' && !skipped.has('false_alert_correctness')) {
    const result = evaluateFalseAlertOutcome({
      evaluatorVersion: record.metadata.evaluatorVersion,
      groundTruth,
      outcome,
    });
    recordBehaviorMetric(result);
  }
  if (groundTruth.expectedLeaderChangeAfterChallenge !== undefined && !skipped.has('challenge_effect')) {
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
    ...(notApplicable === undefined ? {} : { notApplicable: Object.freeze({ ...notApplicable }) }),
  };
}

function defineBehaviorMetric(
  behaviorMetrics: BehaviorMetrics,
  metric: NonNullable<BehaviorMetrics[keyof BehaviorMetrics]>,
): void {
  Object.defineProperty(behaviorMetrics, metric.key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: metric,
  });
}

/**
 * The structural evaluator (`behavior-evaluators-v0.3`, AIC-105): the same six
 * metrics, with evidence matched by the ids the run REFERENCED against
 * `STRUCTURAL_GROUND_TRUTH`, and the root cause matched structurally. Which
 * metrics apply to a scenario is still decided by its accepted ground truth, so
 * the two versions score the same set of metrics on every scenario.
 */
function evaluateStructuralRecord({
  record,
  outcome,
  resources,
  notApplicable,
  skipped,
}: Readonly<{
  record: BenchmarkRecord;
  outcome: BenchmarkOutcome;
  resources?: BenchmarkResourceEvidence;
  notApplicable?: NotApplicableMetrics;
  skipped: ReadonlySet<string>;
}>): BenchmarkEvaluation {
  const { groundTruth } = record.scenario;
  const truth = structuralGroundTruthFor(record.scenario.id);
  const referenced = new Set(outcome.referencedEvidenceIds ?? []);
  const unsupportedClaimRate = evaluateUnsupportedClaimRate(outcome);
  const evidenceCoverage: BenchmarkMetric<'evidence_coverage'> = {
    key: 'evidence_coverage',
    score:
      truth.expectedEvidenceIds.length === 0
        ? 1
        : truth.expectedEvidenceIds.filter((id) => referenced.has(id)).length /
          truth.expectedEvidenceIds.length,
  };
  const terminationCorrectness = evaluateTerminationCorrectness({
    expectedStopKind: groundTruth.expectedStopKind,
    expectedConclusionKind: groundTruth.expectedConclusionKind,
    stopKind: outcome.stopKind,
    conclusionKind: outcome.conclusionKind,
  });

  const behaviorMetrics: BehaviorMetrics = {};
  if (
    groundTruth.rootCause !== undefined &&
    groundTruth.misleadingEvidence !== undefined &&
    !skipped.has('misleading_evidence_handling')
  ) {
    defineBehaviorMetric(
      behaviorMetrics,
      evaluateStructuralMisleadingEvidenceHandling({ truth, outcome }),
    );
  }
  if (groundTruth.expectedConclusionKind === 'no-incident' && !skipped.has('false_alert_correctness')) {
    defineBehaviorMetric(
      behaviorMetrics,
      evaluateStructuralFalseAlertOutcome({
        truth,
        expectedStopKind: groundTruth.expectedStopKind,
        expectedConclusionKind: groundTruth.expectedConclusionKind,
        outcome,
      }),
    );
  }
  if (groundTruth.expectedLeaderChangeAfterChallenge !== undefined && !skipped.has('challenge_effect')) {
    defineBehaviorMetric(
      behaviorMetrics,
      evaluateStructuralChallengeEffect({
        groundTruth: {
          expectedLeaderChangeAfterChallenge: groundTruth.expectedLeaderChangeAfterChallenge,
        },
        outcome: outcome.challengeEffect ?? {
          challengeNodeExecuted: false,
          challengeInvocationCount: 0,
          executedDiscriminatingTrialCount: 0,
        },
      }),
    );
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
    ...(resources === undefined ? {} : { resources }),
    ...(notApplicable === undefined ? {} : { notApplicable: Object.freeze({ ...notApplicable }) }),
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
    /** Behavior metrics that do not apply to this arm, with the reason. */
    notApplicable?: NotApplicableMetrics;
  }>;

export async function runBenchmarkExperiment(
  options: BenchmarkExperimentOptions,
): Promise<BenchmarkExperiment> {
  const records = createExecutionBenchmarkPlan(options);
  // Refused before the first investigation, so a bad map costs no model call.
  // see naive-arm.test.mjs › "runBenchmarkExperiment refuses an invalid notApplicable before calling investigate for any record"
  requireNotApplicable(options.notApplicable);
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
      ...(options.notApplicable === undefined ? {} : { notApplicable: options.notApplicable }),
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

/**
 * A synthetic `primaryScope` for benchmark scenario runs: the benchmark has no
 * registry (`RegistrySnapshot`) to resolve a real Service and Environment
 * against, so this fixed pair of UUIDs stands in rather than routing every
 * scenario through `incidentFromIntake`, which would also put `title`,
 * `startedAt`, `signals` and `idempotencyKey` into the incident the model is
 * shown.
 */
export const BENCHMARK_PRIMARY_SCOPE: PrimaryScope = Object.freeze({
  serviceId: '99999999-9999-4999-8999-999999999999',
  environmentId: '88888888-8888-4888-8888-888888888888',
});

/**
 * The incident id a benchmark run shows to the model: opaque, derived from the
 * run rather than from the scenario.
 *
 * The scenario id is a ground-truth label (`false-alert`, `bad-deployment`),
 * and the incident travels into every model-facing prompt, so an incident named
 * after its scenario hands the model the answer's category. `scenarioId` stays
 * on the record's metadata, where the evaluator reads it and no model does.
 * see model-prompt-scenario-leak.test.mjs › "shows no REPLAY_SCENARIOS id in
 * any model prompt, for every scenario and every model-backed role"
 */
export function opaqueIncidentId(runId: string): string {
  requireNonEmpty(runId, 'runId');
  const digest = createHash('sha256')
    .update(`aic-benchmark-incident:${runId}`)
    .digest('hex');
  return `incident-${digest.slice(0, 16)}`;
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

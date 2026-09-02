import { Client } from 'langsmith';

export const OBSERVABILITY_LAYER = 'observability' as const;

const PERSISTED_METRIC_KEYS = [
  'unsupported_claim_rate',
  'evidence_coverage',
  'termination_correctness',
] as const;

/**
 * The resource axes this layer will persist, and the ONLY ones.
 *
 * `PERSISTED_RESOURCE_SCHEMA_VERSION` is the shape this layer can read. An
 * evidence object at any other version is refused rather than projected: the
 * fields it declares may mean something else, and publishing them under the
 * names below would be a measurement claim nobody made.
 */
const PERSISTED_RESOURCE_SCHEMA_VERSION = 1;
const PERSISTED_RESOURCE_KEYS = [
  'logicalIterationsUsed',
  'declaredLlmCallsUsed',
  'toolCallsUsed',
  'wallClockDurationMs',
  'retryCount',
  'resumeCount',
] as const;

const PERSISTED_BEHAVIOR_METRIC_KEYS = [
  'misleading_evidence_handling',
  'false_alert_correctness',
  'challenge_effect',
] as const;

const PERSISTED_BEHAVIOR_EVALUATOR_VERSION =
  'behavior-evaluators-v0.2' as const;

const PERSISTED_BEHAVIOR_METRIC_REASONS = new Set([
  'passed',
  'misleading-evidence-not-investigated',
  'expected-evidence-missing',
  'root-cause-mismatch',
  'misleading-evidence-not-reconciled',
  'insufficient-investigation',
  'incorrect-outcome',
  'challenge-not-observed',
  'leader-observation-missing',
  'no-investigation-change',
  'leader-change-mismatch',
]);

interface NativeDataset {
  readonly id: string;
}

interface NativeProject {
  readonly id: string;
}

interface NativeExample {
  readonly id: string;
}

interface NativeExampleCreate {
  readonly id: string;
  readonly dataset_id: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface LangSmithPersistenceClient {
  createDataset(name: string): Promise<NativeDataset>;
  createExamples(examples: NativeExampleCreate[]): Promise<NativeExample[]>;
  createProject(payload: Readonly<{
    projectName: string;
    referenceDatasetId: string;
  }>): Promise<NativeProject>;
  createRun(payload: Readonly<{
    id: string;
    name: string;
    run_type: 'chain';
    inputs: Readonly<Record<string, unknown>>;
    outputs: Readonly<Record<string, unknown>>;
    extra: Readonly<{ metadata: Readonly<Record<string, unknown>> }>;
    project_name: string;
    reference_example_id: string;
  }>): Promise<void>;
  createFeedback(feedback: Readonly<{
    runId: string;
    sessionId: string;
    key: string;
    score: number;
  }>): Promise<unknown>;
}

export interface PersistedBenchmarkRunMetadata {
  readonly runId: string;
  readonly scenarioId: string;
  readonly graphVersion: string;
  readonly promptVersion: string;
  readonly toolsetVersion: string;
  readonly statusRulesVersion: string;
  readonly evaluatorVersion?: string;
  readonly toolMode: 'live' | 'replay';
  readonly knowledgeSetVersion: string;
  readonly memoryEnabled: boolean;
  readonly humanReview: false;
  readonly temperature: number;
  readonly seed?: number;
  readonly docsAvailable?: boolean;
}

export interface PersistedBenchmarkRecord {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly scenario: Readonly<{
    id: string;
    groundTruth: unknown;
  }>;
  readonly metadata: PersistedBenchmarkRunMetadata;
}

export interface PersistedBenchmarkEvaluation {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly actualStopKind: string;
  readonly metrics: Readonly<
    Record<string, Readonly<{ key: string; score: number }>>
  >;
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly behaviorMetrics?: Readonly<
    Partial<
      Record<
        (typeof PERSISTED_BEHAVIOR_METRIC_KEYS)[number],
        Readonly<{
          evaluatorVersion: string;
          key: string;
          score: number;
          reason: string;
        }>
      >
    >
  >;
}

export interface PersistedBenchmarkExperiment {
  readonly records: readonly PersistedBenchmarkRecord[];
  readonly results: readonly PersistedBenchmarkEvaluation[];
}

export function createLangSmithClient(): LangSmithPersistenceClient {
  return new Client({ omitTracedRuntimeInfo: true });
}

function assertResultIdentity(
  record: PersistedBenchmarkRecord,
  result: PersistedBenchmarkEvaluation,
): void {
  if (
    result.runId !== record.runId ||
    result.exampleId !== record.exampleId ||
    result.experimentId !== record.experimentId
  ) {
    throw new Error('benchmark result identity must match its run record');
  }
}

function projectRunMetadata(
  metadata: PersistedBenchmarkRunMetadata,
): Record<string, unknown> {
  if (
    metadata.evaluatorVersion !== undefined &&
    metadata.evaluatorVersion !== PERSISTED_BEHAVIOR_EVALUATOR_VERSION
  ) {
    throw new Error('benchmark evaluator version is not supported');
  }
  const projected: Record<string, unknown> = {
    runId: metadata.runId,
    scenarioId: metadata.scenarioId,
    graphVersion: metadata.graphVersion,
    promptVersion: metadata.promptVersion,
    toolsetVersion: metadata.toolsetVersion,
    statusRulesVersion: metadata.statusRulesVersion,
    toolMode: metadata.toolMode,
    knowledgeSetVersion: metadata.knowledgeSetVersion,
    memoryEnabled: metadata.memoryEnabled,
    humanReview: metadata.humanReview,
    temperature: metadata.temperature,
  };
  if (metadata.evaluatorVersion !== undefined) {
    projected.evaluatorVersion = metadata.evaluatorVersion;
  }
  if (metadata.seed !== undefined) projected.seed = metadata.seed;
  if (metadata.docsAvailable !== undefined) {
    projected.docsAvailable = metadata.docsAvailable;
  }
  return projected;
}

function requireMetrics(
  result: PersistedBenchmarkEvaluation,
): Record<
  (typeof PERSISTED_METRIC_KEYS)[number],
  Readonly<{ key: string; score: number }>
> {
  return Object.fromEntries(
    PERSISTED_METRIC_KEYS.map((key) => {
      const metric = result.metrics[key];
      if (metric === undefined || metric.key !== key) {
        throw new Error(`benchmark result is missing metric: ${key}`);
      }
      return [key, metric];
    }),
  ) as Record<
    (typeof PERSISTED_METRIC_KEYS)[number],
    Readonly<{ key: string; score: number }>
  >;
}

/**
 * Projects resource evidence, or refuses it.
 *
 * Absent is not an error: every record written before this evidence existed
 * carries none, and the generic benchmark path publishes none by design.
 *
 * PRESENT is held to the throwing standard `requireBehaviorMetrics` uses rather
 * than the dropping one `requireMetrics` uses, and the difference matters: a
 * silently dropped resource axis reads downstream as "this run spent nothing on
 * that axis", which is the one reading that must never be manufactured. An
 * unknown schema version or a missing declared field is therefore refused
 * before the run is created. An UNDECLARED extra property is dropped by the
 * projection — it is not a claim this layer is being asked to publish.
 */
function requireResourceEvidence(
  result: PersistedBenchmarkEvaluation,
): Readonly<Record<string, number>> | undefined {
  if (result.resources === undefined) return undefined;

  const evidence = result.resources;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    throw new Error('benchmark resource evidence is not an object');
  }

  // OWN data properties only, the idiom `readDeclaredLlmCalls` uses in the graph
  // for the same hazard: read through the prototype chain and a polluted
  // `Object.prototype.resumeCount` supplies a count the run never declared —
  // manufacturing the exact reading this function exists to refuse.
  const own = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(evidence, key);
    return descriptor === undefined || !Object.hasOwn(descriptor, 'value')
      ? undefined
      : descriptor.value;
  };

  // Absent version and wrong version are different failures: one is evidence
  // that forgot to say what it is, the other is evidence this layer cannot
  // read. Reporting them the same way sends the reader looking for the wrong
  // problem.
  const schemaVersion = own('schemaVersion');
  if (schemaVersion === undefined) {
    throw new Error('benchmark resource evidence missing schemaVersion');
  }
  if (schemaVersion !== PERSISTED_RESOURCE_SCHEMA_VERSION) {
    throw new Error(
      `benchmark resource schema version is not supported: ${String(schemaVersion)}`,
    );
  }

  // Built with CreateDataProperty semantics, NOT assignment. `projected[key] =`
  // is an ordinary [[Set]] that walks the prototype chain, so an inherited
  // ACCESSOR named like an axis swallows the write: no own property is created,
  // the axis vanishes from the published outputs — reading downstream as "spent
  // nothing on that axis" — and the feedback projection then reads the
  // inherited getter back out and publishes a number no run declared. Refusing
  // to READ a polluted value is only half the job if the WRITE can still be
  // intercepted. `requireMetrics` above already builds this way.
  const entries: [string, number][] = [
    ['schemaVersion', PERSISTED_RESOURCE_SCHEMA_VERSION],
  ];
  for (const key of PERSISTED_RESOURCE_KEYS) {
    const value = own(key);
    if (value === undefined) {
      throw new Error(`benchmark resource evidence missing ${key}`);
    }
    // The same rule the graph applies to its own counters: a count is a
    // non-negative safe integer. Restated rather than imported because this
    // layer keeps its own outbound vocabulary — but it must not be LOOSER than
    // the graph's, or a negative duration crosses the boundary as evidence.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`benchmark resource evidence ${key} is not a count`);
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function requireBehaviorMetrics(
  result: PersistedBenchmarkEvaluation,
  evaluatorVersion: string | undefined,
): Readonly<
  Partial<
    Record<
      (typeof PERSISTED_BEHAVIOR_METRIC_KEYS)[number],
      Readonly<{
        evaluatorVersion: string;
        key: string;
        score: number;
        reason: string;
      }>
    >
  >
> {
  if (
    (result.behaviorMetrics === undefined) !==
    (evaluatorVersion === undefined)
  ) {
    throw new Error(
      'behavior metric evaluator version and behavior metrics must be declared together',
    );
  }
  if (result.behaviorMetrics === undefined) return {};

  const declaredKeys = new Set<string>(PERSISTED_BEHAVIOR_METRIC_KEYS);
  const projected: Record<string, Readonly<{
    evaluatorVersion: string;
    key: string;
    score: number;
    reason: string;
  }>> = {};
  for (const [key, metric] of Object.entries(result.behaviorMetrics)) {
    if (!declaredKeys.has(key) || metric?.key !== key) {
      throw new Error(`benchmark result has unknown behavior metric: ${key}`);
    }
    if (
      evaluatorVersion !== PERSISTED_BEHAVIOR_EVALUATOR_VERSION ||
      metric.evaluatorVersion !== PERSISTED_BEHAVIOR_EVALUATOR_VERSION
    ) {
      throw new Error(`behavior metric evaluator version mismatch: ${key}`);
    }
    if (metric.score !== 0 && metric.score !== 1) {
      throw new Error(`behavior metric score must be zero or one: ${key}`);
    }
    if (!PERSISTED_BEHAVIOR_METRIC_REASONS.has(metric.reason)) {
      throw new Error(`behavior metric reason is not declared: ${key}`);
    }
    // Same CreateDataProperty reasoning as the resource projection further down
    // this file: an
    // inherited accessor named like a behavior metric would otherwise swallow
    // this write.
    Object.defineProperty(projected, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        evaluatorVersion: metric.evaluatorVersion,
        key: metric.key,
        score: metric.score,
        reason: metric.reason,
      },
    });
  }
  return projected;
}

function createNativeExamples(
  datasetId: string,
  records: readonly PersistedBenchmarkRecord[],
): NativeExampleCreate[] {
  const runNumbers = new Map<string, number>();
  return records.map((record) => {
    const runNumber = (runNumbers.get(record.scenario.id) ?? 0) + 1;
    runNumbers.set(record.scenario.id, runNumber);
    return {
      id: record.exampleId,
      dataset_id: datasetId,
      inputs: { scenarioId: record.scenario.id, runNumber },
      outputs: { groundTruth: record.scenario.groundTruth },
    };
  });
}

function requireExperiment(
  experiment: PersistedBenchmarkExperiment,
): PersistedBenchmarkRecord {
  if (experiment.records.length !== experiment.results.length) {
    throw new Error('benchmark records and results must have the same length');
  }
  const firstRecord = experiment.records[0];
  if (firstRecord === undefined) {
    throw new Error('benchmark experiment must contain at least one record');
  }
  if (
    experiment.records.some(
      ({ experimentId }) => experimentId !== firstRecord.experimentId,
    )
  ) {
    throw new Error('benchmark records must belong to one experiment');
  }
  return firstRecord;
}

async function persistPreparedExperiment({
  client,
  datasetId,
  experiment,
}: Readonly<{
  client: LangSmithPersistenceClient;
  datasetId: string;
  experiment: PersistedBenchmarkExperiment;
}>): Promise<void> {
  const firstRecord = requireExperiment(experiment);
  const project = await client.createProject({
    projectName: firstRecord.experimentId,
    referenceDatasetId: datasetId,
  });

  for (const [index, record] of experiment.records.entries()) {
    const result = experiment.results[index];
    if (result === undefined) {
      throw new Error('benchmark result is missing for its run record');
    }
    assertResultIdentity(record, result);
    const metrics = requireMetrics(result);
    const resources = requireResourceEvidence(result);
    const behaviorMetrics = requireBehaviorMetrics(
      result,
      record.metadata.evaluatorVersion,
    );

    await client.createRun({
      id: record.runId,
      name: `benchmark:${record.metadata.scenarioId}`,
      run_type: 'chain',
      project_name: record.experimentId,
      inputs: {
        exampleId: record.exampleId,
        scenarioId: record.metadata.scenarioId,
        threadId: record.threadId,
      },
      outputs: {
        actualStopKind: result.actualStopKind,
        metrics,
        behaviorMetrics,
        // One key per dimension, never merged into a score, and absent when the
        // run was not measured.
        ...(resources === undefined ? {} : { resources }),
      },
      extra: { metadata: projectRunMetadata(record.metadata) },
      reference_example_id: record.exampleId,
    });

    for (const metric of [
      ...Object.values(metrics),
      ...Object.values(behaviorMetrics),
    ]) {
      await client.createFeedback({
        runId: record.runId,
        sessionId: project.id,
        key: metric.key,
        score: metric.score,
      });
    }

    // Each resource axis gets its OWN feedback key beside the quality ones —
    // the item asks for "separate feedback/output keys" preserving every
    // individual dimension, and a dimension that reaches only `outputs` is one
    // surface short of that. Nothing is blended: no composite key is emitted,
    // and `schemaVersion` is metadata about the shape rather than an axis, so
    // it stays out of the score stream.
    if (resources !== undefined) {
      for (const key of PERSISTED_RESOURCE_KEYS) {
        await client.createFeedback({
          runId: record.runId,
          sessionId: project.id,
          key,
          score: resources[key],
        });
      }
    }
  }
}

export async function persistBenchmarkExperiments({
  client = createLangSmithClient(),
  datasetName,
  experiments,
}: Readonly<{
  client?: LangSmithPersistenceClient;
  datasetName: string;
  experiments: readonly PersistedBenchmarkExperiment[];
}>): Promise<void> {
  if (datasetName.length === 0) {
    throw new Error('datasetName must not be empty');
  }
  const firstExperiment = experiments[0];
  if (firstExperiment === undefined) {
    throw new Error('at least one benchmark experiment is required');
  }
  requireExperiment(firstExperiment);

  const nativeExampleIds = new Set(
    firstExperiment.records.map(({ exampleId }) => exampleId),
  );
  for (const experiment of experiments.slice(1)) {
    requireExperiment(experiment);
    if (
      experiment.records.length !== nativeExampleIds.size ||
      experiment.records.some(({ exampleId }) => !nativeExampleIds.has(exampleId))
    ) {
      throw new Error(
        'benchmark experiments must share the same native example identities',
      );
    }
  }

  const dataset = await client.createDataset(datasetName);
  await client.createExamples(
    createNativeExamples(dataset.id, firstExperiment.records),
  );
  for (const experiment of experiments) {
    await persistPreparedExperiment({
      client,
      datasetId: dataset.id,
      experiment,
    });
  }
}

export async function persistBenchmarkExperiment({
  client = createLangSmithClient(),
  datasetName,
  experiment,
}: Readonly<{
  client?: LangSmithPersistenceClient;
  datasetName: string;
  experiment: PersistedBenchmarkExperiment;
}>): Promise<void> {
  await persistBenchmarkExperiments({
    client,
    datasetName,
    experiments: [experiment],
  });
}

/**
 * The exact set `@langchain/core` honours, in its own order
 * (`@langchain/core/dist/utils/callbacks.js` `isTracingEnabled`), compared the
 * way it compares: strict equality against `'true'`.
 *
 * Reading a narrower set than the tracer does is not a cosmetic gap. A flag
 * this list omits installs the tracer while the key check below never runs, so
 * graph inputs and evidence statements are posted with no credential and the
 * rejection is swallowed as a background warning. Accepting a value the tracer
 * rejects fails the other way: the run stops on a missing key it did not need,
 * or runs untraced believing it is traced.
 */
const TRACING_FLAG_VARIABLES = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
] as const;

/**
 * Tracing configuration resolved from an environment, never from `process.env`
 * directly, so it is decidable in a test without mutating the process.
 *
 * The api key is deliberately absent from the result: callers need to know
 * whether tracing is on and which project it targets, and the LangSmith SDK
 * reads the key from the environment itself.
 */
export type TracingConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; project: string }>;

/**
 * Resolve LangSmith tracing configuration.
 *
 * The enablement flags are exactly those of `TRACING_FLAG_VARIABLES` above; the
 * api key and project each accept the `LANGSMITH_*` name and its legacy
 * `LANGCHAIN_*` twin, which is the pairing the SDK itself resolves
 * (`langsmith/dist/utils/env.js` `getLangSmithEnvironmentVariable`).
 *
 * Enabled tracing without an api key THROWS rather than returning disabled:
 * silently-off tracing is the failure this function exists to prevent. That is
 * the only delivery failure it detects — a wrong-region endpoint or an
 * unreachable host still produces a run that completes, because the tracer
 * reports a rejected send as a warning rather than failing the run it traced.
 */
export function resolveTracingConfig(
  env: Readonly<Record<string, string | undefined>>,
): TracingConfig {
  if (!TRACING_FLAG_VARIABLES.some((name) => env[name] === 'true')) {
    return { enabled: false };
  }

  const apiKey = env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      'tracing is enabled but no api key is set: export LANGSMITH_API_KEY (or LANGCHAIN_API_KEY)',
    );
  }

  return {
    enabled: true,
    project: env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? 'default',
  };
}

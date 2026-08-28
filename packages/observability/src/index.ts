import { Client } from 'langsmith';

export const OBSERVABILITY_LAYER = 'observability' as const;

const PERSISTED_METRIC_KEYS = [
  'unsupported_claim_rate',
  'evidence_coverage',
  'termination_correctness',
] as const;

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
      },
      extra: { metadata: projectRunMetadata(record.metadata) },
      reference_example_id: record.exampleId,
    });

    for (const metric of Object.values(metrics)) {
      await client.createFeedback({
        runId: record.runId,
        sessionId: project.id,
        key: metric.key,
        score: metric.score,
      });
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

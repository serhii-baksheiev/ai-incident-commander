import { Client } from 'langsmith';

export const OBSERVABILITY_LAYER = 'observability' as const;

const PERSISTED_METRIC_KEYS = [
  'unsupported_claim_rate',
  'evidence_coverage',
  'termination_correctness',
] as const;

export interface LangSmithPersistenceClient {
  createRun(payload: Readonly<{
    id: string;
    name: string;
    run_type: string;
    inputs: Readonly<Record<string, unknown>>;
    outputs: Readonly<Record<string, unknown>>;
    extra: Readonly<{ metadata: Readonly<Record<string, unknown>> }>;
    session_name: string;
  }>): Promise<void>;
  createFeedback(
    runId: string,
    key: string,
    feedback: Readonly<{ score: number }>,
  ): Promise<unknown>;
}

export interface PersistedBenchmarkRecord {
  readonly experimentId: string;
  readonly exampleId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
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

export function createLangSmithClient(): LangSmithPersistenceClient {
  return new Client();
}

export async function persistBenchmarkEvaluation({
  client = createLangSmithClient(),
  record,
  result,
}: Readonly<{
  client?: LangSmithPersistenceClient;
  record: PersistedBenchmarkRecord;
  result: PersistedBenchmarkEvaluation;
}>): Promise<void> {
  if (
    result.runId !== record.runId ||
    result.exampleId !== record.exampleId ||
    result.experimentId !== record.experimentId
  ) {
    throw new Error('benchmark result identity must match its run record');
  }

  const metrics = Object.fromEntries(
    PERSISTED_METRIC_KEYS.map((key) => {
      const metric = result.metrics[key];
      if (metric === undefined || metric.key !== key) {
        throw new Error(`benchmark result is missing metric: ${key}`);
      }
      return [key, metric];
    }),
  );

  await client.createRun({
    id: record.runId,
    name: `benchmark:${String(record.metadata.scenarioId)}`,
    run_type: 'chain',
    session_name: record.experimentId,
    inputs: {
      exampleId: record.exampleId,
      scenarioId: record.metadata.scenarioId,
      threadId: record.threadId,
    },
    outputs: {
      actualStopKind: result.actualStopKind,
      metrics,
    },
    extra: { metadata: record.metadata },
  });

  for (const metric of Object.values(metrics)) {
    await client.createFeedback(record.runId, metric.key, {
      score: metric.score,
    });
  }
}

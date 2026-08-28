import { createHash } from 'node:crypto';

import {
  DOMAIN_LAYER,
  EvidenceSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  TrialSchema,
  upsertById,
  type Evidence,
  type ToolId,
  type Trial,
} from '@aic/domain';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export * from './investigation.js';

export const GRAPH_DEPENDENCIES = [DOMAIN_LAYER] as const;

export type PersistentInvestigationTest = Readonly<{
  id: string;
  tool: ToolId;
  input: unknown;
}>;

export type ExecuteInvestigationContext = Readonly<{
  runId: string;
  testId: string;
  attempt: number;
  tool: ToolId;
  input: unknown;
}>;

export type ExecuteInvestigationResult = Readonly<{
  trial: Pick<Trial, 'status' | 'durationMs'>;
  evidence: Omit<Evidence, 'id' | 'trialId'>;
  payloadFingerprint: string;
}>;

export type PersistentInvestigationResult = Readonly<{
  schemaVersion: typeof INCIDENT_STATE_SCHEMA_VERSION;
  runId: string;
  threadId: string;
  trials: Trial[];
  evidence: Evidence[];
  logicalBudgetUsed: number;
}>;

export type PersistentInvestigationRunner = Readonly<{
  start(input: Readonly<{ runId: string; test: PersistentInvestigationTest }>): Promise<PersistentInvestigationResult>;
  resume(input: Readonly<{ runId: string }>): Promise<PersistentInvestigationResult>;
}>;

const PersistentInvestigationState = Annotation.Root({
  schemaVersion: Annotation<typeof INCIDENT_STATE_SCHEMA_VERSION>(),
  runId: Annotation<string>(),
  test: Annotation<PersistentInvestigationTest>(),
  attempt: Annotation<number>(),
  trials: Annotation<Trial[], Trial | readonly Trial[]>({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
  evidence: Annotation<Evidence[], Evidence | readonly Evidence[]>({
    reducer: (current, update) => upsertById(current, update),
    default: () => [],
  }),
});

function hashIdentity(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function deriveTrialId({
  runId,
  testId,
  attempt,
}: Readonly<{ runId: string; testId: string; attempt: number }>): string {
  return hashIdentity([runId, testId, attempt]);
}

export function deriveEvidenceId({
  trialId,
  payloadFingerprint,
}: Readonly<{ trialId: string; payloadFingerprint: string }>): string {
  return hashIdentity([trialId, payloadFingerprint]);
}

function toResult(state: typeof PersistentInvestigationState.State): PersistentInvestigationResult {
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    threadId: state.runId,
    trials: state.trials,
    evidence: state.evidence,
    logicalBudgetUsed: new Set(state.trials.map((trial) => trial.id)).size,
  };
}

export function createPersistentInvestigationRunner({
  checkpointer,
  executeInvestigation,
}: Readonly<{
  checkpointer: BaseCheckpointSaver;
  executeInvestigation(
    context: ExecuteInvestigationContext,
  ): Promise<ExecuteInvestigationResult>;
}>): PersistentInvestigationRunner {
  const graph = new StateGraph(PersistentInvestigationState)
    .addNode('execute_investigation', async (state) => {
      const trialId = deriveTrialId({
        runId: state.runId,
        testId: state.test.id,
        attempt: state.attempt,
      });
      const executed = await executeInvestigation({
        runId: state.runId,
        testId: state.test.id,
        attempt: state.attempt,
        tool: state.test.tool,
        input: state.test.input,
      });
      const evidenceId = deriveEvidenceId({
        trialId,
        payloadFingerprint: executed.payloadFingerprint,
      });
      const evidence = EvidenceSchema.parse({
        ...executed.evidence,
        id: evidenceId,
        trialId,
      });
      const trial = TrialSchema.parse({
        id: trialId,
        runId: state.runId,
        testId: state.test.id,
        attempt: state.attempt,
        tool: state.test.tool,
        input: state.test.input,
        status: executed.trial.status,
        durationMs: executed.trial.durationMs,
        evidenceIds: [evidenceId],
      });

      return { trials: trial, evidence };
    })
    .addEdge(START, 'execute_investigation')
    .addEdge('execute_investigation', END)
    .compile({ checkpointer });

  const configFor = (runId: string) => ({ configurable: { thread_id: runId } });

  return {
    async start({ runId, test }) {
      const state = await graph.invoke(
        {
          schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
          runId,
          test,
          attempt: 1,
          trials: [],
          evidence: [],
        },
        configFor(runId),
      );
      return toResult(state);
    },
    async resume({ runId }) {
      const state = await graph.invoke(null as never, configFor(runId));
      return toResult(state);
    },
  };
}

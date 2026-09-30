import {
  buildExecKey,
  DOMAIN_LAYER,
  INCIDENT_STATE_SCHEMA_VERSION,
  upsertById,
  type CommittedExecution,
  type Evidence,
  type EvidenceProvenance,
  type ToolId,
  type Trial,
} from '@aic/domain';
import {
  Annotation,
  END,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { ingestEvidence, refuseOwnProvenance } from './evidence-ingestion.js';
import { deriveEvidenceId, deriveTrialId } from './identity.js';
import { parseTrial } from './nodes/execute-investigation.js';

export * from './identity.js';
export * from './investigation.js';
export * from './investigation-routes.js';
export * from './nodes/compose.js';
export * from './nodes/derive-hypothesis-state.js';
export * from './nodes/derive-predictions.js';
export * from './nodes/evaluate-predictions.js';
export * from './nodes/execute-investigation.js';
export * from './nodes/plan-investigation.js';
export * from './nodes/termination.js';
export * from './prediction-templates.js';

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
  evidence: Omit<Evidence, 'id' | 'trialId' | 'provenance'>;
  payloadFingerprint: string;
  provenance?: EvidenceProvenance;
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

/**
 * ⚠ This runner shares `INCIDENT_STATE_SCHEMA_VERSION` with `IncidentState`,
 * and that constant moves for changes to `IncidentStateControl` — 1 -> 2 for the
 * logical budget counters, 2 -> 3 for `resumeCount` — a shape THIS state does
 * not carry. So each bump declares an incompatibility that does not exist here,
 * and nothing on the resume path validates the stamped value: a checkpoint
 * written before a bump still returns the version it was written at — by now 1
 * or 2 — through a field typed `typeof INCIDENT_STATE_SCHEMA_VERSION`, i.e.
 * whatever that constant currently is. The number is deliberately not restated
 * here: it goes stale on the next bump, and a half-updated comment reads as
 * freshly checked.
 *
 * Accepted rather than fixed: decoupling the two versions means a second version
 * taxonomy, and one version per persisted-state family is the cheaper wrong
 * answer than two that can disagree. Stated here because this is where the next
 * reader of this file will be, not in a pull request they will never open.
 */
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

/**
 * Trace identity attached to a graph invocation. Purely descriptive: LangGraph
 * forwards `runName`, `tags` and `metadata` to whatever tracer is active, so
 * this adds nothing and costs nothing when tracing is off.
 *
 * There is deliberately no `project` field. Which LangSmith project a run lands
 * in is decided by `LANGSMITH_PROJECT`, read by the SDK — a field here could
 * only ever label a run, and a label that looks like routing is worse than no
 * field at all.
 */
export type InvocationTrace = Readonly<{
  runName?: string;
  metadata?: Readonly<Record<string, unknown>>;
  tags?: readonly string[];
}>;

/**
 * Build the config for one graph invocation.
 *
 * `configurable.thread_id` is what checkpoint resume keys on, so it is always
 * present and always the runId — a trace can decorate an invocation but must
 * never alter its identity. `runId` therefore also wins over a caller metadata
 * key of the same name.
 */
export function buildInvocationConfig({
  runId,
  trace,
}: Readonly<{
  runId: string;
  trace?: InvocationTrace;
}>): LangGraphRunnableConfig {
  const configurable = { thread_id: runId };
  if (trace === undefined) {
    return { configurable };
  }
  return {
    configurable,
    runName: trace.runName ?? 'investigation',
    tags: [...(trace.tags ?? [])],
    metadata: {
      ...trace.metadata,
      runId,
    },
  };
}

/**
 * `execution` is optional: without it the node calls `executeInvestigation`
 * directly, exactly as before AIC-56. With it, the tool call is one committed
 * operation under the `tool.trial` exec key, so a run resumed after a crash
 * between the commit and LangGraph's checkpoint reuses the committed result
 * instead of calling the tool again (docs/decisions/durable-run-execution.md,
 * decisions 6 and 7). see durable-tool-replay.test.mjs › "crash between commit
 * and checkpoint: resume returns the committed result and calls
 * executeInvestigation exactly once in total"
 */
export function createPersistentInvestigationRunner({
  checkpointer,
  executeInvestigation,
  trace,
  execution,
}: Readonly<{
  checkpointer: BaseCheckpointSaver;
  trace?: InvocationTrace;
  execution?: CommittedExecution;
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
      const recordsOf = (executed: ExecuteInvestigationResult) => {
        const evidenceId = deriveEvidenceId({
          trialId,
          payloadFingerprint: executed.payloadFingerprint,
        });
        // Provenance travels alongside the result, never inside its
        // evidence: an evidence object carrying its own `provenance` is
        // refused, naming this evidence id, and a well-formed
        // `executed.provenance` becomes part of the persisted evidence
        // exactly as given — see durable-tool-replay.test.mjs › "evidence
        // carrying its own provenance is refused, naming the evidence id,
        // and nothing is committed" and › "provenance on the
        // ExecuteInvestigationResult (alongside evidence, not inside it)
        // becomes part of the persisted evidence".
        //
        // The own-provenance check runs HERE, on `executed.evidence` itself,
        // before it is ever spread into the item below: `{ ...executed.evidence }`
        // copies only OWN ENUMERABLE properties, so a non-enumerable own
        // `provenance` would otherwise vanish silently in the copy and never
        // reach `ingestEvidence`'s own check on the copy — see
        // durable-tool-replay.test.mjs › "evidence carrying its own
        // NON-enumerable provenance is refused through the durable site just
        // like an enumerable one, and nothing is committed". Reusing
        // `refuseOwnProvenance` (exported by `./evidence-ingestion.js`) keeps
        // this one own-key check in exactly one implementation
        // (`.claude/rules/invariants.md`, "one mechanism, one
        // implementation").
        refuseOwnProvenance(executed.evidence, evidenceId);
        // `executed.provenance` is read the same own-data way inside
        // `ingestEvidence` (via `provenanceSource: executed` below),
        // including the explicit-`provenance: undefined` refusal — see
        // durable-tool-replay.test.mjs › "an ExecuteInvestigationResult with
        // an explicit own provenance: undefined is refused with a message
        // naming provenance, before anything is committed".
        const evidence = ingestEvidence({
          item: { ...executed.evidence, id: evidenceId },
          trialId,
          provenanceSource: executed,
        });
        // Built through `parseTrial` (`./nodes/execute-investigation.js`), the
        // same null-prototype-input-and-post-parse-assert discipline that
        // node's own `TrialSchema.parse` calls use, rather than a second,
        // unprotected `TrialSchema.parse` call here — this runner never
        // supplies a refusal, so `undefined` is passed and the post-parse
        // assertion catches a polluted `Object.prototype.refusal` the same
        // way it would catch one supplied but lost — see
        // durable-tool-replay.test.mjs › "a polluted Object.prototype.refusal
        // never becomes an own property of the trial the durable runner
        // records or the trial it persists through project" (AIC-146 b4).
        const trial = parseTrial(
          {
            id: trialId,
            runId: state.runId,
            testId: state.test.id,
            attempt: state.attempt,
            tool: state.test.tool,
            input: state.test.input,
            status: executed.trial.status,
            durationMs: executed.trial.durationMs,
            evidenceIds: [evidenceId],
          },
          undefined,
        );
        return { trial, evidence };
      };
      const call = async () => {
        const executed = await executeInvestigation({
          runId: state.runId,
          testId: state.test.id,
          attempt: state.attempt,
          tool: state.test.tool,
          input: state.test.input,
        });
        // Validate before this result can ever be committed: `recordsOf`
        // throws on a refused or malformed result, and that throw happens
        // here, inside compute() — before `execution`'s own commit line
        // runs — so a refused result is never durably stored.
        recordsOf(executed);
        return executed;
      };
      const executed = execution
        ? await execution.committed(
            buildExecKey('tool.trial', {
              runId: state.runId,
              testId: state.test.id,
              trialAttempt: state.attempt,
            }),
            call,
            {
              project: (committed) => {
                const { trial, evidence } = recordsOf(committed);
                return { trials: [trial], evidence: [evidence] };
              },
            },
          )
        : await call();
      const { trial, evidence } = recordsOf(executed);

      return { trials: trial, evidence };
    })
    .addEdge(START, 'execute_investigation')
    .addEdge('execute_investigation', END)
    .compile({ checkpointer });

  const configFor = (runId: string) => buildInvocationConfig({ runId, trace });

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

import type { IncidentState } from '@aic/domain';
import type { ConclusionReviewDecision } from '@aic/graph';
import { createInvestigationGraph } from '@aic/graph';
import { Command } from '@langchain/langgraph';

declare const state: IncidentState;
const interruptId = '0123456789abcdef0123456789abcdef';

const confirm = { action: 'confirm' } as const satisfies ConclusionReviewDecision;
const reject = { action: 'reject' } as const satisfies ConclusionReviewDecision;
const addHypothesis = {
  action: 'add_hypothesis',
  hypothesis: {
    id: 'human-hypothesis',
    statement: 'A human-proposed alternative',
    createdBy: 'initial',
  },
} as const satisfies ConclusionReviewDecision;

const challengeProvenance = {
  action: 'add_hypothesis',
  hypothesis: {
    id: 'challenge-hypothesis',
    statement: 'Must not enter through human review',
    // @ts-expect-error challenge provenance is reserved for graph-owned output
    createdBy: 'challenge',
  },
} as const satisfies ConclusionReviewDecision;

const extraDecisionKey = {
  action: 'confirm',
  // @ts-expect-error public decisions are exact and reject additional keys
  reason: 'not in the contract',
} as const satisfies ConclusionReviewDecision;

function assertExecutionSurface(
  execution: ReturnType<typeof createInvestigationGraph>,
): void {
  void execution.execute;
  void execution.getState;
  void execution.execute({ kind: 'start', state });
  void execution.execute({
    kind: 'resume',
    interruptId,
    decision: confirm,
  });
  // @ts-expect-error raw LangGraph commands are not accepted by the public API
  void execution.execute(new Command({ resume: { [interruptId]: confirm } }));
  // @ts-expect-error a resume must target one explicit interrupt id
  void execution.execute({ kind: 'resume', decision: confirm });
  void execution.execute({
    kind: 'resume',
    interruptId,
    // @ts-expect-error challenge provenance cannot enter through human review
    decision: challengeProvenance,
  });
  void execution.execute({
    kind: 'resume',
    interruptId,
    decision: confirm,
    // @ts-expect-error resume DTOs reject LangGraph command control fields
    update: {},
    goto: '__end__',
    graph: 'parent',
  });
  // @ts-expect-error raw invoke must not be a public execution entrypoint
  void execution.invoke;
  // @ts-expect-error raw stream must not be a public execution entrypoint
  void execution.stream;
  // @ts-expect-error raw event streaming must not be a public execution entrypoint
  void execution.streamEvents;
}

void confirm;
void reject;
void addHypothesis;
void challengeProvenance;
void extraDecisionKey;
void assertExecutionSurface;

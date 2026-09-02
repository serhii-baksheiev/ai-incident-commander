# Incident Commander — Architecture v1

**Status:** Frozen for v0.1 implementation  
**Date:** 2026-08-26  
**Primary stack:** TypeScript, LangChain, LangGraph, LangSmith  
**Jira project:** AIC — AI Incident Commander

> **Architecture freeze.** The v0.1 architecture is closed for further review. Structural changes after this point must be driven by benchmark evidence, implementation constraints, or a failed invariant.

## 1. Product thesis

Incident Commander is a **stateful incident investigation system** that forms competing hypotheses, derives testable predictions, executes typed investigation tests, records raw evidence separately from interpretation, challenges its own leading hypothesis before concluding, stops through deterministic rules, survives interruption, and is measured through replayable benchmarks and LangSmith experiments.

The architectural thesis:

> **Graph controls the investigation. The model supplies judgement. Evidence controls what can be claimed. Evals decide whether a change was actually an improvement.**

LangChain is used for model bindings, structured outputs, retrieval and schemas. LangGraph owns application orchestration state, control flow, persistence and HITL. LangSmith owns traces, datasets, experiments, evaluation and regression comparison.

## 2. v0.1 non-goals

v0.1 deliberately does **not** include multi-agent swarms, autonomous prebuilt tool loops, vector DB, Kubernetes, Kafka, autonomous remediation, RAG, long-term Store memory, write actions, full API/worker topology, or production UI.

Rig may be used as an engineering guardrail, but it must not become an application runtime or introduce a second orchestration loop.

## 3. Canonical domain chain

```text
Incident
  → Hypothesis
  → Prediction
  → InvestigationTest
  → Trial
  → Evidence
  → EvidenceAssessment (rule | llm)
  → derived hypothesis state
  → mandatory challenge (max 2 rounds)
  → deterministic termination
  → Conclusion
```

## 4. Domain contracts

### Hypothesis

```ts
type Hypothesis = {
  id: string;
  statement: string;
  createdBy: "initial" | "challenge";
};

type HypothesisStatus =
  | "candidate"
  | "supported"
  | "weakened"
  | "rejected";
```

There is **no numeric confidence in v0.1**. Status is derived from versioned rules over predictions and assessments.

### Prediction

```ts
type Prediction = {
  id: string;
  hypothesisId: string;
  statement: string;
  expectedIfTrue: ExpectedObservation[];
  expectedIfFalse: ExpectedObservation[];
  status: "untested" | "confirmed" | "refuted" | "untestable";
};
```

A prediction must state what observation would support it and what observation would falsify it.

### InvestigationTest

```ts
type InvestigationTest = {
  id: string;
  predictionId: string;
  tool: ToolId;
  input: unknown;
  cost: "cheap" | "medium" | "expensive";
  status: "planned" | "executed" | "unavailable" | "failed";
};
```

### Trial

```ts
type Trial = {
  id: string;
  runId: string;
  testId: string;
  attempt: number;
  tool: ToolId;
  input: unknown;
  status: "ok" | "unavailable" | "error";
  durationMs: number;
  evidenceIds: string[];
};
```

Trial identity is deterministic under replay/resume:

```text
trialId = hash(runId, testId, attempt)
```

### Evidence

Evidence is immutable raw observation produced by a tool.

```ts
type Evidence = {
  id: string;
  trialId: string;
  kind:
    | "log"
    | "metric"
    | "trace"
    | "deploy"
    | "git"
    | "config"
    | "dependency"
    | "runbook"
    | "historical-incident";
  source: string;
  observedAt: string;
  statement: string;
  rawRef: string;
  reliability?: "high" | "medium" | "low";
};
```

`Evidence` does not know whether it supports or contradicts any hypothesis. `statement` is produced deterministically by the tool. `reliability`, if present, is source-derived rather than LLM judgement.

```text
evidenceId = hash(trialId, fingerprint(payload))
```

### EvidenceAssessment

This is the **only stored relation** between evidence and hypothesis.

```ts
type EvidenceAssessment = {
  id: string;
  evidenceId: string;
  hypothesisId: string;
  predictionId?: string;
  effect: "supports" | "contradicts" | "neutral";
  strength: "high" | "medium" | "low";
  rationale: string;
  producedBy: "rule" | "llm";
  promptVersion?: string;
  at: string;
};
```

Mechanical criteria are evaluated by code. The LLM interprets only residual semantic evidence that cannot be mechanically adjudicated.

### Conclusion

Each cause claim owns its own evidence references.

```ts
type CauseClaim = {
  hypothesisId: string;
  cause: {
    component: string;
    mechanism: string;
    trigger?: string;
  };
  evidenceIds: string[];
};

type IncidentConclusion = {
  kind:
    | "root-cause"
    | "multiple-causes"
    | "inconclusive"
    | "no-incident";
  causes: CauseClaim[];
};
```

## 5. IncidentState

```ts
type IncidentState = {
  incident: Incident;

  hypotheses: Hypothesis[];
  predictions: Prediction[];
  tests: InvestigationTest[];
  trials: Trial[];
  evidence: Evidence[];
  assessments: EvidenceAssessment[];

  conclusion?: IncidentConclusion;

  control: {
    runId: string;
    schemaVersion: number;
    statusRulesVersion: string;

    phase: InvestigationPhase;

    maxIterations: number;
    llmCallBudget: number;
    reservedChallengeBudget: number;

    iterationsUsed: number;
    llmCallsUsed: number;

    challengeRounds: number;
    stopKind?: InvestigationStop;

    humanReview: boolean;
  };
};
```

Collections use reducers with upsert-by-id semantics. `schemaVersion` is mandatory because checkpoints persist the state shape.

The three budgets and the two usage counters are **graph-owned**: a node update
can neither raise a limit nor rewrite usage. A node reports LLM consumption only
through a declaration channel the graph validates; no node writes `llmCallsUsed`
itself. Each budget terminates through the same existing `budget-exhausted` stop
kind — no new kind was introduced.

**Where the iteration cap does and does not bite.** `iterationsUsed` is
incremented by the graph on entry to `plan_investigation`, and `maxIterations`
is read on the automatic `need-more-evidence` edge out of `termination_check`.
That is one of three edges that re-enter the cycle, and the other two are bounded
by something else:

- `challenge_hypothesis → execute_investigation` re-enters without passing
  `plan_investigation`, and is bounded by `MAX_CHALLENGE_ROUNDS` and
  `reservedChallengeBudget`;
- `review_conclusion → generate_hypotheses` / `derive_predictions` re-enters on a
  human decision, and is bounded by the human. `iterationsUsed` keeps counting
  across it, so the spend stays visible, but `maxIterations` does not stop it.

So `maxIterations` bounds the automatic loop, not every path that does
investigation work. Stating it the other way round would sell cover that is not
there. see hitl-resume-contract.test.mjs › "maxIterations caps the automatic loop-back
edge while a ${route.label} re-entry is bounded by the human, and iterationsUsed
keeps counting across it"

**Two nodes have no declaration channel.** `termination_check` and
`challenge_hypothesis` return their own decision types rather than a state
update, so they cannot declare consumption — and the LLM responsibilities list
in §7 includes challenge alternative generation. `llmCallBudget` therefore cannot
count those calls when a provider arrives. Recorded here because the budget
design is read here.

`llmCallBudget` is a versioned safety cap, not a calibrated one: no LLM
execution path exists yet — nothing in `packages/` sets `declaredLlmCalls`, so
`llmCallsUsed` stays `0` by construction rather than by estimate.
see investigation-graph.test.mjs › "leaves llmCallsUsed at zero when no node
declares an llm call"

`schemaVersion` is `2` from this change. The counters are required fields, so
state persisted under version 1 is refused rather than coerced to an invented
usage of zero — on the `kind: 'start'` path by the schema's version literal, and
on the resume path by the graph's own version guard, because a restored
checkpoint is never parsed by the schema.

⚠ The two refusals are not equally legible. The resume guard names the version
it refused on; the start path does not, because `parseInvestigationExecutionInput`
collapses every schema failure into a single `invalid investigation execution
input`. Both refuse, one explains.

⚠ **An unresolved tension with the durable-execution invariant below.** §6 states
that naive `counter++` inside replayable nodes is forbidden for budget
accounting, and that logical budget accounting reconciles with unique committed
call/trial records. `iterationsUsed` is computed as a function of the entering
state rather than mutated in place, so it is stable across a replay from the
same checkpoint — but it is **not** reconciled against committed records, and
that half of the invariant is unmet. Recovery instrumentation is AIC-63's scope.
This is recorded, not resolved: the resolution belongs in this document, decided
by its owner, not in one change's history.

## 6. Run identity and persistence

An incident may have multiple runs:

```text
incidentId ≠ runId
runId = LangGraph thread_id for that run
```

Every benchmark example gets a new `runId/thread_id`.

v0.1 uses a **persistent SQLite/file-backed LangGraph checkpointer**. The exact current JS package/API is verified in an implementation spike and pinned in the lockfile.

### Durable execution invariant

The meaningful recovery test kills the process **inside a node**, while a tool or LLM call is in flight.

After resume:

- no duplicate Trial records;
- no duplicate Evidence records;
- execution continues from committed checkpoint state;
- logical budget accounting reconciles with unique committed call/trial records;
- physical retry cost may be recorded separately as recovery overhead.

Naive `counter++` inside replayable nodes is forbidden for budget accounting.

## 7. Graph v0.1

```text
START
  ↓
normalize_incident
  ↓
collect_baseline
  ↓
generate_hypotheses
  ↓
derive_predictions
  ↓
plan_investigation
  ↓
execute_investigation
  ↓
evaluate_predictions
  ↓
interpret_residual_evidence
  ↓
derive_hypothesis_state
  ↓
termination_check
  ├─ need-more-evidence → plan_investigation
  ├─ challenge-required → challenge_hypothesis
  │                         ↓
  │                   discriminating tests
  │                         ↓
  │                   execute/evaluate
  │                         ↓
  │                   termination_check
  └─ terminal → propose_conclusion
                    ↓
                   END
```

### Deterministic responsibilities

Normalization, tool execution, Trial/Evidence creation, dedupe, mechanical prediction evaluation, derived-status rules, reducers, budgets, challenge routing, termination, persistence and safety.

### LLM responsibilities

Hypothesis generation, semantic prediction decomposition, investigation planning, residual semantic evidence interpretation, challenge alternative generation, and evidence-constrained conclusion composition.

**LLM nodes do not have tools attached.** They return structured outputs. Tools are invoked only by deterministic nodes from typed `InvestigationTest` plans.

## 8. Deterministic termination

```ts
type InvestigationStop =
  | "sufficient"
  | "ambiguous"
  | "stalled"
  | "budget-exhausted"
  | "tools-unavailable"
  | "human-stop";
```

Rules:

1. `sufficient` is impossible until mandatory challenge completes.
2. `ambiguous` is valid when multiple hypotheses remain supported after allowed challenge rounds.
3. `budget-exhausted` remains distinct even if the guessed root cause happens to be correct.
4. `tools-unavailable` is never interpreted as “problem absent”.
5. `no-incident` is a valid conclusion and required for false-alert scenarios.

## 9. Mandatory challenge

Challenge is core v0.1 behavior.

```ts
type ChallengeResult = {
  alternative: Hypothesis;
  discriminatingTests: InvestigationTest[];
};
```

### Policy

1. Round 1 challenges the current leader.
2. If leadership changes, round 2 challenges the new leader.
3. Maximum: 2 challenge rounds.
4. Unresolved tie after round 2 → `ambiguous`.
5. No numeric confidence.

### Reserved challenge budget

```text
total logical budget
= normal investigation budget
+ reserved challenge budget
```

Normal planning cannot consume the reserved budget. When the leader becomes supported—or the normal budget reaches its threshold—the graph routes into challenge.

## 10. Tool layer

```ts
interface IncidentTool<I, O> {
  id: ToolId;
  risk: "read" | "safe-write" | "dangerous";
  execute(input: I): Promise<ToolResult<O>>;
}
```

v0.1 implements **read-only** tools only.

Initial narrow tool set:

- recent deployments;
- log search;
- metric query;
- trace lookup;
- Git diff / PR metadata;
- dependency health.

`unavailable` makes the relevant test/prediction `untestable`; it is not negative evidence.

## 11. Record / replay

```text
Incident Lab
   ↓ live tools
record
   ↓
versioned Scenario Fixtures
   ↓
ReplayToolAdapter
   ↓
fast benchmark/evals
```

`ReplayToolAdapter` is the default for graph/prompt iteration. `LiveToolAdapter` validates real integrations and regenerates/validates fixtures periodically.

## 12. Scenario contract

```ts
type IncidentScenario = {
  id: string;

  groundTruth: {
    rootCause?: {
      component: string;
      mechanism: string;
      trigger?: string;
    };

    expectedStopKind: InvestigationStop;

    expectedConclusionKind:
      | "root-cause"
      | "multiple-causes"
      | "inconclusive"
      | "no-incident";

    expectedEvidence: Array<{
      kind: string;
      source: string;
      predicate: string;
    }>;

    misleadingEvidence?: Array<{
      kind: string;
      source: string;
      predicate: string;
    }>;
  };
};
```

### v0.1 replay scenarios

1. bad deployment;
2. DB pool exhaustion;
3. false alert;
4. A — deployment really caused the incident;
5. B — same misleading deployment context, but another dependency caused the incident.

The A/B pair is mandatory because it tests challenge and prediction-based investigation rather than simple correlation.

## 13. LangSmith metadata

Every run records:

```text
runId
scenarioId
graphVersion
promptVersion
toolsetVersion
statusRulesVersion
evaluatorVersion (for versioned behavior-evaluator records)
toolMode: live | replay
knowledgeSetVersion
memoryEnabled
humanReview
temperature
seed (where supported)
docsAvailable (when relevant)
```

The versioned metadata projection is pinned by
`test/benchmark-evaluation.test.mjs` › "allowlists outbound run metadata and
omits undefined optional fields".

Baseline status rules are fixed **before** the first experiment and versioned.

## 14. Evals

### v0.1 deterministic gates

1. **Unsupported-claim rate** — every cause claim must reference supporting evidence/assessment.
2. **Evidence coverage** — compared with structured expected-evidence fingerprints.
3. **Termination correctness / stop-kind distribution** — compared with scenario ground truth.

Gating is per metric. Composite score is dashboard-only.

At least **3 runs per scenario** are required until stability is empirically demonstrated.

### v0.2 evaluators

- misleading-evidence resistance;
- false-alert / no-incident correctness;
- challenge-effect evaluator;
- LLM judge only where structural evaluation is insufficient.

The public benchmark execution callbacks (`investigate` and `createNodes`)
receive a ground-truth-free `BenchmarkExecutionInput` allowlist projection:
experiment/example/run/thread/scenario identities, the replay fixture, and
versioned runtime metadata. They do not receive `BenchmarkRecord`,
`IncidentScenario`, ground truth, or evaluator expectations. The complete
record remains confined to evaluator, regression-gate, persistence, and
LangSmith dataset/evidence boundaries.

Executable boundary proof: `test/behavior-evaluators.test.mjs` › "keeps
scenario ground truth outside the investigation execution callback" and ›
"graph benchmark keeps ground truth outside createNodes and records a challenge
with no investigation change".

Persisted v0.1 records remain readable without behavior-evaluator fields. A
v0.2 behavior-evaluator payload declares `evaluatorVersion` and
`behaviorMetrics` together; partial or unknown-version payloads fail loudly.
Executable compatibility proof: `test/behavior-evaluators.test.mjs` ›
"persists accepted v0.1 records without behavior-evaluator fields", › "rejects
behavior metrics when their evaluator version is absent", and › "rejects an
explicitly unsupported persisted evaluator version".

LLM judges use a cheaper model and separate eval budget.

### Hold-out

Hold-out begins once the benchmark reaches **10+ scenarios**. At least 20% are excluded from prompt iteration.

## 15. Mutation-verified eval gate

The eval gate is not trusted until it rejects an intentional regression.

Example mutation:

```text
disable mandatory challenge
```

or

```text
remove a required expected-evidence fingerprint
```

The relevant gate **must turn red**.

## 16. HITL

v0.1 HITL is an **optional interactive learning path**.

Benchmark:

```text
humanReview = false
challenge → termination → conclusion → END
```

Interactive demo:

```text
proposed conclusion
   ↓
interrupt()
   ↓
confirm | reject | add_hypothesis
   ↓
resume
```

Action approvals belong to v0.3.

## 17. Incident Lab

Target live environment:

```text
services/
  api
  payments
  inventory

infra/
  postgres
  redis
  otel
  prometheus
  loki
```

Live scenarios use isolated ephemeral compose projects or equivalent reset-safe isolation.

## 18. Roadmap

### v0.1 — Investigation Kernel

- canonical domain model;
- StateGraph;
- persistent checkpoint/resume;
- read-only tools;
- record/replay;
- 5 scenario fixtures;
- mandatory challenge;
- deterministic termination;
- LangSmith tracing/evals;
- mutation-verified regression gate;
- optional interrupt/resume demo.

### v0.2 — Investigation Quality + Live Lab

- larger scenario set;
- live Incident Lab e2e;
- richer mechanical prediction evaluation;
- misleading-evidence and challenge evaluators;
- hold-out benchmark policy;
- cost/budget tuning.

### v0.3 — Safe Operations

- ProposedAction;
- risk registry;
- HITL approval;
- proposal hash/idempotency;
- revalidation before execute;
- SAFE_WRITE;
- action outcome becomes new Evidence.

### v0.4 — Knowledge

RAG over runbooks, ADRs and postmortems as a controlled variable using `docsAvailable` and `knowledgeSetVersion`.

### v0.5 — Long-term Memory — conditional

Store is added only after an explicit learning objective is written.

Memory fill/training scenarios and evaluation scenarios must be disjoint. A same-scenario leakage-control run is mandatory. Promotion into durable memory remains human-gated.

### v1 — Production

- durable production DB checkpointer;
- API;
- workers/run ownership;
- recovery policy;
- auth/RBAC;
- retry/timeouts/rate limits;
- audit;
- deployment;
- UI.

## 19. Repo structure

```text
incident-commander/
├── apps/
│   └── cli/
├── packages/
│   ├── domain/
│   │   ├── incident/
│   │   ├── hypothesis/
│   │   ├── prediction/
│   │   ├── evidence/
│   │   └── conclusion/
│   ├── graph/
│   │   ├── state/
│   │   ├── nodes/
│   │   ├── edges/
│   │   └── graph.ts
│   ├── roles/
│   ├── tools/
│   │   ├── live/
│   │   └── replay/
│   ├── persistence/
│   ├── evals/
│   └── observability/
├── incident-lab/
├── datasets/
│   └── scenarios/
└── infra/
```

Dependency rule:

```text
domain imports no LangChain/LangGraph
graph → domain
tools → domain
evals → domain/graph
```

This direction is mechanically linted.

## 20. Rig integration

Rig is used only as a development/process guardrail.

Project invariants:

1. **LangGraph is the sole owner of application orchestration state.**
2. LLM nodes do not own executable tools.
3. Changes to graph topology, prompts or tool semantics require benchmark evidence associated with the head SHA.
4. Unit/replay gates must not require a running Incident Lab.
5. Incident Commander is not part of the Rig Platform RP v0.1 validation experiment.

## 21. v0.1 Definition of Done

v0.1 is complete only when all of the following are true:

- 5 replay scenarios exist, including the A/B pair and false-alert;
- each scenario is run `>= 3` times;
- every benchmark example gets a fresh `runId/thread_id`;
- persistent checkpointing is enabled;
- kill-process **inside `execute_investigation` during an unfinished tool call** → resume succeeds;
- resume produces no duplicate Trial or Evidence records;
- logical budget accounting reconciles with committed trial/call records;
- mandatory challenge executes with max 2 rounds;
- challenge budget is reserved from normal planning;
- deterministic termination supports `sufficient`, `ambiguous`, `stalled`, `budget-exhausted`, and `tools-unavailable`;
- conclusions support `root-cause`, `multiple-causes`, `inconclusive`, and `no-incident`;
- baseline LangSmith experiment exists;
- one changed experiment is compared against baseline;
- an intentional regression makes the eval gate fail;
- benchmark runs with `humanReview=false`;
- one optional interactive `interrupt()` → resume flow is demonstrated;
- persistent checkpointer dependency is proven in local + Docker/CI spike.

## 22. Architecture freeze

The architecture is now **FROZEN for v0.1**.

Before coding, only structural corrections required to implement this document are permitted. RAG, Store, write actions, API topology, workers and UI are outside v0.1.

The next source of architectural evidence is the benchmark—not another review round.

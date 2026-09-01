<div align="center">
  <h1>AI Incident Commander</h1>
  <p><strong>Evidence-driven, replayable incident investigation built around deterministic control.</strong></p>
  <p>
    Architecture frozen for v0.1 · TypeScript · LangGraph · LangChain · LangSmith
  </p>
  <p>
    <a href="docs/incident-commander-architecture-v1.md">Architecture v1</a>
    ·
    <a href="https://sbaksheiev.atlassian.net/jira/software/projects/AIC/boards">Jira project</a>
  </p>
</div>

---

AI Incident Commander is designed as a stateful investigation system for operational incidents. It forms competing hypotheses, derives falsifiable predictions, runs typed investigation tests, preserves raw evidence separately from interpretation, challenges its leading explanation, and stops through deterministic rules.

The goal is not an autonomous remediation swarm. The goal is a disciplined investigation kernel whose conclusions can be traced to evidence, resumed after interruption, replayed against fixed scenarios, and measured before changes are accepted.

## Investigation loop

```mermaid
flowchart LR
    I[Incident] --> H[Competing hypotheses]
    H --> P[Testable predictions]
    P --> T[Typed investigation tests]
    T --> E[Immutable evidence]
    E --> A[Evidence assessment]
    A --> C{Challenge leader}
    C -->|More evidence| P
    C -->|Resolved or bounded| R[Evidence-linked conclusion]
```

## Architectural thesis

> **The graph controls the investigation. The model supplies judgement. Evidence controls what can be claimed. Evals decide whether a change was an improvement.**

Four boundaries make that thesis concrete:

- **LangGraph owns orchestration** — state, routing, persistence, interruption, and recovery.
- **LLM nodes return structured judgement** — they do not own executable tools.
- **Deterministic nodes own side effects** — tool execution, evidence creation, budgets, challenge routing, and termination.
- **Replayable evaluation gates change** — prompt, graph, and tool-semantic changes require evidence tied to the tested revision.

## v0.1 — Investigation Kernel

| Capability | v0.1 commitment |
| --- | --- |
| Domain | Incident → Hypothesis → Prediction → Test → Trial → Evidence → Conclusion |
| Tools | Read-only live adapters plus deterministic replay adapters |
| Control | Mandatory challenge, bounded budgets, deterministic termination |
| Recovery | Persistent checkpoints with duplicate-safe resume semantics |
| Evaluation | Five replay scenarios, repeated runs, LangSmith experiments, mutation-verified gates |
| Human input | Optional conclusion review through interrupt and resume |

Deliberate non-goals for v0.1 include write actions, autonomous remediation, multi-agent swarms, RAG, long-term memory, production API/worker topology, and a production UI.

## Project status

| Area | Status |
| --- | --- |
| Architecture | **Frozen for v0.1 implementation** |
| Repository and engineering guardrails | Scaffolded; Definition-of-Done command gate not configured |
| Product implementation | Canonical domain contracts, a persistent SQLite checkpointer with a kill/resume spike, and a read-only tool registry with live and replay adapters implemented — see [`resumes the persisted run after process death without duplicate records or budget drift`](test/persistent-resume.test.mjs) and [`replays a recorded live response without invoking the live tool again`](test/tool-registry-replay.test.mjs) |
| Scaffold milestone | [AIC-2 — scaffold repository and enforce architecture boundaries](https://sbaksheiev.atlassian.net/browse/AIC-2) |
| Completed implementation milestone | [AIC-4 — persistent checkpointer and kill/resume](https://sbaksheiev.atlassian.net/browse/AIC-4) |
| Completed implementation milestone | [AIC-5 — read-only tool registry and live record / replay adapters](https://sbaksheiev.atlassian.net/browse/AIC-5) |

The architecture freeze means structural changes must be justified by benchmark evidence, an implementation constraint, or a failed invariant—not by another speculative design round.

## Documentation

| Document | Purpose |
| --- | --- |
| [Architecture v1](docs/incident-commander-architecture-v1.md) | Canonical domain contracts, graph topology, persistence, tools, evals, roadmap, and Definition of Done |
| [PLAN.md](PLAN.md) | Local agent/operator queues and standing execution state |
| [Journal](journal/README.md) | Human-readable run history and journal conventions |
| [Self-hosted runner](RUNNER.md) | Linux ARM64 CI VM on an Apple Silicon macOS host, security boundary, and operations |

## Repository shape

```text
apps/cli                  command-line entrypoint
packages/domain           framework-free domain contracts
packages/graph            LangGraph state, nodes, edges, and routing
packages/roles            semantic roles and prompts
packages/tools            live and replay tool adapters
packages/persistence      checkpointing and recovery
packages/evals            deterministic and LangSmith evaluation gates
packages/observability    trace and run metadata
datasets/scenarios        versioned replay fixtures
incident-lab              isolated live incident environment
```

The dependency direction is intentionally one-way: `domain` imports no LangChain or LangGraph code; graph and tools depend on the domain rather than the reverse. Dependency Cruiser checks the module graph, ESLint limits dynamic loading in `packages/domain`, and small deterministic checks cover the domain manifest and TypeScript configuration.

## LangSmith tracing

Tracing is **off by default**: the CLI sets no tracing flag the operator did not
set, so an unconfigured shell produces no outbound call — see
`test/langsmith-tracing.test.mjs` › "makes no outbound call when no tracing flag
is set". Enable it per shell:

```bash
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=<your key>          # or LANGCHAIN_API_KEY
export LANGSMITH_PROJECT=ai-incident-commander
```

⚠ **EU-region accounts must also set the endpoint**, because the SDK's default
host is the US one (`langsmith/dist/utils/profiles.js`, `DEFAULT_API_URL`):

```bash
export LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
```

If every call is refused on authorization, check the region before you suspect
the key: a valid key against the wrong regional host fails the same way an
invalid one does.

**The flag vocabulary is the tracer's, not ours.** `LANGSMITH_TRACING_V2`,
`LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING` and `LANGCHAIN_TRACING` all enable
tracing, and only the exact value `true` does — matching
`@langchain/core`'s `isTracingEnabled`. See › "enables tracing for every flag
name the langchain tracer honours" and › "reports tracing disabled for a flag
value the langchain tracer rejects". Reading a narrower set than the tracer
would install the tracer while our key check stayed silent.

**What is guaranteed, exactly:** with a tracing flag on and no api key set, the
run stops before any checkpoint is written — › "refuses to start when tracing is
enabled without an api key". That is the only delivery failure detected. A
wrong-region endpoint or an unreachable host still produces a run that
completes, because the SDK sends in the background and reports the rejection as
a warning.

Runs are named and tagged so traces are filterable: the root run is
`aic-start` / `aic-resume` with tags `aic` and `aic-<command>`, and every graph
step inherits those tags and the `runId` metadata — › "sends a root run named
for the command whose tags and runId every graph step inherits". Because the
process exits as soon as it prints its result, an enabled run also sets
`LANGCHAIN_CALLBACKS_BACKGROUND=false` unless the operator set it, so delivery
blocks on finalization instead of racing exit — › "blocks background trace
delivery so a short-lived run cannot exit before it sends".

**Two costs, measured on this machine.** Blocking delivery adds roughly 700 ms
to a run (1.6 s against a reachable endpoint, versus 0.9 s in the background and
0.37 s untraced) — the price of not losing the trace. And an **unreachable**
endpoint stalls the run for about 90 seconds: the SDK's client defaults to
`timeout_ms` 90 000 with four retries (`langsmith/dist/client.js`), which no
environment variable bounds, because `@langchain/core` constructs that client
itself. This happens with or without blocking delivery. If a traced run appears
to hang, suspect the endpoint before the graph.

**The test suite is insulated from all of this.** `npm test` preloads
`test/fixtures/no-ambient-tracing.mjs`, which clears the four tracer flags
before any test module loads, and every spawned process is built from the
allow-list in `test/fixtures/child-env.mjs`. Without them a developer with
tracing exported wrote 23 runs into their own workspace on every suite run —
measured against a local counting sink, now zero.

The api key reaches neither the process output nor the trace payload — ›
"never prints the api key on stdout or stderr" and › "never sends the api key
inside a trace payload". One operator caution the code cannot enforce: the SDK
copies non-sensitive `LANGSMITH_*`/`LANGCHAIN_*` variables into run metadata,
and `LANGSMITH_RUNS_ENDPOINTS` embeds api keys in its value while matching none
of the SDK's sensitive-name patterns. Do not export it alongside tracing.

**A traced run transmits the whole graph state** — every trial input and every
evidence record, including its `statement`. Today that is synthetic
persistence-spike text; treat sending real incident content to a third party as
a decision to take deliberately, not a side effect of turning tracing on.

## Engineering workflow

Work is tracked in the [AIC Jira project](https://sbaksheiev.atlassian.net/jira/software/projects/AIC/boards) and delivered with strict Red–Green–Refactor TDD. Rig is present only as an engineering guardrail; LangGraph remains the sole owner of application orchestration.

From a clean checkout:

```bash
npm ci
npm run lint
npm run build
npm test
npm run cli -- --help
npm run cli -- start --run-id demo --checkpoint ./checkpoints.sqlite
npm run cli -- resume --run-id demo --checkpoint ./checkpoints.sqlite
```

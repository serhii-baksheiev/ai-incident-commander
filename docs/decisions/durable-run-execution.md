# Durable run execution — PostgreSQL leases, fencing and committed node results

- **Status:** Accepted, 2026-09-24, on AIC-57's race matrix (decision 11;
  "T-4 verdict" below). Proposed earlier the same day (AIC-56). The owner
  accepted the direction below on 2026-09-23, in place of an
  ADR-DURABLE-RUN-EXECUTION text that was referenced by AIC-56 and AIC-57 but
  never written down.
- **Scope:** v0.3, the infrastructure track (AIC-53). Production operating
  policy is v1.0 and is named where it applies.
- **Built against by:** AIC-56 (durable run substrate), AIC-57 (T-4 race
  harness, the acceptance gate), AIC-58 (run events and stream source); later
  AIC-42 (worker ownership and recovery policy) and AIC-49 (failure-recovery
  acceptance).

## Context

Up to v0.2 the only persisted run state is the LangGraph checkpoint: the
persistence package exports a SQLite and a PostgreSQL checkpointer and no run,
ownership or committed-result record (`packages/persistence/src/index.ts`).
v0.3 adds operational actions (AIC-20), and a run that can act on a production
system must not repeat an observation or a provider call because a worker
crashed between committing a result and checkpointing it.

So the question this record answers is: **what coordinates a run across worker
crashes, restarts and takeovers, and what guarantees does a committed result
carry?**

## Decisions

1. **PostgreSQL is the single coordination substrate.** Durable run records,
   worker ownership, leases and heartbeats, fencing, committed node-result
   identity, run events and recovery metadata all live in it. No Redis, SQS,
   Kafka, distributed lock service or second coordinator is introduced without
   measured need. The PostgreSQL checkpointer (AIC-55) stays a persistence
   mechanism behind its own boundary; it is not the product or domain
   coordination API.
2. **Runs are first-class durable records.** Worker or process identity is not
   run identity: a restart, crash, deploy or lease expiry does not end the
   logical run.
3. **Ownership is lease-based and fenced.** At most one worker holds valid write
   authority over a run. Leases are bounded and renewed by heartbeat, and a
   monotonically advancing fencing identity is checked on every commit path — a
   lease alone is not sufficient. A stale worker may keep computing, but it must
   not commit run-scoped product state after it has lost fencing authority.
4. **Waiting for a human owns no worker.** A run in `waiting_human` holds no
   lease. Its `interactionId` and domain state are durable, and whichever valid
   worker later resumes it does so through that contract; the original worker
   is irrelevant.
5. **Exactly-once external execution is not claimed.** Every logical
   side-effecting or expensive operation whose committed result must survive a
   retry or recovery carries a semantic operation identity, `exec_key`. The
   worker's ownership attempt is never part of an `exec_key`.
6. **Committed node results are immutable.** Retry, recovery or replay of the
   same logical operation returns the committed result instead of calling the
   provider or tool again. A stale worker cannot replace or mutate a committed
   result, and the result keeps the provenance of the logical operation that
   produced it.
7. **Replay is not re-observation.** Replay reuses an `exec_key` and returns its
   committed result without observing anything new. Re-observation is a new
   Trial, and so a new logical operation with a new `exec_key`, and the external
   system may be called again and may answer differently. Neither is hidden
   behind a generic retry.
8. **Checkpoints and node results solve different problems.** A checkpoint is
   orchestration state; a node result is the committed identity and outcome of
   one logical external operation. Neither substitutes for the other, and
   recovery reconciles them without assuming the two writes are atomic.
9. **The exclusion primitive is a fenced checkpointer, provisionally.** Writes
   through the checkpointer are fenced by the same ownership identity as product
   commits (a `FencedCheckpointer`). The run-scoped advisory lock of the earlier
   design is not restored.
10. **Run events are downstream evidence.** `run_events` are append-only durable
    evidence and a stream source for audit and projections. They are not an
    orchestrator and are not the source of ownership.
11. **AIC-57 is the empirical gate for decision 9.** Its critical race, T-4, is:
    a node result is committed → the worker's authority changes, or a stale
    checkpoint exists that does not reflect the commit → a new worker resumes
    from the older checkpoint. The required outcome: the committed `exec_key` is
    discovered, the provider or tool is **not** called again, the committed
    result is reused, product state converges, and the stale checkpoint fork is
    observable. A semantic divergence in that matrix is an architecture failure,
    not a flaky test. If it happens, this record stays Proposed and only the
    exclusion primitive is reopened — and the first fallback evaluated is a
    put-scoped lock around checkpoint writes, not the run-scoped advisory lock.
12. **Integrity events are observable, never silently repaired.** Lease
    acquisition, renewal, expiry and takeover; a stale or fenced commit
    rejected; a committed result reused; recovery and resume; a replay
    suppressed; a checkpoint disagreeing with a committed result; the move to
    and from `waiting_human`; terminal failure and bounded exhaustion — each is
    recorded as durable evidence.
13. **Recovery is bounded.** No recovery path loops without limit, and attempt
    and recovery metadata is kept so that AIC-42 can set the operating policy
    (maximum attempts, parking, intervention). AIC-56 and AIC-57 prove the
    mechanism; AIC-42 productionizes the policy, unless correctness needs a
    minimal primitive now.

## Run lifecycle

A run has five statuses — `queued`, `running`, `waiting_human`, `completed`,
`failed` — the ones AIC-56's scope names. These are the only transitions
between them; `completed` and `failed` are terminal.

| From | To | When |
| --- | --- | --- |
| `queued` | `running` | a worker claims the run and takes its lease (decision 3) |
| `queued` | `failed` | the run has used its bounded execution attempts (decision 13) |
| `running` | `waiting_human` | the run pauses for a human and releases its lease (decision 4) |
| `running` | `completed` | the run reaches its terminal result |
| `running` | `failed` | the run ends in a terminal failure |
| `running` | `queued` | the lease expired and the sweeper returns the run for another worker (decisions 2 and 3) |
| `waiting_human` | `queued` | the human answers and the run waits for a worker again (decision 4) |

The domain enforces the same table (`assertRunTransition` in
`packages/domain/src/execution.ts`), and the two are kept equal by
durable-run-execution-adr.test.mjs › "states the run lifecycle as a table that matches the domain transitions in both directions"

## T-4 verdict (AIC-57)

T-4 passed, so decision 9's fenced checkpointer is no longer provisional and
the put-scoped-lock fallback of decision 11 is not opened.

**Run.** `infra/postgres/tests/t4-race.live.mjs` on main `b51436d`, with
`T4_REPETITIONS=2000`, against a local `postgres:17-alpine` container from
`infra/postgres/compose.yaml`: each of the six orderings, S1 to S6, ran 2,000
times, and all 12,009 tests passed with none failing. Every repetition runs the
matrix's assertions (a) to (h), named in that file, which check the outcomes
decision 11 requires: one tool call in total, one committed node result
produced by the first attempt, a completed run with the same result and
product snapshot across repetitions, and a recorded `checkpoint_fork` for the
stale attempt. The command is in that file's header. The TAP transcripts are
not committed.

**Measured.** The file prints two series:

- `t4-window-ms landed p50=12.607 p99=46.097 n=150`: the time between a fence
  check passing and the checkpoint write landing, when nothing holds it. This
  is how long a writer that has just lost its lease can still land a write,
  and the post-write recheck is what turns that write into a recorded fork.
- `t4-sweep-attempts p50=1.000 p99=1.000 n=12000 max=2`: how many sweeps each
  run needed before it was reclaimed. The harness allows up to 20.

An earlier stress run, on `6bcacdc`, failed because of the harness, not the
checkpointer. At S1 repetition 579 the first sweep returned nothing and a
later one reclaimed the run, and repetitions were not isolated from each
other, so every later repetition claimed that leftover run. That run produced
no evidence for S2 to S6. The harness now retries the sweep and cleans up
after each repetition (#108).

**What the matrix does not cover.**

- **The pre-write fence.** A mutation that removes it leaves the matrix green.
  The fence is pinned by `fenced-checkpointer.live.mjs` › "a real zombie
  worker's checkpoint write is refused by a real RunWriteContext after a
  takeover, fence_rejections records it with kind = checkpoint, and B's
  checkpoint is unaffected".
- **How often reuse happens.** When the first attempt's checkpoint already
  records the node, the new worker never reaches it, and the run records no
  `node_result.reused` event. The matrix accepts both event shapes and does
  not count how many repetitions took each (`normalizeSnapshotEvents` in the
  harness).
- **`putWrites` timing.** The window is sampled for `put` only.
- **A failed recheck.** If the post-write recheck fails for any reason other
  than a recorded refusal, a valid owner's write fails:
  `fenced-checkpointer.test.mjs` › "a post-write recheck that fails for any
  reason other than a recorded fence refusal fails the write loudly instead of
  making the fork silent".
- **Scale.** This was one database on one machine, run one test at a time. CI
  runs the same file with `T4_REPETITIONS=3` on every pull request.

## Consequences

- AIC-56 builds the smallest substrate that proves these semantics on local
  PostgreSQL, with deterministic process and worker tests: no generic workflow
  framework, no abstraction over alternative databases or coordinators, and
  domain contracts that do not depend on LangGraph's checkpoint tables.
- AIC-57 records its measured race-window timing and its verdict in this
  record, and moves the status to Accepted or leaves it Proposed accordingly.
- Out of scope here, and not pulled forward: AIC-41's production database,
  disaster recovery and migration policy; AIC-42's full worker operating
  policy; Kubernetes, Helm or Terraform (AIC-54, deferred until measured); any
  production UI.

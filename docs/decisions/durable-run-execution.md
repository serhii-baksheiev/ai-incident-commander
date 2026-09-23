# Durable run execution — PostgreSQL leases, fencing and committed node results

- **Status:** Proposed, 2026-09-24 (AIC-56). The owner accepted the direction
  below on 2026-09-23, in place of an ADR-DURABLE-RUN-EXECUTION text that was
  referenced by AIC-56 and AIC-57 but never written down. It becomes
  **Accepted** only when AIC-57's race matrix passes (decision 11); until then
  the exclusion primitive of decision 9 is provisional.
- **Scope:** v0.3, the infrastructure track (AIC-53). Production operating
  policy is v1.0 and is named where it applies.
- **Built against by:** AIC-56 (durable run substrate), AIC-57 (T-4 race
  harness, the acceptance gate), AIC-58 (run events and stream source); later
  AIC-42 (worker ownership and recovery policy) and AIC-49 (failure-recovery
  acceptance).

## Context

Up to v0.2 a run lives in one process: the LangGraph checkpointer persists
orchestration state, and a resumed run continues from its last checkpoint.
Nothing records which worker owns a run, nothing stops a worker that has lost
the run from writing to it, and nothing distinguishes "this external call
already happened and its result is committed" from "this node has not run yet".
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

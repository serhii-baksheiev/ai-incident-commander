/**
 * AIC-57 — the T-4 race, the empirical gate for
 * docs/decisions/durable-run-execution.md decision 9 (decision 11 names T-4
 * verbatim): a node result is committed by worker A -> A's authority changes
 * (a lease loss + takeover) -> a stale checkpoint write from A lands after B,
 * the new owner, has already claimed and is progressing. The required
 * outcome: the committed `exec_key` is discovered and reused (never
 * recomputed), product state converges on B's side, and the stale checkpoint
 * fork is OBSERVABLE rather than silent.
 *
 * ## What this file measures, and why it never gates on a fixed call count
 *
 * The acceptance spec (this item) says "Pause A at the pre-put barrier" and
 * asks for release points relative to "B's checkpoint write(s)" without
 * pinning which underlying checkpointer call that is, or what "after the
 * commit" is measured against. Three things were measured to answer that,
 * each overturning an assumption the previous one made:
 *
 * 1. Without a database, in `test/persistent-runner-checkpoint-sequence.test.mjs`:
 *    one `start()` call on the one-node `createPersistentInvestigationRunner`
 *    graph calls an in-memory (`MemorySaver`) checkpointer in EXACTLY this
 *    order — `getTuple, put(1), putWrites(1), put(2), putWrites(2), put(3)` —
 *    and, pinned in that same file, the node itself (so
 *    `execution.committed()`) runs strictly AFTER `put(2)` completes and
 *    strictly before `putWrites(2)` starts. `putWrites` is fire-and-forget
 *    throughout: LangGraph calls it but never awaits its result before
 *    continuing, so it can never be a barrier; `put` genuinely blocks (its
 *    return value, the next `checkpoint_id`, is required to proceed), so a
 *    held `put` holds the whole run with it. Read only this file, "`put`#2,
 *    held" looks like the right barrier for A — the commit already happened,
 *    and it is the first call actually capable of freezing a worker.
 * 2. **Against the real `PostgresSaver` this live lane actually uses, that is
 *    false — measured directly, not merely suspected.** `put`#1 and
 *    `putWrites`#1 are DISPATCHED, and the node then runs CONCURRENTLY with
 *    those calls' own network round trips, not sequenced strictly after
 *    `put`#2 the way `MemorySaver`'s synchronous execution makes it look; the
 *    relative order of "the commit resolves" and "`put`#2 dispatches" is a
 *    genuine race under real I/O, not a fixed sequence. Holding `put`#2 by
 *    COUNT does not reliably wait for the commit to land first: measured
 *    directly, it once let A reach its held put with `execution.committed()`
 *    not yet called AT ALL, so releasing it, sweeping, and asserting on "A's
 *    committed attempt" produced exactly the corruption T-4 exists to catch —
 *    manufactured by this file's OWN premature hold, not a real defect. A
 *    worker's OWN hold therefore has to gate on the commit LANDING (a real,
 *    already-committed SQL transaction — `withCommitSignal`, below), never on
 *    a put count: `withHeldWritesAfterCommit` holds EVERY write (`put` AND
 *    `putWrites` — `putWrites` is fire-and-forget, so leaving it un-held
 *    would let A's real task output land independently of any `put` hold)
 *    dispatched once that signal has fired, as ONE shared gate, so nothing of
 *    a worker's post-commit checkpoint activity is visible until released.
 * 3. **B's OWN post-commit hold still needs to distinguish two DIFFERENT
 *    points (S4 and S5), and correlating either a `put` COUNT or a `put`/
 *    `putWrites` DISPATCH ORDER against the commit is racy for the same
 *    reason point 2 is** — measured directly a second and a third time (once
 *    as a hang, once as a flipped order between two runs of the identical
 *    scenario): B's `resume()` (never `start()` — B always resumes) makes a
 *    pre-commit `put`, then — once the node and its `committed()` call have
 *    returned — one more `put` AND one more `putWrites`, and nothing further.
 *    Which of those last two is DISPATCHED first is not fixed: measured
 *    twice under otherwise identical conditions, the order came out
 *    differently each time. So neither "S4 is the Nth write" nor "S4 is
 *    whichever arrives once a flag says the commit landed" is reliable here.
 *
 *    **What is reliable is CONTENT, which carries no timing question at
 *    all**: the post-commit `put`'s checkpoint has a non-empty `trials`
 *    channel (the committed Trial, once LangGraph has applied it) where the
 *    pre-commit one has none; the post-commit `putWrites`' pending-write list
 *    names the `trials` channel where the pre-commit one does not.
 *    `withHeldPostCommitPut`/`withHeldPostCommitPutWrites` identify EACH by
 *    that content, independently — this file makes no claim about which of
 *    the two dispatches first, only about which single call of each kind is
 *    the post-commit one. **S4 holds the content-identified post-commit
 *    `put`** (closest to "B's first checkpoint write" the acceptance item
 *    names); **S5 holds the content-identified post-commit `putWrites`**
 *    (the item's alternate phrasing, "between B's putWrites and B's put",
 *    names a second post-commit write without insisting on an order either).
 *
 * ## The S1-S6 matrix, named against that measured sequence
 *
 * B is made pausable at four points spanning S2-S5, by wrapping B's
 * checkpointer's `getTuple`/`put`/`putWrites` and B's execution port's
 * `committed` — exactly as the item's own S2-S6 bullet directs ("made
 * pausable by wrapping B's execution port and B's fenced checkpointer
 * beforeWrite with deferreds" — this file's own generalisation of that seam
 * is `withHeldPostCommitPut`/`withHeldPostCommitPutWrites`/`withBGatedReads`/
 * `withBGatedExecution` below, for the reasons points 2-3 above give). S1 and
 * S6 need no B-side gate: S1 releases A before B claims at all, and S6
 * releases A only after B's own run has reached `complete()`.
 *
 * | point | meaning (this file's naming)                                    |
 * | ----- | ----------------------------------------------------------------- |
 * | S1    | A released after the sweep, strictly before B claims               |
 * | S2    | A released after B claims, before B's first `getTuple`             |
 * | S3    | A released after B's `getTuple`, after B's real `committed()` call has landed, before that call's OWN promise resolves to the node |
 * | S4    | A released before B's content-identified post-commit `put` lands (see point 3 above) |
 * | S5    | A released before B's content-identified post-commit `putWrites` lands (see point 3 above; no claim of order against S4's `put`) |
 * | S6    | A released only after B has reached `complete()`                   |
 *
 * ## Design choices this file assumes, beyond the acceptance spec
 *
 * - **Fork detection's mechanism** is the one `test/fenced-checkpointer.test.mjs`
 *   pins (its own "AIC-57 slice (a)" section): after a write lands, the
 *   fenced checkpointer re-checks ownership via a SECOND `assertOwner('checkpoint_fork')`
 *   call and swallows a rejection from it. Against a REAL `RunWriteContext`,
 *   that rejection IS a `fence_rejections` row with `kind = 'checkpoint_fork'`
 *   (`run-write-context.ts`'s `recordRejectionAndThrow`, already shipped) — no
 *   new table, no widened `CheckpointFence`/`RunWriteContext` contract. Rows
 *   6/7/9 below are this file's own acceptance of that same design against a
 *   REAL zombie, a REAL takeover and a REAL barrier, at every point of the
 *   S1-S6 matrix rather than the ordinary suite's fake-fence version.
 * - **Both workers' holds** wrap the REAL `PostgresSaver` handed to
 *   `createFencedCheckpointer`, not `beforeWrite` itself: `beforeWrite` runs
 *   on EVERY write (put, putWrites, deleteThread alike) with no way to tell
 *   them apart, and this file needs to hold specific writes precisely — see
 *   points 2-3 above. A `beforeWrite` that carried the same logic would work
 *   identically; wrapping the inner saver directly is the narrower, more
 *   legible choice for a file whose whole point is to assert about which
 *   write precisely.
 * - **The adversarial tool** is a per-run counter closed over `executeInvestigation`;
 *   its `payloadFingerprint` and evidence `statement` both carry the call
 *   number, so two REAL calls for the same run would be observably
 *   different content, not merely counted.
 * - **Normalization** for the byte-identical comparisons (rows (e)/(f) of the
 *   acceptance spec) replaces every field that is a deterministic function of
 *   `runId` — `runId`/`threadId` themselves, `Trial.id`/`Evidence.id`/
 *   `evidenceIds`/`trialId` (sha256 of parts including `runId`,
 *   `deriveTrialId`/`deriveEvidenceId` in `@aic/graph`), and `execKey` inside
 *   an event's payload (`buildExecKey`, `@aic/domain`, also `runId`-keyed) —
 *   with a fixed placeholder, because every repetition and ordering uses its
 *   own fresh `runId` for isolation. `execution_attempt`/`produced_by_attempt`
 *   are NOT normalized: they are expected to be identical (1 for the commit,
 *   2 for the reuse) across every ordering and repetition, since this file
 *   always drives exactly one takeover.
 * - **"Written after B's claim"** (acceptance spec (c)) is read against ONE
 *   database clock, not this process's: immediately after `store.claimNext`
 *   returns B's claim, this file reads `clock_timestamp()` once from
 *   `store.pool` and compares every row's own `created_at` against THAT
 *   value — never `Date.now()`, which would compare two different clocks and
 *   could read a race that never happened.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * `T4_REPETITIONS` (default 3, kept small for the ordinary live lane) governs
 * how many times EACH of the six orderings runs. The acceptance spec's own
 * stress target (2,000 per ordering, >=10k total) is NOT a `package.json`
 * script — a script that drives thousands of real transactions against a
 * throwaway container is production-adjacent tooling, out of scope for a test
 * file to add — it is this same file, run with the variable set:
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic \
 *     T4_REPETITIONS=2000 npm run build --silent \
 *     && AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic T4_REPETITIONS=2000 \
 *     node --import ./test/fixtures/no-ambient-tracing.mjs --test \
 *     --test-concurrency=1 infra/postgres/tests/t4-race.live.mjs
 *
 * Two harness choices a stress transcript depends on: each race reclaims its
 * run with `sweepUntilReclaimed` (up to 20 sweeps, 25 ms apart; every run a
 * sweep returns must be that repetition's own), and prints how many sweeps
 * each reclaim needed as `t4-sweep-attempts`; and each repetition registers
 * `abandonLeftoverRun` right after `createRun`, so a failed repetition leaves
 * no queued or running run for the next one to claim.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/fenced-checkpointer.live.mjs` and
 * `infra/postgres/tests/run-write-context.live.mjs` — see those files'
 * headers for "why this file is not under `test/`", "it refuses; it never
 * skips", and "independent verification". Not repeated here in full.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import { createPersistentInvestigationRunner, deriveEvidenceId, deriveTrialId } from '@aic/graph';
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place AIC-57's T-4 race
matrix is measured against a real PostgreSQL, a real lease takeover and a real
checkpoint fork, so a skip would report the whole gate as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

/**
 * Kept small by default so the ordinary live lane stays fast; the stress
 * target names this file's own header for how to raise it. Must be a
 * positive integer: a silently-ignored typo (e.g. `T4_REPETITIONS=abc`
 * coercing to `NaN` and then defaulting via `??`) would run the default
 * count while looking configured.
 */
function readRepetitions() {
  const raw = process.env.T4_REPETITIONS;
  if (raw === undefined) return 3;
  const value = Number(raw);
  assert.equal(
    Number.isInteger(value) && value > 0,
    true,
    `T4_REPETITIONS must be a positive integer, got ${JSON.stringify(raw)}`,
  );
  return value;
}
const REPETITIONS = readRepetitions();

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/** Copied in shape from the sibling live files' own `freshStore`. */
async function freshStore(t, options = DEFAULT_OPTIONS) {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const store = await persistence.createRunStore(connectionString, options);
  t.after(async () => {
    await store.close();
  });
  await store.pool.query(
    'truncate table aic_app.runs, aic_app.node_results, aic_app.run_events, aic_app.run_event_counters, aic_app.run_trials, aic_app.run_evidence, aic_app.fence_rejections',
  );
  return store;
}

/** The checkpointer's own (`langgraph`) schema, provisioned once — copied from durable-tool-replay.live.mjs. */
async function provisionCheckpointerSchema() {
  const setupSaver = await persistence.createPostgresCheckpointer(requireConnectionString());
  await setupSaver.setup();
  await setupSaver.pool.end();
}

function deferredPromise() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Module scope (not exported — reachable from both the window-measurement
 * test and its own empty-sample row below, so they call the same one
 * implementation rather than two copies). For an empty `samples`, `at(50)`/
 * `at(99)` would index past the end of an empty sorted array (`undefined`,
 * whose `.toFixed(3)` throws) — reported explicitly as `n=0` instead, with
 * no `NaN`/`undefined` in the line this file's header documents as stable
 * and greppable for the stress run.
 */
function percentiles(samples) {
  if (samples.length === 0) return 'p50=n/a p99=n/a n=0';
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return `p50=${at(50).toFixed(3)} p99=${at(99).toFixed(3)} n=${sorted.length}`;
}

/**
 * The adversarial tool: every ACTUAL invocation returns content that carries
 * its own 1-indexed call number, so two real calls for the same run are
 * observably different, not merely counted.
 */
function createAdversarialTool() {
  let callCount = 0;
  return {
    callCount: () => callCount,
    async execute() {
      callCount += 1;
      const n = callCount;
      // Deliberately carries NOTHING runId-derived beyond the call number:
      // this file compares results across DIFFERENT runIds byte-for-byte
      // (rows (e)/(f)), and a runId embedded in ordinary string content
      // (unlike `Trial`/`Evidence` ids, which are normalized explicitly)
      // would make every comparison spuriously fail.
      return {
        trial: { status: 'ok', durationMs: 1 },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-09-24T00:00:00.000Z',
          statement: `t4-race adversarial call #${n}`,
          rawRef: `fixture://t4-race/call-${n}`,
          reliability: 'high',
        },
        payloadFingerprint: `t4-race-call-${n}`,
      };
    },
  };
}

/**
 * A signal that fires the instant a worker's REAL `committed()` call has
 * durably landed — the data-dependency this file gates A's and B's put-holds
 * on, instead of a fixed put-call count (see "Why a commit SIGNAL, not a
 * put-call count" above). Wraps `context` so its own `committed()` still
 * behaves identically to the caller, plus records the landing.
 */
function withCommitSignal(context) {
  const landed = deferredPromise();
  return {
    execution: {
      async committed(execKey, compute, options) {
        const result = await context.committed(execKey, compute, options);
        landed.resolve();
        return result;
      },
    },
    committedPromise: landed.promise,
  };
}

/**
 * Wraps a real PostgreSQL checkpointer so EVERY write (`put` AND `putWrites`
 * alike — `putWrites` is fire-and-forget, so leaving it un-held would let A's
 * real task output land in the database independently of any `put` hold,
 * measured directly: B would then see that output through its own `getTuple`
 * and skip re-running the node entirely, never calling `committed()` again,
 * which is a legitimate LangGraph optimisation but leaves this file with
 * nothing to synchronise B's own S4/S5 points against) dispatched AFTER
 * `committedPromise` has already resolved awaits ONE shared `gate` before
 * delegating; every call before that point passes straight through. `reached`
 * resolves the instant the FIRST such call begins waiting — the deterministic
 * signal this file uses instead of a sleep to know A has actually arrived
 * with NOTHING of its post-commit checkpoint activity visible yet.
 */
/**
 * Tracks every write promise a (fenced) checkpointer hands back. A fenced
 * write resolves only after its post-write ownership recheck — the step that
 * records a checkpoint_fork — so awaiting these, not the stale runner's own
 * settlement, is what makes "the fork has been recorded" deterministic: the
 * runner rejects on the first write the fence REFUSES, while the write held at
 * the barrier and its recheck may still be in flight.
 */
function trackWrites(saver) {
  const pending = [];
  const proxy = new Proxy(saver, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'put' || prop === 'putWrites' || prop === 'deleteThread') {
        return (...args) => {
          const promise = value.apply(target, args);
          pending.push(promise);
          return promise;
        };
      }
      return value.bind(target);
    },
  });
  return { saver: proxy, settled: () => Promise.allSettled(pending) };
}

function withHeldWritesAfterCommit(inner, committedPromise, gate, reached) {
  let armed = false;
  committedPromise.then(() => {
    armed = true;
  });
  let alreadyHeld = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'put' || prop === 'putWrites') {
        return async function (...args) {
          if (armed) {
            if (!alreadyHeld) {
              alreadyHeld = true;
              reached.resolve();
            }
            await gate.promise;
          }
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}

/**
 * S4 and S5 both need to identify ONE specific checkpointer call out of
 * several `put`/`putWrites` calls a resume makes — and measured a THIRD time
 * (this file's header, point 3): the dispatch order between the post-commit
 * `put` and the post-commit `putWrites` is ITSELF a race under real I/O, not
 * a fixed sequence, the same way point 2's `put`-count race was. Correlating
 * either by POSITION or by a commit-resolved FLAG inherits that race.
 *
 * So neither is identified by position at all: both are identified by
 * CONTENT, which carries no timing question — `put`'s checkpoint either
 * already has a non-empty `trials` channel (the commit's own Trial, applied)
 * or it does not; `putWrites`' pending-write list either contains an entry
 * for the `trials` channel or it does not. A pre-commit call always has an
 * empty or absent `trials` value, because there is nothing yet to apply.
 * This is not a claim about which of the two dispatches first — this file
 * does not claim one does — only about which ONE OF EACH KIND is the
 * post-commit one.
 */
function isPostCommitPutCheckpoint(checkpoint) {
  const trials = checkpoint?.channel_values?.trials;
  return Array.isArray(trials) && trials.length > 0;
}
function isPostCommitPutWritesEntries(writes) {
  return (writes ?? []).some(([channel, value]) => channel === 'trials' && value !== undefined && value !== null);
}

/** Holds the content-identified post-commit `put` call (S4's target); every other `put` call, and every `putWrites` call, passes straight through. */
function withHeldPostCommitPut(inner, gate, reached) {
  let alreadyHeld = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'put') {
        return async function (...args) {
          if (!alreadyHeld && isPostCommitPutCheckpoint(args[1])) {
            alreadyHeld = true;
            reached.resolve();
            await gate.promise;
          }
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}

/** Holds the content-identified post-commit `putWrites` call (S5's target); every other call passes straight through. */
function withHeldPostCommitPutWrites(inner, gate, reached) {
  let alreadyHeld = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'putWrites') {
        return async function (...args) {
          if (!alreadyHeld && isPostCommitPutWritesEntries(args[1])) {
            alreadyHeld = true;
            reached.resolve();
            await gate.promise;
          }
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}

/**
 * B's four pausable points (S2-S5), built for exactly ONE target — every
 * other point passes through immediately. `wait(name)` is called from B's own
 * wrapped checkpointer/execution port; only the call matching `target` ever
 * actually holds.
 */
function createBGates(target) {
  const held = deferredPromise();
  const reached = deferredPromise();
  async function wait(name) {
    if (name === target) {
      reached.resolve();
      await held.promise;
    }
  }
  return { wait, reachedTarget: reached.promise, release: held.resolve, isHeld: target !== undefined };
}

/** Wraps B's inner checkpointer so its first getTuple routes through gates.wait('S2'); the post-commit-write holds (S4/S5) are separate, built with withHeldPostCommitPut/withHeldPostCommitPutWrites. */
function withBGatedReads(inner, gates) {
  let getTupleCount = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'getTuple') {
        return async function (...args) {
          getTupleCount += 1;
          if (getTupleCount === 1) await gates.wait('S2');
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}

/** Wraps B's real execution port so committed() waits (S3) AFTER the real commit has landed, before returning to the node. */
function withBGatedExecution(context, gates) {
  return {
    async committed(execKey, compute, options) {
      const result = await context.committed(execKey, compute, options);
      await gates.wait('S3');
      return result;
    },
  };
}

/** Normalizes every runId-derived field so results from DIFFERENT runIds can be compared byte-for-byte. */
function normalizeResult(result) {
  return {
    schemaVersion: result.schemaVersion,
    threadId: 'RUN',
    runId: 'RUN',
    logicalBudgetUsed: result.logicalBudgetUsed,
    trials: result.trials.map((trial) => ({
      ...trial,
      id: 'TRIAL',
      runId: 'RUN',
      evidenceIds: trial.evidenceIds.map(() => 'EVIDENCE'),
    })),
    evidence: result.evidence.map((evidence) => ({ ...evidence, id: 'EVIDENCE', trialId: 'TRIAL' })),
  };
}

/**
 * Normalizes a product snapshot's CORE fields — status, terminal reason, and
 * the projected Trial/Evidence domain records — the way `normalizeResult`
 * does. This is the part expected identical across EVERY ordering and
 * repetition, S1 included.
 */
function normalizeSnapshotCore(snapshot) {
  return {
    status: snapshot.status,
    terminalReason: snapshot.terminalReason,
    interactionId: snapshot.interactionId,
    trials: snapshot.trials.map((trial) => ({
      ...trial,
      id: 'TRIAL',
      runId: 'RUN',
      evidenceIds: trial.evidenceIds.map(() => 'EVIDENCE'),
    })),
    evidence: snapshot.evidence.map((evidence) => ({ ...evidence, id: 'EVIDENCE', trialId: 'TRIAL' })),
  };
}

/**
 * Normalizes a product snapshot's `run_events`, plus the runId-derived
 * `execKey` inside a `node_result.*` event's payload.
 *
 * ⚠ **This is NOT identical across orderings OR repetitions, for ANY
 * ordering including S1.** Measured directly: A's shared post-commit gate
 * (`withHeldWritesAfterCommit`) releases whichever single write (`put` or
 * `putWrites`) was dispatched first once the commit landed — and that write
 * can EITHER already carry the completed Trial (LangGraph applied it before
 * A was even held) or not, independent of which S-point this file is
 * driving, because every ordering shares the exact same A-side mechanism.
 * When it already does, B's resume finds the checkpoint fully advanced and
 * never calls the node (or `execution.committed()`) again, giving
 * `node_result.committed` then `run.completed` — TWO events, no
 * `node_result.reused`. When it does not, B must re-run the node, giving a
 * genuine third, `node_result.reused`, event in between. Both are legitimate
 * outcomes of the SAME race this file is measuring, not a defect in either
 * ordering — the matrix test validates each run's OWN event shape (one of
 * exactly these two) rather than asserting the full event log is identical
 * across records.
 */
function normalizeSnapshotEvents(snapshot) {
  return snapshot.events.map((event) => ({
    seq: event.seq,
    type: event.type,
    executionAttempt: event.executionAttempt,
    payload:
      event.payload && typeof event.payload === 'object' && 'execKey' in event.payload
        ? { ...event.payload, execKey: 'EXEC_KEY' }
        : event.payload,
  }));
}

/**
 * How many sweeps each successful `sweepUntilReclaimed` call needed, printed
 * by the T-4 matrix as `t4-sweep-attempts`, so a retry that absorbs a
 * slowdown in the mechanism under test stays visible in a stress transcript.
 */
const sweepAttemptsUsed = [];

/**
 * Retries `store.sweepExpired()` up to `attempts` times (`delayMs` apart)
 * until `runId` is among the reclaimed rows. `sweepExpired`'s inner `FOR
 * UPDATE SKIP LOCKED` can legitimately skip a row another transaction
 * transiently holds and hand it to a LATER sweep instead — see
 * infra/postgres/tests/run-store.live.mjs › "a sweep skips an expired run
 * another transaction holds a row lock on, and the next sweep reclaims it".
 * Bounded work only: every call any attempt made is checked against `runId`
 * (a sweep reclaiming a DIFFERENT run would be this repetition claiming a
 * leftover, not proof of its own reclaim), and a run never freed fails
 * closed, naming `runId` and the attempt count, rather than waiting forever.
 */
async function sweepUntilReclaimed(store, runId, { attempts, delayMs }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const swept = await store.sweepExpired();
    for (const sweptRunId of swept) {
      assert.equal(sweptRunId, runId, `sweepUntilReclaimed swept a run other than its own: expected ${runId}, got ${sweptRunId}`);
    }
    if (swept.includes(runId)) {
      sweepAttemptsUsed.push(attempt);
      return swept;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`sweepUntilReclaimed: ${runId} was not reclaimed after ${attempts} attempts`);
}

/**
 * Moves `runId` to a terminal state (`failed`, with a `terminal_reason` that
 * names this cleanup) if — and only if — it is still `queued` or `running`,
 * so a leftover run from a failed or aborted repetition cannot be claimed or
 * swept by a LATER repetition sharing the same store/table (measured
 * directly at S1 rep 579: without this, `claimNext`'s oldest-first ordering
 * handed a later repetition the earlier repetition's own leftover run).
 * Clears `owner_worker_id`/`lease_expires_at` too, so the terminal row can
 * never look `running` again.
 */
async function abandonLeftoverRun(store, runId) {
  await store.pool.query(
    `update aic_app.runs
     set status = 'failed',
         terminal_reason = 'abandoned_by_t4_race_harness',
         owner_worker_id = NULL,
         lease_expires_at = NULL
     where run_id = $1
       and status in ('queued', 'running')`,
    [runId],
  );
}

const ORDERINGS = Object.freeze([
  'S1-released-before-B-claims',
  'S2-released-before-B-reads-thread',
  'S3-released-before-B-commit-resolves',
  'S4-released-before-B-post-commit-put',
  'S5-released-before-B-post-commit-putWrites',
  'S6-released-after-B-completes',
]);

/**
 * Runs one full T-4 repetition for `ordering` and returns everything the
 * matrix test asserts on. One connection pool per checkpointer, closed by
 * `t.after` — this file's own convention, matching the sibling live files.
 */
async function runOneRace(t, store, ordering) {
  const connectionString = requireConnectionString();
  const runId = `run-t4-${ordering}-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  // Registered before anything below can throw, so a repetition that fails
  // inside this function still leaves no run behind for a later repetition's
  // claimNext — see abandonLeftoverRun, and the row "a race that throws after
  // createRun leaves no run behind: ...".
  t.after(() => abandonLeftoverRun(store, runId));
  const testId = 't4-test';
  const tool = createAdversarialTool();

  // ---- Worker A: claims, commits for real, and is held at the FIRST put ----
  // ---- call dispatched after that commit has actually landed.          ----
  const claimA = await store.claimNext(`worker-t4-a-${randomUUID()}`);
  assert.equal(claimA.runId, runId, 'worker A must claim the run this repetition just created');
  const innerA = await persistence.createPostgresCheckpointer(connectionString);
  t.after(() => innerA.pool.end());
  const contextA = await persistence.openRunWriteContext(store, claimA);
  const { execution: signalledExecutionA, committedPromise: aCommittedPromise } = withCommitSignal(contextA);
  const aBarrier = deferredPromise();
  const aReachedBarrier = deferredPromise();
  const gatedInnerA = withHeldWritesAfterCommit(innerA, aCommittedPromise, aBarrier, aReachedBarrier);
  const trackedA = trackWrites(persistence.createFencedCheckpointer(gatedInnerA, contextA));
  const runnerA = createPersistentInvestigationRunner({
    checkpointer: trackedA.saver,
    execution: signalledExecutionA,
    executeInvestigation: tool.execute,
  });
  const aResultPromise = runnerA.start({ runId, test: { id: testId, tool: 'fixture-tool', input: {} } });
  // A's own outcome is not an invariant: when the held write is A's last, it
  // lands, the post-write recheck records the fork without failing the call,
  // and A's invoke resolves; when a later write is refused, it rejects. Which
  // write is held is itself a race under real I/O. The file waits for A to
  // settle and asserts on what A could not do — commit after B's claim — not
  // on which way A settled.
  const aSettled = aResultPromise.then(
    () => ({ outcome: 'resolved' }),
    (error) => ({ outcome: 'rejected', error }),
  );

  await aReachedBarrier.promise;

  // ---- Force-expire A's lease and sweep — no sleep: the lease is set to    ----
  // ---- already-expired before the sweep runs, exactly like the sibling    ----
  // ---- zombie-worker rows.                                                ----
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  await sweepUntilReclaimed(store, runId, { attempts: 20, delayMs: 25 });

  async function releaseAAndAwaitSettlement() {
    aBarrier.resolve();
    const settled = await aSettled;
    await trackedA.settled();
    return settled;
  }

  const claimB = await store.claimNext(`worker-t4-b-${randomUUID()}`);
  assert.equal(claimB.runId, runId);
  assert.equal(claimB.executionAttempt, 2, 'the takeover must be a second attempt');
  const claimBAtRow = (await store.pool.query('select clock_timestamp() as t')).rows[0].t;
  const innerB = await persistence.createPostgresCheckpointer(connectionString);
  t.after(() => innerB.pool.end());
  const contextB = await persistence.openRunWriteContext(store, claimB);

  let bResult;

  if (ordering === 'S2-released-before-B-reads-thread') {
    const bGates = createBGates('S2');
    const gatedInnerB = withBGatedReads(innerB, bGates);
    const fencedB = persistence.createFencedCheckpointer(gatedInnerB, contextB);
    const runnerB = createPersistentInvestigationRunner({
      checkpointer: fencedB,
      execution: contextB,
      executeInvestigation: tool.execute,
    });
    const bResultPromise = runnerB.resume({ runId });
    await bGates.reachedTarget;
    await releaseAAndAwaitSettlement();
    bGates.release();
    bResult = await bResultPromise;
  } else if (ordering === 'S3-released-before-B-commit-resolves') {
    const bGates = createBGates('S3');
    const gatedExecutionB = withBGatedExecution(contextB, bGates);
    const fencedB = persistence.createFencedCheckpointer(innerB, contextB);
    const runnerB = createPersistentInvestigationRunner({
      checkpointer: fencedB,
      execution: gatedExecutionB,
      executeInvestigation: tool.execute,
    });
    const bResultPromise = runnerB.resume({ runId });
    await bGates.reachedTarget;
    await releaseAAndAwaitSettlement();
    bGates.release();
    bResult = await bResultPromise;
  } else if (ordering === 'S4-released-before-B-post-commit-put') {
    // S4's target is the content-identified post-commit `put` (see
    // `withHeldPostCommitPut`'s own header for why content, not position).
    const bBarrier = deferredPromise();
    const bReachedBarrier = deferredPromise();
    const gatedInnerB = withHeldPostCommitPut(innerB, bBarrier, bReachedBarrier);
    const fencedB = persistence.createFencedCheckpointer(gatedInnerB, contextB);
    const runnerB = createPersistentInvestigationRunner({
      checkpointer: fencedB,
      execution: contextB,
      executeInvestigation: tool.execute,
    });
    const bResultPromise = runnerB.resume({ runId });
    await bReachedBarrier.promise;
    await releaseAAndAwaitSettlement();
    bBarrier.resolve();
    bResult = await bResultPromise;
  } else if (ordering === 'S5-released-before-B-post-commit-putWrites') {
    // S5's target is the content-identified post-commit `putWrites` (see
    // `withHeldPostCommitPutWrites`'s own header). This file does not claim
    // it dispatches strictly before or after S4's `put` — measured directly,
    // that relative order is itself a race under real I/O — only that it is
    // a second, independently-identifiable post-commit write.
    const bBarrier = deferredPromise();
    const bReachedBarrier = deferredPromise();
    const gatedInnerB = withHeldPostCommitPutWrites(innerB, bBarrier, bReachedBarrier);
    const fencedB = persistence.createFencedCheckpointer(gatedInnerB, contextB);
    const runnerB = createPersistentInvestigationRunner({
      checkpointer: fencedB,
      execution: contextB,
      executeInvestigation: tool.execute,
    });
    const bResultPromise = runnerB.resume({ runId });
    await bReachedBarrier.promise;
    await releaseAAndAwaitSettlement();
    bBarrier.resolve();
    bResult = await bResultPromise;
  } else if (ordering === 'S6-released-after-B-completes') {
    const fencedB = persistence.createFencedCheckpointer(innerB, contextB);
    const runnerB = createPersistentInvestigationRunner({
      checkpointer: fencedB,
      execution: contextB,
      executeInvestigation: tool.execute,
    });
    bResult = await runnerB.resume({ runId });
    await contextB.complete('t4-race');
    await releaseAAndAwaitSettlement();
    return { runId, testId, tool, claimA, claimBAtRow, bResult, store, connectionString };
  } else {
    throw new Error(`unknown ordering: ${ordering}`);
  }

  await contextB.complete('t4-race');
  return { runId, testId, tool, claimA, claimBAtRow, bResult, store, connectionString };
}

/**
 * S1 is structurally different from the other five (A is released BEFORE B
 * ever claims, so nothing about B needs to be pausable), which is why it gets
 * its own top-level function rather than a branch inside `runOneRace` that
 * would otherwise have to claim B before knowing whether to.
 */
async function runS1Race(t, store) {
  const connectionString = requireConnectionString();
  const ordering = 'S1-released-before-B-claims';
  const runId = `run-t4-${ordering}-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  // Registered before anything below can throw, so a repetition that fails
  // inside this function (S1 rep 579 failed at its sweep, here) still leaves
  // no run behind for a later repetition's claimNext — see abandonLeftoverRun,
  // and the row "a race that throws after createRun leaves no run behind: ...".
  t.after(() => abandonLeftoverRun(store, runId));
  const testId = 't4-test';
  const tool = createAdversarialTool();

  const claimA = await store.claimNext(`worker-t4-a-${randomUUID()}`);
  assert.equal(claimA.runId, runId);
  const innerA = await persistence.createPostgresCheckpointer(connectionString);
  t.after(() => innerA.pool.end());
  const contextA = await persistence.openRunWriteContext(store, claimA);
  const { execution: signalledExecutionA, committedPromise: aCommittedPromise } = withCommitSignal(contextA);
  const aBarrier = deferredPromise();
  const aReachedBarrier = deferredPromise();
  const gatedInnerA = withHeldWritesAfterCommit(innerA, aCommittedPromise, aBarrier, aReachedBarrier);
  const trackedA = trackWrites(persistence.createFencedCheckpointer(gatedInnerA, contextA));
  const runnerA = createPersistentInvestigationRunner({
    checkpointer: trackedA.saver,
    execution: signalledExecutionA,
    executeInvestigation: tool.execute,
  });
  const aResultPromise = runnerA.start({ runId, test: { id: testId, tool: 'fixture-tool', input: {} } });
  const aSettled = aResultPromise.then(
    () => ({ outcome: 'resolved' }),
    (error) => ({ outcome: 'rejected', error }),
  );

  await aReachedBarrier.promise;
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  await sweepUntilReclaimed(store, runId, { attempts: 20, delayMs: 25 });

  aBarrier.resolve();
  await aSettled;
  await trackedA.settled();

  const claimB = await store.claimNext(`worker-t4-b-${randomUUID()}`);
  assert.equal(claimB.runId, runId);
  assert.equal(claimB.executionAttempt, 2, 'the takeover must be a second attempt');
  const claimBAtRow = (await store.pool.query('select clock_timestamp() as t')).rows[0].t;
  const innerB = await persistence.createPostgresCheckpointer(connectionString);
  t.after(() => innerB.pool.end());
  const contextB = await persistence.openRunWriteContext(store, claimB);
  const fencedB = persistence.createFencedCheckpointer(innerB, contextB);
  const runnerB = createPersistentInvestigationRunner({
    checkpointer: fencedB,
    execution: contextB,
    executeInvestigation: tool.execute,
  });
  const bResult = await runnerB.resume({ runId });
  await contextB.complete('t4-race');

  return { runId, testId, tool, claimA, claimBAtRow, bResult, store, connectionString };
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* The two harness defects the first 2,000-repetition stress run exposed:   */
/* (1) both race functions asserted that the FIRST sweep reclaims the run;   */
/* (2) repetitions shared one store with no per-repetition cleanup, so a     */
/* leftover non-terminal run was claimed by the next repetition instead      */
/* -------------------------------------------------------------------------- */

/**
 * Rows for `sweepUntilReclaimed` (defined above; used by `runS1Race` and
 * `runOneRace`). In the first 2,000-repetition stress run, the first sweep at
 * S1 rep 579 returned `[]` for the run the harness had just expired, and rep
 * 580's sweep returned that run too; what, if anything, held the row at rep
 * 579 was not identified. A one-shot assertion on the first sweep assumed
 * more than `sweepExpired`'s `FOR UPDATE SKIP LOCKED` promises
 * (infra/postgres/tests/run-store.live.mjs › "a sweep skips an expired run
 * another transaction holds a row lock on, and the next sweep reclaims it").
 * These rows pin the bounded retry and its bounded, named failure.
 */

test("sweepUntilReclaimed retries until a lock-held run is reclaimed, and every run it swept is this repetition's own", async (t) => {
  const store = await freshStore(t);
  const runId = `run-t4-sweep-until-reclaimed-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext('worker-sweep-until-reclaimed');
  assert.equal(claim.runId, runId, 'this row must claim the run it just created, or it proves nothing about sweepUntilReclaimed');

  // A separate client holds FOR KEY SHARE on the row — the same conflicting
  // lock run-store.live.mjs's sibling row uses to force sweepExpired to skip
  // it — and releases it a short, bounded delay later.
  const lockClient = await store.pool.connect();

  // Released deterministically in this test's own finally, never through
  // t.after: freshStore's own t.after (registered first, inside freshStore)
  // calls store.close(), i.e. pool.end(), which waits for every checked-out
  // client — including this one — to be released first. Hooks run in
  // registration order, so a release queued after that one would never run:
  // pool.end() would hang waiting for a client only a LATER hook frees. Same
  // reasoning as run-store.live.mjs's own "claimNext skips a row..." row.
  // The client is released whether or not COMMIT succeeds, and a failed
  // COMMIT from the timer is awaited again in `finally`, so it fails this row
  // instead of leaving a checked-out client for pool.end() to wait on.
  let lockReleased = false;
  async function releaseLock() {
    if (lockReleased) return;
    lockReleased = true;
    try {
      await lockClient.query('commit');
    } finally {
      lockClient.release();
    }
  }
  let releaseTimer;
  let timerRelease;

  try {
    await lockClient.query('begin');
    const { rows: lockedRows } = await lockClient.query(
      'select run_id from aic_app.runs where run_id = $1 for key share',
      [runId],
    );
    assert.equal(lockedRows[0]?.run_id, runId, 'the test\'s own client must hold the lock before the lease is expired, or this row proves nothing');
    await store.pool.query(
      `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
      [runId],
    );
    releaseTimer = setTimeout(() => {
      timerRelease = releaseLock();
      // Handled here only so it is not reported as unhandled; `finally`
      // awaits the same promise and surfaces the failure.
      timerRelease.catch(() => {});
    }, 150);

    const swept = await sweepUntilReclaimed(store, runId, { attempts: 20, delayMs: 20 });
    assert.deepEqual(
      swept,
      [runId],
      `sweepUntilReclaimed must retry past the sweep(s) that skip the lock-held row and return exactly this repetition's runId once it is reclaimed, got ${JSON.stringify(swept)}`,
    );
  } finally {
    clearTimeout(releaseTimer);
    await releaseLock();
    if (timerRelease) await timerRelease;
  }
});

test('sweepUntilReclaimed fails after its bounded attempts, naming the run and the attempt count, when the lock is never released', async (t) => {
  const store = await freshStore(t);
  const runId = `run-t4-sweep-never-reclaimed-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext('worker-sweep-never-reclaimed');
  assert.equal(claim.runId, runId);

  // Rolled back in this test's own finally, never through t.after — see the
  // sibling row above's comment for why: freshStore's own t.after (registered
  // first) closes the pool, which would hang waiting for this very client if
  // its release were queued behind that hook instead of run before it.
  const lockClient = await store.pool.connect();

  try {
    await lockClient.query('begin');
    await lockClient.query('select run_id from aic_app.runs where run_id = $1 for key share', [runId]);
    await store.pool.query(
      `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
      [runId],
    );
    await assert.rejects(
      () => sweepUntilReclaimed(store, runId, { attempts: 3, delayMs: 10 }),
      (error) => {
        assert.match(
          error.message,
          new RegExp(runId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')),
          `sweepUntilReclaimed's failure must name the run it could not reclaim, got: ${error.message}`,
        );
        assert.match(
          error.message,
          /3 attempts?/,
          `sweepUntilReclaimed's failure must name how many attempts it made (bounded work, not an unbounded loop), got: ${error.message}`,
        );
        return true;
      },
      'sweepUntilReclaimed must fail closed after its bounded attempts budget when the lock is never released, rather than waiting forever',
    );
  } finally {
    try {
      await lockClient.query('rollback');
    } finally {
      lockClient.release();
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Isolation between repetitions: a leftover non-terminal run from an        */
/* abandoned repetition must not be the run a later repetition's claimNext   */
/* returns, nor appear in a later repetition's sweepExpired                  */
/* -------------------------------------------------------------------------- */

/**
 * `abandonLeftoverRun(store, runId)` — the per-repetition cleanup that
 * `runS1Race`/`runOneRace` register on the repetition subtest's `t.after`
 * right after `createRun`, so a
 * run left non-terminal by a failed or aborted repetition — whether still
 * `queued` or left `running` with an expired lease — cannot be claimed or
 * swept by a LATER repetition sharing the same store/table. Measured
 * directly: without this, `claimNext`'s oldest-first ordering hands a later
 * repetition the earlier repetition's own leftover run instead of the run it
 * just created: in the first 2,000-repetition stress run, rep 581 claimed rep
 * 579's run, and the matrix recorded 11,422 failed subtests, rep 579's own
 * included.
 */
test("a repetition that leaves its run non-terminal does not change which run the next repetition claims", async (t) => {
  const store = await freshStore(t);
  const leftoverRunning = `run-t4-leftover-running-${randomUUID()}`;
  const leftoverQueued = `run-t4-leftover-queued-${randomUUID()}`;
  await store.createRun({ runId: leftoverRunning, input: {} });
  await store.createRun({ runId: leftoverQueued, input: {} });

  await t.test('a repetition claims its run and is abandoned before it can finish', async (st) => {
    const claim = await store.claimNext('worker-abandoned-repetition');
    assert.equal(
      claim.runId,
      leftoverRunning,
      'this subtest must claim the run this outer test intends to leave running with an expired lease',
    );
    await store.pool.query(
      `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
      [leftoverRunning],
    );
    // The per-repetition cleanup the real matrix would register, so an
    // abandoned repetition's own run cannot outlive the subtest that created
    // it.
    st.after(() => abandonLeftoverRun(store, leftoverRunning));
  });

  // A second leftover, from an earlier repetition that never even reached
  // claimNext, cleaned up the same way but not through a subtest's own
  // t.after — the mechanism must terminalize a leftover run regardless of
  // which non-terminal status it was left in.
  await abandonLeftoverRun(store, leftoverQueued);

  const freshRunId = `run-t4-fresh-after-leftovers-${randomUUID()}`;
  await store.createRun({ runId: freshRunId, input: {} });

  const nextClaim = await store.claimNext('worker-after-leftovers');
  assert.equal(
    nextClaim?.runId,
    freshRunId,
    `claimNext must return this repetition's own freshly created run, not a leftover non-terminal run left behind by an earlier, abandoned repetition; got ${JSON.stringify(nextClaim)}`,
  );

  const swept = await store.sweepExpired();
  assert.deepEqual(
    swept,
    [],
    'sweepExpired must return nothing stale once every leftover run has been moved to a terminal state by the per-repetition cleanup',
  );
});

/**
 * The rep-579 failure path: a race function that throws after `createRun` —
 * S1 rep 579 threw inside `runS1Race`, at its sweep — must still have
 * registered `abandonLeftoverRun`, or its run outlives the repetition. Driven
 * with a stand-in `t` that only collects `after` hooks, and a store whose
 * `claimNext` throws, so each race function fails at its first step after
 * `createRun` without a real subtest failing this file.
 */
test('a race that throws after createRun leaves no run behind: runS1Race and runOneRace register abandonLeftoverRun before anything else can throw', async (t) => {
  const store = await freshStore(t);
  const races = [
    ['runS1Race', (fakeT, failingStore) => runS1Race(fakeT, failingStore)],
    ['runOneRace', (fakeT, failingStore) => runOneRace(fakeT, failingStore, 'S3-released-before-B-commit-resolves')],
  ];
  for (const [name, race] of races) {
    const hooks = [];
    const fakeT = { after: (hook) => { hooks.push(hook); } };
    let createdRunId;
    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'createRun') {
          return async (run) => {
            createdRunId = run.runId;
            return target.createRun(run);
          };
        }
        if (property === 'claimNext') {
          return async () => {
            throw new Error(`${name}: injected claimNext failure`);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await assert.rejects(() => race(fakeT, failingStore), new RegExp(`${name}: injected claimNext failure`));
    assert.ok(createdRunId, `${name} must have created its run before the injected failure, or this row proves nothing`);
    assert.equal((await store.getRun(createdRunId))?.status, 'queued', `${name}'s run must still be queued before its hooks run`);

    for (const hook of hooks) await hook();

    assert.equal(
      (await store.getRun(createdRunId))?.status,
      'failed',
      `${name} must register abandonLeftoverRun before anything after createRun can throw, so a repetition that fails inside it leaves no queued or running run for the next repetition to claim`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The T-4 matrix: S1-S6, T4_REPETITIONS each, all assertions (a)-(h)         */
/* -------------------------------------------------------------------------- */

test(
  'T-4: for every S1-S6 release point, a stale attempt-1 checkpoint write that lands after attempt 2 has claimed is a recorded checkpoint_fork, never a silent product divergence',
  // Scales with the stress count: measured ~155 ms per race, so a fixed cap
  // stopped a 2,000-repetition run long before it finished.
  { timeout: Math.max(600_000, REPETITIONS * ORDERINGS.length * 1_000) },
  async (t) => {
    await provisionCheckpointerSchema();
    const store = await freshStore(t);
    // Only this matrix's own reclaims: the sweepUntilReclaimed rows above
    // hold a lock on purpose and would skew the count.
    sweepAttemptsUsed.length = 0;
    t.after(() => {
      const max = sweepAttemptsUsed.reduce((a, b) => Math.max(a, b), 0);
      // eslint-disable-next-line no-console -- a stable prefix for the stress run to grep, like t4-window-ms.
      console.log(`t4-sweep-attempts ${percentiles(sweepAttemptsUsed)} max=${max}`);
    });

    const normalizedResults = [];
    const normalizedSnapshots = [];

    for (const ordering of ORDERINGS) {
      for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
        await t.test(`${ordering} rep ${repetition}/${REPETITIONS}`, async (st) => {
          const { runId, testId, tool, claimA, claimBAtRow, bResult, connectionString } =
            ordering === 'S1-released-before-B-claims'
              ? await runS1Race(st, store)
              : await runOneRace(st, store, ordering);

          const expectedExecKey = domain.buildExecKey('tool.trial', { runId, testId, trialAttempt: 1 });

          // (a) the adversarial tool was called exactly once in total.
          assert.equal(
            tool.callCount(),
            1,
            `the adversarial tool must have been called exactly once in total for ${ordering} rep ${repetition}, got ${tool.callCount()}`,
          );

          // (b) node_results has exactly one row for the key, produced_by_attempt = 1.
          const { rows: nodeResultRows } = await store.pool.query(
            'select produced_by_attempt, result_sha from aic_app.node_results where run_id = $1 and exec_key = $2',
            [runId, expectedExecKey],
          );
          assert.equal(nodeResultRows.length, 1, `exactly one node_results row may exist for ${ordering} rep ${repetition}`);
          assert.equal(Number(nodeResultRows[0].produced_by_attempt), 1, 'the committed row must have been produced by attempt 1 (worker A)');

          // (c) no aic_app row scoped to attempt 1 was written AFTER B's claim moment.
          for (const [table, attemptColumn] of [
            ['run_events', 'execution_attempt'],
            ['node_results', 'produced_by_attempt'],
          ]) {
            const { rows } = await store.pool.query(
              `select count(*)::int as n from aic_app.${table} where run_id = $1 and ${attemptColumn} = 1 and created_at > $2`,
              [runId, claimBAtRow],
            );
            assert.equal(
              rows[0].n,
              0,
              `no aic_app.${table} row for attempt 1 may have been written after B's claim (${ordering} rep ${repetition})`,
            );
          }

          // zero execution.integrity_violation events.
          const { rows: violationRows } = await store.pool.query(
            `select count(*)::int as n from aic_app.run_events where run_id = $1 and type = 'execution.integrity_violation'`,
            [runId],
          );
          assert.equal(violationRows[0].n, 0, `zero execution.integrity_violation events expected for ${ordering} rep ${repetition}`);

          // (d) B reaches completed.
          const run = await store.getRun(runId);
          assert.equal(run.status, 'completed', `the run must be completed after B's takeover (${ordering} rep ${repetition})`);

          // Regression pin for the resumed Trial/Evidence identity (the ids are
          // derived with production's own functions, so this pins, not proves).
          const expectedTrialId = deriveTrialId({ runId, testId, attempt: 1 });
          const expectedEvidenceId = deriveEvidenceId({ trialId: expectedTrialId, payloadFingerprint: 't4-race-call-1' });
          assert.equal(bResult.trials[0]?.id, expectedTrialId, `the resumed trial id must match the independently-derived id (${ordering} rep ${repetition})`);
          assert.equal(bResult.evidence[0]?.id, expectedEvidenceId, `the resumed evidence id must match the independently-derived id (${ordering} rep ${repetition})`);

          // (e) byte-identical resumed result across orderings/repetitions, once normalized.
          normalizedResults.push({ ordering, repetition, value: normalizeResult(bResult) });

          // (f) byte-identical product snapshot across orderings/repetitions,
          // once normalized — CORE fields always; the full event sequence
          // only among S2-S6 (see normalizeSnapshotEvents's own header for
          // why S1 structurally cannot match those: it has no
          // node_result.reused event).
          const snapshot = await persistence.readRunProductSnapshot(store, runId);
          normalizedSnapshots.push({
            ordering,
            repetition,
            core: normalizeSnapshotCore(snapshot),
            events: normalizeSnapshotEvents(snapshot),
          });
          // Not deterministic across repetitions OR orderings, measured
          // directly: A's shared post-commit gate
          // (`withHeldWritesAfterCommit`) releases whichever single write was
          // dispatched first once the commit landed, and (this file's
          // header, point 2) that can be EITHER the checkpoint that already
          // carries the completed Trial or an earlier one that does not —
          // affecting whatever B does next regardless of which S-point is
          // being driven, not only S1. Both shapes below are legitimate: with
          // the full checkpoint already visible, B's resume needs no
          // `node_result.reused`; otherwise it does. So this file validates
          // each run's OWN event shape (one of exactly these two) rather than
          // asserting the full event log is identical across orderings —
          // see the aggregate check after the loop for what IS asserted
          // identical (the core product fields).
          const eventTypes = normalizeSnapshotEvents(snapshot).map((event) => event.type);
          const isAlreadyComplete = eventTypes.length === 2;
          assert.deepEqual(
            eventTypes,
            isAlreadyComplete
              ? ['node_result.committed', 'run.completed']
              : ['node_result.committed', 'node_result.reused', 'run.completed'],
            `${ordering} rep ${repetition}'s event shape must be one of the two legitimate outcomes above, got: ${JSON.stringify(eventTypes)}`,
          );

          // (g) a checkpoint_fork was recorded for A's attempt, and NEVER for B's.
          const { rows: forkRowsA } = await store.pool.query(
            `select 1 from aic_app.fence_rejections where run_id = $1 and owner_worker_id = $2 and execution_attempt = 1 and kind = 'checkpoint_fork'`,
            [runId, claimA.ownerWorkerId],
          );
          assert.ok(
            forkRowsA.length > 0,
            `a checkpoint_fork must be recorded for A's attempt in ${ordering} rep ${repetition}: A's held put landed strictly after the sweep in every ordering this file drives`,
          );
          const { rows: forkRowsAnyB } = await store.pool.query(
            `select 1 from aic_app.fence_rejections where run_id = $1 and execution_attempt = 2 and kind = 'checkpoint_fork'`,
            [runId],
          );
          assert.equal(forkRowsAnyB.length, 0, `B, the valid owner, must never have a checkpoint_fork recorded against it (${ordering} rep ${repetition})`);

          // (h) pruneTerminalRun with an UNFENCED saver leaves the snapshot unchanged.
          const snapshotBefore = await persistence.readRunProductSnapshot(store, runId);
          const beforePrune = { core: normalizeSnapshotCore(snapshotBefore), events: normalizeSnapshotEvents(snapshotBefore) };
          const unfencedSaver = await persistence.createPostgresCheckpointer(connectionString);
          st.after(() => unfencedSaver.pool.end());
          await persistence.pruneTerminalRun(store, runId, { checkpointer: unfencedSaver });
          const snapshotAfter = await persistence.readRunProductSnapshot(store, runId);
          const afterPrune = { core: normalizeSnapshotCore(snapshotAfter), events: normalizeSnapshotEvents(snapshotAfter) };
          assert.deepEqual(afterPrune, beforePrune, `pruneTerminalRun must not change the product snapshot (${ordering} rep ${repetition})`);
        });
      }
    }

    // (e)/(f), across EVERY ordering and repetition at once.
    const [firstResult, ...restResults] = normalizedResults;
    for (const entry of restResults) {
      assert.deepEqual(
        entry.value,
        firstResult.value,
        `the resumed result for ${entry.ordering} rep ${entry.repetition} must be byte-identical (after normalization) to ${firstResult.ordering} rep ${firstResult.repetition}`,
      );
    }
    const [firstSnapshot, ...restSnapshots] = normalizedSnapshots;
    for (const entry of restSnapshots) {
      assert.deepEqual(
        entry.core,
        firstSnapshot.core,
        `the product snapshot's core fields (status, terminal reason, trials, evidence) for ${entry.ordering} rep ${entry.repetition} must be byte-identical (after normalization) to ${firstSnapshot.ordering} rep ${firstSnapshot.repetition}`,
      );
    }
    // The full event sequence is NOT compared across orderings/repetitions —
    // see normalizeSnapshotEvents's own header: which of the two legitimate
    // event shapes a given run lands on is a genuine race independent of
    // which S-point is being driven, validated per-run inside the loop
    // above instead. `entry.events` is kept on each pushed record for a
    // future reader who wants to inspect it, even though nothing here
    // asserts equality across records with it.
  },
);

/* -------------------------------------------------------------------------- */
/* Measurement only: the natural window between A's fence check and A's      */
/* inner write, when NOT held by the barrier — no assertion on its value     */
/* -------------------------------------------------------------------------- */

test('measures the natural window between the fence check and the inner write, unheld — prints p50/p99, asserts nothing about the value', async (t) => {
  await provisionCheckpointerSchema();
  const store = await freshStore(t);
  const connectionString = requireConnectionString();

  const windowsMs = [];
  const landedWindowsMs = [];
  const sampleCount = Math.min(REPETITIONS, 50);

  for (let i = 0; i < sampleCount; i += 1) {
    const runId = `run-t4-window-${randomUUID()}`;
    await store.createRun({ runId, input: {} });
    const claim = await store.claimNext(`worker-t4-window-${randomUUID()}`);
    assert.equal(claim.runId, runId);

    const inner = await persistence.createPostgresCheckpointer(connectionString);
    const realContext = await persistence.openRunWriteContext(store, claim);

    let fenceResolvedAt;
    const timedContext = {
      ...realContext,
      async assertOwner(kind) {
        const result = await realContext.assertOwner(kind);
        fenceResolvedAt = performance.now();
        return result;
      },
    };
    const timedInner = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'put' && fenceResolvedAt !== undefined) {
          return async function (...args) {
            const fenceAt = fenceResolvedAt;
            const writeStartedAt = performance.now();
            windowsMs.push(writeStartedAt - fenceAt);
            const result = await value.apply(target, args);
            // The exposure window ends when the write has landed, not when it
            // was dispatched: a lease lost anywhere before this point makes the
            // write a fork, which is what the post-write recheck records.
            landedWindowsMs.push(performance.now() - fenceAt);
            return result;
          };
        }
        return value;
      },
    });

    const fenced = persistence.createFencedCheckpointer(timedInner, timedContext);
    const runner = createPersistentInvestigationRunner({
      checkpointer: fenced,
      execution: realContext,
      executeInvestigation: async () => ({
        trial: { status: 'ok', durationMs: 1 },
        evidence: {
          kind: 'log',
          source: 'fixture-tool',
          observedAt: '2026-09-24T00:00:00.000Z',
          statement: 't4-race window measurement',
          rawRef: 'fixture://t4-race/window',
          reliability: 'high',
        },
        payloadFingerprint: 't4-race-window-v1',
      }),
    });
    try {
      await runner.start({ runId, test: { id: 't4-window-test', tool: 'fixture-tool', input: {} } });
      await realContext.complete('t4-race-window');
    } finally {
      // Closed per sample: registered on the test's own t.after, every
      // sample's pool stayed open until the test ended and the samples ran
      // PostgreSQL out of connections ('too many clients already').
      await inner.pool.end();
    }
  }

  // eslint-disable-next-line no-console -- the stable prefixes this file's header documents, for the stress run to grep.
  console.log(`t4-window-ms dispatch ${percentiles(windowsMs)}`);
  // eslint-disable-next-line no-console -- the exposure window the ADR records: fence resolved -> write landed.
  console.log(`t4-window-ms landed ${percentiles(landedWindowsMs)}`);
  assert.ok(windowsMs.length > 0 && landedWindowsMs.length === windowsMs.length, 'every window sample must have both series recorded');
});

/* -------------------------------------------------------------------------- */
/* percentiles must report an empty sample explicitly, never NaN/undefined   */
/* -------------------------------------------------------------------------- */

/**
 * `percentiles` (module scope, shared with the window-measurement test above)
 * indexes a sorted copy of its samples; for an empty sample that index is
 * `undefined`, so it reports `n=0` explicitly instead of throwing on
 * `.toFixed` or printing `NaN`/`undefined` into a line this file's header
 * documents as greppable for the stress run.
 */
test('percentiles reports n=0 explicitly for an empty sample, never NaN or undefined', () => {
  const report = percentiles([]);
  assert.doesNotMatch(
    String(report),
    /NaN|undefined/,
    `percentiles([]) must not print NaN or undefined for an empty sample, got ${JSON.stringify(report)}`,
  );
  assert.match(
    String(report),
    /\bn=0\b/,
    `percentiles([]) must explicitly report n=0 for an empty sample, got ${JSON.stringify(report)}`,
  );
});

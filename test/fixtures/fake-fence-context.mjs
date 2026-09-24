/**
 * AIC-56 slice E: an in-memory stand-in for the fencing "context" a
 * `FencedCheckpointer` checks before every write — the ordinary-suite
 * equivalent of a `@aic/persistence` `RunWriteContext`, the way
 * `fake-committed-execution.mjs` stands in for `CommittedExecution`.
 *
 * Deliberately the narrowest shape the spec names: `{ assertOwner() }`. A
 * `FencedCheckpointer` is expected to call `assertOwner()` before delegating
 * a write to the inner saver — resolving means the fence passed, rejecting
 * (with `@aic/domain`'s `StaleOwnerError`, the same error a real
 * `RunWriteContext.assertOwner()` throws — see
 * `test/run-write-context.test.mjs` and
 * `infra/postgres/tests/run-write-context.live.mjs`'s "a context whose lease
 * merely expired…" row) means it must refuse.
 *
 * `calls` records the `kind` argument of every `assertOwner(kind)` invocation,
 * in order — the fake's only observability, and enough for a test to assert
 * whether the fence ran at all, which `kind` it ran under (a real
 * `RunWriteContext.assertOwner` defaults `kind` to `'assertOwner'` too, so a
 * bare `assertOwner()` call still pushes that same default here), and (via
 * `onAssertOwner`) to place it inside a shared ordering log alongside
 * `beforeWrite` and the inner saver's own calls.
 *
 * AIC-57 slice (a) added `failOnCall` and `rejectedKinds`: the fork-detection
 * design this fixture stands in for (see test/fenced-checkpointer.test.mjs'
 * "AIC-57 slice (a) — fork detection" section) re-checks ownership by calling
 * `assertOwner('checkpoint_fork')` a SECOND time, after a write has already
 * landed — so a test needs a fence that PASSES on an earlier call and FAILS
 * on a specific later one, and a way to observe exactly which call failed
 * without inferring it from a shared side-effecting log.
 *
 * Callers: test/fenced-checkpointer.test.mjs.
 */
import { StaleOwnerError } from '@aic/domain';

/**
 * @param {object} [config]
 * @param {boolean} [config.fails] When true, every `assertOwner()` call
 *   rejects with `StaleOwnerError` — standing in for a lease this claim no
 *   longer holds.
 * @param {number} [config.failOnCall] When set, only the call whose 1-indexed
 *   position across this fake's whole lifetime equals `failOnCall` rejects;
 *   every other call passes. Lets a test build a fence that holds for an
 *   initial pre-write check and then turns stale for exactly one later
 *   (typically post-write) check, without `fails: true`'s all-or-nothing
 *   behaviour. Ignored when `fails` is true.
 * @param {(kind: string) => void} [config.onAssertOwner] Called synchronously
 *   on every `assertOwner(kind)` invocation, with that call's `kind`, before
 *   it resolves or rejects — the seam a test uses to interleave the fence
 *   into a shared ordering log.
 */
export function createFakeFenceContext({ fails = false, failOnCall, onAssertOwner } = {}) {
  const calls = [];
  const rejectedKinds = [];
  let callCount = 0;

  return {
    /** Every `assertOwner(kind)` call's `kind`, in order. */
    calls,
    /**
     * The `kind` of every call that actually rejected — the fake's stand-in
     * for the durable `fence_rejections` row a real `RunWriteContext`
     * records for the same call (`run-write-context.ts`'s
     * `recordRejectionAndThrow`): a rejected call IS the recording.
     */
    rejectedKinds,

    async assertOwner(kind = 'assertOwner') {
      callCount += 1;
      calls.push(kind);
      onAssertOwner?.(kind);
      if (fails || callCount === failOnCall) {
        rejectedKinds.push(kind);
        throw new StaleOwnerError(
          'the fake fence context was configured to refuse: this claim no longer holds a valid running lease',
        );
      }
    },
  };
}

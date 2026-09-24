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
 * `calls` records every `assertOwner()` invocation, in order — the fake's
 * only observability, and enough for a test to assert whether the fence ran
 * at all, and (via `onAssertOwner`) to place it inside a shared ordering log
 * alongside `beforeWrite` and the inner saver's own calls.
 *
 * Callers: test/fenced-checkpointer.test.mjs.
 */
import { StaleOwnerError } from '@aic/domain';

/**
 * @param {object} [config]
 * @param {boolean} [config.fails] When true, every `assertOwner()` call
 *   rejects with `StaleOwnerError` — standing in for a lease this claim no
 *   longer holds.
 * @param {() => void} [config.onAssertOwner] Called synchronously on every
 *   `assertOwner()` invocation, before it resolves or rejects — the seam a
 *   test uses to interleave the fence into a shared ordering log.
 */
export function createFakeFenceContext({ fails = false, onAssertOwner } = {}) {
  const calls = [];

  return {
    /** Every `assertOwner()` call, in order — the fake's only observability. */
    calls,

    async assertOwner() {
      calls.push('assertOwner');
      onAssertOwner?.();
      if (fails) {
        throw new StaleOwnerError(
          'the fake fence context was configured to refuse: this claim no longer holds a valid running lease',
        );
      }
    },
  };
}

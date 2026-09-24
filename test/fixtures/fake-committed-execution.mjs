/**
 * AIC-56 slice D1: an in-memory stand-in for the `CommittedExecution` port
 * (`@aic/domain`), which a real `@aic/persistence` `RunWriteContext` also
 * satisfies. It implements exactly the semantics
 * `docs/decisions/durable-run-execution.md` decisions 5-8 ask of a real one:
 * the SAME `execKey` commits its result at most once, and every later call
 * for that key returns the already-stored value without calling `compute`
 * again - the replay half of the acceptance this slice proves for the tool
 * half on `createPersistentInvestigationRunner`.
 *
 * Deliberately NOT a copy of `@aic/persistence`'s fencing, integrity or
 * projection-table protocol: this fixture only needs to stand in for the
 * PORT (`committed(execKey, compute, options?)`), the same way the real,
 * database-backed half of this behaviour is proven separately, against a
 * real `RunWriteContext`, in
 * `infra/postgres/tests/durable-tool-replay.live.mjs`.
 *
 * See test/durable-tool-replay.test.mjs, this fixture's one caller.
 */

/**
 * @param {object} [config]
 * @param {boolean} [config.crashAfterFirstCommit] When true, the FIRST time
 *   this store commits a brand-new result (`compute()` just ran, the key was
 *   not already present) it throws a sentinel error instead of returning -
 *   simulating a process death after the result transaction has already
 *   landed durably (it is already in `store` by the time this throws) and
 *   before the caller - the graph node - can return control to LangGraph for
 *   its own checkpoint write. Armed exactly ONCE: a later commit of a
 *   different new key, or a later replay of the SAME key, must not crash
 *   again - matching a real crash, which does not recur on every future
 *   commit once the process has actually restarted.
 */
export function createFakeCommittedExecution({ crashAfterFirstCommit = false } = {}) {
  const store = new Map();
  const calls = [];
  const projectionCalls = [];
  let crashArmed = crashAfterFirstCommit;

  return {
    /** execKey -> the value `compute()` produced when it was first committed. */
    store,
    /** Every execKey this store's `committed` was called with, in call order. */
    calls,
    /** One entry per NEW commit: `{ execKey, result, projection }`. */
    projectionCalls,

    async committed(execKey, compute, options = {}) {
      calls.push(execKey);

      if (store.has(execKey)) {
        return store.get(execKey);
      }

      const result = await compute();
      store.set(execKey, result);

      if (typeof options.project === 'function') {
        const projection = options.project(result);
        projectionCalls.push({ execKey, result, projection });
      }

      if (crashArmed) {
        crashArmed = false;
        throw new Error(`SIMULATED_CRASH_AFTER_COMMIT:${execKey}`);
      }

      return result;
    },
  };
}

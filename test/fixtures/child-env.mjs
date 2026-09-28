/**
 * AIC-126 slice a: the one implementation lives in `scripts/lib/child-env.mjs`
 * now — the canonical location a script under `scripts/` can import without
 * reaching into `test/`. This file re-exports it rather than declaring a
 * second copy (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation"), so every existing import of
 * `test/fixtures/child-env.mjs` keeps working unchanged.
 *
 * The behaviour asserted of `childEnv`, and the audit that keeps every spawn
 * site using it, are in `test/child-process-environment.test.mjs`.
 */
export { childEnv } from '../../scripts/lib/child-env.mjs';

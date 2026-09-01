/**
 * The environment a spawned child process gets, as an ALLOW-LIST.
 *
 * A deny-list over a copy of `process.env` was the previous shape and it leaked:
 * it named eight variables while the SDK reads many more, and
 * `LANGSMITH_RUNS_ENDPOINTS` is the one that costs. In its array form the SDK
 * skips the endpoint-conflict check entirely, so a developer who exports write
 * replicas would have this suite replicate its runs into their real workspace
 * under their real key. An allow-list cannot acquire that failure by the SDK
 * gaining a variable.
 *
 * INHERITING the ambient environment — passing no `env` at all — is the same
 * defect with none of the deny-list's cover. It cost `npm run check` a 3/200 red
 * run in a shell that exported `LANGSMITH_TRACING`: the spawned CLI enabled
 * tracing, performed real network I/O, and blew a spawn timeout that a re-run
 * then hid. `.claude/rules/autonomy.md` ("Flaky ≠ retry") makes that a defect to
 * fix rather than to re-run.
 *
 * `PATH` and `HOME` are what node, npm, git and tsc themselves need; `NODE_*` is
 * passed through so a runner's node options survive. Everything else must be
 * named by the caller, and an override replaces rather than merges.
 *
 * The behaviour asserted of this fixture, and the audit that keeps every spawn
 * site using it, are in `test/child-process-environment.test.mjs`.
 */
export function childEnv(overrides) {
  const env = {};
  for (const name of ['PATH', 'HOME']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('NODE_') && value !== undefined) env[name] = value;
  }
  return { ...env, ...overrides };
}

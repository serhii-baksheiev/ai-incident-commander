/**
 * AIC-99 slice e: `runSourceCheckCommand(argv, deps)`
 * (`apps/cli/src/commands/source-check.ts`) — the `aic source check <service>
 * <env> [<binding>]` behaviour `.claude/runs/20260929-aic99e/design.md` pins:
 * for every `SourceBinding` in scope, build it through `@aic/tools`'s
 * `createEvidenceSourceForBinding` and `check()` it, classify the result into
 * one of six closed words, and write exactly one JSON line per binding to
 * `deps.stdout`.
 *
 * No database and no network here: `deps.store` is a fake whose `snapshot()`
 * resolves a plain `RegistrySnapshot`-shaped object, and every row builds its
 * own fake `fetch` — the same isolation
 * test/cli-registry-commands.test.mjs's header states for
 * `runRegistryCommand`.
 *
 * ## Design this file pins (the task brief leaves the exact module/shape
 * open; this is the contract picked and pinned here)
 *
 *   - `argv` is `[serviceName, environmentName, bindingName?]` — the same
 *     "noun's own remainder" convention `apps/cli/src/commands/registry.ts`
 *     already documents.
 *   - `deps`: `{ store: { snapshot(): Promise<RegistrySnapshot> },
 *     resolveSecret: (secretName) => Promise<ResolveSecretResult>, fetch?,
 *     stdout: (text) => void }`.
 *   - the command returns `{ allReady: boolean }` rather than touching
 *     `process.exitCode` itself — the CLI entrypoint (untouched by this
 *     slice) decides the process exit code from that return value, the same
 *     separation `runRegistryCommand` keeps from `apps/cli/src/index.ts`'s
 *     own top-level catch.
 *   - one stdout JSON line per binding in scope:
 *     `{ service, environment, binding, status, reason? }`, where `service`
 *     and `environment` always echo the given argv strings and `binding` is
 *     the `SourceBinding.name` (or `null` for the summary row emitted when no
 *     concrete binding is in scope at all — see the "absent" rows below).
 *   - classification: `ready` (check() -> ready); `denied` (check() ->
 *     refused denied); `unreachable` (check() -> refused
 *     unavailable/timeout, OR check() throws); `error` (check() -> refused
 *     with any other reason, e.g. rate_limited or budget_exceeded — that
 *     reason is named on the row); `absent` (no such service / environment /
 *     named binding, no bindings at all in the environment, or the factory
 *     refused secret-absent); `misconfigured` (every other factory refusal —
 *     unsupported-adapter, invalid-config, missing-credential,
 *     credential-not-read, secret-unreadable — named on the row).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

function loadSourceCheckCommand() {
  return import('../apps/cli/dist/commands/source-check.js');
}

const secretName = (...parts) => parts.join('_');
const OWNER = 'octo-owner';
const REPO = 'octo-repo';

// All-letters, so guard-secret-file's assigned-secret arm (which rejects an
// all-letters captured value) never reads this fixture as a real credential.
const resolvedSecretValue = 'sourcecheckfixturesecretvaluemarker';

function makeService(overrides = {}) {
  return { id: randomUUID(), name: 'checkout', repositoryAliases: [], ...overrides };
}

function makeEnvironment(serviceId, overrides = {}) {
  return { id: randomUUID(), serviceId, name: 'staging', ...overrides };
}

function makeCredentialRef(environmentId, overrides = {}) {
  return {
    id: randomUUID(),
    environmentId,
    access: 'read',
    name: 'github-read',
    secretName: secretName('GITHUB', 'READ', 'TOKEN'),
    ...overrides,
  };
}

function makeBinding(environmentId, overrides = {}) {
  return {
    id: randomUUID(),
    environmentId,
    adapterId: 'lab',
    adapterVersion: '1',
    name: 'lab-primary',
    config: { baseUrl: 'https://lab.example.test' },
    credentialRefId: null,
    ...overrides,
  };
}

function makeRegistry({ services = [], environments = [], sourceBindings = [], credentialRefs = [], actionPolicies = [] } = {}) {
  return { services, environments, sourceBindings, credentialRefs, actionPolicies };
}

function fakeStore(snapshot) {
  return { snapshot: async () => snapshot };
}

function neverResolveSecret() {
  throw new Error('SOURCE_CHECK_MUST_NOT_RESOLVE_A_SECRET_FOR_THIS_ROW');
}

function fixedResolveSecret(result) {
  return async () => result;
}

function createStdoutSink() {
  const lines = [];
  return {
    stdout: (text) => lines.push(text),
    lines,
    rows: () => lines.map((line) => JSON.parse(line)),
  };
}

/** A fake fetch answering every GET with a fixed HTTP status (lab@1's /health check). */
function labFetchAnswering(status) {
  return async () => new Response('', { status });
}

/** A fake fetch whose call always rejects — simulates a connection failure (e.g. ECONNREFUSED). */
function rejectingFetch() {
  return async () => {
    throw new Error('SIMULATED_CONNECTION_FAILURE');
  };
}

/** Enough of a fake fetch for github@1's check() to answer ready. */
function readyGithubFetch() {
  return async (url) => {
    if (url.pathname === `/repos/${OWNER}/${REPO}`) {
      return new Response('{}', {
        status: 200,
        headers: { 'github-authentication-token-expiration': '2099-01-01T00:00:00Z' },
      });
    }
    return new Response('', { status: 404 });
  };
}

test('exports runSourceCheckCommand', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  assert.equal(
    typeof runSourceCheckCommand,
    'function',
    'apps/cli/src/commands/source-check.ts must export runSourceCheckCommand(argv, deps): Promise<{ allReady: boolean }> (AIC-99 slice e)',
  );
});

test('classifies a lab@1 binding ready when its check() succeeds, and the returned summary reports allReady true', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(200),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'ready' },
  ]);
  assert.equal(summary.allReady, true);
});

test('classifies a binding denied when check() refuses denied', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(401),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'denied' },
  ]);
  assert.equal(summary.allReady, false);
});

test('classifies a binding unreachable when check() refuses unavailable', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(500),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'unreachable' },
  ]);
  assert.equal(summary.allReady, false);
});

test('classifies a binding unreachable when check() throws (a rejecting fetch simulating a connection failure)', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: rejectingFetch(),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'unreachable' },
  ]);
  assert.equal(summary.allReady, false);
});

test('classifies a binding error, naming the refusal reason, for a refusal that is neither denied nor unreachable (429 -> rate_limited)', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(429),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'error', reason: 'rate_limited' },
  ]);
  assert.equal(summary.allReady, false);
});

test('classifies a binding misconfigured, naming invalid-config, when its config is missing a required key', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id, { config: {} });
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'misconfigured', reason: 'invalid-config' },
  ]);
  assert.equal(summary.allReady, false);
});

test('classifies a binding absent, naming no reason, when its credential’s secret file is absent (a github@1 binding whose secret was never installed)', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const credentialRef = makeCredentialRef(environment.id);
  const binding = makeBinding(environment.id, {
    adapterId: 'github',
    adapterVersion: '1',
    name: 'github-primary',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: credentialRef.id,
  });
  const registry = makeRegistry({
    services: [service],
    environments: [environment],
    sourceBindings: [binding],
    credentialRefs: [credentialRef],
  });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: fixedResolveSecret({ status: 'absent' }),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'absent' },
  ]);
  assert.equal(summary.allReady, false);
});

test('classifies a binding misconfigured, naming secret-unreadable, when its credential’s secret file is unreadable', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const credentialRef = makeCredentialRef(environment.id);
  const binding = makeBinding(environment.id, {
    adapterId: 'github',
    adapterVersion: '1',
    name: 'github-primary',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: credentialRef.id,
  });
  const registry = makeRegistry({
    services: [service],
    environments: [environment],
    sourceBindings: [binding],
    credentialRefs: [credentialRef],
  });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: fixedResolveSecret({ status: 'unreadable' }),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: binding.name, status: 'misconfigured', reason: 'secret-unreadable' },
  ]);
  assert.equal(summary.allReady, false);
});

test('reports one absent row naming no binding when the environment has no bindings at all', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const registry = makeRegistry({ services: [service], environments: [environment] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: null, status: 'absent' },
  ]);
  assert.equal(summary.allReady, false);
});

test('reports one absent row naming no binding when the given service is unknown', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const registry = makeRegistry();
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand(['no-such-service', 'staging'], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: 'no-such-service', environment: 'staging', binding: null, status: 'absent' },
  ]);
  assert.equal(summary.allReady, false);
});

test('reports one absent row naming no binding when the given environment is unknown for a known service', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const registry = makeRegistry({ services: [service] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, 'no-such-environment'], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: 'no-such-environment', binding: null, status: 'absent' },
  ]);
  assert.equal(summary.allReady, false);
});

test('reports one absent row naming the given binding when a specific binding name does not exist in the environment', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name, 'no-such-binding'], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: 'no-such-binding', status: 'absent' },
  ]);
  assert.equal(summary.allReady, false);
});

test('checks every binding in the environment when no specific binding is named, and the summary is allReady false when any of them is not ready', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const readyBinding = makeBinding(environment.id, { name: 'lab-a', config: { baseUrl: 'https://a.example.test' } });
  const deniedBinding = makeBinding(environment.id, { name: 'lab-b', config: { baseUrl: 'https://b.example.test' } });
  const registry = makeRegistry({
    services: [service],
    environments: [environment],
    sourceBindings: [readyBinding, deniedBinding],
  });
  const sink = createStdoutSink();
  const statusByBaseUrl = { 'https://a.example.test': 200, 'https://b.example.test': 403 };

  const summary = await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: async (url, init) => new Response('', { status: statusByBaseUrl[url.origin] ?? 500 }),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: readyBinding.name, status: 'ready' },
    { service: service.name, environment: environment.name, binding: deniedBinding.name, status: 'denied' },
  ]);
  assert.equal(summary.allReady, false);
});

test('checks only the named binding when a specific binding is given, and never resolves the other bindings’ secrets', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const targetBinding = makeBinding(environment.id, { name: 'lab-target' });
  const otherCredential = makeCredentialRef(environment.id, { name: 'other-read' });
  const otherBinding = makeBinding(environment.id, {
    name: 'github-other',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: otherCredential.id,
  });
  const registry = makeRegistry({
    services: [service],
    environments: [environment],
    sourceBindings: [targetBinding, otherBinding],
    credentialRefs: [otherCredential],
  });
  const sink = createStdoutSink();

  const summary = await runSourceCheckCommand([service.name, environment.name, targetBinding.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(200),
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: service.name, environment: environment.name, binding: targetBinding.name, status: 'ready' },
  ]);
  assert.equal(summary.allReady, true);
});

test('never writes a resolved secret value into any JSON line', async () => {
  const { runSourceCheckCommand } = await loadSourceCheckCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const credentialRef = makeCredentialRef(environment.id);
  const binding = makeBinding(environment.id, {
    adapterId: 'github',
    adapterVersion: '1',
    name: 'github-primary',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: credentialRef.id,
  });
  const registry = makeRegistry({
    services: [service],
    environments: [environment],
    sourceBindings: [binding],
    credentialRefs: [credentialRef],
  });
  const sink = createStdoutSink();

  await runSourceCheckCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: fixedResolveSecret({ status: 'found', value: resolvedSecretValue }),
    fetch: readyGithubFetch(),
    stdout: sink.stdout,
  });

  for (const line of sink.lines) {
    assert.doesNotMatch(line, new RegExp(resolvedSecretValue));
  }
});

test('source check with no service or environment is refused naming the missing argument, before the registry is read', async () => {
  const { runSourceCheckCommand } = await import('../apps/cli/dist/commands/source-check.js');
  for (const argv of [[], ['checkout']]) {
    let snapshotCalls = 0;
    const lines = [];
    await assert.rejects(
      () =>
        runSourceCheckCommand(argv, {
          store: { snapshot: async () => { snapshotCalls += 1; return { services: [], environments: [], sourceBindings: [], credentialRefs: [], actionPolicies: [] }; } },
          resolveSecret: async () => ({ status: 'absent' }),
          stdout: (text) => lines.push(text),
        }),
      /missing required argument/,
    );
    assert.equal(snapshotCalls, 0, `argv ${JSON.stringify(argv)} must not read the registry`);
    assert.equal(lines.length, 0);
  }
});

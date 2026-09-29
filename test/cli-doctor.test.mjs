/**
 * AIC-99 slice e: `runDoctorCommand(argv, deps)`
 * (`apps/cli/src/commands/doctor.ts`) — the `aic doctor [<service>
 * [<environment>]]` behaviour `.claude/runs/20260929-aic99e/design.md` pins:
 * for every Environment in scope, report whether an `ActionPolicy` exists
 * (informational) and classify every `SourceBinding` exactly as
 * `runSourceCheckCommand` does (test/cli-source-check.test.mjs) — reusing
 * the same closed classification words rather than inventing a second
 * vocabulary (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation").
 *
 * ## Design this file pins
 *
 *   - `argv` is `[serviceName?, environmentName?]`; with neither given,
 *     every Environment of every Service in the registry snapshot is in
 *     scope, in snapshot order.
 *   - `deps` is the same shape `runSourceCheckCommand` takes: `{ store:
 *     { snapshot(): Promise<RegistrySnapshot> }, resolveSecret, fetch?,
 *     stdout }`.
 *   - per Environment in scope, doctor writes exactly one informational row
 *     `{ service, environment, actionPolicy: boolean }` — never a `status`
 *     or `binding` key, so it cannot be mistaken for a per-binding row —
 *     followed by exactly the per-binding rows
 *     `runSourceCheckCommand([service, environment], ...)` would write for
 *     that same Environment (including the `binding: null, status: 'absent'`
 *     row when the Environment carries no SourceBinding at all).
 *   - an unresolvable service or environment name gets no `actionPolicy`
 *     row at all — only the single `binding: null, status: 'absent'` row,
 *     exactly as `runSourceCheckCommand` reports it. This is the acceptance
 *     line this file's own "absent configuration, distinctly" row pins:
 *     nothing configured reads as `absent`, which is a different word from
 *     `denied` (a binding IS configured, its credential is refused) and
 *     `unreachable` (a binding IS configured, its source cannot be reached).
 *   - the returned summary is `{ allReady: boolean }`, true only when every
 *     binding row across every Environment in scope was `ready` and no
 *     Environment in scope reported `absent`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

function loadDoctorCommand() {
  return import('../apps/cli/dist/commands/doctor.js');
}

function makeService(overrides = {}) {
  return { id: randomUUID(), name: 'checkout', repositoryAliases: [], ...overrides };
}

function makeEnvironment(serviceId, overrides = {}) {
  return { id: randomUUID(), serviceId, name: 'staging', ...overrides };
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

function makeActionPolicy(environmentId, overrides = {}) {
  return { id: randomUUID(), environmentId, allowedActionTypes: [], writeCredentialRefIds: [], ...overrides };
}

function makeRegistry({ services = [], environments = [], sourceBindings = [], credentialRefs = [], actionPolicies = [] } = {}) {
  return { services, environments, sourceBindings, credentialRefs, actionPolicies };
}

function fakeStore(snapshot) {
  return { snapshot: async () => snapshot };
}

function neverResolveSecret() {
  throw new Error('DOCTOR_MUST_NOT_RESOLVE_A_SECRET_FOR_THIS_ROW');
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

function labFetchAnswering(status) {
  return async () => new Response('', { status });
}

test('exports runDoctorCommand', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  assert.equal(
    typeof runDoctorCommand,
    'function',
    'apps/cli/src/commands/doctor.ts must export runDoctorCommand(argv, deps): Promise<{ allReady: boolean }> (AIC-99 slice e)',
  );
});

test('reports an actionPolicy row per environment, true when one is set and false when none exists', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService();
  const withPolicy = makeEnvironment(service.id, { name: 'production' });
  const withoutPolicy = makeEnvironment(service.id, { name: 'staging' });
  const registry = makeRegistry({
    services: [service],
    environments: [withPolicy, withoutPolicy],
    actionPolicies: [makeActionPolicy(withPolicy.id)],
  });
  const sink = createStdoutSink();

  await runDoctorCommand([], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  const policyRows = sink.rows().filter((row) => 'actionPolicy' in row);
  assert.deepEqual(policyRows, [
    { service: service.name, environment: withPolicy.name, actionPolicy: true },
    { service: service.name, environment: withoutPolicy.name, actionPolicy: false },
  ]);
});

test('AIC-99 acceptance: names absent configuration distinctly from a denied binding and an unreachable binding', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService();
  const unconfigured = makeEnvironment(service.id, { name: 'unconfigured' });
  const withDenied = makeEnvironment(service.id, { name: 'with-denied' });
  const deniedBinding = makeBinding(withDenied.id, { name: 'lab-denied', config: { baseUrl: 'https://denied.example.test' } });
  const withUnreachable = makeEnvironment(service.id, { name: 'with-unreachable' });
  const unreachableBinding = makeBinding(withUnreachable.id, {
    name: 'lab-unreachable',
    config: { baseUrl: 'https://unreachable.example.test' },
  });
  const registry = makeRegistry({
    services: [service],
    environments: [unconfigured, withDenied, withUnreachable],
    sourceBindings: [deniedBinding, unreachableBinding],
  });
  const sink = createStdoutSink();
  const statusByOrigin = {
    'https://denied.example.test': 401,
    'https://unreachable.example.test': 500,
  };

  const summary = await runDoctorCommand([], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: async (url) => new Response('', { status: statusByOrigin[url.origin] ?? 500 }),
    stdout: sink.stdout,
  });

  const bindingRows = sink.rows().filter((row) => 'status' in row);
  assert.deepEqual(bindingRows, [
    { service: service.name, environment: unconfigured.name, binding: null, status: 'absent' },
    { service: service.name, environment: withDenied.name, binding: deniedBinding.name, status: 'denied' },
    { service: service.name, environment: withUnreachable.name, binding: unreachableBinding.name, status: 'unreachable' },
  ]);
  const statuses = bindingRows.map((row) => row.status);
  assert.equal(new Set(statuses).size, 3, 'absent, denied and unreachable must be three distinct words, never conflated');
  assert.equal(summary.allReady, false);
});

test('narrows to one service and environment when both are given, and reports no other environment', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService();
  const targetEnvironment = makeEnvironment(service.id, { name: 'staging' });
  const otherEnvironment = makeEnvironment(service.id, { name: 'production' });
  const otherService = makeService({ name: 'billing' });
  const otherServiceEnvironment = makeEnvironment(otherService.id, { name: 'staging' });
  const registry = makeRegistry({
    services: [service, otherService],
    environments: [targetEnvironment, otherEnvironment, otherServiceEnvironment],
  });
  const sink = createStdoutSink();

  await runDoctorCommand([service.name, targetEnvironment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  const environmentsReported = new Set(sink.rows().map((row) => `${row.service}/${row.environment}`));
  assert.deepEqual(environmentsReported, new Set([`${service.name}/${targetEnvironment.name}`]));
});

test('reports every environment of every service when given no argv at all', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const serviceA = makeService({ name: 'checkout' });
  const serviceB = makeService({ name: 'billing' });
  const environmentA = makeEnvironment(serviceA.id, { name: 'staging' });
  const environmentB = makeEnvironment(serviceB.id, { name: 'staging' });
  const registry = makeRegistry({ services: [serviceA, serviceB], environments: [environmentA, environmentB] });
  const sink = createStdoutSink();

  await runDoctorCommand([], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  const environmentsReported = new Set(sink.rows().map((row) => `${row.service}/${row.environment}`));
  assert.deepEqual(
    environmentsReported,
    new Set([`${serviceA.name}/${environmentA.name}`, `${serviceB.name}/${environmentB.name}`]),
  );
});

test('reports one absent row naming no binding, and no actionPolicy row, when the given service is unknown', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const registry = makeRegistry();
  const sink = createStdoutSink();

  const summary = await runDoctorCommand(['no-such-service'], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });

  assert.deepEqual(sink.rows(), [
    { service: 'no-such-service', environment: null, binding: null, status: 'absent' },
  ]);
  assert.equal(summary.allReady, false);
});

test('the returned summary is allReady true only when every environment in scope has a binding and every binding is ready', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const binding = makeBinding(environment.id);
  const registry = makeRegistry({ services: [service], environments: [environment], sourceBindings: [binding] });
  const sink = createStdoutSink();

  const summary = await runDoctorCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(200),
    stdout: sink.stdout,
  });

  assert.equal(summary.allReady, true);
});

test('never writes a resolved secret value into any JSON line', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const secretMarker = 'doctorfixturesecretvaluemarker';
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const credentialRef = {
    id: randomUUID(),
    environmentId: environment.id,
    access: 'read',
    name: 'github-read',
    secretName: ['GITHUB', 'READ', 'TOKEN'].join('_'),
  };
  const binding = makeBinding(environment.id, {
    adapterId: 'github',
    adapterVersion: '1',
    name: 'github-primary',
    config: { owner: 'octo-owner', repo: 'octo-repo' },
    credentialRefId: credentialRef.id,
  });
  const registry = makeRegistry({
    services: [service],
    environments: [environment],
    sourceBindings: [binding],
    credentialRefs: [credentialRef],
  });
  const sink = createStdoutSink();

  await runDoctorCommand([service.name, environment.name], {
    store: fakeStore(registry),
    resolveSecret: fixedResolveSecret({ status: 'found', value: secretMarker }),
    fetch: async (url) => {
      if (url.pathname === '/repos/octo-owner/octo-repo') {
        return new Response('{}', {
          status: 200,
          headers: { 'github-authentication-token-expiration': '2099-01-01T00:00:00Z' },
        });
      }
      return new Response('', { status: 404 });
    },
    stdout: sink.stdout,
  });

  for (const line of sink.lines) {
    assert.doesNotMatch(line, new RegExp(secretMarker));
  }
});

/* -------------------------------------------------------------------------- */
/* Absent configuration is never reported as healthy, and one bad binding     */
/* never ends the run                                                          */
/* -------------------------------------------------------------------------- */

test('an empty registry is absent configuration: doctor reports an absent row and is not ready', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const sink = createStdoutSink();
  const summary = await runDoctorCommand([], {
    store: fakeStore(makeRegistry()),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });
  assert.equal(summary.allReady, false);
  assert.ok(sink.rows().some((row) => row.status === 'absent'), JSON.stringify(sink.rows()));
});

test('a service with no environments is absent configuration: doctor reports it and is not ready', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService();
  const sink = createStdoutSink();
  const summary = await runDoctorCommand([], {
    store: fakeStore(makeRegistry({ services: [service] })),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });
  assert.equal(summary.allReady, false);
  assert.ok(
    sink.rows().some((row) => row.service === service.name && row.status === 'absent'),
    JSON.stringify(sink.rows()),
  );
});

test('a binding the catalog cannot build is one misconfigured row that never reproduces its config, and the next binding is still checked', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const opaque = ['abc+def', 'ghi=jkl', 'y'.repeat(40)].join('/');
  const credentialRef = {
    id: randomUUID(),
    environmentId: environment.id,
    access: 'read',
    name: 'github-read',
    secretName: ['GITHUB', 'READ', 'TOKEN'].join('_'),
  };
  const bad = makeBinding(environment.id, {
    name: 'gh-bad',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: opaque, repo: 'demo' },
    credentialRefId: credentialRef.id,
  });
  const good = makeBinding(environment.id, { name: 'lab-good' });
  const sink = createStdoutSink();
  const summary = await runDoctorCommand([], {
    store: fakeStore(makeRegistry({ services: [service], environments: [environment], sourceBindings: [bad, good], credentialRefs: [credentialRef] })),
    resolveSecret: neverResolveSecret,
    fetch: labFetchAnswering(200),
    stdout: sink.stdout,
  });
  const byBinding = Object.fromEntries(sink.rows().filter((row) => 'binding' in row).map((row) => [row.binding, row.status]));
  assert.deepEqual(byBinding, { 'gh-bad': 'misconfigured', 'lab-good': 'ready' });
  assert.equal(summary.allReady, false);
  assert.ok(!sink.lines.join('\n').includes(opaque));
});

test('a secret name the resolver refuses is one misconfigured row, and the run continues', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const tools = await import('@aic/tools');
  const service = makeService();
  const environment = makeEnvironment(service.id);
  const credentialRef = {
    id: randomUUID(),
    environmentId: environment.id,
    access: 'read',
    name: 'github-read',
    secretName: ['GITHUB', 'READ', 'TOKEN'].join('_'),
  };
  const gh = makeBinding(environment.id, {
    name: 'gh',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: 'octo', repo: 'demo' },
    credentialRefId: credentialRef.id,
  });
  const lab = makeBinding(environment.id, { name: 'lab' });
  const sink = createStdoutSink();
  await runDoctorCommand([], {
    store: fakeStore(makeRegistry({ services: [service], environments: [environment], sourceBindings: [gh, lab], credentialRefs: [credentialRef] })),
    resolveSecret: async () => {
      throw new tools.SecretNameError();
    },
    fetch: labFetchAnswering(200),
    stdout: sink.stdout,
  });
  const byBinding = Object.fromEntries(sink.rows().filter((row) => 'binding' in row).map((row) => [row.binding, row.status]));
  assert.deepEqual(byBinding, { gh: 'misconfigured', lab: 'ready' });
});

test('doctor refuses a credential-shaped service or environment argument without reproducing it, before the registry is read', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const token = ['sk', 'ant', 'api03', '7'.repeat(40)].join('-');
  for (const argv of [[token], ['checkout', token]]) {
    let snapshotCalls = 0;
    const sink = createStdoutSink();
    await assert.rejects(
      () =>
        runDoctorCommand(argv, {
          store: { snapshot: async () => { snapshotCalls += 1; return makeRegistry(); } },
          resolveSecret: neverResolveSecret,
          stdout: sink.stdout,
        }),
      (error) => {
        assert.ok(!error.message.includes(token), 'the refusal must not reproduce the argument');
        return true;
      },
    );
    assert.equal(snapshotCalls, 0);
    assert.equal(sink.lines.length, 0);
  }
});

test('doctor refuses a third positional argument before the registry is read', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  let snapshotCalls = 0;
  await assert.rejects(
    () =>
      runDoctorCommand(['checkout', 'prod', 'extra'], {
        store: { snapshot: async () => { snapshotCalls += 1; return makeRegistry(); } },
        resolveSecret: neverResolveSecret,
        stdout: () => {},
      }),
    /extra positional/,
  );
  assert.equal(snapshotCalls, 0);
});

test('doctor <service> for a known service with no environments reports it absent and is not ready', async () => {
  const { runDoctorCommand } = await loadDoctorCommand();
  const service = makeService({ name: 'lonely' });
  const sink = createStdoutSink();
  const summary = await runDoctorCommand([service.name], {
    store: fakeStore(makeRegistry({ services: [service] })),
    resolveSecret: neverResolveSecret,
    stdout: sink.stdout,
  });
  assert.equal(summary.allReady, false);
  assert.deepEqual(sink.rows(), [{ service: 'lonely', environment: null, binding: null, status: 'absent' }]);
});

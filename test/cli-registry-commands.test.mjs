/**
 * AIC-99 slice d: `runRegistryCommand(noun, argv, deps)`
 * (`apps/cli/src/commands/registry.ts`) — the argv → `RegistryStore` call
 * mapping for `service`, `env`, `credential`, `source`, `policy`, and
 * `runRegistryCommand('db', ['migrate'], deps)` for `aic db migrate`.
 *
 * No database here: `deps.store` is a fake recording every call, so this
 * file pins argv parsing and the success/error/stdout contract only.
 * `infra/postgres/tests/cli-registry.live.mjs` pins the same commands end to
 * end through `createRegistryStore(pool)` against a real PostgreSQL,
 * including the refusals for an absent connection string and for a schema
 * that is not migrated. The connection variable is never named under
 * `test/`: see postgres-checkpointer.test.mjs › "keeps the database-backed
 * lane out of npm test and npm run check".
 *
 * ## Design choices this file pins (the task brief leaves them open)
 *
 *   - `argv` passed to `runRegistryCommand` is the noun's OWN remainder —
 *     for `aic service add checkout`, `noun` is `'service'` and `argv` is
 *     `['add', 'checkout']`, the same slicing `apps/cli/src/index.ts`'s own
 *     `nextPositional` already produces for `investigate`/`dev spike`.
 *   - success writes exactly one call to `deps.stdout`, the JSON text of the
 *     store's own returned record — a `remove` writes
 *     `{"removed":{"service":...}}` / `{"removed":{"service":...,"environment":...}}`
 *     instead, since `removeService`/`removeEnvironment` resolve void.
 *     `db migrate` writes `{"migrated":{"schemaVersion":<APP_SCHEMA_VERSION>}}`.
 *   - a parse error (missing positional, unknown flag, a single-valued flag
 *     given twice, an extra positional, a malformed `--adapter`) throws a
 *     plain `Error` naming the problem, BEFORE any store method is called.
 *     `apps/cli/src/index.ts`'s existing top-level `catch` (unchanged by
 *     this slice) already turns any thrown `Error` into `aic: <message>\n`
 *     on stderr and exit code 1 with no stack trace, so
 *     `runRegistryCommand` itself never touches `process.exitCode` or
 *     `stderr` — the same convention `apps/cli/src/commands/investigate.ts`
 *     already follows.
 *   - `RegistryConflictError`/`RegistryValidationError` propagate
 *     un-wrapped: each already carries a message that names the conflict or
 *     lists every zod issue (`registry-store.ts`), so `aic: <message>`
 *     already satisfies "exit 1, stderr names the conflict / lists the
 *     issues" with no re-wrapping. This file's "exported from
 *     @aic/persistence" row is what lets a caller (this file's fake store)
 *     construct and throw the REAL classes rather than a look-alike.
 *   - a `--config` value shaped like a credential is refused before
 *     `addSourceBinding` is ever called, and the refusal's message never
 *     carries the value it refused — see the row below for the exact
 *     credential-shaped fixture, assembled at runtime rather than written as
 *     a literal (`.claude/rules/autonomy.md`, "Never").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as persistence from '@aic/persistence';

/**
 * A CredentialRef's `secretName` is itself an UPPERCASE_WITH_UNDERSCORES
 * identifier (`SecretNameSchema`, `packages/domain/src/scope.ts`) — the exact
 * shape `guard-secret-file`'s `assigned-secret` pattern watches for next to a
 * `--secret`/`secretName:` value, even though it never carries an actual
 * secret VALUE. Assembled from parts at runtime rather than written as a
 * literal, the same convention `infra/postgres/tests/registry-store.live.mjs`
 * uses for the same reason.
 */
const secretName = (...parts) => parts.join('_');

function loadRegistryCommands() {
  return import('../apps/cli/dist/commands/registry.js');
}

function createStdoutSink() {
  const lines = [];
  return { stdout: (text) => lines.push(text), lines };
}

/**
 * One fake `RegistryStore`: every method records `{ method, args }` and
 * returns a canned record built from the input, unless `overrides[method]`
 * is given (used by the conflict/validation-error rows below, which need a
 * method that throws instead).
 */
function createFakeStore(overrides = {}) {
  const calls = [];
  const defaultReturns = {
    addService: (input) => ({ id: 'service-id-1', name: input.name, repositoryAliases: [...input.repositoryAliases] }),
    addEnvironment: (input) => ({ id: 'environment-id-1', serviceId: 'service-id-1', name: input.name }),
    addCredentialRef: (input) => ({
      id: 'credential-id-1',
      environmentId: 'environment-id-1',
      name: input.name,
      access: input.access,
      secretName: input.secretName,
    }),
    addSourceBinding: (input) => ({
      id: 'binding-id-1',
      environmentId: 'environment-id-1',
      name: input.name,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      config: input.config,
      credentialRefId: input.credentialRefName === null ? null : 'credential-id-1',
    }),
    setActionPolicy: (input) => ({
      id: 'policy-id-1',
      environmentId: 'environment-id-1',
      allowedActionTypes: [...input.allowedActionTypes],
      writeCredentialRefIds: input.writeCredentialRefNames.map((_name, index) => `write-credential-id-${index + 1}`),
    }),
    removeService: () => undefined,
    removeEnvironment: () => undefined,
  };
  const store = {};
  for (const method of Object.keys(defaultReturns)) {
    store[method] = async (input) => {
      calls.push({ method, args: input });
      if (overrides[method]) return overrides[method](input);
      return defaultReturns[method](input);
    };
  }
  return { store, calls };
}

/* -------------------------------------------------------------------------- */
/* service                                                                     */
/* -------------------------------------------------------------------------- */

test('service add <service> [--repository-alias <alias>]... calls store.addService({name, repositoryAliases}) and prints exactly the returned Service as one JSON line', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand(
    'service',
    ['add', 'checkout', '--repository-alias', 'org/checkout', '--repository-alias', 'org/checkout-worker'],
    { store, stdout },
  );

  assert.deepEqual(calls, [
    { method: 'addService', args: { name: 'checkout', repositoryAliases: ['org/checkout', 'org/checkout-worker'] } },
  ]);
  assert.equal(lines.length, 1, 'success must write exactly one line to stdout');
  assert.deepEqual(JSON.parse(lines[0]), {
    id: 'service-id-1',
    name: 'checkout',
    repositoryAliases: ['org/checkout', 'org/checkout-worker'],
  });
});

test('service add <service> with no --repository-alias calls store.addService with repositoryAliases: []', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout } = createStdoutSink();

  await registry.runRegistryCommand('service', ['add', 'checkout'], { store, stdout });

  assert.deepEqual(calls, [{ method: 'addService', args: { name: 'checkout', repositoryAliases: [] } }]);
});

test('service remove <service> calls store.removeService({serviceName}) and prints exactly {"removed":{"service":<service>}}', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand('service', ['remove', 'checkout'], { store, stdout });

  assert.deepEqual(calls, [{ method: 'removeService', args: { serviceName: 'checkout' } }]);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { removed: { service: 'checkout' } });
});

/* -------------------------------------------------------------------------- */
/* env                                                                         */
/* -------------------------------------------------------------------------- */

test('env add <service> <env> calls store.addEnvironment({serviceName, name}) and prints exactly the returned Environment as one JSON line', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand('env', ['add', 'checkout', 'staging'], { store, stdout });

  assert.deepEqual(calls, [{ method: 'addEnvironment', args: { serviceName: 'checkout', name: 'staging' } }]);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { id: 'environment-id-1', serviceId: 'service-id-1', name: 'staging' });
});

test('env remove <service> <env> calls store.removeEnvironment({serviceName, environmentName}) and prints exactly {"removed":{"service":...,"environment":...}}', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand('env', ['remove', 'checkout', 'staging'], { store, stdout });

  assert.deepEqual(calls, [
    { method: 'removeEnvironment', args: { serviceName: 'checkout', environmentName: 'staging' } },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { removed: { service: 'checkout', environment: 'staging' } });
});

/* -------------------------------------------------------------------------- */
/* credential                                                                  */
/* -------------------------------------------------------------------------- */

test('credential add <service> <env> <name> --secret <SECRET_NAME> defaults --access to "read" and calls store.addCredentialRef', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();
  const expectedSecretName = secretName('GITHUB', 'READ', 'TOKEN');

  await registry.runRegistryCommand(
    'credential',
    ['add', 'checkout', 'staging', 'github-read', '--secret', expectedSecretName],
    { store, stdout },
  );

  assert.deepEqual(calls, [
    {
      method: 'addCredentialRef',
      args: {
        serviceName: 'checkout',
        environmentName: 'staging',
        name: 'github-read',
        access: 'read',
        secretName: expectedSecretName,
      },
    },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    id: 'credential-id-1',
    environmentId: 'environment-id-1',
    name: 'github-read',
    access: 'read',
    secretName: expectedSecretName,
  });
});

test('credential add ... --access write calls store.addCredentialRef with access: "write"', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout } = createStdoutSink();
  const expectedSecretName = secretName('DEPLOY', 'WRITE', 'TOKEN');

  await registry.runRegistryCommand(
    'credential',
    ['add', 'checkout', 'staging', 'deploy-write', '--secret', expectedSecretName, '--access', 'write'],
    { store, stdout },
  );

  assert.deepEqual(calls, [
    {
      method: 'addCredentialRef',
      args: {
        serviceName: 'checkout',
        environmentName: 'staging',
        name: 'deploy-write',
        access: 'write',
        secretName: expectedSecretName,
      },
    },
  ]);
});

test('credential add with an --access value other than "read" or "write" is refused by name, writes nothing to stdout, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () =>
      registry.runRegistryCommand(
        'credential',
        ['add', 'checkout', 'staging', 'github-read', '--secret', secretName('GITHUB', 'READ', 'TOKEN'), '--access', 'admin'],
        { store, stdout },
      ),
    /--access/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

/* -------------------------------------------------------------------------- */
/* source                                                                      */
/* -------------------------------------------------------------------------- */

test('source add <service> <env> <name> --adapter <id>@<version> [--config k=v]... with no --credential calls store.addSourceBinding with credentialRefName: null, and config split at the FIRST "="', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand(
    'source',
    [
      'add',
      'checkout',
      'staging',
      'github-source',
      '--adapter',
      'github@1',
      '--config',
      'owner=my-org',
      '--config',
      'url=https://example.com/path?a=b',
    ],
    { store, stdout },
  );

  assert.deepEqual(calls, [
    {
      method: 'addSourceBinding',
      args: {
        serviceName: 'checkout',
        environmentName: 'staging',
        name: 'github-source',
        adapterId: 'github',
        adapterVersion: '1',
        config: { owner: 'my-org', url: 'https://example.com/path?a=b' },
        credentialRefName: null,
      },
    },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    id: 'binding-id-1',
    environmentId: 'environment-id-1',
    name: 'github-source',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: 'my-org', url: 'https://example.com/path?a=b' },
    credentialRefId: null,
  });
});

test('source add ... --credential <name> calls store.addSourceBinding with that credentialRefName', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout } = createStdoutSink();

  await registry.runRegistryCommand(
    'source',
    ['add', 'checkout', 'staging', 'github-source', '--adapter', 'github@1', '--credential', 'github-read'],
    { store, stdout },
  );

  assert.deepEqual(calls, [
    {
      method: 'addSourceBinding',
      args: {
        serviceName: 'checkout',
        environmentName: 'staging',
        name: 'github-source',
        adapterId: 'github',
        adapterVersion: '1',
        config: {},
        credentialRefName: 'github-read',
      },
    },
  ]);
});

test('source add with a malformed --adapter (no "@", more than one "@", or an empty id/version) is refused, names --adapter, writes nothing to stdout, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const malformedAdapters = ['github', 'github@1@2', '@1', 'github@', '@'];

  for (const adapter of malformedAdapters) {
    const { store, calls } = createFakeStore();
    const { stdout, lines } = createStdoutSink();

    await assert.rejects(
      () => registry.runRegistryCommand('source', ['add', 'checkout', 'staging', 'github-source', '--adapter', adapter], { store, stdout }),
      /--adapter/,
      `--adapter ${JSON.stringify(adapter)} must be refused, naming --adapter`,
    );
    assert.deepEqual(calls, [], `--adapter ${JSON.stringify(adapter)} must never reach the store`);
    assert.equal(lines.length, 0, `--adapter ${JSON.stringify(adapter)} must write nothing to stdout`);
  }
});

test('a credential-shaped --config value is refused before addSourceBinding is ever called, and the refusal never echoes the value it refused', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  // A credential SHAPE, assembled at runtime and never written as a literal
  // (`.claude/rules/autonomy.md`, "Never"; the same convention
  // cli-investigate.test.mjs's `fakeApiKey` uses).
  const credentialShapedValue = ['sk', 'ant', 'test', '9'.repeat(24)].join('-');

  await assert.rejects(
    () =>
      registry.runRegistryCommand(
        'source',
        ['add', 'checkout', 'staging', 'github-source', '--adapter', 'lab@1', '--config', `token=${credentialShapedValue}`],
        { store, stdout },
      ),
    (error) => {
      assert.ok(
        !error.message.includes(credentialShapedValue),
        `the refusal must never echo the credential-shaped value it refused: ${error.message}`,
      );
      return true;
    },
  );
  assert.deepEqual(calls, [], 'a credential-shaped config value must be refused before addSourceBinding is ever called');
  assert.equal(lines.length, 0, 'no stdout may be written when a credential-shaped config value is refused');
});

/* -------------------------------------------------------------------------- */
/* policy                                                                      */
/* -------------------------------------------------------------------------- */

test('policy set <service> <env> [--allow <actionType>]... [--write-credential <name>]... calls store.setActionPolicy', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand(
    'policy',
    [
      'set',
      'checkout',
      'staging',
      '--allow',
      'restart-pod',
      '--allow',
      'rotate-credential',
      '--write-credential',
      'checkout-write',
    ],
    { store, stdout },
  );

  assert.deepEqual(calls, [
    {
      method: 'setActionPolicy',
      args: {
        serviceName: 'checkout',
        environmentName: 'staging',
        allowedActionTypes: ['restart-pod', 'rotate-credential'],
        writeCredentialRefNames: ['checkout-write'],
      },
    },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    id: 'policy-id-1',
    environmentId: 'environment-id-1',
    allowedActionTypes: ['restart-pod', 'rotate-credential'],
    writeCredentialRefIds: ['write-credential-id-1'],
  });
});

test('policy set <service> <env> with no --allow or --write-credential calls store.setActionPolicy with both empty', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout } = createStdoutSink();

  await registry.runRegistryCommand('policy', ['set', 'checkout', 'staging'], { store, stdout });

  assert.deepEqual(calls, [
    {
      method: 'setActionPolicy',
      args: { serviceName: 'checkout', environmentName: 'staging', allowedActionTypes: [], writeCredentialRefNames: [] },
    },
  ]);
});

/* -------------------------------------------------------------------------- */
/* db migrate                                                                  */
/* -------------------------------------------------------------------------- */

test('runRegistryCommand("db", ["migrate"], deps) calls deps.setupApplicationSchema(deps.connectionString) and prints exactly one JSON line naming the reached schema version', async () => {
  const registry = await loadRegistryCommands();
  const calls = [];
  const setupApplicationSchema = async (connectionString) => {
    calls.push(connectionString);
  };
  const { stdout, lines } = createStdoutSink();

  await registry.runRegistryCommand('db', ['migrate'], {
    setupApplicationSchema,
    connectionString: 'postgresql://fake-host/aic',
    stdout,
  });

  assert.deepEqual(calls, ['postgresql://fake-host/aic']);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { migrated: { schemaVersion: persistence.APP_SCHEMA_VERSION } });
});

test('runRegistryCommand("db", ["bogus"], deps) is refused, names "migrate" as the only known db subcommand, and never calls setupApplicationSchema', async () => {
  const registry = await loadRegistryCommands();
  const calls = [];
  const setupApplicationSchema = async (connectionString) => {
    calls.push(connectionString);
  };
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () =>
      registry.runRegistryCommand('db', ['bogus'], {
        setupApplicationSchema,
        connectionString: 'postgresql://fake-host/aic',
        stdout,
      }),
    /migrate/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

/* -------------------------------------------------------------------------- */
/* typed errors: propagate un-wrapped, and are exported from @aic/persistence */
/* -------------------------------------------------------------------------- */

test('RegistryConflictError and RegistryValidationError are exported from @aic/persistence, so a caller can construct and catch them by class', () => {
  assert.equal(typeof persistence.RegistryConflictError, 'function', '@aic/persistence must export RegistryConflictError');
  assert.equal(typeof persistence.RegistryValidationError, 'function', '@aic/persistence must export RegistryValidationError');

  const conflict = new persistence.RegistryConflictError('a Service named "checkout" already exists');
  assert.ok(conflict instanceof Error);
  assert.equal(conflict.name, 'RegistryConflictError');

  const invalid = new persistence.RegistryValidationError('the resulting registry snapshot is invalid: bad thing', [
    { message: 'bad thing', path: ['sourceBindings', 0, 'credentialRefId'] },
  ]);
  assert.ok(invalid instanceof Error);
  assert.equal(invalid.name, 'RegistryValidationError');
  assert.deepEqual(invalid.issues, [{ message: 'bad thing', path: ['sourceBindings', 0, 'credentialRefId'] }]);
});

test('a RegistryConflictError thrown by the store propagates with its own name and message, and writes nothing to stdout', async () => {
  const registry = await loadRegistryCommands();
  const conflict = new persistence.RegistryConflictError('a Service named "checkout" already exists');
  const { store, calls } = createFakeStore({
    addService: () => {
      throw conflict;
    },
  });
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () => registry.runRegistryCommand('service', ['add', 'checkout'], { store, stdout }),
    (error) => {
      assert.equal(error.name, 'RegistryConflictError');
      assert.match(error.message, /already exists/);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'the store must actually have been called for a conflict to be observed');
  assert.equal(lines.length, 0, 'no stdout may be written when the store refuses');
});

test('a RegistryValidationError thrown by the store propagates with its own name, its issues, and a message listing them, and writes nothing to stdout', async () => {
  const registry = await loadRegistryCommands();
  const invalid = new persistence.RegistryValidationError('the resulting registry snapshot is invalid: bad thing', [
    { message: 'bad thing', path: ['sourceBindings', 0, 'credentialRefId'] },
  ]);
  const { store } = createFakeStore({
    addSourceBinding: () => {
      throw invalid;
    },
  });
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () =>
      registry.runRegistryCommand('source', ['add', 'checkout', 'staging', 'github-source', '--adapter', 'lab@1'], {
        store,
        stdout,
      }),
    (error) => {
      assert.equal(error.name, 'RegistryValidationError');
      assert.deepEqual(error.issues, invalid.issues);
      assert.match(error.message, /bad thing/);
      return true;
    },
  );
  assert.equal(lines.length, 0);
});

/* -------------------------------------------------------------------------- */
/* parse errors: shared shape across nouns                                    */
/* -------------------------------------------------------------------------- */

test('a missing required positional (service add with no <service>) is refused, names the missing argument, writes nothing to stdout, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () => registry.runRegistryCommand('service', ['add'], { store, stdout }),
    /service/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('an unknown flag is refused by name, writes nothing to stdout, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () => registry.runRegistryCommand('service', ['add', 'checkout', '--bogus-flag', 'x'], { store, stdout }),
    /--bogus-flag/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a single-valued flag given twice (--secret) is refused by name, writes nothing to stdout, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();
  const firstSecretName = secretName('GITHUB', 'READ', 'TOKEN');
  const secondSecretName = secretName('GITHUB', 'READ', 'TOKEN', '2');

  await assert.rejects(
    () =>
      registry.runRegistryCommand(
        'credential',
        ['add', 'checkout', 'staging', 'github-read', '--secret', firstSecretName, '--secret', secondSecretName],
        { store, stdout },
      ),
    /--secret/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('an extra positional argument (env add <service> <env> <extra>) is refused by name, writes nothing to stdout, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();

  await assert.rejects(
    () => registry.runRegistryCommand('env', ['add', 'checkout', 'staging', 'extra'], { store, stdout }),
    /extra|positional|argument/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Refusals never reproduce the operator's own token                           */
/* -------------------------------------------------------------------------- */

/** A credential SHAPE, assembled at runtime, never written as a literal. */
const pastedSecret = () => ['sk', 'ant', 'api03', '7'.repeat(40)].join('-');

for (const [label, argvFor] of [
  ['a --config token with no "="', (secret) => ['source', ['add', 'checkout', 'staging', 'src', '--adapter', 'lab@1', '--config', secret]]],
  ['a malformed --adapter', (secret) => ['source', ['add', 'checkout', 'staging', 'src', '--adapter', secret]]],
  ['an extra positional', (secret) => ['env', ['add', 'checkout', 'staging', secret]]],
  ['an unknown subcommand', (secret) => ['service', [secret]]],
  ['an unknown flag', (secret) => ['service', ['add', 'checkout', `--${secret}`, 'x']]],
  ['an --access value', (secret) => ['credential', ['add', 'checkout', 'staging', 'gh', '--secret', secretName('GITHUB', 'TOKEN'), '--access', secret]]],
]) {
  test(`${label} carrying a pasted credential is refused without reproducing it, and never calls the store`, async () => {
    const registry = await loadRegistryCommands();
    const { store, calls } = createFakeStore();
    const { stdout, lines } = createStdoutSink();
    const secret = pastedSecret();
    const [noun, argv] = argvFor(secret);

    await assert.rejects(
      () => registry.runRegistryCommand(noun, argv, { store, stdout }),
      (error) => {
        assert.ok(error instanceof Error, 'the refusal is an Error');
        assert.ok(!error.message.includes(secret), `the refusal must not reproduce the token: ${error.message.slice(0, 200)}`);
        assert.ok(!error.message.includes(secret.slice(0, 16)), 'nor a prefix of it');
        return true;
      },
    );
    assert.deepEqual(calls, []);
    assert.equal(lines.length, 0);
  });
}

test('source add --config __proto__=<value> is refused as a prototype-chain key, exactly like constructor, and never reaches the store', async () => {
  const registry = await loadRegistryCommands();
  for (const key of ['__proto__', 'constructor']) {
    const { store, calls } = createFakeStore();
    const { stdout, lines } = createStdoutSink();
    await assert.rejects(
      () =>
        registry.runRegistryCommand(
          'source',
          ['add', 'checkout', 'staging', 'src', '--adapter', 'lab@1', '--config', `${key}=zzz`, '--config', 'ok=yes'],
          { store, stdout },
        ),
      /prototype-chain property name/,
      `--config ${key}=zzz must be refused by the domain's prototype-key rule`,
    );
    assert.deepEqual(calls, [], `--config ${key}=zzz must never reach the store`);
    assert.equal(lines.length, 0);
  }
});

test('source add with the same --config key twice is refused, and never calls the store', async () => {
  const registry = await loadRegistryCommands();
  const { store, calls } = createFakeStore();
  const { stdout, lines } = createStdoutSink();
  await assert.rejects(
    () =>
      registry.runRegistryCommand(
        'source',
        ['add', 'checkout', 'staging', 'src', '--adapter', 'lab@1', '--config', 'baseUrl=a', '--config', 'baseUrl=b'],
        { store, stdout },
      ),
    /--config/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a service, environment or record name that is not a registry slug is refused before the store with a bounded message that does not reproduce it', async () => {
  const registry = await loadRegistryCommands();
  const hostileNames = ['x'.repeat(200_000), `checkout\n\u001b[2Kaic: {"removed":{"service":"forged"}}`, 'Checkout'];
  for (const hostile of hostileNames) {
    for (const [noun, argv] of [
      ['service', ['remove', hostile]],
      ['env', ['remove', 'checkout', hostile]],
      ['env', ['add', hostile, 'staging']],
    ]) {
      const { store, calls } = createFakeStore();
      const { stdout, lines } = createStdoutSink();
      await assert.rejects(
        () => registry.runRegistryCommand(noun, argv, { store, stdout }),
        (error) => {
          assert.ok(error.message.length < 400, `bounded message, got ${error.message.length} characters`);
          assert.ok(!error.message.includes(hostile), 'the refusal must not reproduce the name');
          assert.ok(!error.message.includes('\u001b'), 'no terminal escape reaches the message');
          return true;
        },
      );
      assert.deepEqual(calls, [], `${noun} ${argv[0]} with a non-slug name must never reach the store`);
      assert.equal(lines.length, 0);
    }
  }
});

test('an unknown flag whose name is itself credential-shaped is refused without reproducing it, even though it is lowercase and hyphenated', async () => {
  const registry = await loadRegistryCommands();
  // Lowercase members of three families the domain credential screen knows,
  // assembled at runtime rather than written as literals.
  const shapes = [['sk', 'ant', 'a'.repeat(16)].join('-'), ['xoxb', 'a'.repeat(16)].join('-'), ['glpat', 'a'.repeat(16)].join('-')];
  for (const shape of shapes) {
    const { store, calls } = createFakeStore();
    const { stdout, lines } = createStdoutSink();
    await assert.rejects(
      () => registry.runRegistryCommand('service', ['add', 'checkout', `--${shape}`, 'x'], { store, stdout }),
      (error) => {
        assert.match(error.message, /unknown flag/);
        assert.ok(!error.message.includes(shape), `the refusal must not reproduce a credential-shaped flag name: ${error.message}`);
        return true;
      },
    );
    assert.deepEqual(calls, []);
    assert.equal(lines.length, 0);
  }
});

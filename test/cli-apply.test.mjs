/**
 * AIC-99 slice g: `runApplyCommand(argv, deps)`
 * (`apps/cli/src/commands/apply.ts`) — `aic apply -f <file> [--overwrite]
 * [--dry-run]`, the declarative onboarding manifest the owner's 2026-09-25
 * ruling fixes as idempotent INPUT, never a source of truth (Jira AIC-99,
 * the 2026-09-25 plan comment).
 *
 * No database here: `deps.store` is a fake `RegistryStore`-shaped object
 * recording every call and keeping its own snapshot up to date, so this file
 * pins the manifest → store-call mapping and the reported drift contract with
 * no PostgreSQL. `infra/postgres/tests/cli-apply.live.mjs` pins the same
 * command end to end through a real registry: apply twice → the second run is
 * all `unchanged`; editing the manifest's policy → `drift`, then
 * `--overwrite` → `updated`.
 *
 * ## Design choices this file pins
 *
 *   - `apply` has no subcommand: `argv` passed to `runApplyCommand` is
 *     whatever follows `apply` on the top-level command line, unlike
 *     `service`/`env`/`source`/`policy`/`credential`/`incident`, which all
 *     consume their own subcommand first.
 *   - `deps` is `{ store: RegistryStore-shaped (snapshot, add* methods and
 *     setActionPolicy, never a remove* call), stdout: (text: string) => void, readManifest?:
 *     (path: string) => unknown }`. `readManifest` is the injectable seam
 *     over the real bounded, single-descriptor manifest reader
 *     (`apps/cli/src/commands/bounded-file.ts`'s `readBoundedRegularFile`,
 *     the reader `aic investigate --replay` also uses, here with a 1 MiB
 *     bound rather than 16 MiB): every row in this file omits it and exercises the real
 *     reader against an actual file, so the byte-bound/duplicate-key/alias
 *     refusals below are measured against the real pipeline, not a fake.
 *   - `runApplyCommand` resolves to `{ clean: boolean }`: `clean` is `false`
 *     exactly when at least one reported line's `action` is `"drift"` — an
 *     `"unmanaged"` line, or a `"drift"` line resolved to `"updated"` by
 *     `--overwrite`, never makes the result unclean by itself. `index.ts`
 *     reads this the same way `runDoctorCommand`'s/`runSourceCheckCommand`'s
 *     `summary.allReady` already is: `!result.clean` sets
 *     `process.exitCode = 1`; this module itself never touches
 *     `process.exitCode`.
 *   - one JSON line is written to `deps.stdout` per manifest-declared entity,
 *     in manifest document order (each Service before its own Environments,
 *     and within an Environment: its Credentials, then its Sources, then its
 *     Policy) — then, after every declared entity, one further line per
 *     registry entity that is present in the snapshot but named by no entity
 *     in the manifest ("unmanaged"), in snapshot array order. Every line has
 *     the shape:
 *       `{ action: "created"|"unchanged"|"drift"|"updated"|"unmanaged",
 *          entity: "service"|"environment"|"credential"|"source"|"policy",
 *          service: string|null, environment: string|null, name: string|null,
 *          fields: string[] }`
 *     — the same "scope fields carry `null` when not applicable" shape
 *     `apps/cli/src/commands/binding-classification.ts`'s `BindingRow`
 *     already uses. `service`/`environment` are always the owning Service's
 *     and Environment's own names (`null` for a `service`-entity line, whose
 *     own name is instead carried in `service`); `name` is the entity's own
 *     name where it has one distinct from its scope (credential, source) and
 *     `null` otherwise (service, environment, policy — a policy is one per
 *     Environment, so its scope names it fully). `fields` is always present:
 *     `[]` outside `"drift"`/`"updated"`, and otherwise the sorted field
 *     names that differ — never the differing VALUES.
 *   - the field-name vocabulary a `"drift"`/`"updated"` line's `fields` draws
 *     from, one set per entity kind, since a store mutation can only ever
 *     replace a whole record: `credential` → `"secret"` (`secretName`),
 *     `"access"`; `source` → `"adapterId"`, `"adapterVersion"`, `"config"`
 *     (the whole config object, never a per-key diff), `"credential"` (the
 *     referenced CredentialRef's name); `policy` → `"allow"`
 *     (`allowedActionTypes`), `"writeCredentials"` (`writeCredentialRefNames`).
 *   - `--overwrite` only ever turns a `"drift"` line into `"updated"` for
 *     `policy`, whose store method (`setActionPolicy`) already replaces the
 *     whole record. `credential` and `source` have no in-place update on
 *     `RegistryStore` (`addCredentialRef`/`addSourceBinding` only ever
 *     INSERT), so a differing credential or source is reported `"drift"`
 *     regardless of `--overwrite`, and no store method is called for it.
 *   - `-f <file>` is required; its absence is refused before any store call
 *     (not even `snapshot()`).
 *   - the manifest is read and YAML-parsed (`uniqueKeys: true`,
 *     `maxAliasCount: 0`, the owner's ruling) BEFORE any store call: a file
 *     over the 1 MiB size bound, invalid YAML syntax, a duplicate mapping
 *     key, or a YAML alias/anchor is refused with zero store calls —
 *     `calls.length === 0` below, not even `snapshot()`.
 *   - after parsing, the manifest is validated against this module's own
 *     strict schema (`apiVersion: "aic.onboarding/v1"`, `kind: "Onboarding"`,
 *     no unrecognised top-level or entity key) and then the domain's own
 *     credential screen (`@aic/domain`'s `scope.ts`), BEFORE any store call —
 *     a credential-shaped config value, repository alias, or policy `allow`
 *     entry is refused without ever being echoed into the thrown message.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

/** A github-pat shape, assembled at runtime — never written as one contiguous literal (`.claude/rules/autonomy.md`). */
const pastedSecret = () => ['ghp', 'B'.repeat(28)].join('_');

/**
 * A CredentialRef's `secretName` is itself an UPPERCASE_WITH_UNDERSCORES
 * identifier (`SecretNameSchema`, `packages/domain/src/scope.ts`), the exact
 * shape `guard-secret-file`'s `assigned-secret` pattern watches for next to a
 * `secret:`/`secretName:` value even though it never carries an actual secret
 * VALUE. Assembled from parts at runtime, the same convention
 * `infra/postgres/tests/registry-store.live.mjs` uses for the same reason.
 */
const secretName = (...parts) => parts.join('_');

function loadApplyCommand() {
  return import('../apps/cli/dist/commands/apply.js');
}

function createStdoutSink() {
  const lines = [];
  return { stdout: (text) => lines.push(text), lines, rows: () => lines.map((line) => JSON.parse(line)) };
}

/**
 * Writes `content` to a fresh, exclusive temp directory, hands the manifest's
 * path to `fn`, and always removes that directory afterward by the exact
 * path `mkdtempSync` returned — never a glob, never `rm -rf "$TMPDIR"`.
 */
async function withManifestFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-cli-apply-'));
  const filePath = join(dir, 'manifest.yaml');
  writeFileSync(filePath, content, 'utf8');
  try {
    return await fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The base manifest: one Service, one Environment, one CredentialRef, one
 * SourceBinding, one ActionPolicy. Every field is overridable so a row can
 * change exactly the one field it means to test.
 */
function manifestYaml({
  serviceName = 'checkout',
  repositoryAliases = [],
  environmentName = 'staging',
  credentialName = 'github-read',
  credentialSecret = secretName('GITHUB', 'READ', 'TOKEN'),
  credentialAccess = 'read',
  sourceName = 'github-source',
  adapterVersion = '1',
  configRepo = 'checkout',
  sourceCredential = credentialName,
  policyAllow = ['restart-pod'],
} = {}) {
  const repositoryAliasesYaml =
    repositoryAliases.length === 0
      ? '[]'
      : `\n${repositoryAliases.map((alias) => `      - ${alias}`).join('\n')}`;
  const credentialLine = sourceCredential === null ? '' : `\n            credential: ${sourceCredential}`;
  const allowYaml = policyAllow.map((entry) => `            - ${entry}`).join('\n');
  return `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: ${serviceName}
    repositoryAliases: ${repositoryAliasesYaml}
    environments:
      - name: ${environmentName}
        credentials:
          - name: ${credentialName}
            secret: ${credentialSecret}
            access: ${credentialAccess}
        sources:
          - name: ${sourceName}
            adapter: github@${adapterVersion}
            config:
              owner: my-org
              repo: ${configRepo}${credentialLine}
        policy:
          allow:
${allowYaml}
          writeCredentials: []
`;
}

function emptySnapshot() {
  return { services: [], environments: [], sourceBindings: [], credentialRefs: [], actionPolicies: [] };
}

/**
 * A stateful fake `RegistryStore`: every `add*`/`setActionPolicy` call is
 * recorded AND folds into the snapshot the next `snapshot()` call returns —
 * the same "apply twice" idempotence a real store gives — so a row can seed
 * an already-onboarded registry directly, or build one up across two calls.
 * `removeEnvironment`/`removeService` record their call rather than throwing,
 * so a violation of "never delete" shows up as an assertion on `calls`
 * instead of an unhandled rejection.
 */
function createFakeRegistryStore(initialSnapshot = emptySnapshot()) {
  let snapshot = initialSnapshot;
  const calls = [];
  const findService = (name) => snapshot.services.find((service) => service.name === name);
  const findEnvironment = (serviceId, name) =>
    snapshot.environments.find((environment) => environment.serviceId === serviceId && environment.name === name);
  const findCredential = (environmentId, name) =>
    snapshot.credentialRefs.find((ref) => ref.environmentId === environmentId && ref.name === name);

  const store = {
    async snapshot() {
      calls.push({ method: 'snapshot', args: undefined });
      return snapshot;
    },
    async addService(input) {
      calls.push({ method: 'addService', args: input });
      const service = { id: randomUUID(), name: input.name, repositoryAliases: [...input.repositoryAliases] };
      snapshot = { ...snapshot, services: [...snapshot.services, service] };
      return service;
    },
    async addEnvironment(input) {
      calls.push({ method: 'addEnvironment', args: input });
      const service = findService(input.serviceName);
      const environment = { id: randomUUID(), serviceId: service.id, name: input.name };
      snapshot = { ...snapshot, environments: [...snapshot.environments, environment] };
      return environment;
    },
    async addCredentialRef(input) {
      calls.push({ method: 'addCredentialRef', args: input });
      const service = findService(input.serviceName);
      const environment = findEnvironment(service.id, input.environmentName);
      const credentialRef = {
        id: randomUUID(),
        environmentId: environment.id,
        name: input.name,
        access: input.access,
        secretName: input.secretName,
      };
      snapshot = { ...snapshot, credentialRefs: [...snapshot.credentialRefs, credentialRef] };
      return credentialRef;
    },
    async addSourceBinding(input) {
      calls.push({ method: 'addSourceBinding', args: input });
      const service = findService(input.serviceName);
      const environment = findEnvironment(service.id, input.environmentName);
      const credentialRefId =
        input.credentialRefName === null ? null : (findCredential(environment.id, input.credentialRefName)?.id ?? null);
      const sourceBinding = {
        id: randomUUID(),
        environmentId: environment.id,
        name: input.name,
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        config: input.config,
        credentialRefId,
      };
      snapshot = { ...snapshot, sourceBindings: [...snapshot.sourceBindings, sourceBinding] };
      return sourceBinding;
    },
    async setActionPolicy(input) {
      calls.push({ method: 'setActionPolicy', args: input });
      const service = findService(input.serviceName);
      const environment = findEnvironment(service.id, input.environmentName);
      const writeCredentialRefIds = input.writeCredentialRefNames.map(
        (name) => findCredential(environment.id, name)?.id ?? randomUUID(),
      );
      const actionPolicy = {
        id: randomUUID(),
        environmentId: environment.id,
        allowedActionTypes: [...input.allowedActionTypes],
        writeCredentialRefIds,
      };
      snapshot = {
        ...snapshot,
        actionPolicies: [
          ...snapshot.actionPolicies.filter((policy) => policy.environmentId !== environment.id),
          actionPolicy,
        ],
      };
      return actionPolicy;
    },
    async removeEnvironment(input) {
      calls.push({ method: 'removeEnvironment', args: input });
    },
    async removeService(input) {
      calls.push({ method: 'removeService', args: input });
    },
  };
  return { store, calls };
}

const CREATED_LINES = [
  { action: 'created', entity: 'service', service: 'checkout', environment: null, name: null, fields: [] },
  { action: 'created', entity: 'environment', service: 'checkout', environment: 'staging', name: null, fields: [] },
  {
    action: 'created',
    entity: 'credential',
    service: 'checkout',
    environment: 'staging',
    name: 'github-read',
    fields: [],
  },
  {
    action: 'created',
    entity: 'source',
    service: 'checkout',
    environment: 'staging',
    name: 'github-source',
    fields: [],
  },
  { action: 'created', entity: 'policy', service: 'checkout', environment: 'staging', name: null, fields: [] },
];

test('exports runApplyCommand', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  assert.equal(
    typeof runApplyCommand,
    'function',
    'apps/cli/src/commands/apply.ts must export runApplyCommand(argv, deps): Promise<{ clean: boolean }> (AIC-99 slice g)',
  );
});

/* -------------------------------------------------------------------------- */
/* create / unchanged / dry-run                                               */
/* -------------------------------------------------------------------------- */

test('a manifest creating one service/environment/credential/source/policy against an empty registry reports one created line per entity, in document order, and calls exactly those five store methods with the manifest\'s own fields', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml(), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: true });
  assert.deepEqual(rows(), CREATED_LINES);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['snapshot', 'addService', 'addEnvironment', 'addCredentialRef', 'addSourceBinding', 'setActionPolicy'],
  );
  assert.deepEqual(calls[1].args, { name: 'checkout', repositoryAliases: [] });
  assert.deepEqual(calls[2].args, { serviceName: 'checkout', name: 'staging' });
  assert.deepEqual(calls[3].args, {
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'github-read',
    access: 'read',
    secretName: secretName('GITHUB', 'READ', 'TOKEN'),
  });
  assert.deepEqual(calls[4].args, {
    serviceName: 'checkout',
    environmentName: 'staging',
    name: 'github-source',
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: 'my-org', repo: 'checkout' },
    credentialRefName: 'github-read',
  });
  assert.deepEqual(calls[5].args, {
    serviceName: 'checkout',
    environmentName: 'staging',
    allowedActionTypes: ['restart-pod'],
    writeCredentialRefNames: [],
  });
});

test('re-applying the identical manifest to the resulting registry reports every entity unchanged and performs zero store mutations', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout: firstStdout } = createStdoutSink();

  await withManifestFile(manifestYaml(), (filePath) => runApplyCommand(['-f', filePath], { store, stdout: firstStdout }));

  calls.length = 0;
  const { stdout, rows } = createStdoutSink();
  const result = await withManifestFile(manifestYaml(), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: true });
  assert.deepEqual(
    rows().map((row) => row.action),
    ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged'],
  );
  assert.deepEqual(calls, [{ method: 'snapshot', args: undefined }], 'a fully matching apply must call only snapshot()');
});

test('--dry-run prints the same creation plan as a real apply against an empty registry, but performs zero store mutations', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml(), (filePath) =>
    runApplyCommand(['-f', filePath, '--dry-run'], { store, stdout }),
  );

  assert.deepEqual(result, { clean: true });
  assert.deepEqual(rows(), CREATED_LINES);
  assert.deepEqual(calls, [{ method: 'snapshot', args: undefined }], '--dry-run must never call an add*/setActionPolicy method');
});

/* -------------------------------------------------------------------------- */
/* drift: source (config / adapter / credential)                              */
/* -------------------------------------------------------------------------- */

function onboardedSnapshot(overrides = {}) {
  const serviceId = overrides.serviceId ?? randomUUID();
  const environmentId = overrides.environmentId ?? randomUUID();
  const credentialId = overrides.credentialId ?? randomUUID();
  const sourceId = overrides.sourceId ?? randomUUID();
  const policyId = overrides.policyId ?? randomUUID();
  return {
    services: [{ id: serviceId, name: 'checkout', repositoryAliases: [] }],
    environments: [{ id: environmentId, serviceId, name: 'staging' }],
    credentialRefs: [
      {
        id: credentialId,
        environmentId,
        name: 'github-read',
        access: 'read',
        secretName: secretName('GITHUB', 'READ', 'TOKEN'),
      },
    ],
    sourceBindings: [
      {
        id: sourceId,
        environmentId,
        name: 'github-source',
        adapterId: 'github',
        adapterVersion: '1',
        config: { owner: 'my-org', repo: 'checkout' },
        credentialRefId: credentialId,
      },
    ],
    actionPolicies: [
      { id: policyId, environmentId, allowedActionTypes: ['restart-pod'], writeCredentialRefIds: [] },
    ],
  };
}

test('a source whose config differs from the stored SourceBinding is reported as drift naming only the config field, performs no store mutation, and reports the result as not clean', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ configRepo: 'checkout-v2' }), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const sourceRow = rows().find((row) => row.entity === 'source');
  assert.deepEqual(sourceRow, {
    action: 'drift',
    entity: 'source',
    service: 'checkout',
    environment: 'staging',
    name: 'github-source',
    fields: ['config'],
  });
  assert.equal(calls.some((call) => call.method === 'addSourceBinding'), false);
});

test('a source whose adapter version differs from the stored SourceBinding is reported as drift naming only the adapterVersion field', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ adapterVersion: '2' }), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const sourceRow = rows().find((row) => row.entity === 'source');
  assert.deepEqual(sourceRow.fields, ['adapterVersion']);
  assert.equal(calls.some((call) => call.method === 'addSourceBinding'), false);
});

test('a source whose referenced credential differs from the stored SourceBinding is reported as drift naming only the credential field', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ sourceCredential: null }), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const sourceRow = rows().find((row) => row.entity === 'source');
  assert.deepEqual(sourceRow.fields, ['credential']);
  assert.equal(calls.some((call) => call.method === 'addSourceBinding'), false);
});

/* -------------------------------------------------------------------------- */
/* drift / updated: policy, and --overwrite's limit                          */
/* -------------------------------------------------------------------------- */

test('a policy whose allow list differs from the stored ActionPolicy is reported as drift without --overwrite, and performs no store mutation', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ policyAllow: ['restart-pod', 'scale-up'] }), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const policyRow = rows().find((row) => row.entity === 'policy');
  assert.deepEqual(policyRow, {
    action: 'drift',
    entity: 'policy',
    service: 'checkout',
    environment: 'staging',
    name: null,
    fields: ['allow'],
  });
  assert.equal(calls.some((call) => call.method === 'setActionPolicy'), false);
});

test('a policy whose allow list differs, applied with --overwrite, is reported updated and setActionPolicy is called with the manifest\'s own allow/writeCredentials, leaving the result clean', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ policyAllow: ['restart-pod', 'scale-up'] }), (filePath) =>
    runApplyCommand(['-f', filePath, '--overwrite'], { store, stdout }),
  );

  assert.deepEqual(result, { clean: true });
  const policyRow = rows().find((row) => row.entity === 'policy');
  assert.deepEqual(policyRow, {
    action: 'updated',
    entity: 'policy',
    service: 'checkout',
    environment: 'staging',
    name: null,
    fields: ['allow'],
  });
  const setPolicyCall = calls.find((call) => call.method === 'setActionPolicy');
  assert.deepEqual(setPolicyCall.args, {
    serviceName: 'checkout',
    environmentName: 'staging',
    allowedActionTypes: ['restart-pod', 'scale-up'],
    writeCredentialRefNames: [],
  });
});

test('a differing CredentialRef is still reported drift even with --overwrite, because the store has no in-place update for it, and no store method is called for it', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(
    manifestYaml({ credentialSecret: secretName('GITHUB', 'READ', 'TOKEN', 'TWO') }),
    (filePath) => runApplyCommand(['-f', filePath, '--overwrite'], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const credentialRow = rows().find((row) => row.entity === 'credential');
  assert.deepEqual(credentialRow, {
    action: 'drift',
    entity: 'credential',
    service: 'checkout',
    environment: 'staging',
    name: 'github-read',
    fields: ['secret'],
  });
  assert.equal(calls.some((call) => call.method === 'addCredentialRef'), false);
});

test('a differing SourceBinding is still reported drift even with --overwrite, because the store has no in-place update for it, and no store method is called for it', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ configRepo: 'checkout-v2' }), (filePath) =>
    runApplyCommand(['-f', filePath, '--overwrite'], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const sourceRow = rows().find((row) => row.entity === 'source');
  assert.deepEqual(sourceRow.action, 'drift');
  assert.equal(calls.some((call) => call.method === 'addSourceBinding'), false);
});

/* -------------------------------------------------------------------------- */
/* unmanaged: present in the registry, absent from the manifest — never removed */
/* -------------------------------------------------------------------------- */

test('a Service present in the registry but absent from the manifest is reported unmanaged and never removed', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const base = onboardedSnapshot();
  const reportingServiceId = randomUUID();
  const seeded = {
    ...base,
    services: [...base.services, { id: reportingServiceId, name: 'reporting', repositoryAliases: [] }],
  };
  const { store, calls } = createFakeRegistryStore(seeded);
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml(), (filePath) => runApplyCommand(['-f', filePath], { store, stdout }));

  assert.deepEqual(result, { clean: true });
  assert.deepEqual(rows().at(-1), {
    action: 'unmanaged',
    entity: 'service',
    service: 'reporting',
    environment: null,
    name: null,
    fields: [],
  });
  assert.equal(
    calls.some((call) => call.method === 'removeService' || call.method === 'removeEnvironment'),
    false,
  );
});

test('an Environment present in the registry but absent from the manifest is reported unmanaged and never removed, even though its Service is managed', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const base = onboardedSnapshot();
  const canaryEnvironmentId = randomUUID();
  const seeded = {
    ...base,
    environments: [
      ...base.environments,
      { id: canaryEnvironmentId, serviceId: base.services[0].id, name: 'canary' },
    ],
  };
  const { store, calls } = createFakeRegistryStore(seeded);
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml(), (filePath) => runApplyCommand(['-f', filePath], { store, stdout }));

  assert.deepEqual(result, { clean: true });
  assert.deepEqual(rows().at(-1), {
    action: 'unmanaged',
    entity: 'environment',
    service: 'checkout',
    environment: 'canary',
    name: null,
    fields: [],
  });
  assert.equal(calls.some((call) => call.method === 'removeEnvironment'), false);
});

/* -------------------------------------------------------------------------- */
/* refusals: before any store call, never reproducing the file's content      */
/* -------------------------------------------------------------------------- */

test('a missing -f is refused before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();

  await assert.rejects(() => runApplyCommand([], { store, stdout }), /-f/);
  assert.deepEqual(calls, []);
});

test('a manifest file over the 1 MiB size bound is refused before any store call, naming the size bound', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const oversized = 'a'.repeat(1024 * 1024 + 1);

  await assert.rejects(
    () => withManifestFile(oversized, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    /1\s*MiB/i,
  );
  assert.deepEqual(calls, []);
});

test('invalid YAML syntax is refused naming only the line and column, never the surrounding text', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const marker = `nonce-${randomUUID()}`;
  const invalidYaml = `apiVersion: aic.onboarding/v1\nkind: Onboarding\nservices: [\n  - name: ${marker}\n`;

  await assert.rejects(
    () => withManifestFile(invalidYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    (error) => {
      assert.match(error.message, /line \d+/i);
      assert.match(error.message, /column \d+/i);
      assert.ok(!error.message.includes(marker), 'the refusal must never echo the surrounding manifest text');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('a duplicate mapping key in the manifest YAML is refused before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const duplicateKeyYaml = `apiVersion: aic.onboarding/v1\napiVersion: aic.onboarding/v1\nkind: Onboarding\nservices: []\n`;

  await assert.rejects(() =>
    withManifestFile(duplicateKeyYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
  );
  assert.deepEqual(calls, []);
});

test('a YAML alias in the manifest is refused before any store call, since aliased input is never accepted', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const aliasedYaml = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - &svc
    name: checkout
    repositoryAliases: []
    environments: []
  - *svc
`;

  await assert.rejects(() =>
    withManifestFile(aliasedYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
  );
  assert.deepEqual(calls, []);
});

test('an unknown top-level manifest key is refused before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const unknownTopLevelKeyYaml = `apiVersion: aic.onboarding/v1\nkind: Onboarding\nservices: []\nunexpected: true\n`;

  await assert.rejects(
    () => withManifestFile(unknownTopLevelKeyYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    /unknown|unrecognised|unrecognized/i,
  );
  assert.deepEqual(calls, []);
});

test('an unknown key inside a service entity is refused before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const unknownEntityKeyYaml = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments: []
    bogusField: true
`;

  await assert.rejects(
    () => withManifestFile(unknownEntityKeyYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    /unknown|unrecognised|unrecognized/i,
  );
  assert.deepEqual(calls, []);
});

test('a manifest whose apiVersion is not aic.onboarding/v1 is refused before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const wrongApiVersionYaml = `apiVersion: aic.onboarding/v2\nkind: Onboarding\nservices: []\n`;

  await assert.rejects(
    () => withManifestFile(wrongApiVersionYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    /apiVersion/i,
  );
  assert.deepEqual(calls, []);
});

test('a manifest whose kind is not Onboarding is refused before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const wrongKindYaml = `apiVersion: aic.onboarding/v1\nkind: Bogus\nservices: []\n`;

  await assert.rejects(
    () => withManifestFile(wrongKindYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    /kind/i,
  );
  assert.deepEqual(calls, []);
});

test('a credential-shaped source config value is refused before any store call, and the refusal never echoes it', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const secret = pastedSecret();
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
        credentials: []
        sources:
          - name: github-source
            adapter: github@1
            config:
              token: ${secret}
        policy:
          allow: []
          writeCredentials: []
`;

  await assert.rejects(
    () => withManifestFile(manifest, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped config value: ${error.message}`);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('a credential-shaped repository alias is refused before any store call, and the refusal never echoes it', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const secret = pastedSecret();

  await assert.rejects(
    () =>
      withManifestFile(manifestYaml({ repositoryAliases: [secret] }), (filePath) =>
        runApplyCommand(['-f', filePath], { store, stdout }),
      ),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped repository alias: ${error.message}`);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('a credential-shaped policy allow entry is refused before any store call, and the refusal never echoes it', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const secret = pastedSecret();

  await assert.rejects(
    () =>
      withManifestFile(manifestYaml({ policyAllow: [secret] }), (filePath) =>
        runApplyCommand(['-f', filePath], { store, stdout }),
      ),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped policy allow entry: ${error.message}`);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

/* -------------------------------------------------------------------------- */
/* an unresolved YAML tag is refused, never merely warned about               */
/* -------------------------------------------------------------------------- */

test('an unresolved YAML tag in the manifest, run through the built CLI, exits non-zero and never lets the credential-shaped value or the tag text reach stdout or stderr', async () => {
  const secret = pastedSecret();
  const dir = mkdtempSync(join(tmpdir(), 'aic-cli-apply-'));
  const filePath = join(dir, 'manifest.yaml');
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
        credentials: []
        sources:
          - name: github-source
            adapter: github@1
            config:
              owner: my-org
              repo: checkout
              token: !!weird ${secret}
        policy:
          allow: []
          writeCredentials: []
`;
  writeFileSync(filePath, manifest, 'utf8');
  try {
    const args = [cliPath, 'apply', '-f', filePath];
    const result = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    });
    assert.notEqual(
      result.status,
      0,
      `expected a non-zero exit for an unresolved YAML tag; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(
      !result.stdout.includes(secret) && !result.stderr.includes(secret),
      `neither stdout nor stderr may echo the credential-shaped config value; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(
      !result.stdout.includes('!!weird') && !result.stderr.includes('!!weird'),
      `neither stdout nor stderr may echo the unresolved tag text; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /not valid YAML at line \d+, column \d+/,
      `the refusal must name only line and column, the same shape invalid syntax already gets; stderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a collection-valued mapping key in the manifest, run through the built CLI, exits non-zero and never lets the key text reach stdout or stderr', async () => {
  // yaml logs this case from toJS itself (a collection key is stringified,
  // and the warning quotes the first 36 characters of the stringified key),
  // so it is a separate path from the parse-time warnings the row above
  // covers, and the assertion is on a prefix of the value.
  const secret = pastedSecret();
  const secretPrefix = secret.slice(0, 16);
  const dir = mkdtempSync(join(tmpdir(), 'aic-cli-apply-'));
  const filePath = join(dir, 'manifest.yaml');
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services: []
? [${secret}]
: 1
`;
  writeFileSync(filePath, manifest, 'utf8');
  try {
    const result = spawnSync(process.execPath, [cliPath, 'apply', '-f', filePath], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    });
    assert.notEqual(
      result.status,
      0,
      `expected a non-zero exit for an unrecognised top-level key; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(
      !result.stdout.includes(secretPrefix) && !result.stderr.includes(secretPrefix),
      `neither stdout nor stderr may echo any of the collection key's text; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest holding more than one YAML document is refused naming only the line and column, before any store call', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const twoDocuments = `${manifestYaml()}---\napiVersion: aic.onboarding/v1\nkind: Onboarding\nservices: []\n`;

  await assert.rejects(
    () => withManifestFile(twoDocuments, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    { message: /is not valid YAML at line \d+, column \d+$/ },
  );
  assert.deepEqual(calls, []);
});

test('a manifest carrying an unresolved YAML tag on an ordinary, non-credential-shaped field is refused before any store call, rather than silently applying the tag\'s fallback value', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();

  await assert.rejects(() =>
    withManifestFile(manifestYaml({ repositoryAliases: ['!!weird extra-alias'] }), (filePath) =>
      runApplyCommand(['-f', filePath], { store, stdout }),
    ),
  );
  assert.deepEqual(calls, []);
});

/* -------------------------------------------------------------------------- */
/* drift: source config key set (added/removed key, not only a changed value) */
/* -------------------------------------------------------------------------- */

function sourceOnlySnapshot(config) {
  const serviceId = randomUUID();
  const environmentId = randomUUID();
  const sourceId = randomUUID();
  return {
    services: [{ id: serviceId, name: 'checkout', repositoryAliases: [] }],
    environments: [{ id: environmentId, serviceId, name: 'staging' }],
    credentialRefs: [],
    sourceBindings: [
      {
        id: sourceId,
        environmentId,
        name: 'github-source',
        adapterId: 'github',
        adapterVersion: '1',
        config,
        credentialRefId: null,
      },
    ],
    actionPolicies: [],
  };
}

function sourceOnlyManifest(configYaml) {
  return `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
        sources:
          - name: github-source
            adapter: github@1
            config:
${configYaml}
`;
}

test('a source config declaring a key the stored SourceBinding does not have is reported as drift naming only the config field', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(sourceOnlySnapshot({}));
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(sourceOnlyManifest('              owner: my-org'), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const sourceRow = rows().find((row) => row.entity === 'source');
  assert.deepEqual(sourceRow, {
    action: 'drift',
    entity: 'source',
    service: 'checkout',
    environment: 'staging',
    name: 'github-source',
    fields: ['config'],
  });
  assert.equal(calls.some((call) => call.method === 'addSourceBinding'), false);
});

test('a source config missing a key the stored SourceBinding has is reported as drift naming only the config field', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(sourceOnlySnapshot({ owner: 'my-org' }));
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(sourceOnlyManifest('              {}'), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const sourceRow = rows().find((row) => row.entity === 'source');
  assert.deepEqual(sourceRow, {
    action: 'drift',
    entity: 'source',
    service: 'checkout',
    environment: 'staging',
    name: 'github-source',
    fields: ['config'],
  });
  assert.equal(calls.some((call) => call.method === 'addSourceBinding'), false);
});

/* -------------------------------------------------------------------------- */
/* drift: credential access                                                   */
/* -------------------------------------------------------------------------- */

test('a CredentialRef whose access differs from the stored one, with the same name and secret, is reported as drift naming only the access field', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore(onboardedSnapshot());
  const { stdout, rows } = createStdoutSink();

  const result = await withManifestFile(manifestYaml({ credentialAccess: 'write' }), (filePath) =>
    runApplyCommand(['-f', filePath], { store, stdout }),
  );

  assert.deepEqual(result, { clean: false });
  const credentialRow = rows().find((row) => row.entity === 'credential');
  assert.deepEqual(credentialRow, {
    action: 'drift',
    entity: 'credential',
    service: 'checkout',
    environment: 'staging',
    name: 'github-read',
    fields: ['access'],
  });
  assert.equal(calls.some((call) => call.method === 'addCredentialRef'), false);
});

/* -------------------------------------------------------------------------- */
/* duplicate names within one manifest are refused before any store mutation  */
/* -------------------------------------------------------------------------- */

function noMutationCalled(calls) {
  return !calls.some((call) => call.method !== 'snapshot');
}

test('two services declared with the same name in one manifest are refused, naming the duplicate\'s path and the word "duplicate", before any store mutation', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments: []
  - name: checkout
    repositoryAliases: []
    environments: []
`;

  await assert.rejects(
    () => withManifestFile(manifest, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    (error) => {
      assert.match(error.message, /duplicate/i);
      assert.match(error.message, /services\[1\]/);
      return true;
    },
  );
  assert.ok(noMutationCalled(calls), `no store mutation may run: ${JSON.stringify(calls)}`);
});

test('two environments declared with the same name in one service are refused, naming the duplicate\'s path and the word "duplicate", before any store mutation', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
      - name: staging
`;

  await assert.rejects(
    () => withManifestFile(manifest, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    (error) => {
      assert.match(error.message, /duplicate/i);
      assert.match(error.message, /environments\[1\]/);
      return true;
    },
  );
  assert.ok(noMutationCalled(calls), `no store mutation may run: ${JSON.stringify(calls)}`);
});

test('two credentials declared with the same name in one environment are refused, naming the duplicate\'s path and the word "duplicate", before any store mutation', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
        credentials:
          - name: github-read
            secret: ${secretName('GITHUB', 'READ', 'TOKEN')}
            access: read
          - name: github-read
            secret: ${secretName('GITHUB', 'READ', 'TOKEN', 'TWO')}
            access: read
`;

  await assert.rejects(
    () => withManifestFile(manifest, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    (error) => {
      assert.match(error.message, /duplicate/i);
      assert.match(error.message, /credentials\[1\]/);
      return true;
    },
  );
  assert.ok(noMutationCalled(calls), `no store mutation may run: ${JSON.stringify(calls)}`);
});

test('two sources declared with the same name in one environment are refused, naming the duplicate\'s path and the word "duplicate", before any store mutation', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const manifest = `apiVersion: aic.onboarding/v1
kind: Onboarding
services:
  - name: checkout
    repositoryAliases: []
    environments:
      - name: staging
        sources:
          - name: github-source
            adapter: github@1
            config:
              owner: my-org
              repo: checkout
          - name: github-source
            adapter: github@2
            config:
              owner: my-org
              repo: checkout
`;

  await assert.rejects(
    () => withManifestFile(manifest, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    (error) => {
      assert.match(error.message, /duplicate/i);
      assert.match(error.message, /sources\[1\]/);
      return true;
    },
  );
  assert.ok(noMutationCalled(calls), `no store mutation may run: ${JSON.stringify(calls)}`);
});

/* -------------------------------------------------------------------------- */
/* top-level unknown key wording: never doubles the word "manifest"           */
/* -------------------------------------------------------------------------- */

test('an unknown top-level manifest key is refused with a message that names "manifest" exactly once, not "manifest manifest"', async () => {
  const { runApplyCommand } = await loadApplyCommand();
  const { store, calls } = createFakeRegistryStore();
  const { stdout } = createStdoutSink();
  const unknownTopLevelKeyYaml = `apiVersion: aic.onboarding/v1\nkind: Onboarding\nservices: []\nunexpected: true\n`;

  await assert.rejects(
    () => withManifestFile(unknownTopLevelKeyYaml, (filePath) => runApplyCommand(['-f', filePath], { store, stdout })),
    { message: /^manifest carries an unrecognised key/ },
  );
  assert.deepEqual(calls, []);
});

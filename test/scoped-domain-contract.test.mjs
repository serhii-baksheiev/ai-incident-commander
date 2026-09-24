/**
 * AIC-96, slice A: the scoped domain types `docs/decisions/integration-boundary.md`
 * is built against - `Service`, `Environment`, `SourceBinding`, `CredentialRef`,
 * `ActionPolicy`, the `RegistrySnapshot` that holds them consistent, and the
 * `primaryScope` an incident carries.
 *
 * This file does not touch `IncidentSchema`, `IncidentStateSchema`,
 * `INCIDENT_STATE_SCHEMA_VERSION`, the graph, evals or roles - that wiring is
 * slice B, a later PR (see the ADR's "Consequences").
 *
 * Every `secretName` fixture below is deliberately kept UNDER sixteen
 * characters: `.claude/scripts/lib/secrets.mjs`'s `assigned-secret` pattern
 * reads a credential keyword next to a long value, and `secretName` itself
 * contains the keyword "secret". A realistic name here would otherwise be
 * indistinguishable, to that scanner, from an assigned credential VALUE -
 * see that module's own documented limit ("Sixteen characters ... keeps
 * `.env.example` committable"). `credential-ref-secrets.test.mjs` is where
 * that scanner is exercised on purpose, with values assembled at runtime.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import * as domain from '@aic/domain';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(
  projectRoot,
  'test/fixtures/scoped-domain-type-contract.ts',
);

const serviceA = randomUUID();
const serviceB = randomUUID();
const environmentA = randomUUID();
const environmentB = randomUUID();
const sourceBindingA = randomUUID();
const credentialReadA = randomUUID();
const credentialWriteA = randomUUID();
const credentialReadB = randomUUID();
const credentialWriteB = randomUUID();
const actionPolicyA = randomUUID();

const serviceInput = () => ({
  name: 'checkout',
  repositoryAliases: ['org/checkout-service'],
});

const service = () => ({ id: serviceA, ...serviceInput() });

const environment = () => ({ id: environmentA, serviceId: serviceA, name: 'production' });

const credentialRef = () => ({
  id: credentialReadA,
  environmentId: environmentA,
  access: 'read',
  name: 'checkout-read',
  secretName: 'CHECKOUT_READ',
});

const writeCredentialRef = () => ({
  id: credentialWriteA,
  environmentId: environmentA,
  access: 'write',
  name: 'checkout-write',
  secretName: 'CHECKOUT_WRITE',
});

const sourceBinding = () => ({
  id: sourceBindingA,
  environmentId: environmentA,
  adapterId: 'github-actions',
  adapterVersion: '1.0.0',
  name: 'github-actions-primary',
  config: { owner: 'org', repo: 'checkout-service' },
  credentialRefId: credentialReadA,
});

const actionPolicy = () => ({
  id: actionPolicyA,
  environmentId: environmentA,
  allowedActionTypes: ['restart-service'],
  writeCredentialRefIds: [credentialWriteA],
});

const registry = () => ({
  services: [service()],
  environments: [environment()],
  sourceBindings: [sourceBinding()],
  credentialRefs: [credentialRef(), writeCredentialRef()],
  actionPolicies: [actionPolicy()],
});

const twoEnvironmentRegistry = () => ({
  services: [
    { id: serviceA, name: 'checkout', repositoryAliases: ['org/checkout-service'] },
    { id: serviceB, name: 'billing', repositoryAliases: ['org/billing-service'] },
  ],
  environments: [
    { id: environmentA, serviceId: serviceA, name: 'production' },
    { id: environmentB, serviceId: serviceB, name: 'production' },
  ],
  sourceBindings: [sourceBinding()],
  credentialRefs: [
    credentialRef(),
    writeCredentialRef(),
    { id: credentialReadB, environmentId: environmentB, access: 'read', name: 'billing-read', secretName: 'BILLING_READ' },
    { id: credentialWriteB, environmentId: environmentB, access: 'write', name: 'billing-write', secretName: 'BILLING_WRITE' },
  ],
  actionPolicies: [actionPolicy()],
});

test('round-trips Service, Environment, SourceBinding, CredentialRef, ActionPolicy and a valid registry', () => {
  const fixtures = [
    ['ServiceSchema', service()],
    ['EnvironmentSchema', environment()],
    ['SourceBindingSchema', sourceBinding()],
    ['CredentialRefSchema', credentialRef()],
    ['ActionPolicySchema', actionPolicy()],
    ['RegistrySnapshotSchema', registry()],
  ];

  for (const [name, fixture] of fixtures) {
    assert.deepEqual(domain[name].parse(fixture), fixture, `${name} must round-trip`);
  }
});

test("refuses an id on ServiceInput, and keeps a Service's id when its name and aliases change", () => {
  const withId = { id: serviceA, ...serviceInput() };
  assert.equal(
    domain.ServiceInputSchema.safeParse(withId).success,
    false,
    'a caller-supplied id is an unrecognized key on ServiceInput',
  );

  const renamed = {
    id: serviceA,
    name: 'checkout-v2',
    repositoryAliases: ['org/checkout-v2'],
  };
  assert.equal(domain.ServiceSchema.safeParse(renamed).success, true);

  const registrySnapshot = registry();
  registrySnapshot.services = [renamed];
  const scoped = domain.checkPrimaryScope(registrySnapshot, {
    serviceId: serviceA,
    environmentId: environmentA,
  });
  assert.deepEqual(
    scoped,
    { ok: true, environment: registrySnapshot.environments[0] },
    'a renamed Service must keep resolving the same environment by id',
  );
});

/**
 * ADR decision 4: "A repository is an alias or a source of evidence, not
 * identity" - renaming or moving a repository never changes which Service an
 * incident belongs to, which only holds if a repository-style NAME can never
 * BE a registry id in the first place. `RegistryIdSchema = z.uuid()`
 * (scope.ts) is the mechanism; this pins it against the two shapes decision 4
 * exists to keep out, on every place a registry id is checked outside a full
 * RegistrySnapshot: PrimaryScopeSchema and ServiceSchema's own id.
 */
test('refuses a repository-style name or a bare word as a registry id, and accepts a UUID', () => {
  const repositoryStyleNames = ['payments-api', 'checkout-service'];
  const bareWords = ['checkout'];

  for (const invalidId of [...repositoryStyleNames, ...bareWords]) {
    assert.equal(
      domain.PrimaryScopeSchema.safeParse({ serviceId: invalidId, environmentId: environmentA }).success,
      false,
      `PrimaryScopeSchema must refuse "${invalidId}" as serviceId`,
    );
    assert.equal(
      domain.PrimaryScopeSchema.safeParse({ serviceId: serviceA, environmentId: invalidId }).success,
      false,
      `PrimaryScopeSchema must refuse "${invalidId}" as environmentId`,
    );
    assert.equal(
      domain.ServiceSchema.safeParse({ id: invalidId, ...serviceInput() }).success,
      false,
      `ServiceSchema must refuse "${invalidId}" as a Service id`,
    );
  }

  assert.equal(
    domain.PrimaryScopeSchema.safeParse({ serviceId: randomUUID(), environmentId: randomUUID() }).success,
    true,
    'a UUID must still be accepted as a registry id in PrimaryScopeSchema',
  );
  assert.equal(
    domain.ServiceSchema.safeParse({ id: randomUUID(), ...serviceInput() }).success,
    true,
    'a UUID must still be accepted as a Service id',
  );
});

const referenceFieldTable = [
  {
    field: 'Environment.serviceId',
    mutate: (candidate) => {
      candidate.environments[0].serviceId = randomUUID();
    },
    path: ['environments', 0, 'serviceId'],
  },
  {
    field: 'CredentialRef.environmentId',
    mutate: (candidate) => {
      candidate.credentialRefs[0].environmentId = randomUUID();
    },
    path: ['credentialRefs', 0, 'environmentId'],
  },
  {
    field: 'SourceBinding.environmentId',
    mutate: (candidate) => {
      candidate.sourceBindings[0].environmentId = randomUUID();
    },
    path: ['sourceBindings', 0, 'environmentId'],
  },
  {
    field: 'ActionPolicy.environmentId',
    mutate: (candidate) => {
      candidate.actionPolicies[0].environmentId = randomUUID();
    },
    path: ['actionPolicies', 0, 'environmentId'],
  },
  {
    field: 'SourceBinding.credentialRefId',
    mutate: (candidate) => {
      candidate.sourceBindings[0].credentialRefId = credentialReadB;
    },
    path: ['sourceBindings', 0, 'credentialRefId'],
  },
  {
    field: 'ActionPolicy.writeCredentialRefIds',
    mutate: (candidate) => {
      candidate.actionPolicies[0].writeCredentialRefIds = [credentialWriteB];
    },
    path: ['actionPolicies', 0, 'writeCredentialRefIds', 0],
  },
];

test('refuses a reference to another environment’s record, naming the field', () => {
  const base = twoEnvironmentRegistry();
  assert.equal(
    domain.RegistrySnapshotSchema.safeParse(base).success,
    true,
    'the unmutated two-environment registry must parse, or the refusals below prove nothing',
  );

  for (const row of referenceFieldTable) {
    const candidate = structuredClone(base);
    row.mutate(candidate);
    const result = domain.RegistrySnapshotSchema.safeParse(candidate);
    assert.equal(result.success, false, `${row.field} must be refused`);

    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    assert.ok(
      paths.includes(row.path.join('.')),
      `${row.field}: expected an issue naming ${row.path.join('.')}, got ${JSON.stringify(paths)}`,
    );
  }
});

test('covers every reference field the scoped schemas declare', () => {
  const schemas = {
    Environment: domain.EnvironmentSchema,
    SourceBinding: domain.SourceBindingSchema,
    CredentialRef: domain.CredentialRefSchema,
    ActionPolicy: domain.ActionPolicySchema,
  };

  const isRegistryIdField = (fieldSchema) =>
    fieldSchema === domain.RegistryIdSchema || fieldSchema?.element === domain.RegistryIdSchema;

  const declared = [];
  for (const [schemaName, schema] of Object.entries(schemas)) {
    for (const [key, fieldSchema] of Object.entries(schema.shape)) {
      if (key === 'id') continue;
      if (!/Ids?$/.test(key)) continue;
      if (!isRegistryIdField(fieldSchema)) continue;
      declared.push(`${schemaName}.${key}`);
    }
  }

  assert.ok(
    declared.length > 0,
    'the derivation must find at least one reference field, or this test checks nothing',
  );

  const covered = new Set(referenceFieldTable.map((row) => row.field));
  for (const field of declared) {
    assert.ok(
      covered.has(field),
      `${field} is a reference field the schema declares but referenceFieldTable does not cover it`,
    );
  }
});

test('refuses a read credential on an ActionPolicy and a write credential on a SourceBinding', () => {
  const base = twoEnvironmentRegistry();
  assert.equal(domain.RegistrySnapshotSchema.safeParse(base).success, true);

  const writeOnSourceBinding = structuredClone(base);
  writeOnSourceBinding.sourceBindings[0].credentialRefId = credentialWriteA;
  assert.equal(
    domain.RegistrySnapshotSchema.safeParse(writeOnSourceBinding).success,
    false,
    'a SourceBinding must never resolve to a write credential',
  );

  const readOnActionPolicy = structuredClone(base);
  readOnActionPolicy.actionPolicies[0].writeCredentialRefIds = [credentialReadA];
  assert.equal(
    domain.RegistrySnapshotSchema.safeParse(readOnActionPolicy).success,
    false,
    'an ActionPolicy must never accept a read credential as a write ref',
  );
});

test('refuses a write and a read CredentialRef naming one secret', () => {
  const base = twoEnvironmentRegistry();
  assert.equal(domain.RegistrySnapshotSchema.safeParse(base).success, true);

  const candidate = structuredClone(base);
  const write = candidate.credentialRefs.find((ref) => ref.id === credentialWriteA);
  const read = candidate.credentialRefs.find((ref) => ref.id === credentialReadA);
  write.secretName = read.secretName;

  assert.equal(
    domain.RegistrySnapshotSchema.safeParse(candidate).success,
    false,
    'a write ref must never name the same secret as a read ref in the same environment',
  );
});

test('refuses a second ActionPolicy for one Environment', () => {
  const base = twoEnvironmentRegistry();
  assert.equal(domain.RegistrySnapshotSchema.safeParse(base).success, true);

  const candidate = structuredClone(base);
  candidate.actionPolicies.push({
    id: randomUUID(),
    environmentId: environmentA,
    allowedActionTypes: ['restart-service'],
    writeCredentialRefIds: [credentialWriteA],
  });

  assert.equal(
    domain.RegistrySnapshotSchema.safeParse(candidate).success,
    false,
    'at most one ActionPolicy may exist per Environment',
  );
});

test('checkPrimaryScope refuses an environment owned by another service', () => {
  const registrySnapshot = twoEnvironmentRegistry();

  assert.deepEqual(
    domain.checkPrimaryScope(registrySnapshot, { serviceId: serviceA, environmentId: environmentA }),
    { ok: true, environment: registrySnapshot.environments[0] },
  );

  assert.deepEqual(
    domain.checkPrimaryScope(registrySnapshot, { serviceId: serviceA, environmentId: environmentB }),
    { ok: false, reason: 'environment-of-another-service' },
  );

  assert.deepEqual(
    domain.checkPrimaryScope(registrySnapshot, { serviceId: randomUUID(), environmentId: environmentA }),
    { ok: false, reason: 'unknown-service' },
  );

  assert.deepEqual(
    domain.checkPrimaryScope(registrySnapshot, { serviceId: serviceA, environmentId: randomUUID() }),
    { ok: false, reason: 'unknown-environment' },
  );
});

const validIntake = () => ({
  primaryScope: { serviceId: serviceA, environmentId: environmentA },
  title: 'Checkout failures',
  startedAt: '2026-09-23T10:00:00Z',
  signals: [
    {
      source: 'pagerduty',
      statement: 'checkout error rate spike',
      observedAt: '2026-09-23T10:00:00Z',
    },
  ],
});

test('an intake requires a primaryScope, and refuses a name where an id belongs', () => {
  assert.equal(
    domain.IncidentIntakeSchema.safeParse(validIntake()).success,
    true,
    'the fixture intake must parse, or the refusals below prove nothing',
  );

  const missingScope = validIntake();
  delete missingScope.primaryScope;
  assert.equal(domain.IncidentIntakeSchema.safeParse(missingScope).success, false, 'primaryScope is required');

  const malformedScope = validIntake();
  malformedScope.primaryScope = { serviceId: serviceA };
  assert.equal(
    domain.IncidentIntakeSchema.safeParse(malformedScope).success,
    false,
    'primaryScope must carry both serviceId and environmentId',
  );

  const nameAsServiceId = validIntake();
  nameAsServiceId.primaryScope = { serviceId: 'checkout', environmentId: environmentA };
  assert.equal(
    domain.IncidentIntakeSchema.safeParse(nameAsServiceId).success,
    false,
    'a Service name is not a serviceId: primaryScope.serviceId must be a registry id, not a name',
  );
});

test('compiles the scoped type contract', () => {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeContractFixture,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: childEnv(),
    },
  );

  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test('the domain package imports only zod, node:crypto and its own modules', () => {
  const domainSrc = resolve(projectRoot, 'packages/domain/src');
  const files = readdirSync(domainSrc).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length > 0, 'the domain package must have source files, or this scan checks nothing');

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(resolve(domainSrc, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      const isImportOrExportWithSource =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier);
      if (isImportOrExportWithSource) {
        const specifier = node.moduleSpecifier.text;
        const allowed = specifier === 'zod' || specifier === 'node:crypto' || specifier.startsWith('./');
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }

  assert.deepEqual(
    offenders,
    [],
    `packages/domain/src must import only zod, node:crypto or its own modules:\n${offenders.join('\n')}`,
  );
});

test('states its limit: a read and a write CredentialRef in different Environments may name one secret', () => {
  const base = twoEnvironmentRegistry();
  const candidate = structuredClone(base);
  const readA = candidate.credentialRefs.find((ref) => ref.id === credentialReadA);
  const writeB = candidate.credentialRefs.find((ref) => ref.id === credentialWriteB);
  writeB.secretName = readA.secretName;

  assert.equal(
    domain.RegistrySnapshotSchema.safeParse(candidate).success,
    true,
    'the read/write secret-collision refusal is scoped to one Environment; across Environments it is accepted',
  );
  const source = readFileSync(resolve(projectRoot, 'packages/domain/src/scope.ts'), 'utf8');
  assert.match(
    source,
    /scoped-domain-contract\.test\.mjs › "states its limit: a read and a write CredentialRef in different Environments may name one secret"/,
    'scope.ts must state the Environment scoping of that refusal and point at this row',
  );
});

test('names the offending writeCredentialRefIds element and why it is refused', () => {
  const base = twoEnvironmentRegistry();
  const candidate = structuredClone(base);
  const policy = candidate.actionPolicies.find((entry) => entry.environmentId === environmentA);
  const policyIndex = candidate.actionPolicies.indexOf(policy);
  policy.writeCredentialRefIds = [credentialWriteA, credentialReadA, credentialWriteB, randomUUID()];

  const result = domain.RegistrySnapshotSchema.safeParse(candidate);
  assert.equal(result.success, false);
  const byIndex = new Map(
    result.error.issues
      .filter((issue) => issue.path[0] === 'actionPolicies' && issue.path[2] === 'writeCredentialRefIds')
      .map((issue) => [issue.path[3], issue.message]),
  );
  assert.deepEqual([...byIndex.keys()].sort(), [1, 2, 3], 'each refused element is named by its own index');
  assert.match(byIndex.get(1), /read/i, 'element 1 is refused for being a read credential');
  assert.match(byIndex.get(2), /Environment/, 'element 2 is refused for belonging to another Environment');
  assert.match(byIndex.get(3), /known/i, 'element 3 is refused for naming no CredentialRef at all');
  assert.equal(result.error.issues.every((issue) => issue.path[1] === policyIndex || issue.path[0] !== 'actionPolicies'), true);
});

test('refuses one Service listing the same repository alias twice, and says so', () => {
  const base = twoEnvironmentRegistry();
  const candidate = structuredClone(base);
  const first = candidate.services[0];
  first.repositoryAliases = [...first.repositoryAliases, first.repositoryAliases[0]];

  const result = domain.RegistrySnapshotSchema.safeParse(candidate);
  assert.equal(result.success, false);
  const aliasIssue = result.error.issues.find((issue) => issue.path[2] === 'repositoryAliases');
  assert.ok(aliasIssue, 'the duplicate alias is refused at its own path');
  assert.doesNotMatch(aliasIssue.message, /another Service/, 'a duplicate inside one Service must not be reported as another Service using it');
});

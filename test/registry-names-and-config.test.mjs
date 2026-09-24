/**
 * AIC-99, slice b: `SourceBinding` and `CredentialRef` gain a slug `name`,
 * unique per Environment, and `SourceBinding` gains a per-adapter `config`
 * object - the natural key `aic apply -f` matches file entries against, and
 * the adapter configuration `aic source add` writes (the lab's `baseUrl`,
 * GitHub's `owner`/`repo`). `credentialRefId` becomes nullable, for an
 * adapter that takes no credential at all (`lab@1`,
 * incident-lab/src/scenario-candidates.mjs). All three are the owner's
 * 2026-09-25 ruling on AIC-99.
 *
 * The domain does not know adapter-specific config keys - `baseUrl`,
 * `owner` and `repo` are only meaningful to the adapter catalog, a later
 * slice (see packages/tools/src/lab-source.ts and github-source.ts for
 * where they are actually consumed). It only enforces the SHAPE every
 * adapter's config must fit: slug-like keys, short string values, a small
 * key count - and refuses a value that looks like a credential, because
 * credentials travel only through a CredentialRef.
 *
 * Every row below that asserts a refusal also asserts the refusal is not
 * merely "name/config is not a key this schema declares" (`code:
 * 'unrecognized_keys'`, confirmed against zod's own output). That code
 * proves only that a schema has not been told about a key at all - it says
 * nothing about whether the FIELD's own shape (a slug, a bounded config
 * object, a nullable id) is what is being judged, which is the thing each
 * row actually names. `assertRefusedForOwnShape` is the one assertion every
 * negative row here shares, so a refusal is only ever accepted as proof of
 * the row's own invariant.
 *
 * Independent oracle (`.claude/rules/invariants.md`): `github_pat_`/`ghp_`,
 * `AKIA...` and `xox[baprs]-...` are recognised by this
 * repository's own credential vocabulary (`findSecretValues`,
 * `.claude/scripts/lib/secrets.mjs`), used here to establish the premise
 * that a value really does read as that credential shape, independently of
 * whatever scope.ts ends up doing. `Bearer <token>` and
 * `scheme://user:pass@host` userinfo are not in that vocabulary (grep
 * `.claude/scripts/lib/secrets.mjs` for `Bearer` or `user:pass`; neither
 * appears), so those two are asserted directly, by the literal shape the
 * ruling names, with no second implementation to check them against.
 *
 * Every credential-shaped value is assembled at runtime from parts, never
 * written out as one contiguous literal (`.claude/rules/autonomy.md`; see
 * credential-ref-secrets.test.mjs's header for the full rationale). Every
 * `secretName` fixture stays under sixteen characters for the same reason
 * credential-ref-secrets.test.mjs's own fixtures do (see that file's
 * header): a longer one reads, to `.claude/scripts/lib/secrets.mjs`'s
 * `assigned-secret` pattern, like an assigned credential VALUE next to the
 * word "secret" in `secretName`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';

import { findSecretValues } from '../.claude/scripts/lib/secrets.mjs';

const serviceA = randomUUID();
const serviceB = randomUUID();
const environmentA = randomUUID();
const environmentB = randomUUID();
const credentialA = randomUUID();
const credentialB = randomUUID();
const bindingA = randomUUID();
const bindingA2 = randomUUID();
const bindingB = randomUUID();

const service = (id, name) => ({ id, name, repositoryAliases: [] });
const environment = (id, serviceId, name) => ({ id, serviceId, name });

const credentialRef = (overrides = {}) => ({
  id: credentialA,
  environmentId: environmentA,
  access: 'read',
  name: 'checkout-read',
  secretName: 'CHECKOUT_READ',
  ...overrides,
});

const githubBinding = (overrides = {}) => ({
  id: bindingA,
  environmentId: environmentA,
  adapterId: 'github',
  adapterVersion: '1',
  name: 'github-primary',
  config: { owner: 'org', repo: 'checkout-service' },
  credentialRefId: credentialA,
  ...overrides,
});

const labBinding = (overrides = {}) => ({
  id: bindingA,
  environmentId: environmentA,
  adapterId: 'lab',
  adapterVersion: '1',
  name: 'lab-primary',
  config: { baseUrl: 'https://lab.internal.example' },
  credentialRefId: null,
  ...overrides,
});

const registryWith = ({ sourceBindings, credentialRefs }) => ({
  services: [service(serviceA, 'checkout')],
  environments: [environment(environmentA, serviceA, 'production')],
  sourceBindings,
  credentialRefs,
  actionPolicies: [],
});

const twoEnvironmentRegistryWith = ({ sourceBindings, credentialRefs }) => ({
  services: [service(serviceA, 'checkout'), service(serviceB, 'billing')],
  environments: [
    environment(environmentA, serviceA, 'production'),
    environment(environmentB, serviceB, 'production'),
  ],
  sourceBindings,
  credentialRefs,
  actionPolicies: [],
});

/**
 * Shared by every negative row below. A refusal driven only by
 * `unrecognized_keys` proves nothing about the invariant the row names: that
 * code fires for any object carrying a key its schema does not declare,
 * regardless of whether the key's own value would otherwise be valid. See
 * the file header.
 */
function assertRefusedForOwnShape(result, message) {
  assert.equal(result.success, false, message);
  const stillUnrecognized = result.error.issues.some((issue) => issue.code === 'unrecognized_keys');
  assert.equal(
    stillUnrecognized,
    false,
    `${message}: the refusal must judge name/config's own shape, not merely that they are unrecognized keys`,
  );
}

test('accepts a SourceBinding whose config carries the GitHub adapter shape (owner, repo)', () => {
  assert.equal(domain.SourceBindingSchema.safeParse(githubBinding()).success, true);
});

test('accepts a SourceBinding whose config carries the lab adapter shape (baseUrl), with no credential bound', () => {
  assert.equal(domain.SourceBindingSchema.safeParse(labBinding()).success, true);
});

test('refuses a SourceBinding with no name', () => {
  const { name, ...withoutName } = githubBinding();
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(withoutName), 'a SourceBinding with no name must be refused');
});

test('refuses a SourceBinding with no config', () => {
  const { config, ...withoutConfig } = githubBinding();
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(withoutConfig), 'a SourceBinding with no config must be refused');
});

test('accepts a RegistrySnapshot whose SourceBinding has a null credentialRefId (a credential-less adapter, e.g. lab@1)', () => {
  const registry = registryWith({ sourceBindings: [labBinding()], credentialRefs: [] });
  assert.equal(domain.RegistrySnapshotSchema.safeParse(registry).success, true);
});

test('a SourceBinding with a non-null credentialRefId still keeps the existing rule: an unresolvable CredentialRef is refused, naming the field', () => {
  const registry = registryWith({
    sourceBindings: [githubBinding({ credentialRefId: randomUUID() })],
    credentialRefs: [credentialRef()],
  });
  const result = domain.RegistrySnapshotSchema.safeParse(registry);
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some((issue) => /does not name a known CredentialRef/.test(issue.message)),
    'a SourceBinding carrying name and config must still be refused for an unresolvable credentialRefId',
  );
});

test('a SourceBinding with a non-null credentialRefId still keeps the existing rule: resolving to a write CredentialRef is refused', () => {
  const writeCredential = { ...credentialRef(), access: 'write' };
  const registry = registryWith({
    sourceBindings: [githubBinding({ credentialRefId: credentialA })],
    credentialRefs: [writeCredential],
  });
  const result = domain.RegistrySnapshotSchema.safeParse(registry);
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some((issue) => /read CredentialRef/.test(issue.message)),
    'a SourceBinding carrying name and config must still be refused for resolving to a write credential',
  );
});

test('refuses a config key that is not slug-shaped', () => {
  for (const key of ['Owner', 'base-url', '1owner']) {
    const candidate = githubBinding({ config: { [key]: 'value' } });
    assertRefusedForOwnShape(
      domain.SourceBindingSchema.safeParse(candidate),
      `a config key "${key}" must be refused`,
    );
  }
});

test('accepts a config value at the 512-character ceiling', () => {
  const atCeiling = githubBinding({ config: { owner: 'a'.repeat(512) } });
  assert.equal(domain.SourceBindingSchema.safeParse(atCeiling).success, true);
});

test('refuses a config value one character past the 512-character ceiling', () => {
  const overCeiling = githubBinding({ config: { owner: 'a'.repeat(513) } });
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(overCeiling), 'a 513-character config value must be refused');
});

test('refuses an empty-string config value', () => {
  const empty = githubBinding({ config: { owner: '' } });
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(empty), 'an empty-string config value must be refused');
});

function keysConfig(count) {
  const config = {};
  for (let index = 0; index < count; index += 1) {
    config[`key${index}`] = 'v';
  }
  return config;
}

test('accepts a config object with exactly sixteen keys', () => {
  const atLimit = githubBinding({ config: keysConfig(16) });
  assert.equal(domain.SourceBindingSchema.safeParse(atLimit).success, true);
});

test('refuses a config object with seventeen keys', () => {
  const overLimit = githubBinding({ config: keysConfig(17) });
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(overLimit), 'a 17-key config object must be refused');
});

/**
 * `github_pat_`/`ghp_`, `AKIA...` and `xox[baprs]-...` are all recognised by
 * `findSecretValues`; each entry's premise is checked before the
 * corresponding config value is tried, so the expectation comes from that
 * independently-tested vocabulary rather than from scope.ts's own logic.
 */
const oracleBackedCorpus = () => {
  const entries = new Map();
  entries.set('github-pat-short', ['ghp_', 'A'.repeat(20)].join(''));
  entries.set('github-pat-long', ['github_pat_', 'A'.repeat(20)].join(''));
  entries.set('cloud-access-key', ['AKIA', 'B'.repeat(16)].join(''));
  entries.set('slack-token', ['xoxb-', 'A'.repeat(20)].join(''));
  return entries;
};

test('refuses a config value shaped like a GitHub PAT, an AWS access key or a Slack token', () => {
  for (const [label, value] of oracleBackedCorpus()) {
    assert.ok(
      findSecretValues(value).length > 0,
      `premise failed for "${label}": findSecretValues did not recognise ${JSON.stringify(value)}`,
    );
    const candidate = githubBinding({ config: { owner: value } });
    assertRefusedForOwnShape(
      domain.SourceBindingSchema.safeParse(candidate),
      `a config value shaped like "${label}" must be refused`,
    );
  }
});

/**
 * Neither shape is in `findSecretValues`'s vocabulary (see the file
 * header), so these two are asserted directly, exactly as the owner's
 * 2026-09-25 ruling names them, with no second implementation to check
 * them against.
 */
test('refuses a config value carrying userinfo (scheme://user:pass@host)', () => {
  const withUserinfo = ['https', '://', 'user', ':', 'pass', '@', 'internal.example.com'].join('');
  const candidate = githubBinding({ config: { owner: withUserinfo } });
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(candidate), 'a config value carrying userinfo must be refused');
});

test('refuses a config value carrying a Bearer-prefixed token', () => {
  const withBearer = ['Bearer ', 'A'.repeat(20)].join('');
  const candidate = githubBinding({ config: { owner: withBearer } });
  assertRefusedForOwnShape(domain.SourceBindingSchema.safeParse(candidate), 'a Bearer-prefixed config value must be refused');
});

test('never carries a refused secret-shaped config value into the error', () => {
  const values = [...oracleBackedCorpus().values()];
  values.push(['https', '://', 'user', ':', 'pass', '@', 'internal.example.com'].join(''));
  values.push(['Bearer ', 'A'.repeat(20)].join(''));

  for (const value of values) {
    const candidate = githubBinding({ config: { owner: value } });
    const result = domain.SourceBindingSchema.safeParse(candidate);
    assertRefusedForOwnShape(result, `premise: the value ${JSON.stringify(value)} must be refused for its own shape`);
    const serialized = JSON.stringify(result.error.issues);
    assert.ok(!serialized.includes(value), `the serialized issues must not carry the rejected config value "${value}" whole`);
  }
});

test('refuses a CredentialRef with no name', () => {
  const { name, ...withoutName } = credentialRef();
  assertRefusedForOwnShape(domain.CredentialRefSchema.safeParse(withoutName), 'a CredentialRef with no name must be refused');
});

test('accepts a CredentialRef whose name is a slug', () => {
  assert.equal(domain.CredentialRefSchema.safeParse(credentialRef()).success, true);
});

test('refuses two SourceBindings sharing one name within the same Environment', () => {
  const registry = registryWith({
    sourceBindings: [
      githubBinding({ id: bindingA, credentialRefId: credentialA }),
      githubBinding({ id: bindingA2, credentialRefId: credentialA }),
    ],
    credentialRefs: [credentialRef()],
  });
  assertRefusedForOwnShape(
    domain.RegistrySnapshotSchema.safeParse(registry),
    'two SourceBindings sharing a name in one Environment must be refused',
  );
});

test('accepts two SourceBindings sharing one name across different Environments', () => {
  const registry = twoEnvironmentRegistryWith({
    sourceBindings: [
      githubBinding({ id: bindingA, credentialRefId: credentialA }),
      githubBinding({ id: bindingB, environmentId: environmentB, credentialRefId: credentialB }),
    ],
    credentialRefs: [
      credentialRef(),
      { ...credentialRef(), id: credentialB, environmentId: environmentB, name: 'billing-read', secretName: 'BILLING_READ' },
    ],
  });
  assert.equal(domain.RegistrySnapshotSchema.safeParse(registry).success, true);
});

test('refuses two CredentialRefs sharing one name within the same Environment', () => {
  const registry = registryWith({
    sourceBindings: [githubBinding({ credentialRefId: credentialA })],
    credentialRefs: [
      credentialRef(),
      { ...credentialRef(), id: randomUUID(), secretName: 'CHECKOUT_READ2' },
    ],
  });
  assertRefusedForOwnShape(
    domain.RegistrySnapshotSchema.safeParse(registry),
    'two CredentialRefs sharing a name in one Environment must be refused',
  );
});

test('accepts two CredentialRefs sharing one name across different Environments', () => {
  const registry = twoEnvironmentRegistryWith({
    sourceBindings: [githubBinding({ credentialRefId: credentialA })],
    credentialRefs: [
      credentialRef(),
      { ...credentialRef(), id: credentialB, environmentId: environmentB, secretName: 'BILLING_READ' },
    ],
  });
  assert.equal(domain.RegistrySnapshotSchema.safeParse(registry).success, true);
});

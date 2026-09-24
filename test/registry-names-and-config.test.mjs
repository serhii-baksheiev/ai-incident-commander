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
 *
 * AIC-99 slice b, round-1 review: the groups of rows below the original set
 * pin three further requirements. "Bounded work" screens a config whose
 * shape is adversarial (many keys, or very long values) and asserts the
 * screening itself finishes inside a fixed budget, using a real timer and a
 * child process it can kill if the budget is blown - a config value's
 * userinfo-shaped check must not itself become the unbounded work
 * `.claude/rules/invariants.md` describes. "Embedded credentials refused
 * anywhere in a value" and "Correspondence, two-way, over a shared corpus"
 * extend the independent-oracle discipline above to a credential shape
 * embedded ANYWHERE in a value, not only at its start, with a mechanical
 * check that a new `SECRET_VALUE_PATTERNS` family is either mirrored here or
 * named as an explicit, reasoned exclusion. "Keys" and "Prototype-shadowing
 * keys" extend config-key screening to credential-shaped and
 * prototype-shadowing keys, and pin that a refused key is never echoed into
 * the reported issues.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';

import { findSecretValues, SECRET_VALUE_PATTERNS } from '../.claude/scripts/lib/secrets.mjs';

import { childEnv } from './fixtures/child-env.mjs';

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
  // Advisory (AIC-99 round-1 review): located at the field, not merely
  // present somewhere in the issue list - so an unrelated refusal elsewhere
  // in the registry cannot satisfy this row.
  assert.ok(
    result.error.issues.some(
      (issue) =>
        /does not name a known CredentialRef/.test(issue.message) &&
        issue.path.join('.') === 'sourceBindings.0.credentialRefId',
    ),
    'the unresolvable-CredentialRef refusal must be located at sourceBindings.0.credentialRefId',
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
  // Advisory (AIC-99 round-1 review): located at the field, not merely
  // present somewhere in the issue list.
  assert.ok(
    result.error.issues.some(
      (issue) => /read CredentialRef/.test(issue.message) && issue.path.join('.') === 'sourceBindings.0.credentialRefId',
    ),
    'the write-credential refusal must be located at sourceBindings.0.credentialRefId',
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

test('a non-slug name (spaces, capitals) is refused on SourceBinding and on CredentialRef', () => {
  assertRefusedForOwnShape(
    domain.SourceBindingSchema.safeParse(githubBinding({ name: 'Github Primary' })),
    'a SourceBinding whose name is not a slug must be refused',
  );
  assertRefusedForOwnShape(
    domain.CredentialRefSchema.safeParse(credentialRef({ name: 'Github Primary' })),
    'a CredentialRef whose name is not a slug must be refused',
  );
});

// Assembled at runtime from parts, never written out as one contiguous
// literal (see the file header, and .claude/rules/autonomy.md).
const pemPrivateKeyHeaderLine = () => ['-----BEGIN ', 'RSA PRIVATE KEY', '-----'].join('');

/**
 * Bounded work (AIC-99 round-1 review, HOLD 1).
 *
 * The reviewers measured the userinfo-shaped pattern
 * (`scheme://user:pass@`) backtracking quadratically over a value with many
 * colons and no closing `@`, and zod 4 still running the credential-shape
 * `.refine` after the value's own `.max(512)` refine has already failed - so
 * a sixteen-key config of 40,004-character values blocked for about 40
 * seconds. The three rows below pin that screening a config - however wide,
 * however long its values - finishes inside a fixed budget.
 *
 * Each row runs `SourceBindingSchema.safeParse` in a CHILD PROCESS, timed
 * with `process.hrtime.bigint()` around the parse call alone (so the
 * ~90-100ms of node-startup-plus-import overhead measured on this machine
 * never counts against the budget), and kills the child well past the
 * budget if it has not returned - a real timer, and a generous bound, but
 * one that cannot hang the suite for the ~40 seconds (sixteen keys) or the
 * ~7600 seconds a naive quadratic extrapolation gives for one 1 MiB value
 * (measured: killing a bare `spawnSync` after 3000ms already catches it
 * mid-flight, with no output at all).
 */
const BOUNDED_WORK_MS = 250;
const CHILD_PROCESS_KILL_AFTER_MS = 3000;

/**
 * The child script itself stays small and fixed; the candidate travels over
 * STDIN rather than as a `-e` argument. A 1 MiB config value embedded
 * directly in argv overflows the OS argument-list limit (`E2BIG`) before the
 * child even starts, which would fail this row for a reason that has
 * nothing to do with how long `safeParse` takes - and would keep failing it
 * even once the screening itself is fast.
 */
const TIMED_PARSE_CHILD_SCRIPT = [
  "const candidate = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  "import('@aic/domain').then((domain) => {",
  '  const start = process.hrtime.bigint();',
  '  const result = domain.SourceBindingSchema.safeParse(candidate);',
  '  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;',
  '  process.stdout.write(JSON.stringify({ success: result.success, elapsedMs }));',
  '});',
].join('\n');

/**
 * Runs `SourceBindingSchema.safeParse` on a `githubBinding` overridden with
 * `config`, inside a fresh Node process, and reports how long the parse call
 * itself took. Returns `{ timedOut: true }` if the child did not report back
 * within `killAfterMs` - which is itself conclusive evidence the parse call
 * did not finish anywhere near `BOUNDED_WORK_MS`, without this test having to
 * wait out however long an ungoverned implementation actually runs.
 */
function timedParseInChildProcess(config, { killAfterMs = CHILD_PROCESS_KILL_AFTER_MS } = {}) {
  const candidate = {
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId: 'github',
    adapterVersion: '1',
    name: 'github-primary',
    config,
    credentialRefId: randomUUID(),
  };
  const outcome = spawnSync(process.execPath, ['-e', TIMED_PARSE_CHILD_SCRIPT], {
    timeout: killAfterMs,
    encoding: 'utf8',
    input: JSON.stringify(candidate),
    maxBuffer: 8 * 1024 * 1024,
    env: childEnv(),
  });
  if (outcome.error || outcome.signal || !outcome.stdout) return { timedOut: true, killAfterMs };
  return { timedOut: false, ...JSON.parse(outcome.stdout) };
}

test('screens sixteen keys of 40,004-character userinfo-shaped values in under 250ms, and still refuses the binding', () => {
  const config = {};
  for (let index = 0; index < 16; index += 1) config[`key${index}`] = 'a://' + ':'.repeat(40000);
  const outcome = timedParseInChildProcess(config);
  assert.equal(
    outcome.timedOut,
    false,
    `screening must finish within the ${CHILD_PROCESS_KILL_AFTER_MS}ms safety margin, let alone the ${BOUNDED_WORK_MS}ms budget`,
  );
  assert.equal(outcome.success, false, 'sixteen keys of 40,004-character values must still be refused');
  assert.ok(
    outcome.elapsedMs < BOUNDED_WORK_MS,
    `screening must finish in under ${BOUNDED_WORK_MS}ms, took ${outcome.elapsedMs?.toFixed(1)}ms`,
  );
});

test('screens a single 1 MiB config value in under 250ms, and still refuses the binding', () => {
  const config = { owner: 'a://' + ':'.repeat(1024 * 1024) };
  const outcome = timedParseInChildProcess(config);
  assert.equal(
    outcome.timedOut,
    false,
    `screening must finish within the ${CHILD_PROCESS_KILL_AFTER_MS}ms safety margin, let alone the ${BOUNDED_WORK_MS}ms budget`,
  );
  assert.equal(outcome.success, false, 'a 1 MiB config value must still be refused (it exceeds the 512-character ceiling)');
  assert.ok(
    outcome.elapsedMs < BOUNDED_WORK_MS,
    `screening must finish in under ${BOUNDED_WORK_MS}ms, took ${outcome.elapsedMs?.toFixed(1)}ms`,
  );
});

test('screens one thousand keys of 600-character values in under 250ms, and still refuses the binding', () => {
  const config = {};
  for (let index = 0; index < 1000; index += 1) config[`key${index}`] = 'a://' + ':'.repeat(596);
  const outcome = timedParseInChildProcess(config);
  assert.equal(
    outcome.timedOut,
    false,
    `screening must finish within the ${CHILD_PROCESS_KILL_AFTER_MS}ms safety margin, let alone the ${BOUNDED_WORK_MS}ms budget`,
  );
  assert.equal(outcome.success, false, 'one thousand keys must still be refused (it exceeds the sixteen-key ceiling)');
  assert.ok(
    outcome.elapsedMs < BOUNDED_WORK_MS,
    `screening must finish in under ${BOUNDED_WORK_MS}ms, took ${outcome.elapsedMs?.toFixed(1)}ms`,
  );
});

/**
 * Embedded credentials refused anywhere in a value (AIC-99 round-1 review,
 * HOLD 2). The current anchored patterns (`^ghp_`, `^AKIA`, ...) miss a
 * credential embedded after other text - a URL's userinfo, a query string,
 * a leading space. Every positive below is checked against `findSecretValues`
 * first: that is the premise, and it guards against a fixture that only
 * looks like a credential to this file's own eyes.
 */
const embeddedCredentialCorpus = () => {
  const ghp = ['ghp_', 'A'.repeat(20)].join('');
  const entries = new Map();
  entries.set('a GitHub PAT embedded as URL userinfo', ['https://', ghp, '@github.com/o/r'].join(''));
  entries.set('a GitHub PAT after a token= assignment', ['token=', ghp].join(''));
  entries.set('a GitHub PAT preceded by a leading space', [' ', ghp].join(''));
  entries.set('an AWS access key id after an id= assignment', ['id=AKIA', 'B'.repeat(16)].join(''));
  entries.set('a GitHub PAT inside a full URL query string (?token=)', ['https://h.example/x?token=', ghp].join(''));
  entries.set('a gho_ token', ['gho_', 'A'.repeat(20)].join(''));
  entries.set('a ghs_ token', ['ghs_', 'A'.repeat(20)].join(''));
  entries.set('a ghr_ token', ['ghr_', 'A'.repeat(20)].join(''));
  entries.set('an npm_ token', ['npm_', 'A'.repeat(30)].join(''));
  entries.set('an AIza (Google API) key', ['AIza', 'A'.repeat(35)].join(''));
  entries.set('a PEM private-key header line', pemPrivateKeyHeaderLine());
  return entries;
};

test('refuses a config value carrying a recognised credential shape embedded anywhere in it, not only at the start', () => {
  for (const [label, value] of embeddedCredentialCorpus()) {
    assert.ok(findSecretValues(value).length > 0, `premise failed for "${label}": findSecretValues did not recognise ${JSON.stringify(value)}`);
    const candidate = githubBinding({ config: { owner: value } });
    assertRefusedForOwnShape(
      domain.SourceBindingSchema.safeParse(candidate),
      `a config value carrying ${label} must be refused, wherever it sits in the value`,
    );
  }
});

test('refuses a config value carrying an AWS STS session key id (ASIA-prefixed), asserted directly rather than through findSecretValues', () => {
  const asiaKey = ['ASIA', 'C'.repeat(16)].join('');
  assert.equal(
    findSecretValues(asiaKey).length,
    0,
    "premise: findSecretValues's own cloud-access-key pattern is anchored to the literal AKIA prefix and does not recognise " +
      'the ASIA (STS session) prefix, so this row is asserted directly by the literal shape, with no oracle to check it ' +
      'against - the same treatment the file header already gives Bearer and userinfo',
  );
  const candidate = githubBinding({ config: { owner: asiaKey } });
  assertRefusedForOwnShape(
    domain.SourceBindingSchema.safeParse(candidate),
    'a config value carrying an ASIA-shaped AWS session key id must be refused',
  );
});

/**
 * Correspondence, two-way, over a shared corpus (`.claude/rules/invariants.md`,
 * "one mechanism, one implementation"). The domain carries its own,
 * framework-free copy of the credential-shape vocabulary (it cannot import
 * `.claude/scripts/lib/secrets.mjs` - scoped-domain-contract.test.mjs ›
 * "the domain package imports only zod, node:crypto and its own modules").
 * This corpus checks that copy against `findSecretValues` in both
 * directions: a positive from every `SECRET_VALUE_PATTERNS` family this
 * corpus mirrors must be refused, and a spread of benign adapter-config
 * values a real SourceBinding actually carries must be accepted.
 */
const EXCLUDED_SECRET_FAMILIES = new Map([
  [
    'assigned-secret',
    'a KEYWORD+SEPARATOR+VALUE construction, not a fixed-prefix literal shape - reproducing its own bounded ' +
      'candidate walk (secrets.mjs: matches()/GLOBAL_TWIN, capped at MAX_CANDIDATES_PER_LINE) faithfully in a ' +
      'second, framework-free module is exactly the duplicated-complexity risk .claude/rules/invariants.md warns ' +
      'about; the eleven fixed-prefix families below are what this corpus mirrors instead.',
  ],
]);

const secretFamilyCorpus = () => {
  const entries = new Map();
  entries.set('atlassian-token', ['ATATT3x', 'A'.repeat(20)].join(''));
  entries.set('github-pat', ['ghp_', 'A'.repeat(20)].join(''));
  entries.set('cloud-access-key', ['AKIA', 'B'.repeat(16)].join(''));
  entries.set('anthropic-key', ['sk-ant-', 'A'.repeat(20)].join(''));
  entries.set('private-key-block', pemPrivateKeyHeaderLine());
  entries.set('slack-token', ['xoxb-', 'A'.repeat(20)].join(''));
  entries.set('google-api-key', ['AIza', 'A'.repeat(35)].join(''));
  entries.set('stripe-live-key', ['sk_live_', 'A'.repeat(20)].join(''));
  entries.set('openai-project-key', ['sk-proj-', 'A'.repeat(20)].join(''));
  entries.set('npm-token', ['npm_', 'A'.repeat(30)].join(''));
  entries.set('gitlab-pat', ['glpat-', 'A'.repeat(20)].join(''));
  return entries;
};

const benignConfigValues = () => [
  'http://127.0.0.1:8099',
  'https://ghe.example.com',
  'https://api.github.com',
  'org',
  'checkout-service',
  ['git@github.com', ':o/r.git'].join(''),
  'production',
  'staging',
  'us-east-1',
  'v2',
  'checkout',
  'billing-read',
  'application/json',
  '2026-09-25T00:00:00Z',
  'GET',
];

test('every SECRET_VALUE_PATTERNS family is either mirrored by the correspondence corpus or explicitly excluded, with a reason', () => {
  const covered = new Set(secretFamilyCorpus().keys());
  for (const { id } of SECRET_VALUE_PATTERNS) {
    assert.ok(
      covered.has(id) || EXCLUDED_SECRET_FAMILIES.has(id),
      `SECRET_VALUE_PATTERNS gained a family ("${id}") this corpus neither mirrors nor lists as an explicit exclusion`,
    );
  }
});

test('refuses a config value if and only if findSecretValues flags it, over a shared corpus of credential-shaped and benign values', () => {
  const corpus = [...secretFamilyCorpus().values(), ...benignConfigValues()];
  for (const value of corpus) {
    const flaggedBySecretsLib = findSecretValues(value).length > 0;
    const result = domain.SourceBindingSchema.safeParse(githubBinding({ config: { owner: value } }));
    const refusedForItsOwnShape =
      result.success === false && !result.error.issues.every((issue) => issue.code === 'unrecognized_keys');
    assert.equal(
      refusedForItsOwnShape,
      flaggedBySecretsLib,
      `the domain's refusal of ${JSON.stringify(value)} must agree with findSecretValues (findSecretValues flagged it: ${flaggedBySecretsLib})`,
    );
  }
});

/**
 * Keys (AIC-99 round-1 review, HOLD 3). Config keys are never screened for
 * being credential-shaped, and a refused key is echoed verbatim into
 * `issue.path` - which, serialized, leaks the credential into a hook
 * transcript, a CI log or a terminal scrollback exactly as
 * `.claude/scripts/lib/secrets.mjs`'s own header says a guard must not do.
 */
test('refuses a credential-shaped config key, and never echoes the refused key into the reported issues', () => {
  const ghpKey = ['ghp_', 'A'.repeat(20)].join('');
  const result = domain.SourceBindingSchema.safeParse(githubBinding({ config: { [ghpKey]: 'value' } }));
  assert.equal(result.success, false, 'a credential-shaped config key must be refused');
  const serialized = JSON.stringify(result.error.issues);
  assert.ok(
    !serialized.includes(ghpKey),
    `the serialized issues must not carry the refused key ${JSON.stringify(ghpKey)} verbatim`,
  );
});

test('refuses a config key that is itself slug-shaped but reads as a credential anywhere within it', () => {
  const credentialShapedKey = ['a', 'ATATT3x', 'B'.repeat(20)].join('');
  assert.match(
    credentialShapedKey,
    /^[a-z][a-zA-Z0-9]{0,63}$/,
    'premise: the key must itself satisfy the existing slug-key shape, or this row proves nothing beyond that check',
  );
  assert.ok(
    findSecretValues(credentialShapedKey).length > 0,
    `premise failed: findSecretValues did not recognise ${JSON.stringify(credentialShapedKey)} as credential-shaped`,
  );
  assertRefusedForOwnShape(
    domain.SourceBindingSchema.safeParse(githubBinding({ config: { [credentialShapedKey]: 'value' } })),
    'a slug-shaped config key that reads as a credential anywhere within it must be refused',
  );
});

/**
 * Prototype-shadowing keys (AIC-99 round-1 review, HOLD 3). The slug-key
 * regex alone does not exclude the JavaScript prototype-chain property names
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `prototype`;
 * these two rows pin that a config key screen refuses all five, and refuses
 * `__proto__` supplied as an own property through `JSON.parse` rather than
 * silently dropping it with no issue reported at all.
 */
test('refuses constructor, toString, valueOf, hasOwnProperty and prototype as config keys', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']) {
    assertRefusedForOwnShape(
      domain.SourceBindingSchema.safeParse(githubBinding({ config: { [key]: 'value' } })),
      `a config key "${key}" must be refused (prototype-shadowing)`,
    );
  }
});

test('refuses a __proto__ own property supplied through JSON.parse, rather than silently dropping it', () => {
  const config = JSON.parse('{"__proto__":"x"}');
  assert.deepEqual(
    Object.keys(config),
    ['__proto__'],
    'premise: __proto__ must land as an own enumerable property of the parsed config, not the prototype slot',
  );
  assertRefusedForOwnShape(
    domain.SourceBindingSchema.safeParse(githubBinding({ config })),
    'a config carrying __proto__ as an own property must be refused, not silently accepted with the key dropped',
  );
});

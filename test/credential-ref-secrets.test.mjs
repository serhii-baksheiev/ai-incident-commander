/**
 * AIC-96, slice A: CredentialRef never carries a secret's own value, and its
 * secretName field refuses everything this repository's own credential
 * vocabulary recognises as a secret shape.
 *
 * The independent-oracle invariant (`.claude/rules/invariants.md`): the
 * premise of every refusal below - "this value looks like a credential" - is
 * established by `findSecretValues` from `.claude/scripts/lib/secrets.mjs`,
 * not by CredentialRefSchema's own regex. That module is a security/ownership
 * mechanism in its own right (it is what `guard-secret-file` refuses commits
 * on), built and tested independently of the domain package, which is exactly
 * what makes it a valid oracle here rather than the schema checking its own
 * work.
 *
 * Every corpus value is ASSEMBLED AT RUNTIME from parts, never written out as
 * one contiguous literal (`.claude/rules/autonomy.md`: "a fixture needing a
 * credential SHAPE assembles it at runtime instead of writing it out, or the
 * check reports its own test data as a leak"). This is not decoration: this
 * file's own `guard-secret-file` PreToolUse hook refuses a `Write`/`Edit` that
 * carries a contiguous credential-shaped literal, using this exact vocabulary.
 *
 * Registry ids below are real UUIDs (`RegistryIdSchema = z.uuid()`), generated
 * at load time and bound to camelCase names rather than written out as
 * literals: a `<name with "credential" in it> = "<uuid>"` declaration line
 * would itself read, to the `assigned-secret` pattern, like an assigned
 * credential - a UUID is 36 characters, well past its sixteen-character floor.
 * Binding through `randomUUID()` sidesteps this the same way
 * scoped-domain-contract.test.mjs does: the declaration's value is a call
 * expression (never a match, since `(` is outside the value's character
 * class), and every USE of the resulting name is a bare, all-letters
 * identifier (`credentialReadA`), which is exactly the identifier shape
 * `secrets.mjs`'s `IDENTIFIER_VALUE` is built to reject.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';

import {
  CREDENTIAL_WORDS,
  SECRET_VALUE_PATTERNS,
  findSecretValues,
} from '../.claude/scripts/lib/secrets.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scopeSourcePath = join(projectRoot, 'packages', 'domain', 'src', 'scope.ts');

const environmentA = randomUUID();
const serviceA = randomUUID();
const credentialReadA = randomUUID();

const baseCredentialRef = () => ({
  id: credentialReadA,
  environmentId: environmentA,
  access: 'read',
  name: 'checkout-read',
  secretName: 'CHECKOUT_READ',
});

const basePrimaryScope = () => ({ serviceId: serviceA, environmentId: environmentA });

const baseSignal = () => ({
  source: 'pagerduty',
  statement: 'checkout error rate spike',
  observedAt: '2026-09-23T10:00:00Z',
});

const baseIntake = () => ({
  primaryScope: basePrimaryScope(),
  title: 'Checkout failures',
  startedAt: '2026-09-23T10:00:00Z',
  signals: [baseSignal()],
});

test('CredentialRef declares exactly id, environmentId, access, name, secretName', () => {
  assert.deepEqual(
    Object.keys(domain.CredentialRefSchema.shape).sort(),
    ['access', 'environmentId', 'id', 'name', 'secretName'].sort(),
  );
});

test("refuses every credential word, and 'value', as an extra key on CredentialRef, primaryScope, Signal and the intake", () => {
  const extraKeys = [...CREDENTIAL_WORDS, 'value'];

  const targets = [
    ['CredentialRefSchema', domain.CredentialRefSchema, baseCredentialRef()],
    ['PrimaryScopeSchema', domain.PrimaryScopeSchema, basePrimaryScope()],
    ['SignalSchema', domain.SignalSchema, baseSignal()],
    ['IncidentIntakeSchema', domain.IncidentIntakeSchema, baseIntake()],
  ];

  for (const [name, schema, fixture] of targets) {
    assert.equal(schema.safeParse(fixture).success, true, `${name}'s own fixture must parse, or the refusals below prove nothing`);

    for (const key of extraKeys) {
      const candidate = { ...fixture, [key]: 'x'.repeat(20) };
      assert.equal(
        schema.safeParse(candidate).success,
        false,
        `${name} must refuse an unrecognized "${key}" key`,
      );
    }
  }
});

/**
 * One corpus entry per `SECRET_VALUE_PATTERNS` id, each assembled from parts
 * rather than written as one literal (see the file header). `value` is what
 * gets tried as `secretName`; `oracleLine` is what `findSecretValues` is run
 * against to establish the premise that `value` (or, for `assigned-secret`,
 * the line built around it) really does read as a credential to this
 * repository's own vocabulary.
 *
 * `assigned-secret` is the one pattern that needs a keyword + separator
 * context to fire at all - a bare value never matches it - so its oracleLine
 * supplies that context, built from `CREDENTIAL_WORDS` itself rather than a
 * hardcoded keyword, while `value` stays the bare fragment that is actually
 * tried as a `secretName`. Its value is deliberately mixed letters+digits: an
 * all-letters value is the identifier `assigned-secret` itself is built to
 * ignore (see secrets.mjs's `IDENTIFIER_VALUE`).
 */
const corpus = () => {
  const entries = new Map();
  entries.set('atlassian-token', ['ATATT3x', 'A'.repeat(20)].join(''));
  entries.set('github-pat', ['ghp_', 'A'.repeat(20)].join(''));
  entries.set('cloud-access-key', ['AKIA', 'B'.repeat(16)].join(''));
  entries.set('anthropic-key', ['sk-ant-', 'A'.repeat(20)].join(''));
  entries.set('private-key-block', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''));
  entries.set('slack-token', ['xoxb-', 'A'.repeat(20)].join(''));
  entries.set('google-api-key', ['AIza', 'A'.repeat(35)].join(''));
  entries.set('stripe-live-key', ['sk_live_', 'A'.repeat(20)].join(''));
  entries.set('openai-project-key', ['sk-proj-', 'A'.repeat(20)].join(''));
  entries.set('npm-token', ['npm_', 'A'.repeat(32)].join(''));
  entries.set('gitlab-pat', ['glpat-', 'A'.repeat(20)].join(''));

  const assignedValue = ['A1b2C3d4', 'E5f6G7h8'].join('');
  const assignedKeyword = [...CREDENTIAL_WORDS].find((word) => word === 'secret');
  if (!assignedKeyword) throw new Error('CREDENTIAL_WORDS no longer carries "secret"; the assigned-secret oracle line needs a real keyword');
  entries.set('assigned-secret', {
    value: assignedValue,
    oracleLine: [assignedKeyword, ' = ', assignedValue].join(''),
  });

  return entries;
};

test('has a corpus entry for every pattern id in the vocabulary', () => {
  const ids = SECRET_VALUE_PATTERNS.map((entry) => entry.id);
  assert.ok(ids.length > 0, 'the vocabulary must declare at least one pattern, or this test checks nothing');

  const entries = corpus();
  for (const id of ids) {
    assert.ok(entries.has(id), `the corpus has no entry for pattern id "${id}"`);
  }
});

test('refuses every secret shape the repository’s vocabulary knows, as a secretName', () => {
  const entries = corpus();

  for (const [id, entry] of entries) {
    const value = typeof entry === 'string' ? entry : entry.value;
    const oracleLine = typeof entry === 'string' ? entry : entry.oracleLine;

    const findings = findSecretValues(oracleLine);
    assert.ok(
      findings.some((finding) => finding.id === id),
      `premise failed for "${id}": findSecretValues did not report it on ${JSON.stringify(oracleLine)}`,
    );

    const candidate = { ...baseCredentialRef(), secretName: value };
    assert.equal(
      domain.CredentialRefSchema.safeParse(candidate).success,
      false,
      `CredentialRefSchema must refuse a secretName shaped like "${id}"`,
    );
  }
});

test('accepts ordinary secret names', () => {
  for (const secretName of ['DATADOG_READ_API_KEY', 'GITHUB_FIXTURE_TOKEN']) {
    const candidate = { ...baseCredentialRef(), secretName };
    assert.equal(
      domain.CredentialRefSchema.safeParse(candidate).success,
      true,
      `CredentialRefSchema must accept the ordinary secret name "${secretName}"`,
    );
  }
});

test('never carries the rejected value into the error', () => {
  const entries = corpus();

  for (const [id, entry] of entries) {
    const value = typeof entry === 'string' ? entry : entry.value;
    const candidate = { ...baseCredentialRef(), secretName: value };
    const result = domain.CredentialRefSchema.safeParse(candidate);
    assert.equal(result.success, false, `premise: "${id}" must still be refused`);

    const serialized = JSON.stringify(result.error.issues);
    assert.ok(!serialized.includes(value), `the serialized issues for "${id}" must not carry the rejected value whole`);

    for (let start = 0; start + 8 <= value.length; start += 1) {
      const slice = value.slice(start, start + 8);
      assert.ok(
        !serialized.includes(slice),
        `the serialized issues for "${id}" must not carry the 8-character slice "${slice}" of the rejected value`,
      );
    }
  }
});

test('states its limit: an uppercase-underscore random value is accepted', () => {
  const randomShaped = ['RAND', randomBytes(8).toString('hex').toUpperCase()].join('_');
  assert.equal(
    domain.SecretNameSchema.safeParse(randomShaped).success,
    true,
    'an uppercase-underscore random value is accepted: SecretNameSchema cannot tell it apart from a real secret name, which is the documented false negative',
  );

  const source = readFileSync(scopeSourcePath, 'utf8');
  assert.match(
    source,
    /credential-ref-secrets\.test\.mjs\s*›\s*"states its limit: an uppercase-underscore random value is accepted"/,
    'scope.ts must document this limit with a pointer to this test, not free-standing prose (`.claude/rules/invariants.md`, "State the limits - and test them")',
  );
});

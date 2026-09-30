/**
 * AIC-21 slice 2: the two `ProposedAction` shapes — a model-facing
 * `ProposedActionDraftSchema` and the audited `ProposedActionRecordSchema` —
 * plus `ACTION_PARAMS_SCHEMAS`, the frozen per-action-type params map.
 *
 * ## Scope
 *
 * This file pins the draft and record SHAPES only. It does not build a
 * `ProposedAction` from untrusted input, resolve risk against the registry,
 * apply an `ActionPolicy`, or check cited evidence against state — that
 * boundary function (`buildProposedAction`), `ProposalRefusalReasonSchema`,
 * `parseProposedActionRecord` and the branded `ProposedAction` type belong to
 * a later, Tier-2, owner-gated slice. Nothing here calls any of those four.
 *
 * ## Why the draft is strict and rejects, not strips
 *
 * `risk`, `idempotencyKey`, `primaryScope`, `incidentId`,
 * `writeCredentialRefId`, `contractVersion` and `proposedBy` are all
 * server-derived facts about a proposal, never a model's to state. A model
 * (or a HITL "modify") supplying any of them is refused outright —
 * `z.strictObject` reports `unrecognized_keys` rather than silently
 * discarding the field, so a caller cannot smuggle a false `risk` or a
 * spoofed `idempotencyKey` past validation by including it and having it
 * quietly ignored.
 *
 * ## Independent oracle (`.claude/rules/invariants.md`)
 *
 * The premise that a pasted GitHub PAT shape reads as a credential is
 * established by `findSecretValues`, this repository's own credential
 * vocabulary (`.claude/scripts/lib/secrets.mjs`) — never by
 * `ProposedActionDraftSchema`'s own screen checking its own work, the same
 * convention `test/incident-intake-credential-screen.test.mjs` and
 * `test/registry-names-and-config.test.mjs` already use. The
 * `ACTION_PARAMS_SCHEMAS` ↔ registry correspondence is checked against
 * `@aic/domain`'s own `RISK_REGISTRY` — a separate module's data, not the
 * function under test checking itself.
 *
 * Every credential-shaped value below is assembled at runtime from parts,
 * never written out as one contiguous literal (`.claude/rules/autonomy.md`,
 * "Never").
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as domain from '@aic/domain';

import { findSecretValues } from '../.claude/scripts/lib/secrets.mjs';
import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerPath = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
const typeContractFixture = resolve(projectRoot, 'test/fixtures/proposed-action-type-contract.ts');

/** A github-pat shape (`ghp_` + 20+ alphanumerics), assembled at runtime. */
const pastedSecret = () => ['ghp', 'A'.repeat(28)].join('_');

const fixtureServiceId = randomUUID();
const fixtureEnvironmentId = randomUUID();
const fixtureWriteCredentialRefId = randomUUID();

const validObservation = (overrides = {}) => ({
  form: 'deployment-in-window',
  subject: 'checkout',
  window: 'incident',
  presence: 'present',
  ...overrides,
});

const validPrecondition = (overrides = {}) => ({
  statement: 'the incident is still open',
  observation: {
    form: 'signal-state',
    subject: 'checkout',
    window: 'incident',
    signal: 'error-rate',
    state: 'elevated',
  },
  ...overrides,
});

const baseDraft = (overrides = {}) => ({
  actionType: 'incident-comment',
  params: { body: 'checkout error rate is elevated' },
  reason: 'correlated with the 10:02 deploy',
  evidenceIds: ['evidence-1'],
  expectedOutcome: {
    statement: 'a follow-up comment records the current hypothesis',
    observations: [validObservation()],
  },
  blastRadius: { level: 'incident-record', description: 'adds a comment to the incident record only' },
  rollbackPlan: { strategy: 'manual-steps', steps: ['delete the comment'] },
  preconditions: [validPrecondition()],
  ...overrides,
});

const validRecord = (overrides = {}) => ({
  contractVersion: domain.PROPOSED_ACTION_CONTRACT_VERSION,
  riskRegistryVersion: domain.RISK_REGISTRY_VERSION,
  risk: 'safe-write',
  idempotencyKey: `sha256:${'0'.repeat(64)}`,
  incidentId: 'incident-1',
  primaryScope: { serviceId: fixtureServiceId, environmentId: fixtureEnvironmentId },
  writeCredentialRefId: fixtureWriteCredentialRefId,
  proposedBy: 'llm',
  ...baseDraft(),
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Sanity: the shared fixture is itself accepted                              */
/* -------------------------------------------------------------------------- */

test('the shared baseDraft() fixture is itself a valid ProposedActionDraftSchema value', () => {
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft());
  assert.equal(result.success, true, `fixture must parse cleanly: ${JSON.stringify(result.error?.issues)}`);
});

/* -------------------------------------------------------------------------- */
/* Row — server-derived fields are refused, not stripped, one key at a time   */
/* -------------------------------------------------------------------------- */

test('a draft carrying risk, idempotencyKey, primaryScope, incidentId, writeCredentialRefId, contractVersion or proposedBy is refused with unrecognized_keys, one key at a time', () => {
  const forbiddenValues = {
    risk: 'safe-write',
    idempotencyKey: `sha256:${'0'.repeat(64)}`,
    primaryScope: { serviceId: fixtureServiceId, environmentId: fixtureEnvironmentId },
    incidentId: 'incident-1',
    writeCredentialRefId: fixtureWriteCredentialRefId,
    contractVersion: 1,
    proposedBy: 'llm',
  };

  for (const [key, value] of Object.entries(forbiddenValues)) {
    const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ [key]: value }));
    assert.equal(result.success, false, `a draft carrying "${key}" must be refused`);
    const namesForbiddenKey = result.error.issues.some(
      (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes(key),
    );
    assert.ok(
      namesForbiddenKey,
      `the refusal for "${key}" must be unrecognized_keys naming it: ${JSON.stringify(result.error.issues)}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Row — rollback semantics are mandatory, and "none" is not a variant        */
/* -------------------------------------------------------------------------- */

test('a draft with no rollbackPlan is refused', () => {
  const { rollbackPlan: _rollbackPlan, ...withoutRollbackPlan } = baseDraft();
  const result = domain.ProposedActionDraftSchema.safeParse(withoutRollbackPlan);
  assert.equal(result.success, false, 'rollbackPlan must be required');
});

test('a draft whose rollbackPlan strategy is "none" is refused: there is no none variant', () => {
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ rollbackPlan: { strategy: 'none' } }));
  assert.equal(result.success, false, 'a rollback-free proposal must never validate');
});

/* -------------------------------------------------------------------------- */
/* Row — evidenceIds: at least one, at most 32, count checked before parsing  */
/* -------------------------------------------------------------------------- */

test('a draft with an empty evidenceIds is refused: a proposal without supporting evidence is rejected', () => {
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ evidenceIds: [] }));
  assert.equal(result.success, false);
});

test('a draft with 33 evidenceIds is refused on the count alone, before any element is parsed, well under half a second', () => {
  const tooManyMalformedIds = Array.from({ length: 33 }, () => ({ not: 'a string' }));
  const started = performance.now();
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ evidenceIds: tooManyMalformedIds }));
  const elapsed = performance.now() - started;

  assert.equal(result.success, false);
  assert.deepEqual(
    result.error.issues.map((issue) => [issue.code, issue.path]),
    [['too_big', ['evidenceIds']]],
    'the count must be checked before any element is parsed: a too_big issue at evidenceIds alone, nothing from inside an element',
  );
  assert.ok(elapsed < 500, `refusal took ${elapsed.toFixed(1)} ms`);
});

/* -------------------------------------------------------------------------- */
/* Row — preconditions: at least one, and every observation is a known form   */
/* -------------------------------------------------------------------------- */

test('a draft with an empty preconditions is refused', () => {
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ preconditions: [] }));
  assert.equal(result.success, false);
});

test('a draft whose precondition observation carries an unregistered form is refused', () => {
  const result = domain.ProposedActionDraftSchema.safeParse(
    baseDraft({
      preconditions: [validPrecondition({ observation: { form: 'not-a-real-form', subject: 'checkout' } })],
    }),
  );
  assert.equal(result.success, false);
});

/* -------------------------------------------------------------------------- */
/* Row — a credential-shaped reason or params.body is refused, never echoed   */
/* -------------------------------------------------------------------------- */

test("the fixture premise: pastedSecret() reads as a credential to this repository's own vocabulary", () => {
  const secret = pastedSecret();
  assert.ok(
    findSecretValues(secret).length > 0,
    `pastedSecret() must be flagged by findSecretValues (the independent oracle), or the rows below prove nothing: ${secret.slice(0, 8)}...`,
  );
});

test('a draft with a credential-shaped reason is refused, and the reported issue never echoes it', () => {
  const secret = pastedSecret();
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ reason: secret }));
  assert.equal(result.success, false, 'a credential-shaped reason must be refused');
  const messages = result.error.issues.map((issue) => issue.message).join('; ');
  assert.ok(!messages.includes(secret), `the reported issue must never echo the credential-shaped reason: ${messages}`);
});

test('ACTION_PARAMS_SCHEMAS["incident-comment"] refuses a credential-shaped params.body, and never echoes it', () => {
  const secret = pastedSecret();
  const result = domain.ACTION_PARAMS_SCHEMAS['incident-comment'].safeParse({ body: secret });
  assert.equal(result.success, false, 'a credential-shaped params.body must be refused');
  const serializedIssues = JSON.stringify(result.error.issues);
  assert.ok(!serializedIssues.includes(secret), `the reported issue must never echo the credential-shaped body: ${serializedIssues}`);
});

/* -------------------------------------------------------------------------- */
/* Row — ACTION_PARAMS_SCHEMAS ↔ the registry's safe-write ids, both ways     */
/* -------------------------------------------------------------------------- */

test("ACTION_PARAMS_SCHEMAS keys are exactly the registry's safe-write action ids, and vice versa", () => {
  const registrySafeWriteIds = domain.RISK_REGISTRY.entries
    .filter((entry) => entry.kind === 'action' && entry.risk === 'safe-write')
    .map((entry) => entry.id)
    .sort();
  const paramsSchemaIds = Object.keys(domain.ACTION_PARAMS_SCHEMAS).sort();

  assert.deepEqual(
    paramsSchemaIds,
    registrySafeWriteIds,
    `ACTION_PARAMS_SCHEMAS keys ${JSON.stringify(paramsSchemaIds)} must equal the registry's safe-write ids ${JSON.stringify(registrySafeWriteIds)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* The record shape: closed, versioned, safe-write only in this slice         */
/* -------------------------------------------------------------------------- */

test('PROPOSED_ACTION_CONTRACT_VERSION is 1, and ProposedActionRecordSchema requires exactly that literal', () => {
  assert.equal(domain.PROPOSED_ACTION_CONTRACT_VERSION, 1);
  const result = domain.ProposedActionRecordSchema.safeParse(validRecord({ contractVersion: 2 }));
  assert.equal(result.success, false, 'a record naming any contractVersion other than 1 must be refused');
});

test('a well-formed safe-write record parses; a record whose risk is dangerous is refused', () => {
  const okResult = domain.ProposedActionRecordSchema.safeParse(validRecord());
  assert.equal(okResult.success, true, `fixture record must parse cleanly: ${JSON.stringify(okResult.error?.issues)}`);

  const dangerousResult = domain.ProposedActionRecordSchema.safeParse(validRecord({ risk: 'dangerous' }));
  assert.equal(dangerousResult.success, false, 'this slice only ever admits risk: safe-write on a record');
});

/* -------------------------------------------------------------------------- */
/* Review round 1 (PR #196)                                                   */
/* -------------------------------------------------------------------------- */

test('ACTION_PARAMS_SCHEMAS refuses params carrying an own __proto__ key parsed from JSON, for every action type, and echoes nothing', () => {
  // Kills: a strict object that silently drops an own __proto__ key, which
  // lets one payload carry any number of distinct idempotency identities.
  for (const actionType of ['incident-comment', 'create-follow-up-ticket']) {
    const valid = actionType === 'incident-comment' ? { body: 'post this' } : { title: 'follow up', body: 'post this' };
    const marked = JSON.parse(`{"__proto__":{"marker":"proto-sentinel"},${JSON.stringify(valid).slice(1)}`);
    assert.ok(Object.hasOwn(marked, '__proto__'), 'fixture premise: JSON.parse keeps __proto__ as an own key');

    const result = domain.ACTION_PARAMS_SCHEMAS[actionType].safeParse(marked);
    assert.equal(result.success, false, `${actionType} must refuse the marked params`);
    assert.ok(!JSON.stringify(result.error.issues).includes('proto-sentinel'), 'the refusal must not echo the payload');
    assert.equal(domain.ACTION_PARAMS_SCHEMAS[actionType].safeParse(valid).success, true, 'the same params without __proto__ still parse');
  }
});

test('a record carrying an extra key is refused', () => {
  const result = domain.ProposedActionRecordSchema.safeParse({ ...validRecord(), unaudited: 'extra' });
  assert.equal(result.success, false);
});

test('a draft actionType longer than 64 characters is refused', () => {
  const result = domain.ProposedActionDraftSchema.safeParse(baseDraft({ actionType: 'a'.repeat(65) }));
  assert.equal(result.success, false);
  assert.equal(domain.ProposedActionDraftSchema.safeParse(baseDraft({ actionType: 'a'.repeat(64) })).success, true);
});

test("the record schema's actionType variants are exactly ACTION_PARAMS_SCHEMAS' keys, and vice versa", () => {
  const variantTypes = domain.ProposedActionRecordSchema.options.map((option) => option.shape.actionType.value).sort();
  assert.deepEqual(variantTypes, ['create-follow-up-ticket', 'incident-comment']);
  assert.deepEqual(Object.keys(domain.ACTION_PARAMS_SCHEMAS).sort(), ['create-follow-up-ticket', 'incident-comment']);
});

test('compiles the proposed-action type contract: a record narrows params by actionType, and an unregistered actionType does not type-check', () => {
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
    { cwd: projectRoot, encoding: 'utf8', env: childEnv() },
  );
  assert.equal(
    result.status,
    0,
    `type-contract compile exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n\nsee test/fixtures/proposed-action-type-contract.ts`,
  );
});

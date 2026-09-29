/**
 * AIC-146 slice b4: the typed refusal reason is recorded durably on the
 * Trial, so AIC-101 can read WHY a test went unavailable/failed from
 * `run_trials` (`Trial.refusal`), never from `node_results` (design note 5).
 * `INCIDENT_STATE_SCHEMA_VERSION` bumps 6 -> 7 for it, since older code does
 * not validate the new optional field — see test/state-cutover.test.mjs for
 * the resume-side refusal that bump forces, and test/domain-contract.test.mjs
 * for the version-6 -> 7 literal-version pin.
 *
 * This file pins the domain half only:
 *
 *   - `@aic/domain` exports `EvidenceSourceRefusalReasonSchema`: a `z.enum`
 *     of exactly the six reasons `@aic/tools`'s `evidence-source.ts` already
 *     freezes as `EVIDENCE_SOURCE_REFUSAL_REASONS` — one spelling, not two
 *     (`.claude/rules/invariants.md`, "one mechanism, one implementation"):
 *     `unavailable`, `denied`, `rate_limited`, `timeout`, `adapter_error`,
 *     `budget_exceeded`.
 *   - `@aic/domain` exports `TrialRefusalSchema` (`z.strictObject`):
 *     `reason: EvidenceSourceRefusalReasonSchema`, `sourceBindingId: a UUID
 *     or null` (present either way, since a tool with no routed binding at
 *     all still gets a refusal naming `null`, `TrialSchema.refusal` carries
 *     `TrialRefusalSchema`, optional — a Trial that never went through a
 *     bound source, or that succeeded, carries no `refusal` key at all.
 *   - `@aic/tools`'s `EVIDENCE_SOURCE_REFUSAL_REASONS` deep-equals
 *     `EvidenceSourceRefusalReasonSchema.options` and stays frozen: the tools
 *     package re-exports the domain's own list rather than keeping a second,
 *     possibly-diverging one. Checked by deep equality rather than reference
 *     identity, because `z.enum(...).options` is not guaranteed to be the
 *     exact array object a caller passed in when constructing the enum (the
 *     independent-oracle rule in `.claude/rules/invariants.md` asks for an
 *     alternative implementation or externally observable behaviour, and a
 *     structural equality check over a closed six-element list is exactly
 *     that: it fails the moment either side gains, loses or reorders an
 *     entry).
 *
 * The port (`packages/tools/src/bound-investigation-executor.ts`) and the
 * node (`packages/graph/src/nodes/execute-investigation.ts`) sides of this
 * slice are pinned in test/bound-investigation-executor.test.mjs and
 * test/investigation-execution.test.mjs respectively.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as tools from '@aic/tools';

/* -------------------------------------------------------------------------- */
/* EvidenceSourceRefusalReasonSchema — the closed six-reason vocabulary       */
/* -------------------------------------------------------------------------- */

const SIX_REASONS = Object.freeze([
  'unavailable',
  'denied',
  'rate_limited',
  'timeout',
  'adapter_error',
  'budget_exceeded',
]);

test('EvidenceSourceRefusalReasonSchema accepts each of the six frozen reasons', () => {
  for (const reason of SIX_REASONS) {
    assert.equal(
      domain.EvidenceSourceRefusalReasonSchema.safeParse(reason).success,
      true,
      `${reason} must be an accepted refusal reason`,
    );
  }
});

test('EvidenceSourceRefusalReasonSchema refuses a reason outside the six, and an empty string', () => {
  for (const reason of ['not-a-reason', 'DENIED', '', 'unavailable ']) {
    assert.equal(
      domain.EvidenceSourceRefusalReasonSchema.safeParse(reason).success,
      false,
      `${JSON.stringify(reason)} must be refused`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* TrialRefusalSchema / TrialSchema.refusal                                   */
/* -------------------------------------------------------------------------- */

function validRefusal(overrides = {}) {
  return { reason: 'denied', sourceBindingId: randomUUID(), ...overrides };
}

test('TrialRefusalSchema accepts a reason paired with a UUID sourceBindingId', () => {
  assert.equal(domain.TrialRefusalSchema.safeParse(validRefusal()).success, true);
});

test('TrialRefusalSchema accepts a reason paired with a null sourceBindingId (no binding served the tool)', () => {
  assert.equal(
    domain.TrialRefusalSchema.safeParse(validRefusal({ sourceBindingId: null })).success,
    true,
  );
});

test('TrialRefusalSchema refuses a sourceBindingId that is missing entirely, rather than present and null', () => {
  const { sourceBindingId, ...withoutSourceBindingId } = validRefusal();
  void sourceBindingId;
  assert.equal(domain.TrialRefusalSchema.safeParse(withoutSourceBindingId).success, false);
});

test('TrialRefusalSchema refuses a sourceBindingId that is neither a UUID nor null', () => {
  assert.equal(
    domain.TrialRefusalSchema.safeParse(validRefusal({ sourceBindingId: 'incident-lab' })).success,
    false,
  );
});

test('TrialRefusalSchema refuses a reason outside the six frozen reasons', () => {
  assert.equal(domain.TrialRefusalSchema.safeParse(validRefusal({ reason: 'not-a-reason' })).success, false);
});

test('TrialRefusalSchema refuses an unknown key', () => {
  assert.equal(
    domain.TrialRefusalSchema.safeParse({ ...validRefusal(), extra: 'unused-fixture' }).success,
    false,
  );
});

function baseTrial(overrides = {}) {
  return {
    id: 'trial-1',
    runId: 'run-1',
    testId: 'test-1',
    attempt: 1,
    tool: 'deployments',
    input: { service: 'checkout' },
    status: 'unavailable',
    durationMs: 0,
    evidenceIds: [],
    ...overrides,
  };
}

test('TrialSchema accepts a Trial carrying no refusal at all, because a successful or pre-b4 trial has none', () => {
  const trial = baseTrial({ status: 'ok' });
  const result = domain.TrialSchema.safeParse(trial);
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(result.data, 'refusal'), false, 'refusal must not appear when it was never supplied');
});

test('TrialSchema accepts a Trial carrying a well-formed refusal naming a binding UUID', () => {
  const refusal = validRefusal();
  const result = domain.TrialSchema.safeParse(baseTrial({ refusal }));
  assert.equal(result.success, true);
  assert.deepEqual(result.data.refusal, refusal);
});

test('TrialSchema accepts a Trial carrying a well-formed refusal naming a null sourceBindingId (no route)', () => {
  const refusal = validRefusal({ reason: 'unavailable', sourceBindingId: null });
  const result = domain.TrialSchema.safeParse(baseTrial({ refusal }));
  assert.equal(result.success, true);
  assert.deepEqual(result.data.refusal, refusal);
});

test('TrialSchema refuses a Trial whose refusal fails TrialRefusalSchema (unknown key)', () => {
  assert.equal(
    domain.TrialSchema.safeParse(baseTrial({ refusal: { ...validRefusal(), extra: 'unused-fixture' } })).success,
    false,
  );
});

test('TrialSchema refuses a Trial whose refusal names a reason outside the six frozen reasons', () => {
  assert.equal(
    domain.TrialSchema.safeParse(baseTrial({ refusal: validRefusal({ reason: 'not-a-reason' }) })).success,
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* One spelling — @aic/tools re-exports the domain's own reason list         */
/* -------------------------------------------------------------------------- */

test('EVIDENCE_SOURCE_REFUSAL_REASONS (tools) deep-equals EvidenceSourceRefusalReasonSchema.options (domain), one spelling', () => {
  assert.deepEqual(
    [...tools.EVIDENCE_SOURCE_REFUSAL_REASONS],
    [...domain.EvidenceSourceRefusalReasonSchema.options],
    'the tools package must re-export the domain\'s own six-reason list, not a second, possibly-diverging copy',
  );
});

test('EVIDENCE_SOURCE_REFUSAL_REASONS (tools) stays frozen', () => {
  assert.equal(Object.isFrozen(tools.EVIDENCE_SOURCE_REFUSAL_REASONS), true);
});

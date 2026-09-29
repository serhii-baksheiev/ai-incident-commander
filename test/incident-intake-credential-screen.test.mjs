/**
 * AIC-99 slice f: `aic incident start` refuses a credential-shaped
 * `--title` / `--external-ref` / `--idempotency-key` / signal `source` or
 * `statement` without ever echoing the pasted value (AIC-99 slice f).
 *
 * ## Design choice this file pins
 *
 * The task brief leaves open WHERE that screen lives. This file pins it at
 * the domain level, on `IncidentIntakeSchema` and `SignalSchema`
 * (`packages/domain/src/intake.ts`) — the same layer `scope.ts` already
 * screens `Service`/`Environment` names and `SourceBinding` config at
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"): a CLI
 * that merely re-validated its OWN copy of the credential vocabulary would be
 * a second implementation of the same rule, and the two would drift. A CLI
 * refusal is exactly a rejected `IncidentIntakeSchema.safeParse` reported
 * without echoing the source value — see test/cli-incident-command.test.mjs
 * for that half.
 *
 * Independent oracle (`.claude/rules/invariants.md`): the premise that the
 * fixtures below really do read as a credential is established by
 * `findSecretValues`, this repository's OWN credential vocabulary
 * (`.claude/scripts/lib/secrets.mjs`), never by `IncidentIntakeSchema`'s own
 * regex checking its own work — the identical convention
 * test/registry-names-and-config.test.mjs already uses for `scope.ts`.
 *
 * Every credential-shaped value below is assembled at runtime from parts,
 * never written out as one contiguous literal
 * (`.claude/rules/autonomy.md`, "Never"; `credential-ref-secrets.test.mjs`'s
 * header has the full rationale).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';

import { findSecretValues } from '../.claude/scripts/lib/secrets.mjs';

/** A github-pat shape (`ghp_` + 20+ alphanumerics) — recognised both by this repository's own `findSecretValues` and by the domain's own vocabulary. */
const pastedSecret = () => ['ghp', 'A'.repeat(28)].join('_');

const scope = () => ({ serviceId: randomUUID(), environmentId: randomUUID() });

const baseIntake = (overrides = {}) => ({
  primaryScope: scope(),
  title: 'Checkout failures',
  startedAt: '2026-09-29T10:00:00Z',
  signals: [
    {
      source: 'pagerduty',
      statement: 'checkout error rate spike',
      observedAt: '2026-09-29T10:00:00Z',
    },
  ],
  ...overrides,
});

test('the fixture premise: pastedSecret() really does read as a credential to this repository\'s own vocabulary', () => {
  const secret = pastedSecret();
  assert.ok(
    findSecretValues(secret).length > 0,
    `pastedSecret() must be flagged by findSecretValues (the independent oracle), or every refusal row below would prove nothing: ${secret.slice(0, 8)}...`,
  );
});

test('IncidentIntakeSchema refuses a credential-shaped title, and the reported issue never echoes it', () => {
  const secret = pastedSecret();
  const result = domain.IncidentIntakeSchema.safeParse(baseIntake({ title: secret }));

  assert.equal(result.success, false, 'a credential-shaped title must be refused');
  const messages = result.error.issues.map((issue) => issue.message).join('; ');
  assert.ok(!messages.includes(secret), `the reported issue must never echo the credential-shaped title: ${messages}`);
});

test('IncidentIntakeSchema refuses a credential-shaped externalRef, and the reported issue never echoes it', () => {
  const secret = pastedSecret();
  const result = domain.IncidentIntakeSchema.safeParse(baseIntake({ externalRef: secret }));

  assert.equal(result.success, false, 'a credential-shaped externalRef must be refused');
  const messages = result.error.issues.map((issue) => issue.message).join('; ');
  assert.ok(!messages.includes(secret), `the reported issue must never echo the credential-shaped externalRef: ${messages}`);
});

test('IncidentIntakeSchema refuses a credential-shaped idempotencyKey, and the reported issue never echoes it', () => {
  const secret = pastedSecret();
  const result = domain.IncidentIntakeSchema.safeParse(baseIntake({ idempotencyKey: secret }));

  assert.equal(result.success, false, 'a credential-shaped idempotencyKey must be refused');
  const messages = result.error.issues.map((issue) => issue.message).join('; ');
  assert.ok(!messages.includes(secret), `the reported issue must never echo the credential-shaped idempotencyKey: ${messages}`);
});

test('IncidentIntakeSchema refuses a credential-shaped signal source, and the reported issue never echoes it', () => {
  const secret = pastedSecret();
  const intake = baseIntake({ signals: [{ source: secret, statement: 'checkout error rate spike', observedAt: '2026-09-29T10:00:00Z' }] });
  const result = domain.IncidentIntakeSchema.safeParse(intake);

  assert.equal(result.success, false, 'a credential-shaped signal source must be refused');
  const messages = result.error.issues.map((issue) => issue.message).join('; ');
  assert.ok(!messages.includes(secret), `the reported issue must never echo the credential-shaped signal source: ${messages}`);
});

test('IncidentIntakeSchema refuses a credential-shaped signal statement, and the reported issue never echoes it', () => {
  const secret = pastedSecret();
  const intake = baseIntake({ signals: [{ source: 'pagerduty', statement: secret, observedAt: '2026-09-29T10:00:00Z' }] });
  const result = domain.IncidentIntakeSchema.safeParse(intake);

  assert.equal(result.success, false, 'a credential-shaped signal statement must be refused');
  const messages = result.error.issues.map((issue) => issue.message).join('; ');
  assert.ok(!messages.includes(secret), `the reported issue must never echo the credential-shaped signal statement: ${messages}`);
});

test('an ordinary title, externalRef, idempotencyKey and signal text are still accepted: the screen refuses only a credential shape, not free text in general', () => {
  const intake = baseIntake({ externalRef: 'pagerduty:incident-123', idempotencyKey: 'checkout-prod-run-one' });
  assert.equal(domain.IncidentIntakeSchema.safeParse(intake).success, true, 'ordinary, non-credential-shaped text must not be refused by the new screen');
});

test('a credential pasted past the first 512 characters of a signal statement is still refused: the screen reads the whole field', () => {
  const secret = pastedSecret();
  const logLine = '10.0.0.1 - - [29/Sep/2026:10:00:00 +0000] "GET /checkout HTTP/1.1" 502 0\n';
  let statement = '';
  while (statement.length < 1_500) statement += logLine;
  statement += `Authorization: token ${secret}`;
  assert.ok(statement.length <= 2_000 && statement.indexOf(secret) > 512, 'fixture sanity: the secret sits past character 512, inside the field cap');
  const result = domain.IncidentIntakeSchema.safeParse(
    baseIntake({ signals: [{ source: 'pagerduty', statement, observedAt: '2026-09-29T10:00:00Z' }] }),
  );
  assert.equal(result.success, false, 'a secret anywhere inside the field must be refused');
  assert.ok(!JSON.stringify(result.error.issues).includes(secret));
});

test('an intake carries at most a bounded number of signals', () => {
  const signal = { source: 'pagerduty', statement: 'checkout error rate spike', observedAt: '2026-09-29T10:00:00Z' };
  const many = domain.IncidentIntakeSchema.safeParse(baseIntake({ signals: Array.from({ length: 1_000 }, () => signal) }));
  assert.equal(many.success, false, 'a thousand signals must be refused by a cap, not parsed');
  const few = domain.IncidentIntakeSchema.safeParse(baseIntake({ signals: Array.from({ length: 10 }, () => signal) }));
  assert.equal(few.success, true, 'an ordinary number of signals is accepted');
});

/** An ordinary long word-character run, the shape of a base64 blob in a pasted log. */
const base64Run = (length) => 'QUJDRGVmZ2hpams0NTY3ODkrLw'.repeat(Math.ceil(length / 26)).slice(0, length);

test('validating an accepted intake of the full signal count, each statement a 2000-character base64-like run, stays well under half a second', () => {
  const signals = Array.from({ length: domain.MAX_INTAKE_SIGNALS }, () => ({
    source: 'pagerduty',
    statement: base64Run(2_000),
    observedAt: '2026-09-29T10:00:00Z',
  }));
  const started = performance.now();
  const result = domain.IncidentIntakeSchema.safeParse(baseIntake({ signals }));
  const elapsed = performance.now() - started;
  assert.equal(result.success, true, 'an ordinary long run is not a credential');
  assert.ok(elapsed < 500, `validation took ${elapsed.toFixed(1)} ms`);
});

test('an intake with far more signals than the cap is refused before any signal is parsed, well under half a second', () => {
  const signal = { source: 'pagerduty', statement: base64Run(2_000), observedAt: '2026-09-29T10:00:00Z' };
  const signals = Array.from({ length: 2_000 }, () => signal);
  const started = performance.now();
  const result = domain.IncidentIntakeSchema.safeParse(baseIntake({ signals }));
  const elapsed = performance.now() - started;
  assert.equal(result.success, false);
  assert.ok(elapsed < 500, `refusal took ${elapsed.toFixed(1)} ms`);
});

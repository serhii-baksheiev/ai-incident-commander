/**
 * AIC-96, slice A: the idempotency key an IncidentIntake derives, so that
 * repeated intake of the same incident is a no-op
 * (docs/decisions/integration-boundary.md, "Ownership": "intake carries
 * `idempotencyKey` so repeated intake does not create a second Incident").
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';

/**
 * The golden value below was computed independently of any implementation -
 * none exists yet, this is the Red step. The exact tuple the design
 * specifies, `['aic.incident-intake', 1, serviceId, environmentId, 'window',
 * INCIDENT_INTAKE_WINDOW_MS, windowIndex]`, was built by hand from the fixed
 * ids and startedAt below, JSON.stringify'd, and hashed with node's own
 * `crypto.createHash('sha256')` - the same primitive intake.ts is specified
 * to use, invoked here directly rather than through `deriveIdempotencyKey`
 * (which does not exist yet, so it cannot be the source of its own answer).
 * The exact command run to produce GOLDEN_KEY:
 *
 *   node -e "
 *     const crypto = require('crypto');
 *     const SERVICE_ID = 'd98b983f-db53-47f9-bc47-b86ef63970b9';
 *     const ENVIRONMENT_ID = '0106d837-e829-4a5c-a529-8ffe940b19c6';
 *     const WINDOW_MS = 15 * 60_000;
 *     const ms = Date.parse('2026-09-23T10:00:00Z');
 *     const k = Math.floor(ms / WINDOW_MS);
 *     const tuple = ['aic.incident-intake', 1, SERVICE_ID, ENVIRONMENT_ID, 'window', WINDOW_MS, k];
 *     console.log('sha256:' + crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex'));
 *   "
 *
 * which printed the GOLDEN_KEY below (ms = 1790157600000, k = 1989064).
 * Reproducing this does not require this file's own implementation to exist,
 * let alone agree with itself - it is a second, independent computation of
 * the same documented tuple.
 */
const GOLDEN_SERVICE_ID = 'd98b983f-db53-47f9-bc47-b86ef63970b9';
const GOLDEN_ENVIRONMENT_ID = '0106d837-e829-4a5c-a529-8ffe940b19c6';
const GOLDEN_STARTED_AT = '2026-09-23T10:00:00Z';
const GOLDEN_KEY = 'sha256:46aa26c9d8e0ce395d20830fe78153816d986250019ce85e843d5dcfd9bf0cf9';

const scope = () => ({ serviceId: randomUUID(), environmentId: randomUUID() });

const intakeFixture = (overrides = {}) => ({
  primaryScope: scope(),
  title: 'Checkout failures',
  startedAt: '2026-09-23T10:00:00Z',
  signals: [
    {
      source: 'pagerduty',
      statement: 'checkout error rate spike',
      observedAt: '2026-09-23T10:00:00Z',
    },
  ],
  ...overrides,
});

test('same scope and externalRef give the same key whatever title, signals or startedAt', () => {
  const sharedScope = scope();
  const base = intakeFixture({ primaryScope: sharedScope, externalRef: 'pagerduty:incident-123' });
  const variant = {
    ...base,
    title: 'A completely different title',
    startedAt: '2026-09-23T11:30:00Z',
    signals: [],
  };

  assert.equal(domain.deriveIdempotencyKey(base), domain.deriveIdempotencyKey(variant));
});

test('a different service, environment or externalRef gives a different key', () => {
  const reference = intakeFixture({ externalRef: 'pagerduty:incident-123' });
  const referenceKey = domain.deriveIdempotencyKey(reference);

  const differentService = {
    ...reference,
    primaryScope: { ...reference.primaryScope, serviceId: randomUUID() },
  };
  assert.notEqual(domain.deriveIdempotencyKey(differentService), referenceKey);

  const differentEnvironment = {
    ...reference,
    primaryScope: { ...reference.primaryScope, environmentId: randomUUID() },
  };
  assert.notEqual(domain.deriveIdempotencyKey(differentEnvironment), referenceKey);

  const differentExternalRef = { ...reference, externalRef: 'pagerduty:incident-456' };
  assert.notEqual(domain.deriveIdempotencyKey(differentExternalRef), referenceKey);
});

test('without externalRef, the same window gives the same key and the next window a different one', () => {
  const sharedScope = scope();
  const windowStartMs =
    Math.floor(Date.parse('2026-09-23T10:00:00Z') / domain.INCIDENT_INTAKE_WINDOW_MS) *
    domain.INCIDENT_INTAKE_WINDOW_MS;

  const intakeAt = (ms) => intakeFixture({ primaryScope: sharedScope, startedAt: new Date(ms).toISOString() });

  const atWindowStart = intakeAt(windowStartMs);
  const justBeforeNextWindow = intakeAt(windowStartMs + domain.INCIDENT_INTAKE_WINDOW_MS - 1);
  const atNextWindow = intakeAt(windowStartMs + domain.INCIDENT_INTAKE_WINDOW_MS);

  assert.equal(
    domain.deriveIdempotencyKey(atWindowStart),
    domain.deriveIdempotencyKey(justBeforeNextWindow),
    'the same [kW, (k+1)W) window must give the same key',
  );
  assert.notEqual(
    domain.deriveIdempotencyKey(atWindowStart),
    domain.deriveIdempotencyKey(atNextWindow),
    'crossing into the next window must give a different key',
  );
});

test('the same instant in two offsets or precisions gives the same key', () => {
  const sharedScope = scope();
  const build = (startedAt) => intakeFixture({ primaryScope: sharedScope, startedAt });

  const utc = domain.deriveIdempotencyKey(build('2026-09-23T10:00:00Z'));
  const explicitOffset = domain.deriveIdempotencyKey(build('2026-09-23T12:00:00+02:00'));
  const withMilliseconds = domain.deriveIdempotencyKey(build('2026-09-23T10:00:00.000Z'));

  assert.equal(utc, explicitOffset, 'the same instant spelled with an explicit offset must give the same key');
  assert.equal(utc, withMilliseconds, 'the same instant spelled with milliseconds must give the same key');
});

test('a caller idempotencyKey wins over externalRef and is still scope-qualified', () => {
  const sharedScope = scope();
  const base = intakeFixture({
    primaryScope: sharedScope,
    externalRef: 'pagerduty:incident-123',
    idempotencyKey: 'checkout-prod-run-one',
  });

  const differentExternalRef = { ...base, externalRef: 'pagerduty:incident-999' };
  assert.equal(
    domain.deriveIdempotencyKey(base),
    domain.deriveIdempotencyKey(differentExternalRef),
    'a caller-supplied idempotencyKey must win over externalRef',
  );

  const differentCallerKey = { ...base, idempotencyKey: 'checkout-prod-run-two' };
  assert.notEqual(
    domain.deriveIdempotencyKey(base),
    domain.deriveIdempotencyKey(differentCallerKey),
    'a different caller idempotencyKey must give a different key',
  );

  const differentScope = { ...base, primaryScope: scope() };
  assert.notEqual(
    domain.deriveIdempotencyKey(base),
    domain.deriveIdempotencyKey(differentScope),
    'even a caller-supplied idempotencyKey must stay scope-qualified',
  );
});

test('matches the documented derivation and the golden value', () => {
  const intake = {
    primaryScope: { serviceId: GOLDEN_SERVICE_ID, environmentId: GOLDEN_ENVIRONMENT_ID },
    title: 'Checkout failures',
    startedAt: GOLDEN_STARTED_AT,
    signals: [],
  };

  assert.equal(domain.deriveIdempotencyKey(intake), GOLDEN_KEY);
});

test('produces a key IdempotencyKeySchema accepts, and incidentFromIntake stores it', () => {
  const intake = intakeFixture();
  const key = domain.deriveIdempotencyKey(intake);
  assert.equal(domain.IdempotencyKeySchema.safeParse(key).success, true);

  const id = randomUUID();
  const incident = domain.incidentFromIntake(intake, { id });

  assert.equal(incident.id, id);
  assert.equal(incident.idempotencyKey, key);
  assert.deepEqual(incident.primaryScope, intake.primaryScope);
  assert.equal(incident.title, intake.title);
  assert.equal(incident.startedAt, intake.startedAt);
  assert.deepEqual(incident.signals, intake.signals);
});

test('refuses a startedAt without an offset', () => {
  const intake = intakeFixture({ startedAt: '2026-09-23T10:00:00' });
  assert.equal(domain.IncidentIntakeSchema.safeParse(intake).success, false);
});

test('refuses to derive a window key from a startedAt it cannot parse', () => {
  const intake = { ...intakeFixture(), startedAt: 'not-a-date' };
  delete intake.externalRef;
  delete intake.idempotencyKey;
  assert.throws(
    () => domain.deriveIdempotencyKey(intake),
    /startedAt/,
    'an unparseable startedAt would put every such intake in one scope on one key; it must be refused instead',
  );
});

test('never stores a caller idempotencyKey raw', () => {
  const raw = 'caller-raw-key-0042';
  const intake = { ...intakeFixture(), idempotencyKey: raw };
  const incident = domain.incidentFromIntake(intake, { id: randomUUID() });
  assert.match(incident.idempotencyKey, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(incident.idempotencyKey, raw);
  assert.equal(JSON.stringify(incident).includes(raw), false, 'the raw caller key appears nowhere in the stored incident');
});

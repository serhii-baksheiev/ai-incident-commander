/**
 * AIC-96, slice A: intake of an Incident and the idempotency key that makes
 * repeated intake of the same incident a no-op
 * (docs/decisions/integration-boundary.md, "Ownership": "intake carries
 * `idempotencyKey` so repeated intake does not create a second Incident").
 *
 * Deliberately does not import `contracts.ts` at runtime, to keep the
 * circular-import risk out of this pair of modules.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { PrimaryScopeSchema, screenedText } from './scope.js';

export const SignalSchema = z.strictObject({
  source: screenedText(200),
  statement: screenedText(2000),
  observedAt: z.iso.datetime({ offset: true }),
});

/**
 * At most this many signals per intake: bounded by construction, like the
 * registry's config (sixteen keys), so validation never scales with an
 * unbounded caller-supplied array — see incident-intake-credential-screen.test.mjs
 * › "an intake carries at most a bounded number of signals".
 */
export const MAX_INTAKE_SIGNALS = 100;

export const IncidentIntakeSchema = z.strictObject({
  primaryScope: PrimaryScopeSchema,
  title: screenedText(200),
  startedAt: z.iso.datetime({ offset: true }),
  signals: z.array(SignalSchema).max(MAX_INTAKE_SIGNALS),
  externalRef: screenedText(256).optional(),
  idempotencyKey: screenedText(256).optional(),
});

export type IncidentIntake = z.infer<typeof IncidentIntakeSchema>;

export const IdempotencyKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * The intake de-duplication window, in milliseconds. Two intakes with no
 * caller-supplied `idempotencyKey` or `externalRef` collide only inside the
 * same half-open window `[kW, (k+1)W)` - the boundary is a stated limit, not
 * an accident: see incident-intake-idempotency.test.mjs › "without
 * externalRef, the same window gives the same key and the next window a
 * different one".
 */
export const INCIDENT_INTAKE_WINDOW_MS = 15 * 60_000;

/**
 * Derives the idempotency key for an intake: a caller-supplied
 * `idempotencyKey` wins over `externalRef`, which wins over the
 * scope-qualified intake window - each basis is scope-qualified by
 * `serviceId` and `environmentId` so the same key, ref or window never
 * collides across two Environments.
 *
 * @throws {Error} when neither `idempotencyKey` nor `externalRef` is supplied
 * and `startedAt` is not a parseable timestamp - see incident-intake-idempotency.test.mjs
 * › "refuses to derive a window key from a startedAt it cannot parse".
 */
export function deriveIdempotencyKey(intake: IncidentIntake): string {
  const { serviceId, environmentId } = intake.primaryScope;

  const windowBasis = (): unknown[] => {
    const startedAt = Date.parse(intake.startedAt);
    // NaN would serialise as null and put every such intake in one scope on
    // one key. See incident-intake-idempotency.test.mjs › "refuses to derive a
    // window key from a startedAt it cannot parse".
    if (Number.isNaN(startedAt)) throw new Error('cannot derive an idempotency key: intake.startedAt is not a parseable timestamp');
    return ['window', INCIDENT_INTAKE_WINDOW_MS, Math.floor(startedAt / INCIDENT_INTAKE_WINDOW_MS)];
  };
  const basis: unknown[] =
    intake.idempotencyKey !== undefined
      ? ['key', intake.idempotencyKey]
      : intake.externalRef !== undefined
        ? ['externalRef', intake.externalRef]
        : windowBasis();

  const tuple = ['aic.incident-intake', 1, serviceId, environmentId, ...basis];
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `sha256:${digest}`;
}

/**
 * Not named `Incident`: `contracts.ts` already owns that name for the incident
 * state carries. Both now require `primaryScope` (`IncidentSchema` since
 * AIC-96), so the two are reconciled on that field; `IntakeDerivedIncident` is
 * the intake-built shape — with `title`, `startedAt`, `signals` and
 * `idempotencyKey` besides — that `IncidentSchema` accepts because it is a
 * `looseObject` rather than restating a stricter one.
 */
export interface IntakeDerivedIncident {
  id: string;
  primaryScope: IncidentIntake['primaryScope'];
  title: string;
  startedAt: string;
  signals: IncidentIntake['signals'];
  externalRef?: string;
  idempotencyKey: string;
}

export function incidentFromIntake(intake: IncidentIntake, { id }: { id: string }): IntakeDerivedIncident {
  const incident: IntakeDerivedIncident = {
    id,
    primaryScope: intake.primaryScope,
    title: intake.title,
    startedAt: intake.startedAt,
    signals: intake.signals,
    idempotencyKey: deriveIdempotencyKey(intake),
  };
  if (intake.externalRef !== undefined) incident.externalRef = intake.externalRef;
  return incident;
}

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

import { PrimaryScopeSchema } from './scope.js';

export const SignalSchema = z.strictObject({
  source: z.string().min(1).max(200),
  statement: z.string().min(1).max(2000),
  observedAt: z.iso.datetime({ offset: true }),
});

export const IncidentIntakeSchema = z.strictObject({
  primaryScope: PrimaryScopeSchema,
  title: z.string().min(1).max(200),
  startedAt: z.iso.datetime({ offset: true }),
  signals: z.array(SignalSchema),
  externalRef: z.string().min(1).max(256).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
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
 * Not named `Incident`: `contracts.ts` already owns that name for the
 * incident state carries today, which has no `primaryScope` yet. The two are
 * reconciled when `IncidentSchema` itself requires a scope — the persisted
 * state cutover AIC-96 still owes.
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

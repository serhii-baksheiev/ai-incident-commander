import type { Pool, PoolClient } from 'pg';

import {
  IncidentIntakeSchema,
  checkPrimaryScope,
  incidentFromIntake,
  type IncidentIntake,
  type IntakeDerivedIncident,
  type RegistrySnapshot,
} from '@aic/domain';

import { APPLICATION_SCHEMA } from './app-schema.js';
import { withConnectionScopedPool } from './registry-store.js';

/**
 * AIC-99 slice f: `createIncidentStore` — `aic incident start`'s own
 * transactional store, built on migration 3's `incidents` table
 * (`app-schema.ts`), which carries no foreign key to `services`/
 * `environments`. See `infra/postgres/tests/incident-store.live.mjs` for
 * the contract this file is built against.
 */

/**
 * A `primaryScope` `checkPrimaryScope` refuses — never a bare database
 * error, and never `RegistryValidationError`/`RegistryConflictError`: an
 * Incident is not a `RegistrySnapshot` mutation, so neither existing
 * registry error class is the right shape for this refusal to carry.
 */
export class IncidentScopeError extends Error {
  readonly reason: 'unknown-service' | 'unknown-environment' | 'environment-of-another-service';

  constructor(reason: 'unknown-service' | 'unknown-environment' | 'environment-of-another-service', options?: ErrorOptions) {
    super(`incident start refused: primaryScope is ${reason}`, options);
    this.name = 'IncidentScopeError';
    this.reason = reason;
  }
}

export interface IncidentStore {
  startIncident(
    intake: IncidentIntake,
    opts: { readonly id: string },
  ): Promise<{ readonly incident: IntakeDerivedIncident; readonly created: boolean }>;
}

/**
 * Only what `checkPrimaryScope` reads (`registry.services`/
 * `registry.environments`, by `id`/`serviceId` alone), read when the call
 * runs, so a scope removed before the call is caught. A removal that commits
 * between this read and the insert is not: the Incident is stored, and it
 * survives removal like any other Incident (the table has no foreign key to
 * the registry). `name` is left
 * blank: `checkPrimaryScope` never reads it, and this snapshot is never
 * passed to `RegistrySnapshotSchema`.
 */
async function loadScopeSnapshot(client: PoolClient): Promise<RegistrySnapshot> {
  const servicesResult = await client.query<{ id: string }>(
    `SELECT id FROM "${APPLICATION_SCHEMA}".services`,
  );
  const environmentsResult = await client.query<{ id: string; service_id: string }>(
    `SELECT id, service_id FROM "${APPLICATION_SCHEMA}".environments`,
  );
  return {
    services: servicesResult.rows.map((row) => ({ id: row.id, name: '', repositoryAliases: [] })),
    environments: environmentsResult.rows.map((row) => ({ id: row.id, serviceId: row.service_id, name: '' })),
    sourceBindings: [],
    credentialRefs: [],
    actionPolicies: [],
  };
}

/**
 * `client.release(err)` destroys the pooled connection instead of returning
 * it, whenever `err` is truthy — correct for a broken connection, wrong for
 * a start this store refused on purpose. `IncidentScopeError` is exactly
 * that: the transaction rolled back cleanly and the connection is fine.
 */
function releaseClient(client: PoolClient, failure: unknown): void {
  const isExpectedRefusal = failure instanceof IncidentScopeError;
  client.release(failure !== undefined && !isExpectedRefusal ? failure : undefined);
}

async function startIncidentAgainst(
  pool: Pool,
  intake: IncidentIntake,
  opts: { readonly id: string },
): Promise<{ readonly incident: IntakeDerivedIncident; readonly created: boolean }> {
  const validated = IncidentIntakeSchema.safeParse(intake);
  if (!validated.success) {
    throw new Error(
      `incident intake is invalid: ${validated.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const safeIntake = validated.data;

  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN');
    try {
      const registry = await loadScopeSnapshot(client);
      const check = checkPrimaryScope(registry, safeIntake.primaryScope);
      if (!check.ok) {
        throw new IncidentScopeError(check.reason);
      }

      const incident = incidentFromIntake(safeIntake, { id: opts.id });

      // INSERT ... ON CONFLICT (idempotency_key) DO NOTHING, then a SELECT
      // by key when the insert lost the race: the unique index on
      // idempotency_key is what makes two concurrent starts with the same
      // derived key leave exactly one row, with no advisory lock needed —
      // see incident-store.live.mjs's concurrency row.
      const insertResult = await client.query<{ body: unknown }>(
        `INSERT INTO "${APPLICATION_SCHEMA}".incidents
           (id, idempotency_key, primary_service_id, primary_environment_id, body)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING body`,
        [
          incident.id,
          incident.idempotencyKey,
          incident.primaryScope.serviceId,
          incident.primaryScope.environmentId,
          JSON.stringify(incident),
        ],
      );

      let resultIncident: IntakeDerivedIncident;
      let created: boolean;
      if (insertResult.rows.length === 1) {
        resultIncident = insertResult.rows[0].body as IntakeDerivedIncident;
        created = true;
      } else {
        const selectResult = await client.query<{ body: unknown }>(
          `SELECT body FROM "${APPLICATION_SCHEMA}".incidents WHERE idempotency_key = $1`,
          [incident.idempotencyKey],
        );
        resultIncident = selectResult.rows[0].body as IntakeDerivedIncident;
        created = false;
      }

      await client.query('COMMIT');
      return { incident: resultIncident, created };
    } catch (error) {
      failure = error;
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what gets reported; a connection that
        // cannot even roll back is released as broken below.
      }
      throw error;
    }
  } finally {
    releaseClient(client, failure);
  }
}

function createPooledIncidentStore(pool: Pool): IncidentStore {
  return {
    startIncident: (intake, opts) => startIncidentAgainst(pool, intake, opts),
  };
}

function createConnectionStringIncidentStore(connectionString: string): IncidentStore {
  return {
    startIncident: (intake, opts) =>
      withConnectionScopedPool(connectionString, (pool) => createPooledIncidentStore(pool).startIncident(intake, opts)),
  };
}

/**
 * Builds an `IncidentStore`, from either of two things a caller can hold —
 * the same overload shape `createRegistryStore` uses: an already-open
 * `pg.Pool`, or a bare connection string (a fresh `Pool` per call, schema
 * version checked, closed afterward — `withConnectionScopedPool`, shared
 * with `createRegistryStore`).
 */
export function createIncidentStore(pool: Pool): IncidentStore;
export function createIncidentStore(connectionString: string): IncidentStore;
export function createIncidentStore(poolOrConnectionString: Pool | string): IncidentStore {
  return typeof poolOrConnectionString === 'string'
    ? createConnectionStringIncidentStore(poolOrConnectionString)
    : createPooledIncidentStore(poolOrConnectionString);
}

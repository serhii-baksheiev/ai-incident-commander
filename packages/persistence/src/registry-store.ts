import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  RegistrySnapshotSchema,
  type ActionPolicy,
  type CredentialRef,
  type Environment,
  type RegistrySnapshot,
  type Service,
  type SourceBinding,
} from '@aic/domain';

import { APPLICATION_SCHEMA } from './app-schema.js';

/**
 * AIC-99 slice c: the transactional registry store the owner's 2026-09-25
 * ruling approved (`docs/decisions/integration-boundary.md`), built on
 * migration 3's normalized tables (`app-schema.ts`). See
 * test/registry-schema.test.mjs (migration 3's SQL shape) and
 * infra/postgres/tests/registry-store.live.mjs (this module's behaviour
 * against a real PostgreSQL) for the spec this file is built against.
 */

/** `addService`/`addEnvironment`/... refuse a name that already exists in its scope. */
export class RegistryConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RegistryConflictError';
  }
}

/**
 * A mutation that would leave `RegistrySnapshotSchema` invalid is refused
 * with this, carrying the zod issues that describe what failed — never the
 * bare database CHECK/FK error those same constraints would otherwise raise.
 */
export class RegistryValidationError extends Error {
  readonly issues: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[];

  constructor(
    message: string,
    issues: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RegistryValidationError';
    this.issues = issues;
  }
}

export interface RegistryStore {
  snapshot(): Promise<RegistrySnapshot>;
  addService(input: { readonly name: string; readonly repositoryAliases: readonly string[] }): Promise<Service>;
  addEnvironment(input: { readonly serviceName: string; readonly name: string }): Promise<Environment>;
  addCredentialRef(input: {
    readonly serviceName: string;
    readonly environmentName: string;
    readonly name: string;
    readonly access: 'read' | 'write';
    readonly secretName: string;
  }): Promise<CredentialRef>;
  addSourceBinding(input: {
    readonly serviceName: string;
    readonly environmentName: string;
    readonly name: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly config: Record<string, string>;
    readonly credentialRefName: string | null;
  }): Promise<SourceBinding>;
  setActionPolicy(input: {
    readonly serviceName: string;
    readonly environmentName: string;
    readonly allowedActionTypes: readonly string[];
    readonly writeCredentialRefNames: readonly string[];
  }): Promise<ActionPolicy>;
  /** Deletes the Environment and cascades through its own SourceBindings, CredentialRefs and ActionPolicy. */
  removeEnvironment(input: { readonly serviceName: string; readonly environmentName: string }): Promise<void>;
  /** Refuses (RegistryValidationError) while the Service still has an Environment. */
  removeService(input: { readonly serviceName: string }): Promise<void>;
}

/**
 * One key for every registry mutation: a transaction-scoped advisory lock
 * (`pg_advisory_xact_lock` releases automatically at COMMIT or ROLLBACK, the
 * same convention `app-schema.ts`'s `SCHEMA_SETUP_LOCK_KEY` uses), so two
 * concurrent mutations serialize rather than racing on the snapshot each
 * reads and re-validates. See registry-store.live.mjs › "concurrent
 * addSourceBinding calls with the same name in the same Environment leave
 * exactly one row, and the loser gets the typed conflict error".
 */
const REGISTRY_LOCK_KEY = 847_522_913;

interface QueryableClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * Sequential, not `Promise.all`: `queryable` is often a single `PoolClient`
 * held inside one transaction (every mutation below), and issuing concurrent
 * queries against ONE client is deprecated in `pg` (measured: pg 8.23.0 warns
 * "Calling client.query() when the client is already executing a query" and
 * states it is removed in pg@9) — each `await` here waits for the previous
 * statement to finish before sending the next.
 */
async function loadSnapshot(queryable: QueryableClient): Promise<RegistrySnapshot> {
  const servicesResult = await queryable.query<{ id: string; name: string; repository_aliases: string[] | null }>(
    `SELECT id, name, repository_aliases FROM "${APPLICATION_SCHEMA}".services`,
  );
  const environmentsResult = await queryable.query<{ id: string; service_id: string; name: string }>(
    `SELECT id, service_id, name FROM "${APPLICATION_SCHEMA}".environments`,
  );
  const sourceBindingsResult = await queryable.query<{
    id: string;
    environment_id: string;
    name: string;
    adapter_id: string;
    adapter_version: string;
    config: unknown;
    credential_ref_id: string | null;
  }>(
    `SELECT id, environment_id, name, adapter_id, adapter_version, config, credential_ref_id
     FROM "${APPLICATION_SCHEMA}".source_bindings`,
  );
  const credentialRefsResult = await queryable.query<{
    id: string;
    environment_id: string;
    name: string;
    access: 'read' | 'write';
    secret_name: string;
  }>(`SELECT id, environment_id, name, access, secret_name FROM "${APPLICATION_SCHEMA}".credential_refs`);
  const actionPoliciesResult = await queryable.query<{
    id: string;
    environment_id: string;
    allowed_action_types: string[] | null;
    write_credential_ref_ids: string[] | null;
  }>(
    `SELECT id, environment_id, allowed_action_types, write_credential_ref_ids
     FROM "${APPLICATION_SCHEMA}".action_policies`,
  );

  return {
    services: servicesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      repositoryAliases: row.repository_aliases ?? [],
    })),
    environments: environmentsResult.rows.map((row) => ({
      id: row.id,
      serviceId: row.service_id,
      name: row.name,
    })),
    sourceBindings: sourceBindingsResult.rows.map((row) => ({
      id: row.id,
      environmentId: row.environment_id,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      name: row.name,
      config: row.config as Record<string, string>,
      credentialRefId: row.credential_ref_id,
    })),
    credentialRefs: credentialRefsResult.rows.map((row) => ({
      id: row.id,
      environmentId: row.environment_id,
      access: row.access,
      name: row.name,
      secretName: row.secret_name,
    })),
    actionPolicies: actionPoliciesResult.rows.map((row) => ({
      id: row.id,
      environmentId: row.environment_id,
      allowedActionTypes: row.allowed_action_types ?? [],
      writeCredentialRefIds: row.write_credential_ref_ids ?? [],
    })),
  };
}

/** Resolves a Service by name to its id, or a fresh (never-matching) id when absent — see this file's header note below on `resolve*`. */
function resolveServiceId(snapshot: RegistrySnapshot, name: string): string {
  return snapshot.services.find((service) => service.name === name)?.id ?? randomUUID();
}

function resolveEnvironmentId(snapshot: RegistrySnapshot, serviceId: string, name: string): string {
  return (
    snapshot.environments.find((environment) => environment.serviceId === serviceId && environment.name === name)
      ?.id ?? randomUUID()
  );
}

function resolveCredentialRefId(snapshot: RegistrySnapshot, environmentId: string, name: string): string {
  return (
    snapshot.credentialRefs.find((ref) => ref.environmentId === environmentId && ref.name === name)?.id ??
    randomUUID()
  );
}

/**
 * A name that does not resolve (unknown Service, unknown Environment, unknown
 * CredentialRef in scope) is deliberately given a FRESH random id rather than
 * throwing immediately: `RegistrySnapshotSchema`'s own cross-reference checks
 * then refuse it (`... does not name a known ...`) when the resulting
 * snapshot is validated below, which is what turns every such case into a
 * `RegistryValidationError` carrying real zod issues, with no special-casing
 * per caller. The same mechanism is what makes `removeService`'s refusal (a
 * Service that still has an Environment) fall out of the same generic
 * validation step, with no dedicated check of its own: removing the Service
 * from the snapshot while its Environment stays behind is exactly the
 * "Environment.serviceId does not name a known Service" issue.
 */
type MutationOutcome<T> = {
  readonly newSnapshot: RegistrySnapshot;
  readonly result: T;
  readonly event: { readonly kind: string; readonly subjectId: string; readonly body: unknown };
  readonly write: (client: PoolClient) => Promise<void>;
};

async function mutate<T>(
  pool: Pool,
  run: (snapshot: RegistrySnapshot) => Promise<MutationOutcome<T>>,
): Promise<T> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [REGISTRY_LOCK_KEY]);
      const snapshot = await loadSnapshot(client);
      const { newSnapshot, result, event, write } = await run(snapshot);

      const parsed = RegistrySnapshotSchema.safeParse(newSnapshot);
      if (!parsed.success) {
        await client.query('ROLLBACK');
        throw new RegistryValidationError(
          `the resulting registry snapshot is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        );
      }

      await write(client);
      await client.query(
        `INSERT INTO "${APPLICATION_SCHEMA}".registry_events (kind, subject_id, body) VALUES ($1, $2, $3::jsonb)`,
        [event.kind, event.subjectId, JSON.stringify(event.body)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failure = error;
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is what gets reported; a connection that cannot
        // even roll back is released as broken below.
      }
      throw error;
    }
  } finally {
    client.release(failure);
  }
}

/** Builds a store against `pool` — an already-open `pg.Pool` a caller holds, unlike `createRunStore`'s connection string. */
export function createRegistryStore(pool: Pool): RegistryStore {
  return {
    async snapshot() {
      return loadSnapshot(pool);
    },

    async addService(input) {
      return mutate(pool, async (snapshot) => {
        if (snapshot.services.some((service) => service.name === input.name)) {
          throw new RegistryConflictError(`a Service named "${input.name}" already exists`);
        }
        const service: Service = {
          id: randomUUID(),
          name: input.name,
          repositoryAliases: [...input.repositoryAliases],
        };
        return {
          newSnapshot: { ...snapshot, services: [...snapshot.services, service] },
          result: service,
          event: { kind: 'service.added', subjectId: service.id, body: { name: service.name } },
          write: async (client) => {
            await client.query(
              `INSERT INTO "${APPLICATION_SCHEMA}".services (id, name, repository_aliases) VALUES ($1, $2, $3)`,
              [service.id, service.name, service.repositoryAliases],
            );
          },
        };
      });
    },

    async addEnvironment(input) {
      return mutate(pool, async (snapshot) => {
        const serviceId = resolveServiceId(snapshot, input.serviceName);
        if (snapshot.environments.some((environment) => environment.serviceId === serviceId && environment.name === input.name)) {
          throw new RegistryConflictError(
            `an Environment named "${input.name}" already exists for service "${input.serviceName}"`,
          );
        }
        const environment: Environment = { id: randomUUID(), serviceId, name: input.name };
        return {
          newSnapshot: { ...snapshot, environments: [...snapshot.environments, environment] },
          result: environment,
          event: { kind: 'environment.added', subjectId: environment.id, body: { name: environment.name, serviceId } },
          write: async (client) => {
            await client.query(
              `INSERT INTO "${APPLICATION_SCHEMA}".environments (id, service_id, name) VALUES ($1, $2, $3)`,
              [environment.id, environment.serviceId, environment.name],
            );
          },
        };
      });
    },

    async addCredentialRef(input) {
      return mutate(pool, async (snapshot) => {
        const serviceId = resolveServiceId(snapshot, input.serviceName);
        const environmentId = resolveEnvironmentId(snapshot, serviceId, input.environmentName);
        if (snapshot.credentialRefs.some((ref) => ref.environmentId === environmentId && ref.name === input.name)) {
          throw new RegistryConflictError(
            `a CredentialRef named "${input.name}" already exists in Environment "${input.environmentName}"`,
          );
        }
        const credentialRef: CredentialRef = {
          id: randomUUID(),
          environmentId,
          name: input.name,
          access: input.access,
          secretName: input.secretName,
        };
        return {
          newSnapshot: { ...snapshot, credentialRefs: [...snapshot.credentialRefs, credentialRef] },
          result: credentialRef,
          event: {
            kind: 'credentialRef.added',
            subjectId: credentialRef.id,
            body: { name: credentialRef.name, environmentId },
          },
          write: async (client) => {
            await client.query(
              `INSERT INTO "${APPLICATION_SCHEMA}".credential_refs (id, environment_id, name, access, secret_name)
               VALUES ($1, $2, $3, $4, $5)`,
              [credentialRef.id, credentialRef.environmentId, credentialRef.name, credentialRef.access, credentialRef.secretName],
            );
          },
        };
      });
    },

    async addSourceBinding(input) {
      return mutate(pool, async (snapshot) => {
        const serviceId = resolveServiceId(snapshot, input.serviceName);
        const environmentId = resolveEnvironmentId(snapshot, serviceId, input.environmentName);
        if (snapshot.sourceBindings.some((binding) => binding.environmentId === environmentId && binding.name === input.name)) {
          throw new RegistryConflictError(
            `a SourceBinding named "${input.name}" already exists in Environment "${input.environmentName}"`,
          );
        }
        const credentialRefId =
          input.credentialRefName === null ? null : resolveCredentialRefId(snapshot, environmentId, input.credentialRefName);
        const sourceBinding: SourceBinding = {
          id: randomUUID(),
          environmentId,
          adapterId: input.adapterId,
          adapterVersion: input.adapterVersion,
          name: input.name,
          config: input.config,
          credentialRefId,
        };
        return {
          newSnapshot: { ...snapshot, sourceBindings: [...snapshot.sourceBindings, sourceBinding] },
          result: sourceBinding,
          event: {
            kind: 'sourceBinding.added',
            subjectId: sourceBinding.id,
            body: { name: sourceBinding.name, environmentId },
          },
          write: async (client) => {
            await client.query(
              `INSERT INTO "${APPLICATION_SCHEMA}".source_bindings
                 (id, environment_id, name, adapter_id, adapter_version, config, credential_ref_id)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
              [
                sourceBinding.id,
                sourceBinding.environmentId,
                sourceBinding.name,
                sourceBinding.adapterId,
                sourceBinding.adapterVersion,
                JSON.stringify(sourceBinding.config),
                sourceBinding.credentialRefId,
              ],
            );
          },
        };
      });
    },

    async setActionPolicy(input) {
      return mutate(pool, async (snapshot) => {
        const serviceId = resolveServiceId(snapshot, input.serviceName);
        const environmentId = resolveEnvironmentId(snapshot, serviceId, input.environmentName);
        const writeCredentialRefIds = input.writeCredentialRefNames.map((name) =>
          resolveCredentialRefId(snapshot, environmentId, name),
        );
        const actionPolicy: ActionPolicy = {
          id: randomUUID(),
          environmentId,
          allowedActionTypes: [...input.allowedActionTypes],
          writeCredentialRefIds,
        };
        const otherPolicies = snapshot.actionPolicies.filter((policy) => policy.environmentId !== environmentId);
        return {
          newSnapshot: { ...snapshot, actionPolicies: [...otherPolicies, actionPolicy] },
          result: actionPolicy,
          event: { kind: 'actionPolicy.set', subjectId: actionPolicy.id, body: { environmentId } },
          write: async (client) => {
            await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".action_policies WHERE environment_id = $1`, [
              environmentId,
            ]);
            await client.query(
              `INSERT INTO "${APPLICATION_SCHEMA}".action_policies
                 (id, environment_id, allowed_action_types, write_credential_ref_ids)
               VALUES ($1, $2, $3, $4)`,
              [actionPolicy.id, actionPolicy.environmentId, actionPolicy.allowedActionTypes, actionPolicy.writeCredentialRefIds],
            );
          },
        };
      });
    },

    async removeEnvironment(input) {
      return mutate(pool, async (snapshot) => {
        const serviceId = resolveServiceId(snapshot, input.serviceName);
        const environmentId = resolveEnvironmentId(snapshot, serviceId, input.environmentName);
        return {
          newSnapshot: {
            ...snapshot,
            environments: snapshot.environments.filter((environment) => environment.id !== environmentId),
            sourceBindings: snapshot.sourceBindings.filter((binding) => binding.environmentId !== environmentId),
            credentialRefs: snapshot.credentialRefs.filter((ref) => ref.environmentId !== environmentId),
            actionPolicies: snapshot.actionPolicies.filter((policy) => policy.environmentId !== environmentId),
          },
          result: undefined as void,
          event: { kind: 'environment.removed', subjectId: environmentId, body: { serviceId } },
          write: async (client) => {
            await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".source_bindings WHERE environment_id = $1`, [
              environmentId,
            ]);
            await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".credential_refs WHERE environment_id = $1`, [
              environmentId,
            ]);
            await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".action_policies WHERE environment_id = $1`, [
              environmentId,
            ]);
            await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".environments WHERE id = $1`, [environmentId]);
          },
        };
      });
    },

    async removeService(input) {
      return mutate(pool, async (snapshot) => {
        const serviceId = resolveServiceId(snapshot, input.serviceName);
        return {
          newSnapshot: { ...snapshot, services: snapshot.services.filter((service) => service.id !== serviceId) },
          result: undefined as void,
          event: { kind: 'service.removed', subjectId: serviceId, body: {} },
          write: async (client) => {
            await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".services WHERE id = $1`, [serviceId]);
          },
        };
      });
    },
  };
}

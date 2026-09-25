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
  /**
   * CASCADES through every Environment the Service still has, and through
   * each of THEIR own SourceBindings, CredentialRefs and ActionPolicy — the
   * owner's 2026-09-25 ruling, Jira AIC-99 comment 20973.
   */
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
 * One `registry_events` row. A mutation appends its events in the order
 * given: `removeService` appends one `environment.removed` per cascaded
 * Environment, then its own `service.removed` (registry-store.live.mjs ›
 * "removeService cascades through both of a Service's Environments and their
 * SourceBindings, CredentialRefs and ActionPolicy, records one
 * environment.removed per Environment plus one service.removed, keeps every
 * historical audit table's row for that scope byte-for-byte unchanged, and
 * leaves an unrelated Service and its Environment untouched"); every other
 * mutation appends exactly one.
 */
type MutationEvent = { readonly kind: string; readonly subjectId: string; readonly body: unknown };

/**
 * A name that does not resolve (unknown Service, unknown Environment, unknown
 * CredentialRef in scope) is deliberately given a FRESH random id rather than
 * throwing immediately: `RegistrySnapshotSchema`'s own cross-reference checks
 * then refuse it (`... does not name a known ...`) when the resulting
 * snapshot is validated below, which is what turns every such case into a
 * `RegistryValidationError` carrying real zod issues, with no special-casing
 * per caller. **This is the ADD paths' mechanism only** (`addEnvironment`,
 * `addCredentialRef`, `addSourceBinding`, `setActionPolicy`): a fresh id
 * lands in the new snapshot right alongside the row that references it, so
 * the cross-reference check has something to refuse.
 *
 * The REMOVE paths (`removeEnvironment`, `removeService`) cannot rely on the
 * same mechanism: filtering a snapshot by an id nothing carries removes
 * nothing, so a snapshot built from an unresolved name would look
 * unchanged and pass validation vacuously, reporting success for a removal
 * that removed nothing. Each of those two checks its own name resolves to an
 * existing row in the loaded snapshot and throws `RegistryValidationError`
 * itself, before either produces a `newSnapshot`, a `write`, or `events`.
 * `removeService` removes the Service together with every Environment it
 * has and each of their SourceBindings, CredentialRefs and ActionPolicy —
 * the owner's 2026-09-25 ruling (Jira AIC-99 comment 20973) is CASCADE — so
 * the snapshot it hands to the validation step below carries no Environment
 * pointing at the removed Service.
 */
type MutationOutcome<T> = {
  readonly newSnapshot: RegistrySnapshot;
  readonly result: T;
  readonly events: readonly MutationEvent[];
  readonly write: (client: PoolClient) => Promise<void>;
};

/**
 * `client.release(err)` (pg) destroys the pooled connection instead of
 * returning it to the pool whenever `err` is truthy — correct for a broken
 * connection (a failed ROLLBACK, a network error), wrong for a mutation this
 * store itself refused on purpose. `RegistryValidationError` and
 * `RegistryConflictError` are exactly that: the transaction rolled back
 * cleanly and the connection is fine, so releasing it as broken would only
 * shrink the pool on ordinary, expected refusals.
 */
function releaseClient(client: PoolClient, failure: unknown): void {
  const isExpectedRefusal = failure instanceof RegistryValidationError || failure instanceof RegistryConflictError;
  client.release(failure !== undefined && !isExpectedRefusal ? failure : undefined);
}

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
      const { newSnapshot, result, events, write } = await run(snapshot);

      const parsed = RegistrySnapshotSchema.safeParse(newSnapshot);
      if (!parsed.success) {
        throw new RegistryValidationError(
          `the resulting registry snapshot is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        );
      }

      await write(client);
      // Sequential, in the order the mutation gave them: one client runs
      // one query at a time, and `seq` then follows that order.
      for (const event of events) {
        await client.query(
          `INSERT INTO "${APPLICATION_SCHEMA}".registry_events (kind, subject_id, body) VALUES ($1, $2, $3::jsonb)`,
          [event.kind, event.subjectId, JSON.stringify(event.body)],
        );
      }
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
    releaseClient(client, failure);
  }
}

/**
 * `snapshot()`'s five SELECTs run on one dedicated client inside
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY … COMMIT`, so all five see
 * the same instant of the registry (PostgreSQL's MVCC snapshot, taken at
 * `BEGIN`) rather than each read racing an interleaved mutation — see
 * registry-store.live.mjs › "snapshot() never returns a SourceBinding whose
 * credentialRefId survives from before a removeEnvironment that fully
 * commits partway through the read".
 *
 * Deliberately does NOT take `REGISTRY_LOCK_KEY`: a lock-serialized read
 * would block a concurrent `mutate()` (e.g. a committing `removeEnvironment`)
 * for as long as the read takes, which a plain read has no business doing.
 * REPEATABLE READ's own MVCC snapshot is the mechanism that keeps the read
 * consistent without serializing against writers.
 */
async function readConsistentSnapshot(pool: Pool): Promise<RegistrySnapshot> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const snapshot = await loadSnapshot(client);
      await client.query('COMMIT');
      return snapshot;
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
    releaseClient(client, failure);
  }
}

/**
 * Deletes one Environment and everything that belongs to it — its
 * SourceBindings, CredentialRefs and ActionPolicy, in that dependency order —
 * inside the caller's transaction. Shared by `removeEnvironment` (one
 * Environment) and `removeService`'s cascade (the owner's 2026-09-25 ruling,
 * Jira AIC-99 comment 20973: removing a Service removes every Environment it
 * still has, each with its own SourceBindings, CredentialRefs and
 * ActionPolicy), so the per-Environment delete logic is written once.
 */
async function deleteEnvironmentCascade(client: PoolClient, environmentId: string): Promise<void> {
  await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".source_bindings WHERE environment_id = $1`, [
    environmentId,
  ]);
  await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".credential_refs WHERE environment_id = $1`, [
    environmentId,
  ]);
  await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".action_policies WHERE environment_id = $1`, [
    environmentId,
  ]);
  const { rowCount } = await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".environments WHERE id = $1`, [
    environmentId,
  ]);
  if (rowCount !== 1) {
    const message = `expected to delete exactly one Environment row for id "${environmentId}", deleted ${rowCount}`;
    throw new RegistryValidationError(message, [{ message, path: ['environmentName'] }]);
  }
}

/** Builds a store against `pool` — an already-open `pg.Pool` a caller holds, unlike `createRunStore`'s connection string. */
export function createRegistryStore(pool: Pool): RegistryStore {
  return {
    async snapshot() {
      return readConsistentSnapshot(pool);
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
          events: [{ kind: 'service.added', subjectId: service.id, body: { name: service.name } }],
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
          events: [{ kind: 'environment.added', subjectId: environment.id, body: { name: environment.name, serviceId } }],
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
          events: [
            {
              kind: 'credentialRef.added',
              subjectId: credentialRef.id,
              body: { name: credentialRef.name, environmentId },
            },
          ],
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
          events: [
            {
              kind: 'sourceBinding.added',
              subjectId: sourceBinding.id,
              body: { name: sourceBinding.name, environmentId },
            },
          ],
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
          events: [{ kind: 'actionPolicy.set', subjectId: actionPolicy.id, body: { environmentId } }],
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
        const service = snapshot.services.find((candidate) => candidate.name === input.serviceName);
        const environment = service
          ? snapshot.environments.find(
              (candidate) => candidate.serviceId === service.id && candidate.name === input.environmentName,
            )
          : undefined;
        if (!service || !environment) {
          const message = `no Environment named "${input.environmentName}" exists for service "${input.serviceName}"`;
          throw new RegistryValidationError(message, [{ message, path: ['environmentName'] }]);
        }
        const serviceId = service.id;
        const environmentId = environment.id;
        return {
          newSnapshot: {
            ...snapshot,
            environments: snapshot.environments.filter((candidate) => candidate.id !== environmentId),
            sourceBindings: snapshot.sourceBindings.filter((binding) => binding.environmentId !== environmentId),
            credentialRefs: snapshot.credentialRefs.filter((ref) => ref.environmentId !== environmentId),
            actionPolicies: snapshot.actionPolicies.filter((policy) => policy.environmentId !== environmentId),
          },
          result: undefined as void,
          events: [{ kind: 'environment.removed', subjectId: environmentId, body: { serviceId } }],
          write: async (client) => {
            await deleteEnvironmentCascade(client, environmentId);
          },
        };
      });
    },

    async removeService(input) {
      return mutate(pool, async (snapshot) => {
        const service = snapshot.services.find((candidate) => candidate.name === input.serviceName);
        if (!service) {
          const message = `no Service named "${input.serviceName}" exists`;
          throw new RegistryValidationError(message, [{ message, path: ['serviceName'] }]);
        }
        const serviceId = service.id;
        // CASCADE, per the owner's 2026-09-25 ruling (Jira AIC-99 comment
        // 20973): removing a Service removes every Environment it still has,
        // and each Environment's own SourceBindings, CredentialRefs and
        // ActionPolicy — see this module's header and
        // docs/decisions/integration-boundary.md, "Removal semantics".
        const removedEnvironments = snapshot.environments.filter((candidate) => candidate.serviceId === serviceId);
        const removedEnvironmentIds = removedEnvironments.map((environment) => environment.id);
        return {
          newSnapshot: {
            ...snapshot,
            services: snapshot.services.filter((candidate) => candidate.id !== serviceId),
            environments: snapshot.environments.filter((candidate) => candidate.serviceId !== serviceId),
            sourceBindings: snapshot.sourceBindings.filter(
              (binding) => !removedEnvironmentIds.includes(binding.environmentId),
            ),
            credentialRefs: snapshot.credentialRefs.filter(
              (ref) => !removedEnvironmentIds.includes(ref.environmentId),
            ),
            actionPolicies: snapshot.actionPolicies.filter(
              (policy) => !removedEnvironmentIds.includes(policy.environmentId),
            ),
          },
          result: undefined as void,
          events: [
            ...removedEnvironments.map((environment) => ({
              kind: 'environment.removed',
              subjectId: environment.id,
              body: { serviceId },
            })),
            { kind: 'service.removed', subjectId: serviceId, body: {} },
          ],
          write: async (client) => {
            for (const environmentId of removedEnvironmentIds) {
              await deleteEnvironmentCascade(client, environmentId);
            }
            const { rowCount } = await client.query(`DELETE FROM "${APPLICATION_SCHEMA}".services WHERE id = $1`, [
              serviceId,
            ]);
            if (rowCount !== 1) {
              const message = `expected to delete exactly one Service row for id "${serviceId}", deleted ${rowCount}`;
              throw new RegistryValidationError(message, [{ message, path: ['serviceName'] }]);
            }
          },
        };
      });
    },
  };
}

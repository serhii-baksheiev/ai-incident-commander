import { Pool } from 'pg';

/**
 * The application's own schema — see `index.ts`'s module doc for why it is
 * named separately from the checkpointer's (`CHECKPOINTER_SCHEMA`).
 */
export const APPLICATION_SCHEMA = 'aic_app' as const;

/**
 * The migration version this build's `APPLICATION_MIGRATIONS` reach — one
 * version per entry below, applied in order. AIC-56 slice B shipped the first:
 * the `runs` table and the ledger that records it. Slice C adds the second:
 * the fenced write context's own tables (`node_results`, `run_events`,
 * `run_event_counters`, `run_trials`, `run_evidence`, `fence_rejections`) and
 * `runs.interaction_id` (decision 4: a run waiting for a human still carries
 * the interaction it is waiting on).
 *
 * AIC-99 slice c adds the third: the normalized registry tables (`services`,
 * `environments`, `credential_refs`, `source_bindings`, `action_policies`,
 * `incidents`, `registry_events`) the owner's 2026-09-25 ruling approved
 * (`docs/decisions/integration-boundary.md`), written to by
 * `registry-store.ts`'s `createRegistryStore`.
 */
export const APP_SCHEMA_VERSION = 3 as const;

interface ApplicationMigration {
  readonly version: number;
  readonly sql: string;
}

/**
 * The ordered migrations `setupApplicationSchema` applies, each exactly once,
 * inside one transaction (see that function below).
 *
 * The `status` CHECK constraint lists the domain's `RUN_STATUSES` as literal
 * SQL text rather than generating it: a migration never changes after it
 * ships, so it cannot read a constant that might change under it. The two are
 * kept equal instead by a correspondence test in both directions
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") — see
 * run-store.test.mjs › "the migration's status CHECK constraint lists exactly
 * RUN_STATUSES".
 *
 * The second CHECK constraint is decision 4 of
 * `docs/decisions/durable-run-execution.md` ("waiting for a human owns no
 * worker") and its `running` counterpart ("running always holds a lease"),
 * enforced by the database itself rather than only by this package's
 * TypeScript — see infra/postgres/tests/run-store.live.mjs › "the database
 * rejects a waiting_human row with an owner or lease, and a running row
 * without them".
 */
export const APPLICATION_MIGRATIONS: readonly ApplicationMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    sql: `
      CREATE SCHEMA IF NOT EXISTS "aic_app";

      CREATE TABLE IF NOT EXISTS "aic_app".runs (
        run_id text PRIMARY KEY,
        status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_human', 'completed', 'failed')),
        input jsonb NOT NULL,
        owner_worker_id text,
        lease_expires_at timestamptz,
        heartbeat_at timestamptz,
        execution_attempt integer NOT NULL DEFAULT 0,
        recovery_count integer NOT NULL DEFAULT 0,
        terminal_reason text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT runs_lease_ownership_check CHECK (
          (status <> 'waiting_human' OR (owner_worker_id IS NULL AND lease_expires_at IS NULL))
          AND (status <> 'running' OR (owner_worker_id IS NOT NULL AND lease_expires_at IS NOT NULL))
        )
      );

      CREATE INDEX IF NOT EXISTS runs_queued_created_at_idx
        ON "aic_app".runs (created_at) WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS runs_running_lease_idx
        ON "aic_app".runs (lease_expires_at) WHERE status = 'running';
    `,
  }),
  /**
   * AIC-56 slice C: the fenced write context's own tables, and
   * `runs.interaction_id` (decision 4). Migration 1 above stays
   * byte-identical — see run-write-context.test.mjs › "APP_SCHEMA_VERSION is
   * 2, migration 1's SQL is byte-identical to what shipped in #97, and
   * migration 2 exists".
   *
   * - `node_results` is the committed-result ledger decision 6 asks for: one
   *   row per `(run_id, exec_key)`, never updated after insert (`run-write-context.ts`
   *   never issues an UPDATE against it — only INSERT ... ON CONFLICT DO
   *   NOTHING). `input_sha` is nullable: a caller that never passed an
   *   `inputFingerprint` stores none.
   * - `run_events` is the append-only evidence decision 10 and decision 12
   *   ask for, keyed by `(run_id, seq)`; `seq` comes from
   *   `run_event_counters`, upserted-and-incremented inside the same fenced
   *   transaction that appends the event, so it is strictly increasing per
   *   run — see run-write-context.live.mjs › "each fenced write appends an
   *   event with a strictly increasing seq per run".
   * - `run_trials` / `run_evidence` are the domain `Trial` / `Evidence`
   *   projection, keyed by their own `id`s; `body` is `canonicalJson`'s text
   *   (`@aic/domain`), the one place canonical JSON lives in this codebase.
   * - `fence_rejections` is decision 12's durable evidence of a stale or
   *   fenced commit: one row per refused run-scoped write attempt, recorded
   *   in its own statement after the refusing transaction has already rolled
   *   back — see run-write-context.live.mjs › "a zombie worker after lease
   *   loss cannot write domain records or events, and fence_rejections
   *   records the attempts".
   */
  Object.freeze({
    version: 2,
    sql: `
      ALTER TABLE "aic_app".runs ADD COLUMN IF NOT EXISTS interaction_id text;

      CREATE TABLE IF NOT EXISTS "aic_app".node_results (
        run_id text NOT NULL,
        exec_key text NOT NULL,
        op text NOT NULL,
        input_sha text,
        result_json text NOT NULL,
        result_sha text NOT NULL,
        produced_by_attempt integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (run_id, exec_key)
      );

      CREATE TABLE IF NOT EXISTS "aic_app".run_event_counters (
        run_id text PRIMARY KEY,
        next_seq integer NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "aic_app".run_events (
        run_id text NOT NULL,
        seq integer NOT NULL,
        type text NOT NULL,
        execution_attempt integer NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (run_id, seq)
      );

      CREATE TABLE IF NOT EXISTS "aic_app".run_trials (
        run_id text NOT NULL,
        trial_id text NOT NULL,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (run_id, trial_id)
      );

      CREATE TABLE IF NOT EXISTS "aic_app".run_evidence (
        run_id text NOT NULL,
        evidence_id text NOT NULL,
        trial_id text NOT NULL,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (run_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS "aic_app".fence_rejections (
        id bigserial PRIMARY KEY,
        run_id text NOT NULL,
        owner_worker_id text NOT NULL,
        execution_attempt integer NOT NULL,
        kind text NOT NULL,
        at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE INDEX IF NOT EXISTS fence_rejections_run_at_idx
        ON "aic_app".fence_rejections (run_id, at);
      CREATE UNIQUE INDEX IF NOT EXISTS runs_interaction_id_key
        ON "aic_app".runs (interaction_id) WHERE interaction_id IS NOT NULL;
    `,
  }),
  /**
   * AIC-99 slice c: the normalized registry tables the owner's 2026-09-25
   * ruling approved (`docs/decisions/integration-boundary.md`) — written to
   * exclusively by `registry-store.ts`'s `createRegistryStore`.
   *
   * `REFERENCES` targets below are deliberately UNQUALIFIED (`"services"`,
   * not `"aic_app"."services"`): test/registry-schema.test.mjs's
   * `source_bindings.credential_ref_id` assertion matches
   * `REFERENCES\s+"?credential_refs"?` literally, with no schema prefix.
   * `SET LOCAL search_path` just below resolves each unqualified reference
   * against `aic_app` for the rest of this migration's transaction only —
   * every `CREATE TABLE` target itself stays schema-qualified.
   *
   * - `services` / `environments` / `credential_refs` / `source_bindings` /
   *   `action_policies` mirror `@aic/domain`'s `Service` / `Environment` /
   *   `CredentialRef` / `SourceBinding` / `ActionPolicy` — normalized rows a
   *   `RegistrySnapshot` is assembled from. `credential_refs` carries exactly
   *   `id, environment_id, name, access, secret_name`: a secret's NAME, never
   *   its value (docs/decisions/integration-boundary.md, "Trust boundary").
   *   `source_bindings.credential_ref_id` is nullable (a credential-less
   *   adapter like lab@1) and, when set, must reference `credential_refs`.
   *   `action_policies.environment_id` is UNIQUE: at most one ActionPolicy
   *   per Environment, the same rule `RegistrySnapshotSchema` enforces.
   * - `incidents` carries NO foreign key to `services` or `environments`:
   *   `primary_service_id` / `primary_environment_id` are plain columns, so
   *   `removeEnvironment` / `removeService` never cascade into deleting an
   *   Incident. `idempotency_key` is UNIQUE: repeated intake with the same
   *   key never creates a second Incident.
   * - `registry_events` is the append-only ledger `createRegistryStore`
   *   records one row into per mutation: a `bigserial seq` primary key (the
   *   same shape `fence_rejections` above already uses) and a `body jsonb`
   *   column, with no foreign key of its own — an event about a removed
   *   Service or Environment must stay readable after the row it names is
   *   gone.
   */
  Object.freeze({
    version: 3,
    sql: `
      SET LOCAL search_path TO "aic_app", public;

      CREATE TABLE IF NOT EXISTS "aic_app"."services" (
        id uuid PRIMARY KEY,
        name text NOT NULL UNIQUE,
        repository_aliases text[] NOT NULL DEFAULT '{}'::text[]
      );

      CREATE TABLE IF NOT EXISTS "aic_app"."environments" (
        id uuid PRIMARY KEY,
        service_id uuid NOT NULL REFERENCES "services"(id),
        name text NOT NULL,
        UNIQUE (service_id, name)
      );

      CREATE TABLE IF NOT EXISTS "aic_app"."credential_refs" (
        id uuid PRIMARY KEY,
        environment_id uuid NOT NULL REFERENCES "environments"(id),
        name text NOT NULL,
        access text NOT NULL CHECK (access IN ('read', 'write')),
        secret_name text NOT NULL,
        UNIQUE (environment_id, name)
      );

      CREATE TABLE IF NOT EXISTS "aic_app"."source_bindings" (
        id uuid PRIMARY KEY,
        environment_id uuid NOT NULL REFERENCES "environments"(id),
        name text NOT NULL,
        adapter_id text NOT NULL,
        adapter_version text NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        credential_ref_id uuid REFERENCES "credential_refs"(id),
        UNIQUE (environment_id, name)
      );

      CREATE TABLE IF NOT EXISTS "aic_app"."action_policies" (
        id uuid PRIMARY KEY,
        environment_id uuid NOT NULL UNIQUE REFERENCES "environments"(id),
        allowed_action_types text[] NOT NULL DEFAULT '{}'::text[],
        write_credential_ref_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
      );

      CREATE TABLE IF NOT EXISTS "aic_app"."incidents" (
        id text PRIMARY KEY,
        idempotency_key text NOT NULL UNIQUE,
        primary_service_id uuid,
        primary_environment_id uuid,
        body jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE IF NOT EXISTS "aic_app"."registry_events" (
        seq bigserial PRIMARY KEY,
        kind text NOT NULL,
        subject_id uuid,
        body jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `,
  }),
]);

/**
 * A transaction-scoped advisory lock key, held only for the duration of
 * `setupApplicationSchema`'s own transaction (`pg_advisory_xact_lock` releases
 * automatically at COMMIT or ROLLBACK — no unlock call is needed or correct
 * here). It is what makes two concurrent `setupApplicationSchema` calls safe:
 * without it, two sessions racing `CREATE SCHEMA IF NOT EXISTS` /
 * `CREATE TABLE IF NOT EXISTS` can both pass the "if not exists" check before
 * either commits and then collide on PostgreSQL's own catalog uniqueness — a
 * well-known race with the "if not exists" forms, not a hypothetical one.
 * Nothing else in this package takes a lock by this key.
 */
const SCHEMA_SETUP_LOCK_KEY = 847_361_209;

/**
 * Provisions the `aic_app` schema: creates it if absent, creates the
 * migration ledger if absent, and applies every entry of
 * `APPLICATION_MIGRATIONS` not yet recorded in it — all inside one
 * transaction, so a failure partway through leaves nothing half-applied.
 * Idempotent: calling it again applies nothing new and still succeeds. See
 * infra/postgres/tests/run-store.live.mjs › "setupApplicationSchema is
 * idempotent, and assertApplicationSchemaVersion then matches".
 *
 * Opens and closes its own pool: unlike `createRunStore`, this is a one-shot
 * provisioning step with no lifecycle for a caller to hold onto.
 */
export async function setupApplicationSchema(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    let failure: unknown;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_SETUP_LOCK_KEY]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${APPLICATION_SCHEMA}"`);
        await client.query(
          `CREATE TABLE IF NOT EXISTS "${APPLICATION_SCHEMA}".schema_migrations (
             version integer PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
           )`,
        );
        for (const migration of APPLICATION_MIGRATIONS) {
          const { rows } = await client.query(
            `SELECT 1 FROM "${APPLICATION_SCHEMA}".schema_migrations WHERE version = $1`,
            [migration.version],
          );
          if (rows.length === 0) {
            await client.query(migration.sql);
            await client.query(`INSERT INTO "${APPLICATION_SCHEMA}".schema_migrations (version) VALUES ($1)`, [
              migration.version,
            ]);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        failure = error;
        try {
          await client.query('ROLLBACK');
        } catch {
          // The migration's own error is the one to report; a connection that
          // cannot even roll back is released as broken below.
        }
        throw error;
      }
    } finally {
      client.release(failure);
    }
  } finally {
    await pool.end();
  }
}

/**
 * What the seam reads from: anything that can answer one query — the same
 * structural-port convention `CheckpointerVersionSource` follows in
 * `index.ts`, for the same reason (the library, here `pg.Pool`, is not
 * imported into this module's public type surface).
 */
export interface ApplicationSchemaVersionSource {
  query(sql: string): Promise<{ rows: Array<{ v: number | null }> }>;
}

/**
 * The `schemaVersion` validation seam for the application schema, mirroring
 * `assertCheckpointerSchemaVersion` in `index.ts`: it refuses loudly on a
 * version this build was not written against and does nothing else — no
 * migration, no repair. See run-store.test.mjs › "assertApplicationSchemaVersion
 * refuses a mismatched and a missing version on a fake source, and accepts the
 * current one".
 */
export async function assertApplicationSchemaVersion(source: ApplicationSchemaVersionSource): Promise<void> {
  const { rows } = await source.query(`select max(version) as v from "${APPLICATION_SCHEMA}".schema_migrations`);
  const applied = rows[0]?.v ?? null;

  if (applied !== APP_SCHEMA_VERSION) {
    throw new Error(
      `the application schema "${APPLICATION_SCHEMA}" is at migration version ${applied}, and this build expects ${APP_SCHEMA_VERSION}: refusing before execution rather than reading a store written by a different application schema`,
    );
  }
}

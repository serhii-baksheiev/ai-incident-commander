import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { withDeclaredOwnValues } from './own-value-serde.js';

export {
  DESERIALIZATION_MAX_DEPTH,
  DESERIALIZATION_MAX_NODES,
  DeserializationBudgetError,
  UnverifiableContainerError,
  withDeclaredOwnValues,
} from './own-value-serde.js';

export const PERSISTENCE_LAYER = 'persistence' as const;

/**
 * The one place this repository builds a checkpointer, which is why the serde
 * is wired here rather than at each call site.
 *
 * `SqliteSaver.fromConnString` drops the serde argument, so the saver arrives
 * with the default `JsonPlusSerializer`; `.serde` is a public assignable field
 * on `BaseCheckpointSaver`, so the wrapper is an injection rather than a fork.
 * see checkpoint-serde-own-values.test.mjs › "keeps the own value the
 * serialized form declares when an inherited setter writes another"
 */
export function createSqliteCheckpointer(checkpointPath: string): SqliteSaver {
  const saver = SqliteSaver.fromConnString(checkpointPath);
  saver.serde = withDeclaredOwnValues(saver.serde);
  return saver;
}

/**
 * The application's own schema, and the checkpointer's — two names, never one.
 *
 * AIC-55 acceptance row 4 asks that checkpointer storage live separately from
 * `aic_app`. Separate schemas are what makes the rest of that row's intent
 * mechanical rather than habitual: a domain query cannot reach a checkpoint
 * table by accident, a grant can be written against one and not the other, and
 * AIC-41's future backup/restore procedure can name each independently.
 *
 * `APPLICATION_SCHEMA` is declared in `app-schema.ts`, which also owns the
 * migrations and the run store built on it, and re-exported here so both
 * schema names are exported from the same place.
 * see postgres-checkpointer.test.mjs › "declares a checkpointer schema that is neither public nor the application schema"
 */
export { APPLICATION_SCHEMA } from './app-schema.js';
export const CHECKPOINTER_SCHEMA = 'langgraph' as const;

/**
 * The one place this repository builds a PostgreSQL checkpointer.
 *
 * Two things this does that the library does not do for you, both load-bearing:
 *
 * 1. **The serde is injected.** `PostgresSaver.fromConnString` passes `void 0`
 *    as the serde, so the saver arrives with the default `JsonPlusSerializer` —
 *    the same gap `createSqliteCheckpointer` works around above. A checkpointer
 *    that skips `withDeclaredOwnValues` silently drops the own-value protection
 *    AIC-93 added, and nothing in a passing graph run would show it.
 *    see postgres-checkpointer.test.mjs › "builds the PostgreSQL checkpointer with the own-value serde, not the library default"
 * 2. **The schema is declared.** The library defaults to `public`; every
 *    checkpointer table is then unqualified at runtime through `search_path`.
 *    see postgres-checkpointer.test.mjs › "qualifies every checkpointer table with the checkpointer schema"
 *
 * ⚠ **This does not provision anything.** `setup()` is the caller's explicit
 * step, which is AIC-55 acceptance row 5. The library reads `isSetup` nowhere,
 * so it performs no lazy migration of its own — but that is the library's
 * current behaviour, not a guarantee this repository can offer, so the row
 * below watches the pool rather than trusting it.
 * see postgres-checkpointer.test.mjs › "opens no connection and issues no statement while the checkpointer is being built"
 */
export function createPostgresCheckpointer(connectionString: string): PostgresSaver {
  const saver = PostgresSaver.fromConnString(connectionString, {
    schema: CHECKPOINTER_SCHEMA,
  });
  saver.serde = withDeclaredOwnValues(saver.serde);
  return saver;
}

/**
 * The migration version this repository has been built and tested against.
 *
 * Measured, not read off a changelog: `setup()` against an empty PostgreSQL 17
 * leaves `max(v) = 4` in `<schema>.checkpoint_migrations`, which is the library's
 * own version ledger.
 * see infra/postgres/tests/postgres-checkpointer.live.mjs › "agrees with the migration version a real setup() writes, and refuses any other"
 */
export const CHECKPOINTER_MIGRATION_VERSION = 4 as const;

/**
 * What the seam reads from: anything that can answer one query.
 *
 * Structural rather than `pg.Pool`, for two reasons. The library declares
 * `pool` private, so a typed caller cannot hand over the saver's own pool; and
 * a narrow port keeps `pg` out of this module's type surface, which is the
 * bounded-adapter convention the rest of this repository follows.
 */
export interface CheckpointerVersionSource {
  query(sql: string): Promise<{ rows: Array<{ v: number | null }> }>;
}

/**
 * The `schemaVersion` validation seam AIC-55 owns — and only the seam.
 *
 * AIC-55's scope asks for a validation seam while leaving the historical
 * migration, corruption and DR policy to AIC-41. So this refuses loudly on a
 * version it was not built against and does nothing else: it does not migrate,
 * does not repair, and does not decide which older versions are acceptable.
 * That decision is the policy AIC-41 plugs in here.
 *
 * 🔴 **Refusing is the point.** The failure this prevents is a process that
 * opens a checkpoint store written by a different version of the checkpointer,
 * reads what it expects to be there, and continues — which surfaces later, as
 * corrupt-looking state, far from the cause. `.claude/rules/autonomy.md` asks a
 * mismatch to refuse before execution rather than during it.
 *
 * ⚠ It reads the LIBRARY's migration ledger, not a domain state version. The
 * graph layer validates its own persisted state separately, and neither check
 * substitutes for the other.
 */
export async function assertCheckpointerSchemaVersion(
  source: CheckpointerVersionSource,
): Promise<void> {
  const { rows } = await source.query(
    `select max(v) as v from "${CHECKPOINTER_SCHEMA}".checkpoint_migrations`,
  );
  const applied = rows[0]?.v ?? null;

  if (applied !== CHECKPOINTER_MIGRATION_VERSION) {
    throw new Error(
      `the checkpointer schema "${CHECKPOINTER_SCHEMA}" is at migration version ${applied}, and this build expects ${CHECKPOINTER_MIGRATION_VERSION}: refusing before execution rather than reading a store written by a different checkpointer — migrating it is AIC-41's policy, not this seam's`,
    );
  }
}

/**
 * AIC-56 slice B: the `aic_app` application schema — its migrations, its
 * `schemaVersion` seam, and the run store built on it — beside the
 * checkpointer schema this module already owns above.
 */
export {
  APP_SCHEMA_VERSION,
  APPLICATION_MIGRATIONS,
  assertApplicationSchemaVersion,
  setupApplicationSchema,
  type ApplicationSchemaVersionSource,
} from './app-schema.js';

export {
  createRunStore,
  RUN_STORE_TRANSITIONS,
  type RunClaim,
  type RunRecord,
  type RunStore,
  type RunStoreOptions,
} from './run-store.js';

/**
 * AIC-56 slice C: the fenced write context every run-scoped write goes
 * through, built on `RunStore` above.
 */
export {
  openRunWriteContext,
  RUN_WRITE_CONTEXT_FENCE_SQL,
  type CommittedOptions,
  type RunWriteContext,
} from './run-write-context.js';

/**
 * AIC-56 slice E: checkpoint writes fenced by the run write context's
 * ownership check.
 */
export {
  createFencedCheckpointer,
  type CheckpointFence,
  type FencedCheckpointerOptions,
} from './fenced-checkpointer.js';

/**
 * AIC-56 slice F: the retention boundary — the product-API read model that
 * never reads `node_results`, and the guard that prunes a terminal run's
 * `node_results` and checkpoint thread.
 */
export {
  pruneTerminalRun,
  readRunProductSnapshot,
  RunNotTerminalError,
  type RetentionCheckpointer,
  type RunProductSnapshot,
} from './retention.js';

/**
 * AIC-58 slice a: a durable, tail/poll `RunEventStreamSource` (the domain
 * port `@aic/domain` declares) over the run's append-only event timeline in
 * `aic_app` (named in `run-event-stream.ts`, not repeated here — see
 * test/run-events-table-boundary.test.mjs for why this file names no table).
 */
export {
  createRunEventStreamSource,
  MAX_RUN_EVENT_READ_LIMIT,
  MIN_RUN_EVENT_POLL_INTERVAL_MS,
  type RunEventStreamSourceOptions,
} from './run-event-stream.js';

/**
 * AIC-99 slice c: the transactional registry store built on migration 3's
 * normalized tables (`app-schema.ts`). `RegistryValidationError` and
 * `RegistryConflictError` are deliberately NOT re-exported here: this
 * repository's only caller so far (registry-store.live.mjs) reads a rejected
 * mutation by `error.name` and, for a validation failure, `error.issues` —
 * never by importing the class — so the export list this module already
 * pins (`durable-run-boundaries.test.mjs`) stays unchanged apart from
 * `createRegistryStore` itself.
 */
export { createRegistryStore, type RegistryStore } from './registry-store.js';

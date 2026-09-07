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
 * They are exported so the boundary rows and the database-backed lane read the
 * same two strings this module builds with, rather than each spelling them
 * again — one source, the convention `.claude/rules/invariants.md` states.
 * see postgres-checkpointer.test.mjs › "declares a checkpointer schema that is neither public nor the application schema"
 */
export const APPLICATION_SCHEMA = 'aic_app' as const;
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

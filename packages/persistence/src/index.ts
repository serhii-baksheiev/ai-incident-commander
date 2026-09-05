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

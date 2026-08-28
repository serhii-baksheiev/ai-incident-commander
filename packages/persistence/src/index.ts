import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

export const PERSISTENCE_LAYER = 'persistence' as const;

export function createSqliteCheckpointer(checkpointPath: string): SqliteSaver {
  return SqliteSaver.fromConnString(checkpointPath);
}

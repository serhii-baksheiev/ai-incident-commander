/**
 * A hand-written, minimal declaration for `pg` — no `@types/pg`.
 *
 * Covers exactly the surface this package's `run-store.ts`, `app-schema.ts`
 * and `run-write-context.ts` use: `Pool` construction, `query`, `connect`,
 * `end`, `on('error', ...)`, the pool's connection counters, and
 * `PoolClient`'s `query`/`release`. Anything `pg` exports beyond this is
 * deliberately left untyped rather than guessed at.
 */
declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
  }

  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    release(error?: unknown): void;
  }

  export interface PoolConfig {
    connectionString?: string;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: 'error', listener: (error: unknown) => void): this;
  }
}

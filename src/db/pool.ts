import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

const { Pool, types } = pg;

// numeric/int8 must never become a lossy JS number: uint256 amounts and nonces stay
// strings and are parsed deliberately at the edges that need them.
types.setTypeParser(types.builtins.NUMERIC, (value) => value);
types.setTypeParser(types.builtins.INT8, (value) => value);

export type Database = NodePgDatabase<typeof schema>;

/** The handle drizzle hands to a `db.transaction` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything that can run a statement. Repository functions accept this so the caller
 * decides the transaction boundary, rather than each repository opening its own.
 */
export type Executor = Database | Transaction;
export type PgPool = pg.Pool;
export type PgPoolClient = pg.PoolClient;

export interface DbHandle {
  readonly pool: PgPool;
  readonly db: Database;
  close(): Promise<void>;
}

export function createDbHandle(options: { url: string; maxConnections: number }): DbHandle {
  const pool = new Pool({
    connectionString: options.url,
    max: options.maxConnections,
    // Fail fast rather than letting a request hang on an exhausted pool.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  // An idle client error must not take the process down.
  pool.on('error', () => undefined);

  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
}

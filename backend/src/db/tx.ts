import type pg from "pg";
import { pool } from "./pool";

// Run `fn` inside a single transaction: BEGIN, then COMMIT (returning fn's result) on success,
// or ROLLBACK + rethrow on error. The connection is always released. Replaces the hand-rolled
// begin/commit/rollback/release boilerplate that was duplicated across the data layer.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

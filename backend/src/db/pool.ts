import "../env";
import pg from "pg";

const { Pool } = pg;

// The single shared connection pool. Every query in the db/ modules goes through this.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

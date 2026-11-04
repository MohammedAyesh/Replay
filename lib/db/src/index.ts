import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { withTransientRetry } from "./transientRetry";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// The production database scales to zero and closes connections when it does
// (2026-11-04). Keep-alive and a lifetime cap stop us reusing sockets it has
// already dropped; a connect timeout bounds a cold start; transient failures
// are retried (see transientRetry.ts).
export const pool = withTransientRetry(new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  connectionTimeoutMillis: 15_000,
  maxLifetimeSeconds: 300,
}), {
  onRetry: ({ attempt, phase, readOnly, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ level: 40, msg: "Retrying a database call after a dropped connection", attempt, phase, readOnly, error: message }));
  },
});
export const db = drizzle(pool, { schema });

export { isTransientConnectionError, isReadOnlyQuery, withTransientRetry } from "./transientRetry";
export * from "./schema";

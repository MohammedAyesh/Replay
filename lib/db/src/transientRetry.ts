/**
 * Retry for database connections that drop (2026-11-04).
 *
 * The production database scales to zero when idle and closes every open
 * connection when it does; the Autoscale API instance is idle between requests
 * too. A query that lands on a dropped or waking connection failed with
 * "Connection terminated unexpectedly", `ECONNRESET` or "Client network socket
 * disconnected before secure TLS connection was established". In a background
 * timer that was an unhandled rejection and the process exited (~30 times a
 * day); in a request it was a 500 (the GPU worker's queue polls, the WhatsApp
 * tick, the academies list).
 *
 * Getting a connection is always safe to retry: nothing has been sent yet.
 * Running a query is retried only for reads, because a write whose connection
 * dropped mid-flight may already have committed.
 */

type Queryable = {
  query: (...args: any[]) => any;
  connect: () => Promise<PoolClientLike>;
};

type PoolClientLike = {
  query: (config: unknown, values?: unknown) => Promise<unknown>;
  release: (err?: Error | boolean) => void;
};

const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  // Postgres: admin shutdown / crash shutdown / cannot connect now (class 08, connection exceptions, below)
  "57P01", "57P02", "57P03",
]);

const TRANSIENT_MESSAGES = [
  /connection terminated unexpectedly/i,
  /connection terminated due to connection timeout/i,
  /timeout exceeded when trying to connect/i,
  /client network socket disconnected before secure tls connection was established/i,
  /client has encountered a connection error and is not queryable/i,
  /terminating connection due to administrator command/i,
  /the database system is (starting up|shutting down)/i,
  /server closed the connection unexpectedly/i,
  /econnreset/i,
];

/** Whether an error (or anything in its `cause` chain) is a dropped or refused connection. */
export function isTransientConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && (TRANSIENT_CODES.has(e.code) || /^08[0-9A-Z]{3}$/.test(e.code))) return true;
    if (typeof e.message === "string" && TRANSIENT_MESSAGES.some((re) => re.test(e.message as string))) return true;
    current = e.cause;
  }
  return false;
}

/** A statement that only reads, so running it twice is harmless. */
export function isReadOnlyQuery(text: string): boolean {
  const sql = text.replace(/^\s*(\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*/, "").trimStart().toLowerCase();
  if (sql.startsWith("select") || sql.startsWith("show") || sql.startsWith("(select")) {
    return !/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/.test(sql) && !/\bnextval\s*\(/.test(sql);
  }
  if (sql.startsWith("with")) return !/\b(insert|update|delete|merge)\b/.test(sql) && !/\bnextval\s*\(/.test(sql);
  return false;
}

export type RetryOptions = {
  /** total tries, first one included */
  attempts?: number;
  /** delay before the 2nd try; doubles each time */
  baseDelayMs?: number;
  onRetry?: (info: { attempt: number; readOnly: boolean; phase: "connect" | "query"; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Replace `pool.query` (what Drizzle calls outside transactions) with a version
 * that retries transient connection failures. Callback calls and submittables
 * (cursors, streams) go to the original untouched; transactions use
 * `pool.connect()` and are not affected.
 */
export function withTransientRetry<T extends Queryable>(pool: T, options: RetryOptions = {}): T {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const original = pool.query.bind(pool);

  async function run(config: unknown, values: unknown): Promise<unknown> {
    const text = typeof config === "string" ? config : String((config as { text?: unknown } | null)?.text ?? "");
    const readOnly = isReadOnlyQuery(text);
    for (let attempt = 1; ; attempt++) {
      const wait = baseDelayMs * 2 ** (attempt - 1);
      let client: PoolClientLike;
      try {
        client = await pool.connect();
      } catch (error) {
        if (attempt < attempts && isTransientConnectionError(error)) {
          options.onRetry?.({ attempt, readOnly, phase: "connect", error });
          await sleep(wait);
          continue;
        }
        throw error;
      }
      try {
        const result = values === undefined ? await client.query(config) : await client.query(config, values);
        client.release();
        return result;
      } catch (error) {
        const transient = isTransientConnectionError(error);
        // A broken connection must not go back into the pool.
        client.release(transient ? (error as Error) : undefined);
        if (transient && readOnly && attempt < attempts) {
          options.onRetry?.({ attempt, readOnly, phase: "query", error });
          await sleep(wait);
          continue;
        }
        throw error;
      }
    }
  }

  (pool as { query: (...args: any[]) => any }).query = (config: unknown, values?: unknown, callback?: unknown) => {
    if (typeof values === "function" || typeof callback === "function"
      || (config && typeof (config as { submit?: unknown }).submit === "function")) {
      return original(config, values, callback);
    }
    return run(config, values);
  };
  return pool;
}

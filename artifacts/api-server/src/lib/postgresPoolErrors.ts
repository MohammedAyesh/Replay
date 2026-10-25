type ErrorPool = {
  on(event: "error", listener: (error: Error) => void): unknown;
};

type WarnLogger = {
  warn(fields: { err: Error }, message: string): unknown;
};

export function attachPostgresIdleErrorListener(pool: ErrorPool, logger: WarnLogger): void {
  pool.on("error", (err) => {
    logger.warn({ err }, "Postgres idle client error");
  });
}

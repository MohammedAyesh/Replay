import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { attachPostgresIdleErrorListener } from "./postgresPoolErrors";

describe("attachPostgresIdleErrorListener", () => {
  it("logs pool errors without throwing", () => {
    const pool = new EventEmitter();
    const logger = { warn: vi.fn() };
    const error = new Error("Connection terminated unexpectedly");

    attachPostgresIdleErrorListener(pool, logger);

    expect(() => pool.emit("error", error)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith({ err: error }, "Postgres idle client error");
  });
});

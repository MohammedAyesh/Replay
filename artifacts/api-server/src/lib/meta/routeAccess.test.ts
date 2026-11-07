import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { sendFailure } from "./routeAccess";

function response() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe("database schema errors", () => {
  it("identifies a missing table without claiming it is an ads table", () => {
    const out = response();

    sendFailure(out.res, { cause: { code: "42P01" } }, "Loading data failed");

    expect(out.status).toHaveBeenCalledWith(500);
    expect(out.json).toHaveBeenCalledWith({
      error: "A required database table is missing. Apply the schema update, then publish again.",
    });
  });

  it("identifies a missing column without claiming tables are missing", () => {
    const out = response();

    sendFailure(out.res, { cause: { code: "42703" } }, "Loading data failed");

    expect(out.status).toHaveBeenCalledWith(500);
    expect(out.json).toHaveBeenCalledWith({
      error: "A required database column is missing. Apply the schema update, then publish again.",
    });
  });
});

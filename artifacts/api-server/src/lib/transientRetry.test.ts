import { describe, expect, it } from "vitest";
import { isReadOnlyQuery, isTransientConnectionError, withTransientRetry } from "@workspace/db";

// The errors production logged before each crash (2026-11-01 … 11-04).
const terminated = new Error("Connection terminated unexpectedly");
const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", errno: -104, syscall: "read" });
const tls = new Error("Client network socket disconnected before secure TLS connection was established");
const drizzleWrapped = Object.assign(new Error("Failed query: select 1"), { cause: reset });

function fakePool(script: Array<"connect-fail" | "query-fail" | "ok">) {
  const calls = { connect: 0, query: 0, released: [] as Array<unknown> };
  const pool = {
    query: (..._args: unknown[]) => { throw new Error("original pool.query should not be used for promise calls"); },
    connect: async () => {
      calls.connect++;
      const step = script.shift() ?? "ok";
      if (step === "connect-fail") throw tls;
      return {
        query: async () => {
          calls.query++;
          if (step === "query-fail") throw terminated;
          return { rows: [{ ok: 1 }] };
        },
        release: (err?: unknown) => { calls.released.push(err ?? null); },
      };
    },
  };
  return { pool: withTransientRetry(pool, { sleep: async () => {} }), calls };
}

describe("transient database connection retry", () => {
  it("recognises the production connection errors, also wrapped by Drizzle", () => {
    for (const error of [terminated, reset, tls, drizzleWrapped]) expect(isTransientConnectionError(error)).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("protocol violation"), { code: "08P01" }))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isTransientConnectionError(new Error("relation does not exist"))).toBe(false);
  });

  it("tells reads from writes", () => {
    expect(isReadOnlyQuery('select "id" from "footage_requests" where "status" in ($1, $2)')).toBe(true);
    expect(isReadOnlyQuery("with x as (select 1) select * from x")).toBe(true);
    expect(isReadOnlyQuery("  /* c */ SELECT 1")).toBe(true);
    expect(isReadOnlyQuery('update "user_clips" set "export_status" = $1')).toBe(false);
    expect(isReadOnlyQuery('insert into "a" values (1) returning *')).toBe(false);
    expect(isReadOnlyQuery("with x as (delete from a returning *) select * from x")).toBe(false);
    expect(isReadOnlyQuery("select * from a for update")).toBe(false);
    expect(isReadOnlyQuery("select nextval('s')")).toBe(false);
  });

  it("retries a read whose connection dropped, and discards the broken connection", async () => {
    const { pool, calls } = fakePool(["query-fail", "query-fail", "ok"]);
    const result = await pool.query({ text: 'select "id" from "footage_requests"', rowMode: "array" });
    expect(result).toEqual({ rows: [{ ok: 1 }] });
    expect(calls.query).toBe(3);
    expect(calls.released).toEqual([terminated, terminated, null]);
  });

  it("does not run a write twice once it was sent", async () => {
    const { pool, calls } = fakePool(["query-fail", "ok"]);
    await expect(pool.query({ text: 'update "user_clips" set "x" = $1', values: [1] })).rejects.toBe(terminated);
    expect(calls.query).toBe(1);
  });

  it("retries a write whose connection never opened", async () => {
    const { pool, calls } = fakePool(["connect-fail", "ok"]);
    await expect(pool.query('insert into "a" values (1)')).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(calls.connect).toBe(2);
    expect(calls.query).toBe(1);
  });

  it("gives up after the last attempt and passes other errors straight through", async () => {
    const { pool, calls } = fakePool(["query-fail", "query-fail", "query-fail", "query-fail", "ok"]);
    await expect(pool.query("select 1")).rejects.toBe(terminated);
    expect(calls.query).toBe(4);

    const syntax = Object.assign(new Error('syntax error at or near "selec"'), { code: "42601" });
    let queried = 0;
    const strict = withTransientRetry({
      query: (..._args: unknown[]) => undefined,
      connect: async () => ({ query: async () => { queried++; throw syntax; }, release: () => {} }),
    }, { sleep: async () => {} });
    await expect(strict.query("selec 1")).rejects.toBe(syntax);
    expect(queried).toBe(1);
  });

  it("leaves callback calls on the original pool.query", () => {
    let original = 0;
    const pool = withTransientRetry({ query: (..._args: unknown[]) => { original++; }, connect: async () => { throw new Error("unused"); } });
    pool.query("select 1", [], () => {});
    expect(original).toBe(1);
  });
});

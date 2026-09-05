/**
 * The admin settings API.
 *
 * Two things are worth testing here and they are not the CRUD. First, that a bad
 * rule cannot be stored: a rule is data that changes behaviour for real people,
 * and its failure mode is not a crash but a plausible value silently applying to
 * the wrong population. Second, the preview — with priority-based precedence,
 * no single rule tells you what is in force, so "what does this user get, and
 * which rule decided" is the feature that makes the model usable rather than
 * frightening.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { db, usersTable, settingsRulesTable, settingsDefaultsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { invalidateSettingsCache, isMissingRelationError } from "../lib/settings";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));
import { getLocalUserId } from "../lib/clerkUserBridge";
const mockedGetLocalUserId = vi.mocked(getLocalUserId);

const TAG = `set_${Date.now()}`;
let app: Express;
let adminId: number;
let plainId: number;

beforeAll(async () => {
  const { default: adminSettingsRouter } = await import("./adminSettings");
  app = express();
  app.use(express.json());
  app.use("/api", adminSettingsRouter);

  const [admin] = await db.insert(usersTable)
    .values({ name: "Admin", email: `admin_${TAG}@test.local`, isAdmin: true })
    .returning({ id: usersTable.id });
  const [plain] = await db.insert(usersTable)
    .values({ name: "Plain", email: `plain_${TAG}@test.local` })
    .returning({ id: usersTable.id });
  adminId = admin.id;
  plainId = plain.id;
});

afterAll(async () => {
  await db.delete(settingsDefaultsTable);
  await db.delete(settingsRulesTable);
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, plainId]));
  invalidateSettingsCache();
});

afterEach(async () => {
  await db.delete(settingsDefaultsTable);
  await db.delete(settingsRulesTable);
  invalidateSettingsCache();
});

const asAdmin = () => mockedGetLocalUserId.mockResolvedValue(adminId);
const post = (body: unknown) => request(app).post("/api/admin/settings/rules").send(body as object);

describe("who can touch it", () => {
  it("refuses an anonymous caller", async () => {
    mockedGetLocalUserId.mockResolvedValue(null as never);
    expect((await request(app).get("/api/admin/settings/rules")).status).toBe(401);
    expect((await post({ key: "downloads.limit", value: 1 })).status).toBe(401);
  });

  it("refuses a signed-in non-admin", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    expect((await request(app).get("/api/admin/settings/registry")).status).toBe(401);
    expect((await post({ key: "downloads.limit", value: 1 })).status).toBe(401);
  });
});

describe("the catalogue", () => {
  it("lists every adjustable value with its type, bounds and default", async () => {
    asAdmin();
    const res = await request(app).get("/api/admin/settings/registry");
    expect(res.status).toBe(200);
    const keys = res.body.settings.map((s: { key: string }) => s.key);
    expect(keys).toContain("downloads.limit");
    expect(keys).toContain("export.crf");
    expect(keys).toContain("render.maxConcurrent");
    const limit = res.body.settings.find((s: { key: string }) => s.key === "downloads.limit");
    expect(limit).toMatchObject({ type: "number", defaultValue: 5, min: 0, integer: true });
  });
});

describe("what cannot be stored", () => {
  it("rejects an unknown key", async () => {
    asAdmin();
    const res = await post({ key: "downloads.unlimited_free_money", value: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown setting/i);
  });

  it("rejects a value of the wrong type, including a numeric string", async () => {
    asAdmin();
    // An admin form will happily submit "5". Storing it would make the resolver
    // hand a string to code expecting a number, and fail somewhere unrelated.
    expect((await post({ key: "downloads.limit", value: "5" })).status).toBe(400);
    expect((await post({ key: "downloads.enabled", value: "yes" })).status).toBe(400);
    expect((await post({ key: "export.preset", value: "blazing" })).status).toBe(400);
  });

  it("rejects a value outside the registered bounds", async () => {
    asAdmin();
    expect((await post({ key: "export.crf", value: 3 })).status).toBe(400);
    expect((await post({ key: "export.crf", value: 99 })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 2.5 })).status).toBe(400);
  });

  it("rejects a scoped rule with no id, and a global rule with one", async () => {
    asAdmin();
    expect((await post({ key: "downloads.limit", value: 1, scopeType: "user" })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 1, scopeType: "global", scopeId: 4 })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 1, scopeType: "planet", scopeId: 4 })).status).toBe(400);
  });

  it("rejects a half-specified or zero-length time window", async () => {
    asAdmin();
    expect((await post({ key: "downloads.limit", value: 1, startMinute: 600 })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 1, startMinute: 600, endMinute: 600 })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 1, startMinute: 600, endMinute: 2000 })).status).toBe(400);
  });

  it("rejects a window that ends before it starts, and an unknown time zone", async () => {
    asAdmin();
    expect((await post({
      key: "downloads.limit", value: 1,
      effectiveFrom: "2026-09-10T00:00:00Z", effectiveUntil: "2026-09-01T00:00:00Z",
    })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 1, timezone: "Mars/Olympus" })).status).toBe(400);
  });

  it("rejects a malformed exclusion", async () => {
    asAdmin();
    expect((await post({ key: "downloads.limit", value: 1, excludes: [{ scopeType: "global", scopeId: 1 }] })).status).toBe(400);
    expect((await post({ key: "downloads.limit", value: 1, excludes: [{ scopeType: "user" }] })).status).toBe(400);
  });

  it("validates the merged rule on edit, not just the fields being changed", async () => {
    asAdmin();
    const created = await post({ key: "downloads.limit", value: 1, startMinute: 600, endMinute: 900 });
    expect(created.status).toBe(201);
    // Removing only the start leaves an end with no start — invalid as a whole,
    // even though the patch on its own looks harmless.
    const patched = await request(app)
      .patch(`/api/admin/settings/rules/${created.body.rule.id}`)
      .send({ startMinute: null });
    expect(patched.status).toBe(400);
  });
});

describe("what a rule does once stored", () => {
  it("accepts a well-formed rule and normalises its days", async () => {
    asAdmin();
    const res = await post({
      key: "downloads.limit", value: 20, scopeType: "academy", scopeId: 3,
      priority: 5, daysOfWeek: [5, 5, 6], startMinute: 18 * 60, endMinute: 60,
      note: "Weekend evenings at the academy",
    });
    expect(res.status).toBe(201);
    expect(res.body.rule).toMatchObject({
      key: "downloads.limit", value: 20, scopeType: "academy", scopeId: 3,
      priority: 5, daysOfWeek: [5, 6], enabled: true, timezone: "Asia/Amman",
    });
  });

  it("deletes, and reports a missing rule honestly", async () => {
    asAdmin();
    const created = await post({ key: "downloads.limit", value: 2 });
    expect((await request(app).delete(`/api/admin/settings/rules/${created.body.rule.id}`)).status).toBe(200);
    expect((await request(app).delete(`/api/admin/settings/rules/${created.body.rule.id}`)).status).toBe(404);
  });
});

describe("the preview — why does this person get this value", () => {
  it("shows the shipped default and says so when no rule applies", async () => {
    asAdmin();
    const res = await request(app).get("/api/admin/settings/preview");
    expect(res.status).toBe(200);
    const limit = res.body.settings.find((s: any) => s.definition.key === "downloads.limit");
    expect(limit).toMatchObject({ isDefault: true });
    expect(limit.resolution).toMatchObject({ value: 5, rule: null, matched: [] });
  });

  it("names the winning rule and every rule it beat", async () => {
    asAdmin();
    await post({ key: "downloads.limit", value: 20, scopeType: "academy", scopeId: 3, priority: 0 });
    const promo = await post({ key: "downloads.limit", value: 50, scopeType: "global", priority: 100 });

    const res = await request(app).get("/api/admin/settings/preview?academyId=3&key=downloads.limit");
    expect(res.status).toBe(200);
    expect(res.body.resolution.value).toBe(50);
    expect(res.body.resolution.rule.id).toBe(promo.body.rule.id);
    // Both matched — this is what stops two admins' rules being a mystery.
    expect(res.body.resolution.matched).toHaveLength(2);
    expect(res.body.resolution.matched.map((m: any) => m.value)).toEqual([50, 20]);
  });

  it("answers for a specific moment, so a scheduled rule can be checked before it fires", async () => {
    asAdmin();
    await post({
      key: "downloads.limit", value: 50, priority: 10,
      effectiveFrom: "2026-10-01T00:00:00Z", effectiveUntil: "2026-10-08T00:00:00Z",
    });
    const before = await request(app).get("/api/admin/settings/preview?key=downloads.limit&at=2026-09-20T12:00:00Z");
    const during = await request(app).get("/api/admin/settings/preview?key=downloads.limit&at=2026-10-03T12:00:00Z");
    expect(before.body.resolution.value).toBe(5);
    expect(during.body.resolution.value).toBe(50);
  });

  it("rejects an unusable 'at' rather than silently previewing now", async () => {
    asAdmin();
    expect((await request(app).get("/api/admin/settings/preview?at=lunchtime")).status).toBe(400);
  });
});

/**
 * The window between deploying the code and running the schema push.
 *
 * It used to answer 500, which tells an admin only that the page is broken. It
 * is a specific condition with a specific remedy, and the push is deliberately
 * interactive-only, so the API cannot fix it — it can only say so.
 *
 * The missing table is SIMULATED rather than dropped. An earlier version of
 * these tests really did `DROP TABLE settings_rules CASCADE`, which takes an
 * exclusive lock on a database the other suites are using concurrently — and it
 * duly made an unrelated claim-match concurrency test fail intermittently. A
 * test that breaks its neighbours is not worth the fidelity it buys.
 */
describe("before the schema push has been run", () => {
  const missingRelation = () => {
    const err = new Error(`relation "settings_rules" does not exist`) as Error & { code: string };
    err.code = "42P01";
    return err;
  };

  /**
   * Fail only reads of settings_rules, exactly as a missing table would.
   *
   * Narrow on purpose: a blanket spy on db.select also breaks the admin check,
   * so the route 500s before reaching the code under test and the test passes
   * for the wrong reason.
   */
  const withMissingTable = async (fn: () => Promise<void>) => {
    invalidateSettingsCache();
    const realSelect = db.select.bind(db);
    const selectSpy = vi.spyOn(db, "select").mockImplementation(((...args: unknown[]) => {
      const builder = (realSelect as (...a: unknown[]) => unknown)(...args) as { from: (t: unknown) => unknown };
      const realFrom = builder.from.bind(builder);
      builder.from = (table: unknown) => {
        if (table === settingsRulesTable) throw missingRelation();
        return realFrom(table);
      };
      return builder;
    }) as never);
    const realInsert = db.insert.bind(db);
    const insertSpy = vi.spyOn(db, "insert").mockImplementation(((table: unknown) => {
      if (table === settingsRulesTable) throw missingRelation();
      return (realInsert as (t: unknown) => unknown)(table);
    }) as never);
    try {
      await fn();
    } finally {
      selectSpy.mockRestore();
      insertSpy.mockRestore();
      invalidateSettingsCache();
    }
  };

  it("lists no rules and names the command to run, instead of a 500", async () => {
    asAdmin();
    await withMissingTable(async () => {
      const res = await request(app).get("/api/admin/settings/rules");
      expect(res.status).toBe(200);
      expect(res.body.rules).toEqual([]);
      expect(res.body.schemaReady).toBe(false);
      expect(res.body.message).toMatch(/pnpm --filter @workspace\/db run push/);
    });
  }, 30_000);

  it("refuses to save a rule with an explanation rather than a crash", async () => {
    asAdmin();
    await withMissingTable(async () => {
      const res = await post({ key: "downloads.limit", value: 2 });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/Shell tab/);
    });
  }, 30_000);

  it("recognises the Postgres missing-relation error by code and by message", () => {
    // Two shapes, because drizzle sometimes surfaces the driver error directly
    // and sometimes wraps it.
    expect(isMissingRelationError(missingRelation())).toBe(true);
    expect(isMissingRelationError({ cause: { code: "42P01" } })).toBe(true);
    expect(isMissingRelationError(new Error('relation "settings_rules" does not exist'))).toBe(true);
    // And must not swallow anything else — a connection failure is a real outage
    // and has to keep surfacing as one.
    expect(isMissingRelationError(new Error("connection refused"))).toBe(false);
    expect(isMissingRelationError({ code: "42703" })).toBe(false);
  });

  it("goes back to normal once the table is there again", async () => {
    asAdmin();
    await withMissingTable(async () => {
      expect((await request(app).get("/api/admin/settings/rules")).body.schemaReady).toBe(false);
    });
    const res = await request(app).get("/api/admin/settings/rules");
    expect(res.status).toBe(200);
    expect(res.body.schemaReady).toBe(true);
  }, 30_000);
});

/**
 * Changing the base value.
 *
 * The distinction that matters here is between the three layers, because they
 * mean different things to whoever is trying to work out why a number is what
 * it is: the product shipped this way, an administrator decided this is how it
 * should be, or a specific rule is firing right now.
 */
describe("the shipped defaults, made editable", () => {
  it("reports every setting as shipped until one is changed", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const res = await request(app).get("/api/admin/settings/defaults").expect(200);
    const limit = res.body.defaults.find((d: { key: string }) => d.key === "downloads.limit");
    expect(limit).toMatchObject({ value: 5, shippedValue: 5, isShipped: true });
  });

  it("changes the value everyone gets, without writing a rule", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    await request(app).put("/api/admin/settings/defaults/downloads.limit")
      .send({ value: 12, note: "bumped for the season" }).expect(200);

    const preview = await request(app).get("/api/admin/settings/preview").expect(200);
    const entry = preview.body.settings.find((e: { definition: { key: string } }) => e.definition.key === "downloads.limit");
    expect(entry.resolution.value).toBe(12);
    expect(entry.resolution.source).toBe("default");
    expect(entry.resolution.rule).toBeNull();

    // The point of the feature: no rule was created.
    const rules = await request(app).get("/api/admin/settings/rules").expect(200);
    expect(rules.body.rules).toHaveLength(0);
  });

  it("validates a base value exactly as strictly as a rule's", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    // "12" is the dangerous one: stored, it makes the resolver hand a string to
    // a caller expecting a number, and the failure surfaces somewhere unrelated.
    const asString = await request(app).put("/api/admin/settings/defaults/downloads.limit").send({ value: "12" });
    expect(asString.status).toBe(400);
    const outOfRange = await request(app).put("/api/admin/settings/defaults/downloads.limit").send({ value: -1 });
    expect(outOfRange.status).toBe(400);
    const unknown = await request(app).put("/api/admin/settings/defaults/nope.nope").send({ value: 1 });
    expect(unknown.status).toBe(400);
  });

  it("reverts to the shipped value by removing the row, not by copying it", async () => {
    // Copying today's shipped value into the row would pin it: a later change to
    // the default in code would be silently ignored for this key forever.
    mockedGetLocalUserId.mockResolvedValue(adminId);
    await request(app).put("/api/admin/settings/defaults/downloads.limit").send({ value: 12 }).expect(200);
    await request(app).delete("/api/admin/settings/defaults/downloads.limit").expect(200);

    const rows = await db.select().from(settingsDefaultsTable);
    expect(rows).toHaveLength(0);
    const res = await request(app).get("/api/admin/settings/defaults").expect(200);
    const limit = res.body.defaults.find((d: { key: string }) => d.key === "downloads.limit");
    expect(limit).toMatchObject({ value: 5, isShipped: true });
  });

  it("still lets a rule beat the base value", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    await request(app).put("/api/admin/settings/defaults/downloads.limit").send({ value: 12 }).expect(200);
    await request(app).post("/api/admin/settings/rules")
      .send({ key: "downloads.limit", value: 50, scopeType: "global", priority: 0 }).expect(201);

    const preview = await request(app).get("/api/admin/settings/preview").expect(200);
    const entry = preview.body.settings.find((e: { definition: { key: string } }) => e.definition.key === "downloads.limit");
    expect(entry.resolution.value).toBe(50);
    expect(entry.resolution.source).toBe("rule");
  });

  it("refuses a plain user", async () => {
    mockedGetLocalUserId.mockResolvedValue(plainId);
    await request(app).get("/api/admin/settings/defaults").expect(401);
    await request(app).put("/api/admin/settings/defaults/downloads.limit").send({ value: 9 }).expect(401);
    await request(app).delete("/api/admin/settings/defaults/downloads.limit").expect(401);
  });
});

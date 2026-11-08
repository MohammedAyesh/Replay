import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { academiesTable, academyCreativeTemplatesTable, academyMembersTable, creativeLibraryTemplatesTable, db, fieldsTable, usersTable } from "@workspace/db";
import { buildTemplateScene, builtInTemplateFile, parseTemplateFile, sceneSchema, type Scene } from "@workspace/api-zod";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }),
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const id = Number(req.headers["x-test-user"]);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return user ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import libraryRouter from "./creativeTemplateLibrary";
import { replacementFor, replacementScenes } from "../lib/creative/myTemplates";

const tag = Date.now();
const OFFER = JSON.parse(fs.readFileSync(new URL("../../../../templates/field-special-offer.json", import.meta.url), "utf8"));
let app: Express;
let admin: number;
let fieldOwner: number;
let academyOwner: number;
let venueId: number;
let academyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const lib = (p = "") => `/api/admin/creative/template-library${p}`;
const owned = (id: number) => `/api/academy/console/academies/${id}/creative/library-templates`;

/** A file replacing the open-slots story with the built-in's own scene and a new background. */
const openSlotsFile = (key: string, extra: Record<string, unknown> = {}) => ({
  replayTemplate: 1, key, title: { en: "Free tonight, dark", ar: "فاضي الليلة" }, audience: "field",
  baseKey: "field-open-slots", replacesBase: true,
  formats: { story: { ...buildTemplateScene("field-open-slots", "field", "story", "ar"), background: "#101010" } },
  ...extra,
});

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", libraryRouter);
  const users = await db.insert(usersTable).values([
    { name: `Admin ${tag}`, email: `lib-admin-${tag}@test.local`, isAdmin: true },
    { name: `Field ${tag}`, email: `lib-field-${tag}@test.local` },
    { name: `Academy ${tag}`, email: `lib-academy-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [admin, fieldOwner, academyOwner] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Library field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const rows = await db.insert(academiesTable).values([
    { name: `Library venue ${tag}`, fieldId: field.id, kind: "venue" },
    { name: `Library academy ${tag}`, fieldId: field.id },
  ]).returning({ id: academiesTable.id });
  [venueId, academyId] = rows.map((r) => r.id);
  await db.insert(academyMembersTable).values([
    { academyId: venueId, userId: fieldOwner, role: "owner" },
    { academyId, userId: academyOwner, role: "owner" },
  ]);
  await db.delete(creativeLibraryTemplatesTable);
});

describe("template files (2026-11-08)", () => {
  it("reads the special offer file, and every built-in exported as a file reads back", () => {
    const offer = parseTemplateFile(OFFER);
    expect(offer.ok && offer.templates[0]).toMatchObject({ key: "field-special-offer", audience: "field" });
    for (const key of ["field-open-slots", "field-match-week-reel", "goal"]) {
      const file = builtInTemplateFile(key, "ar");
      expect(parseTemplateFile(file)).toMatchObject({ ok: true });
    }
  });

  it("says what is wrong and keeps nothing", () => {
    const story = buildTemplateScene("field-open-slots", "field", "story", "ar");
    const bad = parseTemplateFile({ replayTemplates: 1, templates: [
      { key: "a-b", title: { en: "A", ar: "أ" }, formats: { post: story } },
      { key: "Bad Key", title: { en: "B", ar: "ب" }, formats: { story } },
      { key: "c-d", title: { en: "C", ar: "ج" }, replacesBase: true, formats: { story } },
      { key: "e-f", title: { en: "E", ar: "هـ" }, baseKey: "no-such-template", formats: { story } },
    ] });
    expect(bad.ok).toBe(false);
    const errors = bad.ok ? [] : bad.errors.join("\n");
    expect(errors).toContain('templates.0.formats.post: the scene says it is "story"');
    expect(errors).toContain("templates.1.key");
    expect(errors).toContain("templates.2.replacesBase");
    expect(errors).toContain('there is no built-in template "no-such-template"');
    expect(parseTemplateFile({ hello: 1 })).toMatchObject({ ok: false });
  });
});

describe("Admin → Template library", () => {
  it("only an admin uploads", async () => {
    await request(app).post(lib()).set(auth(fieldOwner)).send(OFFER).expect(403);
    await request(app).get(lib()).set(auth(fieldOwner)).expect(403);
  });

  it("an uploaded file reaches every field's Creative hub, not academies'", async () => {
    const res = await request(app).post(lib()).set(auth(admin)).send(OFFER).expect(201);
    expect(res.body.saved.map((s: { format: string }) => s.format).sort()).toEqual(["post", "story"]);
    const venue = await request(app).get(owned(venueId)).set(auth(fieldOwner)).expect(200);
    expect(venue.body.templates.map((t: { key: string }) => t.key)).toEqual(["field-special-offer", "field-special-offer"]);
    expect(venue.body.templates[0].scene.template).toEqual({ key: "field-special-offer", style: "field" });
    const academy = await request(app).get(owned(academyId)).set(auth(academyOwner)).expect(200);
    expect(academy.body.templates).toEqual([]);
  });

  it("a bad file is refused with its problems, and the library is unchanged", async () => {
    const res = await request(app).post(lib()).set(auth(admin)).send({ ...OFFER, key: "x" }).expect(400);
    expect(res.body.errors.join(" ")).toContain("key");
    const all = await request(app).get(lib()).set(auth(admin)).expect(200);
    expect(all.body.templates).toHaveLength(2);
  });

  it("uploading the same key again updates it", async () => {
    const res = await request(app).post(lib()).set(auth(admin)).send({ ...OFFER, title: { en: "Offer", ar: "عرض" } }).expect(201);
    expect(res.body.saved.every((s: { created: boolean }) => !s.created)).toBe(true);
    expect(res.body.templates.filter((t: { key: string }) => t.key === "field-special-offer").map((t: { title: { en: string } }) => t.title.en)).toEqual(["Offer", "Offer"]);
  });

  it("one that replaces a built-in is used by the field's autopilot, under the field's own choice", async () => {
    await request(app).post(lib()).set(auth(admin)).send(openSlotsFile("open-slots-dark")).expect(201);
    let own = await replacementScenes(venueId);
    expect(replacementFor(own, "field-open-slots", "story")?.background).toBe("#101010");
    // Academies don't get a field template's replacement.
    expect(replacementFor(await replacementScenes(academyId), "field-open-slots", "story")).toBeUndefined();
    // The field's own "use instead" wins.
    const mine = { ...buildTemplateScene("field-open-slots", "field", "story", "ar"), background: "#202020" } as Scene;
    await db.insert(academyCreativeTemplatesTable).values({ academyId: venueId, baseKey: "field-open-slots", format: "story", title: "Ours", scene: mine, replacesBase: true });
    own = await replacementScenes(venueId);
    expect(replacementFor(own, "field-open-slots", "story")?.background).toBe("#202020");
    await db.delete(academyCreativeTemplatesTable).where(eq(academyCreativeTemplatesTable.academyId, venueId));
  });

  it("a second replacement switches the first off; hiding one takes it out of the autopilot", async () => {
    await request(app).post(lib()).set(auth(admin)).send({ ...openSlotsFile("open-slots-grey"), formats: { story: { ...buildTemplateScene("field-open-slots", "field", "story", "ar"), background: "#303030" } } }).expect(201);
    const all = (await request(app).get(lib()).set(auth(admin))).body.templates as Array<{ key: string; replacesBase: boolean }>;
    expect(all.find((t) => t.key === "open-slots-dark")!.replacesBase).toBe(false);
    expect(replacementFor(await replacementScenes(venueId), "field-open-slots", "story")?.background).toBe("#303030");
    await request(app).patch(lib("/open-slots-grey")).set(auth(admin)).send({ active: false }).expect(200);
    expect(replacementFor(await replacementScenes(venueId), "field-open-slots", "story")).toBeUndefined();
    await request(app).patch(lib("/field-special-offer")).set(auth(admin)).send({ replacesBase: true }).expect(409);
  });

  it("a montage laid out for three clips is used only for three", async () => {
    const reel = buildTemplateScene("field-day-best", "field", "story", "ar");
    await request(app).post(lib()).set(auth(admin)).send({
      replayTemplate: 1, key: "day-best-three", title: { en: "Best of the day, 3", ar: "أحلى اللقطات" }, baseKey: "field-day-best",
      replacesBase: true, clips: 3, formats: { story: { ...reel, background: "#404040" } },
    }).expect(201);
    const own = await replacementScenes(venueId);
    expect(replacementFor(own, "field-day-best", "story", 3)?.background).toBe("#404040");
    expect(replacementFor(own, "field-day-best", "story", 4)).toBeUndefined();
  });

  it("downloads a template as a file that uploads again, and deletes it", async () => {
    const file = await request(app).get(lib("/field-special-offer/file")).set(auth(admin)).expect(200);
    expect(file.headers["content-disposition"]).toContain("field-special-offer.json");
    const parsed = parseTemplateFile(JSON.parse(file.text));
    expect(parsed.ok && Object.keys(parsed.templates[0].formats).sort()).toEqual(["post", "story"]);
    expect(sceneSchema.safeParse((parsed.ok && parsed.templates[0].formats.story)).success).toBe(true);
    const builtIn = await request(app).get("/api/admin/creative/template-builtins/field-rebook/file").set(auth(admin)).expect(200);
    expect(JSON.parse(builtIn.text)).toMatchObject({ key: "field-rebook-copy", baseKey: "field-rebook", replacesBase: false });
    await request(app).delete(lib("/field-special-offer")).set(auth(admin)).expect(204);
    const venue = await request(app).get(owned(venueId)).set(auth(fieldOwner)).expect(200);
    expect(venue.body.templates.some((t: { key: string }) => t.key === "field-special-offer")).toBe(false);
  });
});

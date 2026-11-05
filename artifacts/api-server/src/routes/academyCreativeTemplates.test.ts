import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { academiesTable, academyCreativeProjectsTable, academyMembersTable, db, fieldsTable, usersTable } from "@workspace/db";
import { buildTemplateScene, CREATIVE_TEMPLATES, type Scene } from "@workspace/api-zod";

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

import creativeRouter from "./academyCreative";
import templatesRouter from "./academyCreativeTemplates";
import { materializeDraft } from "../lib/creative/autoDrafts";
import { replacementScenes, withReplacements } from "../lib/creative/myTemplates";

const tag = Date.now();
let app: Express;
let ownerA: number;
let ownerB: number;
let academyA: number;
let academyB: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (academy: number, p: string) => `/api/academy/console/academies/${academy}/creative${p}`;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", creativeRouter, templatesRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner A ${tag}`, email: `owner-a-mine-${tag}@test.local` },
    { name: `Owner B ${tag}`, email: `owner-b-mine-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerA, ownerB] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Mine field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([{ name: `Mine A ${tag}`, fieldId: field.id }, { name: `Mine B ${tag}`, fieldId: field.id }]).returning({ id: academiesTable.id });
  [academyA, academyB] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([{ academyId: academyA, userId: ownerA, role: "owner" }, { academyId: academyB, userId: ownerB, role: "owner" }]);
});

/** A goal clip edited in the editor: a new headline, and its video cut and framed for one clip. */
async function editedProject(): Promise<number> {
  const scene = buildTemplateScene("goal", "broadcast", "story", "en");
  const layers = scene.layers.map((l) => {
    if (l.kind === "video" && l.src.type === "binding") return { ...l, trimInMs: 1500, trimOutMs: 6000, framing: { zoom: 0.3, keys: [[0, 0.4, 0.5]] } };
    return l;
  });
  const res = await request(app).post(url(academyA, "/projects")).set(auth(ownerA)).send({
    templateKey: "goal", style: "broadcast", title: "Goal", scene: { ...scene, layers, background: "#112233" },
    data: { media: { type: "recording", recordingId: 9, fromMs: 0, toMs: 9000 } },
  }).expect(201);
  return res.body.project.id;
}

describe("My templates", () => {
  it("saves an edited design as a template: the design kept, the one clip's cut and camera dropped, bindings intact", async () => {
    const projectId = await editedProject();
    const made = await request(app).post(url(academyA, "/my-templates")).set(auth(ownerA)).send({ projectId, title: "Our goal" }).expect(201);
    const t = made.body.template;
    expect(t).toMatchObject({ baseKey: "goal", format: "story", kind: "video", title: "Our goal", replacesBase: false });
    const scene = t.scene as Scene;
    expect(scene.background).toBe("#112233");
    expect(scene.template).toEqual({ key: "goal", style: "broadcast", mine: t.id });
    const video = scene.layers.find((l) => l.kind === "video")!;
    expect(video).toMatchObject({ src: { type: "binding", path: "media" }, trimInMs: 0 });
    expect(video).not.toHaveProperty("trimOutMs");
    expect(video).not.toHaveProperty("framing");
    // The project now points at its template, so "Update template" from it changes this one.
    const [p] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, projectId));
    expect((p.scene as Scene).template?.mine).toBe(t.id);
    const list = await request(app).get(url(academyA, "/my-templates")).set(auth(ownerA)).expect(200);
    expect(list.body.templates.map((x: { id: number }) => x.id)).toContain(t.id);
  });

  it("is the academy's own: another academy can't list, change or delete it", async () => {
    const projectId = await editedProject();
    const t = (await request(app).post(url(academyA, "/my-templates")).set(auth(ownerA)).send({ projectId, title: "Private" }).expect(201)).body.template;
    expect((await request(app).get(url(academyB, "/my-templates")).set(auth(ownerB)).expect(200)).body.templates).toEqual([]);
    await request(app).get(url(academyA, "/my-templates")).set(auth(ownerB)).expect((r) => expect([403, 404]).toContain(r.status));
    await request(app).patch(url(academyB, `/my-templates/${t.id}`)).set(auth(ownerB)).send({ title: "Mine now" }).expect(404);
    await request(app).delete(url(academyB, `/my-templates/${t.id}`)).set(auth(ownerB)).expect(404);
    await request(app).post(url(academyA, "/my-templates")).set(auth(ownerA)).send({ projectId, title: "" }).expect(400);
  });

  it("updates a template from an edited project, and one template at a time stands in for the catalogue's", async () => {
    const projectId = await editedProject();
    const first = (await request(app).post(url(academyA, "/my-templates")).set(auth(ownerA)).send({ projectId, title: "First", replacesBase: true }).expect(201)).body.template;
    expect(first.replacesBase).toBe(true);
    const second = (await request(app).post(url(academyA, "/my-templates")).set(auth(ownerA)).send({ projectId, title: "Second", replacesBase: true }).expect(201)).body.template;
    const list = (await request(app).get(url(academyA, "/my-templates")).set(auth(ownerA)).expect(200)).body.templates as Array<{ id: number; replacesBase: boolean }>;
    expect(list.filter((x) => x.replacesBase).map((x) => x.id)).toEqual([second.id]);

    // Edit the project again and save it over the template.
    const [p] = await db.select().from(academyCreativeProjectsTable).where(eq(academyCreativeProjectsTable.id, projectId));
    await db.update(academyCreativeProjectsTable).set({ scene: { ...(p.scene as Scene), background: "#445566" } }).where(eq(academyCreativeProjectsTable.id, projectId));
    const updated = (await request(app).patch(url(academyA, `/my-templates/${second.id}`)).set(auth(ownerA)).send({ projectId, title: "Second v2" }).expect(200)).body.template;
    expect(updated).toMatchObject({ title: "Second v2", replacesBase: true });
    expect(updated.scene.background).toBe("#445566");
    expect(updated.scene.template.mine).toBe(second.id);

    // The academy's drafts build from it; another academy's from the catalogue.
    const own = await replacementScenes(academyA);
    expect(own.get("goal:story")?.background).toBe("#445566");
    const plan = { templateKey: "goal", format: "story", title: "Goal", originKey: `test:${tag}`, sessionId: null, data: {} } as never;
    const mine = materializeDraft(plan, academyA, "broadcast", { templates: CREATIVE_TEMPLATES, build: withReplacements(own, buildTemplateScene) });
    expect((mine!.scene as Scene).background).toBe("#445566");
    const theirs = materializeDraft(plan, academyB, "broadcast", { templates: CREATIVE_TEMPLATES, build: withReplacements(await replacementScenes(academyB), buildTemplateScene) });
    expect((theirs!.scene as Scene).background).not.toBe("#445566");

    // Switched off, then deleted.
    await request(app).patch(url(academyA, `/my-templates/${second.id}`)).set(auth(ownerA)).send({ replacesBase: false }).expect(200);
    expect((await replacementScenes(academyA)).has("goal:story")).toBe(false);
    await request(app).delete(url(academyA, `/my-templates/${first.id}`)).set(auth(ownerA)).expect(204);
  });

  it("refuses a design that wasn't made from a template", async () => {
    const blank = await request(app).post(url(academyA, "/projects")).set(auth(ownerA))
      .send({ scene: { v: 1, format: "post", background: "@paper", layers: [], locale: "en" } }).expect(201);
    const res = await request(app).post(url(academyA, "/my-templates")).set(auth(ownerA)).send({ projectId: blank.body.project.id, title: "Blank" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_template");
  });
});

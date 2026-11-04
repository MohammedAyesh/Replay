import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { academiesTable, academyMembersTable, db, fieldsTable, usersTable } from "@workspace/db";

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

import favoritesRouter from "./academyFavorites";

const stamp = Date.now();
let app: Express;
let ownerId: number, managerId: number, strangerId: number, academyId: number, otherAcademyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (id = academyId) => `/api/academy/console/academies/${id}/favorites`;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", favoritesRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${stamp}`, email: `fav-owner-${stamp}@test.local` },
    { name: `Manager ${stamp}`, email: `fav-mgr-${stamp}@test.local` },
    { name: `Stranger ${stamp}`, email: `fav-x-${stamp}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, managerId, strangerId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Fav field ${stamp}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([{ name: `JUFA ${stamp}`, fieldId: field.id }, { name: `Other ${stamp}`, fieldId: field.id }]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: managerId, role: "manager" },
  ]);
});

describe("favourites", () => {
  it("stars and unstars templates, clips and drafts, newest first, per user", async () => {
    expect((await request(app).get(url()).set(auth(ownerId)).expect(200)).body).toEqual({ template: [], clip: [], project: [] });
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "template", key: "fulltime", on: true }).expect(200);
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "template", key: "studio:match", on: true }).expect(200);
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "clip", key: "1234", on: true }).expect(200);
    // Starring twice is harmless.
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "clip", key: "1234", on: true }).expect(200);
    const res = await request(app).put(url()).set(auth(ownerId)).send({ kind: "project", key: "77", on: true }).expect(200);
    expect(res.body.template.sort()).toEqual(["fulltime", "studio:match"]);
    expect(res.body).toMatchObject({ clip: ["1234"], project: ["77"] });
    // The manager has his own stars.
    expect((await request(app).get(url()).set(auth(managerId)).expect(200)).body).toEqual({ template: [], clip: [], project: [] });
    const off = await request(app).put(url()).set(auth(ownerId)).send({ kind: "template", key: "fulltime", on: false }).expect(200);
    expect(off.body.template).toEqual(["studio:match"]);
  });

  it("refuses bad keys and people outside the academy", async () => {
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "clip", key: "abc", on: true }).expect(400);
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "template", key: "a b", on: true }).expect(400);
    await request(app).put(url()).set(auth(ownerId)).send({ kind: "player", key: "1", on: true }).expect(400);
    await request(app).get(url()).set(auth(strangerId)).expect(403);
    await request(app).get(url(otherAcademyId)).set(auth(ownerId)).expect(403);
  });
});

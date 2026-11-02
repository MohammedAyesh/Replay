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

import profileRouter from "./academyProfile";
import { coordsFromMapLink, coordsFromText } from "../lib/mapLink";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let outsiderId: number;
let academyId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = () => `/api/academy/console/academies/${academyId}/profile`;
const profile = (patch: Record<string, unknown> = {}) => ({
  name: "Galaxy Academy", nameAr: "أكاديمية جالاكسي", description: "Ages 6–14", contactPhone: "079 123 4567",
  whatsappPhone: "0791234567", email: "Info@Galaxy.jo", address: "Airport Road, Amman", latitude: 31.85, longitude: 35.93,
  instagramUrl: "@galaxy.academy", facebookUrl: "facebook.com/galaxyacademy", websiteUrl: "galaxy.jo", ...patch,
});

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", profileRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-prof-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-prof-${tag}@test.local` },
    { name: `Out ${tag}`, email: `out-prof-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, outsiderId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Prof field ${tag}`, cameraId: "camera1", latitude: 31.95, longitude: 35.91 }).returning({ id: fieldsTable.id });
  const [academy] = await db.insert(academiesTable).values({ name: `Prof ${tag}`, fieldId: field.id }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
  ]);
});

describe("academy profile", () => {
  it("lets members read it, falling back to the field's location", async () => {
    const res = await request(app).get(url()).set(auth(coachId));
    expect(res.status).toBe(200);
    expect(res.body.canEdit).toBe(false);
    expect(res.body.latitude).toBeNull();
    expect(res.body.field).toMatchObject({ latitude: 31.95, longitude: 35.91 });
    expect((await request(app).get(url()).set(auth(outsiderId))).status).toBe(403);
  });

  it("only lets the owner change it", async () => {
    expect((await request(app).put(url()).set(auth(coachId)).send(profile())).status).toBe(403);
    expect((await request(app).post(`${url()}/locate`).set(auth(coachId)).send({ link: "31.9,35.9" })).status).toBe(403);
  });

  it("saves the owner's profile, normalising WhatsApp, email and links", async () => {
    const res = await request(app).put(url()).set(auth(ownerId)).send(profile());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Galaxy Academy", nameAr: "أكاديمية جالاكسي", contactPhone: "079 123 4567", whatsappPhone: "962791234567",
      email: "info@galaxy.jo", latitude: 31.85, longitude: 35.93, canEdit: true,
      instagramUrl: "https://instagram.com/galaxy.academy", facebookUrl: "https://facebook.com/galaxyacademy", websiteUrl: "https://galaxy.jo/",
    });
    const [row] = await db.select().from(academiesTable).where(eq(academiesTable.id, academyId));
    expect(row.name).toBe("Galaxy Academy");
  });

  it("rejects a bad phone, email or half a location and clears empty fields", async () => {
    const bad = await request(app).put(url()).set(auth(ownerId)).send(profile({ whatsappPhone: "12", email: "nope", longitude: null }));
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toMatchObject({ whatsappPhone: "invalid_phone", email: "invalid_email", location: "incomplete_location" });
    expect((await request(app).put(url()).set(auth(ownerId)).send(profile({ name: "x" }))).status).toBe(400);
    const cleared = await request(app).put(url()).set(auth(ownerId)).send(profile({ instagramUrl: "", latitude: null, longitude: null }));
    expect(cleared.status).toBe(200);
    expect(cleared.body.instagramUrl).toBeNull();
    expect(cleared.body.latitude).toBeNull();
  });

  it("uploads and removes a logo", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const up = await request(app).post(`${url()}/logo`).set(auth(ownerId)).attach("logo", png, { filename: "l.png", contentType: "image/png" });
    expect(up.status).toBe(200);
    expect(up.body.logoUrl).toMatch(/^data:image\/png;base64,/);
    const gif = await request(app).post(`${url()}/logo`).set(auth(ownerId)).attach("logo", png, { filename: "l.gif", contentType: "image/gif" });
    expect(gif.status).toBe(400);
    expect((await request(app).delete(`${url()}/logo`).set(auth(ownerId))).body.logoUrl).toBeNull();
  });

  it("reads coordinates from pasted text", async () => {
    const res = await request(app).post(`${url()}/locate`).set(auth(ownerId)).send({ link: "31.8512, 35.9301" });
    expect(res.body).toEqual({ latitude: 31.8512, longitude: 35.9301 });
    expect((await request(app).post(`${url()}/locate`).set(auth(ownerId)).send({ link: "https://example.com/x" })).status).toBe(422);
  });
});

describe("map links", () => {
  it("finds the pin in every common link shape", () => {
    expect(coordsFromText("https://www.google.com/maps/place/Galaxy/@31.9,35.8,15z/data=!3m1!4b1!4m6!3m5!1s0x1:0x2!8m2!3d31.8512!4d35.9301")).toEqual({ latitude: 31.8512, longitude: 35.9301 });
    expect(coordsFromText("https://www.google.com/maps/@31.95,35.91,17z")).toEqual({ latitude: 31.95, longitude: 35.91 });
    expect(coordsFromText("https://maps.google.com/?q=31.95,35.91")).toEqual({ latitude: 31.95, longitude: 35.91 });
    expect(coordsFromText("https://www.google.com/maps/search/31.95,+35.91")).toEqual({ latitude: 31.95, longitude: 35.91 });
    expect(coordsFromText("https://maps.apple.com/?ll=31.95,35.91&q=Pin")).toEqual({ latitude: 31.95, longitude: 35.91 });
    expect(coordsFromText("https://www.openstreetmap.org/?mlat=31.95&mlon=35.91#map=17/31.95/35.91")).toEqual({ latitude: 31.95, longitude: 35.91 });
    expect(coordsFromText("Airport Road, Amman")).toBeNull();
    expect(coordsFromText("0,0")).toBeNull();
  });

  it("follows a maps.app.goo.gl short link, and only to map hosts", async () => {
    const fetcher = vi.fn(async (target: string) => {
      if (target.startsWith("https://maps.app.goo.gl/")) return new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/X/data=!3d31.8512!4d35.9301" } });
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
    });
    expect(await coordsFromMapLink("https://maps.app.goo.gl/abc123", fetcher as unknown as typeof fetch)).toEqual({ latitude: 31.8512, longitude: 35.9301 });
    expect(await coordsFromMapLink("https://evil.example/redirect", fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

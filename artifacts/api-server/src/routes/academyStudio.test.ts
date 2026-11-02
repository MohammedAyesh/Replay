import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { createCanvas } from "@napi-rs/canvas";
import {
  academiesTable,
  academyMatchLineupsTable,
  academyMatchPlayerStatsTable,
  academyMembersTable,
  academyPlayersTable,
  academyRecordingsTable,
  academySessionsTable,
  academySquadsTable,
  brandingProfilesTable,
  db,
  fieldsTable,
  recordingsTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";

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

import studioRouter, { ammanDayLabel, ammanTime, weekRows } from "./academyStudio";
import { STUDIO_FORMATS, isolateLtrRuns } from "../lib/studio/posts";

const tag = Date.now();
let app: Express;
let ownerId: number;
let coachId: number;
let outsiderId: number;
let academyId: number;
let otherAcademyId: number;
let matchSessionId: number;
const auth = (id: number) => ({ "x-test-user": String(id) });
const url = (path = "") => `/api/academy/console/academies/${academyId}/studio${path}`;
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const r = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  r.on("data", (c: Buffer) => chunks.push(c));
  r.on("end", () => cb(null, Buffer.concat(chunks)));
};
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

const SAMPLES: Record<string, Record<string, unknown>> = {
  match: { template: "match", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1, squad: "U-12", dateLabel: "SAT 31 OCT", scorers: [{ number: 10, name: "Ahmad Saleh", goals: 2 }, { number: 7, name: null, goals: 1 }] },
  player: { template: "player", number: 10, firstName: "Ahmad", squad: "U-12 Blue", ageGroup: "U-12", line: "Two goals this week" },
  training: { template: "training", rangeLabel: "2 – 8 NOV", rows: [{ day: "MON 2", time: "17:00", squad: "U-10", place: "Pitch 1" }, { day: "WED 4", time: "18:30", squad: "U-12", place: null }] },
  registration: { template: "registration", kind: "trial", headline: "Free trial session", ageGroups: "6–14", startDate: "SUN 15 NOV", priceJod: 0 },
  announcement: { template: "announcement", title: "No training on Friday", body: "Friday's sessions move to Saturday at the same times." },
};

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api", studioRouter);
  const users = await db.insert(usersTable).values([
    { name: `Owner ${tag}`, email: `owner-studio-${tag}@test.local` },
    { name: `Coach ${tag}`, email: `coach-studio-${tag}@test.local` },
    { name: `Out ${tag}`, email: `out-studio-${tag}@test.local` },
  ]).returning({ id: usersTable.id });
  [ownerId, coachId, outsiderId] = users.map((u) => u.id);
  const [field] = await db.insert(fieldsTable).values({ name: `Studio field ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const academies = await db.insert(academiesTable).values([
    { name: `Studio Academy ${tag}`, nameAr: "أكاديمية ستوديو", fieldId: field.id, whatsappPhone: "962791234567" },
    { name: `Other Studio ${tag}`, fieldId: field.id },
  ]).returning({ id: academiesTable.id });
  [academyId, otherAcademyId] = academies.map((a) => a.id);
  await db.insert(academyMembersTable).values([
    { academyId, userId: ownerId, role: "owner" },
    { academyId, userId: coachId, role: "coach" },
    { academyId: otherAcademyId, userId: ownerId, role: "owner" },
  ]);
  const [squad] = await db.insert(academySquadsTable).values({ academyId, name: "U-12 Blue", ageGroup: "U-12" }).returning({ id: academySquadsTable.id });
  const [player] = await db.insert(academyPlayersTable).values({ academyId, squadId: squad.id, name: "Ahmad Saleh", jerseyNumber: 10 }).returning({ id: academyPlayersTable.id });
  const [session] = await db.insert(academySessionsTable).values({
    academyId, squadId: squad.id, type: "match", startsAt: new Date("2026-10-31T15:00:00Z"), location: "Galaxy", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1,
  }).returning({ id: academySessionsTable.id });
  matchSessionId = session.id;
  const [rec] = await db.insert(recordingsTable).values({
    fieldId: field.id, court: "1", date: "2026-10-31", timeSlot: "18:00", duration: "60 min", videoUrl: `https://vz.test/studio-${tag}/playlist.m3u8`,
  } as typeof recordingsTable.$inferInsert).returning({ id: recordingsTable.id });
  await db.insert(academyRecordingsTable).values({ academyId, recordingId: rec.id });
  await db.insert(academyMatchLineupsTable).values({ sessionId: session.id, playerId: player.id, shirtNumber: 9 });
  await db.insert(academyMatchPlayerStatsTable).values({ sessionId: session.id, academyId, playerId: player.id, recordingId: rec.id, stats: { goals: 2 } });
});

afterAll(async () => {
  await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), inArray(brandingProfilesTable.scopeId, [academyId, otherAcademyId])));
});

describe("studio: access", () => {
  it("is owner only", async () => {
    expect((await request(app).get(url()).set(auth(ownerId))).status).toBe(200);
    for (const id of [coachId, outsiderId]) {
      expect((await request(app).get(url()).set(auth(id))).status).toBe(403);
      expect((await request(app).get(url("/clips")).set(auth(id))).status).toBe(403);
      expect((await request(app).post(url("/render")).set(auth(id)).send({ ...SAMPLES.announcement, format: "post", locale: "en" })).status).toBe(403);
      expect((await request(app).post(url("/clips/1/export")).set(auth(id))).status).toBe(403);
      expect((await request(app).get(url("/clips/1/download")).set(auth(id))).status).toBe(403);
    }
  });
});

describe("studio: data", () => {
  it("prefills matches with scorers by shirt number and hides names by default", async () => {
    const res = await request(app).get(url()).set(auth(ownerId));
    expect(res.body.brand.showPlayerNames).toBe(false);
    expect(res.body.brand.contact.en).toBe("WhatsApp 079 123 4567");
    const match = res.body.matches.find((m: { sessionId: number }) => m.sessionId === matchSessionId);
    expect(match).toMatchObject({ opponent: "Al-Wehdat", ownScore: 3, opponentScore: 1, squad: "U-12 Blue" });
    expect(match.scorers).toEqual([{ number: 9, name: null, goals: 2 }]);
    expect(match.dateLabel.en).toBe("SAT 31 OCT");
    expect(res.body.players[0]).toMatchObject({ number: 10, firstName: null, squad: "U-12 Blue", ageGroup: "U-12" });
  });

  it("shows first names only once the academy's profile allows them", async () => {
    await db.insert(brandingProfilesTable).values({ scopeType: "academy", scopeId: academyId, nameEn: "Studio", showPlayerNames: true });
    try {
      const res = await request(app).get(url()).set(auth(ownerId));
      expect(res.body.players[0].firstName).toBe("Ahmad");
      const match = res.body.matches.find((m: { sessionId: number }) => m.sessionId === matchSessionId);
      expect(match.scorers[0].name).toBe("Ahmad");
    } finally {
      await db.delete(brandingProfilesTable).where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, academyId)));
    }
  });

  it("lists the next seven days of sessions in Amman time", async () => {
    const now = new Date("2026-11-02T06:00:00Z");
    const [s] = await db.insert(academySessionsTable).values({
      academyId, type: "training", startsAt: new Date("2026-11-03T14:30:00Z"), location: "Pitch 2",
    }).returning({ id: academySessionsTable.id });
    await db.insert(academySessionsTable).values({ academyId, type: "training", startsAt: new Date("2026-11-12T14:30:00Z"), location: "Later" });
    const week = await weekRows(academyId, now);
    expect(week.rows.en).toEqual([{ day: "TUE 3", time: "17:30", squad: null, place: "Pitch 2" }]);
    expect(week.rows.ar[0].day).toBe("الثلاثاء 3");
    expect(week.rangeLabel.en).toBe("2 – 8 NOV");
    expect(s.id).toBeGreaterThan(0);
    // Midnight UTC is 03:00 in Amman, and still the same day.
    expect(ammanTime(new Date("2026-11-02T21:30:00Z"))).toBe("00:30");
    expect(ammanDayLabel(new Date("2026-11-02T21:30:00Z"), "en")).toBe("TUE 3 NOV");
  });
});

describe("studio: render", () => {
  for (const format of Object.keys(STUDIO_FORMATS) as Array<keyof typeof STUDIO_FORMATS>) {
    for (const [template, sample] of Object.entries(SAMPLES)) {
      it(`draws ${template} as a ${format} PNG of the right size`, async () => {
        const res = await request(app).post(url("/render")).set(auth(ownerId))
          .send({ ...sample, format, locale: template === "match" ? "ar" : "en" }).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/image\/png/);
        expect(pngSize(res.body as Buffer)).toEqual(STUDIO_FORMATS[format]);
      });
    }
  }

  it("draws the preview at half size, and accepts a background photo", async () => {
    const photo = createCanvas(300, 200).toBuffer("image/jpeg");
    const res = await request(app).post(url("/render")).set(auth(ownerId))
      .send({ ...SAMPLES.announcement, format: "story", locale: "ar", preview: true, backgroundData: `data:image/jpeg;base64,${photo.toString("base64")}` })
      .buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(pngSize(res.body as Buffer)).toEqual({ w: 540, h: 960 });
  });

  it("refuses a bad payload, a non-image and an oversized upload", async () => {
    expect((await request(app).post(url("/render")).set(auth(ownerId)).send({ template: "poster", format: "post", locale: "en" })).status).toBe(400);
    expect((await request(app).post(url("/render")).set(auth(ownerId)).send({ ...SAMPLES.match, ownScore: -1, format: "post", locale: "en" })).status).toBe(400);
    expect((await request(app).post(url("/render")).set(auth(ownerId)).send({ ...SAMPLES.match, format: "a4", locale: "en" })).status).toBe(400);
    expect((await request(app).post(url("/render")).set(auth(ownerId))
      .send({ ...SAMPLES.announcement, format: "post", locale: "en", backgroundData: "data:text/plain;base64,aGVsbG8=" })).status).toBe(400);
    const big = Buffer.alloc(6 * 1024 * 1024 + 10, 1).toString("base64");
    const tooBig = await request(app).post(url("/render")).set(auth(ownerId))
      .send({ ...SAMPLES.announcement, format: "post", locale: "en", backgroundData: `data:image/jpeg;base64,${big.slice(0, Math.floor(big.length / 4) * 4)}` });
    expect([400, 413]).toContain(tooBig.status);
  });

  it("will not print a name the academy hasn't allowed", async () => {
    const res = await request(app).post(url("/render")).set(auth(ownerId))
      .send({ ...SAMPLES.player, number: null, format: "post", locale: "en" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shirt number/);
  });

  it("keeps numbers left-to-right inside Arabic text", () => {
    expect(isolateLtrRuns("واتساب 079 543 3320")).toBe("واتساب ⁦079 543 3320⁩");
    expect(isolateLtrRuns("Call 079")).toBe("Call 079");
  });
});

describe("studio: clips", () => {
  it("lets owners and coaches clip their academy's recordings, and nobody else", async () => {
    const { canCreateClipFromVideo } = await import("../lib/publicFootage");
    const req = (id: number) => ({ headers: { "x-test-user": String(id) } }) as unknown as import("express").Request;
    expect(await canCreateClipFromVideo(req(coachId), `studio-${tag}`)).toBe(true);
    expect(await canCreateClipFromVideo(req(ownerId), `studio-${tag}`)).toBe(true);
    expect(await canCreateClipFromVideo(req(outsiderId), `studio-${tag}`)).toBe(false);
  });

  it("lists only this academy's clips made by its members, newest first", async () => {
    const base = { videoId: `vid-${tag}`, startTime: "10", endTime: "22", aspectRatio: "9:16" };
    const [older] = await db.insert(userClipsTable).values({ ...base, userId: coachId, academyId, title: "Coach clip", createdAt: new Date("2026-10-01T10:00:00Z") }).returning({ id: userClipsTable.id });
    const [newer] = await db.insert(userClipsTable).values({ ...base, userId: ownerId, academyId, title: "Owner clip", aspectRatio: "16:9", exportStatus: "done", exportedUrl: "https://cdn.test/x.mp4", createdAt: new Date("2026-10-02T10:00:00Z") }).returning({ id: userClipsTable.id });
    const [outsider] = await db.insert(userClipsTable).values({ ...base, userId: outsiderId, academyId, title: "Outsider clip" }).returning({ id: userClipsTable.id });
    const [elsewhere] = await db.insert(userClipsTable).values({ ...base, userId: ownerId, academyId: otherAcademyId, title: "Other academy clip" }).returning({ id: userClipsTable.id });
    const [deleted] = await db.insert(userClipsTable).values({ ...base, userId: ownerId, academyId, title: "Deleted", hiddenReason: "deleted" }).returning({ id: userClipsTable.id });

    const res = await request(app).get(url("/clips")).set(auth(ownerId));
    expect(res.status).toBe(200);
    const ids = res.body.clips.map((c: { id: number }) => c.id);
    expect(ids).toEqual([newer.id, older.id]);
    expect(ids).not.toContain(outsider.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(deleted.id);
    expect(res.body.clips[0]).toMatchObject({ aspectRatio: "16:9", status: "ready", creator: { role: "owner", isYou: true } });
    expect(res.body.clips[1]).toMatchObject({ aspectRatio: "9:16", status: "processing", durationSeconds: 12, creator: { role: "coach", isYou: false } });

    // The owner's export paths only reach this academy's member clips.
    expect((await request(app).get(url(`/clips/${outsider.id}/export-status`)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).get(url(`/clips/${elsewhere.id}/export-status`)).set(auth(ownerId))).status).toBe(404);
    expect((await request(app).get(url(`/clips/${older.id}/export-status`)).set(auth(ownerId))).body.status).toBe("pending");
    expect((await request(app).get(url(`/clips/${newer.id}/export-status`)).set(auth(ownerId))).body.status).toBe("done");
    expect((await request(app).get(url(`/clips/${older.id}/download`)).set(auth(ownerId))).status).toBe(404);
  });
});

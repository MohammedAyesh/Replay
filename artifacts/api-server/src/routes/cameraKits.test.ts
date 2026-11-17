/**
 * Portable cameras (Labs): hidden unless switched on, a set-up never assumes a mast
 * height, Stop keeps what was played, and a measurement only reaches the stats when
 * it agrees with the saved size or the owner approves it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq } from "drizzle-orm";
import {
  academiesTable,
  academyMembersTable,
  cameraKitsTable,
  cameraSetupsTable,
  db,
  fieldsTable,
  footageRequestsTable,
  recordingsTable,
  settingsRulesTable,
  usersTable,
  venuePitchesTable,
} from "@workspace/db";

process.env.CONTABO_CONTROL_KEY = "test-control-key";
process.env.CONTABO_CONTROL_URL = "http://127.0.0.1:9";
process.env.ANALYSIS_WORKER_KEY = "kit-worker-key";

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

const control = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string }> }));
vi.mock("./contabo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./contabo")>();
  return {
    ...actual,
    controlFetch: vi.fn(async (path: string, opts: RequestInit = {}) => {
      control.calls.push({ path, method: String(opts.method ?? "GET") });
      if (path.startsWith("/record-hq/") && opts.method === "POST") return { ok: true, status: 200, body: { jobId: `job-${control.calls.length}`, status: "scheduled" } };
      if (opts.method === "DELETE") return { ok: true, status: 200, body: { status: "cancelled" } };
      if (path.startsWith("/kit/")) return { ok: false, status: 404, body: null };
      return { ok: true, status: 200, body: {} };
    }),
    controlResponse: vi.fn(async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } })),
  };
});

import kitsRouter from "./cameraKits";
import { invalidateSettingsCache } from "../lib/settings";
import { decide, rescaleModel, sizeDisagreement } from "../lib/cameraKits";
import { cameraForRecording } from "../lib/cameraPitchModel";

const tag = Date.now();
let app: Express;
let adminId: number;
let ownerId: number;
let coachId: number;
let strangerId: number;
let academyId: number;
let pitchId: number;
let kitId: number;

const auth = (id: number) => ({ "x-test-user": String(id) });

function model(length: number, width: number) {
  return {
    calibrationId: `autocal-test-${tag}`,
    fittedAt: new Date().toISOString(),
    calibratedAspectRatio: 3840 / 1080,
    pitchWidthMetres: length,
    pitchHeightMetres: width,
    grid: [
      [{ x: 0, y: 0 }, { x: length, y: 0 }],
      [{ x: 0, y: width }, { x: length, y: width }],
    ],
  };
}

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/api", kitsRouter);
  const users = await db.insert(usersTable).values([
    { email: `kit-admin-${tag}@t.test`, name: "Admin", isAdmin: true },
    { email: `kit-owner-${tag}@t.test`, name: "Owner" },
    { email: `kit-coach-${tag}@t.test`, name: "Coach" },
    { email: `kit-stranger-${tag}@t.test`, name: "Stranger" },
  ]).returning({ id: usersTable.id });
  [adminId, ownerId, coachId, strangerId] = users.map((u) => u.id);
  const [home] = await db.insert(fieldsTable).values({ name: `Kit home ${tag}`, cameraId: "camera1" }).returning({ id: fieldsTable.id });
  const [academy] = await db.insert(academiesTable).values({ name: `Kit Academy ${tag}`, fieldId: home.id }).returning({ id: academiesTable.id });
  academyId = academy.id;
  await db.insert(academyMembersTable).values([
    { userId: ownerId, academyId, role: "owner" },
    { userId: coachId, academyId, role: "coach" },
  ]);
  const [pitch] = await db.insert(venuePitchesTable).values({ academyId, name: "Pitch 1", size: "5", lengthM: 40, widthM: 20 }).returning({ id: venuePitchesTable.id });
  pitchId = pitch.id;
});

afterAll(async () => {
  // The settings table is shared by the whole run; leave no rule behind.
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.key, "labs.portableCameras"), eq(settingsRulesTable.scopeId, academyId)));
  invalidateSettingsCache();
});

describe("decide", () => {
  it("uses a size within 3% straight away and holds anything further off", () => {
    expect(sizeDisagreement({ lengthM: 40.8, widthM: 20.4 }, { lengthM: 40, widthM: 20 })).toBeCloseTo(0.02);
    expect(decide({ ok: true, lengthM: 40.8, widthM: 20.4 }, { lengthM: 40, widthM: 20, autoApprove: true }).status).toBe("measured");
    expect(decide({ ok: true, lengthM: 40.8, widthM: 18.8 }, { lengthM: 40, widthM: 20, autoApprove: true }).status).toBe("needs_look");
    expect(decide({ ok: true, lengthM: 40.2, widthM: 20 }, { lengthM: 40, widthM: 20, autoApprove: false }).status).toBe("needs_look");
    expect(decide({ ok: true, lengthM: 38, widthM: 19 }, null).status).toBe("measured");
    expect(decide({ ok: false, error: "Not enough players in view" }, null)).toEqual({ status: "needs_look", reasons: ["Not enough players in view"] });
  });

  it("stretches a measured model to the saved size", () => {
    const out = rescaleModel(model(40.8, 18.8), { lengthM: 40.8, widthM: 18.8 }, { lengthM: 40, widthM: 20 });
    expect(out.grid[1][1].x).toBeCloseTo(40);
    expect(out.grid[1][1].y).toBeCloseTo(20);
    expect(out.calibrationId).toMatch(/saved-size$/);
  });
});

describe("portable cameras", () => {
  it("is hidden until switched on, and only admins add kits", async () => {
    await request(app).get("/api/kits/access").set(auth(ownerId)).expect(200).expect((r) => expect(r.body.enabled).toBe(false));
    await request(app).get("/api/kits").set(auth(ownerId)).expect(404);
    await request(app).get("/api/kits/access").set(auth(adminId)).expect(200).expect((r) => expect(r.body.enabled).toBe(true));
    await request(app).post("/api/kits/manage").set(auth(adminId)).send({ name: "Kit 1", cameraId: "bad camera" }).expect(400);
    const created = await request(app).post("/api/kits/manage").set(auth(adminId))
      .send({ academyId, name: "Kit 1", cameraId: "camera9", wifiSsid: "ReplayKit1", wifiPassword: "goal-goal-goal" }).expect(201);
    kitId = created.body.kit.id;
    expect(created.body.kit.token).toMatch(/^[0-9a-f]{24}$/);

    // Switched on for the academy: its owner and coach see it, a stranger still doesn't.
    await db.insert(settingsRulesTable).values({ key: "labs.portableCameras", scopeType: "academy", scopeId: academyId, value: true, priority: 0 });
    invalidateSettingsCache();
    await request(app).get("/api/kits").set(auth(coachId)).expect(200).expect((r) => {
      expect(r.body.kits.map((k: { id: number }) => k.id)).toEqual([kitId]);
      expect(r.body.kits[0].token).toBeUndefined();
      expect(r.body.kits[0].wifiSsid).toBe("ReplayKit1");
    });
    await request(app).get("/api/kits").set(auth(strangerId)).expect(404);
    await request(app).post("/api/kits/manage").set(auth(ownerId)).send({ academyId, name: "Kit 2", cameraId: "camera8" }).expect(403);
  });

  it("needs the mast height typed, records, and keeps what was played on Stop", async () => {
    await request(app).post(`/api/kits/${kitId}/setups`).set(auth(coachId)).send({ pitchId }).expect(400);
    await request(app).post(`/api/kits/${kitId}/setups`).set(auth(coachId)).send({ pitchId, mastHeightM: 0.5 }).expect(400);
    const created = await request(app).post(`/api/kits/${kitId}/setups`).set(auth(coachId)).send({ pitchId, mastHeightM: 4.5 }).expect(201);
    const setupId = created.body.setup.id;
    expect(created.body.setup).toMatchObject({ status: "setting_up", mastHeightM: 4.5, knownLengthM: 40, knownWidthM: 20, wifiSsid: "ReplayKit1" });

    // The preview needs vps1's kit endpoints; without them it says so instead of failing silently.
    await request(app).get(`/api/kits/setups/${setupId}/snapshot`).set(auth(coachId)).expect(501);
    await request(app).get(`/api/kits/${kitId}/status`).set(auth(coachId)).expect(200).expect((r) => expect(r.body).toEqual({ online: false, reason: "unsupported" }));

    const started = await request(app).post(`/api/kits/setups/${setupId}/start`).set(auth(coachId)).send({ minutes: 90, kind: "match", title: "Thursday 5s" }).expect(200);
    expect(started.body.setup.status).toBe("recording");
    expect(started.body.setup.footage.status).toBe("scheduled");
    const [kit] = await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.id, kitId));
    const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, kit.fieldId!));
    expect(field).toMatchObject({ isHidden: true, cameraId: "camera9" });
    // A camera that already has a field keeps it: no second field shares a camera.
    const reuse = await request(app).post("/api/kits/manage").set(auth(adminId)).send({ academyId, name: "Kit fixed", cameraId: "camera1" }).expect(201);
    const { ensureKitField } = await import("../lib/cameraKits");
    const [reuseKit] = await db.select().from(cameraKitsTable).where(eq(cameraKitsTable.id, reuse.body.kit.id));
    const homeFields = await db.select({ id: fieldsTable.id }).from(fieldsTable).where(eq(fieldsTable.cameraId, "camera1")).orderBy(fieldsTable.id);
    expect(await ensureKitField(reuseKit)).toBe(homeFields[0].id);
    expect((await db.select({ id: fieldsTable.id }).from(fieldsTable).where(eq(fieldsTable.cameraId, "camera1"))).length).toBe(homeFields.length);
    await db.update(cameraKitsTable).set({ archived: true }).where(eq(cameraKitsTable.id, reuseKit.id));
    expect(control.calls.some((c) => c.path.startsWith("/record-hq/camera9") && c.method === "POST")).toBe(true);

    // A second set-up on the same kit can't record at the same time.
    const other = await request(app).post(`/api/kits/${kitId}/setups`).set(auth(coachId)).send({ placeName: "Away pitch", placeSize: "7", mastHeightM: 6 }).expect(201);
    await request(app).post(`/api/kits/setups/${other.body.setup.id}/start`).set(auth(coachId)).send({ minutes: 60 }).expect(409);

    // Stop after 10 minutes: the booking is cancelled and the 10 minutes are pulled from the SD card.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const { ammanLocal } = await import("../lib/venues/core");
    await db.update(cameraSetupsTable).set({ startLocal: ammanLocal(tenMinutesAgo), startedAt: tenMinutesAgo }).where(eq(cameraSetupsTable.id, setupId));
    const stopped = await request(app).post(`/api/kits/setups/${setupId}/stop`).set(auth(coachId)).expect(200);
    expect(stopped.body.setup.status).toBe("recording");
    expect(stopped.body.setup.footage.id).not.toBe(started.body.setup.footage.id);
    const [pull] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, stopped.body.setup.footage.id));
    expect(pull.requestedSeconds).toBe(600);
    expect(control.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("uses a measurement within 3% for the stats, and holds one that isn't for the owner", async () => {
    const [setup] = await db.select().from(cameraSetupsTable).where(eq(cameraSetupsTable.pitchId, pitchId)).limit(1);
    const [req] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, setup.footageRequestId!));
    await db.update(footageRequestsTable).set({ status: "ready", videoId: `vid-${tag}` }).where(eq(footageRequestsTable.id, req.id));
    await request(app).get(`/api/kits/setups/${setup.id}`).set(auth(coachId)).expect(200).expect((r) => expect(r.body.setup.status).toBe("measuring"));

    await request(app).get("/api/worker/kit-setups/pending").expect(401);
    const pending = await request(app).get("/api/worker/kit-setups/pending").set("x-worker-key", "kit-worker-key").expect(200);
    expect(pending.body.setups.find((s: { setupId: number }) => s.setupId === setup.id)).toMatchObject({ cameraId: "camera9", mastHeightM: 4.5, knownLengthM: 40, knownWidthM: 20 });

    const posted = await request(app).post(`/api/worker/kit-setups/${setup.id}/calibration`).set("x-worker-key", "kit-worker-key")
      .send({ ok: true, lengthM: 40.8, widthM: 18.8, tiltDeg: 14.2, warnings: [], pitchModel: model(40.8, 18.8) }).expect(200);
    expect(posted.body.status).toBe("needs_look");

    // A recording made in the set-up's window doesn't read a model nobody has approved.
    const [recording] = await db.insert(recordingsTable).values({
      fieldId: req.fieldId, court: "cam9", date: req.startLocal.slice(0, 10), timeSlot: req.startLocal.slice(11, 16),
      duration: "10:00", videoUrl: `https://cdn.test/vid-${tag}/playlist.m3u8`, isVisible: false,
    } as typeof recordingsTable.$inferInsert).returning({ id: recordingsTable.id });
    expect((await cameraForRecording(recording.id)).pitchModel).toBeNull();

    // Coaches can't approve; the owner uses the saved size, and the recording reads it.
    await request(app).post(`/api/kits/setups/${setup.id}/review`).set(auth(coachId)).send({ action: "approve" }).expect(403);
    const reviewed = await request(app).post(`/api/kits/setups/${setup.id}/review`).set(auth(ownerId)).send({ action: "use_saved" }).expect(200);
    expect(reviewed.body.setup.status).toBe("approved");
    const camera = await cameraForRecording(recording.id);
    expect(camera.pitchModel?.pitchWidthMetres).toBeCloseTo(40);
    expect(camera.pitchModel?.pitchHeightMetres).toBeCloseTo(20);

    const manage = await request(app).get(`/api/kits/manage?academyId=${academyId}`).set(auth(ownerId)).expect(200);
    expect(manage.body.canAdd).toBe(false);
    expect(manage.body.setups.length).toBeGreaterThanOrEqual(2);
    await request(app).get(`/api/kits/manage?academyId=${academyId}`).set(auth(coachId)).expect(403);
  });
});

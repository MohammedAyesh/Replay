import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  recordingSchedulesTable,
  recordingsTable,
  usersTable,
} from "@workspace/db";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn(),
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn((res: any, _req: any, error = "Unauthenticated") => {
    res.status(401).json({ error, reason: "no_credentials" });
  }),
}));

import { getLocalUserId, getLocalUserRecord } from "../lib/clerkUserBridge";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const mockedGetLocalUserRecord = vi.mocked(getLocalUserRecord);
const TAG = `security-${Date.now()}`;

let app: Express;
let adminId: number;
let targetId: number;
let fieldId: number;
let recordingId: number;
let footageRequestId: number;

beforeAll(async () => {
  const [{ default: fieldsRouter }, { default: adminRouter }, { default: authRouter }] = await Promise.all([
    import("./fields"),
    import("./admin"),
    import("./auth"),
  ]);
  app = express();
  app.use(express.json());
  app.use("/api", fieldsRouter);
  app.use("/api", adminRouter);
  app.use("/api", authRouter);

  const [admin] = await db.insert(usersTable).values({
    name: `Security Admin ${TAG}`,
    email: `security-admin-${TAG}@test.local`,
    isGuest: false,
    isAdmin: true,
    clerkId: `clerk_${TAG}_admin`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  adminId = admin.id;

  const [target] = await db.insert(usersTable).values({
    name: `Security Target ${TAG}`,
    email: `security-target-${TAG}@test.local`,
    isGuest: false,
    isAdmin: false,
    clerkId: `clerk_${TAG}_target`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  targetId = target.id;

  const [field] = await db.insert(fieldsTable).values({
    name: `Security field ${TAG}`,
    location: "Test",
    isHidden: false,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;

  const [recording] = await db.insert(recordingsTable).values({
    fieldId,
    court: "1",
    date: "2026-09-21",
    timeSlot: "12:00",
    duration: "00:30:00",
    videoUrl: `https://cdn.test/security-owner-${TAG}/playlist.m3u8`,
    isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingId = recording.id;

  await db.insert(recordingSchedulesTable).values({
    fieldId,
    allowedDate: "2026-09-21",
    startTime: "00:00",
    endTime: "23:59",
  });

  const [footageRequest] = await db.insert(footageRequestsTable).values({
    fieldId,
    requestedBy: adminId,
    cameraId: "camera1",
    startLocal: "2026-09-21 12:00",
    endLocal: "2026-09-21 12:30",
    requestedSeconds: 1800,
    status: "ready",
    videoId: `security-owner-${TAG}`,
    shareExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  }).returning({ id: footageRequestsTable.id });
  footageRequestId = footageRequest.id;
});

beforeEach(() => {
  mockedGetLocalUserId.mockResolvedValue(adminId);
  mockedGetLocalUserRecord.mockResolvedValue({
    id: targetId,
    isGuest: false,
    isAdmin: false,
  } as Awaited<ReturnType<typeof getLocalUserRecord>>);
});

afterAll(async () => {
  await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, footageRequestId));
  await db.delete(recordingSchedulesTable).where(eq(recordingSchedulesTable.fieldId, fieldId));
  await db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(eq(usersTable.id, targetId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  delete process.env.ADMIN_SETUP_SECRET;
});

describe("public footage access", () => {
  it("hides owner footage from ordinary visitors but lets admins inspect it", async () => {
    const denied = await request(app).get(`/api/fields/${fieldId}/recordings`).expect(200);
    expect(denied.body).toEqual([]);

    mockedGetLocalUserRecord.mockResolvedValue({
      id: adminId,
      isGuest: false,
      isAdmin: true,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    const allowed = await request(app).get(`/api/fields/${fieldId}/recordings`).expect(200);
    expect(allowed.body).toHaveLength(1);
    expect(allowed.body[0].id).toBe(recordingId);
    mockedGetLocalUserRecord.mockResolvedValue({
      id: targetId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
  });

  it("does not reveal hidden fields to visitors", async () => {
    await db.update(fieldsTable).set({ isHidden: true }).where(eq(fieldsTable.id, fieldId));
    await request(app).get(`/api/fields/${fieldId}`).expect(404);

    mockedGetLocalUserRecord.mockResolvedValue({
      id: adminId,
      isGuest: false,
      isAdmin: true,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    await request(app).get(`/api/fields/${fieldId}`).expect(200);
    await db.update(fieldsTable).set({ isHidden: false }).where(eq(fieldsTable.id, fieldId));
  });
});

describe("centralized admin access", () => {
  it("denies non-admins and protects admin role invariants", async () => {
    mockedGetLocalUserId.mockResolvedValueOnce(targetId);
    await request(app).get("/api/admin/access").expect(403);

    mockedGetLocalUserId.mockResolvedValue(adminId);
    const access = await request(app).get("/api/admin/access").expect(200);
    expect(access.body.users.some((user: { id: number }) => user.id === targetId)).toBe(true);
    expect(access.body.fields.some((field: { id: number }) => field.id === fieldId)).toBe(true);

    await request(app)
      .patch(`/api/admin/access/users/${adminId}`)
      .send({ isAdmin: false })
      .expect(409);

    await request(app)
      .patch(`/api/admin/access/users/${targetId}`)
      .send({ isAdmin: false })
      .expect(200);
  });
});

describe("admin setup protection", () => {
  it("uses safe token comparison and rate-limits failed attempts", async () => {
    const secret = `setup-${TAG}`;
    process.env.ADMIN_SETUP_SECRET = secret;
    mockedGetLocalUserRecord.mockResolvedValue({
      id: targetId,
      isGuest: false,
      isAdmin: false,
      clerkId: `clerk_${TAG}_target`,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post("/api/auth/admin-setup").send({ token: `${secret}-wrong` }).expect(403);
    }
    await request(app).post("/api/auth/admin-setup").send({ token: `${secret}-wrong` }).expect(429);
  });
});
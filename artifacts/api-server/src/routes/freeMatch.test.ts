import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  claimMatchIdentityBindingsTable,
  claimMatchProgressTable,
  fieldsTable,
  footageRequestsTable,
  freeMatchRewardsTable,
  matchRoomsTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  statUnlocksTable,
  usersTable,
} from "@workspace/db";

// Which recordings each room's booking overlaps. The real lookup needs tracked footage on the
// field's clock; what matters here is who found themselves in it.
const roomRecordings = vi.hoisted(() => new Map<number, number[]>());

vi.mock("../lib/matchFeed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/matchFeed")>()),
  recordingsForRoom: vi.fn(async (ctx: { room: { id: number } }) =>
    (roomRecordings.get(ctx.room.id) ?? []).map((recordingId) => ({ recordingId }))),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const { db: database, usersTable: users } = await import("@workspace/db");
    const { eq: equals } = await import("drizzle-orm");
    const [row] = await database.select().from(users).where(equals(users.id, Number(raw)));
    return row ?? null;
  }),
  unauthenticatedResponse: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import ownerRouter from "./owner";
import { freeMatchStatus } from "../lib/freeMatch";
import { ensureRoomForRequest } from "../lib/matchRooms";

const TAG = `fm_${Date.now()}`;
let app: Express;
const users: Record<string, number> = {};
let fieldId: number;
const recordingIds: number[] = [];
const bundleByRecording = new Map<number, number>();

function localString(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const as = (who: string) => ({ "x-test-user": String(users[who]) });
const HOUR = 60 * 60 * 1000;

/** A finished booking by `who`, paid the given way, with its own recording. */
async function playedMatch(who: string, method: "cliq" | "field", hoursAgo: number) {
  const quarter = 15 * 60 * 1000;
  const start = Math.floor((Date.now() - hoursAgo * HOUR) / quarter) * quarter;
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: `cam-${TAG}`,
    requestedBy: users[who],
    startLocal: localString(start),
    endLocal: localString(start + HOUR),
    requestedSeconds: 3600,
    rateFils: 0,
    status: "ready",
    readyAt: new Date(start + HOUR),
  }).returning();
  const room = await ensureRoomForRequest(row);
  await db.insert(statUnlocksTable).values({
    userId: users[who], matchId: room.id, kind: "booking", amountFils: 2000,
    reference: `RB${room.code}-${TAG}-${Math.random().toString(36).slice(2, 6)}`, method, status: "paid",
  });
  const [recording] = await db.insert(recordingsTable).values({
    fieldId, court: "1", date: localString(start).slice(0, 10), timeSlot: localString(start).slice(11),
    duration: "01:00:00", videoUrl: `https://example.test/${TAG}-${room.id}.m3u8`, isVisible: true,
  }).returning({ id: recordingsTable.id });
  recordingIds.push(recording.id);
  const [bundle] = await db.insert(recordingTrackingBundlesTable).values({
    recordingId: recording.id, uploadedBy: users.booker, manifest: { version: 1, duration: 3600 } as never,
  }).returning({ id: recordingTrackingBundlesTable.id });
  bundleByRecording.set(recording.id, bundle.id);
  roomRecordings.set(room.id, [recording.id]);
  return { room, recordingId: recording.id };
}

/** `who` finished finding himself in a recording. */
async function found(who: string, recordingId: number) {
  await db.insert(claimMatchProgressTable).values({ userId: users[who], recordingId, completed: true, stage: "done" });
  await db.insert(claimMatchIdentityBindingsTable).values({
    userId: users[who], recordingId, personId: `p-${who}`, trackingBundleId: bundleByRecording.get(recordingId)!,
    bundleFingerprint: "fp", personParts: [`p-${who}`], vouchedFragments: [], resolutionMethod: "track-fallback",
    supportCount: 1, acceptedAnswerCount: 1, supportPercent: 100, state: "confirmed", resolvedAt: new Date(),
  });
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://control.example.test";
  process.env.CONTABO_CONTROL_KEY = "test-key";
  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);
  for (const key of ["booker", "f1", "f2", "f3", "f4", "f5", "guest"]) {
    const [u] = await db.insert(usersTable).values({
      name: `${key} ${TAG}`, email: `${TAG}_${key}@test.local`, profileComplete: true, isGuest: key === "guest",
    }).returning({ id: usersTable.id });
    users[key] = u.id;
  }
  const [field] = await db.insert(fieldsTable).values({ name: `Free Field ${TAG}`, location: "Test", cameraId: `cam-${TAG}` })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
});

afterAll(async () => {
  const ids = Object.values(users);
  await db.delete(freeMatchRewardsTable).where(inArray(freeMatchRewardsTable.userId, ids));
  await db.delete(claimMatchIdentityBindingsTable).where(inArray(claimMatchIdentityBindingsTable.userId, ids));
  await db.delete(claimMatchProgressTable).where(inArray(claimMatchProgressTable.userId, ids));
  await db.delete(recordingTrackingBundlesTable).where(inArray(recordingTrackingBundlesTable.recordingId, recordingIds));
  await db.delete(recordingsTable).where(inArray(recordingsTable.id, recordingIds));
  await db.delete(statUnlocksTable).where(inArray(statUnlocksTable.userId, ids));
  await db.delete(matchRoomsTable).where(eq(matchRoomsTable.fieldId, fieldId));
  await db.delete(footageRequestsTable).where(eq(footageRequestsTable.fieldId, fieldId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

describe("free match challenge", () => {
  let source: Awaited<ReturnType<typeof playedMatch>>;

  it("does not count a match paid at the field", async () => {
    const fieldPaid = await playedMatch("booker", "field", 30);
    await found("booker", fieldPaid.recordingId);
    for (const friend of ["f1", "f2", "f3", "f4", "f5"]) await found(friend, fieldPaid.recordingId);
    const status = await freeMatchStatus(users.booker);
    expect(status.attempt).toBeNull();
    expect(status.reward).toBeNull();
  });

  it("tracks the booker and his friends on a CliQ booking", async () => {
    source = await playedMatch("booker", "cliq", 3);
    let status = await freeMatchStatus(users.booker);
    expect(status.attempt?.code).toBe(source.room.code);
    expect(status.attempt?.paid).toBe(true);
    expect(status.attempt?.bookerFound).toBe(false);

    await found("booker", source.recordingId);
    for (const friend of ["f1", "f2", "f3", "f4"]) await found(friend, source.recordingId);
    // A guest finding himself doesn't count.
    await found("guest", source.recordingId);
    status = await freeMatchStatus(users.booker);
    expect(status.attempt?.bookerFound).toBe(true);
    expect(status.attempt?.friendsFound).toBe(4);
    expect(status.reward).toBeNull();
  });

  it("earns the free match when the fifth friend finds himself", async () => {
    await found("f5", source.recordingId);
    const status = await freeMatchStatus(users.booker);
    expect(status.attempt).toBeNull();
    expect(status.reward).toMatchObject({ freeHours: 2, worthFils: 4000, sourceCode: source.room.code, status: "available" });
    expect(status.reward?.thanks).toHaveLength(5);
    expect(status.latestEarned?.sourceCode).toBe(source.room.code);
    // Seen twice, still one reward.
    await freeMatchStatus(users.booker);
    const rows = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.userId, users.booker));
    expect(rows).toHaveLength(1);
  });

  it("a second full match the same month earns nothing more", async () => {
    const again = await playedMatch("booker", "cliq", 2);
    for (const who of ["booker", "f1", "f2", "f3", "f4", "f5"]) await found(who, again.recordingId);
    const status = await freeMatchStatus(users.booker);
    expect(status.attempt?.code).toBe(again.room.code);
    expect(status.attempt?.capped).toBe(true);
    const rows = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.userId, users.booker));
    expect(rows).toHaveLength(1);
  });

  function slot(daysAhead: number, hour: number, minutes: number) {
    const day = localString(Date.now() + daysAhead * 24 * HOUR).slice(0, 10);
    const start = `${day} ${String(hour).padStart(2, "0")}:00`;
    const endMinutes = hour * 60 + minutes;
    const end = `${day} ${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
    return { fieldId, startLocal: start, endLocal: end };
  }

  it("books up to two hours for nothing and spends the free match", async () => {
    const res = await request(app).post("/api/bookings").set(as("booker"))
      .send({ ...slot(2, 10, 120), payWith: "cliq", useFreeMatch: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amountFils: 0, method: "free", freeMatch: true });
    const [reward] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.userId, users.booker));
    expect(reward.status).toBe("used");
    const [payment] = await db.select().from(statUnlocksTable).where(eq(statUnlocksTable.reference, res.body.reference));
    expect(payment).toMatchObject({ method: "free", status: "paid", amountFils: 0 });

    const twice = await request(app).post("/api/bookings").set(as("booker"))
      .send({ ...slot(3, 10, 60), useFreeMatch: true });
    expect(twice.status).toBe(409);
  });

  it("a free-match booking never counts toward another", async () => {
    const [reward] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.userId, users.booker));
    const status = await freeMatchStatus(users.booker);
    expect(status.attempt?.code).not.toBe(
      (await db.select({ code: matchRoomsTable.code }).from(matchRoomsTable).where(eq(matchRoomsTable.id, reward.usedMatchId!)))[0].code,
    );
  });

  it("charges only the extra hours, and cancelling hands the free match back", async () => {
    // Give the free match back from the free booking first, by cancelling it before kick-off.
    const [reward] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.userId, users.booker));
    const [usedRoom] = await db.select({ requestId: matchRoomsTable.footageRequestId }).from(matchRoomsTable)
      .where(eq(matchRoomsTable.id, reward.usedMatchId!));
    // The camera job can't be reached in tests; drop the job id so cancelling doesn't call it.
    await db.update(footageRequestsTable).set({ vpsJobId: null, status: "scheduled" }).where(eq(footageRequestsTable.id, usedRoom.requestId));
    const cancel = await request(app).delete(`/api/bookings/${usedRoom.requestId}`).set(as("booker"));
    expect(cancel.status).toBe(204);
    const [back] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, reward.id));
    expect(back).toMatchObject({ status: "available", usedMatchId: null });

    const res = await request(app).post("/api/bookings").set(as("booker"))
      .send({ ...slot(4, 18, 180), payWith: "cliq", useFreeMatch: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amountFils: 2000, method: "cliq", status: "awaiting_payment" });
    const unpaid = await request(app).delete(`/api/bookings/${res.body.requestId}`).set(as("booker"));
    expect(unpaid.status).toBe(204);
    const [again] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, reward.id));
    expect(again.status).toBe("available");
  });

  it("offers the free match on the Book page", async () => {
    const res = await request(app).get("/api/bookings/fields").set(as("booker"));
    expect(res.status).toBe(200);
    expect(res.body.freeMatch).toMatchObject({ enabled: true, freeHours: 2, reward: { freeHours: 2 } });
  });

  it("is off for everyone when the setting is off, but an earned one still shows", async () => {
    const status = await freeMatchStatus(users.booker, {
      ...(await (await import("../lib/commerce")).loadCommerce({ userId: users.booker })),
      freeMatchEnabled: false,
    });
    expect(status.enabled).toBe(false);
    expect(status.attempt).toBeNull();
    expect(status.reward?.status).toBe("available");
  });

  it("never touches other players' rewards", async () => {
    const rows = await db.select().from(freeMatchRewardsTable).where(and(
      inArray(freeMatchRewardsTable.userId, [users.f1, users.f2]),
    ));
    expect(rows).toHaveLength(0);
  });
});

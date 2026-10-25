import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// Which recordings each room's booking overlaps, and how much of each recording's match it
// covers (0..1). The real lookup needs tracked footage on the field's clock; what matters
// here is who found themselves in it.
const roomRecordings = vi.hoisted(() => new Map<number, Array<{ recordingId: number; share: number }>>());

vi.mock("../lib/matchFeed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/matchFeed")>()),
  recordingsForRoom: vi.fn(async (ctx: { room: { id: number } }) =>
    (roomRecordings.get(ctx.room.id) ?? []).map(({ recordingId, share }) => ({
      recordingId, bundleId: 0, manifest: { version: 1, duration: 3600 }, fromSeconds: 0, toSeconds: 3600 * share, recordingOffsetSec: 0,
    }))),
}));

// The camera service: accepts every job unless a test says otherwise.
const camera = vi.hoisted(() => ({ ok: true }));
vi.mock("./contabo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contabo")>()),
  controlFetch: vi.fn(async () => (camera.ok
    ? { ok: true, status: 200, body: { jobId: `job-${Math.random().toString(36).slice(2, 8)}`, status: "scheduled" } }
    : { ok: false, status: 503, body: { error: "camera offline" } })),
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
import matchRoomsRouter from "./matchRooms";
import { bookingRecordings, freeMatchStatus, loyaltyStatus } from "../lib/freeMatch";
import { loadCommerce } from "../lib/commerce";
import { ensureRoomForRequest } from "../lib/matchRooms";

const TAG = `fm_${Date.now()}`;
let app: Express;
const users: Record<string, number> = {};
let fieldId: number;
const recordingIds: number[] = [];
const bundleByRecording = new Map<number, number>();
const FRIENDS = ["f1", "f2", "f3", "f4", "f5"];

function localString(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const as = (who: string) => ({ "x-test-user": String(users[who]) });
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A booking by `who` starting `hoursAgo` ago (negative = in the future), paid the given way, with its own recording. */
async function booking(who: string, method: "cliq" | "field", hoursAgo: number, opts: { status?: string; paid?: boolean; readyAt?: Date } = {}) {
  const quarter = 15 * 60 * 1000;
  const start = Math.floor((Date.now() - hoursAgo * HOUR) / quarter) * quarter;
  const future = hoursAgo < 0;
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: `cam-${TAG}`,
    requestedBy: users[who],
    startLocal: localString(start),
    endLocal: localString(start + HOUR),
    requestedSeconds: 3600,
    rateFils: 0,
    status: opts.status ?? (future ? "scheduled" : "ready"),
    readyAt: future ? null : (opts.readyAt ?? new Date(start + HOUR)),
  }).returning();
  const room = await ensureRoomForRequest(row);
  await db.insert(statUnlocksTable).values({
    userId: users[who], matchId: room.id, kind: "booking", amountFils: 2000,
    reference: `RB${room.code}-${TAG}-${Math.random().toString(36).slice(2, 6)}`, method, status: opts.paid === false ? "pending" : "paid",
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
  roomRecordings.set(room.id, [{ recordingId: recording.id, share: 1 }]);
  return { room, request: row, recordingId: recording.id };
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

async function everyoneFinds(recordingId: number, who = ["booker", ...FRIENDS]) {
  for (const person of who) await found(person, recordingId);
}

/** His rewards of one kind (the challenge unless asked); the other kind is tested on its own. */
const rewardsOf = (who: string, kind: "challenge" | "loyalty" = "challenge") => db.select().from(freeMatchRewardsTable)
  .where(and(eq(freeMatchRewardsTable.userId, users[who]), eq(freeMatchRewardsTable.kind, kind)));

function slot(daysAhead: number, hour: number, minutes: number) {
  const day = localString(Date.now() + daysAhead * DAY).slice(0, 10);
  const endMinutes = hour * 60 + minutes;
  return {
    fieldId,
    startLocal: `${day} ${String(hour).padStart(2, "0")}:00`,
    endLocal: `${day} ${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`,
  };
}

/** Clear one player's free-match state between scenarios. */
async function resetPlayer(who: string) {
  await db.delete(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.userId, users[who]));
  await db.update(footageRequestsTable).set({ status: "cancelled" }).where(eq(footageRequestsTable.requestedBy, users[who]));
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://control.example.test";
  process.env.CONTABO_CONTROL_KEY = "test-key";
  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);
  app.use("/api", matchRoomsRouter);
  for (const key of ["booker", "other", "loyal", ...FRIENDS, "guest", "admin"]) {
    const [u] = await db.insert(usersTable).values({
      name: `${key} ${TAG}`, email: `${TAG}_${key}@test.local`, profileComplete: true,
      isGuest: key === "guest", isAdmin: key === "admin",
    }).returning({ id: usersTable.id });
    users[key] = u.id;
  }
  const [field] = await db.insert(fieldsTable).values({ name: `Free Field ${TAG}`, location: "Test", cameraId: `cam-${TAG}` })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
});

beforeEach(() => {
  camera.ok = true;
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

describe("free match: earning", () => {
  let source: Awaited<ReturnType<typeof booking>>;

  it("does not count a match paid at the field", async () => {
    const fieldPaid = await booking("booker", "field", 30);
    await everyoneFinds(fieldPaid.recordingId);
    const status = await freeMatchStatus(users.booker);
    expect(status.attempt).toBeNull();
    expect(status.reward).toBeNull();
  });

  it("tracks the booker and his friends on a CliQ booking", async () => {
    source = await booking("booker", "cliq", 3);
    let status = await freeMatchStatus(users.booker);
    expect(status.attempt?.code).toBe(source.room.code);
    expect(status.attempt?.paid).toBe(true);
    expect(status.attempt?.bookerFound).toBe(false);

    await everyoneFinds(source.recordingId, ["booker", "f1", "f2", "f3", "f4"]);
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
    expect(await rewardsOf("booker")).toHaveLength(1);
  });

  it("is once per player: a second full match never earns another", async () => {
    const again = await booking("booker", "cliq", 2);
    await everyoneFinds(again.recordingId);
    const status = await freeMatchStatus(users.booker);
    expect(status.canEarn).toBe(false);
    expect(status.attempt).toBeNull();
    expect(await rewardsOf("booker")).toHaveLength(1);
    // Even after he has used it, it doesn't come round again.
    await db.update(freeMatchRewardsTable).set({ status: "used", usedAt: new Date(), earnedAt: new Date(Date.now() - 400 * DAY) })
      .where(eq(freeMatchRewardsTable.userId, users.booker));
    await freeMatchStatus(users.booker);
    expect(await rewardsOf("booker")).toHaveLength(1);
    await db.update(freeMatchRewardsTable).set({ status: "available", usedAt: null }).where(eq(freeMatchRewardsTable.userId, users.booker));
    const fields = await request(app).get("/api/bookings/fields").set(as("booker"));
    expect(fields.body.freeMatch.canEarn).toBe(false);
  });

  it("a newer upcoming booking does not hide an older match that just finished", async () => {
    await resetPlayer("other");
    const played = await booking("other", "cliq", 5);
    await booking("other", "cliq", -48); // booked the next game before his friends finished
    await everyoneFinds(played.recordingId, ["other", ...FRIENDS]);
    const status = await freeMatchStatus(users.other);
    expect(status.reward?.sourceCode).toBe(played.room.code);
  });

  it("still earns when the booker only looks after the video was deleted", async () => {
    await resetPlayer("other");
    const old = await booking("other", "cliq", 17 * 24, { readyAt: new Date(Date.now() - 16 * DAY) });
    await everyoneFinds(old.recordingId, ["other", ...FRIENDS]);
    const status = await freeMatchStatus(users.other);
    expect(status.reward?.sourceCode).toBe(old.room.code);
    // ...but a lapsed match with work left is not shown as something to do.
    await resetPlayer("other");
    await booking("other", "cliq", 17 * 24, { readyAt: new Date(Date.now() - 16 * DAY) });
    expect((await freeMatchStatus(users.other)).attempt).toBeNull();
  });

  it("counts only the recording that is this booking's match", async () => {
    await resetPlayer("other");
    const mine = await booking("other", "cliq", 4);
    const neighbour = await booking("f1", "cliq", 5); // the previous group, whose pull ran into this slot
    roomRecordings.set(mine.room.id, [
      { recordingId: neighbour.recordingId, share: 0.1 },
      { recordingId: mine.recordingId, share: 0.9 },
    ]);
    await everyoneFinds(neighbour.recordingId, ["f2", "f3", "f4", "f5"]);
    await found("other", mine.recordingId);
    const status = await freeMatchStatus(users.other);
    expect(status.attempt?.findRecordingId).toBe(mine.recordingId);
    expect(status.attempt?.friendsFound).toBe(0);
    expect(bookingRecordings([
      { recordingId: 1, bundleId: 0, manifest: { duration: 3600 } as never, fromSeconds: 0, toSeconds: 300, recordingOffsetSec: 0 },
    ]).map((r) => r.recordingId)).toEqual([1]); // a lone small overlap is still better than nothing
  });

  it("a partly free CliQ booking never counts toward another free match", async () => {
    await resetPlayer("other");
    const played = await booking("other", "cliq", 6);
    await everyoneFinds(played.recordingId, ["other", ...FRIENDS]);
    await freeMatchStatus(users.other); // earns
    // Spend it on a 3-hour booking (1 extra hour paid by CliQ), then play it and get everyone in.
    const res = await request(app).post("/api/bookings").set(as("other")).send({ ...slot(2, 9, 180), payWith: "cliq", useFreeMatch: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ method: "cliq", amountFils: 2000 });
    const [usedRoom] = await db.select().from(matchRoomsTable).where(eq(matchRoomsTable.code, res.body.code));
    await db.update(footageRequestsTable).set({ status: "ready", readyAt: new Date() }).where(eq(footageRequestsTable.id, res.body.requestId));
    await db.update(statUnlocksTable).set({ status: "paid" }).where(eq(statUnlocksTable.reference, res.body.reference));
    const [rec] = await db.insert(recordingsTable).values({
      fieldId, court: "1", date: "2026-01-01", timeSlot: "09:00", duration: "01:00:00", videoUrl: `https://example.test/${TAG}-partial.m3u8`, isVisible: true,
    }).returning({ id: recordingsTable.id });
    recordingIds.push(rec.id);
    const [bundle] = await db.insert(recordingTrackingBundlesTable).values({ recordingId: rec.id, uploadedBy: users.booker, manifest: { version: 1, duration: 3600 } as never }).returning({ id: recordingTrackingBundlesTable.id });
    bundleByRecording.set(rec.id, bundle.id);
    roomRecordings.set(usedRoom.id, [{ recordingId: rec.id, share: 1 }]);
    await everyoneFinds(rec.id, ["other", ...FRIENDS]);
    await freeMatchStatus(users.other);
    expect(await rewardsOf("other")).toHaveLength(1);
  });

  it("a friend counts only with a real account and his own player confirmed", async () => {
    await resetPlayer("other");
    const played = await booking("other", "cliq", 9);
    await everyoneFinds(played.recordingId, ["other", "f1", "f2", "f3", "f4"]);
    // f5 finished, but the player he picked isn't confirmed as him yet.
    await db.insert(claimMatchProgressTable).values({ userId: users.f5, recordingId: played.recordingId, completed: true, stage: "done" });
    await db.insert(claimMatchIdentityBindingsTable).values({
      userId: users.f5, recordingId: played.recordingId, personId: "p-f5", trackingBundleId: bundleByRecording.get(played.recordingId)!,
      bundleFingerprint: "fp", personParts: ["p-f5"], vouchedFragments: [], resolutionMethod: "track-fallback",
      supportCount: 1, acceptedAnswerCount: 1, supportPercent: 100, state: "pending",
    });
    // A deleted account that had found himself doesn't count either.
    const [gone] = await db.insert(usersTable).values({ name: `gone ${TAG}`, email: "deleted-player@soccerwatch.local", profileComplete: true })
      .returning({ id: usersTable.id });
    users.gone = gone.id;
    await found("gone", played.recordingId);
    let status = await freeMatchStatus(users.other);
    expect(status.attempt?.friendsFound).toBe(4);
    expect(status.reward).toBeNull();
    await db.update(claimMatchIdentityBindingsTable).set({ state: "confirmed" })
      .where(and(eq(claimMatchIdentityBindingsTable.userId, users.f5), eq(claimMatchIdentityBindingsTable.recordingId, played.recordingId)));
    status = await freeMatchStatus(users.other);
    expect(status.reward?.sourceCode).toBe(played.room.code);
  });

  it("two loads at once never earn twice", async () => {
    await resetPlayer("other");
    const a = await booking("other", "cliq", 8);
    const b = await booking("other", "cliq", 7);
    await everyoneFinds(a.recordingId, ["other", ...FRIENDS]);
    await everyoneFinds(b.recordingId, ["other", ...FRIENDS]);
    await Promise.all([freeMatchStatus(users.other), freeMatchStatus(users.other), freeMatchStatus(users.other)]);
    expect(await rewardsOf("other")).toHaveLength(1);
  });
});

describe("free match: spending", () => {
  let rewardId: number;

  it("books up to two hours for nothing and spends the free match", async () => {
    const [reward] = await rewardsOf("booker");
    rewardId = reward.id;
    const res = await request(app).post("/api/bookings").set(as("booker"))
      .send({ ...slot(2, 10, 120), payWith: "cliq", useFreeMatch: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amountFils: 0, method: "free", freeMatch: true, status: "scheduled" });
    const [after] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, rewardId));
    expect(after.status).toBe("used");
    const [payment] = await db.select().from(statUnlocksTable).where(eq(statUnlocksTable.reference, res.body.reference));
    expect(payment).toMatchObject({ method: "free", status: "paid", amountFils: 0 });

    // The match page says it's a free match, not "paid".
    const room = await request(app).get(`/api/m/${res.body.code}`).set(as("booker"));
    expect(room.body.booking).toMatchObject({ method: "free", status: "paid", mine: true });

    const twice = await request(app).post("/api/bookings").set(as("booker")).send({ ...slot(3, 10, 60), useFreeMatch: true });
    expect(twice.status).toBe(409);

    // Cancelling it before kick-off hands the free match back.
    const cancel = await request(app).delete(`/api/bookings/${res.body.requestId}`).set(as("booker"));
    expect(cancel.status).toBe(204);
    const [back] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, rewardId));
    expect(back).toMatchObject({ status: "available", usedMatchId: null });
  });

  it("a double tap spends the free match once", async () => {
    const [a, b] = await Promise.all([
      request(app).post("/api/bookings").set(as("booker")).send({ ...slot(5, 10, 60), payWith: "cliq", useFreeMatch: true }),
      request(app).post("/api/bookings").set(as("booker")).send({ ...slot(5, 14, 60), payWith: "cliq", useFreeMatch: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const won = a.status === 201 ? a : b;
    await request(app).delete(`/api/bookings/${won.body.requestId}`).set(as("booker"));
    const [back] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, rewardId));
    expect(back.status).toBe("available");
  });

  it("a booking the camera couldn't start gives the free match back", async () => {
    camera.ok = false;
    const res = await request(app).post("/api/bookings").set(as("booker")).send({ ...slot(6, 10, 60), useFreeMatch: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("failed");
    const status = await freeMatchStatus(users.booker);
    expect(status.reward?.id).toBe(rewardId);
  });

  it("a booking the owner cancelled gives the free match back, with the time it was held", async () => {
    const [before] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, rewardId));
    const res = await request(app).post("/api/bookings").set(as("booker")).send({ ...slot(7, 10, 60), useFreeMatch: true });
    expect(res.status).toBe(201);
    await db.update(freeMatchRewardsTable).set({ usedAt: new Date(Date.now() - DAY) }).where(eq(freeMatchRewardsTable.id, rewardId));
    await db.update(footageRequestsTable).set({ status: "cancelled", message: "Cancelled by owner" }).where(eq(footageRequestsTable.id, res.body.requestId));
    const status = await freeMatchStatus(users.booker);
    expect(status.reward?.id).toBe(rewardId);
    expect(Date.parse(status.reward!.expiresAt)).toBeGreaterThan(before.expiresAt.getTime() + DAY - 60_000);
  });

  it("charges only the extra hours; an admin rejecting that transfer gives the free match back", async () => {
    const res = await request(app).post("/api/bookings").set(as("booker"))
      .send({ ...slot(4, 18, 180), payWith: "cliq", useFreeMatch: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amountFils: 2000, method: "cliq", status: "awaiting_payment" });
    const [payment] = await db.select().from(statUnlocksTable).where(eq(statUnlocksTable.reference, res.body.reference));
    const reject = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/reject`).set(as("admin"));
    expect(reject.status).toBe(200);
    const status = await freeMatchStatus(users.booker);
    expect(status.reward?.id).toBe(rewardId);
  });

  it("a fully free booking can't be cancelled here after kick-off", async () => {
    const res = await request(app).post("/api/bookings").set(as("booker")).send({ ...slot(8, 10, 60), useFreeMatch: true });
    expect(res.status).toBe(201);
    await db.update(footageRequestsTable).set({ startLocal: localString(Date.now() - HOUR), endLocal: localString(Date.now()) })
      .where(eq(footageRequestsTable.id, res.body.requestId));
    const cancel = await request(app).delete(`/api/bookings/${res.body.requestId}`).set(as("booker"));
    expect(cancel.status).toBe(409);
    await db.update(footageRequestsTable).set({ status: "cancelled" }).where(eq(footageRequestsTable.id, res.body.requestId));
  });

  it("offers the free match on the Book page", async () => {
    const res = await request(app).get("/api/bookings/fields").set(as("booker"));
    expect(res.status).toBe(200);
    expect(res.body.freeMatch).toMatchObject({ enabled: true, freeHours: 2, reward: { freeHours: 2 } });
  });

  it("is off for everyone when the setting is off, but an earned one still shows", async () => {
    const status = await freeMatchStatus(users.booker, { commerce: {
      ...(await (await import("../lib/commerce")).loadCommerce({ userId: users.booker })),
      freeMatchEnabled: false,
    } });
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

describe("free game every 5 bookings", () => {
  // Count from long ago so the test's bookings (some from yesterday) all qualify.
  const commerce = async (over: Record<string, unknown> = {}) => ({
    ...(await loadCommerce({ userId: users.loyal })), loyaltyCountFrom: "2000-01-01", ...over,
  });
  const loyalRewards = () => rewardsOf("loyal", "loyalty");

  it("counts paid games he played, and the fifth earns a free one", async () => {
    await booking("loyal", "cliq", 50);
    await booking("loyal", "field", 40);
    await booking("loyal", "cliq", 30);
    await booking("loyal", "cliq", 20);
    let status = await freeMatchStatus(users.loyal, { commerce: await commerce() });
    expect(status.loyalty).toMatchObject({ enabled: true, every: 5, count: 4, total: 4, earned: 0 });
    expect(status.reward).toBeNull();

    // These don't count: waiting for payment, not played yet, cancelled.
    await booking("loyal", "cliq", 10, { paid: false });
    await booking("loyal", "cliq", -24);
    await booking("loyal", "cliq", 12, { status: "cancelled" });
    status = await freeMatchStatus(users.loyal, { commerce: await commerce() });
    expect(status.loyalty.total).toBe(4);

    await booking("loyal", "field", 8);
    status = await freeMatchStatus(users.loyal, { commerce: await commerce() });
    expect(status.loyalty).toMatchObject({ count: 0, total: 5, earned: 1 });
    expect(status.reward).toMatchObject({ kind: "loyalty", freeHours: 2, status: "available" });
    // A loyalty free game doesn't use up the friends challenge.
    expect(status.canEarn).toBe(true);
    expect(await loyalRewards()).toHaveLength(1);
  });

  it("a game paid for with a free match doesn't count toward the next", async () => {
    const [reward] = await loyalRewards();
    const paidWithFree = await booking("loyal", "cliq", 6);
    await db.update(freeMatchRewardsTable).set({ status: "used", usedMatchId: paidWithFree.room.id, usedAt: new Date() })
      .where(eq(freeMatchRewardsTable.id, reward.id));
    const status = await loyaltyStatus(users.loyal, await commerce());
    expect(status).toMatchObject({ total: 5, count: 0 });
  });

  it("only bookings from the count-from date count", async () => {
    const status = await loyaltyStatus(users.loyal, await commerce({ loyaltyCountFrom: "2999-01-01" }));
    expect(status.total).toBe(0);
  });

  it("ten games earn two, written once even when loaded twice at once", async () => {
    for (const hours of [7, 5, 4, 3, 2]) await booking("loyal", "cliq", hours);
    const c = await commerce();
    const [a, b] = await Promise.all([loyaltyStatus(users.loyal, c), loyaltyStatus(users.loyal, c)]);
    expect(a.earned).toBe(2);
    expect(b.earned).toBe(2);
    expect((await loyalRewards()).map((row) => row.milestone).sort()).toEqual([1, 2]);
  });

  it("off stops new ones", async () => {
    await resetPlayer("loyal");
    await booking("loyal", "cliq", 60);
    for (const hours of [58, 56, 54, 52]) await booking("loyal", "cliq", hours);
    const status = await loyaltyStatus(users.loyal, await commerce({ loyaltyEnabled: false }));
    expect(status.enabled).toBe(false);
    expect(await loyalRewards()).toHaveLength(0);
  });

  it("the Book page shows where he is", async () => {
    const res = await request(app).get("/api/bookings/fields").set(as("loyal"));
    expect(res.status).toBe(200);
    expect(res.body.freeMatch.loyalty).toMatchObject({ enabled: true, every: 5 });
  });
});

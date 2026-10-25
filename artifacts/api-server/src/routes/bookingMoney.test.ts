import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  academiesTable,
  db,
  fieldOwnersTable,
  fieldsTable,
  footageCancellationRequestsTable,
  footageRequestsTable,
  freeMatchRewardsTable,
  matchPlayersTable,
  matchRoomsTable,
  statUnlocksTable,
  usersTable,
} from "@workspace/db";

// The camera service: records every call, accepts every job unless a test says otherwise.
const camera = vi.hoisted(() => ({ ok: true, calls: [] as Array<{ path: string; method: string }> }));
vi.mock("./contabo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contabo")>()),
  controlFetch: vi.fn(async (path: string, init?: { method?: string }) => {
    camera.calls.push({ path, method: init?.method ?? "GET" });
    if (!camera.ok) return { ok: false, status: 503, body: { error: "camera offline" } };
    return { ok: true, status: 200, body: { jobId: `job-${Math.random().toString(36).slice(2, 8)}`, status: "scheduled" } };
  }),
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

import ownerRouter, { activatePaidBooking, cancelUnpaidBooking, lapseUnpaidBookings } from "./owner";
import matchRoomsRouter from "./matchRooms";
import { availableReward, reconcileRewards, UNPAID_BOOKING_LAPSE_MS } from "../lib/freeMatch";

const TAG = `bm_${Date.now()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let app: Express;
const users: Record<string, number> = {};
let fieldId: number;
let academyId: number;
let nextMilestone = 100;

const as = (who: string) => ({ "x-test-user": String(users[who]) });

function localString(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** A slot `daysAhead` days out, starting on the hour, lasting `minutes`. */
function slot(daysAhead: number, hour: number, minutes = 60) {
  const day = localString(Date.now() + daysAhead * DAY).slice(0, 10);
  const endMinutes = hour * 60 + minutes;
  return {
    fieldId,
    startLocal: `${day} ${String(hour).padStart(2, "0")}:00`,
    endLocal: `${day} ${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`,
  };
}

/** A free match (2 free hours) for `who`, expiring in `expiresInMs`. */
async function giveReward(who: string, expiresInMs = 30 * DAY) {
  const [row] = await db.insert(freeMatchRewardsTable).values({
    userId: users[who], kind: "loyalty", milestone: nextMilestone++, sourceMatchId: null,
    freeHours: 2, worthFils: 4000, friendNames: [], expiresAt: new Date(Date.now() + expiresInMs),
  }).returning();
  return row;
}

const rewardRow = async (id: number) => (await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.id, id)))[0];
const requestRow = async (id: number) => (await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, id)))[0];
const paymentRow = async (reference: string) => (await db.select().from(statUnlocksTable).where(eq(statUnlocksTable.reference, reference)))[0];
const cameraPosts = () => camera.calls.filter((c) => c.method === "POST" && c.path.startsWith("/record-hq/"));
const cameraDeletes = () => camera.calls.filter((c) => c.method === "DELETE" && c.path.startsWith("/record-hq/"));

/** Clear every booking and reward between scenarios, so slots and holds never leak. */
async function resetAll() {
  await db.delete(freeMatchRewardsTable).where(inArray(freeMatchRewardsTable.userId, Object.values(users)));
  await db.update(footageRequestsTable).set({ status: "cancelled" }).where(eq(footageRequestsTable.fieldId, fieldId));
}

beforeAll(async () => {
  process.env.PUBLIC_SHARE_BASE_URL = "https://replay.example.test";
  process.env.CONTABO_CONTROL_URL = "https://control.example.test";
  process.env.CONTABO_CONTROL_KEY = "test-key";
  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);
  app.use("/api", matchRoomsRouter);
  for (const key of ["player", "p2", "p3", "p4", "owner", "admin"]) {
    const [u] = await db.insert(usersTable).values({
      name: `${key} ${TAG}`, email: `${TAG}_${key}@test.local`, profileComplete: true, isAdmin: key === "admin",
    }).returning({ id: usersTable.id });
    users[key] = u.id;
  }
  const [field] = await db.insert(fieldsTable).values({ name: `Money Field ${TAG}`, location: "Test", cameraId: `cam-${TAG}` })
    .returning({ id: fieldsTable.id });
  fieldId = field.id;
  await db.insert(fieldOwnersTable).values({ userId: users.owner, fieldId });
  const [academy] = await db.insert(academiesTable).values({ name: `Money Academy ${TAG}`, fieldId }).returning({ id: academiesTable.id });
  academyId = academy.id;
});

beforeEach(async () => {
  camera.ok = true;
  camera.calls.length = 0;
  await resetAll();
});

afterAll(async () => {
  const ids = Object.values(users);
  await db.delete(freeMatchRewardsTable).where(inArray(freeMatchRewardsTable.userId, ids));
  await db.delete(statUnlocksTable).where(inArray(statUnlocksTable.userId, ids));
  const rooms = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.fieldId, fieldId));
  if (rooms.length) await db.delete(matchPlayersTable).where(inArray(matchPlayersTable.matchId, rooms.map((r) => r.id)));
  await db.delete(matchRoomsTable).where(eq(matchRoomsTable.fieldId, fieldId));
  await db.delete(footageRequestsTable).where(eq(footageRequestsTable.fieldId, fieldId));
  await db.delete(academiesTable).where(eq(academiesTable.id, academyId));
  await db.delete(fieldOwnersTable).where(eq(fieldOwnersTable.fieldId, fieldId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

describe("pay at the field, then switched to CliQ", () => {
  async function switchedBooking(daysAhead: number) {
    const booked = await request(app).post("/api/bookings").set(as("player")).send({ ...slot(daysAhead, 18), payWith: "field" });
    expect(booked.status).toBe(201);
    expect(booked.body.status).toBe("scheduled");
    const switched = await request(app).post(`/api/bookings/${booked.body.requestId}/pay-with`).set(as("player")).send({ method: "cliq" });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ method: "cliq", status: "scheduled" });
    return booked.body as { requestId: number; code: string; reference: string };
  }

  it("stays locked in, and the field can still take the cash for it", async () => {
    const booking = await switchedBooking(3);
    const page = await request(app).get(`/api/m/${booking.code}`).set(as("player"));
    expect(page.body.booking).toMatchObject({ method: "cliq", status: "pending" });
    const collected = await request(app).post(`/api/m/${booking.code}/booking/collect`).set(as("owner")).send({});
    expect(collected.status).toBe(200);
    expect(collected.body.booking).toMatchObject({ status: "paid", method: "field" });
    expect(await paymentRow(booking.reference)).toMatchObject({ status: "paid", method: "field" });
  });

  it("the booker can still cancel it before kick-off: the camera job is stopped", async () => {
    const booking = await switchedBooking(4);
    const del = await request(app).delete(`/api/bookings/${booking.requestId}`).set(as("player"));
    expect(del.status).toBe(204);
    expect(cameraDeletes()).toHaveLength(1);
    expect((await requestRow(booking.requestId)).status).toBe("cancelled");
    expect((await paymentRow(booking.reference)).status).toBe("rejected");
  });

  it("an admin rejecting the transfer cancels the recording, even once it is recording", async () => {
    const booking = await switchedBooking(5);
    // The match has kicked off and the camera is recording; the transfer never came.
    await db.update(footageRequestsTable).set({ status: "recording" }).where(eq(footageRequestsTable.id, booking.requestId));
    const payment = await paymentRow(booking.reference);
    const reject = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/reject`).set(as("admin"));
    expect(reject.status).toBe(200);
    expect(reject.body).toMatchObject({ status: "rejected", booking: { status: "cancelled" } });
    expect(cameraDeletes()).toHaveLength(1);
    expect((await requestRow(booking.requestId)).status).toBe("cancelled");
  });

  it("a reject the camera can't carry out changes nothing and can be retried", async () => {
    const booking = await switchedBooking(6);
    const payment = await paymentRow(booking.reference);
    camera.ok = false;
    const reject = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/reject`).set(as("admin"));
    expect(reject.status).toBe(502);
    expect((await paymentRow(booking.reference)).status).toBe("pending");
    expect((await requestRow(booking.requestId)).status).toBe("scheduled");
    camera.ok = true;
    const retry = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/reject`).set(as("admin"));
    expect(retry.status).toBe(200);
    expect((await requestRow(booking.requestId)).status).toBe("cancelled");
  });

  it("an admin confirming the transfer marks it paid and keeps the recording", async () => {
    const booking = await switchedBooking(7);
    const payment = await paymentRow(booking.reference);
    const confirm = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/confirm`).set(as("admin"));
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ status: "paid", booking: { status: "scheduled" } });
    expect(cameraPosts()).toHaveLength(1); // only the original lock-in
  });

  it("counts as a booking waiting for payment", async () => {
    await switchedBooking(8);
    await switchedBooking(9);
    await switchedBooking(10);
    const fourth = await request(app).post("/api/bookings").set(as("player")).send({ ...slot(11, 18), payWith: "field" });
    expect(fourth.status).toBe(409);
  });
});

describe("unpaid bookings that are never paid", () => {
  /** A partly free CliQ booking (3 hours, 2 free) that is never paid, its slot moved `endedAgoMs` into the past. */
  async function unpaidPartlyFree(endedAgoMs: number) {
    const reward = await giveReward("player");
    const booked = await request(app).post("/api/bookings").set(as("player")).send({ ...slot(2, 9, 180), payWith: "cliq", useFreeMatch: true });
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ status: "awaiting_payment", amountFils: 2000, freeMatch: true });
    const end = Math.floor((Date.now() - endedAgoMs) / (15 * 60 * 1000)) * 15 * 60 * 1000;
    await db.update(footageRequestsTable).set({ startLocal: localString(end - 3 * HOUR), endLocal: localString(end) })
      .where(eq(footageRequestsTable.id, booked.body.requestId));
    return { reward, requestId: booked.body.requestId as number, reference: booked.body.reference as string };
  }

  it("keeps the free match while a late transfer can still be confirmed", async () => {
    const { reward, requestId, reference } = await unpaidPartlyFree(HOUR);
    expect(await availableReward(users.player)).toBeNull();
    expect(await lapseUnpaidBookings()).toBe(0);
    // Confirmed after the whistle but inside the window: pulled from the SD card.
    const payment = await paymentRow(reference);
    const confirm = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/confirm`).set(as("admin"));
    expect(confirm.status).toBe(200);
    expect(cameraPosts()).toHaveLength(1);
    expect((await requestRow(requestId)).status).not.toBe("awaiting_payment");
    expect((await rewardRow(reward.id)).status).toBe("used");
  });

  it("hands the free match back once it has lapsed, extended by the time it was held", async () => {
    const { reward, requestId } = await unpaidPartlyFree(UNPAID_BOOKING_LAPSE_MS + HOUR);
    const end = Date.parse(`${(await requestRow(requestId)).endLocal.replace(" ", "T")}:00+03:00`);
    // Claimed 3 days before the slot ended.
    await db.update(freeMatchRewardsTable).set({ usedAt: new Date(end - 3 * DAY) }).where(eq(freeMatchRewardsTable.id, reward.id));
    // Read before any sweep has run: still handed back.
    const back = await availableReward(users.player);
    expect(back?.id).toBe(reward.id);
    // Held until the slot ended, not until it was noticed.
    expect(Math.abs(back!.expiresAt.getTime() - (reward.expiresAt.getTime() + 3 * DAY))).toBeLessThan(60_000);
  });

  it("the sweep cancels a lapsed booking and turns its payment down; a late confirm is refused", async () => {
    const { reward, requestId, reference } = await unpaidPartlyFree(UNPAID_BOOKING_LAPSE_MS + HOUR);
    expect(await lapseUnpaidBookings()).toBe(1);
    expect(await requestRow(requestId)).toMatchObject({ status: "cancelled", message: "Payment not received in time" });
    expect((await rewardRow(reward.id)).status).toBe("available");
    const payment = await paymentRow(reference);
    expect(payment.status).toBe("rejected");
    const confirm = await request(app).post(`/api/admin/stat-unlocks/${payment.id}/confirm`).set(as("admin"));
    expect(confirm.status).toBe(409);
    expect((await paymentRow(reference)).status).toBe("rejected");
    expect(cameraPosts()).toHaveLength(0);
  });

  it("a lapsed booking is never activated, even before the sweep", async () => {
    const { requestId } = await unpaidPartlyFree(UNPAID_BOOKING_LAPSE_MS + HOUR);
    expect(await activatePaidBooking(requestId)).toEqual({ status: "cancelled" });
    expect(cameraPosts()).toHaveLength(0);
  });
});

describe("handing back a free match", () => {
  /** A fully free booking (2 hours) by the player, spending a fresh reward. */
  async function freeBooking(daysAhead: number) {
    const reward = await giveReward("player");
    const booked = await request(app).post("/api/bookings").set(as("player")).send({ ...slot(daysAhead, 10, 120), useFreeMatch: true });
    expect(booked.status).toBe(201);
    expect(booked.body.method).toBe("free");
    return { reward, requestId: booked.body.requestId as number };
  }

  async function refund(requestId: number) {
    const [cancellation] = await db.insert(footageCancellationRequestsTable).values({
      footageRequestId: requestId, requestedBy: users.owner, reason: "test refund",
    }).returning();
    const res = await request(app).patch(`/api/admin/footage-cancellation-requests/${cancellation.id}`).set(as("admin")).send({ status: "approved" });
    expect(res.status).toBe(200);
    expect((await requestRow(requestId)).status).toBe("refunded");
  }

  it("refunding a match that was delivered keeps the free match spent", async () => {
    const { reward, requestId } = await freeBooking(2);
    await db.update(footageRequestsTable).set({ status: "ready", readyAt: new Date(), videoId: "video-1", deliveredSeconds: 7200 })
      .where(eq(footageRequestsTable.id, requestId));
    await refund(requestId);
    await reconcileRewards(users.player);
    expect((await rewardRow(reward.id)).status).toBe("used");
    expect(await availableReward(users.player)).toBeNull();
  });

  it("a refunded booking that never delivered anything hands it back", async () => {
    const { reward, requestId } = await freeBooking(3);
    await db.update(footageRequestsTable).set({ status: "refunded" }).where(eq(footageRequestsTable.id, requestId));
    await reconcileRewards(users.player);
    expect((await rewardRow(reward.id)).status).toBe("available");
  });

  it("adds back only the time it was held until the cancel, not until it is noticed", async () => {
    const { reward, requestId } = await freeBooking(4);
    // Claimed 10 days ago; the owner cancelled the booking 8 days ago; nobody looked since.
    await db.update(freeMatchRewardsTable).set({ usedAt: new Date(Date.now() - 10 * DAY) }).where(eq(freeMatchRewardsTable.id, reward.id));
    await db.update(footageRequestsTable).set({ status: "cancelled", updatedAt: new Date(Date.now() - 8 * DAY) })
      .where(eq(footageRequestsTable.id, requestId));
    await reconcileRewards(users.player);
    const back = await rewardRow(reward.id);
    expect(back.status).toBe("available");
    expect(Math.abs(back.expiresAt.getTime() - (reward.expiresAt.getTime() + 2 * DAY))).toBeLessThan(60_000);
  });

  it("never brings back a free match whose extended expiry has passed", async () => {
    const { reward, requestId } = await freeBooking(5);
    // Claimed 6 days ago, cancelled 5.5 days ago, expired 5 days ago: half a day back still leaves it expired.
    await db.update(freeMatchRewardsTable).set({ usedAt: new Date(Date.now() - 6 * DAY), expiresAt: new Date(Date.now() - 5 * DAY) })
      .where(eq(freeMatchRewardsTable.id, reward.id));
    await db.update(footageRequestsTable).set({ status: "cancelled", updatedAt: new Date(Date.now() - 5.5 * DAY) })
      .where(eq(footageRequestsTable.id, requestId));
    await reconcileRewards(users.player);
    expect((await rewardRow(reward.id)).status).toBe("used");
    expect(await availableReward(users.player)).toBeNull();
  });

  it("cancelling before kick-off gives it back with the time held so far", async () => {
    const { reward, requestId } = await freeBooking(6);
    await db.update(freeMatchRewardsTable).set({ usedAt: new Date(Date.now() - DAY) }).where(eq(freeMatchRewardsTable.id, reward.id));
    expect((await request(app).delete(`/api/bookings/${requestId}`).set(as("player"))).status).toBe(204);
    const back = await rewardRow(reward.id);
    expect(back.status).toBe("available");
    expect(Math.abs(back.expiresAt.getTime() - (reward.expiresAt.getTime() + DAY))).toBeLessThan(60_000);
  });
});

describe("cancel and confirm racing", () => {
  async function cliqBooking(daysAhead: number, hour = 20) {
    const booked = await request(app).post("/api/bookings").set(as("player")).send({ ...slot(daysAhead, hour), payWith: "cliq" });
    expect(booked.status).toBe(201);
    expect(booked.body.status).toBe("awaiting_payment");
    const payment = await paymentRow(booked.body.reference);
    return { requestId: booked.body.requestId as number, reference: booked.body.reference as string, paymentId: payment.id };
  }

  it("cancelled first: the admin's confirm is refused, nothing records, nothing is marked paid", async () => {
    const booking = await cliqBooking(2);
    expect((await request(app).delete(`/api/bookings/${booking.requestId}`).set(as("player"))).status).toBe(204);
    const confirm = await request(app).post(`/api/admin/stat-unlocks/${booking.paymentId}/confirm`).set(as("admin"));
    expect(confirm.status).toBe(409);
    expect((await paymentRow(booking.reference)).status).not.toBe("paid");
    expect((await requestRow(booking.requestId)).status).toBe("cancelled");
    expect(cameraPosts()).toHaveLength(0);
  });

  it("confirmed between the booker's read and his cancel: the cancel does nothing", async () => {
    const booking = await cliqBooking(3);
    // The DELETE has read "awaiting_payment"; the admin confirms; then the DELETE writes.
    const confirm = await request(app).post(`/api/admin/stat-unlocks/${booking.paymentId}/confirm`).set(as("admin"));
    expect(confirm.status).toBe(200);
    expect(await cancelUnpaidBooking(booking.requestId, "Cancelled before payment")).toBe(false);
    expect((await requestRow(booking.requestId)).status).toBe("scheduled");
    expect((await paymentRow(booking.reference)).status).toBe("paid");
    // And the cancel the booker sees is a clear refusal.
    const del = await request(app).delete(`/api/bookings/${booking.requestId}`).set(as("player"));
    expect(del.status).toBe(409);
    expect((await requestRow(booking.requestId)).status).toBe("scheduled");
  });

  it("cancelled between the admin's read and his activation: no camera job starts", async () => {
    const booking = await cliqBooking(4);
    expect(await cancelUnpaidBooking(booking.requestId, "Cancelled before payment")).toBe(true);
    expect(await activatePaidBooking(booking.requestId)).toEqual({ status: "cancelled" });
    expect(cameraPosts()).toHaveLength(0);
  });

  it("at the same moment: either cancelled and unpaid, or recording and paid, never both", async () => {
    for (let i = 0; i < 4; i += 1) {
      camera.calls.length = 0;
      const booking = await cliqBooking(5 + i);
      const [del, confirm] = await Promise.all([
        request(app).delete(`/api/bookings/${booking.requestId}`).set(as("player")),
        request(app).post(`/api/admin/stat-unlocks/${booking.paymentId}/confirm`).set(as("admin")),
      ]);
      const stored = await requestRow(booking.requestId);
      const payment = await paymentRow(booking.reference);
      if (stored.status === "cancelled") {
        expect(del.status).toBe(204);
        expect(confirm.status).toBe(409);
        expect(payment.status).not.toBe("paid");
        // A job that was started is stopped again.
        expect(cameraDeletes().length).toBe(cameraPosts().length);
      } else {
        expect(stored.status).toBe("scheduled");
        expect(confirm.status).toBe(200);
        expect(del.status).toBe(409);
        expect(payment.status).toBe("paid");
      }
    }
  });
});

describe("one slot, booked at the same moment", () => {
  it("only one booking wins, and only its free match is spent", async () => {
    const who = ["player", "p2", "p3", "p4"];
    const rewards = await Promise.all(who.map((w) => giveReward(w)));
    const results = await Promise.all(who.map((w) =>
      request(app).post("/api/bookings").set(as(w)).send({ ...slot(12, 16, 120), useFreeMatch: true })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const rows = await db.select().from(footageRequestsTable).where(and(
      eq(footageRequestsTable.fieldId, fieldId), eq(footageRequestsTable.startLocal, slot(12, 16).startLocal),
      inArray(footageRequestsTable.status, ["awaiting_payment", "queued", "scheduled"]),
    ));
    expect(rows).toHaveLength(1);
    const used = (await db.select().from(freeMatchRewardsTable).where(inArray(freeMatchRewardsTable.id, rewards.map((r) => r.id))))
      .filter((r) => r.status === "used");
    expect(used).toHaveLength(1);
  });
});

describe("the field owner and the academy's bookings", () => {
  it("names the academy when its session holds the slot, and nothing more", async () => {
    const s = slot(3, 14, 60);
    await db.insert(footageRequestsTable).values({
      fieldId, academyId, cameraId: `cam-${TAG}`, requestedBy: users.admin, startLocal: s.startLocal, endLocal: s.endLocal,
      requestedSeconds: 3600, status: "scheduled", vpsJobId: "academy-job",
    });
    const clash = await request(app).post(`/api/owner/fields/${fieldId}/requests`).set(as("owner"))
      .send({ startLocal: s.startLocal, endLocal: s.endLocal });
    expect(clash.status).toBe(400);
    expect(clash.body).toEqual({ error: "The academy has this slot booked" });
    // The academy session still isn't in the owner's list.
    const list = await request(app).get(`/api/owner/fields/${fieldId}/requests`).set(as("owner"));
    expect(list.body.some((r: { startLocal: string }) => r.startLocal === s.startLocal)).toBe(false);

    // His own booking clashing reads as before.
    const own = slot(4, 14, 60);
    expect((await request(app).post(`/api/owner/fields/${fieldId}/requests`).set(as("owner")).send(own)).status).toBe(201);
    const again = await request(app).post(`/api/owner/fields/${fieldId}/requests`).set(as("owner")).send(own);
    expect(again.body).toEqual({ error: "You already booked footage for this time" });
  });
});

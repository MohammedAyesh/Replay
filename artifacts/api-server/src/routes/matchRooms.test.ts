import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  footageRequestsTable,
  matchPlayersTable,
  matchRoomsTable,
  settingsRulesTable,
  statUnlocksTable,
  userClipsTable,
  usersTable,
  varMarksTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { invalidateSettingsCache } from "../lib/settings";

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

import matchRoomsRouter from "./matchRooms";
import ownerRouter from "./owner";
import {
  ammanLocalInstant,
  ensureRoomForRequest,
  matchPhase,
  normalizePhone,
  voteOpen,
} from "../lib/matchRooms";

const TAG = `mr_${Date.now()}`;
let app: Express;
const users: Record<string, number> = {};
let fieldId: number;
const requestIds: number[] = [];

function localString(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function booking(startMs: number, minutes: number, status = "scheduled") {
  const minute = 60 * 1000;
  const start = Math.floor(startMs / minute) * minute;
  const [row] = await db.insert(footageRequestsTable).values({
    fieldId,
    cameraId: `cam-${TAG}`,
    requestedBy: users.owner,
    startLocal: localString(start),
    endLocal: localString(start + minutes * minute),
    requestedSeconds: minutes * 60,
    status,
  }).returning();
  requestIds.push(row.id);
  const room = await ensureRoomForRequest(row);
  return { request: row, room };
}

const as = (who: string) => ({ "x-test-user": String(users[who]) });

/** A settings rule scoped to this test's field, so it cannot leak into other suites. */
async function fieldRule(key: string, value: number | boolean | string) {
  await db.insert(settingsRulesTable).values({ key, value, priority: 100, scopeType: "field", scopeId: fieldId });
  invalidateSettingsCache();
}
async function clearFieldRules() {
  await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.scopeType, "field"), eq(settingsRulesTable.scopeId, fieldId)));
  invalidateSettingsCache();
}

beforeAll(async () => {
  process.env.PUBLIC_SHARE_BASE_URL = "https://replay.example.test";
  process.env.CONTABO_CONTROL_URL = "https://control.example.test";
  process.env.CONTABO_CONTROL_KEY = "test-key";
  app = express();
  app.use(express.json());
  app.use("/api", matchRoomsRouter);
  app.use("/api", ownerRouter);

  for (const [key, extra] of Object.entries({
    owner: {},
    ali: { phone: "0791234567" },
    omar: {},
    sami: {},
    outsider: {},
    admin: { isAdmin: true },
  } as Record<string, Partial<typeof usersTable.$inferInsert>>)) {
    const [u] = await db.insert(usersTable).values({
      name: `${key} ${TAG}`,
      email: `${TAG}_${key}@test.local`,
      profileComplete: true,
      ...extra,
    }).returning({ id: usersTable.id });
    users[key] = u.id;
  }
  const [field] = await db.insert(fieldsTable).values({
    name: `Match Field ${TAG}`, location: "Test", cameraId: `cam-${TAG}`,
  }).returning({ id: fieldsTable.id });
  fieldId = field.id;
  await db.insert(fieldOwnersTable).values({ userId: users.owner, fieldId });
});

afterAll(async () => {
  await clearFieldRules();
  if (requestIds.length) {
    await db.delete(varMarksTable).where(inArray(varMarksTable.footageRequestId, requestIds));
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  }
  await db.delete(fieldOwnersTable).where(eq(fieldOwnersTable.fieldId, fieldId));
  await db.delete(fieldsTable).where(eq(fieldsTable.id, fieldId));
  const ids = Object.values(users);
  await db.delete(statUnlocksTable).where(inArray(statUnlocksTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

describe("match room helpers", () => {
  it("reads Amman local time as UTC+3", () => {
    expect(new Date(ammanLocalInstant("2026-09-23 20:00")).toISOString()).toBe("2026-09-23T17:00:00.000Z");
    expect(Number.isNaN(ammanLocalInstant("nonsense"))).toBe(true);
  });

  it("normalizes Jordanian phone spellings to one form", () => {
    expect(normalizePhone("079 123 4567")).toBe("+962791234567");
    expect(normalizePhone("00962791234567")).toBe("+962791234567");
    expect(normalizePhone("+962791234567")).toBe("+962791234567");
  });

  it("walks through the match phases", () => {
    const base = { startLocal: "2026-09-23 20:00", endLocal: "2026-09-23 21:00", readyAt: null, shareRevoked: false, shareExpiresAt: null };
    const kickoff = ammanLocalInstant(base.startLocal);
    const whistle = ammanLocalInstant(base.endLocal);
    expect(matchPhase({ ...base, status: "scheduled" }, kickoff - 60 * 60 * 1000)).toBe("pre");
    expect(matchPhase({ ...base, status: "scheduled" }, kickoff - 2 * 60 * 1000)).toBe("live");
    expect(matchPhase({ ...base, status: "recording" }, whistle + 4 * 60 * 1000)).toBe("live");
    expect(matchPhase({ ...base, status: "running" }, whistle + 6 * 60 * 1000)).toBe("processing");
    expect(matchPhase({ ...base, status: "ready", readyAt: new Date(whistle) }, whistle + 60 * 60 * 1000)).toBe("ready");
    expect(matchPhase({ ...base, status: "ready", readyAt: new Date(whistle) }, whistle + 15 * 24 * 60 * 60 * 1000)).toBe("expired");
    expect(matchPhase({ ...base, status: "cancelled" }, kickoff)).toBe("cancelled");
    expect(voteOpen({ ...base, status: "ready" }, whistle + 23 * 60 * 60 * 1000)).toBe(true);
    expect(voteOpen({ ...base, status: "ready" }, whistle + 25 * 60 * 60 * 1000)).toBe(false);
  });

  it("gives each booking exactly one room, even when asked twice at once", async () => {
    const { request: req } = await booking(Date.now() + 3 * 24 * 60 * 60 * 1000, 60);
    const [a, b] = await Promise.all([ensureRoomForRequest(req), ensureRoomForRequest(req)]);
    expect(a.id).toBe(b.id);
    expect(a.code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
  });
});

describe("a match from invite to vote", () => {
  it("RSVP, invites, captaincy, teams and privacy", async () => {
    const { request: req, room } = await booking(Date.now() + 2 * 24 * 60 * 60 * 1000, 60);

    // Anyone with the link sees the match, but not the VAR id or the footage link.
    const anon = await request(app).get(`/api/m/${room.code.toLowerCase()}`);
    expect(anon.status).toBe(200);
    expect(anon.body.phase).toBe("pre");
    expect(anon.body.var.requestId).toBeNull();
    expect(anon.body.captainUrl).toBeNull();
    expect(anon.body.counts.needed).toBe(12);

    // The owner sees the captain link.
    const owner = await request(app).get(`/api/m/${room.code}`).set(as("owner"));
    expect(owner.body.isOwner).toBe(true);
    expect(owner.body.captainUrl).toContain(`?c=${room.captainToken}`);

    // Signing in is required to join.
    expect((await request(app).post(`/api/m/${room.code}/join`).send({ rsvp: "in" })).status).toBe(401);

    // Omar uses the captain link and becomes captain.
    const omar = await request(app).post(`/api/m/${room.code}/join`).set(as("omar"))
      .send({ rsvp: "in", captainToken: room.captainToken, shirtNumber: 10 });
    expect(omar.status).toBe(200);
    expect(omar.body.isCaptain).toBe(true);
    expect(omar.body.me.shirtNumber).toBe(10);
    expect(omar.body.var.requestId).toBe(req.id);
    const omarPlayerId = omar.body.me.id as number;

    // Omar invites Ali by phone (07… spelling); Ali's account matches the +962 form and is linked.
    const invite = await request(app).post(`/api/m/${room.code}/players`).set(as("omar"))
      .send({ displayName: "Ali", phone: "+962 79 123 4567" });
    expect(invite.status).toBe(201);
    expect(invite.body.inviteUrl).toMatch(/\/m\/[A-Z0-9]+\?i=/);
    const dup = await request(app).post(`/api/m/${room.code}/players`).set(as("omar"))
      .send({ displayName: "Ali again", phone: "0791234567" });
    expect(dup.status).toBe(409);

    // Ali sees the invite on his matches list and says he's in.
    const aliMatches = await request(app).get("/api/me/matches").set(as("ali"));
    expect(aliMatches.status).toBe(200);
    expect(aliMatches.body.upcoming.map((m: { code: string }) => m.code)).toContain(room.code);
    const ali = await request(app).post(`/api/m/${room.code}/join`).set(as("ali")).send({ rsvp: "in" });
    expect(ali.body.me.rsvp).toBe("in");
    expect(ali.body.me.invitedBy?.id).toBe(omarPlayerId);
    expect(ali.body.isCaptain).toBe(false);

    // A placeholder invite for someone without an account, claimed by Sami via the personal link.
    const placeholder = await request(app).post(`/api/m/${room.code}/players`).set(as("omar"))
      .send({ displayName: "Cousin" });
    const token = new URL(placeholder.body.inviteUrl).searchParams.get("i");
    const preview = await request(app).get(`/api/m/${room.code}?i=${token}`);
    expect(preview.body.personalInvite?.name).toBe("Cousin");
    expect(preview.body.invitedBy?.playerId).toBe(omarPlayerId);
    const sami = await request(app).post(`/api/m/${room.code}/join`).set(as("sami"))
      .send({ rsvp: "maybe", inviteToken: token });
    expect(sami.body.me.id).toBe(placeholder.body.id);
    expect(sami.body.isMember).toBe(false); // "maybe" isn't on the roster yet

    // Only managers may change the room or other players.
    expect((await request(app).patch(`/api/m/${room.code}`).set(as("ali")).send({ title: "x" })).status).toBe(403);
    const renamed = await request(app).patch(`/api/m/${room.code}`).set(as("omar"))
      .send({ title: "Thursday 6s", teamAName: "Lions" });
    expect(renamed.body.title).toBe("Thursday 6s");
    expect((await request(app).patch(`/api/m/${room.code}/players/${omarPlayerId}`).set(as("ali")).send({ team: "B" })).status).toBe(403);

    // Auto teams split in-and-maybe players across both sides with pitch slots.
    const teams = await request(app).post(`/api/m/${room.code}/teams/auto`).set(as("omar")).send({});
    const placed = teams.body.players.filter((p: { team: string | null }) => p.team);
    expect(placed.length).toBe(3);
    expect(new Set(placed.map((p: { team: string }) => p.team))).toEqual(new Set(["A", "B"]));
    expect(placed.every((p: { slotX: number; slotY: number }) => p.slotX >= 0 && p.slotY <= 100)).toBe(true);

    // The outsider can read the page but not join VAR, flag, or vote.
    const outsiderVar = await request(app).get(`/api/owner/requests/${req.id}/var-marks`).set(as("outsider"));
    expect(outsiderVar.status).toBe(403);
    const aliVar = await request(app).get(`/api/owner/requests/${req.id}/var-marks`).set(as("ali"));
    expect(aliVar.status).toBe(200);
    const samiVar = await request(app).get(`/api/owner/requests/${req.id}/var-marks`).set(as("sami"));
    expect(samiVar.status).toBe(403);

    // Flags are refused before the match opens.
    const early = await request(app).post(`/api/m/${room.code}/flags`).set(as("ali")).send({ kind: "goal" });
    expect(early.status).toBe(409);

    // Leaving takes you off the lineup.
    const out = await request(app).post(`/api/m/${room.code}/join`).set(as("ali")).send({ rsvp: "out" });
    expect(out.body.me.team).toBeNull();
    expect(out.body.me.rsvp).toBe("out");
    expect((await request(app).get(`/api/owner/requests/${req.id}/var-marks`).set(as("ali"))).status).toBe(403);
  });

  it("flags during the match, then score, games and the vote", async () => {
    const { request: req, room } = await booking(Date.now() - 50 * 60 * 1000, 60, "recording");
    await request(app).post(`/api/m/${room.code}/join`).set(as("omar")).send({ rsvp: "in" });
    await request(app).post(`/api/m/${room.code}/join`).set(as("ali")).send({ rsvp: "in" });
    await request(app).post(`/api/m/${room.code}/join`).set(as("sami")).send({ rsvp: "in" });

    const page = await request(app).get(`/api/m/${room.code}`).set(as("ali"));
    expect(page.body.phase).toBe("live");
    expect(page.body.var.active).toBe(true);
    expect(page.body.isCaptain).toBe(false); // omar joined first and took the armband
    expect((await request(app).get(`/api/m/${room.code}`).set(as("omar"))).body.isCaptain).toBe(true);

    const flag = await request(app).post(`/api/m/${room.code}/flags`).set(as("ali")).send({ kind: "goal", note: "top bins" });
    expect(flag.status).toBe(201);
    expect(flag.body.offsetSeconds).toBeGreaterThan(40 * 60);
    const outsiderFlag = await request(app).post(`/api/m/${room.code}/flags`).set(as("outsider")).send({ kind: "foul" });
    expect(outsiderFlag.status).toBe(403);
    const marks = (await request(app).get(`/api/m/${room.code}`).set(as("sami"))).body.marks;
    expect(marks).toHaveLength(1);
    expect(marks[0].mine).toBe(false);
    expect((await request(app).get(`/api/m/${room.code}`)).body.marks).toHaveLength(0);

    // Games must not overlap; scored games set the match score as games won.
    const bad = await request(app).put(`/api/m/${room.code}/games`).set(as("omar"))
      .send({ games: [{ startOffsetSec: 0, endOffsetSec: 900 }, { startOffsetSec: 800, endOffsetSec: 1500 }] });
    expect(bad.status).toBe(400);
    const games = await request(app).put(`/api/m/${room.code}/games`).set(as("omar")).send({ games: [
      { startOffsetSec: 0, endOffsetSec: 900, scoreA: 2, scoreB: 1 },
      { startOffsetSec: 960, endOffsetSec: 1800, scoreA: 0, scoreB: 3 },
      { startOffsetSec: 1860, endOffsetSec: 3000, scoreA: 4, scoreB: 2 },
    ] });
    expect(games.status).toBe(200);
    expect(games.body.games).toHaveLength(3);
    expect(games.body.score).toEqual({ a: 2, b: 1 });

    // Vote: opens 10 min before the whistle. No self votes, one vote per player, changeable.
    const roster = games.body.players as Array<{ id: number; userId: number }>;
    const aliPlayer = roster.find((p) => p.userId === users.ali)!;
    const samiPlayer = roster.find((p) => p.userId === users.sami)!;
    const self = await request(app).post(`/api/m/${room.code}/vote`).set(as("ali")).send({ candidatePlayerId: aliPlayer.id });
    expect(self.status).toBe(400);
    const v1 = await request(app).post(`/api/m/${room.code}/vote`).set(as("ali")).send({ candidatePlayerId: samiPlayer.id });
    expect(v1.status).toBe(200);
    expect(v1.body.vote.myVote).toBe(samiPlayer.id);
    await request(app).post(`/api/m/${room.code}/vote`).set(as("omar")).send({ candidatePlayerId: samiPlayer.id });
    const v2 = await request(app).post(`/api/m/${room.code}/vote`).set(as("omar")).send({ candidatePlayerId: aliPlayer.id });
    expect(v2.body.vote.votesCast).toBe(2);
    expect((await request(app).post(`/api/m/${room.code}/vote`).set(as("outsider")).send({ candidatePlayerId: samiPlayer.id })).status).toBe(403);

    // The story renderer's context for a clip cut from this match.
    await request(app).post(`/api/m/${room.code}/teams/auto`).set(as("omar")).send({});
    await request(app).patch(`/api/m/${room.code}/players/${aliPlayer.id}`).set(as("ali")).send({ shirtNumber: 9 });
    const [clip] = await db.insert(userClipsTable).values({
      userId: users.ali, videoId: `vid-${TAG}`, title: "Top bins", startTime: "10", endTime: "20",
      footageRequestId: req.id, visibility: "match",
    }).returning();
    const story = await request(app).get(`/api/user-clips/${clip.id}/story-context`).set(as("ali"));
    expect(story.status).toBe(200);
    expect(story.body.shirtNumber).toBe(9);
    expect(story.body.match.code).toBe(room.code);
    expect(story.body.match.teamColor).toMatch(/^#/);
    expect((await request(app).get(`/api/user-clips/${clip.id}/story-context`).set(as("omar"))).status).toBe(404);
    const matchClips = await request(app).get(`/api/m/${room.code}/clips`).set(as("sami"));
    expect(matchClips.body.map((c: { id: number }) => c.id)).toContain(clip.id);
    expect((await request(app).get(`/api/m/${room.code}/clips`)).body).toHaveLength(0);
    await db.delete(userClipsTable).where(eq(userClipsTable.id, clip.id));

    // Calendar file.
    const ics = await request(app).get(`/api/m/${room.code}/calendar.ics`);
    expect(ics.status).toBe(200);
    expect(ics.text).toContain("BEGIN:VEVENT");
    expect(req.id).toBeGreaterThan(0);
  });

  it("stats unlocks go pending, then an admin confirms them", async () => {
    const { room } = await booking(Date.now() - 3 * 60 * 60 * 1000, 60, "ready");
    await request(app).post(`/api/m/${room.code}/join`).set(as("omar")).send({ rsvp: "in" });
    await request(app).post(`/api/m/${room.code}/join`).set(as("ali")).send({ rsvp: "in" });

    // Stats ship switched off: nothing to buy until an admin turns them on.
    await clearFieldRules();
    const off = await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("ali")).send({ kind: "match" });
    expect(off.status).toBe(409);
    expect((await request(app).get(`/api/m/${room.code}`).set(as("ali"))).body.stats.enabled).toBe(false);
    await fieldRule("stats.enabled", true);
    await fieldRule("stats.paywallEnabled", true); // off by default since 2026-09-26

    expect((await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("outsider")).send({ kind: "match" })).status).toBe(403);
    expect((await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("ali")).send({ kind: "team" })).status).toBe(403);
    const pending = await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("ali")).send({ kind: "match" });
    expect(pending.status).toBe(201);
    expect(pending.body.amountFils).toBe(500);
    expect(pending.body.reference).toMatch(new RegExp(`^RP${room.code}-`));
    const again = await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("ali")).send({ kind: "match" });
    expect(again.body.reference).toBe(pending.body.reference);

    let page = await request(app).get(`/api/m/${room.code}`).set(as("ali"));
    expect(page.body.stats.unlocked).toBe(false);
    expect(page.body.stats.pending.reference).toBe(pending.body.reference);

    expect((await request(app).get("/api/admin/stat-unlocks").set(as("ali"))).status).toBe(403);
    const list = await request(app).get("/api/admin/stat-unlocks").set(as("admin"));
    const row = list.body.find((r: { reference: string }) => r.reference === pending.body.reference);
    expect(row).toBeTruthy();
    const confirmed = await request(app).post(`/api/admin/stat-unlocks/${row.id}/confirm`).set(as("admin"));
    expect(confirmed.status).toBe(200);
    page = await request(app).get(`/api/m/${room.code}`).set(as("ali"));
    expect(page.body.stats.unlocked).toBe(true);
    // Omar didn't pay: still locked for him.
    expect((await request(app).get(`/api/m/${room.code}`).set(as("omar"))).body.stats.unlocked).toBe(false);

    // A captain's team unlock covers the whole match.
    const team = await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("omar")).send({ kind: "team" });
    expect(team.body.amountFils).toBe(500 * 12);
    const teamRow = (await request(app).get("/api/admin/stat-unlocks").set(as("admin"))).body
      .find((r: { reference: string }) => r.reference === team.body.reference);
    await request(app).post(`/api/admin/stat-unlocks/${teamRow.id}/confirm`).set(as("admin"));
    expect((await request(app).get(`/api/m/${room.code}`).set(as("omar"))).body.stats.unlocked).toBe(true);
    await clearFieldRules();
  });

  it("admin settings drive stats prices, the paywall and the booking price", async () => {
    const { room } = await booking(Date.now() - 3 * 60 * 60 * 1000, 60, "ready");
    await request(app).post(`/api/m/${room.code}/join`).set(as("sami")).send({ rsvp: "in" });
    await fieldRule("stats.enabled", true);
    await fieldRule("stats.paywallEnabled", true); // off by default since 2026-09-26
    await fieldRule("pricing.statsPerMatch", 0.75);
    await fieldRule("pricing.statsTeamPerPlayer", 0.25);
    await fieldRule("payments.cliqAlias", "TESTALIAS");
    let page = await request(app).get(`/api/m/${room.code}`).set(as("sami"));
    expect(page.body.stats.prices.matchFils).toBe(750);
    expect(page.body.stats.prices.teamFils).toBe(250 * 12);
    expect(page.body.stats.cliqAlias).toBe("TESTALIAS");
    const unlock = await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("sami")).send({ kind: "match" });
    expect(unlock.body.amountFils).toBe(750);
    expect(unlock.body.cliqAlias).toBe("TESTALIAS");

    // Team pack switched off: the captain can't buy it.
    await fieldRule("stats.teamPackEnabled", false);
    expect((await request(app).post(`/api/m/${room.code}/stats/unlock`).set(as("sami")).send({ kind: "team" })).status).toBe(409);

    // Paywall off: stats are simply open.
    await db.delete(settingsRulesTable).where(and(eq(settingsRulesTable.key, "stats.paywallEnabled"), eq(settingsRulesTable.scopeType, "field"), eq(settingsRulesTable.scopeId, fieldId)));
    await fieldRule("stats.paywallEnabled", false);
    page = await request(app).get(`/api/m/${room.code}`).set(as("sami"));
    expect(page.body.stats.unlocked).toBe(true);
    expect(page.body.stats.paywall).toBe(false);
    await clearFieldRules();
  });

  it("the admin hands the captaincy to another player", async () => {
    const { room } = await booking(Date.now() + 3 * 60 * 60 * 1000, 60);
    await request(app).post(`/api/m/${room.code}/join`).set(as("omar")).send({ rsvp: "in" });
    const joined = await request(app).post(`/api/m/${room.code}/join`).set(as("ali")).send({ rsvp: "in" });
    expect(joined.status).toBeLessThan(300);
    const guest = await request(app).post(`/api/m/${room.code}/players`).set(as("omar")).send({ displayName: "No Account" });
    let page = await request(app).get(`/api/m/${room.code}`).set(as("admin"));
    expect(page.body.captain.userId).toBe(users.omar);
    const aliPlayer = page.body.players.find((p: { userId: number | null }) => p.userId === users.ali);

    expect((await request(app).post(`/api/m/${room.code}/captain`).set(as("ali")).send({ playerId: aliPlayer.id })).status).toBe(403);
    expect((await request(app).post(`/api/m/${room.code}/captain`).set(as("admin")).send({ playerId: guest.body.id })).status).toBe(400);
    const made = await request(app).post(`/api/m/${room.code}/captain`).set(as("admin")).send({ playerId: aliPlayer.id });
    expect(made.status).toBe(200);
    expect(made.body.captain.userId).toBe(users.ali);
    page = await request(app).get(`/api/m/${room.code}`).set(as("ali"));
    expect(page.body.isCaptain).toBe(true);
    // The new captain can pass it on again; the old one no longer can.
    const omarPlayer = page.body.players.find((p: { userId: number | null }) => p.userId === users.omar);
    expect((await request(app).post(`/api/m/${room.code}/captain`).set(as("omar")).send({ playerId: omarPlayer.id })).status).toBe(403);
    expect((await request(app).post(`/api/m/${room.code}/captain`).set(as("ali")).send({ playerId: omarPlayer.id })).status).toBe(200);
  });

  it("three teams: split, rotate games, and a table", async () => {
    const { room } = await booking(Date.now() - 50 * 60 * 1000, 60, "recording");
    for (const who of ["omar", "ali", "sami", "outsider"]) {
      await request(app).post(`/api/m/${room.code}/join`).set(as(who)).send({ rsvp: "in" });
    }
    await request(app).post(`/api/m/${room.code}/players`).set(as("omar")).send({ displayName: "Fifth" });
    let page = await request(app).get(`/api/m/${room.code}`).set(as("omar"));
    const fifth = page.body.players.find((p: { name: string }) => p.name === "Fifth");
    await request(app).patch(`/api/m/${room.code}/players/${fifth.id}`).set(as("omar")).send({ rsvp: "in" });

    // Team C is refused until the match has three teams.
    expect((await request(app).patch(`/api/m/${room.code}/players/${fifth.id}`).set(as("omar")).send({ team: "C" })).status).toBe(400);
    const three = await request(app).patch(`/api/m/${room.code}`).set(as("omar")).send({ teamCount: 3, teamCName: "Reds", playersPerSide: 5 });
    expect(three.status).toBe(200);
    expect(three.body.teamCount).toBe(3);
    expect(three.body.teams.C.name).toBe("Reds");
    expect(three.body.counts.needed).toBe(15);

    const auto = await request(app).post(`/api/m/${room.code}/teams/auto`).set(as("omar")).send({});
    const sides = auto.body.players.filter((p: { rsvp: string }) => p.rsvp === "in").map((p: { team: string }) => p.team);
    expect(new Set(sides)).toEqual(new Set(["A", "B", "C"]));
    const benchC = auto.body.players.filter((p: { team: string }) => p.team === "C");
    expect(benchC.every((p: { slotX: number | null }) => p.slotX === null)).toBe(true);

    // A game between a team and itself is refused.
    expect((await request(app).put(`/api/m/${room.code}/games`).set(as("omar"))
      .send({ games: [{ startOffsetSec: 0, endOffsetSec: 600, teamX: "A", teamY: "A" }] })).status).toBe(400);
    // Winner stays on: A beats B, A draws C, C beats B.
    const games = await request(app).put(`/api/m/${room.code}/games`).set(as("omar")).send({ games: [
      { startOffsetSec: 0, endOffsetSec: 600, teamX: "A", teamY: "B", scoreA: 2, scoreB: 0 },
      { startOffsetSec: 600, endOffsetSec: 1200, teamX: "A", teamY: "C", scoreA: 1, scoreB: 1 },
      { startOffsetSec: 1200, endOffsetSec: 1800, teamX: "C", teamY: "B", scoreA: 3, scoreB: 1 },
    ] });
    expect(games.status).toBe(200);
    expect(games.body.score).toBeNull();
    expect(games.body.games[2]).toMatchObject({ teamX: "C", teamY: "B" });
    const table = games.body.standings as Array<{ team: string; points: number; played: number }>;
    expect(table.map((r) => r.team)).toEqual(["C", "A", "B"]);
    expect(table.map((r) => r.points)).toEqual([4, 4, 0]);
    expect(games.body.leader).toBe("C");

    // Back to two teams: team C's players go to the bench and its games go.
    const two = await request(app).patch(`/api/m/${room.code}`).set(as("omar")).send({ teamCount: 2 });
    expect(two.body.teamCount).toBe(2);
    expect(two.body.teams.C).toBeUndefined();
    expect(two.body.players.some((p: { team: string | null }) => p.team === "C")).toBe(false);
    expect(two.body.games).toHaveLength(1);
    expect(two.body.standings).toBeNull();
  });

  it("owner bookings carry their match link", async () => {
    const { request: req, room } = await booking(Date.now() + 5 * 24 * 60 * 60 * 1000, 60);
    // The owner sees the booking on My matches before any player has joined; a stranger doesn't.
    const ownerMatches = await request(app).get("/api/me/matches").set(as("owner"));
    const upcoming = ownerMatches.body.upcoming.find((m: { code: string }) => m.code === room.code);
    expect(upcoming?.isOwner).toBe(true);
    const adminMatches = await request(app).get("/api/me/matches").set(as("admin"));
    expect(adminMatches.body.upcoming.some((m: { code: string }) => m.code === room.code)).toBe(true);
    const outsiderMatches = await request(app).get("/api/me/matches").set(as("outsider"));
    expect(outsiderMatches.body.upcoming.some((m: { code: string }) => m.code === room.code)).toBe(false);
    const list = await request(app).get(`/api/owner/fields/${fieldId}/requests`).set(as("owner"));
    expect(list.status).toBe(200);
    const items = Array.isArray(list.body) ? list.body : list.body.requests ?? list.body.items;
    const mine = items.find((r: { id: number }) => r.id === req.id);
    expect(mine.match.code).toBe(room.code);
    expect(mine.match.captainUrl).toContain(room.captainToken);
    const [stored] = await db.select().from(matchRoomsTable).where(eq(matchRoomsTable.id, room.id));
    expect(stored.footageRequestId).toBe(req.id);
    const players = await db.select().from(matchPlayersTable).where(eq(matchPlayersTable.matchId, room.id));
    expect(players).toHaveLength(0);
  });
});

describe("players book a future recording and pay by CliQ", () => {
  it("books, holds the slot, waits for payment, then an admin confirm starts the camera job", async () => {
    const realFetch = globalThis.fetch;
    const recordCalls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://control.example.test")) {
        recordCalls.push(url);
        return new Response(JSON.stringify({ jobId: "job-test-1", status: "scheduled" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });
    try {
      const minute = 60 * 1000;
      const quarter = 15 * minute;
      const startMs = Math.ceil((Date.now() + 2 * 24 * 60 * minute) / quarter) * quarter;
      const startLocal = localString(startMs);
      const endLocal = localString(startMs + 90 * minute);

      const fields = await request(app).get("/api/bookings/fields");
      expect(fields.body.fields.some((f: { id: number }) => f.id === fieldId)).toBe(true);
      expect(fields.body.pricePerHourFils).toBe(2000);

      expect((await request(app).post("/api/bookings").send({ fieldId, startLocal, endLocal })).status).toBe(401);
      const booked = await request(app).post("/api/bookings").set(as("sami")).send({ fieldId, startLocal, endLocal, title: "Thursday 5s" });
      expect(booked.status).toBe(201);
      expect(booked.body.amountFils).toBe(4000); // 90 minutes = 2 started hours × 2 JOD
      expect(booked.body.reference).toMatch(new RegExp(`^RB${booked.body.code}-`));
      requestIds.push(booked.body.requestId);

      // The slot is held: nobody else can take it, and it shows as taken.
      const clash = await request(app).post("/api/bookings").set(as("omar")).send({ fieldId, startLocal, endLocal });
      expect(clash.status).toBe(409);
      const taken = await request(app).get(`/api/bookings/taken?fieldId=${fieldId}&date=${startLocal.slice(0, 10)}`);
      expect(taken.body.taken.some((t: { startLocal: string }) => t.startLocal === startLocal)).toBe(true);

      // The booker is captain and sees the payment on the match page; no camera call yet.
      const page = await request(app).get(`/api/m/${booked.body.code}`).set(as("sami"));
      expect(page.body.phase).toBe("pre");
      expect(page.body.isCaptain).toBe(true);
      expect(page.body.title).toBe("Thursday 5s");
      expect(page.body.booking.status).toBe("pending");
      expect(page.body.booking.mine).toBe(true);
      expect(page.body.var.active).toBe(false);
      expect(recordCalls).toHaveLength(0);
      // Paying for a booking does not unlock stats.
      expect(page.body.stats.unlocked).toBe(false);
      expect(page.body.stats.pending).toBeNull();

      // Past windows and too-short windows are refused.
      expect((await request(app).post("/api/bookings").set(as("sami")).send({
        fieldId, startLocal: localString(Math.floor((Date.now() - 3 * 60 * minute) / quarter) * quarter),
        endLocal: localString(Math.floor((Date.now() - 2 * 60 * minute) / quarter) * quarter),
      })).status).toBe(400);

      // Admin confirms the CliQ transfer: the camera job starts and the booking is scheduled.
      const list = await request(app).get("/api/admin/stat-unlocks").set(as("admin"));
      const row = list.body.find((r: { reference: string }) => r.reference === booked.body.reference);
      expect(row.kind).toBe("booking");
      const confirm = await request(app).post(`/api/admin/stat-unlocks/${row.id}/confirm`).set(as("admin"));
      expect(confirm.status).toBe(200);
      expect(confirm.body.booking.status).toBe("scheduled");
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0]).toContain("/record-hq/");
      const [stored] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, booked.body.requestId));
      expect(stored.status).toBe("scheduled");
      expect(stored.vpsJobId).toBe("job-test-1");
      expect(stored.rateFils).toBe(0); // the field owner is never billed for a player booking

      // A second booking that is never paid: the booker cancels it and the slot frees up.
      const second = await request(app).post("/api/bookings").set(as("omar")).send({
        fieldId, startLocal: localString(startMs + 3 * 60 * minute), endLocal: localString(startMs + 4 * 60 * minute),
      });
      expect(second.status).toBe(201);
      requestIds.push(second.body.requestId);
      expect(second.body.amountFils).toBe(2000);
      expect((await request(app).delete(`/api/bookings/${second.body.requestId}`).set(as("sami"))).status).toBe(404);
      expect((await request(app).delete(`/api/bookings/${second.body.requestId}`).set(as("omar"))).status).toBe(204);
      const again = await request(app).post("/api/bookings").set(as("ali")).send({
        fieldId, startLocal: localString(startMs + 3 * 60 * minute), endLocal: localString(startMs + 4 * 60 * minute),
      });
      expect(again.status).toBe(201);
      requestIds.push(again.body.requestId);
      // An admin rejecting the payment cancels the booking.
      const rejRow = (await request(app).get("/api/admin/stat-unlocks").set(as("admin"))).body
        .find((r: { reference: string }) => r.reference === again.body.reference);
      await request(app).post(`/api/admin/stat-unlocks/${rejRow.id}/reject`).set(as("admin"));
      const [rejected] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, again.body.requestId));
      expect(rejected.status).toBe("cancelled");
    } finally {
      spy.mockRestore();
    }
  });

  it("pay at the field: recording locks in at once, the field marks the cash received", async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://control.example.test")) {
        calls.push({ url, method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ jobId: `job-field-${calls.length}`, status: "scheduled" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });
    try {
      const minute = 60 * 1000;
      const quarter = 15 * minute;
      const startMs = Math.ceil((Date.now() + 5 * 24 * 60 * minute) / quarter) * quarter;
      const fields = await request(app).get("/api/bookings/fields");
      expect(fields.body.payAtField).toBe(true);

      const booked = await request(app).post("/api/bookings").set(as("ali")).send({
        fieldId, startLocal: localString(startMs), endLocal: localString(startMs + 60 * minute), payWith: "field",
      });
      expect(booked.status).toBe(201);
      requestIds.push(booked.body.requestId);
      expect(booked.body.method).toBe("field");
      expect(booked.body.status).toBe("scheduled");
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1); // camera job started without waiting

      let page = await request(app).get(`/api/m/${booked.body.code}`).set(as("ali"));
      expect(page.body.booking).toMatchObject({ status: "pending", method: "field", mine: true });

      // Players can't mark their own cash received; the field owner can.
      expect((await request(app).post(`/api/m/${booked.body.code}/booking/collect`).set(as("ali")).send({})).status).toBe(403);
      const admin = (await request(app).get("/api/admin/stat-unlocks").set(as("admin"))).body
        .find((r: { reference: string }) => r.reference === booked.body.reference);
      expect(admin.method).toBe("field");
      page = await request(app).post(`/api/m/${booked.body.code}/booking/collect`).set(as("owner")).send({});
      expect(page.status).toBe(200);
      expect(page.body.booking.status).toBe("paid");

      // Switching a CliQ booking to pay-at-field locks it in too.
      const cliq = await request(app).post("/api/bookings").set(as("ali")).send({
        fieldId, startLocal: localString(startMs + 2 * 60 * minute), endLocal: localString(startMs + 3 * 60 * minute),
      });
      requestIds.push(cliq.body.requestId);
      expect(cliq.body.method).toBe("cliq");
      const switched = await request(app).post(`/api/bookings/${cliq.body.requestId}/pay-with`).set(as("ali")).send({ method: "field" });
      expect(switched.status).toBe(200);
      expect(switched.body.status).toBe("scheduled");

      // An uncollected pay-at-field booking can still be cancelled before kick-off: the camera job is stopped.
      const del = await request(app).delete(`/api/bookings/${cliq.body.requestId}`).set(as("ali"));
      expect(del.status).toBe(204);
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/record-hq/"))).toBe(true);
      const [gone] = await db.select().from(footageRequestsTable).where(eq(footageRequestsTable.id, cliq.body.requestId));
      expect(gone.status).toBe("cancelled");

      // The switch is refused when the admin has turned pay-at-field off.
      await fieldRule("booking.payAtFieldEnabled", false);
      const off = await request(app).post("/api/bookings").set(as("ali")).send({
        fieldId, startLocal: localString(startMs + 5 * 60 * minute), endLocal: localString(startMs + 6 * 60 * minute), payWith: "field",
      });
      expect(off.status).toBe(400);
      await clearFieldRules();
    } finally {
      spy.mockRestore();
    }
  });
});


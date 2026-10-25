import { and, desc, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import {
  db,
  claimMatchIdentityBindingsTable,
  claimMatchProgressTable,
  fieldsTable,
  footageRequestsTable,
  freeMatchRewardsTable,
  matchPlayersTable,
  matchRoomsTable,
  statUnlocksTable,
  usersTable,
  type FreeMatchReward,
} from "@workspace/db";
import { loadCommerce, type Commerce } from "./commerce";
import { recordingsForRoom } from "./matchFeed";
import {
  AMMAN_UTC_OFFSET_MS,
  FOOTAGE_RETENTION_MS,
  ammanLocalInstant,
  avatarUrlFor,
  matchPhase,
  type MatchPhase,
  type RoomContext,
} from "./matchRooms";

/**
 * The free-match challenge.
 *
 * A player books a match and pays by CliQ (paying at the field does not
 * count). After the whistle he finds himself in the video, and enough other
 * accounts (Admin -> Settings, default 5) find themselves in the same match
 * before the full video is deleted. His next booking is then free for up to a
 * set number of hours (default 2), used within a set number of days (default
 * 30). A player earns at most a set number a month (default 1). A booking
 * that used a free match never counts toward another.
 *
 * Nothing runs in the background: progress is worked out when the player
 * looks (Home, the match page), and the reward row is written the first time
 * the match is seen complete. The unique index on source_match_id makes that
 * safe to race.
 */

export type FreeMatchFriend = { userId: number; name: string; avatarUrl: string | null; found: boolean };

export type FreeMatchAttempt = {
  code: string;
  fieldName: string;
  startMs: number;
  endMs: number;
  phase: MatchPhase;
  /** The CliQ transfer is confirmed. */
  paid: boolean;
  /** Booked with CliQ, transfer not confirmed yet. */
  payPending: boolean;
  /** The recording to find yourself in, once there is one with tracking. */
  findRecordingId: number | null;
  bookerFound: boolean;
  friendsFound: number;
  friends: FreeMatchFriend[];
  /** When the full video is deleted and the attempt lapses. */
  deadline: string | null;
  /** He already earned this month's free match(es); this one can't earn another. */
  capped: boolean;
};

export type FreeMatchRewardView = {
  id: number;
  freeHours: number;
  worthFils: number;
  expiresAt: string;
  sourceCode: string | null;
  thanks: string[];
  /** Set when a booking holds it (waiting for its extra hours to be paid, or already used). */
  usedCode: string | null;
  status: "available" | "used";
};

export type FreeMatchStatus = {
  enabled: boolean;
  friendsRequired: number;
  freeHours: number;
  useWithinDays: number;
  deadlineDays: number;
  pricePerHourFils: number;
  attempt: FreeMatchAttempt | null;
  /** An unused free match he can book with now. */
  reward: FreeMatchRewardView | null;
  /** The most recent one he earned, for the "unlocked" moment on the source match. */
  latestEarned: FreeMatchRewardView | null;
};

const DEAD_STATUSES = ["cancelled", "failed", "rejected"];

/** When this booking's full video is deleted (estimated from the end until it is ready). */
export function attemptDeadlineMs(request: RoomContext["request"]): number | null {
  const end = ammanLocalInstant(request.endLocal);
  const expires = request.shareExpiresAt?.getTime()
    ?? ((request.readyAt?.getTime() ?? end) + FOOTAGE_RETENTION_MS);
  return Number.isFinite(expires) ? expires : null;
}

function ammanMonthStart(now = Date.now()): Date {
  const local = new Date(now + AMMAN_UTC_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - AMMAN_UTC_OFFSET_MS);
}

/** Rooms that already used a free match: they never count toward another. */
async function roomsThatUsedRewards(userId: number): Promise<number[]> {
  const rows = await db.select({ id: freeMatchRewardsTable.usedMatchId }).from(freeMatchRewardsTable)
    .where(and(eq(freeMatchRewardsTable.userId, userId), isNotNull(freeMatchRewardsTable.usedMatchId)));
  return rows.map((row) => row.id).filter((id): id is number => id !== null);
}

/** Accounts (not guests) that finished finding themselves in any of these recordings. */
export async function foundUserIds(recordingIds: number[]): Promise<Set<number>> {
  if (!recordingIds.length) return new Set();
  const rows = await db.selectDistinct({ userId: claimMatchProgressTable.userId })
    .from(claimMatchProgressTable)
    .innerJoin(claimMatchIdentityBindingsTable, and(
      eq(claimMatchIdentityBindingsTable.userId, claimMatchProgressTable.userId),
      eq(claimMatchIdentityBindingsTable.recordingId, claimMatchProgressTable.recordingId),
    ))
    .innerJoin(usersTable, eq(usersTable.id, claimMatchProgressTable.userId))
    .where(and(
      inArray(claimMatchProgressTable.recordingId, recordingIds),
      eq(claimMatchProgressTable.completed, true),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
      eq(usersTable.isGuest, false),
    ));
  return new Set(rows.map((row) => row.userId));
}

/** The booker's CliQ payment for a room, if the booking was a CliQ one. */
async function cliqPayment(matchId: number, userId: number) {
  const [row] = await db.select({ status: statUnlocksTable.status, method: statUnlocksTable.method })
    .from(statUnlocksTable)
    .where(and(
      eq(statUnlocksTable.matchId, matchId),
      eq(statUnlocksTable.userId, userId),
      eq(statUnlocksTable.kind, "booking"),
    ))
    .orderBy(desc(statUnlocksTable.createdAt))
    .limit(1);
  return row ?? null;
}

/** How far one booking has got. `null` when it can't count (not his, not CliQ, or used a free match). */
export async function attemptForRoom(
  ctx: RoomContext,
  bookerId: number,
  commerce: Commerce,
  options: { usedRewardRooms?: number[]; earnedThisMonth?: number } = {},
): Promise<FreeMatchAttempt | null> {
  if (ctx.request.requestedBy !== bookerId || DEAD_STATUSES.includes(ctx.request.status)) return null;
  const usedRooms = options.usedRewardRooms ?? await roomsThatUsedRewards(bookerId);
  if (usedRooms.includes(ctx.room.id)) return null;
  const payment = await cliqPayment(ctx.room.id, bookerId);
  if (!payment || payment.method !== "cliq" || payment.status === "rejected") return null;
  const phase = matchPhase(ctx.request);
  const afterWhistle = ["processing", "ready", "expired"].includes(phase);
  const recordings = afterWhistle ? await recordingsForRoom(ctx).catch(() => []) : [];
  const found = await foundUserIds(recordings.map((r) => r.recordingId));

  const roster = await db.select({
    userId: matchPlayersTable.userId,
    displayName: matchPlayersTable.displayName,
    name: usersTable.name,
    avatarPath: usersTable.avatarPath,
    isGuest: usersTable.isGuest,
  }).from(matchPlayersTable)
    .innerJoin(usersTable, eq(usersTable.id, matchPlayersTable.userId))
    .where(and(eq(matchPlayersTable.matchId, ctx.room.id), inArray(matchPlayersTable.rsvp, ["in", "maybe", "invited"])));
  const people = new Map<number, FreeMatchFriend>();
  for (const row of roster) {
    if (row.userId === null || row.userId === bookerId || row.isGuest) continue;
    people.set(row.userId, {
      userId: row.userId,
      name: (row.displayName || row.name || "").trim(),
      avatarUrl: avatarUrlFor(row.userId, row.avatarPath),
      found: found.has(row.userId),
    });
  }
  // Friends who found themselves without joining the room still count: the video is the proof they played.
  const missing = [...found].filter((id) => id !== bookerId && !people.has(id));
  if (missing.length) {
    const rows = await db.select({ id: usersTable.id, name: usersTable.name, avatarPath: usersTable.avatarPath })
      .from(usersTable).where(inArray(usersTable.id, missing));
    for (const row of rows) people.set(row.id, { userId: row.id, name: (row.name ?? "").trim(), avatarUrl: avatarUrlFor(row.id, row.avatarPath), found: true });
  }
  const friends = [...people.values()].sort((a, b) => Number(b.found) - Number(a.found));
  const deadline = attemptDeadlineMs(ctx.request);
  return {
    code: ctx.room.code,
    fieldName: ctx.field.name,
    startMs: ammanLocalInstant(ctx.request.startLocal),
    endMs: ammanLocalInstant(ctx.request.endLocal),
    phase,
    paid: payment.status === "paid",
    payPending: payment.status === "pending",
    findRecordingId: recordings[0]?.recordingId ?? null,
    bookerFound: found.has(bookerId),
    friendsFound: friends.filter((f) => f.found).length,
    friends,
    deadline: deadline === null ? null : new Date(deadline).toISOString(),
    capped: (options.earnedThisMonth ?? 0) >= commerce.freeMatchPerMonth,
  };
}

function complete(attempt: FreeMatchAttempt, commerce: Commerce): boolean {
  return attempt.paid && attempt.bookerFound && attempt.friendsFound >= commerce.freeMatchFriendsRequired;
}

/** Write the reward the first time a finished attempt is seen. Safe to call repeatedly. */
async function earnReward(userId: number, matchId: number, attempt: FreeMatchAttempt, commerce: Commerce): Promise<void> {
  const now = Date.now();
  await db.insert(freeMatchRewardsTable).values({
    userId,
    sourceMatchId: matchId,
    freeHours: commerce.freeMatchHours,
    worthFils: commerce.freeMatchHours * commerce.playerBookingFilsPerHour,
    friendNames: attempt.friends.filter((f) => f.found).map((f) => f.name.split(/\s+/)[0] ?? "").filter(Boolean),
    expiresAt: new Date(now + commerce.freeMatchUseWithinDays * 24 * 60 * 60 * 1000),
  }).onConflictDoNothing();
}

async function rewardView(row: FreeMatchReward): Promise<FreeMatchRewardView> {
  const codes = await db.select({ id: matchRoomsTable.id, code: matchRoomsTable.code }).from(matchRoomsTable)
    .where(inArray(matchRoomsTable.id, [row.sourceMatchId, ...(row.usedMatchId ? [row.usedMatchId] : [])]));
  const code = (id: number | null) => (id === null ? null : codes.find((c) => c.id === id)?.code ?? null);
  return {
    id: row.id,
    freeHours: row.freeHours,
    worthFils: row.worthFils,
    expiresAt: row.expiresAt.toISOString(),
    sourceCode: code(row.sourceMatchId),
    thanks: row.friendNames,
    usedCode: code(row.usedMatchId),
    status: row.status,
  };
}

/** His unused, unexpired free match, if he has one. */
export async function availableReward(userId: number): Promise<FreeMatchReward | null> {
  const [row] = await db.select().from(freeMatchRewardsTable)
    .where(and(
      eq(freeMatchRewardsTable.userId, userId),
      eq(freeMatchRewardsTable.status, "available"),
      gte(freeMatchRewardsTable.expiresAt, new Date()),
    ))
    .orderBy(freeMatchRewardsTable.expiresAt)
    .limit(1);
  return row ?? null;
}

/** Spend a reward on a booking's room. Returns false if it was already spent (double tap, two tabs). */
export async function spendReward(rewardId: number, userId: number, matchId: number): Promise<boolean> {
  const rows = await db.update(freeMatchRewardsTable)
    .set({ status: "used", usedMatchId: matchId, usedAt: new Date() })
    .where(and(
      eq(freeMatchRewardsTable.id, rewardId),
      eq(freeMatchRewardsTable.userId, userId),
      eq(freeMatchRewardsTable.status, "available"),
    ))
    .returning({ id: freeMatchRewardsTable.id });
  return rows.length > 0;
}

/** A booking that used a free match was cancelled before kick-off: give it back. */
export async function releaseRewardForMatch(matchId: number): Promise<void> {
  await db.update(freeMatchRewardsTable)
    .set({ status: "available", usedMatchId: null, usedAt: null })
    .where(and(eq(freeMatchRewardsTable.usedMatchId, matchId), eq(freeMatchRewardsTable.status, "used")));
}

/** Did this room's booking use a free match? */
export async function rewardUsedByMatch(matchId: number): Promise<FreeMatchReward | null> {
  const [row] = await db.select().from(freeMatchRewardsTable).where(eq(freeMatchRewardsTable.usedMatchId, matchId));
  return row ?? null;
}

async function earnedSince(userId: number, since: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(freeMatchRewardsTable)
    .where(and(eq(freeMatchRewardsTable.userId, userId), gte(freeMatchRewardsTable.earnedAt, since)));
  return row?.n ?? 0;
}

/**
 * Everything Home, the match page and the Book page need. Also writes the
 * reward when the newest attempt has just finished.
 */
export async function freeMatchStatus(userId: number, commerceIn?: Commerce): Promise<FreeMatchStatus> {
  const commerce = commerceIn ?? await loadCommerce({ userId });
  const base = {
    enabled: commerce.freeMatchEnabled,
    friendsRequired: commerce.freeMatchFriendsRequired,
    freeHours: commerce.freeMatchHours,
    useWithinDays: commerce.freeMatchUseWithinDays,
    deadlineDays: Math.round(FOOTAGE_RETENTION_MS / (24 * 60 * 60 * 1000)),
    pricePerHourFils: commerce.playerBookingFilsPerHour,
  };
  const usedRooms = await roomsThatUsedRewards(userId);
  let earnedThisMonth = await earnedSince(userId, ammanMonthStart());
  let attempt: FreeMatchAttempt | null = null;

  if (commerce.freeMatchEnabled) {
    const rewardedRooms = (await db.select({ id: freeMatchRewardsTable.sourceMatchId }).from(freeMatchRewardsTable)
      .where(eq(freeMatchRewardsTable.userId, userId))).map((row) => row.id);
    const excluded = [...usedRooms, ...rewardedRooms];
    // His recent CliQ bookings, newest first. A handful is plenty: only the newest live one is shown.
    const candidates = await db.select({ room: matchRoomsTable, request: footageRequestsTable, field: fieldsTable })
      .from(matchRoomsTable)
      .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
      .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
      .innerJoin(statUnlocksTable, and(
        eq(statUnlocksTable.matchId, matchRoomsTable.id),
        eq(statUnlocksTable.kind, "booking"),
        eq(statUnlocksTable.method, "cliq"),
        inArray(statUnlocksTable.status, ["pending", "paid"]),
      ))
      .where(and(
        eq(footageRequestsTable.requestedBy, userId),
        notInArray(footageRequestsTable.status, DEAD_STATUSES),
        ...(excluded.length ? [notInArray(matchRoomsTable.id, excluded)] : []),
      ))
      .orderBy(desc(footageRequestsTable.startLocal))
      .limit(5);
    const now = Date.now();
    for (const ctx of candidates) {
      const deadline = attemptDeadlineMs(ctx.request);
      if (deadline !== null && deadline < now) continue;
      const next = await attemptForRoom(ctx, userId, commerce, { usedRewardRooms: usedRooms, earnedThisMonth });
      if (!next) continue;
      if (!next.capped && complete(next, commerce)) {
        await earnReward(userId, ctx.room.id, next, commerce);
        earnedThisMonth += 1;
        continue;
      }
      attempt = next;
      break;
    }
  }

  const available = await availableReward(userId);
  const [latest] = await db.select().from(freeMatchRewardsTable)
    .where(eq(freeMatchRewardsTable.userId, userId))
    .orderBy(desc(freeMatchRewardsTable.earnedAt))
    .limit(1);
  return {
    ...base,
    attempt,
    reward: available ? await rewardView(available) : null,
    latestEarned: latest ? await rewardView(latest) : null,
  };
}

import { and, desc, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
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
import { DELETED_PLAYER_EMAIL } from "./accountDeletion";
import { loadCommerce, type Commerce } from "./commerce";
import { recordingsForRoom, type FieldRecordingCache, type LinkedRecording } from "./matchFeed";
import { clipRangeToMatchWindow } from "./matchWindow";
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
 * 30). Each player can earn it once, ever. Friends must be real accounts
 * (not guests, not deleted) who finished finding themselves with the player
 * they picked confirmed as them. A booking that used a free match never
 * counts.
 *
 * Nothing runs in the background: progress is worked out when the player
 * looks (Home, the match page), and the reward row is written the first time
 * a match is seen complete, even if he only looks after its video was
 * deleted (nobody can finish finding themselves after that, so a match that
 * is complete by then was complete in time). Earning takes a per-player
 * advisory lock so two devices can't both earn past the monthly cap, and the
 * unique index on source_match_id stops one match earning twice.
 *
 * A booking that spent a free match and then never recorded (cancelled by
 * anyone, failed, refunded) hands it back; that is reconciled on every read,
 * so no cancel path has to remember to do it.
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
  /** He hasn't had his one free match yet, so a CliQ booking can still earn it. */
  canEarn: boolean;
  attempt: FreeMatchAttempt | null;
  /** An unused free match he can book with now. */
  reward: FreeMatchRewardView | null;
  /** The most recent one he earned, for the "unlocked" moment on the source match. */
  latestEarned: FreeMatchRewardView | null;
};

const DEAD_STATUSES = ["cancelled", "failed", "rejected", "refunded"];
/** A booking older than this can't have anything left to earn or show. */
const LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
/** A recording counts for a booking only when the booking covers at least this share of its match. */
const MIN_RECORDING_SHARE = 0.5;
const EARN_LOCK_NAMESPACE = 7741;

/** When this booking's full video is deleted (estimated from the end until it is ready). */
export function attemptDeadlineMs(request: RoomContext["request"]): number | null {
  const end = ammanLocalInstant(request.endLocal);
  const expires = request.shareExpiresAt?.getTime()
    ?? ((request.readyAt?.getTime() ?? end) + FOOTAGE_RETENTION_MS);
  return Number.isFinite(expires) ? expires : null;
}

/** Each player can earn the free match once, ever. */
const REWARDS_PER_PLAYER = 1;

/** "YYYY-MM-DD HH:MM" in Amman, the format footage requests store. */
function ammanLocalString(ms: number): string {
  const d = new Date(ms + AMMAN_UTC_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The recordings that are this booking's match. A recording that only
 * overlaps it by a few minutes (the previous group's pull running into the
 * slot) is someone else's game: its players don't count here. Best match first.
 */
export function bookingRecordings(recordings: LinkedRecording[]): LinkedRecording[] {
  const scored = recordings.map((recording) => {
    const whole = clipRangeToMatchWindow(0, recording.manifest.duration, recording.manifest);
    const wholeLength = whole ? whole.toSeconds - whole.fromSeconds : recording.manifest.duration;
    const share = wholeLength > 0 ? (recording.toSeconds - recording.fromSeconds) / wholeLength : 0;
    return { recording, share };
  }).sort((a, b) => b.share - a.share);
  const kept = scored.filter((entry) => entry.share >= MIN_RECORDING_SHARE);
  return (kept.length ? kept : scored.slice(0, 1)).map((entry) => entry.recording);
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
      // Finished finding himself, and the player he picked is confirmed as him.
      eq(claimMatchProgressTable.completed, true),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
      // A real account: not a guest, not a deleted one.
      eq(usersTable.isGuest, false),
      ne(usersTable.email, DELETED_PLAYER_EMAIL),
    ));
  return new Set(rows.map((row) => row.userId));
}

type Candidate = RoomContext & { paymentStatus: string };

type Progress = {
  ctx: Candidate;
  phase: MatchPhase;
  afterWhistle: boolean;
  deadlineMs: number | null;
  recordings: LinkedRecording[];
  found: Set<number>;
};

async function progressFor(ctx: Candidate, perField?: FieldRecordingCache): Promise<Progress> {
  const phase = matchPhase(ctx.request);
  const afterWhistle = ["processing", "ready", "expired"].includes(phase);
  const recordings = afterWhistle ? bookingRecordings(await recordingsForRoom(ctx, perField).catch(() => [])) : [];
  const found = await foundUserIds(recordings.map((r) => r.recordingId));
  return { ctx, phase, afterWhistle, deadlineMs: attemptDeadlineMs(ctx.request), recordings, found };
}

function friendsFoundCount(progress: Progress, bookerId: number): number {
  return [...progress.found].filter((id) => id !== bookerId).length;
}

function isComplete(progress: Progress, bookerId: number, commerce: Commerce): boolean {
  return progress.ctx.paymentStatus === "paid"
    && progress.found.has(bookerId)
    && friendsFoundCount(progress, bookerId) >= commerce.freeMatchFriendsRequired;
}

/** The squad list for the attempt he sees: the roster plus anyone who found themselves without joining. */
async function friendsFor(progress: Progress, bookerId: number): Promise<FreeMatchFriend[]> {
  const roster = await db.select({
    userId: matchPlayersTable.userId,
    displayName: matchPlayersTable.displayName,
    name: usersTable.name,
    avatarPath: usersTable.avatarPath,
    isGuest: usersTable.isGuest,
  }).from(matchPlayersTable)
    .innerJoin(usersTable, eq(usersTable.id, matchPlayersTable.userId))
    .where(and(eq(matchPlayersTable.matchId, progress.ctx.room.id), inArray(matchPlayersTable.rsvp, ["in", "maybe", "invited"])));
  const people = new Map<number, FreeMatchFriend>();
  for (const row of roster) {
    if (row.userId === null || row.userId === bookerId || row.isGuest) continue;
    people.set(row.userId, {
      userId: row.userId,
      name: (row.displayName || row.name || "").trim(),
      avatarUrl: avatarUrlFor(row.userId, row.avatarPath),
      found: progress.found.has(row.userId),
    });
  }
  // Friends who found themselves without joining the room still count: the video is the proof they played.
  const missing = [...progress.found].filter((id) => id !== bookerId && !people.has(id));
  if (missing.length) {
    const rows = await db.select({ id: usersTable.id, name: usersTable.name, avatarPath: usersTable.avatarPath })
      .from(usersTable).where(inArray(usersTable.id, missing));
    for (const row of rows) people.set(row.id, { userId: row.id, name: (row.name ?? "").trim(), avatarUrl: avatarUrlFor(row.id, row.avatarPath), found: true });
  }
  return [...people.values()].sort((a, b) => Number(b.found) - Number(a.found));
}

async function attemptView(progress: Progress, bookerId: number, capped: boolean): Promise<FreeMatchAttempt> {
  const friends = await friendsFor(progress, bookerId);
  const { ctx } = progress;
  return {
    code: ctx.room.code,
    fieldName: ctx.field.name,
    startMs: ammanLocalInstant(ctx.request.startLocal),
    endMs: ammanLocalInstant(ctx.request.endLocal),
    phase: progress.phase,
    paid: ctx.paymentStatus === "paid",
    payPending: ctx.paymentStatus === "pending",
    findRecordingId: progress.recordings[0]?.recordingId ?? null,
    bookerFound: progress.found.has(bookerId),
    friendsFound: friends.filter((f) => f.found).length,
    friends,
    deadline: progress.deadlineMs === null ? null : new Date(progress.deadlineMs).toISOString(),
    capped,
  };
}

/**
 * Write the reward for a finished match, unless the player already earned
 * his one. Serialised per player so two devices can't both earn it. Returns
 * whether a reward was written.
 */
async function earnReward(userId: number, progress: Progress, commerce: Commerce): Promise<boolean> {
  const friendIds = [...progress.found].filter((id) => id !== userId);
  const names = friendIds.length
    ? await db.select({ name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, friendIds))
    : [];
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${EARN_LOCK_NAMESPACE}, ${userId})`);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(freeMatchRewardsTable)
      .where(eq(freeMatchRewardsTable.userId, userId));
    if ((count?.n ?? 0) >= REWARDS_PER_PLAYER) return false;
    const inserted = await tx.insert(freeMatchRewardsTable).values({
      userId,
      sourceMatchId: progress.ctx.room.id,
      freeHours: commerce.freeMatchHours,
      worthFils: commerce.freeMatchHours * commerce.playerBookingFilsPerHour,
      friendNames: names.map((row) => (row.name ?? "").trim().split(/\s+/)[0] ?? "").filter(Boolean),
      expiresAt: new Date(Date.now() + commerce.freeMatchUseWithinDays * 24 * 60 * 60 * 1000),
    }).onConflictDoNothing({ target: freeMatchRewardsTable.sourceMatchId }).returning({ id: freeMatchRewardsTable.id });
    return inserted.length > 0;
  });
}

function rewardView(row: FreeMatchReward, codes: Map<number, string>): FreeMatchRewardView {
  return {
    id: row.id,
    freeHours: row.freeHours,
    worthFils: row.worthFils,
    expiresAt: row.expiresAt.toISOString(),
    sourceCode: codes.get(row.sourceMatchId) ?? null,
    thanks: row.friendNames,
    usedCode: row.usedMatchId === null ? null : codes.get(row.usedMatchId) ?? null,
    status: row.status,
  };
}

/**
 * Hand back free matches spent on bookings that never recorded: cancelled by
 * anyone, failed, or refunded. The time it was held is added back to its
 * expiry. Also frees a reward claimed by a booking that crashed before it
 * got its room (claimed more than 10 minutes ago with no room).
 */
export async function reconcileRewards(userId: number): Promise<void> {
  await db.execute(sql`
    update free_match_rewards r
       set status = 'available',
           used_match_id = null,
           used_at = null,
           expires_at = r.expires_at + (now() - coalesce(r.used_at, now()))
     where r.user_id = ${userId}
       and r.status = 'used'
       and (
         (r.used_match_id is null and r.used_at < now() - interval '10 minutes')
         or exists (
           select 1 from match_rooms m
             join footage_requests f on f.id = m.footage_request_id
            where m.id = r.used_match_id
              and f.status in ('cancelled', 'failed', 'refunded')
         )
       )`);
}

/** Whether a new CliQ booking could still earn him the free match: he hasn't had his one yet. */
export async function canEarn(userId: number, commerce: Commerce): Promise<boolean> {
  if (!commerce.freeMatchEnabled) return false;
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(freeMatchRewardsTable)
    .where(eq(freeMatchRewardsTable.userId, userId));
  return (row?.n ?? 0) < REWARDS_PER_PLAYER;
}

/** His unused, unexpired free match, if he has one. */
export async function availableReward(userId: number): Promise<FreeMatchReward | null> {
  await reconcileRewards(userId);
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

/**
 * Claim a reward for a booking about to be created. Returns false if it was
 * already spent or lapsed (double tap, two tabs). Attach the booking's room
 * with `attachReward` once it exists, or `releaseReward` if creating it fails.
 */
export async function claimReward(rewardId: number, userId: number): Promise<boolean> {
  const rows = await db.update(freeMatchRewardsTable)
    .set({ status: "used", usedMatchId: null, usedAt: new Date() })
    .where(and(
      eq(freeMatchRewardsTable.id, rewardId),
      eq(freeMatchRewardsTable.userId, userId),
      eq(freeMatchRewardsTable.status, "available"),
      gte(freeMatchRewardsTable.expiresAt, new Date()),
    ))
    .returning({ id: freeMatchRewardsTable.id });
  return rows.length > 0;
}

export async function attachReward(rewardId: number, matchId: number): Promise<void> {
  await db.update(freeMatchRewardsTable).set({ usedMatchId: matchId }).where(eq(freeMatchRewardsTable.id, rewardId));
}

export async function releaseReward(rewardId: number): Promise<void> {
  await db.update(freeMatchRewardsTable)
    .set({ status: "available", usedMatchId: null, usedAt: null })
    .where(and(eq(freeMatchRewardsTable.id, rewardId), eq(freeMatchRewardsTable.status, "used")));
}

/** A booking that used a free match was cancelled before it recorded: give it back, with the time it was held. */
export async function releaseRewardForMatch(matchId: number): Promise<void> {
  await db.execute(sql`
    update free_match_rewards
       set status = 'available',
           used_match_id = null,
           expires_at = expires_at + (now() - coalesce(used_at, now())),
           used_at = null
     where used_match_id = ${matchId} and status = 'used'`);
}

/**
 * Everything Home, the match page and the Book page need. Also writes the
 * reward for any of his matches that has just finished.
 */
export async function freeMatchStatus(
  userId: number,
  options: { commerce?: Commerce; fieldRecordings?: FieldRecordingCache } = {},
): Promise<FreeMatchStatus> {
  const commerce = options.commerce ?? await loadCommerce({ userId });
  const base = {
    enabled: commerce.freeMatchEnabled,
    friendsRequired: commerce.freeMatchFriendsRequired,
    freeHours: commerce.freeMatchHours,
    useWithinDays: commerce.freeMatchUseWithinDays,
    deadlineDays: Math.round(FOOTAGE_RETENTION_MS / (24 * 60 * 60 * 1000)),
    pricePerHourFils: commerce.playerBookingFilsPerHour,
  };
  await reconcileRewards(userId);
  let rewards = await db.select().from(freeMatchRewardsTable)
    .where(eq(freeMatchRewardsTable.userId, userId))
    .orderBy(desc(freeMatchRewardsTable.earnedAt));
  let attempt: FreeMatchAttempt | null = null;

  // Once he has earned his one free match, there is nothing left to track.
  if (commerce.freeMatchEnabled && rewards.length < REWARDS_PER_PLAYER) {
    const excluded = rewards.flatMap((row) => [row.sourceMatchId, ...(row.usedMatchId === null ? [] : [row.usedMatchId])]);
    const now = Date.now();
    // His CliQ bookings from the last few weeks that haven't earned or used a free match, newest first.
    const candidates: Candidate[] = (await db.select({
      room: matchRoomsTable, request: footageRequestsTable, field: fieldsTable, paymentStatus: statUnlocksTable.status,
    })
      .from(matchRoomsTable)
      .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
      .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
      .innerJoin(statUnlocksTable, and(
        eq(statUnlocksTable.matchId, matchRoomsTable.id),
        eq(statUnlocksTable.userId, userId),
        eq(statUnlocksTable.kind, "booking"),
        eq(statUnlocksTable.method, "cliq"),
        inArray(statUnlocksTable.status, ["pending", "paid"]),
      ))
      .where(and(
        eq(footageRequestsTable.requestedBy, userId),
        notInArray(footageRequestsTable.status, DEAD_STATUSES),
        gte(footageRequestsTable.startLocal, ammanLocalString(now - LOOKBACK_MS)),
        ...(excluded.length ? [notInArray(matchRoomsTable.id, excluded)] : []),
      ))
      .orderBy(desc(footageRequestsTable.startLocal))
      .limit(10));

    const progress = await Promise.all(candidates.map((ctx) => progressFor(ctx, options.fieldRecordings)));
    // Earn from the oldest finished match first; after his one, the rest earn nothing.
    let earnedAny = false;
    for (const entry of [...progress].reverse()) {
      if (entry.afterWhistle && isComplete(entry, userId, commerce)) {
        if (await earnReward(userId, entry, commerce)) earnedAny = true;
      }
    }
    if (earnedAny) {
      rewards = await db.select().from(freeMatchRewardsTable)
        .where(eq(freeMatchRewardsTable.userId, userId))
        .orderBy(desc(freeMatchRewardsTable.earnedAt));
    }
    const rewarded = new Set(rewards.map((row) => row.sourceMatchId));
    const capped = rewards.length >= REWARDS_PER_PLAYER;
    // What to show: the newest match past the whistle that still has work to do, else the next one coming up.
    const live = progress.filter((entry) => !rewarded.has(entry.ctx.room.id) && (entry.deadlineMs === null || entry.deadlineMs >= now));
    const pick = live.find((entry) => entry.afterWhistle)
      ?? [...live].reverse().find((entry) => !entry.afterWhistle)
      ?? null;
    if (pick) attempt = await attemptView(pick, userId, capped);
  }

  const nowDate = new Date();
  const available = rewards
    .filter((row) => row.status === "available" && row.expiresAt >= nowDate)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())[0] ?? null;
  const latest = rewards[0] ?? null;
  const roomIds = [...new Set([available, latest].flatMap((row) => (row ? [row.sourceMatchId, ...(row.usedMatchId === null ? [] : [row.usedMatchId])] : [])))];
  const codes = new Map<number, string>(roomIds.length
    ? (await db.select({ id: matchRoomsTable.id, code: matchRoomsTable.code }).from(matchRoomsTable).where(inArray(matchRoomsTable.id, roomIds)))
      .map((row) => [row.id, row.code] as [number, string])
    : []);
  return {
    ...base,
    canEarn: commerce.freeMatchEnabled && rewards.length < REWARDS_PER_PLAYER,
    attempt,
    reward: available ? rewardView(available, codes) : null,
    latestEarned: latest ? rewardView(latest, codes) : null,
  };
}

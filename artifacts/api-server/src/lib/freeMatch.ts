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
 * anyone, failed, refunded before delivery, lapsed unpaid) hands it back;
 * that is reconciled on every read, so no cancel path has to remember to do it.
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
  /** challenge: earned with friends. loyalty: earned by booking N games. */
  kind: "challenge" | "loyalty";
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
  /** The challenge reward he earned, for the "unlocked" moment on the source match. */
  latestEarned: FreeMatchRewardView | null;
  /** Every N paid games he has played, one free. */
  loyalty: LoyaltyStatus;
};

export type LoyaltyStatus = {
  enabled: boolean;
  /** Games per free one (5: the 6th is free). */
  every: number;
  /** Paid games played in the current block, 0..every-1. */
  count: number;
  /** All paid games played since counting started. */
  total: number;
  /** Free games earned this way so far. */
  earned: number;
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
      .where(and(eq(freeMatchRewardsTable.userId, userId), eq(freeMatchRewardsTable.kind, "challenge")));
    if ((count?.n ?? 0) >= REWARDS_PER_PLAYER) return false;
    const inserted = await tx.insert(freeMatchRewardsTable).values({
      userId,
      kind: "challenge",
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
    kind: row.kind,
    freeHours: row.freeHours,
    worthFils: row.worthFils,
    expiresAt: row.expiresAt.toISOString(),
    sourceCode: row.sourceMatchId === null ? null : codes.get(row.sourceMatchId) ?? null,
    thanks: row.friendNames,
    usedCode: row.usedMatchId === null ? null : codes.get(row.usedMatchId) ?? null,
    status: row.status,
  };
}

/**
 * A CliQ booking whose transfer still isn't confirmed this long after its
 * whistle has lapsed: it never recorded and never will (the status sweep
 * cancels it, and an admin confirming it late is turned away). Inside this
 * window a late confirmation still pulls the match from the camera's SD card.
 */
export const UNPAID_BOOKING_LAPSE_MS = 24 * 60 * 60 * 1000;

/** An unpaid booking ending at or before this "YYYY-MM-DD HH:MM" (Amman) has lapsed. */
export function unpaidLapseCutoffLocal(now = Date.now()): string {
  return ammanLocalString(now - UNPAID_BOOKING_LAPSE_MS);
}

/**
 * When the booking behind a held free match stopped holding it: its end for
 * a booking that lapsed unpaid, else when it was cancelled/failed (its last
 * update), never later than its end or now. `f` is the footage_requests row.
 */
const BOOKING_DIED_AT = sql`(case
  when f.end_local !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$' then least(now(), f.updated_at)
  when f.status = 'awaiting_payment' then least(now(), (f.end_local::timestamp - interval '3 hours') at time zone 'UTC')
  else least(now(), f.updated_at, (f.end_local::timestamp - interval '3 hours') at time zone 'UTC')
end)`;

/**
 * Hand back free matches spent on bookings that never recorded: cancelled by
 * anyone, failed, refunded before anything was delivered, or left unpaid
 * until they lapsed. The time it was actually held (from its claim until the
 * booking died) is added back to its expiry; one whose extended expiry has
 * already passed stays spent. Also frees a reward claimed by a booking that
 * crashed before it got its room (claimed more than 10 minutes ago with no
 * room), adding back those few minutes.
 */
export async function reconcileRewards(userId: number, now = Date.now()): Promise<void> {
  await db.execute(sql`
    update free_match_rewards r
       set status = 'available',
           used_match_id = null,
           used_at = null,
           expires_at = r.expires_at + least(now() - r.used_at, interval '10 minutes')
     where r.user_id = ${userId}
       and r.status = 'used'
       and r.used_match_id is null
       and r.used_at < now() - interval '10 minutes'
       and r.expires_at + least(now() - r.used_at, interval '10 minutes') >= now()`);
  await db.execute(sql`
    with back as (
      select r.id, r.expires_at + greatest(interval '0', ${BOOKING_DIED_AT} - coalesce(r.used_at, ${BOOKING_DIED_AT})) as new_expiry
        from free_match_rewards r
        join match_rooms m on m.id = r.used_match_id
        join footage_requests f on f.id = m.footage_request_id
       where r.user_id = ${userId}
         and r.status = 'used'
         and (
           f.status in ('cancelled', 'failed')
           -- A refund after delivery keeps the free match spent: the match was recorded.
           or (f.status = 'refunded' and f.ready_at is null and f.video_id is null and coalesce(f.delivered_seconds, 0) = 0)
           or (f.status = 'awaiting_payment' and f.end_local <= ${unpaidLapseCutoffLocal(now)})
         )
    )
    update free_match_rewards r
       set status = 'available',
           used_match_id = null,
           used_at = null,
           expires_at = back.new_expiry
      from back
     where r.id = back.id
       and r.status = 'used'
       and back.new_expiry >= now()`);
}

/** Whether a new CliQ booking could still earn him the free match: he hasn't had his one yet. */
export async function canEarn(userId: number, commerce: Commerce): Promise<boolean> {
  if (!commerce.freeMatchEnabled) return false;
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(freeMatchRewardsTable)
    .where(and(eq(freeMatchRewardsTable.userId, userId), eq(freeMatchRewardsTable.kind, "challenge")));
  return (row?.n ?? 0) < REWARDS_PER_PLAYER;
}

/**
 * Every N paid games he has played earns a free one. A game counts once its
 * booking was paid (CliQ confirmed or cash collected at the field), it wasn't
 * cancelled, failed or refunded, its slot is over, it started on or after the
 * count-from date, and it wasn't itself paid for with a free match. Missing
 * rewards are written here (one per block of N), under the same per-player
 * lock as the challenge, so two devices can't write the same block twice.
 */
export async function loyaltyStatus(userId: number, commerce: Commerce): Promise<LoyaltyStatus> {
  const every = commerce.loyaltyEvery;
  const nowLocal = ammanLocalString(Date.now());
  const [row] = await db.execute<{ n: number }>(sql`
    select count(distinct m.id)::int as n
      from match_rooms m
      join footage_requests f on f.id = m.footage_request_id
     where f.requested_by = ${userId}
       and f.status not in ('cancelled', 'failed', 'rejected', 'refunded')
       and f.end_local <= ${nowLocal}
       and f.start_local >= ${`${commerce.loyaltyCountFrom} 00:00`}
       and exists (
         select 1 from stat_unlocks s
          where s.match_id = m.id and s.user_id = ${userId} and s.kind = 'booking'
            and s.status = 'paid' and s.method in ('cliq', 'field'))
       and not exists (select 1 from free_match_rewards r where r.used_match_id = m.id)`).then((result) => result.rows);
  const total = Number(row?.n ?? 0);
  const due = Math.floor(total / every);
  let earned = (await db.select({ milestone: freeMatchRewardsTable.milestone }).from(freeMatchRewardsTable)
    .where(and(eq(freeMatchRewardsTable.userId, userId), eq(freeMatchRewardsTable.kind, "loyalty")))).length;
  if (commerce.loyaltyEnabled && due > earned) {
    earned = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${EARN_LOCK_NAMESPACE}, ${userId})`);
      const have = new Set((await tx.select({ milestone: freeMatchRewardsTable.milestone }).from(freeMatchRewardsTable)
        .where(and(eq(freeMatchRewardsTable.userId, userId), eq(freeMatchRewardsTable.kind, "loyalty"))))
        .map((r) => r.milestone));
      for (let milestone = 1; milestone <= due; milestone++) {
        if (have.has(milestone)) continue;
        await tx.insert(freeMatchRewardsTable).values({
          userId,
          kind: "loyalty",
          milestone,
          sourceMatchId: null,
          freeHours: commerce.freeMatchHours,
          worthFils: commerce.freeMatchHours * commerce.playerBookingFilsPerHour,
          friendNames: [],
          expiresAt: new Date(Date.now() + commerce.freeMatchUseWithinDays * 24 * 60 * 60 * 1000),
        }).onConflictDoNothing();
        have.add(milestone);
      }
      return have.size;
    });
  }
  return {
    enabled: commerce.loyaltyEnabled,
    every,
    count: total - Math.min(due, Math.floor(total / every)) * every,
    total,
    earned,
  };
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
export async function claimReward(rewardId: number, userId: number, executor: Pick<typeof db, "update"> = db): Promise<boolean> {
  const rows = await executor.update(freeMatchRewardsTable)
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

/**
 * A booking that used a free match was cancelled before it recorded: give it
 * back, with the time it was held (until the booking died, see
 * BOOKING_DIED_AT). Not if that extended expiry has already passed.
 */
export async function releaseRewardForMatch(matchId: number): Promise<void> {
  await db.execute(sql`
    with back as (
      select r.id, r.expires_at + greatest(interval '0', ${BOOKING_DIED_AT} - coalesce(r.used_at, ${BOOKING_DIED_AT})) as new_expiry
        from free_match_rewards r
        join match_rooms m on m.id = r.used_match_id
        join footage_requests f on f.id = m.footage_request_id
       where r.used_match_id = ${matchId} and r.status = 'used'
    )
    update free_match_rewards r
       set status = 'available',
           used_match_id = null,
           used_at = null,
           expires_at = back.new_expiry
      from back
     where r.id = back.id
       and r.status = 'used'
       and back.new_expiry >= now()`);
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
  const loyalty = await loyaltyStatus(userId, commerce);
  let rewards = await db.select().from(freeMatchRewardsTable)
    .where(eq(freeMatchRewardsTable.userId, userId))
    .orderBy(desc(freeMatchRewardsTable.earnedAt));
  const challengeCount = () => rewards.filter((row) => row.kind === "challenge").length;
  let attempt: FreeMatchAttempt | null = null;

  // Once he has earned his one challenge free match, there is nothing left to track for it.
  if (commerce.freeMatchEnabled && challengeCount() < REWARDS_PER_PLAYER) {
    const excluded = rewards.flatMap((row) => [
      ...(row.sourceMatchId === null ? [] : [row.sourceMatchId]),
      ...(row.usedMatchId === null ? [] : [row.usedMatchId]),
    ]);
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
    const capped = challengeCount() >= REWARDS_PER_PLAYER;
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
  const latest = rewards.find((row) => row.kind === "challenge") ?? null;
  const roomIds = [...new Set([available, latest].flatMap((row) => (row
    ? [...(row.sourceMatchId === null ? [] : [row.sourceMatchId]), ...(row.usedMatchId === null ? [] : [row.usedMatchId])]
    : [])))];
  const codes = new Map<number, string>(roomIds.length
    ? (await db.select({ id: matchRoomsTable.id, code: matchRoomsTable.code }).from(matchRoomsTable).where(inArray(matchRoomsTable.id, roomIds)))
      .map((row) => [row.id, row.code] as [number, string])
    : []);
  return {
    ...base,
    canEarn: commerce.freeMatchEnabled && challengeCount() < REWARDS_PER_PLAYER,
    attempt,
    reward: available ? rewardView(available, codes) : null,
    latestEarned: latest ? rewardView(latest, codes) : null,
    loyalty,
  };
}

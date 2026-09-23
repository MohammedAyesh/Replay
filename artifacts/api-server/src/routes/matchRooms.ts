import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  fieldOwnersTable,
  matchGamesTable,
  matchPlayersTable,
  matchRoomsTable,
  motmVotesTable,
  statUnlocksTable,
  usersTable,
  userClipsTable,
  varMarksTable,
  type MatchPlayer,
} from "@workspace/db";
import { getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";
import {
  BOOKING_FILS,
  STATS_MATCH_FILS,
  STATS_MONTHLY_FILS,
  ammanLocalInstant,
  avatarUrlFor,
  isPlaying,
  loadRoomByCode,
  matchPhase,
  matchWindow,
  normalizeEmail,
  normalizePhone,
  playerForUser,
  publicBaseUrl,
  randomToken,
  roomsForUser,
  rosterFor,
  voteOpen,
  VAR_CLOSE_AFTER_MS,
  VAR_OPEN_BEFORE_MS,
  type RoomContext,
} from "../lib/matchRooms";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  isBunnyStorageConfigured,
  uploadBufferToBunnyStorage,
} from "../lib/bunny";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

type LocalUser = NonNullable<Awaited<ReturnType<typeof getLocalUserRecord>>>;

const TEAM_COLORS = ["#F2F4F8", "#FF6B1A", "#7AA2FF", "#0B0F1A", "#2FD8C4", "#FFD23F", "#E23B3B", "#1F8A4C"];
const CLIQ_ALIAS = process.env.REPLAY_CLIQ_ALIAS || "REPLAYJO";

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function intParam(req: Request, name: string): number | null {
  const parsed = Number.parseInt(param(req, name), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function optionalUser(req: Request): Promise<LocalUser | null> {
  try {
    return await getLocalUserRecord(req);
  } catch {
    return null;
  }
}

/** A real (non-guest) signed-in account, or a 401/403 response. */
async function requirePlayer(req: Request, res: Response): Promise<LocalUser | null> {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return null;
  }
  if (user.isGuest) {
    res.status(403).json({ error: "Create an account to join matches", reason: "guest" });
    return null;
  }
  return user;
}

async function isFieldOwner(userId: number, fieldId: number): Promise<boolean> {
  const [row] = await db.select({ id: fieldOwnersTable.id }).from(fieldOwnersTable)
    .where(and(eq(fieldOwnersTable.userId, userId), eq(fieldOwnersTable.fieldId, fieldId)));
  return Boolean(row);
}

async function loadOr404(req: Request, res: Response): Promise<RoomContext | null> {
  const ctx = await loadRoomByCode(param(req, "code"));
  if (!ctx) {
    res.status(404).json({ error: "Match not found" });
    return null;
  }
  return ctx;
}

/** Captain, the field's owner, or an admin may manage the room. */
async function canManage(user: LocalUser, ctx: RoomContext): Promise<boolean> {
  if (user.isAdmin) return true;
  if (ctx.room.captainUserId === user.id) return true;
  return isFieldOwner(user.id, ctx.room.fieldId);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((p) => Array.from(p)[0]).join("").toUpperCase();
}

type UserLite = { id: number; name: string; avatarPath: string | null; shirtNumber: number | null };

async function usersById(ids: number[]): Promise<Map<number, UserLite>> {
  const unique = Array.from(new Set(ids.filter((id) => Number.isSafeInteger(id))));
  if (!unique.length) return new Map();
  const rows = await db.select({
    id: usersTable.id,
    name: usersTable.name,
    avatarPath: usersTable.avatarPath,
    shirtNumber: usersTable.shirtNumber,
  }).from(usersTable).where(inArray(usersTable.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

function playerView(player: MatchPlayer, users: Map<number, UserLite>, roster: MatchPlayer[], viewerId: number | null) {
  const user = player.userId ? users.get(player.userId) : undefined;
  const name = player.displayName || user?.name || "";
  const inviter = player.invitedByPlayerId ? roster.find((p) => p.id === player.invitedByPlayerId) : undefined;
  return {
    id: player.id,
    name,
    initials: initials(name),
    avatarUrl: user ? avatarUrlFor(user.id, user.avatarPath) : null,
    userId: player.userId,
    signedUp: Boolean(player.userId),
    rsvp: player.rsvp,
    team: player.team,
    shirtNumber: player.shirtNumber ?? user?.shirtNumber ?? null,
    slotX: player.slotX,
    slotY: player.slotY,
    invitedBy: inviter ? { id: inviter.id, name: inviter.displayName } : null,
    isMe: viewerId !== null && player.userId === viewerId,
  };
}

async function voteSummary(ctx: RoomContext, viewerId: number | null, roster: MatchPlayer[]) {
  const open = voteOpen(ctx.request);
  const end = ammanLocalInstant(ctx.request.endLocal);
  const closed = Number.isFinite(end) && Date.now() > end + 24 * 60 * 60 * 1000;
  const votes = await db.select().from(motmVotesTable).where(eq(motmVotesTable.matchId, ctx.room.id));
  const myVote = viewerId ? votes.find((v) => v.voterUserId === viewerId)?.candidatePlayerId ?? null : null;
  const tallies = new Map<number, number>();
  for (const vote of votes) tallies.set(vote.candidatePlayerId, (tallies.get(vote.candidatePlayerId) ?? 0) + 1);
  const max = Math.max(0, ...tallies.values());
  const winners = closed && max > 0
    ? Array.from(tallies.entries()).filter(([, n]) => n === max).map(([id]) => id)
    : [];
  const showTallies = closed || myVote !== null;
  const eligible = roster.filter((p) => p.rsvp === "in" && p.userId).length;
  return {
    open,
    closed,
    closesAt: Number.isFinite(end) ? new Date(end + 24 * 60 * 60 * 1000).toISOString() : null,
    myVote,
    votesCast: votes.length,
    eligibleVoters: eligible,
    tallies: showTallies ? Array.from(tallies.entries()).map(([playerId, count]) => ({ playerId, count })) : [],
    winners,
  };
}

async function statsAccess(userId: number | null, matchId: number) {
  if (!userId) return { unlocked: false, pending: null as null | { reference: string; kind: string; amountFils: number } };
  const now = new Date();
  const rows = await db.select().from(statUnlocksTable).where(and(
    or(
      and(eq(statUnlocksTable.userId, userId), eq(statUnlocksTable.matchId, matchId)),
      and(eq(statUnlocksTable.userId, userId), eq(statUnlocksTable.kind, "monthly")),
      and(eq(statUnlocksTable.matchId, matchId), eq(statUnlocksTable.kind, "team")),
    ),
  )).orderBy(desc(statUnlocksTable.createdAt));
  const paid = rows.some((row) => row.status === "paid" && (
    row.kind !== "monthly" || (row.validUntil && row.validUntil > now)
  ) && (row.kind !== "team" || row.matchId === matchId));
  const pending = rows.find((row) => row.status === "pending" && row.userId === userId);
  return {
    unlocked: paid,
    pending: pending ? { reference: pending.reference, kind: pending.kind, amountFils: pending.amountFils } : null,
  };
}

async function roomPayload(req: Request, ctx: RoomContext, viewer: LocalUser | null) {
  const { room, request, field } = ctx;
  const base = publicBaseUrl(req);
  const roster = await rosterFor(room.id);
  const userIds = roster.map((p) => p.userId).filter((id): id is number => typeof id === "number");
  if (room.captainUserId) userIds.push(room.captainUserId);
  const users = await usersById(userIds);
  const viewerId = viewer && !viewer.isGuest ? viewer.id : null;
  const me = viewerId ? roster.find((p) => p.userId === viewerId) ?? null : null;
  const isCaptain = viewerId !== null && room.captainUserId === viewerId;
  const isOwner = viewer ? (viewer.isAdmin || await isFieldOwner(viewer.id, room.fieldId)) : false;
  const member = isCaptain || isPlaying(me);
  const phase = matchPhase(request);
  const window = matchWindow(request);

  // "Invited by" from ?by=<playerId> or a personal invite ?i=<token>.
  const byId = Number.parseInt(String(req.query.by ?? ""), 10);
  const inviteToken = typeof req.query.i === "string" ? req.query.i : "";
  const personal = inviteToken ? roster.find((p) => p.inviteToken === inviteToken && !p.userId) : undefined;
  const inviterPlayer = personal?.invitedByPlayerId
    ? roster.find((p) => p.id === personal.invitedByPlayerId)
    : Number.isSafeInteger(byId) ? roster.find((p) => p.id === byId) : undefined;
  const inviterUser = inviterPlayer?.userId ? users.get(inviterPlayer.userId) : undefined;
  const captainUser = room.captainUserId ? users.get(room.captainUserId) : undefined;

  const counts = {
    in: roster.filter((p) => p.rsvp === "in").length,
    maybe: roster.filter((p) => p.rsvp === "maybe").length,
    invited: roster.filter((p) => p.rsvp === "invited").length,
    out: roster.filter((p) => p.rsvp === "out").length,
    needed: room.playersPerSide * 2,
  };

  let marks: Array<{ id: number; kind: string; note: string | null; atUtc: string; offsetSeconds: number | null; byName: string | null; mine: boolean }> = [];
  if (member || isOwner) {
    const rows = await db.select().from(varMarksTable)
      .where(eq(varMarksTable.footageRequestId, request.id))
      .orderBy(asc(varMarksTable.atUtc));
    const markUsers = await usersById(rows.map((r) => r.createdBy));
    marks = rows.map((mark) => ({
      id: mark.id,
      kind: mark.kind,
      note: mark.note,
      atUtc: mark.atUtc.toISOString(),
      offsetSeconds: Number.isFinite(window.startMs) ? (mark.atUtc.getTime() - window.startMs) / 1000 : null,
      byName: markUsers.get(mark.createdBy)?.name ?? null,
      mine: mark.createdBy === viewerId,
    }));
  }

  const shareActive = (request.status === "ready" || request.status === "partial")
    && Boolean(request.shareToken) && !request.shareRevoked
    && Boolean(request.shareExpiresAt) && request.shareExpiresAt!.getTime() > Date.now();

  const games = await db.select().from(matchGamesTable)
    .where(eq(matchGamesTable.matchId, room.id)).orderBy(asc(matchGamesTable.idx));
  const vote = await voteSummary(ctx, viewerId, roster);
  const stats = await statsAccess(viewerId, room.id);
  const now = Date.now();
  const varActive = now >= window.startMs - VAR_OPEN_BEFORE_MS
    && now <= window.endMs + VAR_CLOSE_AFTER_MS
    && ["queued", "running", "scheduled", "recording"].includes(request.status)
    && request.varState !== "unsupported" && request.varState !== "ftp-failed";

  const myClips = viewerId
    ? await db.select({ id: userClipsTable.id }).from(userClipsTable)
      .where(and(eq(userClipsTable.footageRequestId, request.id), eq(userClipsTable.userId, viewerId)))
    : [];
  const matchClipCount = await db.select({ n: sql<number>`count(*)::int` }).from(userClipsTable)
    .where(and(eq(userClipsTable.footageRequestId, request.id), inArray(userClipsTable.visibility, ["match", "public"])));

  return {
    code: room.code,
    url: `${base}/m/${room.code}`,
    serverNow: new Date(now).toISOString(),
    phase,
    status: request.status,
    progress: request.progress,
    startLocal: request.startLocal,
    endLocal: request.endLocal,
    ...window,
    field: {
      id: field.id,
      name: field.name,
      location: field.location,
      imageUrl: field.thumbnailUrl,
    },
    title: room.title,
    playersPerSide: room.playersPerSide,
    teams: {
      A: { name: room.teamAName, color: room.teamAColor },
      B: { name: room.teamBName, color: room.teamBColor },
    },
    score: room.scoreA !== null && room.scoreB !== null ? { a: room.scoreA, b: room.scoreB } : null,
    captain: captainUser ? {
      userId: captainUser.id,
      name: captainUser.name,
      avatarUrl: avatarUrlFor(captainUser.id, captainUser.avatarPath),
    } : null,
    isCaptain,
    isOwner,
    canManage: isCaptain || isOwner,
    isMember: member,
    signedIn: Boolean(viewer && !viewer.isGuest),
    players: roster.map((p) => playerView(p, users, roster, viewerId)),
    counts,
    me: me ? playerView(me, users, roster, viewerId) : null,
    invitedBy: inviterPlayer ? {
      playerId: inviterPlayer.id,
      name: inviterPlayer.displayName,
      avatarUrl: inviterUser ? avatarUrlFor(inviterUser.id, inviterUser.avatarPath) : null,
    } : captainUser ? {
      playerId: null,
      name: captainUser.name,
      avatarUrl: avatarUrlFor(captainUser.id, captainUser.avatarPath),
    } : null,
    personalInvite: personal ? { playerId: personal.id, name: personal.displayName } : null,
    myInviteUrl: me ? `${base}/m/${room.code}?by=${me.id}` : null,
    captainUrl: isOwner ? `${base}/m/${room.code}?c=${room.captainToken}` : null,
    var: {
      active: varActive,
      // The footage request id unlocks the VAR proxy, so only people who may
      // watch it receive it.
      requestId: (member || isOwner) ? request.id : null,
      state: request.varState,
    },
    marks,
    footage: {
      ready: shareActive,
      readyAt: request.readyAt?.toISOString() ?? null,
      shareUrl: shareActive && (member || isOwner) ? `${base}/w/${request.shareToken}` : null,
      shareToken: shareActive && (member || isOwner) ? request.shareToken : null,
      expiresAt: request.shareExpiresAt?.toISOString() ?? null,
    },
    games: games.map((g) => ({
      id: g.id, idx: g.idx, startOffsetSec: g.startOffsetSec, endOffsetSec: g.endOffsetSec, scoreA: g.scoreA, scoreB: g.scoreB,
    })),
    vote,
    stats: {
      ...stats,
      prices: { matchFils: STATS_MATCH_FILS, monthlyFils: STATS_MONTHLY_FILS, teamFils: STATS_MATCH_FILS * room.playersPerSide * 2 },
      cliqAlias: CLIQ_ALIAS,
    },
    clips: {
      mine: myClips.length,
      match: matchClipCount[0]?.n ?? 0,
    },
    prices: { bookingFils: BOOKING_FILS },
  };
}

// ---------------------------------------------------------------- read

router.get("/m/:code", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const viewer = await optionalUser(req);
  res.json(await roomPayload(req, ctx, viewer));
});

router.get("/me/matches", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user) {
    unauthenticatedResponse(res, req);
    return;
  }
  if (user.isGuest) {
    res.json({ upcoming: [], live: [], recent: [], invites: [] });
    return;
  }
  const rooms = await roomsForUser(user.id);
  const base = publicBaseUrl(req);
  const items = await Promise.all(rooms.map(async (ctx) => {
    const roster = await rosterFor(ctx.room.id);
    const me = roster.find((p) => p.userId === user.id) ?? null;
    const phase = matchPhase(ctx.request);
    const w = matchWindow(ctx.request);
    return {
      code: ctx.room.code,
      url: `${base}/m/${ctx.room.code}`,
      phase,
      startLocal: ctx.request.startLocal,
      endLocal: ctx.request.endLocal,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      startMs: w.startMs,
      field: { id: ctx.field.id, name: ctx.field.name, location: ctx.field.location, imageUrl: ctx.field.thumbnailUrl },
      title: ctx.room.title,
      myRsvp: me?.rsvp ?? (ctx.room.captainUserId === user.id ? "in" : null),
      myTeam: me?.team ?? null,
      isCaptain: ctx.room.captainUserId === user.id,
      countIn: roster.filter((p) => p.rsvp === "in").length,
      needed: ctx.room.playersPerSide * 2,
      score: ctx.room.scoreA !== null && ctx.room.scoreB !== null ? { a: ctx.room.scoreA, b: ctx.room.scoreB } : null,
      voteOpen: voteOpen(ctx.request),
    };
  }));

  // Invites by phone or email: placeholders someone added for this person.
  const phone = normalizePhone(user.phone);
  const email = normalizeEmail(user.email);
  const invitedRows = (phone || email) ? await db.select({ player: matchPlayersTable })
    .from(matchPlayersTable)
    .where(and(
      isNull(matchPlayersTable.userId),
      or(
        phone ? eq(matchPlayersTable.contactPhone, phone) : sql`false`,
        email ? eq(matchPlayersTable.contactEmail, email) : sql`false`,
      ),
    )) : [];
  const inviteRooms = await Promise.all(invitedRows.map(async ({ player }) => {
    const [room] = await db.select().from(matchRoomsTable).where(eq(matchRoomsTable.id, player.matchId));
    if (!room || items.some((item) => item.code === room.code)) return null;
    const ctx = await loadRoomByCode(room.code);
    if (!ctx) return null;
    const phase = matchPhase(ctx.request);
    if (phase !== "pre" && phase !== "live") return null;
    const w = matchWindow(ctx.request);
    return {
      code: room.code,
      url: `${base}/m/${room.code}?i=${player.inviteToken}`,
      phase,
      startLocal: ctx.request.startLocal,
      endLocal: ctx.request.endLocal,
      startsAt: w.startsAt,
      startMs: w.startMs,
      field: { id: ctx.field.id, name: ctx.field.name, location: ctx.field.location, imageUrl: ctx.field.thumbnailUrl },
      title: room.title,
      inviteToken: player.inviteToken,
    };
  }));

  const now = Date.now();
  const byStart = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs;
  const active = items.filter((item) => item.myRsvp !== "out");
  res.json({
    live: active.filter((i) => i.phase === "live").sort(byStart),
    upcoming: active.filter((i) => i.phase === "pre" && i.startMs > now - 60 * 60 * 1000).sort(byStart),
    recent: items.filter((i) => ["processing", "ready", "expired"].includes(i.phase)).sort((a, b) => b.startMs - a.startMs).slice(0, 30),
    invites: inviteRooms.filter(Boolean),
  });
});

// ---------------------------------------------------------------- joining

const joinSchema = z.object({
  rsvp: z.enum(["in", "maybe", "out"]),
  displayName: z.string().trim().min(1).max(40).optional(),
  shirtNumber: z.number().int().min(0).max(99).nullable().optional(),
  by: z.number().int().positive().nullable().optional(),
  inviteToken: z.string().max(64).nullable().optional(),
  captainToken: z.string().max(64).nullable().optional(),
});

router.post("/m/:code/join", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const body = joinSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid RSVP" });
    return;
  }
  const phase = matchPhase(ctx.request);
  if (phase === "cancelled" || phase === "failed") {
    res.status(409).json({ error: "This match was cancelled" });
    return;
  }

  const roster = await rosterFor(ctx.room.id);
  let me = roster.find((p) => p.userId === user.id) ?? null;
  const shirt = body.data.shirtNumber === undefined ? user.shirtNumber ?? null : body.data.shirtNumber;
  const name = body.data.displayName || user.name;

  // Claim a placeholder: the personal invite link, or a placeholder carrying this person's phone / email.
  if (!me) {
    const phone = normalizePhone(user.phone);
    const email = normalizeEmail(user.email);
    const placeholder = roster.find((p) => !p.userId && (
      (body.data.inviteToken && p.inviteToken === body.data.inviteToken)
      || (phone && p.contactPhone === phone)
      || (email && p.contactEmail === email)
    ));
    if (placeholder) {
      const [claimed] = await db.update(matchPlayersTable).set({
        userId: user.id,
        displayName: name,
        rsvp: body.data.rsvp,
        rsvpAt: new Date(),
        shirtNumber: placeholder.shirtNumber ?? shirt,
        updatedAt: new Date(),
      }).where(and(eq(matchPlayersTable.id, placeholder.id), isNull(matchPlayersTable.userId))).returning();
      me = claimed ?? null;
    }
  }

  if (!me) {
    const by = body.data.by && roster.some((p) => p.id === body.data.by) ? body.data.by : null;
    const [created] = await db.insert(matchPlayersTable).values({
      matchId: ctx.room.id,
      userId: user.id,
      displayName: name,
      invitedByPlayerId: by,
      inviteToken: randomToken(10),
      rsvp: body.data.rsvp,
      rsvpAt: new Date(),
      shirtNumber: shirt,
    }).onConflictDoNothing().returning();
    me = created ?? await playerForUser(ctx.room.id, user.id);
  } else if (me.userId === user.id) {
    const [updated] = await db.update(matchPlayersTable).set({
      rsvp: body.data.rsvp,
      rsvpAt: new Date(),
      ...(body.data.displayName ? { displayName: body.data.displayName } : {}),
      ...(body.data.shirtNumber !== undefined ? { shirtNumber: body.data.shirtNumber } : {}),
      // Leaving the match takes you off the lineup.
      ...(body.data.rsvp === "out" ? { team: null, slotX: null, slotY: null } : {}),
      updatedAt: new Date(),
    }).where(eq(matchPlayersTable.id, me.id)).returning();
    me = updated ?? me;
  }

  if (body.data.shirtNumber !== undefined && body.data.shirtNumber !== null) {
    await db.update(usersTable).set({ shirtNumber: body.data.shirtNumber }).where(eq(usersTable.id, user.id));
  }

  // Captain: the captain link wins; otherwise the first player in becomes captain.
  const captainClaim = body.data.captainToken && body.data.captainToken === ctx.room.captainToken;
  if (captainClaim || (!ctx.room.captainUserId && body.data.rsvp === "in")) {
    await db.update(matchRoomsTable).set({ captainUserId: user.id, updatedAt: new Date() })
      .where(eq(matchRoomsTable.id, ctx.room.id));
    if (me && body.data.rsvp !== "in" && captainClaim) {
      await db.update(matchPlayersTable).set({ rsvp: "in", rsvpAt: new Date() }).where(eq(matchPlayersTable.id, me.id));
    }
  }

  const fresh = await loadRoomByCode(ctx.room.code);
  res.json(await roomPayload(req, fresh ?? ctx, user));
});

// ---------------------------------------------------------------- roster management

const inviteSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  phone: z.string().trim().max(24).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  shirtNumber: z.number().int().min(0).max(99).nullable().optional(),
});

router.post("/m/:code/players", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const me = await playerForUser(ctx.room.id, user.id);
  const manager = await canManage(user, ctx);
  if (!manager && !isPlaying(me)) {
    res.status(403).json({ error: "Join the match to invite people" });
    return;
  }
  const body = inviteSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "A name is required" });
    return;
  }
  const phone = normalizePhone(body.data.phone);
  const email = normalizeEmail(body.data.email);
  if (body.data.email && !email) {
    res.status(400).json({ error: "That email doesn't look right" });
    return;
  }
  const roster = await rosterFor(ctx.room.id);
  const duplicate = roster.find((p) => (phone && p.contactPhone === phone) || (email && p.contactEmail === email));
  if (duplicate) {
    res.status(409).json({ error: "Already on the list", playerId: duplicate.id });
    return;
  }
  // If the phone or email belongs to an existing account, link it straight away.
  let linkedUserId: number | null = null;
  if (email) {
    const [account] = await db.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.email, email), eq(usersTable.isGuest, false)));
    linkedUserId = account?.id ?? null;
  }
  if (!linkedUserId && phone) {
    const candidates = await db.select({ id: usersTable.id, phone: usersTable.phone }).from(usersTable)
      .where(and(eq(usersTable.isGuest, false), sql`${usersTable.phone} is not null`));
    linkedUserId = candidates.find((c) => normalizePhone(c.phone) === phone)?.id ?? null;
  }
  if (linkedUserId && roster.some((p) => p.userId === linkedUserId)) {
    res.status(409).json({ error: "Already on the list" });
    return;
  }
  const [created] = await db.insert(matchPlayersTable).values({
    matchId: ctx.room.id,
    userId: linkedUserId,
    displayName: body.data.displayName,
    contactPhone: phone,
    contactEmail: email,
    invitedByPlayerId: me?.id ?? null,
    inviteToken: randomToken(10),
    rsvp: "invited",
    shirtNumber: body.data.shirtNumber ?? null,
  }).returning();
  const base = publicBaseUrl(req);
  res.status(201).json({
    id: created.id,
    inviteUrl: `${base}/m/${ctx.room.code}?i=${created.inviteToken}`,
  });
});

const playerPatchSchema = z.object({
  team: z.enum(["A", "B"]).nullable().optional(),
  shirtNumber: z.number().int().min(0).max(99).nullable().optional(),
  slotX: z.number().min(0).max(100).nullable().optional(),
  slotY: z.number().min(0).max(100).nullable().optional(),
  displayName: z.string().trim().min(1).max(40).optional(),
  rsvp: z.enum(["in", "maybe", "out", "invited"]).optional(),
});

router.patch("/m/:code/players/:playerId", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const playerId = intParam(req, "playerId");
  const body = playerPatchSchema.safeParse(req.body ?? {});
  if (!playerId || !body.success) {
    res.status(400).json({ error: "Invalid change" });
    return;
  }
  const [player] = await db.select().from(matchPlayersTable)
    .where(and(eq(matchPlayersTable.id, playerId), eq(matchPlayersTable.matchId, ctx.room.id)));
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const manager = await canManage(user, ctx);
  const self = player.userId === user.id;
  if (!manager && !self) {
    res.status(403).json({ error: "Only the captain can change other players" });
    return;
  }
  // Players may change their own number and name; only the captain sets teams and slots for others.
  const update: Partial<typeof matchPlayersTable.$inferInsert> = { updatedAt: new Date() };
  if (body.data.shirtNumber !== undefined) update.shirtNumber = body.data.shirtNumber;
  if (body.data.displayName !== undefined && (self || !player.userId)) update.displayName = body.data.displayName;
  if (manager || self) {
    if (body.data.team !== undefined) update.team = body.data.team;
    if (body.data.slotX !== undefined) update.slotX = body.data.slotX;
    if (body.data.slotY !== undefined) update.slotY = body.data.slotY;
  }
  if (body.data.rsvp !== undefined && (manager || self)) {
    update.rsvp = body.data.rsvp;
    update.rsvpAt = new Date();
  }
  const [saved] = await db.update(matchPlayersTable).set(update).where(eq(matchPlayersTable.id, playerId)).returning();
  if (self && body.data.shirtNumber !== undefined && body.data.shirtNumber !== null) {
    await db.update(usersTable).set({ shirtNumber: body.data.shirtNumber }).where(eq(usersTable.id, user.id));
  }
  res.json({ id: saved.id });
});

router.delete("/m/:code/players/:playerId", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const playerId = intParam(req, "playerId");
  if (!playerId) {
    res.status(400).json({ error: "Invalid player" });
    return;
  }
  const [player] = await db.select().from(matchPlayersTable)
    .where(and(eq(matchPlayersTable.id, playerId), eq(matchPlayersTable.matchId, ctx.room.id)));
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const manager = await canManage(user, ctx);
  const inviter = await playerForUser(ctx.room.id, user.id);
  const mayRemove = manager || (!player.userId && inviter && player.invitedByPlayerId === inviter.id);
  if (!mayRemove) {
    res.status(403).json({ error: "Only the captain can remove players" });
    return;
  }
  if (player.userId) {
    // Signed-up players are marked out rather than deleted, so their votes and clips keep a home.
    await db.update(matchPlayersTable).set({ rsvp: "out", team: null, slotX: null, slotY: null, updatedAt: new Date() })
      .where(eq(matchPlayersTable.id, playerId));
  } else {
    await db.delete(matchPlayersTable).where(eq(matchPlayersTable.id, playerId));
  }
  res.status(204).send();
});

/** Default formation slots (percent of pitch width/height), per side, attacking upward. */
function formationSlots(count: number, side: "A" | "B"): Array<{ x: number; y: number }> {
  const rows = count <= 5 ? [1, 2, 2] : count <= 6 ? [1, 2, 2, 1] : count <= 7 ? [1, 3, 2, 1] : [1, 3, 3, 1];
  const slots: Array<{ x: number; y: number }> = [];
  const half = side === "A" ? [52, 95] : [5, 48];
  rows.forEach((n, r) => {
    const yFrac = rows.length === 1 ? 0.5 : r / (rows.length - 1);
    const y = side === "A" ? half[1] - yFrac * (half[1] - half[0]) : half[0] + yFrac * (half[1] - half[0]);
    for (let i = 0; i < n; i += 1) slots.push({ x: ((i + 1) / (n + 1)) * 100, y });
  });
  return slots;
}

router.post("/m/:code/teams/auto", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  if (!(await canManage(user, ctx))) {
    res.status(403).json({ error: "Only the captain can pick teams" });
    return;
  }
  const shuffle = Boolean((req.body ?? {}).shuffle);
  const roster = (await rosterFor(ctx.room.id)).filter((p) => p.rsvp === "in" || p.rsvp === "maybe");
  const order = shuffle ? [...roster].sort(() => Math.random() - 0.5) : roster;
  const teamA = order.filter((_, i) => i % 2 === 0);
  const teamB = order.filter((_, i) => i % 2 === 1);
  const place = async (players: MatchPlayer[], side: "A" | "B") => {
    const slots = formationSlots(players.length, side);
    await Promise.all(players.map((p, i) => db.update(matchPlayersTable).set({
      team: side, slotX: slots[i]?.x ?? 50, slotY: slots[i]?.y ?? 50, updatedAt: new Date(),
    }).where(eq(matchPlayersTable.id, p.id))));
  };
  await place(teamA, "A");
  await place(teamB, "B");
  const fresh = await loadRoomByCode(ctx.room.code);
  res.json(await roomPayload(req, fresh ?? ctx, user));
});

const roomPatchSchema = z.object({
  title: z.string().trim().max(60).nullable().optional(),
  teamAName: z.string().trim().max(30).nullable().optional(),
  teamBName: z.string().trim().max(30).nullable().optional(),
  teamAColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  teamBColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  playersPerSide: z.number().int().min(3).max(11).optional(),
});

router.patch("/m/:code", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  if (!(await canManage(user, ctx))) {
    res.status(403).json({ error: "Only the captain can change the match" });
    return;
  }
  const body = roomPatchSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid change" });
    return;
  }
  await db.update(matchRoomsTable).set({ ...body.data, updatedAt: new Date() }).where(eq(matchRoomsTable.id, ctx.room.id));
  const fresh = await loadRoomByCode(ctx.room.code);
  res.json(await roomPayload(req, fresh ?? ctx, user));
});

const scoreSchema = z.object({
  scoreA: z.number().int().min(0).max(99),
  scoreB: z.number().int().min(0).max(99),
});

router.post("/m/:code/score", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  if (!(await canManage(user, ctx))) {
    res.status(403).json({ error: "Only the captain can set the score" });
    return;
  }
  const body = scoreSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid score" });
    return;
  }
  await db.update(matchRoomsTable).set({
    scoreA: body.data.scoreA, scoreB: body.data.scoreB, scoreUpdatedAt: new Date(), updatedAt: new Date(),
  }).where(eq(matchRoomsTable.id, ctx.room.id));
  const fresh = await loadRoomByCode(ctx.room.code);
  res.json(await roomPayload(req, fresh ?? ctx, user));
});

const gamesSchema = z.object({
  games: z.array(z.object({
    startOffsetSec: z.number().int().min(0),
    endOffsetSec: z.number().int().min(1),
    scoreA: z.number().int().min(0).max(99).nullable().optional(),
    scoreB: z.number().int().min(0).max(99).nullable().optional(),
  })).max(12),
});

router.put("/m/:code/games", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  if (!(await canManage(user, ctx))) {
    res.status(403).json({ error: "Only the captain can split the match" });
    return;
  }
  const body = gamesSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid games" });
    return;
  }
  const w = matchWindow(ctx.request);
  const total = Math.round((w.endMs - w.startMs) / 1000);
  const games = [...body.data.games].sort((a, b) => a.startOffsetSec - b.startOffsetSec);
  for (let i = 0; i < games.length; i += 1) {
    const g = games[i];
    if (g.endOffsetSec <= g.startOffsetSec || g.endOffsetSec > total + 600 || (i > 0 && g.startOffsetSec < games[i - 1].endOffsetSec)) {
      res.status(400).json({ error: "Games must not overlap and must fit inside the match" });
      return;
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(matchGamesTable).where(eq(matchGamesTable.matchId, ctx.room.id));
    if (games.length) {
      await tx.insert(matchGamesTable).values(games.map((g, idx) => ({
        matchId: ctx.room.id, idx, startOffsetSec: g.startOffsetSec, endOffsetSec: g.endOffsetSec,
        scoreA: g.scoreA ?? null, scoreB: g.scoreB ?? null,
      })));
    }
    // The match score is the number of games won when games carry scores.
    const scored = games.filter((g) => g.scoreA != null && g.scoreB != null);
    if (scored.length) {
      const winsA = scored.filter((g) => (g.scoreA ?? 0) > (g.scoreB ?? 0)).length;
      const winsB = scored.filter((g) => (g.scoreB ?? 0) > (g.scoreA ?? 0)).length;
      await tx.update(matchRoomsTable).set({ scoreA: winsA, scoreB: winsB, scoreUpdatedAt: new Date() })
        .where(eq(matchRoomsTable.id, ctx.room.id));
    }
  });
  const fresh = await loadRoomByCode(ctx.room.code);
  res.json(await roomPayload(req, fresh ?? ctx, user));
});

// ---------------------------------------------------------------- live: flags

const flagSchema = z.object({
  kind: z.enum(["goal", "foul", "offside", "other"]),
  note: z.string().trim().max(200).nullable().optional(),
  atUtc: z.coerce.date().optional(),
});

router.post("/m/:code/flags", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const me = await playerForUser(ctx.room.id, user.id);
  const manager = await canManage(user, ctx);
  if (!manager && !isPlaying(me)) {
    res.status(403).json({ error: "Only players in this match can flag moments" });
    return;
  }
  const body = flagSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid flag" });
    return;
  }
  const w = matchWindow(ctx.request);
  const now = Date.now();
  if (!Number.isFinite(w.startMs) || now < w.startMs - VAR_OPEN_BEFORE_MS || now > w.endMs + 30 * 60 * 1000) {
    res.status(409).json({ error: "Flagging is open only during the match" });
    return;
  }
  const at = body.data.atUtc ?? new Date(now);
  const atMs = at.getTime();
  if (atMs < w.startMs - VAR_OPEN_BEFORE_MS || atMs > w.endMs + VAR_CLOSE_AFTER_MS) {
    res.status(400).json({ error: "That moment is outside the match" });
    return;
  }
  const [mark] = await db.insert(varMarksTable).values({
    footageRequestId: ctx.request.id,
    atUtc: at,
    kind: body.data.kind,
    note: body.data.note || null,
    createdBy: user.id,
  }).returning();
  res.status(201).json({
    id: mark.id, kind: mark.kind, atUtc: mark.atUtc.toISOString(),
    offsetSeconds: (mark.atUtc.getTime() - w.startMs) / 1000,
  });
});

// ---------------------------------------------------------------- after: vote

router.post("/m/:code/vote", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const me = await playerForUser(ctx.room.id, user.id);
  if (!isPlaying(me)) {
    res.status(403).json({ error: "Only players in this match can vote" });
    return;
  }
  if (!voteOpen(ctx.request)) {
    res.status(409).json({ error: "Voting is closed" });
    return;
  }
  const candidateId = Number((req.body ?? {}).candidatePlayerId);
  const [candidate] = await db.select().from(matchPlayersTable)
    .where(and(eq(matchPlayersTable.id, candidateId), eq(matchPlayersTable.matchId, ctx.room.id)));
  if (!candidate || candidate.rsvp !== "in") {
    res.status(400).json({ error: "Pick someone who played" });
    return;
  }
  if (candidate.id === me!.id) {
    res.status(400).json({ error: "You can't vote for yourself" });
    return;
  }
  await db.insert(motmVotesTable).values({
    matchId: ctx.room.id, voterUserId: user.id, candidatePlayerId: candidate.id,
  }).onConflictDoUpdate({
    target: [motmVotesTable.matchId, motmVotesTable.voterUserId],
    set: { candidatePlayerId: candidate.id, updatedAt: new Date() },
  });
  const fresh = await loadRoomByCode(ctx.room.code);
  res.json(await roomPayload(req, fresh ?? ctx, user));
});

// ---------------------------------------------------------------- clips of the match

router.get("/m/:code/clips", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const viewer = await optionalUser(req);
  const me = viewer && !viewer.isGuest ? await playerForUser(ctx.room.id, viewer.id) : null;
  const member = Boolean(viewer && (isPlaying(me) || ctx.room.captainUserId === viewer.id));
  const visibilities = member ? ["match", "public"] : ["public"];
  const rows = await db.select({
    clip: userClipsTable,
    userName: usersTable.name,
    avatarPath: usersTable.avatarPath,
  }).from(userClipsTable)
    .innerJoin(usersTable, eq(usersTable.id, userClipsTable.userId))
    .where(and(
      eq(userClipsTable.footageRequestId, ctx.request.id),
      eq(userClipsTable.isHidden, false),
      viewer && !viewer.isGuest
        ? or(inArray(userClipsTable.visibility, visibilities), eq(userClipsTable.userId, viewer.id))!
        : inArray(userClipsTable.visibility, visibilities),
    ))
    .orderBy(desc(userClipsTable.createdAt));
  const w = matchWindow(ctx.request);
  res.json(rows.map(({ clip, userName, avatarPath }) => ({
    id: clip.id,
    title: clip.title,
    startTime: Number(clip.startTime),
    endTime: Number(clip.endTime),
    duration: Number(clip.endTime) - Number(clip.startTime),
    aspectRatio: clip.aspectRatio,
    visibility: clip.visibility,
    createdAt: clip.createdAt.toISOString(),
    exportStatus: clip.exportStatus,
    likeCount: clip.likeCount,
    mine: viewer ? clip.userId === viewer.id : false,
    by: { userId: clip.userId, name: userName, avatarUrl: avatarUrlFor(clip.userId, avatarPath) },
    matchStartMs: w.startMs,
  })));
});

// ---------------------------------------------------------------- stats purchases

function paymentReference(prefix: string): string {
  return `${prefix}-${randomToken(3).toUpperCase()}`;
}

router.post("/m/:code/stats/unlock", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const user = await requirePlayer(req, res);
  if (!user) return;
  const kind = (req.body ?? {}).kind === "team" ? "team" : "match";
  const me = await playerForUser(ctx.room.id, user.id);
  if (!isPlaying(me) && ctx.room.captainUserId !== user.id) {
    res.status(403).json({ error: "Only players in this match can unlock its stats" });
    return;
  }
  if (kind === "team" && !(await canManage(user, ctx))) {
    res.status(403).json({ error: "Only the captain can unlock stats for the team" });
    return;
  }
  const [existing] = await db.select().from(statUnlocksTable).where(and(
    eq(statUnlocksTable.userId, user.id), eq(statUnlocksTable.matchId, ctx.room.id),
    eq(statUnlocksTable.kind, kind), inArray(statUnlocksTable.status, ["pending", "paid"]),
  ));
  if (existing) {
    res.json({ reference: existing.reference, status: existing.status, amountFils: existing.amountFils, cliqAlias: CLIQ_ALIAS });
    return;
  }
  const amountFils = kind === "team" ? STATS_MATCH_FILS * ctx.room.playersPerSide * 2 : STATS_MATCH_FILS;
  const [created] = await db.insert(statUnlocksTable).values({
    userId: user.id, matchId: ctx.room.id, kind, amountFils, reference: paymentReference(`RP${ctx.room.code}`),
  }).returning();
  res.status(201).json({ reference: created.reference, status: created.status, amountFils, cliqAlias: CLIQ_ALIAS });
});

router.post("/me/stats-plan", async (req, res): Promise<void> => {
  const user = await requirePlayer(req, res);
  if (!user) return;
  const [existing] = await db.select().from(statUnlocksTable).where(and(
    eq(statUnlocksTable.userId, user.id), eq(statUnlocksTable.kind, "monthly"), eq(statUnlocksTable.status, "pending"),
  ));
  if (existing) {
    res.json({ reference: existing.reference, status: existing.status, amountFils: existing.amountFils, cliqAlias: CLIQ_ALIAS });
    return;
  }
  const [created] = await db.insert(statUnlocksTable).values({
    userId: user.id, kind: "monthly", amountFils: STATS_MONTHLY_FILS, reference: paymentReference("RPM"),
  }).returning();
  res.status(201).json({ reference: created.reference, status: created.status, amountFils: created.amountFils, cliqAlias: CLIQ_ALIAS });
});

router.get("/admin/stat-unlocks", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user?.isAdmin) {
    res.status(user ? 403 : 401).json({ error: "Admin access required" });
    return;
  }
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const rows = await db.select({
    unlock: statUnlocksTable,
    userName: usersTable.name,
    userEmail: usersTable.email,
    userPhone: usersTable.phone,
    code: matchRoomsTable.code,
  }).from(statUnlocksTable)
    .innerJoin(usersTable, eq(usersTable.id, statUnlocksTable.userId))
    .leftJoin(matchRoomsTable, eq(matchRoomsTable.id, statUnlocksTable.matchId))
    .where(status === "all" ? sql`true` : eq(statUnlocksTable.status, status))
    .orderBy(desc(statUnlocksTable.createdAt))
    .limit(200);
  res.json(rows.map(({ unlock, userName, userEmail, userPhone, code }) => ({
    id: unlock.id, kind: unlock.kind, amountFils: unlock.amountFils, reference: unlock.reference,
    status: unlock.status, createdAt: unlock.createdAt.toISOString(), confirmedAt: unlock.confirmedAt?.toISOString() ?? null,
    validUntil: unlock.validUntil?.toISOString() ?? null,
    user: { id: unlock.userId, name: userName, email: userEmail, phone: userPhone },
    matchCode: code,
  })));
});

router.post("/admin/stat-unlocks/:id/:action", async (req, res): Promise<void> => {
  const user = await getLocalUserRecord(req);
  if (!user?.isAdmin) {
    res.status(user ? 403 : 401).json({ error: "Admin access required" });
    return;
  }
  const id = intParam(req, "id");
  const action = param(req, "action");
  if (!id || (action !== "confirm" && action !== "reject")) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }
  const [row] = await db.select().from(statUnlocksTable).where(eq(statUnlocksTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const now = new Date();
  const [saved] = await db.update(statUnlocksTable).set(action === "confirm" ? {
    status: "paid",
    confirmedBy: user.id,
    confirmedAt: now,
    validUntil: row.kind === "monthly" ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) : null,
  } : { status: "rejected", confirmedBy: user.id, confirmedAt: now })
    .where(eq(statUnlocksTable.id, id)).returning();
  res.json({ id: saved.id, status: saved.status });
});

// ---------------------------------------------------------------- avatars

router.post("/me/avatar", avatarUpload.single("photo"), async (req, res): Promise<void> => {
  const user = await requirePlayer(req, res);
  if (!user) return;
  const file = (req as Request & { file?: { buffer: Buffer; mimetype: string } }).file;
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
    res.status(400).json({ error: "Upload a JPG, PNG or WebP photo" });
    return;
  }
  if (!isBunnyStorageConfigured()) {
    res.status(503).json({ error: "Photo storage is not configured" });
    return;
  }
  const ext = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
  const path = `avatars/u${user.id}-${randomToken(6)}.${ext}`;
  try {
    await uploadBufferToBunnyStorage(file.buffer, path, file.mimetype);
  } catch (error) {
    logger.error({ error, userId: user.id }, "avatar upload failed");
    res.status(502).json({ error: "Upload failed, try again" });
    return;
  }
  await db.update(usersTable).set({ avatarPath: path }).where(eq(usersTable.id, user.id));
  res.json({ avatarUrl: avatarUrlFor(user.id, path) });
});

router.delete("/me/avatar", async (req, res): Promise<void> => {
  const user = await requirePlayer(req, res);
  if (!user) return;
  await db.update(usersTable).set({ avatarPath: null }).where(eq(usersTable.id, user.id));
  res.status(204).send();
});

router.get("/users/:id/avatar", async (req, res): Promise<void> => {
  const id = intParam(req, "id");
  if (!id) {
    res.status(404).end();
    return;
  }
  const [row] = await db.select({ avatarPath: usersTable.avatarPath }).from(usersTable).where(eq(usersTable.id, id));
  if (!row?.avatarPath) {
    res.status(404).end();
    return;
  }
  const upstreamUrl = `https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${row.avatarPath}`;
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(upstreamUrl, { headers: { AccessKey: BUNNY_STORAGE_API_KEY } });
  } catch {
    res.status(502).end();
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status === 404 ? 404 : 502).end();
    return;
  }
  const ext = row.avatarPath.split(".").pop();
  res.setHeader("Content-Type", ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");
  // The URL carries a version, so a new photo is a new URL.
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.removeHeader("Vary");
  await pipeline(Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>), res).catch(() => undefined);
});

// ---------------------------------------------------------------- public profile

router.get("/users/:id/replay-profile", async (req, res): Promise<void> => {
  const id = intParam(req, "id");
  if (!id) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [user] = await db.select({
    id: usersTable.id, name: usersTable.name, position: usersTable.position,
    avatarPath: usersTable.avatarPath, shirtNumber: usersTable.shirtNumber, isGuest: usersTable.isGuest,
  }).from(usersTable).where(eq(usersTable.id, id));
  if (!user || user.isGuest) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rooms = await roomsForUser(id);
  const base = publicBaseUrl(req);
  let played = 0;
  let motm = 0;
  let wins = 0;
  const recent: Array<Record<string, unknown>> = [];
  for (const ctx of rooms) {
    const phase = matchPhase(ctx.request);
    if (!["processing", "ready", "expired"].includes(phase)) continue;
    const me = await playerForUser(ctx.room.id, id);
    if (!isPlaying(me)) continue;
    played += 1;
    const roster = await rosterFor(ctx.room.id);
    const vote = await voteSummary(ctx, null, roster);
    const isMotm = vote.winners.includes(me!.id);
    if (isMotm) motm += 1;
    const score = ctx.room.scoreA !== null && ctx.room.scoreB !== null ? { a: ctx.room.scoreA, b: ctx.room.scoreB } : null;
    const won = score && me!.team ? (me!.team === "A" ? score.a > score.b : score.b > score.a) : false;
    if (won) wins += 1;
    recent.push({
      code: ctx.room.code, url: `${base}/m/${ctx.room.code}`, startLocal: ctx.request.startLocal,
      field: { id: ctx.field.id, name: ctx.field.name }, score, team: me!.team, won, motm: isMotm,
      startMs: matchWindow(ctx.request).startMs,
    });
  }
  recent.sort((a, b) => Number(b.startMs) - Number(a.startMs));
  const clipRows = await db.select({ n: sql<number>`count(*)::int` }).from(userClipsTable)
    .where(and(eq(userClipsTable.userId, id), eq(userClipsTable.visibility, "public"), eq(userClipsTable.isHidden, false)));
  res.json({
    id: user.id,
    name: user.name,
    position: user.position,
    shirtNumber: user.shirtNumber,
    avatarUrl: avatarUrlFor(user.id, user.avatarPath),
    matchesPlayed: played,
    wins,
    motmCount: motm,
    publicClips: clipRows[0]?.n ?? 0,
    recent: recent.slice(0, 12),
  });
});

// ---------------------------------------------------------------- calendar

router.get("/m/:code/calendar.ics", async (req, res): Promise<void> => {
  const ctx = await loadOr404(req, res);
  if (!ctx) return;
  const w = matchWindow(ctx.request);
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const base = publicBaseUrl(req);
  const title = ctx.room.title || `Match at ${ctx.field.name}`;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Replay//Match//EN", "BEGIN:VEVENT",
    `UID:replay-${ctx.room.code}@replayjo.com`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(w.startMs)}`, `DTEND:${stamp(w.endMs)}`,
    `SUMMARY:${title.replace(/[,;\\]/g, " ")}`,
    `LOCATION:${`${ctx.field.name} ${ctx.field.location ?? ""}`.trim().replace(/[,;\\]/g, " ")}`,
    `DESCRIPTION:VAR opens 3 minutes before kick-off. ${base}/m/${ctx.room.code}`,
    `URL:${base}/m/${ctx.room.code}`,
    "BEGIN:VALARM", "TRIGGER:-PT60M", "ACTION:DISPLAY", "DESCRIPTION:Match in one hour", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="replay-${ctx.room.code}.ics"`);
  res.send(lines.join("\r\n"));
});

export { TEAM_COLORS };
export default router;

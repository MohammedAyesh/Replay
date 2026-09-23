import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  fieldsTable,
  footageRequestsTable,
  matchPlayersTable,
  matchRoomsTable,
  type MatchPlayer,
  type MatchRoom,
} from "@workspace/db";
import { logger } from "./logger";

type FootageRequest = typeof footageRequestsTable.$inferSelect;
type Field = typeof fieldsTable.$inferSelect;

export const AMMAN_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
export const VAR_OPEN_BEFORE_MS = 3 * 60 * 1000;
export const VAR_CLOSE_AFTER_MS = 5 * 60 * 1000;
export const VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FOOTAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// Prices live in Admin -> Settings; see lib/commerce.ts.

export type TeamSide = "A" | "B" | "C";

export function teamSides(teamCount: number): TeamSide[] {
  return teamCount >= 3 ? ["A", "B", "C"] : ["A", "B"];
}

export interface GameResult {
  teamX: string;
  teamY: string;
  scoreA: number | null;
  scoreB: number | null;
}

export interface StandingRow {
  team: TeamSide;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

/**
 * The table for a multi-game session: 3 points a win, 1 a draw. Games without a
 * score are ignored. Sorted by points, then goal difference, then goals scored.
 */
export function computeStandings(games: readonly GameResult[], teamCount: number): StandingRow[] {
  const sides = teamSides(teamCount);
  const rows = new Map<TeamSide, StandingRow>(sides.map((team) => [team, {
    team, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0,
  }]));
  for (const g of games) {
    if (g.scoreA == null || g.scoreB == null) continue;
    const x = rows.get(g.teamX as TeamSide);
    const y = rows.get(g.teamY as TeamSide);
    if (!x || !y || x === y) continue;
    x.played += 1; y.played += 1;
    x.goalsFor += g.scoreA; x.goalsAgainst += g.scoreB;
    y.goalsFor += g.scoreB; y.goalsAgainst += g.scoreA;
    if (g.scoreA > g.scoreB) { x.won += 1; y.lost += 1; x.points += 3; }
    else if (g.scoreB > g.scoreA) { y.won += 1; x.lost += 1; y.points += 3; }
    else { x.drawn += 1; y.drawn += 1; x.points += 1; y.points += 1; }
  }
  return [...rows.values()].sort((a, b) =>
    b.points - a.points
    || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst)
    || b.goalsFor - a.goalsFor
    || a.team.localeCompare(b.team));
}

/** The outright leader of the table, or null when nobody has played or the top is tied. */
export function standingsLeader(rows: readonly StandingRow[]): TeamSide | null {
  const [first, second] = rows;
  if (!first || first.played === 0) return null;
  if (second && second.points === first.points
    && second.goalsFor - second.goalsAgainst === first.goalsFor - first.goalsAgainst
    && second.goalsFor === first.goalsFor) return null;
  return first.team;
}

const ACTIVE_STATUSES = new Set(["queued", "running", "scheduled", "recording"]);
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type MatchPhase =
  | "pre" // booked, before VAR opens
  | "live" // VAR window: 3 min before kick-off to 5 min after the whistle
  | "processing" // whistle blown, full-quality footage being prepared
  | "ready" // footage ready, share link active
  | "expired" // footage past retention; the match lives on as a memory
  | "failed"
  | "cancelled";

/** "YYYY-MM-DD HH:MM" Amman local → UTC epoch ms (NaN if malformed). */
export function ammanLocalInstant(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  const epoch = Date.UTC(y, mo - 1, d, h, mi);
  return epoch - AMMAN_UTC_OFFSET_MS;
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function newRoomCode(length = 6): string {
  const random = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[random[i] % CODE_ALPHABET.length];
  return code;
}

export function normalizeCode(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 12);
}

export function matchPhase(request: Pick<FootageRequest, "startLocal" | "endLocal" | "status" | "readyAt" | "shareRevoked" | "shareExpiresAt">, now = Date.now()): MatchPhase {
  if (request.status === "cancelled") return "cancelled";
  if (request.status === "failed") return "failed";
  // A player booking waiting on its payment stays "upcoming" until the slot is over.
  if (request.status === "awaiting_payment") {
    const endMs = ammanLocalInstant(request.endLocal);
    return Number.isFinite(endMs) && now > endMs ? "processing" : "pre";
  }
  const start = ammanLocalInstant(request.startLocal);
  const end = ammanLocalInstant(request.endLocal);
  if (request.status === "ready" || request.status === "partial") {
    const expiresAt = request.shareExpiresAt?.getTime()
      ?? ((request.readyAt?.getTime() ?? end) + FOOTAGE_RETENTION_MS);
    return now > expiresAt ? "expired" : "ready";
  }
  if (Number.isFinite(start) && now < start - VAR_OPEN_BEFORE_MS) return "pre";
  if (Number.isFinite(end) && now <= end + VAR_CLOSE_AFTER_MS && ACTIVE_STATUSES.has(request.status)) return "live";
  return "processing";
}

export function matchWindow(request: Pick<FootageRequest, "startLocal" | "endLocal">) {
  const start = ammanLocalInstant(request.startLocal);
  const end = ammanLocalInstant(request.endLocal);
  return {
    startsAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
    endsAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    varOpensAt: Number.isFinite(start) ? new Date(start - VAR_OPEN_BEFORE_MS).toISOString() : null,
    varClosesAt: Number.isFinite(end) ? new Date(end + VAR_CLOSE_AFTER_MS).toISOString() : null,
    voteClosesAt: Number.isFinite(end) ? new Date(end + VOTE_WINDOW_MS).toISOString() : null,
    startMs: start,
    endMs: end,
  };
}

export function voteOpen(request: Pick<FootageRequest, "startLocal" | "endLocal" | "status">, now = Date.now()): boolean {
  if (request.status === "cancelled" || request.status === "failed") return false;
  const end = ammanLocalInstant(request.endLocal);
  const start = ammanLocalInstant(request.startLocal);
  // Opens at kick-off + half the match so a vote is possible from the car park,
  // and closes 24 h after the whistle.
  if (!Number.isFinite(end) || !Number.isFinite(start)) return false;
  return now >= end - 10 * 60 * 1000 && now <= end + VOTE_WINDOW_MS;
}

/**
 * Every booking gets exactly one room. Safe to call repeatedly and
 * concurrently: the unique constraint on footage_request_id wins races and the
 * loser simply re-reads.
 */
export async function ensureRoomForRequest(request: Pick<FootageRequest, "id" | "fieldId">): Promise<MatchRoom> {
  const [existing] = await db.select().from(matchRoomsTable)
    .where(eq(matchRoomsTable.footageRequestId, request.id));
  if (existing) return existing;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const [created] = await db.insert(matchRoomsTable).values({
        footageRequestId: request.id,
        fieldId: request.fieldId,
        code: newRoomCode(),
        captainToken: randomToken(12),
      }).onConflictDoNothing().returning();
      if (created) return created;
      const [raced] = await db.select().from(matchRoomsTable)
        .where(eq(matchRoomsTable.footageRequestId, request.id));
      if (raced) return raced;
      // Conflict was on the code: try another one.
    } catch (error) {
      logger.warn({ error, requestId: request.id, attempt }, "match room insert failed, retrying");
    }
  }
  throw new Error("Could not create a match room");
}

/** Create rooms for any bookings that predate match rooms. Cheap and idempotent. */
export async function backfillMatchRooms(): Promise<number> {
  const rows = await db.select({ id: footageRequestsTable.id, fieldId: footageRequestsTable.fieldId })
    .from(footageRequestsTable)
    .leftJoin(matchRoomsTable, eq(matchRoomsTable.footageRequestId, footageRequestsTable.id))
    .where(isNull(matchRoomsTable.id));
  let created = 0;
  for (const row of rows) {
    try {
      await ensureRoomForRequest(row);
      created += 1;
    } catch (error) {
      logger.warn({ error, requestId: row.id }, "match room backfill failed");
    }
  }
  return created;
}

export type RoomContext = {
  room: MatchRoom;
  request: FootageRequest;
  field: Field;
};

export async function loadRoomByCode(code: string): Promise<RoomContext | null> {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const [row] = await db.select({
    room: matchRoomsTable,
    request: footageRequestsTable,
    field: fieldsTable,
  }).from(matchRoomsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
    .where(eq(matchRoomsTable.code, normalized));
  return row ?? null;
}

export async function loadRoomByRequestId(requestId: number): Promise<RoomContext | null> {
  const [row] = await db.select({
    room: matchRoomsTable,
    request: footageRequestsTable,
    field: fieldsTable,
  }).from(matchRoomsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
    .where(eq(matchRoomsTable.footageRequestId, requestId));
  return row ?? null;
}

export async function rosterFor(matchId: number): Promise<MatchPlayer[]> {
  return db.select().from(matchPlayersTable)
    .where(eq(matchPlayersTable.matchId, matchId))
    .orderBy(asc(matchPlayersTable.createdAt), asc(matchPlayersTable.id));
}

export async function playerForUser(matchId: number, userId: number): Promise<MatchPlayer | null> {
  const [player] = await db.select().from(matchPlayersTable)
    .where(and(eq(matchPlayersTable.matchId, matchId), eq(matchPlayersTable.userId, userId)));
  return player ?? null;
}

/** A player counts as "on the roster" for VAR, votes and flags once they said they're in. */
export function isPlaying(player: Pick<MatchPlayer, "rsvp"> | null | undefined): boolean {
  return player?.rsvp === "in";
}

/** Is this user an "in" player on the room that belongs to this booking? */
export async function isRosterMemberOfRequest(userId: number, footageRequestId: number): Promise<boolean> {
  const [row] = await db.select({ rsvp: matchPlayersTable.rsvp, captain: matchRoomsTable.captainUserId })
    .from(matchRoomsTable)
    .leftJoin(matchPlayersTable, and(
      eq(matchPlayersTable.matchId, matchRoomsTable.id),
      eq(matchPlayersTable.userId, userId),
    ))
    .where(eq(matchRoomsTable.footageRequestId, footageRequestId));
  if (!row) return false;
  return row.captain === userId || row.rsvp === "in";
}

export async function roomsForUser(userId: number): Promise<RoomContext[]> {
  const memberships = await db.select({ matchId: matchPlayersTable.matchId })
    .from(matchPlayersTable)
    .where(and(eq(matchPlayersTable.userId, userId), inArray(matchPlayersTable.rsvp, ["in", "maybe", "invited"])));
  const captainOf = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable)
    .where(eq(matchRoomsTable.captainUserId, userId));
  const ids = Array.from(new Set([...memberships.map((m) => m.matchId), ...captainOf.map((c) => c.id)]));
  if (!ids.length) return [];
  return db.select({
    room: matchRoomsTable,
    request: footageRequestsTable,
    field: fieldsTable,
  }).from(matchRoomsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .innerJoin(fieldsTable, eq(fieldsTable.id, matchRoomsTable.fieldId))
    .where(inArray(matchRoomsTable.id, ids));
}

export function publicBaseUrl(req: { headers: Record<string, unknown>; protocol?: string; get?: (name: string) => string | undefined }): string {
  const configured = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]) || req.protocol || "https";
  const host = (String(req.headers["x-forwarded-host"] ?? "").split(",")[0]) || req.get?.("host") || "";
  return `${proto}://${host}`;
}

export function avatarUrlFor(userId: number, avatarPath: string | null | undefined): string | null {
  if (!avatarPath) return null;
  // The path carries a random suffix, so its tail doubles as a cache buster.
  const version = avatarPath.split("-").pop()?.replace(/\.\w+$/, "") ?? "0";
  return `/api/users/${userId}/avatar?v=${encodeURIComponent(version)}`;
}

export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/[^\d+]/g, "");
  if (!digits) return null;
  // Jordan: 07XXXXXXXX → +9627XXXXXXXX so both spellings match.
  if (/^07\d{8}$/.test(digits)) return `+962${digits.slice(1)}`;
  if (/^9627\d{8}$/.test(digits)) return `+${digits}`;
  if (/^00/.test(digits)) return `+${digits.slice(2)}`;
  return digits;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

export function formatJod(fils: number): string {
  const jod = fils / 1000;
  return `${Number.isInteger(jod) ? jod.toFixed(0) : jod.toFixed(jod * 10 % 1 === 0 ? 1 : 2)} JOD`;
}

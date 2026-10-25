import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import {
  academyMembersTable, academyPlayerGuardiansTable, academyPlayersTable,
  academySessionsTable, academiesTable, db, fieldsTable, footageRequestsTable,
} from "@workspace/db";
import { getLocalUserRecord } from "../lib/clerkUserBridge";
import { requireAcademyConsoleUser } from "../lib/academyAccess";
import { ammanLocalInstant } from "../lib/matchRooms";
import { describeLive, parseLiveManifest } from "../lib/liveManifest";
import { parseLiveCamera, parseVarControlCamera } from "../lib/liveCameras";
import { canViewPinnedAcademyRecording } from "../lib/publicFootage";
import { liveSegmentNames, pipeLiveSegment, rewriteLivePlaylist } from "../lib/liveHlsProxy";
import { controlFetch, controlResponse } from "./contabo";
import { logger } from "../lib/logger";

const router: IRouter = Router();
type Surface = "console" | "family";
type SessionLive = {
  sessionId: number; academyId: number; squadId: number | null; cameraId: string | null;
  booking: { startLocal: string; endLocal: string; status: string } | null;
};
type Camera = { alias: string; control: string } | null;

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function varCamera(value: string | null): Camera {
  const control = parseVarControlCamera(value ?? undefined);
  const alias = parseLiveCamera(value ?? undefined)
    ?? (control ? parseLiveCamera(`camera${control.slice(3)}`) : null);
  return control && alias ? { alias, control } : null;
}

async function sessionFor(academyId: number, sessionId: number): Promise<SessionLive | null> {
  const [row] = await db.select({
    sessionId: academySessionsTable.id,
    academyId: academySessionsTable.academyId,
    squadId: academySessionsTable.squadId,
    footageRequestId: academySessionsTable.footageRequestId,
    cameraId: fieldsTable.cameraId,
  }).from(academySessionsTable)
    .innerJoin(academiesTable, eq(academiesTable.id, academySessionsTable.academyId))
    .leftJoin(fieldsTable, eq(fieldsTable.id, academiesTable.fieldId))
    .where(and(eq(academySessionsTable.id, sessionId), eq(academySessionsTable.academyId, academyId)));
  if (!row) return null;
  const [booking] = row.footageRequestId === null ? [] : await db.select({
    startLocal: footageRequestsTable.startLocal,
    endLocal: footageRequestsTable.endLocal,
    status: footageRequestsTable.status,
  }).from(footageRequestsTable).where(eq(footageRequestsTable.id, row.footageRequestId));
  return { ...row, booking: booking ?? null };
}

async function canViewFamilySession(userId: number, session: SessionLive): Promise<boolean> {
  const [members, players, guardianLinks] = await Promise.all([
    db.select({ academyId: academyMembersTable.academyId }).from(academyMembersTable)
      .where(and(eq(academyMembersTable.userId, userId), eq(academyMembersTable.academyId, session.academyId))),
    db.select({
      id: academyPlayersTable.id,
      academyId: academyPlayersTable.academyId,
      squadId: academyPlayersTable.squadId,
      userId: academyPlayersTable.userId,
      isActive: academyPlayersTable.isActive,
    }).from(academyPlayersTable).where(eq(academyPlayersTable.academyId, session.academyId)),
    db.select({ playerId: academyPlayerGuardiansTable.playerId }).from(academyPlayerGuardiansTable)
      .where(eq(academyPlayerGuardiansTable.userId, userId)),
  ]);
  return canViewPinnedAcademyRecording(
    userId,
    { academyId: session.academyId, sessionSquadId: session.squadId },
    new Set(members.map(({ academyId }) => academyId)),
    players,
    new Set(guardianLinks.map(({ playerId }) => playerId)),
  );
}

async function authorizedSession(
  req: import("express").Request,
  res: Response,
  surface: Surface,
): Promise<SessionLive | null> {
  let userId: number;
  let academyId: number;
  const sessionId = Number(param(req.params.sessionId));
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  if (surface === "console") {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return null;
    userId = user.id;
    academyId = Number(param(req.params.academyId));
    if (!Number.isSafeInteger(academyId) || academyId < 1) {
      res.status(404).json({ error: "Session not found" });
      return null;
    }
  } else {
    const user = await getLocalUserRecord(req);
    if (!user || user.isGuest || user.isDisabled) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    userId = user.id;
    const [found] = await db.select({ academyId: academySessionsTable.academyId })
      .from(academySessionsTable).where(eq(academySessionsTable.id, sessionId));
    if (!found) {
      res.status(404).json({ error: "Session not found" });
      return null;
    }
    academyId = found.academyId;
  }
  const session = await sessionFor(academyId, sessionId);
  const hasConsoleMembership = surface === "console" && (await db.select({ id: academyMembersTable.id })
    .from(academyMembersTable)
    .where(and(
      eq(academyMembersTable.userId, userId),
      eq(academyMembersTable.academyId, academyId),
    ))).length > 0;
  if (!session
    || (surface === "console" && !hasConsoleMembership)
    || (surface === "family" && !(await canViewFamilySession(userId, session)))) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return session;
}

function bookingWindow(session: SessionLive) {
  const booking = session.booking;
  if (!booking || ["failed", "cancelled", "canceled"].includes(booking.status.toLowerCase())) return null;
  const start = ammanLocalInstant(booking.startLocal) - 3 * 60_000;
  const end = ammanLocalInstant(booking.endLocal) + 5 * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start: new Date(start), end: new Date(end) };
}

async function statusResponse(session: SessionLive, sessionId: number, base: string) {
  const camera = varCamera(session.cameraId);
  const window = bookingWindow(session);
  const baseResponse = {
    status: "no_booking" as string,
    windowStartsAt: window?.start.toISOString() ?? null,
    windowEndsAt: window?.end.toISOString() ?? null,
    camera: camera?.alias ?? null,
    variant: "hls" as const,
    playlistPath: null as string | null,
    message: "No live footage booking is available for this session.",
    panAvailable: false as const,
  };
  if (!window) return baseResponse;
  if (!camera) return { ...baseResponse, status: "not_live", message: "No camera is assigned to this academy." };
  const now = Date.now();
  const playlistPath = `${base}/playlist.m3u8`;
  if (now < window.start.getTime()) return { ...baseResponse, status: "upcoming", playlistPath, message: "Live viewing opens shortly before the booking." };
  if (now > window.end.getTime()) return { ...baseResponse, status: "ended", playlistPath: null, message: "The live viewing window has ended." };
  const path = `/var/${encodeURIComponent(camera.control)}/hls/playlist.m3u8`;
  try {
    const upstream = await controlFetch(path, {}, 15_000);
    if (!upstream.ok || typeof upstream.body !== "string") {
      return { ...baseResponse, status: "not_live", playlistPath, message: "The camera stream is not available right now." };
    }
    const live = describeLive(parseLiveManifest(upstream.body), new Date());
    return {
      ...baseResponse,
      status: live.live ? "live" : live.reason === "ended" ? "ended" : "not_live",
      playlistPath: live.live ? playlistPath : null,
      message: live.live ? "Live now" : live.reason === "ended" ? "The camera stream has ended." : "Waiting for the camera stream.",
    };
  } catch (error) {
    logger.warn({ error, sessionId }, "Academy live status check failed");
    return { ...baseResponse, status: "not_live", playlistPath, message: "Live status is temporarily unavailable." };
  }
}

/**
 * The browser-facing URL of a session's live routes. It is built from the authorized
 * session, not from the Express route pattern, and carries the /api prefix the web
 * app uses for every other API call.
 */
function sessionLiveBase(surface: Surface, session: SessionLive): string {
  return surface === "console"
    ? `/api/academy/console/academies/${session.academyId}/sessions/${session.sessionId}/live`
    : `/api/academy/family/sessions/${session.sessionId}/live`;
}

function register(surface: Surface, path: string) {
  const base = path.replace(/\/status$/, "");
  router.get(path, async (req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    const session = await authorizedSession(req, res, surface);
    if (!session) return;
    res.json(await statusResponse(session, session.sessionId, sessionLiveBase(surface, session)));
  });
  router.get(`${base}/playlist.m3u8`, async (req, res): Promise<void> => {
    const session = await authorizedSession(req, res, surface);
    if (!session) return;
    const window = bookingWindow(session);
    const camera = varCamera(session.cameraId);
    if (!window || !camera || Date.now() < window.start.getTime() || Date.now() > window.end.getTime()) {
      res.status(404).json({ error: "Live playback is outside this session window" });
      return;
    }
    try {
      const upstream = await controlResponse(`/var/${encodeURIComponent(camera.control)}/hls/playlist.m3u8`, {}, 15_000);
      if (!upstream.ok) {
        res.status(502).json({ error: "Live playlist unavailable" });
        return;
      }
      const playlist = rewriteLivePlaylist(
        await upstream.text(),
        `${sessionLiveBase(surface, session)}/seg/`,
        new Date(ammanLocalInstant(session.booking!.startLocal)),
      );
      if (!playlist) {
        res.status(502).json({ error: "Live playlist has no safe booking-boundary timestamps" });
        return;
      }
      res.set("Cache-Control", "no-store").type("application/vnd.apple.mpegurl").send(playlist);
    } catch (error) {
      logger.warn({ error, sessionId: session.sessionId }, "Academy live playlist proxy failed");
      res.status(502).json({ error: "Live playlist unavailable" });
    }
  });
  router.get(`${base}/seg/:name`, async (req, res): Promise<void> => {
    const session = await authorizedSession(req, res, surface);
    if (!session) return;
    const name = param(req.params.name);
    const camera = varCamera(session.cameraId);
    const window = bookingWindow(session);
    if (!/^[A-Za-z0-9._-]+\.(?:ts|m4s|mp4)$/i.test(name)) {
      res.status(400).json({ error: "Invalid live segment" });
      return;
    }
    if (!window || !camera || Date.now() < window.start.getTime() || Date.now() > window.end.getTime()) {
      res.status(404).json({ error: "Live playback is outside this session window" });
      return;
    }
    try {
      // Serve only a segment the trimmed playlist for this session would list: vps1's
      // rolling window can still hold footage from before the booking started.
      const listing = await controlResponse(`/var/${encodeURIComponent(camera.control)}/hls/playlist.m3u8`, {}, 15_000);
      if (!listing.ok) {
        res.status(502).json({ error: "Live playlist unavailable" });
        return;
      }
      const allowed = liveSegmentNames(await listing.text(), new Date(ammanLocalInstant(session.booking!.startLocal)));
      if (!allowed?.has(name)) {
        res.status(404).json({ error: "Live segment is outside this session window" });
        return;
      }
      const upstream = await controlResponse(
        `/var/${encodeURIComponent(camera.control)}/hls/seg/${encodeURIComponent(name)}`,
        {},
        30_000,
      );
      pipeLiveSegment(upstream, res, (error) => {
        logger.warn({ error, sessionId: session.sessionId, name }, "Academy live segment stream failed");
      });
    } catch (error) {
      logger.warn({ error, sessionId: session.sessionId, name }, "Academy live segment proxy failed");
      res.status(502).json({ error: "Live segment unavailable" });
    }
  });
}

register("console", "/academy/console/academies/:academyId/sessions/:sessionId/live/status");
register("family", "/academy/family/sessions/:sessionId/live/status");
export default router;

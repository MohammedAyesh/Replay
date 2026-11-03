import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { academiesTable, academyPlayerClipsTable, academyPlayersTable, academySessionsTable, academyTrialClipsTable, db, userClipsTable } from "@workspace/db";
import { getClipExportCdnUrl } from "../lib/bunny";
import { fetchExportObject, probeExportObject } from "../lib/backupExport";
import { CLIP_PLAYBACK_RANGE_MAX_BYTES, planExportRange, sendBoundedExport } from "../lib/exportPlayback";
import { logger } from "../lib/logger";
import { listPrivateClips, preparePrivateClips, sendPrivateClips } from "../lib/featured/privateClips";
import { loadSquadGrid, saveTargets, setConsent, loadTargets } from "../lib/featured/store";
import { consoleAccess, consoleSession } from "./academyMatches";

/**
 * "Every child appears" (academy console):
 *
 *   GET  …/featured                         the squad grid (?month=YYYY-MM, ?squadId=), the footage flags, the targets
 *   PUT  …/featured/targets                 the owner's targets
 *   GET  …/players/public-consent           every player's public-post consent
 *   PUT  …/players/:playerId/public-consent  set one (owner)
 *   GET  …/matches/:sessionId/private-clips          each child's private clip of the match
 *   POST …/matches/:sessionId/private-clips/prepare  make the missing ones (owner)
 *   POST …/matches/:sessionId/private-clips/send     send to the families (owner; one message per family)
 *
 * And for the family, without an account: GET /kc/:token (the clip's facts) and
 * /kc/:token/video (the clip itself; counts as opened).
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get(`${base}/featured`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const month = typeof req.query.month === "string" && MONTH.test(req.query.month) ? req.query.month : undefined;
  const squadId = Number(req.query.squadId);
  try {
    const grid = await loadSquadGrid(access.academyId, { month, squadId: Number.isSafeInteger(squadId) && squadId > 0 ? squadId : null });
    res.json({ ...grid, canEdit: access.isOwner });
  } catch (error) {
    logger.error({ error: (error as Error)?.message, academyId: access.academyId }, "Squad grid failed");
    res.status(500).json({ error: "Couldn't load the squad grid" });
  }
});

const TargetsBody = z.object({
  publicPostsPerMonth: z.number().int().min(0).max(8).optional(),
  privateClipPerMatch: z.boolean().optional(),
});

router.put(`${base}/featured/targets`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res, true);
  if (!access) return;
  const body = TargetsBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid targets" }); return; }
  res.json({ targets: await saveTargets(access.academyId, body.data) });
});

router.get(`${base}/featured/targets`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  res.json({ targets: await loadTargets(access.academyId) });
});

router.get(`${base}/players/public-consent`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const rows = await db.select({
    playerId: academyPlayersTable.id,
    consent: academyPlayersTable.publicPostsConsent,
    consentAt: academyPlayersTable.publicPostsConsentAt,
  }).from(academyPlayersTable).where(eq(academyPlayersTable.academyId, access.academyId));
  res.json({ players: rows.map((r) => ({ ...r, consentAt: r.consentAt?.toISOString() ?? null })) });
});

router.put(`${base}/players/:playerId/public-consent`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res, true);
  if (!access) return;
  const playerId = Number(req.params.playerId);
  const body = z.object({ consent: z.boolean() }).safeParse(req.body ?? {});
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || !body.success) { res.status(400).json({ error: "Invalid" }); return; }
  if (!(await setConsent(access.academyId, playerId, body.data.consent))) { res.status(404).json({ error: "Player not found in this academy" }); return; }
  res.json({ playerId, consent: body.data.consent });
});

// ─── Private clips of a match ───────────────────────────────────────────────

router.get(`${base}/matches/:sessionId/private-clips`, async (req, res): Promise<void> => {
  const access = await consoleSession(req, res);
  if (!access) return;
  res.json({ clips: await listPrivateClips(access.academyId, access.session.id) });
});

router.post(`${base}/matches/:sessionId/private-clips/prepare`, async (req, res): Promise<void> => {
  const access = await consoleSession(req, res, true);
  if (!access) return;
  try {
    const result = await preparePrivateClips(access.academyId, access.session.id, access.user.id);
    res.json({ ...result, clips: await listPrivateClips(access.academyId, access.session.id) });
  } catch (error) {
    logger.error({ error: (error as Error)?.message, sessionId: access.session.id }, "Preparing private clips failed");
    res.status(500).json({ error: "Couldn't prepare the clips" });
  }
});

router.post(`${base}/matches/:sessionId/private-clips/send`, async (req, res): Promise<void> => {
  const access = await consoleSession(req, res, true);
  if (!access) return;
  const body = z.object({ playerIds: z.array(z.number().int().positive()).max(200).optional() }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid" }); return; }
  try {
    const result = await sendPrivateClips(access.academyId, access.session.id, access.user.id, { playerIds: body.data.playerIds });
    if (result.reason === "whatsapp_off") {
      res.status(409).json({ error: "Turn WhatsApp on first: link your number or choose Replay's number.", code: "whatsapp_off" });
      return;
    }
    res.json({ ...result, clips: await listPrivateClips(access.academyId, access.session.id) });
  } catch (error) {
    logger.error({ error: (error as Error)?.message, sessionId: access.session.id }, "Sending private clips failed");
    res.status(500).json({ error: "Couldn't send the clips" });
  }
});

// ─── The family's link (no account) ─────────────────────────────────────────

const TOKEN = /^[0-9a-f]{32}$/;

type ClipByToken = {
  kind: "player" | "trial";
  clip: { id: number; academyId: number; sessionId: number | null; momentKind: string | null; note: unknown; openedAt: Date | null };
  playerName: string;
  exportStatus: string | null;
  exportedUrl: string | null;
  userClipId: number | null;
};

/** A player's clip from a match, or a trial child's clip (lib/marketing/trials.ts): both open at /kc/<token>. */
async function clipByToken(req: Request, res: Response): Promise<ClipByToken | null> {
  const token = String(req.params.token ?? "");
  if (!TOKEN.test(token)) { res.status(404).json({ error: "Not found" }); return null; }
  const [row] = await db.select({
    clip: academyPlayerClipsTable,
    playerName: academyPlayersTable.name,
    exportStatus: userClipsTable.exportStatus,
    exportedUrl: userClipsTable.exportedUrl,
    userClipId: userClipsTable.id,
  }).from(academyPlayerClipsTable)
    .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyPlayerClipsTable.playerId))
    .leftJoin(userClipsTable, eq(userClipsTable.id, academyPlayerClipsTable.userClipId))
    .where(and(eq(academyPlayerClipsTable.token, token)));
  // A prepared clip the owner has not sent yet is not the family's yet.
  if (row) {
    if (row.clip.status !== "sent") { res.status(404).json({ error: "Not found" }); return null; }
    return { kind: "player", ...row };
  }
  const [trial] = await db.select({
    clip: academyTrialClipsTable,
    exportStatus: userClipsTable.exportStatus,
    exportedUrl: userClipsTable.exportedUrl,
    userClipId: userClipsTable.id,
  }).from(academyTrialClipsTable)
    .leftJoin(userClipsTable, eq(userClipsTable.id, academyTrialClipsTable.userClipId))
    .where(eq(academyTrialClipsTable.token, token));
  if (!trial || trial.clip.status !== "sent") { res.status(404).json({ error: "Not found" }); return null; }
  return {
    kind: "trial",
    clip: { id: trial.clip.id, academyId: trial.clip.academyId, sessionId: trial.clip.sessionId, momentKind: null, note: null, openedAt: trial.clip.openedAt },
    playerName: trial.clip.childName ?? "",
    exportStatus: trial.exportStatus,
    exportedUrl: trial.exportedUrl,
    userClipId: trial.userClipId,
  };
}

router.get("/kc/:token", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const row = await clipByToken(req, res);
  if (!row) return;
  const [[academy], [session]] = await Promise.all([
    db.select({ name: academiesTable.name, nameAr: academiesTable.nameAr, logoUrl: academiesTable.logoUrl }).from(academiesTable).where(eq(academiesTable.id, row.clip.academyId)),
    row.clip.sessionId ? db.select({ startsAt: academySessionsTable.startsAt, opponent: academySessionsTable.opponent }).from(academySessionsTable).where(eq(academySessionsTable.id, row.clip.sessionId)) : Promise.resolve([]),
  ]);
  res.json({
    firstName: row.playerName.trim().split(/\s+/)[0] ?? "",
    academy: academy ? { name: academy.name, nameAr: academy.nameAr } : null,
    match: session ? { startsAt: session.startsAt.toISOString(), opponent: session.opponent } : null,
    trial: row.kind === "trial",
    momentKind: row.clip.momentKind,
    note: row.clip.note ?? null,
    ready: row.exportStatus === "done" && Boolean(row.exportedUrl),
  });
});

router.get("/kc/:token/video", async (req, res): Promise<void> => {
  const row = await clipByToken(req, res);
  if (!row) return;
  if (row.exportStatus !== "done" || !row.exportedUrl || !row.userClipId) {
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json({ error: "Still being prepared", code: "preparing" });
    return;
  }
  if (!row.clip.openedAt) {
    const table = row.kind === "trial" ? academyTrialClipsTable : academyPlayerClipsTable;
    await db.update(table).set({ openedAt: new Date() }).where(eq(table.id, row.clip.id)).catch(() => {});
  }
  const url = getClipExportCdnUrl(row.userClipId, row.exportedUrl);
  if (url) {
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, url);
    return;
  }
  // Not a plain Storage object (a vps1 copy): relay it in bounded ranges, as the clip player does.
  const probe = await probeExportObject(row.exportedUrl);
  if (probe.state !== "exists") { res.status(404).json({ error: "Not found" }); return; }
  const plan = planExportRange(req.header("range") ?? undefined, CLIP_PLAYBACK_RANGE_MAX_BYTES);
  const abort = new AbortController();
  res.once("close", () => { if (!res.writableEnded) abort.abort(); });
  try {
    const upstream = await fetchExportObject(probe.url, { range: plan.upstreamRange, signal: abort.signal });
    const outcome = await sendBoundedExport(res, upstream, plan, { "Content-Type": upstream.headers.get("content-type") ?? "video/mp4", "Cache-Control": "private, no-store" });
    if (outcome === "unusable" && !res.headersSent) res.status(502).json({ error: "Playback unavailable" });
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: "Playback unavailable" });
    else logger.debug({ error: (error as Error)?.message }, "Kid clip stream ended early");
  }
});

export default router;

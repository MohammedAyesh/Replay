import { Router, type IRouter } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { listTrials, makeTrialClip, sendTrialClip, setTrialSession } from "../lib/marketing/trials";
import { consoleAccess } from "./academyMatches";

/**
 * Trial sessions (People → Trials; owner and coaches):
 *
 *   GET  …/trials                              leads at the trial stage, their session, the clip and the follow-up
 *   PUT  …/contacts/:contactId/trial           { sessionId | null }: book (or clear) the trial session
 *   POST …/contacts/:contactId/trial-clip      { momentSeconds, childName }: cut the child's moment
 *   POST …/trial-clips/:clipId/send            send it to the family; the follow-up is set from it
 */
const router: IRouter = Router();
const base = "/academy/console/academies/:academyId";

const id = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

const ERRORS: Record<string, [number, string]> = {
  not_found: [404, "Person not found"],
  not_in_academy: [404, "Session not found in this academy"],
  no_session: [409, "Set the trial session first"],
  no_video: [409, "The session has no video yet"],
  bad_moment: [400, "That time isn't in the video"],
};

router.get(`${base}/trials`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  res.json({ trials: await listTrials(access.academyId) });
});

const TrialBody = z.object({ sessionId: z.number().int().positive().nullable() });

router.put(`${base}/contacts/:contactId/trial`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const contactId = id(req.params.contactId);
  const body = TrialBody.safeParse(req.body ?? {});
  if (!contactId || !body.success) { res.status(400).json({ error: "Invalid trial" }); return; }
  const error = await setTrialSession(access.academyId, contactId, body.data.sessionId);
  if (error) { const [code, message] = ERRORS[error]; res.status(code).json({ error: message, code: error }); return; }
  res.json({ trials: await listTrials(access.academyId) });
});

const ClipBody = z.object({ momentSeconds: z.number().min(0).max(6 * 3600), childName: z.string().max(60).nullable().optional() });

router.post(`${base}/contacts/:contactId/trial-clip`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const contactId = id(req.params.contactId);
  const body = ClipBody.safeParse(req.body ?? {});
  if (!contactId || !body.success) { res.status(400).json({ error: "Invalid clip" }); return; }
  try {
    const result = await makeTrialClip(access.academyId, contactId, access.user.id, { momentSeconds: body.data.momentSeconds, childName: body.data.childName ?? null });
    if ("error" in result) { const [code, message] = ERRORS[result.error]; res.status(code).json({ error: message, code: result.error }); return; }
    res.status(201).json({ clipId: result.clipId, trials: await listTrials(access.academyId) });
  } catch (error) {
    logger.error({ error: (error as Error)?.message, academyId: access.academyId, contactId }, "Trial clip failed");
    res.status(500).json({ error: "Couldn't make the clip" });
  }
});

router.post(`${base}/trial-clips/:clipId/send`, async (req, res): Promise<void> => {
  const access = await consoleAccess(req, res);
  if (!access) return;
  const clipId = id(req.params.clipId);
  if (!clipId) { res.status(400).json({ error: "Invalid clip" }); return; }
  const result = await sendTrialClip(access.academyId, clipId, access.user.id);
  if (result.reason === "not_found") { res.status(404).json({ error: "Clip not found" }); return; }
  if (result.reason && result.reason !== "already_sent") { res.status(409).json({ error: "Not sent", code: result.reason }); return; }
  res.json({ ...result, trials: await listTrials(access.academyId) });
});

export default router;

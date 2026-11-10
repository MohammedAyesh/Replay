import { and, eq, isNotNull } from "drizzle-orm";
import type { Framing } from "@workspace/api-zod";
import { academyRecordingsTable, db } from "@workspace/db";
import { clip as clipParts, resolveBindings } from "../academyMatchStats";
import { partsBoxes, playerCentreSamples, trackIndex } from "../coachTracks";
import { logger } from "../logger";
import { loadRecordingPlay } from "../matchPlayLoad";
import { ballKeys, DEFAULT_ZOOM } from "./framing";

/**
 * A camera that follows one academy player through a window of a recording
 * (Creative hub → Player reel). His roster track comes from the match's
 * line-up binding (a shirt number or the owner's pick in Matches → Who's who);
 * his box centres are smoothed into keys the same way the ball's are.
 *
 * Null when the recording is not a session's analysed recording, the player
 * is not bound in it, or he is on camera for under MIN_COVERAGE of the window.
 */

/** Below this share of the window with him in sight, the ball is the better camera. */
export const PLAYER_FOLLOW_MIN_COVERAGE = 0.3;

export async function playerFollowFraming(
  academyId: number,
  recordingId: number,
  playerId: number,
  fromMs: number,
  toMs: number,
  zoom = DEFAULT_ZOOM,
): Promise<{ framing: Framing; coverage: number } | null> {
  if (!(toMs > fromMs)) return null;
  try {
    const links = await db.select({ sessionId: academyRecordingsTable.sessionId }).from(academyRecordingsTable)
      .where(and(eq(academyRecordingsTable.academyId, academyId), eq(academyRecordingsTable.recordingId, recordingId), isNotNull(academyRecordingsTable.sessionId)));
    // Loaded on demand: the match route module is large.
    const { loadContext, loadSession } = await import("../../routes/academyMatches");
    for (const link of links) {
      const session = await loadSession(academyId, link.sessionId!);
      if (!session) continue;
      const ctx = await loadContext(session);
      // The roster belongs to the session's analysed recording; another recording's tracks are not his.
      if (ctx.recordingId !== recordingId || !ctx.roster) continue;
      const binding = resolveBindings(ctx.lineup, ctx.roster).find((b) => b.playerId === playerId);
      const rosterPlayer = binding ? ctx.roster.players.find((p) => p.id === binding.rosterPlayerId) : undefined;
      if (!rosterPlayer) continue;
      const play = await loadRecordingPlay(recordingId, { keepSegments: true });
      if (!play?.segments) return null;
      const m = play.manifest;
      const offset = m.videoStartSeconds ?? 0;
      const parts = clipParts(rosterPlayer.parts.map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })),
        fromMs / 1000 - offset - 1, toMs / 1000 - offset + 1, play.fps);
      const boxes = partsBoxes(trackIndex(play.segments), parts, m, fromMs / 1000 - 1, toMs / 1000 + 1, 5);
      const keyed = ballKeys(playerCentreSamples(boxes), fromMs, toMs, zoom);
      if (!keyed || keyed.coverage < PLAYER_FOLLOW_MIN_COVERAGE) return null;
      return { framing: { ...keyed.framing, mode: "manual" }, coverage: keyed.coverage };
    }
  } catch (error) {
    logger.warn({ academyId, recordingId, playerId, error: (error as Error).message }, "Creative framing: player follow failed");
  }
  return null;
}

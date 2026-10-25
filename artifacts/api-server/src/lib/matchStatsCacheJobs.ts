import { desc } from "drizzle-orm";
import { db, matchPlayerStatsCacheTable } from "@workspace/db";
import { logger } from "./logger";

const scheduledMatches = new Map<number, ReturnType<typeof setTimeout>>();
const runningMatches = new Set<number>();
const rerunMatches = new Set<number>();
const scheduledRecordings = new Map<number, ReturnType<typeof setTimeout>>();
const runningRecordings = new Set<number>();
const rerunRecordings = new Set<number>();

function scheduleMatch(matchId: number, delayMs: number): void {
  if (!Number.isSafeInteger(matchId) || matchId <= 0) return;
  if (runningMatches.has(matchId)) {
    rerunMatches.add(matchId);
    return;
  }
  if (scheduledMatches.has(matchId)) return;
  const timer = setTimeout(() => {
    scheduledMatches.delete(matchId);
    void (async () => {
      runningMatches.add(matchId);
      try {
        const { fillMatchStatsCacheForMatch } = await import("./matchFeed");
        await fillMatchStatsCacheForMatch(matchId);
      } catch (error) {
        logger.error({ matchId, err: error }, "Background match stats cache fill failed");
      } finally {
        runningMatches.delete(matchId);
        if (rerunMatches.delete(matchId)) scheduleMatch(matchId, 0);
      }
    })();
  }, Math.max(0, delayMs));
  timer.unref?.();
  scheduledMatches.set(matchId, timer);
}

function scheduleRecording(recordingId: number, delayMs: number): void {
  if (!Number.isSafeInteger(recordingId) || recordingId <= 0) return;
  if (runningRecordings.has(recordingId)) {
    rerunRecordings.add(recordingId);
    return;
  }
  if (scheduledRecordings.has(recordingId)) return;
  const timer = setTimeout(() => {
    scheduledRecordings.delete(recordingId);
    void (async () => {
      runningRecordings.add(recordingId);
      try {
        const { fillMatchStatsCacheForRecording } = await import("./matchFeed");
        await fillMatchStatsCacheForRecording(recordingId);
      } catch (error) {
        logger.error({ recordingId, err: error }, "Background recording stats cache fill failed");
      } finally {
        runningRecordings.delete(recordingId);
        if (rerunRecordings.delete(recordingId)) scheduleRecording(recordingId, 0);
      }
    })();
  }, Math.max(0, delayMs));
  timer.unref?.();
  scheduledRecordings.set(recordingId, timer);
}

export function queueMatchStatsCacheForMatch(matchId: number, delayMs = 0): void {
  scheduleMatch(matchId, delayMs);
}

export function queueMatchStatsCacheForRecording(recordingId: number, delayMs = 350): void {
  scheduleRecording(recordingId, delayMs);
}

/**
 * Bring every cached match up to date, newest first, one at a time. Home
 * tiles, personal bests and public measured stats read the cached rows as they
 * are; only a fill rewrites them, and the fills run per match on demand (three
 * recent matches per My-matches load). After MATCH_STATS_CACHE_VERSION moves,
 * an older match nobody opens would keep serving its old numbers for good, so
 * this runs once at start-up. Each fill recomputes only a match whose rows are
 * not current, so a restart with nothing stale costs a query per match.
 */
export async function refreshStaleMatchStatsCaches(pauseMs = 250): Promise<number> {
  const rows = await db.selectDistinct({ matchId: matchPlayerStatsCacheTable.matchId })
    .from(matchPlayerStatsCacheTable)
    .orderBy(desc(matchPlayerStatsCacheTable.matchId));
  const { fillMatchStatsCacheForMatch } = await import("./matchFeed");
  let checked = 0;
  for (const { matchId } of rows) {
    if (runningMatches.has(matchId) || scheduledMatches.has(matchId)) continue;
    runningMatches.add(matchId);
    try {
      await fillMatchStatsCacheForMatch(matchId);
      checked++;
    } catch (error) {
      logger.warn({ matchId, err: error }, "Stale match stats cache refresh failed");
    } finally {
      runningMatches.delete(matchId);
      if (rerunMatches.delete(matchId)) scheduleMatch(matchId, 0);
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return checked;
}
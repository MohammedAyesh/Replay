import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { academyMembersTable, academyPlayerClipsTable, academyRecordingsTable, academySessionsTable, db, recordingTrackingBundlesTable } from "@workspace/db";
import { logger } from "../logger";
import { preparePrivateClips } from "./privateClips";

/**
 * Prepares children's private clips on its own once a match is analysed (the
 * owner still sends them). Runs from the vps1 minute tick, at most every
 * 15 minutes, over matches of the last 7 days that have an analysed recording.
 * preparePrivateClips is idempotent and returns early when every bound child
 * has his clip, so looking again costs little.
 */
const EVERY_MS = 15 * 60_000;
const DAYS = 7;
const MAX_MATCHES = 6;
let lastRun = 0;
let running = false;

export async function maybePrepareRecentClips(now = new Date()): Promise<number | "skipped"> {
  if (running || now.getTime() - lastRun < EVERY_MS) return "skipped";
  running = true;
  lastRun = now.getTime();
  try {
    const sessions = await db.selectDistinct({ id: academySessionsTable.id, academyId: academySessionsTable.academyId, startsAt: academySessionsTable.startsAt })
      .from(academySessionsTable)
      .innerJoin(academyRecordingsTable, eq(academyRecordingsTable.sessionId, academySessionsTable.id))
      .innerJoin(recordingTrackingBundlesTable, eq(recordingTrackingBundlesTable.recordingId, academyRecordingsTable.recordingId))
      .where(and(
        eq(academySessionsTable.type, "match"),
        gte(academySessionsTable.startsAt, new Date(now.getTime() - DAYS * 86_400_000)),
        lt(academySessionsTable.startsAt, now),
      ))
      .orderBy(asc(academySessionsTable.startsAt));
    if (!sessions.length) return 0;
    // Matches that already have every clip they will get are skipped cheaply first: a row per child means prepared.
    const counts = await db.select({ sessionId: academyPlayerClipsTable.sessionId, n: sql<number>`count(*)::int` })
      .from(academyPlayerClipsTable).where(inArray(academyPlayerClipsTable.sessionId, sessions.map((s) => s.id)))
      .groupBy(academyPlayerClipsTable.sessionId);
    const have = new Map(counts.map((c) => [c.sessionId, c.n]));
    const todo = [...sessions].sort((a, b) => (have.get(a.id) ?? 0) - (have.get(b.id) ?? 0)).slice(0, MAX_MATCHES);
    let prepared = 0;
    for (const s of todo) {
      const [owner] = await db.select({ userId: academyMembersTable.userId }).from(academyMembersTable)
        .where(and(eq(academyMembersTable.academyId, s.academyId), eq(academyMembersTable.role, "owner")))
        .orderBy(asc(academyMembersTable.id)).limit(1);
      if (!owner) continue;
      try {
        prepared += (await preparePrivateClips(s.academyId, s.id, owner.userId)).prepared;
      } catch (error) {
        logger.warn({ error: (error as Error)?.message, sessionId: s.id }, "Private clip sweep: one match failed");
      }
    }
    return prepared;
  } finally {
    running = false;
  }
}

export const __test = { reset: () => { lastRun = 0; running = false; } };

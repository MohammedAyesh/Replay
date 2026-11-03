import { and, desc, eq } from "drizzle-orm";
import {
  academyAttendanceTable,
  academyMatchPlayerStatsTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  db,
} from "@workspace/db";
import type { AcademyPlayerStats } from "../academyMatchStats";
import { playerPictures } from "../academyPlayerPhotos";
import type { PictureFact } from "../creative/sessionData";
import type { FeaturedFacts } from "./drafts";
import { lastSoloPublic } from "./store";

/**
 * Sessions in a row a child attended, newest first: present or late counts,
 * excused is skipped (neither breaks nor adds), absent ends the run.
 */
export function attendanceStreak(statuses: string[]): number {
  let n = 0;
  for (const s of statuses) {
    if (s === "present" || s === "late") n += 1;
    else if (s === "absent") break;
  }
  return n;
}

/** What the automatic drafts need to feature every child (see ./drafts.ts). */
export async function loadFeaturedFacts(academyId: number, showNames: boolean): Promise<FeaturedFacts> {
  const [roster, lastSolo, history, attendance] = await Promise.all([
    db.select({
      playerId: academyPlayersTable.id, name: academyPlayersTable.name, number: academyPlayersTable.jerseyNumber,
      position: academyPlayersTable.position, squad: academySquadsTable.name, consent: academyPlayersTable.publicPostsConsent,
    }).from(academyPlayersTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
      .where(and(eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.isActive, true))),
    lastSoloPublic(academyId),
    db.select({
      playerId: academyMatchPlayerStatsTable.playerId, sessionId: academyMatchPlayerStatsTable.sessionId,
      startsAt: academySessionsTable.startsAt, stats: academyMatchPlayerStatsTable.stats,
    }).from(academyMatchPlayerStatsTable)
      .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyMatchPlayerStatsTable.sessionId))
      .where(eq(academyMatchPlayerStatsTable.academyId, academyId)),
    db.select({ playerId: academyAttendanceTable.playerId, status: academyAttendanceTable.status })
      .from(academyAttendanceTable)
      .innerJoin(academySessionsTable, eq(academySessionsTable.id, academyAttendanceTable.sessionId))
      .where(eq(academySessionsTable.academyId, academyId))
      .orderBy(desc(academySessionsTable.startsAt)),
  ]);
  const pictures = new Map<number, PictureFact>();
  if (showNames && roster.length) {
    for (const [id, pic] of await playerPictures(academyId, roster.map((r) => r.playerId)).catch(() => new Map())) {
      pictures.set(id, { cutout: pic.kind === "photo" && pic.photo.transparent });
    }
  }
  const byPlayer = new Map<number, string[]>();
  for (const a of attendance) byPlayer.set(a.playerId, [...(byPlayer.get(a.playerId) ?? []), a.status]);
  return {
    consent: new Set(roster.filter((r) => r.consent).map((r) => r.playerId)),
    lastSolo,
    showNames,
    roster: roster.map((r) => ({ playerId: r.playerId, name: r.name, number: r.number, position: r.position, squad: r.squad ?? null, picture: pictures.get(r.playerId) ?? null })),
    history: history.map((h) => {
      const s = h.stats as Partial<AcademyPlayerStats>;
      return { playerId: h.playerId, sessionId: h.sessionId, startsAt: h.startsAt, stats: { goals: s.goals, dribblesWon: s.dribblesWon, passesCompleted: s.passesCompleted, touches: s.touches, distanceKm: s.distanceKm, topSpeedKmh: s.topSpeedKmh } };
    }),
    streaks: new Map([...byPlayer].map(([id, list]) => [id, attendanceStreak(list)])),
  };
}

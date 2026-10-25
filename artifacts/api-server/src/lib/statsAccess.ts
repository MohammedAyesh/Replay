import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, statUnlocksTable } from "@workspace/db";
import type { Commerce } from "./commerce";

/**
 * Has this player paid for (or been given) the stats of this match?
 *
 * Moved out of routes/matchRooms.ts unchanged so the clip export can ask the
 * same question before it prints anyone's numbers on an end screen: a clip must
 * never show stats its owner cannot see in the app.
 */
export async function statsAccess(userId: number | null, matchId: number, commerce: Commerce) {
  // Paywall off: stats are free for everyone who can open the match.
  if (!commerce.statsPaywall) return { unlocked: true, pending: null as null | { reference: string; kind: string; amountFils: number } };
  if (!userId) return { unlocked: false, pending: null as null | { reference: string; kind: string; amountFils: number } };
  const now = new Date();
  const rows = await db.select().from(statUnlocksTable).where(and(
    inArray(statUnlocksTable.kind, ["match", "team", "monthly"]),
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

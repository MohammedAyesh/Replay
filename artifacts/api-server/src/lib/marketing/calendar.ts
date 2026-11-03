import { eq } from "drizzle-orm";
import { academyFeatureSettingsTable, db } from "@workspace/db";
import { z } from "zod";

/**
 * The weekly content calendar: which kind of post goes out on which day.
 * The creative hub fills each slot from Replay's auto drafts (For you); the
 * owner edits the week. Days are 0 (Sunday) to 6 (Saturday), Amman time.
 */
export const CALENDAR_KINDS = ["matchday", "fulltime", "player", "training", "weekly"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export type CalendarSlot = { day: number; kind: CalendarKind };

/** Matchday Thursday, full-time Saturday, player of the week Monday, a training clip Wednesday. */
export const DEFAULT_CALENDAR: CalendarSlot[] = [
  { day: 1, kind: "player" },
  { day: 3, kind: "training" },
  { day: 4, kind: "matchday" },
  { day: 6, kind: "fulltime" },
];

export const CalendarBody = z.object({
  slots: z.array(z.object({ day: z.number().int().min(0).max(6), kind: z.enum(CALENDAR_KINDS) })).max(14).nullable(),
});

export function normaliseCalendar(slots: CalendarSlot[]): CalendarSlot[] {
  const seen = new Set<string>();
  return slots
    .filter((s) => { const k = `${s.day}:${s.kind}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.day - b.day || CALENDAR_KINDS.indexOf(a.kind) - CALENDAR_KINDS.indexOf(b.kind));
}

function parseStored(v: unknown): CalendarSlot[] | null {
  const parsed = CalendarBody.shape.slots.safeParse(v);
  return parsed.success && parsed.data ? normaliseCalendar(parsed.data) : null;
}

export async function loadCalendar(academyId: number): Promise<{ slots: CalendarSlot[]; isDefault: boolean }> {
  const [row] = await db.select({ cal: academyFeatureSettingsTable.contentCalendar }).from(academyFeatureSettingsTable).where(eq(academyFeatureSettingsTable.academyId, academyId));
  const stored = parseStored(row?.cal ?? null);
  return stored ? { slots: stored, isDefault: false } : { slots: DEFAULT_CALENDAR, isDefault: true };
}

/** `null` goes back to the default week. */
export async function saveCalendar(academyId: number, slots: CalendarSlot[] | null) {
  const value = slots ? normaliseCalendar(slots) : null;
  await db.insert(academyFeatureSettingsTable)
    .values({ academyId, contentCalendar: value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: academyFeatureSettingsTable.academyId, set: { contentCalendar: value, updatedAt: new Date() } });
  return loadCalendar(academyId);
}

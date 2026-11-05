import { addDays, wallMinutes, wallString } from "./core";
import { IG_LEAD_MINUTES, WEEKLY_KINDS, boardTimes, weeklyTimes, type IgSlotSettings, type WeeklyKind } from "./igCalendar";

/**
 * Suggestions for the Instagram autopilot, so the owner always has something to look at and
 * approve: every post the autopilot will make on its own in the coming days that isn't on the
 * calendar yet (the weekly posts, tonight's and tomorrow's free pitches, last month's scorers on
 * the 1st). Each would appear by itself a few hours before its time; "Add now" puts it on the
 * calendar today, at its time, waiting for the owner's OK.
 *
 * The key a suggestion is added under is the same one the autopilot uses for that post
 * (scheduleFieldPosts), so adding one never makes the same post twice.
 */
export const SUGGEST_KINDS = [...WEEKLY_KINDS, "open_slots", "leaderboard", "day_best"] as const;
export type SuggestKind = (typeof SUGGEST_KINDS)[number];
export type IgSuggestion = { kind: SuggestKind; placement: "story" | "reel"; at: number; originKey: string };

const PLACEMENT: Record<SuggestKind, "story" | "reel"> = {
  thanks: "reel", top5: "reel", match_week: "reel", player_week: "reel", versus: "reel", open_slots: "story", leaderboard: "story", day_best: "reel",
};

/** The next time this kind of post goes out at or after `from`, and the key it goes out under. */
export function nextOccurrence(s: IgSlotSettings, kind: SuggestKind, from: number): { at: number; originKey: string } {
  if (kind === "open_slots") {
    const today = wallString(from).slice(0, 10);
    for (let d = 0; d < 3; d += 1) {
      const date = addDays(today, d);
      const at = wallMinutes(`${date} ${s.openSlotsTime}`);
      if (at >= from) return { at, originKey: `slots:${date}` };
    }
  }
  if (kind === "day_best") {
    // Yesterday's games, posted at dayBestTime: the key is the games' day.
    const today = wallString(from).slice(0, 10);
    for (let d = 0; d < 3; d += 1) {
      const date = addDays(today, d);
      const at = wallMinutes(`${date} ${s.dayBestTime}`);
      if (at >= from) return { at, originKey: `day:${addDays(date, -1)}` };
    }
  }
  if (kind === "leaderboard") {
    let b = boardTimes(s, from);
    if (b.at < from) b = boardTimes(s, wallMinutes(`${addDays(`${wallString(from).slice(0, 7)}-28`, 7).slice(0, 7)}-01 00:00`));
    return { at: b.at, originKey: `board:${b.month}` };
  }
  let t = weeklyTimes(s, kind as WeeklyKind, from);
  if (t.at < from) t = weeklyTimes(s, kind as WeeklyKind, from + 7 * 1440);
  return { at: t.at, originKey: `${kind}:${t.gamesWeek}` };
}

/**
 * What to suggest from `now` (Amman wall minutes) for `days` days: the next occurrence of every
 * kind that is switched on, not on the calendar already (`taken` origin keys), sorted by time.
 * Tomorrow's free pitches too, so a field with everything else off still gets two a day.
 */
export function suggestPosts(input: { s: IgSlotSettings; now: number; days: number; taken: ReadonlySet<string> }): IgSuggestion[] {
  const { s, now, days, taken } = input;
  const from = now + IG_LEAD_MINUTES;
  const until = now + days * 1440;
  const off = new Set<string>(s.off);
  const out: IgSuggestion[] = [];
  const add = (kind: SuggestKind, o: { at: number; originKey: string }) => {
    if (o.at > until || taken.has(o.originKey) || out.some((x) => x.originKey === o.originKey)) return;
    out.push({ kind, placement: PLACEMENT[kind], ...o });
  };
  for (const kind of SUGGEST_KINDS) {
    if (off.has(kind)) continue;
    const first = nextOccurrence(s, kind, from);
    add(kind, first);
    // Free pitches are a daily post: the day after as well.
    if (kind === "open_slots") add(kind, nextOccurrence(s, kind, first.at + 1));
  }
  return out.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
}

/** A suggestion the owner asked to add: the kind, re-derived on the server from its time. */
export function suggestionFor(s: IgSlotSettings, kind: SuggestKind, at: number, now: number): IgSuggestion | null {
  // The time comes from the client: only a real occurrence of that kind (not in the past) is accepted.
  const o = nextOccurrence(s, kind, Math.max(now + IG_LEAD_MINUTES, at - 1));
  return o.at === at ? { kind, placement: PLACEMENT[kind], ...o } : null;
}

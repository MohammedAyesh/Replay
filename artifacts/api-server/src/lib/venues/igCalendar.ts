/**
 * Instagram autopilot: the calendar's pure rules (no database), unit-tested in igCalendar.test.ts.
 *
 * Times are Amman wall minutes (lib/venues/core.ts), like every other field-console time.
 *
 *   stories    every `storyEveryHours` while the field is open, up to `storiesPerSlot` each;
 *   feed Reels at `reelTimes` (1–3 a day): the best booking clip ready before each Reel time is
 *              promoted to it (confirmed goals first, by score);
 *   awards     nominees on `nomineesDay` from `nomineesTime`, voting until `votingEndDay`
 *              `votingEndTime`, winners on `winnerDay` from `winnerTime`, `winnerGapMinutes` apart;
 *   night      nothing ever goes out between `quietFrom` and `quietTo`.
 *
 * The planner keeps what is pinned (moved by the owner) or already on its way out, then hands
 * every other waiting clip the earliest free slot after it is ready. A slot that passes without
 * the owner's OK frees the clip for the next one: the calendar rolls.
 */
import { addDays, ammanLocal, isTime, openingWindow, wallMinutes, wallString, weekday, type OpeningHours } from "./core";

export type IgSlotSettings = {
  storyEveryHours: number;
  storiesPerSlot: number;
  reelTimes: string[];
  quietFrom: string;
  quietTo: string;
  nomineesDay: number;
  nomineesTime: string;
  votingEndDay: number;
  votingEndTime: string;
  winnerDay: number;
  winnerTime: string;
  winnerGapMinutes: number;
  /** Fewer votes than this in total and the owner picks the winner. */
  minVotes: number;
};

export const DEFAULT_IG_SLOTS: IgSlotSettings = {
  storyEveryHours: 3,
  storiesPerSlot: 2,
  reelTimes: ["14:00", "21:00"],
  quietFrom: "01:00",
  quietTo: "10:00",
  nomineesDay: 0,
  nomineesTime: "12:00",
  votingEndDay: 2,
  votingEndTime: "23:59",
  winnerDay: 3,
  winnerTime: "19:00",
  winnerGapMinutes: 90,
  minVotes: 5,
};

/** Instagram's limit: 100 API-published posts in a rolling 24 hours. The autopilot keeps a reserve for the owner's own posts. */
export const IG_DAILY_LIMIT = 100;
export const IG_RESERVE = 10;
/** A clip needs this long between being ready and its slot (rendering, Instagram processing). */
export const IG_LEAD_MINUTES = 20;
/** A booking clip that hasn't gone out this long after its game is dropped: too old to post. */
export const IG_MAX_AGE_HOURS = 72;
/** A slot this far in the past still publishes (a render that finished a little late). */
export const IG_GRACE_MINUTES = 60;

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const time = (v: unknown, d: string) => (isTime(v) && v !== "24:00" ? v : d);

export function normaliseIgSlots(raw: unknown): IgSlotSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_IG_SLOTS;
  const reels = Array.isArray(r.reelTimes) ? [...new Set(r.reelTimes.filter((t): t is string => isTime(t) && t !== "24:00"))].sort().slice(0, 3) : d.reelTimes;
  return {
    storyEveryHours: clampInt(r.storyEveryHours, 1, 12, d.storyEveryHours),
    storiesPerSlot: clampInt(r.storiesPerSlot, 1, 5, d.storiesPerSlot),
    reelTimes: reels.length ? reels : d.reelTimes,
    quietFrom: time(r.quietFrom, d.quietFrom),
    quietTo: time(r.quietTo, d.quietTo),
    nomineesDay: clampInt(r.nomineesDay, 0, 6, d.nomineesDay),
    nomineesTime: time(r.nomineesTime, d.nomineesTime),
    votingEndDay: clampInt(r.votingEndDay, 0, 6, d.votingEndDay),
    votingEndTime: time(r.votingEndTime, d.votingEndTime),
    winnerDay: clampInt(r.winnerDay, 0, 6, d.winnerDay),
    winnerTime: time(r.winnerTime, d.winnerTime),
    winnerGapMinutes: clampInt(r.winnerGapMinutes, 15, 240, d.winnerGapMinutes),
    minVotes: clampInt(r.minVotes, 1, 1000, d.minVotes),
  };
}

const tod = (minute: number) => ((minute % 1440) + 1440) % 1440;
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Is this wall minute in the night window (quietFrom → quietTo, which may run past midnight)? */
export function isQuiet(s: Pick<IgSlotSettings, "quietFrom" | "quietTo">, minute: number): boolean {
  const from = hm(s.quietFrom);
  const to = hm(s.quietTo);
  if (from === to) return false;
  const t = tod(minute);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

export type Slot = { at: number; kind: "story" | "reel"; capacity: number };

/**
 * Story and Reel slots from `fromDate` for `days` Amman days. A story slot is on the hour,
 * every storyEveryHours from the first whole hour of each opening window.
 */
export function slotsFor(s: IgSlotSettings, hours: OpeningHours, fromDate: string, days: number): Slot[] {
  const out: Slot[] = [];
  const seen = new Set<string>();
  const push = (slot: Slot) => {
    const key = `${slot.kind}:${slot.at}`;
    if (seen.has(key) || isQuiet(s, slot.at)) return;
    seen.add(key);
    out.push(slot);
  };
  for (let i = -1; i < days; i += 1) {
    const date = addDays(fromDate, i);
    // The day before is read too: its opening can run past midnight into fromDate.
    const w = openingWindow(hours, date);
    if (w) {
      const first = Math.ceil(w.start / 60) * 60;
      for (let m = first; m < w.end; m += s.storyEveryHours * 60) push({ at: m, kind: "story", capacity: s.storiesPerSlot });
    }
    if (i >= 0) for (const t of s.reelTimes) push({ at: wallMinutes(`${date} ${t}`), kind: "reel", capacity: 1 });
  }
  const start = wallMinutes(`${fromDate} 00:00`);
  const end = start + days * 1440;
  return out.filter((x) => x.at >= start && x.at < end).sort((a, b) => a.at - b.at || (a.kind === "reel" ? -1 : 1));
}

export type PlanItem = {
  id: number;
  kind: "booking_clip" | "award_nominees" | "award_winner";
  status: string;
  placement: "story" | "reel";
  /** Wall minute of its slot, or null. */
  slotAt: number | null;
  pinned: boolean;
  score: number;
  /** Wall minute the clip is ready to go (the footage came back). */
  readyAt: number;
};

const MOVABLE = new Set(["planned", "approved"]);

/**
 * Hand every movable booking clip a slot. Pinned items, award items and anything already
 * rendering, publishing or out keep theirs. Returns the new slot and placement of every movable
 * clip (slotAt null: no free slot in the window yet).
 */
export function planSlots(input: { now: number; slots: Slot[]; items: PlanItem[]; leadMinutes?: number }): Map<number, { slotAt: number | null; placement: "story" | "reel" }> {
  const lead = input.leadMinutes ?? IG_LEAD_MINUTES;
  const used = new Map<string, number>();
  const key = (kind: string, at: number) => `${kind}:${at}`;
  const out = new Map<number, { slotAt: number | null; placement: "story" | "reel" }>();
  const free: PlanItem[] = [];
  for (const item of input.items) {
    // Waiting clips are planned afresh every time; a planned slot that passed without the
    // owner's OK is simply not offered again, so the clip rolls to the next one.
    const movable = item.kind === "booking_clip" && MOVABLE.has(item.status) && !item.pinned;
    if (movable) { free.push(item); continue; }
    if (item.slotAt !== null) used.set(key(item.placement, item.slotAt), (used.get(key(item.placement, item.slotAt)) ?? 0) + 1);
  }
  const future = input.slots.filter((s) => s.at >= input.now + Math.min(lead, 5));
  const room = (slot: Slot) => slot.capacity - (used.get(key(slot.kind, slot.at)) ?? 0);
  const take = (slot: Slot, item: PlanItem) => {
    used.set(key(slot.kind, slot.at), (used.get(key(slot.kind, slot.at)) ?? 0) + 1);
    out.set(item.id, { slotAt: slot.at, placement: slot.kind });
  };
  const waiting = [...free].sort((a, b) => a.readyAt - b.readyAt || a.id - b.id);
  // Reels first: each Reel time takes the best clip ready in the 24 hours before it.
  for (const slot of future.filter((s) => s.kind === "reel")) {
    if (room(slot) <= 0) continue;
    const candidates = waiting.filter((i) => !out.has(i.id) && i.readyAt + lead <= slot.at && i.readyAt >= slot.at - 1440 && i.score > 0);
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.readyAt < a.readyAt) ? b : a));
    take(slot, best);
  }
  // Then stories, earliest free slot after each clip is ready.
  const stories = future.filter((s) => s.kind === "story");
  for (const item of waiting) {
    if (out.has(item.id)) continue;
    const slot = stories.find((s) => s.at >= item.readyAt + lead && room(s) > 0);
    if (slot) take(slot, item);
    else out.set(item.id, { slotAt: null, placement: "story" });
  }
  return out;
}

/** Room left under Instagram's limit for the autopilot, from Meta's count (or our own when Meta's can't be read). */
export function pacing(used: number, total = IG_DAILY_LIMIT): { used: number; total: number; left: number; paused: boolean } {
  const t = Number.isFinite(total) && total > 0 ? total : IG_DAILY_LIMIT;
  const left = Math.max(0, t - IG_RESERVE - used);
  return { used, total: t, left, paused: left <= 0 };
}

// ── Weeks and awards ────────────────────────────────────────────────────────

/** The Sunday (Amman calendar) the week of this wall minute starts on. */
export function weekStartOf(minute: number): string {
  const date = wallString(minute).slice(0, 10);
  return addDays(date, -weekday(date));
}

/** Wall minute of a weekday and time in the week starting `weekStart` (a Sunday). */
export function atWeekday(weekStart: string, day: number, timeOfDay: string): number {
  return wallMinutes(`${addDays(weekStart, day)} ${timeOfDay}`);
}

export type AwardTimes = { nominees: number; votingEnds: number; winner: number };

/**
 * The award cycle that announces the week starting `gamesWeek`: nominees on the following
 * week's nomineesDay, voting until votingEndDay, winners on winnerDay (each after the last).
 */
export function awardTimes(s: IgSlotSettings, gamesWeek: string): AwardTimes {
  const next = addDays(gamesWeek, 7);
  const nominees = atWeekday(next, s.nomineesDay, s.nomineesTime);
  let votingEnds = atWeekday(next, s.votingEndDay, s.votingEndTime);
  if (votingEnds <= nominees) votingEnds += 7 * 1440;
  let winner = atWeekday(next, s.winnerDay, s.winnerTime);
  while (winner <= votingEnds) winner += 7 * 1440;
  return { nominees, votingEnds, winner };
}

/** The games week whose awards are being announced at this moment (the one before this week). */
export function announcingWeek(minute: number): string {
  return addDays(weekStartOf(minute), -7);
}

export const AWARD_ORDER = ["goal", "dribble", "shot", "save", "fastest"] as const;
export type AwardCategory = (typeof AWARD_ORDER)[number];

/** Winner of a vote: most votes, then the nominee listed first. Null when the vote is too thin. */
export function voteWinner(nomineeKeys: string[], votes: Array<{ nomineeKey: string }>, minVotes: number): { key: string | null; total: number; counts: Record<string, number> } {
  const counts: Record<string, number> = Object.fromEntries(nomineeKeys.map((k) => [k, 0]));
  let total = 0;
  for (const v of votes) {
    if (!(v.nomineeKey in counts)) continue;
    counts[v.nomineeKey] += 1;
    total += 1;
  }
  if (total < minVotes) return { key: null, total, counts };
  let best: string | null = null;
  for (const k of nomineeKeys) if (best === null || counts[k] > counts[best]) best = k;
  return { key: best, total, counts };
}

/** Score for promoting a booking clip: confirmed goals first, then players' own clips, then detections. */
export const SOURCE_SCORE: Record<string, number> = { confirmed_goal: 30, saved_clip: 20, shot: 10, dribble: 10 };

export function nowWall(date = new Date()): number {
  return wallMinutes(ammanLocal(date));
}

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
 *   weekly     the thank-you (last week's numbers), top 5, match and player of the week on their
 *              weekday and time (`weekly`), and "which is nicer?" from this week's games so far;
 *   daily      open slots tonight, as a story at `openSlotsTime`, when anything is free; the moment
 *              of the day at `dayBestTime` (a goal, dribble, skill or save by weekday, ending on
 *              tonight's free kick-offs); a quiet hour still free, with a moment from that hour,
 *              at `sameHourTime`;
 *   monthly    the scorers of last month on the 1st at `boardTime`;
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
  /** Weekday (0 = Sunday) and time of each weekly post. */
  weekly: Record<WeeklyKind, { day: number; time: string }>;
  openSlotsTime: string;
  /** Last month's scorers, on the 1st. */
  boardTime: string;
  /** Yesterday's best clips, every day at this time. */
  dayBestTime: string;
  /** Match highlights: at most this many games a day (the ones with the best moments). */
  highlightsPerDay: number;
  /** "Same hour, free today": a story at this time about an afternoon kick-off still free. */
  sameHourTime: string;
  /** Match of the week opens on this number: dribbles won or shots on target (never the goals). */
  matchWeekHeadline: "dribbles" | "shots";
  /** Kinds the owner switched off. */
  off: OptionalKind[];
};

/** Weekly posts. `versus` and `best_goals` are this week's games so far; the rest are last week's. */
export const WEEKLY_KINDS = ["thanks", "top5", "match_week", "player_week", "versus", "so_close", "pass_week", "skill_week", "best_goals"] as const;
export type WeeklyKind = (typeof WEEKLY_KINDS)[number];
/** What the owner can switch off (booking clips and awards have their own switches). */
export const OPTIONAL_KINDS = [...WEEKLY_KINDS, "milestone", "open_slots", "leaderboard", "match_highlights", "day_best", "moment_day", "same_hour"] as const;
export type OptionalKind = (typeof OPTIONAL_KINDS)[number];

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
  weekly: {
    thanks: { day: 0, time: "21:00" },
    top5: { day: 1, time: "21:00" },
    player_week: { day: 1, time: "14:00" },
    match_week: { day: 2, time: "21:00" },
    versus: { day: 4, time: "21:00" },
    so_close: { day: 2, time: "14:00" },
    pass_week: { day: 4, time: "14:00" },
    skill_week: { day: 5, time: "14:00" },
    best_goals: { day: 6, time: "21:00" },
  },
  openSlotsTime: "17:00",
  boardTime: "14:00",
  dayBestTime: "13:00",
  highlightsPerDay: 3,
  sameHourTime: "11:00",
  matchWeekHeadline: "dribbles",
  off: [],
};

/** Instagram's limit: 100 API-published posts in a rolling 24 hours. The autopilot keeps a reserve for the owner's own posts. */
export const IG_DAILY_LIMIT = 100;
export const IG_RESERVE = 10;
/** A clip needs this long between being ready and its slot (rendering, Instagram processing). */
export const IG_LEAD_MINUTES = 20;
/** A game this recent is "fresh": its clip goes out before any older game's. */
export const IG_MAX_AGE_HOURS = 72;
/**
 * How far back the autopilot looks for games to post: older games fill the calendar when there
 * are no fresh ones. Bunny keeps footage 14 days; 12 leaves room to render and post.
 */
export const IG_BACKFILL_DAYS = 12;
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
  const weekly = (r.weekly && typeof r.weekly === "object" ? r.weekly : {}) as Record<string, unknown>;
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
    weekly: Object.fromEntries(WEEKLY_KINDS.map((k) => {
      const w = (weekly && typeof weekly[k] === "object" ? weekly[k] : {}) as Record<string, unknown>;
      return [k, { day: clampInt(w.day, 0, 6, d.weekly[k].day), time: time(w.time, d.weekly[k].time) }];
    })) as IgSlotSettings["weekly"],
    openSlotsTime: time(r.openSlotsTime, d.openSlotsTime),
    boardTime: time(r.boardTime, d.boardTime),
    dayBestTime: time(r.dayBestTime, d.dayBestTime),
    highlightsPerDay: clampInt(r.highlightsPerDay, 1, 10, d.highlightsPerDay),
    sameHourTime: time(r.sameHourTime, d.sameHourTime),
    matchWeekHeadline: r.matchWeekHeadline === "shots" ? "shots" : "dribbles",
    off: Array.isArray(r.off) ? [...new Set(r.off.filter((k): k is OptionalKind => (OPTIONAL_KINDS as readonly unknown[]).includes(k)))] : [],
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
  kind: string;
  status: string;
  placement: "story" | "reel" | "carousel";
  /** Wall minute of its slot, or null. */
  slotAt: number | null;
  pinned: boolean;
  score: number;
  /** Wall minute the clip is ready to go (the footage came back). */
  readyAt: number;
  /** Wall minute its game started (booking clips); older than IG_MAX_AGE_HOURS = a back-fill. */
  gameAt?: number;
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
  // Fresh games first, in the order their footage came back; then earlier days' games, newest
  // first, to fill what's left (a field with no new games still gets posts).
  const fresh = (i: PlanItem) => (i.gameAt ?? i.readyAt) >= input.now - IG_MAX_AGE_HOURS * 60;
  const waiting = [...free].sort((a, b) => Number(fresh(b)) - Number(fresh(a))
    || (fresh(a) ? a.readyAt - b.readyAt : (b.gameAt ?? b.readyAt) - (a.gameAt ?? a.readyAt))
    || a.id - b.id);
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

// ── Weekly, daily and monthly posts ─────────────────────────────────────────

/**
 * When a weekly post of the week holding `minute` goes out, and which games week it covers:
 * "which is nicer?" and the best goals cover this week so far (Sunday up to its post); the others last week.
 */
export function weeklyTimes(s: IgSlotSettings, kind: WeeklyKind, minute: number): { at: number; gamesWeek: string; gamesUntil: number | null } {
  const week = weekStartOf(minute);
  const w = s.weekly[kind];
  const at = atWeekday(week, w.day, w.time);
  return kind === "versus" || kind === "best_goals" ? { at, gamesWeek: week, gamesUntil: at - 3 * 60 } : { at, gamesWeek: addDays(week, -7), gamesUntil: null };
}

/** The moment of the day by weekday (0 = Sunday): goal, dribble, skill, goal, save, goal, dribble. */
export const DAY_MOMENT_ROTATION = ["goal", "dribble", "skill", "goal", "save", "goal", "dribble"] as const;
export type DayMomentKind = (typeof DAY_MOMENT_ROTATION)[number];

/** Milestones of games filmed: 50, 100, 250, 500, 1,000, 2,500, 5,000, 10,000 … */
export function milestoneCrossed(before: number, now: number): number | null {
  const steps = [50, 100, 250, 500];
  for (let m = 1000; m <= 1_000_000; m *= 10) steps.push(m, m * 2.5, m * 5);
  let hit: number | null = null;
  for (const n of steps) if (before < n && now >= n) hit = n;
  return hit;
}

/** The month before the one holding `minute` ("YYYY-MM"), and the 1st of this month at `time`. */
export function boardTimes(s: IgSlotSettings, minute: number): { at: number; month: string } {
  const today = wallString(minute).slice(0, 10);
  const first = `${today.slice(0, 7)}-01`;
  const prev = addDays(first, -1).slice(0, 7);
  return { at: wallMinutes(`${first} ${s.boardTime}`), month: prev };
}

// ── Votes in the comments ───────────────────────────────────────────────────

const ARABIC_DIGITS: Record<string, string> = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const LETTERS: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, "أ": 1, "ا": 1, "إ": 1, "آ": 1, "ب": 2, "ج": 3, "د": 4 };

/**
 * The choice a comment makes (1-based), or null. "2", "٢", "#3", "رقم 1", "B", "ب", "اللقطة 4 🔥"
 * count; a comment naming two different choices, or a number past the last, does not.
 * Letters only count as a whole word ("ب" yes, "بطل" no) in a comment of one or two words.
 * Mentions (@someone12) are not numbers.
 */
export function commentChoice(body: string, choices: number): number | null {
  const text = body.replace(/@\S+/g, " ").replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d] ?? d).toLowerCase();
  const picks = new Set<number>();
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})(?![\d.])/g)) picks.add(Number(m[1]));
  // A letter only in a short comment ("B", "ب 🔥", "team A"): "what a goal" is not a vote for A.
  const words = text.split(/[^\p{L}\d]+/u).filter(Boolean);
  if (words.length <= 2) for (const word of words) if (word in LETTERS) picks.add(LETTERS[word]);
  if (picks.size !== 1) return null;
  const [n] = [...picks];
  return n >= 1 && n <= choices ? n : null;
}

/**
 * One vote per Instagram account: its latest comment that makes a choice. `own` (the field's
 * own account) never votes.
 */
export function commentVotes(comments: Array<{ fromId: string | null; body: string; createdAt: Date }>, choices: number, own: Array<string | null> = []): Map<string, number> {
  const latest = new Map<string, { n: number; at: number }>();
  for (const c of comments) {
    if (!c.fromId || own.includes(c.fromId)) continue;
    const n = commentChoice(c.body, choices);
    if (n === null) continue;
    const prev = latest.get(c.fromId);
    if (!prev || c.createdAt.getTime() >= prev.at) latest.set(c.fromId, { n, at: c.createdAt.getTime() });
  }
  return new Map([...latest].map(([k, v]) => [k, v.n]));
}

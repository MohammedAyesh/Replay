/**
 * "Every child appears": the pure rules (no database).
 *
 *   playersInData     which academy players a creative design is about
 *   squadGrid         the creative hub's squad grid: one cell per child, green /
 *                     amber / red, days since he last appeared, the summary line
 *   footageGaps       children in the squad the analysis found no footage of
 *   rotationOrder     who a "player of the …" draft should go to: whoever has
 *                     waited longest; performance only breaks ties
 *   bestMoment        a child's best moment of a match, for his private clip
 *   ownBaselineNote   how today compares with HIS OWN earlier matches (never
 *                     with another child)
 *
 * Children's rules, enforced here and by the callers:
 *   - a child without public-post consent is "private only": he is never put
 *     in a public post, and the public target does not apply to him;
 *   - rankings of children are never made public (nothing here ranks children
 *     for display; rotationOrder picks one name and says nothing about the rest).
 */

export const AMMAN_TZ = "Asia/Amman";
const DAY = 86_400_000;

// ── Players in a design ─────────────────────────────────────────────────────

export type RosterPlayer = { id: number; number: number | null; isActive: boolean };

type MediaLike = { type?: unknown; playerId?: unknown } | null | undefined;
type DataLike = {
  player?: { playerId?: unknown; number?: unknown; photo?: MediaLike } | null;
  photos?: MediaLike[] | null;
  media?: MediaLike;
  more?: MediaLike[] | null;
  custom?: Record<string, unknown> | null;
} | null | undefined;

const intOf = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const playerOfMedia = (m: MediaLike): number | null =>
  m && typeof m === "object" && m.type === "player" ? intOf(m.playerId) : null;

/** List templates whose rows are players (call-up, line-up): custom.n1 … n9 are shirt numbers. */
export const PLAYER_ROW_TEMPLATES = new Set(["lineup", "callup"]);

/**
 * The academy players a design shows. The template's own player (data.player:
 * his id, else his photo, else his shirt number when exactly one active player
 * wears it) makes the design `solo` when he is the only one. A line-up adds its
 * rows (row photos, else shirt numbers). Pictures of players anywhere count too.
 */
export function playersInData(
  data: DataLike,
  templateKey: string | null,
  roster: RosterPlayer[],
  /** The scene draws data.player (a {{player.*}} binding); a full-time post carries one it never shows. */
  showsPlayer = true,
): { playerIds: number[]; solo: boolean } {
  const known = new Set(roster.map((p) => p.id));
  const byNumber = (n: number | null): number | null => {
    if (n === null) return null;
    const hits = roster.filter((p) => p.isActive && p.number === n);
    return hits.length === 1 ? hits[0].id : null;
  };
  const ids: number[] = [];
  const add = (id: number | null) => { if (id !== null && known.has(id) && !ids.includes(id)) ids.push(id); };

  let main: number | null = null;
  if (showsPlayer && data?.player && typeof data.player === "object") {
    main = intOf(data.player.playerId) ?? playerOfMedia(data.player.photo) ?? byNumber(intOf(data.player.number));
    if (main !== null && !known.has(main)) main = null;
    add(main);
  }
  if (templateKey && PLAYER_ROW_TEMPLATES.has(templateKey)) {
    for (let i = 0; i < 9; i++) {
      add(playerOfMedia(data?.photos?.[i]) ?? byNumber(intOf(data?.custom?.[`n${i + 1}`])));
    }
  }
  add(playerOfMedia(data?.media));
  for (const m of data?.more ?? []) add(playerOfMedia(m));
  return { playerIds: ids, solo: main !== null && ids.length === 1 };
}

// ── Squad grid ──────────────────────────────────────────────────────────────

export type GridPlayer = { id: number; name: string; number: number | null; squadName: string | null; consent: boolean };
export type FeatureRow = { playerId: number; itemType: string; visibility: "public" | "private"; solo: boolean; featuredAt: Date };
/** An analysed match a child played in this month, and whether he got its private clip. */
export type PlayedMatch = { playerId: number; sessionId: number; startsAt: Date };
export type FeatureTargets = { publicPostsPerMonth: number; privateClipPerMatch: boolean };
export const DEFAULT_TARGETS: FeatureTargets = { publicPostsPerMonth: 1, privateClipPerMatch: true };

export type GridStatus = "green" | "amber" | "red";

export type GridCell = {
  playerId: number;
  number: number | null;
  name: string;
  squadName: string | null;
  mode: "public" | "private_only";
  status: GridStatus;
  lastFeaturedAt: string | null;
  daysSince: number | null;
  month: { publicSolo: number; publicAll: number; private: number; analysedMatches: number; clipsReceived: number };
  /** What still has to happen this month for the cell to turn green. */
  missing: Array<"public_post" | "private_clip" | "any">;
};

export type SquadGrid = {
  month: string;
  targets: FeatureTargets;
  cells: GridCell[];
  summary: { featured: number; total: number; notYet: Array<{ playerId: number; number: number | null; name: string }> };
};

/** "2026-11" in Amman. */
export function ammanMonth(at: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: AMMAN_TZ, year: "numeric", month: "2-digit" }).formatToParts(at);
  const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${v.year}-${v.month}`;
}

/** First instant of an Amman calendar month, and of the next one. Jordan is UTC+3 all year. */
export function monthBounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 3 * 3600_000);
  const to = new Date(Date.UTC(y, m, 1) - 3 * 3600_000);
  return { from, to };
}

/**
 * One cell per child. Green: he met this month's target (consented children:
 * the solo public posts; every child: a private clip for each analysed match he
 * played, when that target is on; and at least one appearance of any kind).
 * Red: he has never appeared anywhere. Amber: everything in between, with the
 * days since he last appeared.
 */
export function squadGrid(input: {
  players: GridPlayer[];
  features: FeatureRow[];
  played: PlayedMatch[];
  /** private clips received, by `${sessionId}:${playerId}` */
  clipsReceived: ReadonlySet<string>;
  targets: FeatureTargets;
  now: Date;
  month?: string;
}): SquadGrid {
  const month = input.month ?? ammanMonth(input.now);
  const { from, to } = monthBounds(month);
  const inMonth = (d: Date) => d >= from && d < to;
  const cells: GridCell[] = input.players.map((p) => {
    const mine = input.features.filter((f) => f.playerId === p.id && f.featuredAt <= input.now);
    const last = mine.reduce<Date | null>((a, f) => (!a || f.featuredAt > a ? f.featuredAt : a), null);
    const thisMonth = mine.filter((f) => inMonth(f.featuredAt));
    const publicSolo = thisMonth.filter((f) => f.visibility === "public" && f.solo).length;
    const publicAll = thisMonth.filter((f) => f.visibility === "public").length;
    const priv = thisMonth.filter((f) => f.visibility === "private").length;
    const matches = input.played.filter((m) => m.playerId === p.id && inMonth(m.startsAt));
    const received = matches.filter((m) => input.clipsReceived.has(`${m.sessionId}:${p.id}`)).length;
    const missing: GridCell["missing"] = [];
    if (p.consent && publicSolo < input.targets.publicPostsPerMonth) missing.push("public_post");
    if (input.targets.privateClipPerMatch && received < matches.length) missing.push("private_clip");
    if (!thisMonth.length && !missing.length) missing.push("any");
    const status: GridStatus = !last ? "red" : missing.length ? "amber" : "green";
    return {
      playerId: p.id,
      number: p.number,
      name: p.name,
      squadName: p.squadName,
      mode: p.consent ? "public" : "private_only",
      status,
      lastFeaturedAt: last?.toISOString() ?? null,
      daysSince: last ? Math.floor((input.now.getTime() - last.getTime()) / DAY) : null,
      month: { publicSolo, publicAll, private: priv, analysedMatches: matches.length, clipsReceived: received },
      missing,
    };
  });
  cells.sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name));
  const notYet = cells.filter((c) => c.status !== "green").map((c) => ({ playerId: c.playerId, number: c.number, name: c.name }));
  return { month, targets: input.targets, cells, summary: { featured: cells.length - notYet.length, total: cells.length, notYet } };
}

// ── Footage gaps ────────────────────────────────────────────────────────────

/** A recent analysed match: who was in the squad, who the analysis found (bound to a roster player). */
export type AnalysedMatch = { sessionId: number; startsAt: Date; inSquad: number[]; found: number[] };

export type FootageGap = { playerId: number; matches: number; latestSessionId: number };

/**
 * Children the analysis found no footage of: counted back from the latest
 * analysed match he was in the squad for, the run of matches with no footage
 * of him. "No footage of #7 in the last 3 matches" is { matches: 3 }; the
 * link goes to the latest of them (Matches → Who's who).
 */
export function footageGaps(matches: AnalysedMatch[], playerIds: number[]): FootageGap[] {
  const ordered = [...matches].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  const out: FootageGap[] = [];
  for (const id of playerIds) {
    let run = 0;
    let latest: number | null = null;
    for (const m of ordered) {
      if (!m.inSquad.includes(id)) continue;
      if (m.found.includes(id)) break;
      run += 1;
      latest ??= m.sessionId;
    }
    if (run > 0 && latest !== null) out.push({ playerId: id, matches: run, latestSessionId: latest });
  }
  return out;
}

// ── Rotation ────────────────────────────────────────────────────────────────

/** Waits are compared in whole weeks: within the same week, performance decides. */
export const ROTATION_BUCKET_DAYS = 7;

/**
 * Candidates in the order a "player of the …" draft should take them: longest
 * wait since his last solo public post first (never featured = longest), and
 * only within the same week of waiting does performance (`perf`, bigger is
 * better, compared element by element) break the tie.
 */
export function rotationOrder<T extends { playerId: number }>(
  candidates: T[],
  lastSolo: ReadonlyMap<number, Date | null>,
  perf: (c: T) => number[],
  now: Date,
): T[] {
  const bucket = (id: number) => {
    const at = lastSolo.get(id) ?? null;
    return at ? Math.floor((now.getTime() - at.getTime()) / (ROTATION_BUCKET_DAYS * DAY)) : Number.POSITIVE_INFINITY;
  };
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  return [...candidates].sort((a, b) => {
    const wa = bucket(a.playerId);
    const wb = bucket(b.playerId);
    if (wa !== wb) return wb > wa ? 1 : -1;
    return cmp(perf(a), perf(b)) || a.playerId - b.playerId;
  });
}

// ── A child's best moment and his own baseline ──────────────────────────────

/** Moment kinds from personalMoments, best first; "presence" is the clip of him when nothing was credited. */
export const MOMENT_RANK = ["your-goal", "your-shot", "dribble", "long-pass", "touch-spell", "fastest-run", "completed-pass", "presence"] as const;
export type MomentKind = (typeof MOMENT_RANK)[number];

export function bestMoment<T extends { kind: string; momentSeconds: number }>(moments: T[]): T | null {
  const rank = (k: string) => {
    const i = (MOMENT_RANK as readonly string[]).indexOf(k);
    return i < 0 ? MOMENT_RANK.length : i;
  };
  return [...moments].sort((a, b) => rank(a.kind) - rank(b.kind) || a.momentSeconds - b.momentSeconds)[0] ?? null;
}

export type StatLine = {
  goals?: number | null; dribblesWon?: number | null; passesCompleted?: number | null;
  touches?: number | null; distanceKm?: number | null; topSpeedKmh?: number | null;
};

/** Stats a note can be about, most meaningful to a parent first. */
export const NOTE_STATS = ["goals", "dribblesWon", "passesCompleted", "topSpeedKmh", "distanceKm", "touches"] as const;
export type NoteStat = (typeof NOTE_STATS)[number];

export type BaselineNote =
  | { kind: "above"; stat: NoteStat; value: number; usual: number; matches: number }
  | { kind: "best"; stat: NoteStat; value: number; matches: number }
  | { kind: "first" };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Today against his own earlier matches only. With fewer than two earlier
 * matches there is nothing fair to compare with ("first"). Otherwise the stat
 * where today beats his own usual (median) by the most, and "best" when it is
 * also his highest ever. Null when today beats nothing: the message then just
 * shows the moment, never a "worse than usual".
 */
export function ownBaselineNote(today: StatLine, earlier: StatLine[]): BaselineNote | null {
  let best: { stat: NoteStat; value: number; usual: number; ratio: number; max: number; n: number } | null = null;
  let comparable = 0;
  for (const stat of NOTE_STATS) {
    const value = today[stat];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const past = earlier.map((e) => e[stat]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (past.length < 2) continue;
    comparable = Math.max(comparable, past.length);
    const usual = median(past);
    if (value <= usual) continue;
    const ratio = usual > 0 ? value / usual : value + 1;
    // Tiny gains on continuous stats are noise: 5% for speed and distance.
    if ((stat === "topSpeedKmh" || stat === "distanceKm") && ratio < 1.05) continue;
    if (!best || ratio > best.ratio) best = { stat, value, usual, ratio, max: Math.max(...past), n: past.length };
  }
  if (!best) return comparable === 0 && earlier.length < 2 ? { kind: "first" } : null;
  const round = (v: number) => (best!.stat === "distanceKm" || best!.stat === "topSpeedKmh" ? Math.round(v * 10) / 10 : Math.round(v));
  if (best.value > best.max) return { kind: "best", stat: best.stat, value: round(best.value), matches: best.n };
  return { kind: "above", stat: best.stat, value: round(best.value), usual: round(best.usual), matches: best.n };
}

// ── Wording for the parent's message ────────────────────────────────────────

const MOMENT_WORDS: Record<MomentKind, { en: string; ar: string }> = {
  "your-goal": { en: "his goal", ar: "جوله" },
  "your-shot": { en: "his shot on target", ar: "تسديدته على المرمى" },
  dribble: { en: "his dribble", ar: "مراوغته" },
  "long-pass": { en: "his long pass", ar: "تمريرته الطويلة" },
  "touch-spell": { en: "his spell on the ball", ar: "لمساته على الطابة" },
  "fastest-run": { en: "his fastest run", ar: "أسرع ركضة إله" },
  "completed-pass": { en: "his pass", ar: "تمريرته" },
  presence: { en: "him in action", ar: "لقطة إله بالماتش" },
};

const STAT_WORDS: Record<NoteStat, { en: (v: number) => string; ar: (v: number) => string }> = {
  goals: { en: (v) => `${v} goal${v === 1 ? "" : "s"}`, ar: (v) => (v === 1 ? "جول" : v === 2 ? "جولين" : `${v} جوالات`) },
  dribblesWon: { en: (v) => `${v} dribble${v === 1 ? "" : "s"} won`, ar: (v) => `${v} مراوغات ناجحة` },
  passesCompleted: { en: (v) => `${v} completed pass${v === 1 ? "" : "es"}`, ar: (v) => `${v} تمريرات صحيحة` },
  topSpeedKmh: { en: (v) => `a top speed of ${v} km/h`, ar: (v) => `سرعة ${v} كم/س` },
  distanceKm: { en: (v) => `${v} km run`, ar: (v) => `${v} كم ركض` },
  touches: { en: (v) => `${v} touches`, ar: (v) => `${v} لمسة` },
};

export function momentWords(kind: string, locale: "ar" | "en"): string {
  return (MOMENT_WORDS[kind as MomentKind] ?? MOMENT_WORDS.presence)[locale];
}

/** " — 3 dribbles won, more than his usual 1" / "" (never a comparison with anyone else). */
export function noteWords(note: BaselineNote | null, locale: "ar" | "en"): string {
  if (!note || note.kind === "first") return "";
  const w = STAT_WORDS[note.stat];
  if (note.kind === "best") {
    return locale === "ar" ? ` — ${w.ar(note.value)}، أحسن رقم إله لهلأ` : ` — ${w.en(note.value)}, his best yet`;
  }
  return locale === "ar"
    ? ` — ${w.ar(note.value)}، أكثر من معدّله (${note.usual})`
    : ` — ${w.en(note.value)}, more than his usual ${note.usual}`;
}

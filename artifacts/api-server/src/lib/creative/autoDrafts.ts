import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { academyCreativeProjectsTable, academySessionsTable, db, type Academy } from "@workspace/db";
import {
  CREATIVE_STYLES,
  CREATIVE_TEMPLATES,
  buildTemplateScene,
  sceneSchema,
  type CreativeData,
  type CreativeStyle,
  type Scene,
  type TemplateMeta,
} from "@workspace/api-zod";
import { logger } from "../logger";
import {
  academyCreativeProfile,
  buildSessionData,
  fallbackWindow,
  frameSource,
  goalsAreOurs,
  loadSessionFacts,
  pickPlayerOfMatch,
  playerLabel,
  playerStatsSummary,
  rankedMoments,
  soleScorer,
  windowSource,
  type CreativeLocale,
  type SessionFacts,
  type SessionMoment,
} from "./sessionData";

/**
 * Creative hub → For you: drafts Replay prepares on its own.
 *
 * After a finished match (last 14 days): full time, a clean sheet, player of
 * the match, and the academy's confirmed goals as short videos. Before a
 * fixture (next 7 days): a matchday post. Once a week: a clip from the
 * week's training, when a training was filmed.
 *
 * Every draft carries origin 'auto' and a stable origin_key, inserted with
 * ON CONFLICT DO NOTHING on (academy_id, origin_key): running twice makes
 * nothing new, and a draft the owner skipped (kept as status 'skipped') is
 * never made again.
 */

export const FOR_YOU = {
  /** finished matches this recent get drafts */
  pastDays: 14,
  /** fixtures this soon get a matchday draft */
  aheadDays: 7,
  /** a match with no end time is over this long after kick-off */
  assumedMatchMinutes: 100,
  /** goal videos per match, at most */
  goalsPerMatch: 3,
  /** sessions looked at per sync, at most */
  maxSessions: 40,
  /** one sync per academy per this long (in memory) */
  syncIntervalMs: 10 * 60_000,
  /** drafts older than this leave the feed (they stay in the Library) */
  feedDays: 21,
  /** drafts are made in Arabic */
  locale: "ar" as CreativeLocale,
  defaultStyle: "broadcast" as CreativeStyle,
} as const;

const DAY = 86_400_000;

// ── Origin keys ─────────────────────────────────────────────────────────────

export type DraftKind = "fulltime" | "cleansheet" | "potm" | "goal" | "matchday" | "weekly";
export type FeedGroup = "after" | "upcoming" | "week";

export const originKey = {
  fulltime: (sessionId: number) => `fulltime:session:${sessionId}`,
  cleansheet: (sessionId: number) => `cleansheet:session:${sessionId}`,
  potm: (sessionId: number) => `potm:session:${sessionId}`,
  matchday: (sessionId: number) => `matchday:session:${sessionId}`,
  goal: (momentId: string) => `goal:moment:${momentId}`,
  weekly: (isoWeek: string) => `weekly:${isoWeek}`,
};

export type ParsedOriginKey =
  | { kind: Exclude<DraftKind, "goal" | "weekly">; sessionId: number }
  | { kind: "goal"; momentId: string }
  | { kind: "weekly"; week: string };

export function parseOriginKey(key: string | null | undefined): ParsedOriginKey | null {
  if (!key) return null;
  let m = /^(fulltime|cleansheet|potm|matchday):session:(\d+)$/.exec(key);
  if (m) return { kind: m[1] as "fulltime", sessionId: Number(m[2]) };
  m = /^goal:moment:([\w-]+)$/.exec(key);
  if (m) return { kind: "goal", momentId: m[1] };
  m = /^weekly:(\d{4}-W\d{2})$/.exec(key);
  if (m) return { kind: "weekly", week: m[1] };
  return null;
}

export const groupOf = (kind: DraftKind): FeedGroup =>
  kind === "matchday" ? "upcoming" : kind === "weekly" ? "week" : "after";

/** Which catalogue template each kind of draft is made from. */
export const TEMPLATE_FOR: Record<DraftKind, string> = {
  fulltime: "fulltime",
  cleansheet: "cleansheet",
  potm: "potm",
  goal: "goal",
  matchday: "matchday",
  weekly: "training",
};

// ── Amman calendar ──────────────────────────────────────────────────────────

/** Year, month, day of a moment on the Amman calendar. */
export function ammanYmd(date: Date): { y: number; m: number; d: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)) {
    p[part.type] = part.value;
  }
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** ISO week ("2026-W45") of the Amman calendar day the moment falls on. */
export function isoWeekKey(date: Date): string {
  const { y, m, d } = ammanYmd(date);
  const day = new Date(Date.UTC(y, m - 1, d));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function isFinished(s: { startsAt: Date; endsAt: Date | null }, now: Date): boolean {
  const end = s.endsAt ?? new Date(s.startsAt.getTime() + FOR_YOU.assumedMatchMinutes * 60_000);
  return end.getTime() <= now.getTime();
}

// ── Throttle ────────────────────────────────────────────────────────────────

export function shouldSync(lastRunMs: number | undefined, nowMs: number, intervalMs: number = FOR_YOU.syncIntervalMs): boolean {
  return lastRunMs === undefined || nowMs - lastRunMs >= intervalMs;
}

// ── Planning (pure) ─────────────────────────────────────────────────────────

export type DraftPlan = {
  kind: DraftKind;
  originKey: string;
  templateKey: string;
  sessionId: number | null;
  data: CreativeData;
  /** The footage the draft is built around; a still uses its frame, a video its window. */
  moment: SessionMoment | null;
  title: string;
};

/** The week's draft: a clip from its latest filmed training. */
export type WeekFacts = {
  isoWeek: string;
  training: SessionFacts | null;
};

const AR = {
  fulltime: "نهاية المباراة",
  cleansheet: "شباك نظيفة",
  potm: "نجم المباراة",
  goal: "هدف",
  matchday: "يوم المباراة",
  weekly: "من تمرين الأسبوع",
  vs: "ضد",
};
const EN = {
  fulltime: "Full time",
  cleansheet: "Clean sheet",
  potm: "Player of the match",
  goal: "Goal",
  matchday: "Matchday",
  weekly: "This week's training",
  vs: "vs",
};

/** A human title for the draft, in the draft's language. */
export function draftTitle(kind: DraftKind, facts: SessionFacts | null, locale: CreativeLocale, extra: { player?: string | null } = {}): string {
  const w = locale === "ar" ? AR : EN;
  const bits: string[] = [w[kind]];
  if (facts) {
    const s = facts.session;
    if (s.opponent) {
      const score = s.ownScore !== null && s.opponentScore !== null && kind !== "matchday" ? ` ${s.ownScore}–${s.opponentScore}` : "";
      bits.push(`${w.vs} ${s.opponent}${score}`);
    } else if (s.squad) {
      bits.push(s.squad);
    }
  }
  if ((kind === "potm" || kind === "goal") && extra.player) bits.push(extra.player);
  return bits.join(" · ").slice(0, 120);
}

/**
 * The drafts these facts call for that do not exist yet. `existing` holds
 * every origin key the academy already has, skipped ones included.
 */
export function planAutoDrafts(input: {
  now: Date;
  sessions: SessionFacts[];
  week: WeekFacts | null;
  existing: ReadonlySet<string>;
  locale?: CreativeLocale;
}): DraftPlan[] {
  const locale = input.locale ?? FOR_YOU.locale;
  const out: DraftPlan[] = [];
  const seen = new Set(input.existing);
  const add = (plan: DraftPlan) => {
    if (seen.has(plan.originKey)) return;
    seen.add(plan.originKey);
    out.push(plan);
  };
  const now = input.now.getTime();

  for (const facts of input.sessions) {
    const s = facts.session;
    if (s.type !== "match") continue;
    const base = buildSessionData(facts, locale);
    const best = rankedMoments(facts)[0] ?? null;
    const starts = s.startsAt.getTime();

    if (isFinished(s, input.now) && starts >= now - FOR_YOU.pastDays * DAY) {
      const scored = s.ownScore !== null && s.opponentScore !== null;
      if (scored) {
        add({ kind: "fulltime", originKey: originKey.fulltime(s.id), templateKey: TEMPLATE_FOR.fulltime, sessionId: s.id, data: base, moment: best, title: draftTitle("fulltime", facts, locale) });
        if (s.opponentScore === 0) {
          // The clean-sheet card names one player (meant for the keeper): leave it for the owner to fill.
          const { player: _potm, ...team } = base;
          add({ kind: "cleansheet", originKey: originKey.cleansheet(s.id), templateKey: TEMPLATE_FOR.cleansheet, sessionId: s.id, data: team, moment: best, title: draftTitle("cleansheet", facts, locale) });
        }
      }
      const potm = pickPlayerOfMatch(facts.players);
      if (potm) {
        const label = playerLabel(potm, facts.showNames);
        add({
          kind: "potm", originKey: originKey.potm(s.id), templateKey: TEMPLATE_FOR.potm, sessionId: s.id,
          // A player template reads the player's own numbers as stats.goals, stats.distanceKm, …
          data: { ...base, stats: { ...(base.stats ?? {}), ...playerStatsSummary(potm.stats) } },
          moment: best, title: draftTitle("potm", facts, locale, { player: label }),
        });
      }
      if (goalsAreOurs(facts)) {
        // A goal clip names its scorer only when one player scored them all.
        const { player: _potm, more: _more, ...team } = base;
        const scorer = soleScorer(facts.players);
        const label = scorer ? playerLabel(scorer, facts.showNames) : null;
        const data: CreativeData = scorer
          ? { ...team, player: { name: facts.showNames ? playerLabel({ name: scorer.name, number: null }, true) : null, number: scorer.number, ...(s.squad ? { squad: s.squad } : {}) } }
          : team;
        const goals = [...facts.goals].sort((a, b) => b.weight - a.weight || a.atMs - b.atMs).slice(0, FOR_YOU.goalsPerMatch);
        for (const g of goals.sort((a, b) => a.atMs - b.atMs)) {
          add({ kind: "goal", originKey: originKey.goal(g.id), templateKey: TEMPLATE_FOR.goal, sessionId: s.id, data: { ...data, media: windowSource(g) }, moment: g, title: draftTitle("goal", facts, locale, { player: label }) });
        }
      }
    } else if (starts >= now && starts < now + FOR_YOU.aheadDays * DAY) {
      // A fixture: no score and no footage yet.
      const { media: _media, more: _more, stats: _stats, player: _player, ...fixture } = base;
      add({ kind: "matchday", originKey: originKey.matchday(s.id), templateKey: TEMPLATE_FOR.matchday, sessionId: s.id, data: fixture, moment: null, title: draftTitle("matchday", facts, locale) });
    }
  }

  const training = input.week?.training ?? null;
  if (input.week && training && training.recording) {
    const data = buildSessionData(training, locale);
    const { player: _player, stats: _stats, ...clip } = data;
    const best = rankedMoments(training)[0] ?? null;
    clip.media = best ? windowSource(best) : fallbackWindow(training.recording);
    clip.custom = { headline: locale === "ar" ? AR.weekly : EN.weekly };
    add({
      kind: "weekly", originKey: originKey.weekly(input.week.isoWeek), templateKey: TEMPLATE_FOR.weekly, sessionId: training.session.id,
      data: clip, moment: best, title: draftTitle("weekly", training, locale),
    });
  }
  return out;
}

/** The most used style among the academy's projects, else the default. */
export function preferredStyle(counts: Array<{ style: string | null; count: number }>): CreativeStyle {
  const valid = counts.filter((c): c is { style: CreativeStyle; count: number } =>
    c.style !== null && (CREATIVE_STYLES as readonly string[]).includes(c.style) && c.count > 0);
  valid.sort((a, b) => b.count - a.count || CREATIVE_STYLES.indexOf(a.style) - CREATIVE_STYLES.indexOf(b.style));
  return valid[0]?.style ?? FOR_YOU.defaultStyle;
}

export type DraftRow = typeof academyCreativeProjectsTable.$inferInsert;

/**
 * The row for a plan, or null when the catalogue has no such template yet
 * (the draft is made on a later sync once it does).
 */
export function materializeDraft(
  plan: DraftPlan,
  academyId: number,
  style: CreativeStyle,
  catalogue: { templates: TemplateMeta[]; build: typeof buildTemplateScene } = { templates: CREATIVE_TEMPLATES, build: buildTemplateScene },
  locale: CreativeLocale = FOR_YOU.locale,
): DraftRow | null {
  const meta = catalogue.templates.find((t) => t.key === plan.templateKey);
  if (!meta) return null;
  let scene: Scene;
  try {
    const parsed = sceneSchema.safeParse(catalogue.build(meta.key, style, meta.formats[0] ?? "post", locale));
    if (!parsed.success) {
      logger.warn({ template: meta.key, style, issues: parsed.error.issues.slice(0, 3) }, "Creative template built an invalid scene");
      return null;
    }
    scene = parsed.data;
  } catch (error) {
    logger.warn({ template: meta.key, style, error: (error as Error).message }, "Creative template failed to build");
    return null;
  }
  const isVideo = scene.durationMs !== undefined;
  const data: CreativeData = { ...plan.data };
  if (plan.moment) data.media = isVideo ? windowSource(plan.moment) : frameSource(plan.moment);
  return {
    academyId,
    kind: isVideo ? "video" : "image",
    format: scene.format,
    title: plan.title,
    templateKey: meta.key,
    style,
    status: "draft",
    origin: "auto",
    originKey: plan.originKey,
    sourceSessionId: plan.sessionId,
    scene,
    data,
  };
}

// ── Sync (DB) ───────────────────────────────────────────────────────────────

async function styleFor(academyId: number): Promise<CreativeStyle> {
  const rows = await db.select({ style: academyCreativeProjectsTable.style, count: sql<number>`count(*)::int` })
    .from(academyCreativeProjectsTable)
    .where(and(eq(academyCreativeProjectsTable.academyId, academyId), isNotNull(academyCreativeProjectsTable.style)))
    .groupBy(academyCreativeProjectsTable.style);
  return preferredStyle(rows.map((r) => ({ style: r.style, count: Number(r.count) })));
}

/** Make the drafts the academy's recent and coming matches call for. Returns how many were added. */
export async function syncAutoDrafts(academy: Academy, now = new Date()): Promise<number> {
  const academyId = academy.id;
  const weekStart = new Date(now.getTime() - 7 * DAY);
  const [profile, sessionRows, existingRows, style, trainingRows] = await Promise.all([
    academyCreativeProfile(academy),
    db.select({ id: academySessionsTable.id }).from(academySessionsTable)
      .where(and(
        eq(academySessionsTable.academyId, academyId),
        eq(academySessionsTable.type, "match"),
        gte(academySessionsTable.startsAt, new Date(now.getTime() - FOR_YOU.pastDays * DAY)),
        lt(academySessionsTable.startsAt, new Date(now.getTime() + FOR_YOU.aheadDays * DAY)),
      ))
      .orderBy(desc(academySessionsTable.startsAt))
      .limit(FOR_YOU.maxSessions),
    db.select({ key: academyCreativeProjectsTable.originKey }).from(academyCreativeProjectsTable)
      .where(and(eq(academyCreativeProjectsTable.academyId, academyId), isNotNull(academyCreativeProjectsTable.originKey))),
    styleFor(academyId),
    db.select({ id: academySessionsTable.id }).from(academySessionsTable)
      .where(and(
        eq(academySessionsTable.academyId, academyId),
        eq(academySessionsTable.type, "training"),
        gte(academySessionsTable.startsAt, weekStart),
        lt(academySessionsTable.startsAt, now),
      ))
      .orderBy(desc(academySessionsTable.startsAt))
      .limit(5),
  ]);
  const sessions: SessionFacts[] = [];
  for (const row of sessionRows) {
    const facts = await loadSessionFacts(academyId, row.id, profile);
    if (facts) sessions.push(facts);
  }
  const isoWeek = isoWeekKey(now);
  let training: SessionFacts | null = null;
  for (const row of trainingRows) {
    const facts = await loadSessionFacts(academyId, row.id, profile);
    // This ISO week's (Amman) latest filmed training, finished.
    if (facts?.recording && isoWeekKey(facts.session.startsAt) === isoWeek && isFinished(facts.session, now)) { training = facts; break; }
  }
  const locale = FOR_YOU.locale;
  const plans = planAutoDrafts({
    now,
    sessions,
    week: { isoWeek, training },
    existing: new Set(existingRows.map((r) => r.key).filter((k): k is string => Boolean(k))),
    locale,
  });
  const rows = plans.map((p) => materializeDraft(p, academyId, style)).filter((r): r is DraftRow => r !== null);
  if (!rows.length) return 0;
  const inserted = await db.insert(academyCreativeProjectsTable).values(rows)
    .onConflictDoNothing({
      target: [academyCreativeProjectsTable.academyId, academyCreativeProjectsTable.originKey],
      where: sql`${academyCreativeProjectsTable.originKey} is not null`,
    })
    .returning({ id: academyCreativeProjectsTable.id });
  return inserted.length;
}

const lastSync = new Map<number, number>();
const running = new Map<number, Promise<void>>();

/** syncAutoDrafts at most once per academy per FOR_YOU.syncIntervalMs; never throws. */
export async function ensureAutoDrafts(academy: Academy, now = new Date()): Promise<void> {
  const inFlight = running.get(academy.id);
  if (inFlight) return inFlight;
  if (!shouldSync(lastSync.get(academy.id), now.getTime())) return;
  lastSync.set(academy.id, now.getTime());
  const job = (async () => {
    try {
      const added = await syncAutoDrafts(academy, now);
      if (added) logger.info({ academyId: academy.id, added }, "Creative hub: drafts prepared");
    } catch (error) {
      logger.warn({ academyId: academy.id, error: (error as Error).message }, "Creative hub: draft sync failed");
    } finally {
      running.delete(academy.id);
    }
  })();
  running.set(academy.id, job);
  return job;
}

/** For tests: forget when each academy last synced. */
export function resetAutoDraftThrottle(): void {
  lastSync.clear();
}

// ── Feed ────────────────────────────────────────────────────────────────────

/**
 * Whether a draft still belongs in the feed: a matchday post until kick-off,
 * the week's schedule during its week, the rest for FOR_YOU.feedDays.
 */
export function inFeed(parsed: ParsedOriginKey | null, createdAt: Date, session: { startsAt: Date } | null, now: Date): boolean {
  if (!parsed) return false;
  if (parsed.kind === "matchday") return session ? session.startsAt.getTime() > now.getTime() : false;
  if (parsed.kind === "weekly") return parsed.week === isoWeekKey(now);
  return now.getTime() - createdAt.getTime() <= FOR_YOU.feedDays * DAY;
}

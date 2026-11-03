import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { academyAdMediaTable, academyCreativeProjectsTable, academyMatchLineupsTable, academyPhoneMediaTable, academyPlayersTable, academySessionsTable, db, type Academy } from "@workspace/db";
import {
  type CreativeFormat,
  PUBLIC_STYLES,
  CREATIVE_TEMPLATES,
  buildTemplateScene,
  sceneSchema,
  type CreativeData,
  type CreativeStyle,
  type Scene,
  type TemplateMeta,
} from "@workspace/api-zod";
import { logger } from "../logger";
import { academyPack } from "./packs";
import { ensureReplayMusic, replayLibrary, sceneWithDefaultMusic, templateMusicOverrides } from "./music";
import { loadFeaturedFacts } from "../featured/draftFacts";
import { consentedFacts, matchFeaturedPlans, playerData, rotatedPlayerOfMatch, weekFeaturedPlans, type FeaturedFacts, type FeaturedPlan } from "../featured/drafts";

/**
 * Replay's library and the admins' template music for drafts' default
 * soundtracks; an empty library when it can't be read (drafts are made
 * without music), Replay's own picks when the admin choices can't be.
 */
async function replayLibraryForDrafts() {
  try {
    await ensureReplayMusic();
    const library = await replayLibrary();
    const overrides = await templateMusicOverrides().catch(() => new Map());
    return { library, overrides };
  } catch {
    return { library: [], overrides: new Map() };
  }
}
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
  teamStatsSummary,
  windowSource,
  type CreativeLocale,
  type SessionFacts,
  type SessionMoment,
} from "./sessionData";

/**
 * Creative hub → For you: drafts Replay prepares on its own.
 *
 * After a finished match (last 14 days): full time, a clean sheet, player of
 * the match, the academy's confirmed goals as short videos, and the match
 * stats once the match was analysed. Before a fixture (next 7 days): a
 * matchday post; two days before (Amman calendar) a countdown; the day before
 * a squad call-up, when the owner picked the squad (match line-up). Once a
 * week: a clip from the week's training, when a training was filmed.
 *
 * Drafts use the academy's brand pack style when it has one (academies.
 * creative_pack), else the style it uses most.
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

export type DraftKind = "fulltime" | "cleansheet" | "potm" | "goal" | "matchday" | "countdown" | "callup" | "matchstats" | "weekly"
  | "improved" | "firstgoal" | "meet" | "streak" | "weekmoment"
  | "phonebefore" | "phoneafter" | "goalduo";
export type FeedGroup = "after" | "upcoming" | "week";

export const originKey = {
  fulltime: (sessionId: number) => `fulltime:session:${sessionId}`,
  cleansheet: (sessionId: number) => `cleansheet:session:${sessionId}`,
  potm: (sessionId: number) => `potm:session:${sessionId}`,
  matchday: (sessionId: number) => `matchday:session:${sessionId}`,
  countdown: (sessionId: number) => `countdown:session:${sessionId}`,
  callup: (sessionId: number) => `callup:session:${sessionId}`,
  matchstats: (sessionId: number) => `matchstats:session:${sessionId}`,
  goal: (momentId: string) => `goal:moment:${momentId}`,
  weekly: (isoWeek: string) => `weekly:${isoWeek}`,
  improved: (sessionId: number) => `improved:session:${sessionId}`,
  firstgoal: (playerId: number) => `firstgoal:player:${playerId}`,
  meet: (isoWeek: string) => `meet:${isoWeek}`,
  streak: (isoWeek: string) => `streak:${isoWeek}`,
  weekmoment: (isoWeek: string) => `weekmoment:${isoWeek}`,
  phonebefore: (sessionId: number) => `phonebefore:session:${sessionId}`,
  phoneafter: (sessionId: number) => `phoneafter:session:${sessionId}`,
  goalduo: (momentId: string) => `goalduo:moment:${momentId}`,
};

/** Kinds made once per ISO week. */
const WEEK_KINDS = new Set<DraftKind>(["weekly", "meet", "streak", "weekmoment"]);

export type ParsedOriginKey =
  | { kind: Exclude<DraftKind, "goal" | "goalduo" | "weekly" | "firstgoal" | "meet" | "streak" | "weekmoment">; sessionId: number }
  | { kind: "goal" | "goalduo"; momentId: string }
  | { kind: "firstgoal"; playerId: number }
  | { kind: "weekly" | "meet" | "streak" | "weekmoment"; week: string };

export function parseOriginKey(key: string | null | undefined): ParsedOriginKey | null {
  if (!key) return null;
  let m = /^(fulltime|cleansheet|potm|matchday|countdown|callup|matchstats|improved|phonebefore|phoneafter):session:(\d+)$/.exec(key);
  if (m) return { kind: m[1] as "fulltime", sessionId: Number(m[2]) };
  m = /^(goal|goalduo):moment:([\w-]+)$/.exec(key);
  if (m) return { kind: m[1] as "goal", momentId: m[2] };
  m = /^(weekly|meet|streak|weekmoment):(\d{4}-W\d{2})$/.exec(key);
  if (m) return { kind: m[1] as "weekly", week: m[2] };
  m = /^firstgoal:player:(\d+)$/.exec(key);
  if (m) return { kind: "firstgoal", playerId: Number(m[1]) };
  return null;
}

/** Drafts about a coming fixture: in the feed until kick-off. */
export const isFixtureKind = (kind: DraftKind) => kind === "matchday" || kind === "countdown" || kind === "callup" || kind === "phonebefore";

export const groupOf = (kind: DraftKind): FeedGroup =>
  isFixtureKind(kind) ? "upcoming" : WEEK_KINDS.has(kind) ? "week" : "after";

/** Which catalogue template each kind of draft is made from. */
export const TEMPLATE_FOR: Record<DraftKind, string> = {
  fulltime: "fulltime",
  cleansheet: "cleansheet",
  potm: "potm",
  goal: "goal",
  matchday: "matchday",
  countdown: "countdown",
  callup: "callup",
  matchstats: "matchstats",
  weekly: "training",
  improved: "improved",
  firstgoal: "firstgoal",
  meet: "meetplayer",
  streak: "streak",
  weekmoment: "weekmoment",
  phonebefore: "matchday",
  phoneafter: "fulltime",
  goalduo: "goalduo",
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

/** Whole Amman calendar days from `now` to `date` (0 = today, 1 = tomorrow). */
export function ammanDaysUntil(date: Date, now: Date): number {
  const a = ammanYmd(now);
  const b = ammanYmd(date);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY);
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
  /** A format other than the template's first (a phone photo before the match makes a story). */
  format?: CreativeFormat;
  /** Changes to named layers of the built scene (the phone angle's trim in a two-angle reel). */
  layerPatch?: Record<string, Partial<{ trimInMs: number; trimOutMs: number }>>;
};

/** A phone file sorted against a session (lib/phoneMedia). */
export type PhoneFact = { mediaId: number; kind: "image" | "video"; phase: "before" | "during" | "after"; offsetSec: number | null; durationSec: number | null; recordingId: number | null; playerIds: number[] };

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
  countdown: "العد التنازلي",
  callup: "قائمة الماتش",
  matchstats: "أرقام الماتش",
  weekly: "من تمرين الأسبوع",
  improved: "الأكثر تطوّراً",
  firstgoal: "أول جول",
  meet: "تعرّفوا على اللاعب",
  streak: "ما بغيب",
  weekmoment: "لقطة الأسبوع",
  phonebefore: "قبل الماتش",
  phoneafter: "بعد الماتش",
  goalduo: "الجول من زاويتين",
  vs: "ضد",
};
const EN = {
  fulltime: "Full time",
  cleansheet: "Clean sheet",
  potm: "Player of the match",
  goal: "Goal",
  matchday: "Matchday",
  countdown: "Countdown",
  callup: "Squad call-up",
  matchstats: "Match stats",
  weekly: "This week's training",
  improved: "Most improved",
  firstgoal: "First goal",
  meet: "Meet the player",
  streak: "Attendance streak",
  weekmoment: "Moment of the week",
  phonebefore: "Before the match",
  phoneafter: "After the match",
  goalduo: "Goal from two angles",
  vs: "vs",
};

/** A human title for the draft, in the draft's language. */
export function draftTitle(kind: DraftKind, facts: SessionFacts | null, locale: CreativeLocale, extra: { player?: string | null } = {}): string {
  const w = locale === "ar" ? AR : EN;
  const bits: string[] = [w[kind]];
  if (facts) {
    const s = facts.session;
    if (s.opponent) {
      const score = s.ownScore !== null && s.opponentScore !== null && !isFixtureKind(kind) ? ` ${s.ownScore}–${s.opponentScore}` : "";
      bits.push(`${w.vs} ${s.opponent}${score}`);
    } else if (s.squad) {
      bits.push(s.squad);
    }
  }
  if ((kind === "potm" || kind === "goal" || kind === "improved" || kind === "firstgoal" || kind === "meet" || kind === "streak") && extra.player) bits.push(extra.player);
  return bits.join(" · ").slice(0, 120);
}

/** A player the owner put in a fixture's squad (academy_match_lineups, in_squad). */
export type CallupPlayer = { name: string | null; number: number | null; position: string | null; playerId?: number };

/** Rows the call-up template has. */
export const CALLUP_ROWS = 9;

const POSITIONS: Array<{ re: RegExp; en: string; ar: string }> = [
  { re: /^(gk|goal ?keeper|keeper|حارس)/i, en: "GK", ar: "حارس" },
  { re: /^(df|def|defen[cs]e|defender|back|cb|lb|rb|دفاع|مدافع)/i, en: "DF", ar: "دفاع" },
  { re: /^(mf|mid|midfield|midfielder|cm|dm|am|وسط)/i, en: "MF", ar: "وسط" },
  { re: /^(fw|fwd|forward|striker|attack|attacker|winger|st|هجوم|مهاجم)/i, en: "FW", ar: "هجوم" },
];

/** A short position label ("GK" / "حارس"); anything unrecognised is kept, shortened. */
export function positionLabel(raw: string | null | undefined, locale: CreativeLocale): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  const hit = POSITIONS.find((p) => p.re.test(v));
  return hit ? hit[locale === "ar" ? "ar" : "en"] : v.slice(0, 12);
}

/**
 * The call-up template's rows (custom.n1/p1/pos1 … n9/p9/pos9): shirt order,
 * goalkeepers first. Names only when the academy shows them, else blank (the
 * number says who it is), as every other draft does.
 */
export function callupCustom(players: CallupPlayer[], showNames: boolean, locale: CreativeLocale): Record<string, string> {
  const gk = (p: CallupPlayer) => (positionLabel(p.position, "en") === "GK" ? 0 : 1);
  const rows = [...players]
    .sort((a, b) => gk(a) - gk(b) || (a.number ?? 999) - (b.number ?? 999) || (a.name ?? "").localeCompare(b.name ?? ""))
    .slice(0, CALLUP_ROWS);
  const out: Record<string, string> = {};
  rows.forEach((p, i) => {
    out[`n${i + 1}`] = p.number !== null && p.number !== undefined ? String(p.number) : "";
    out[`p${i + 1}`] = showNames ? playerLabel({ name: p.name, number: null }, true) ?? "" : "";
    out[`pos${i + 1}`] = positionLabel(p.position, locale);
  });
  return out;
}

/**
 * The drafts these facts call for that do not exist yet. `existing` holds
 * every origin key the academy already has, skipped ones included.
 * `callups` holds each fixture's squad (by session id), when the owner picked one.
 */
export function planAutoDrafts(input: {
  now: Date;
  sessions: SessionFacts[];
  week: WeekFacts | null;
  existing: ReadonlySet<string>;
  locale?: CreativeLocale;
  callups?: ReadonlyMap<number, CallupPlayer[]>;
  /**
   * Every child appears (lib/featured): consent, rotation, pictures, history and
   * streaks. With it, player drafts go by rotation, children without public-post
   * consent are left out, and the five "every child" drafts are planned.
   */
  featured?: FeaturedFacts;
  /** This week's finished filmed sessions, for the moment of the week. */
  weekSessions?: SessionFacts[];
  academyData?: CreativeData["academy"];
  /** Phone files sorted against each session (by session id): before / during / after. */
  phone?: ReadonlyMap<number, PhoneFact[]>;
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
  const featured = input.featured;
  const addFeatured = (plan: FeaturedPlan, facts: SessionFacts | null, moment: SessionMoment | null) => add({
    kind: plan.kind, originKey: plan.originKey, templateKey: plan.templateKey, sessionId: plan.sessionId,
    data: plan.data, moment, title: draftTitle(plan.kind, facts, locale, { player: plan.label }),
  });

  for (const facts of input.sessions) {
    const s = facts.session;
    if (s.type !== "match") continue;
    // A child without public-post consent is left out of every list a draft shows (scorers, line-up).
    const base = buildSessionData(featured ? consentedFacts(facts, featured) : facts, locale);
    if (featured) delete base.player;
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
      // With the feature log: whoever has waited longest among those who played; performance breaks ties.
      const potm = featured ? rotatedPlayerOfMatch(facts.players, featured, input.now) : pickPlayerOfMatch(facts.players);
      if (potm) {
        const label = playerLabel(potm, facts.showNames);
        add({
          kind: "potm", originKey: originKey.potm(s.id), templateKey: TEMPLATE_FOR.potm, sessionId: s.id,
          // A player template reads the player's own numbers as stats.goals, stats.distanceKm, …
          data: {
            ...base,
            ...(featured ? { player: playerData(potm, featured, s.squad) } : {}),
            stats: { ...(base.stats ?? {}), ...playerStatsSummary(potm.stats) },
          },
          moment: best, title: draftTitle("potm", facts, locale, { player: label }),
        });
      }
      // The match stats card, once the analysis measured the team's numbers.
      const teamStats = teamStatsSummary(facts.team);
      if (Object.keys(teamStats).length) {
        const { player: _player, more: _more, media: _media, ...match } = base;
        add({
          kind: "matchstats", originKey: originKey.matchstats(s.id), templateKey: TEMPLATE_FOR.matchstats, sessionId: s.id,
          data: { ...match, stats: teamStats }, moment: null, title: draftTitle("matchstats", facts, locale),
        });
      }
      if (goalsAreOurs(facts)) {
        // A goal clip names its scorer only when one player scored them all.
        const { player: _potm, more: _more, ...team } = base;
        const sole = soleScorer(facts.players);
        const scorer = sole && (!featured || featured.consent.has(sole.playerId)) ? sole : null;
        const label = scorer ? playerLabel(scorer, facts.showNames) : null;
        const data: CreativeData = scorer
          ? { ...team, player: { ...(featured ? { playerId: scorer.playerId } : {}), name: facts.showNames ? playerLabel({ name: scorer.name, number: null }, true) : null, number: scorer.number, ...(s.squad ? { squad: s.squad } : {}) } as CreativeData["player"] }
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
      const daysUntil = ammanDaysUntil(s.startsAt, input.now);
      if (daysUntil === 2) {
        add({
          kind: "countdown", originKey: originKey.countdown(s.id), templateKey: TEMPLATE_FOR.countdown, sessionId: s.id,
          data: { ...fixture, custom: { days: "2" } }, moment: null, title: draftTitle("countdown", facts, locale),
        });
      }
      const squad = (input.callups?.get(s.id) ?? []).filter((p) => !featured || p.playerId === undefined || featured.consent.has(p.playerId));
      if (daysUntil === 1 && squad.length) {
        add({
          kind: "callup", originKey: originKey.callup(s.id), templateKey: TEMPLATE_FOR.callup, sessionId: s.id,
          data: { ...fixture, custom: callupCustom(squad, facts.showNames, locale) }, moment: null, title: draftTitle("callup", facts, locale),
        });
      }
    }
  }

  // Phone files sorted by match time. A file showing a child without consent stays out of public drafts.
  const phoneOk = (f: PhoneFact) => !featured || f.playerIds.every((id) => featured.consent.has(id));
  for (const facts of input.sessions) {
    const files = (input.phone?.get(facts.session.id) ?? []).filter(phoneOk);
    if (!files.length || facts.session.type !== "match") continue;
    const s = facts.session;
    const shown = buildSessionData(featured ? consentedFacts(facts, featured) : facts, locale);
    if (featured) delete shown.player;
    const photo = (phase: PhoneFact["phase"]) => [...files].reverse().find((f) => f.phase === phase && f.kind === "image");
    // Before: a story for match day from the touchline (the squad warming up, the kit).
    const before = photo("before");
    if (before && !isFinished(s, input.now)) {
      const { stats: _st, more: _mo, ...fixture } = shown;
      add({ kind: "phonebefore", originKey: originKey.phonebefore(s.id), templateKey: TEMPLATE_FOR.phonebefore, sessionId: s.id,
        data: { ...fixture, media: { type: "upload", mediaId: before.mediaId } }, moment: null, title: draftTitle("phonebefore", facts, locale), format: "story" });
    }
    // After: the full-time post on a photo taken after the whistle.
    const after = photo("after");
    if (after && isFinished(s, input.now) && s.ownScore !== null && s.opponentScore !== null) {
      add({ kind: "phoneafter", originKey: originKey.phoneafter(s.id), templateKey: TEMPLATE_FOR.phoneafter, sessionId: s.id,
        data: { ...shown, media: { type: "upload", mediaId: after.mediaId } }, moment: null, title: draftTitle("phoneafter", facts, locale) });
    }
    // During: each confirmed goal a phone also filmed, as two angles in step.
    if (goalsAreOurs(facts)) {
      for (const g of facts.goals.slice(0, FOR_YOU.goalsPerMatch)) {
        const v = files.find((f) => f.phase === "during" && f.kind === "video" && f.offsetSec !== null && f.durationSec
          && f.recordingId === g.recordingId && g.atMs >= f.offsetSec * 1000 && g.atMs <= (f.offsetSec + f.durationSec) * 1000);
        if (!v || v.offsetSec === null || !v.durationSec) continue;
        const phoneFrom = v.offsetSec * 1000;
        const from = Math.max(g.fromMs, phoneFrom);
        const to = Math.min(g.toMs, phoneFrom + v.durationSec * 1000);
        if (to - from < 4000) continue;
        add({
          kind: "goalduo", originKey: originKey.goalduo(g.id), templateKey: TEMPLATE_FOR.goalduo, sessionId: s.id, moment: null,
          data: {
            ...shown,
            media: { type: "recording", recordingId: g.recordingId, fromMs: from, toMs: to },
            more: [{ type: "upload", mediaId: v.mediaId }],
            custom: { headline: locale === "ar" ? "الجول من الكاميرا ومن التلفون" : "From the camera and from the stands" },
          },
          layerPatch: { phone: { trimInMs: Math.round(from - phoneFrom), trimOutMs: Math.round(to - phoneFrom) } },
          title: draftTitle("goalduo", facts, locale),
        });
      }
    }
  }

  if (featured) {
    for (const facts of input.sessions) {
      if (facts.session.type !== "match" || !isFinished(facts.session, input.now) || facts.session.startsAt.getTime() < now - FOR_YOU.pastDays * DAY) continue;
      const base = buildSessionData(consentedFacts(facts, featured), locale);
      delete base.player;
      const best = rankedMoments(facts)[0] ?? null;
      for (const plan of matchFeaturedPlans(facts, base, featured, input.now, locale)) addFeatured(plan, facts, best);
    }
    if (input.week) {
      const academy = input.academyData ?? input.sessions[0]?.academy ?? input.week.training?.academy;
      for (const plan of weekFeaturedPlans({ isoWeek: input.week.isoWeek, featured, weekSessions: input.weekSessions ?? [], academy, now: input.now, locale })) {
        addFeatured(plan, null, null);
      }
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

/**
 * The most used house style among the academy's projects, else the default.
 * Pack styles never come from here (styleFor gives an academy its own pack).
 */
export function preferredStyle(counts: Array<{ style: string | null; count: number }>): CreativeStyle {
  const order: readonly string[] = PUBLIC_STYLES;
  const valid = counts.filter((c): c is { style: CreativeStyle; count: number } =>
    c.style !== null && order.includes(c.style) && c.count > 0);
  valid.sort((a, b) => b.count - a.count || order.indexOf(a.style) - order.indexOf(b.style));
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
    const format = plan.format && meta.formats.includes(plan.format) ? plan.format : meta.formats[0] ?? "post";
    const parsed = sceneSchema.safeParse(catalogue.build(meta.key, style, format, locale));
    if (!parsed.success) {
      logger.warn({ template: meta.key, style, issues: parsed.error.issues.slice(0, 3) }, "Creative template built an invalid scene");
      return null;
    }
    scene = parsed.data;
  } catch (error) {
    logger.warn({ template: meta.key, style, error: (error as Error).message }, "Creative template failed to build");
    return null;
  }
  if (plan.layerPatch) {
    scene = { ...scene, layers: scene.layers.map((l) => (plan.layerPatch![l.id] && l.kind === "video" ? { ...l, ...plan.layerPatch![l.id] } : l)) } as Scene;
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

/** The academy's brand pack style if it has one, else its most used house style. */
export async function styleFor(academy: Pick<Academy, "id" | "creativePack">): Promise<CreativeStyle> {
  const pack = academyPack(academy);
  if (pack) return pack.key;
  const academyId = academy.id;
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
    styleFor(academy),
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
  // Squads only for tomorrow's fixtures (the call-up draft's day).
  const callupIds = sessions.filter((f) => ammanDaysUntil(f.session.startsAt, now) === 1).map((f) => f.session.id);
  const callups = await loadCallups(academyId, callupIds);
  const isoWeek = isoWeekKey(now);
  let training: SessionFacts | null = null;
  for (const row of trainingRows) {
    const facts = await loadSessionFacts(academyId, row.id, profile);
    // This ISO week's (Amman) latest filmed training, finished.
    if (facts?.recording && isoWeekKey(facts.session.startsAt) === isoWeek && isFinished(facts.session, now)) { training = facts; break; }
  }
  const locale = FOR_YOU.locale;
  // Every child appears: consent, rotation and the "every child" drafts. A failure here only drops those.
  const featured = await loadFeaturedFacts(academyId, profile.showNames).catch((error) => {
    logger.warn({ academyId, error: (error as Error).message }, "Creative hub: featured facts unavailable");
    return undefined;
  });
  const weekSessions = [...sessions, ...(training ? [training] : [])]
    .filter((f) => f.recording && isFinished(f.session, now) && isoWeekKey(f.session.startsAt) === isoWeek);
  const phone = await loadPhoneFacts(academyId, sessions.map((f) => f.session.id)).catch(() => new Map<number, PhoneFact[]>());
  const plans = planAutoDrafts({
    now,
    phone,
    sessions,
    week: { isoWeek, training },
    existing: new Set(existingRows.map((r) => r.key).filter((k): k is string => Boolean(k))),
    locale,
    callups,
    featured,
    weekSessions,
    academyData: profile.academy,
  });
  const made = plans.map((p) => materializeDraft(p, academyId, style)).filter((r): r is DraftRow => r !== null);
  if (!made.length) return 0;
  // Video drafts get their template's recommended soundtrack, as a manager's own would.
  const music = made.some((r) => r.kind === "video") ? await replayLibraryForDrafts() : { library: [], overrides: new Map() };
  const rows = await Promise.all(made.map(async (r) => (r.kind === "video"
    ? { ...r, scene: await sceneWithDefaultMusic(r.scene as Scene, r.templateKey, music.library, music.overrides) }
    : r)));
  const inserted = await db.insert(academyCreativeProjectsTable).values(rows)
    .onConflictDoNothing({
      target: [academyCreativeProjectsTable.academyId, academyCreativeProjectsTable.originKey],
      where: sql`${academyCreativeProjectsTable.originKey} is not null`,
    })
    .returning({ id: academyCreativeProjectsTable.id });
  return inserted.length;
}

/** Phone files sorted against these sessions (not the unlinked ones), oldest first. */
export async function loadPhoneFacts(academyId: number, sessionIds: number[]): Promise<Map<number, PhoneFact[]>> {
  const out = new Map<number, PhoneFact[]>();
  if (!sessionIds.length) return out;
  const rows = await db.select({
    sessionId: academyPhoneMediaTable.sessionId, mediaId: academyPhoneMediaTable.mediaId, kind: academyPhoneMediaTable.kind,
    phase: academyPhoneMediaTable.phase, offsetSec: academyPhoneMediaTable.offsetSec, recordingId: academyPhoneMediaTable.recordingId,
    playerIds: academyPhoneMediaTable.playerIds, durationSec: academyAdMediaTable.durationSec,
  }).from(academyPhoneMediaTable)
    .innerJoin(academyAdMediaTable, eq(academyAdMediaTable.id, academyPhoneMediaTable.mediaId))
    .where(and(eq(academyPhoneMediaTable.academyId, academyId), inArray(academyPhoneMediaTable.sessionId, sessionIds), eq(academyAdMediaTable.status, "ready")))
    .orderBy(academyPhoneMediaTable.createdAt);
  for (const r of rows) {
    if (r.sessionId === null || r.phase === "unlinked") continue;
    const list = out.get(r.sessionId) ?? [];
    list.push({ mediaId: r.mediaId, kind: r.kind === "video" ? "video" : "image", phase: r.phase as PhoneFact["phase"], offsetSec: r.offsetSec, durationSec: r.durationSec, recordingId: r.recordingId, playerIds: (r.playerIds as number[]) ?? [] });
    out.set(r.sessionId, list);
  }
  return out;
}

/** Each fixture's squad as the owner picked it (in_squad line-up rows), by session id. */
export async function loadCallups(academyId: number, sessionIds: number[]): Promise<Map<number, CallupPlayer[]>> {
  const out = new Map<number, CallupPlayer[]>();
  if (!sessionIds.length) return out;
  const rows = await db.select({
    sessionId: academyMatchLineupsTable.sessionId,
    playerId: academyMatchLineupsTable.playerId,
    shirt: academyMatchLineupsTable.shirtNumber,
    jersey: academyPlayersTable.jerseyNumber,
    name: academyPlayersTable.name,
    position: academyPlayersTable.position,
  }).from(academyMatchLineupsTable)
    .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyMatchLineupsTable.playerId))
    .where(and(
      inArray(academyMatchLineupsTable.sessionId, sessionIds),
      eq(academyMatchLineupsTable.inSquad, true),
      eq(academyPlayersTable.academyId, academyId),
    ));
  for (const r of rows) {
    const list = out.get(r.sessionId) ?? [];
    list.push({ name: r.name, number: r.shirt ?? r.jersey ?? null, position: r.position ?? null, playerId: r.playerId });
    out.set(r.sessionId, list);
  }
  return out;
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
  if (isFixtureKind(parsed.kind)) return session ? session.startsAt.getTime() > now.getTime() : false;
  if ("week" in parsed) return parsed.week === isoWeekKey(now);
  return now.getTime() - createdAt.getTime() <= FOR_YOU.feedDays * DAY;
}

import type { CreativeData } from "@workspace/api-zod";
import type { AcademyPlayerStats } from "../academyMatchStats";
import {
  buildSessionData,
  POTM_MIN_MINUTES,
  POTM_MIN_PLAYERS,
  playerSource,
  rankedMoments,
  windowSource,
  type CreativeLocale,
  type PictureFact,
  type SessionFacts,
  type SessionPlayerFacts,
} from "../creative/sessionData";
import { noteWords, ownBaselineNote, rotationOrder, type BaselineNote, type StatLine } from "./rules";

/**
 * "Every child appears" in the creative hub's automatic drafts (pure).
 *
 * What the academy knows about its children that drafts need: who may be in a
 * public post (consent), when each last had a solo public post (rotation), his
 * picture, his earlier matches and his attendance streak. With these:
 *
 *   - "player of the match" goes to whoever has waited longest among the
 *     children who played; performance only breaks ties (rotationOrder);
 *   - a child without consent is never named, numbered or pictured in a draft
 *     (the scorer line, the call-up and the line-up leave him out);
 *   - five drafts that don't depend on talent: most improved (against his own
 *     earlier matches), first goal, meet the player, attendance streak, and the
 *     moment of the week.
 */

export type FeaturedPlayer = {
  playerId: number;
  name: string;
  number: number | null;
  position: string | null;
  squad: string | null;
  picture: PictureFact | null;
};

export type FeaturedFacts = {
  consent: ReadonlySet<number>;
  lastSolo: ReadonlyMap<number, Date | null>;
  showNames: boolean;
  /** Active players. */
  roster: FeaturedPlayer[];
  /** Every analysed match's numbers per child (any time), for "his own earlier matches". */
  history: Array<{ playerId: number; sessionId: number; startsAt: Date; stats: StatLine }>;
  /** Sessions in a row each child attended (present or late), counted back from the latest marked one. */
  streaks: ReadonlyMap<number, number>;
};

/** A streak worth a post: at least this many sessions in a row. */
export const STREAK_MIN = 8;
/** First-goal posts per match, at most. */
const FIRST_GOALS_PER_MATCH = 2;

const firstName = (name: string | null | undefined) => (name ? name.trim().split(/\s+/)[0] ?? null : null);

const perfKey = (p: SessionPlayerFacts) => [
  p.stats?.goals ?? 0,
  (p.stats?.passesCompleted ?? 0) + (p.stats?.dribblesWon ?? 0),
  p.stats?.touches ?? 0,
  Math.round((p.stats?.distanceKm ?? 0) * 100),
];

/** The template's `player`: his id (for the feature log), number, first name when names are shown, his picture. */
export function playerData(p: { playerId: number; name: string | null; number: number | null; position?: string | null }, featured: FeaturedFacts, squad?: string | null): NonNullable<CreativeData["player"]> & { playerId: number } {
  const known = featured.roster.find((r) => r.playerId === p.playerId);
  const pic = featured.showNames ? known?.picture ?? null : null;
  const position = p.position ?? known?.position ?? null;
  const sq = squad ?? known?.squad ?? null;
  return {
    playerId: p.playerId,
    name: featured.showNames ? firstName(p.name ?? known?.name) : null,
    number: p.number ?? known?.number ?? null,
    ...(sq ? { squad: sq } : {}),
    ...(position ? { position } : {}),
    ...(pic ? { photo: playerSource(p.playerId, pic) } : {}),
  };
}

/** Player of the match by rotation: among those who played enough, the consented child who has waited longest. */
export function rotatedPlayerOfMatch(players: SessionPlayerFacts[], featured: FeaturedFacts, now: Date): SessionPlayerFacts | null {
  const played = players.filter((p) => p.stats && (p.stats.minutes === null || p.stats.minutes === undefined || p.stats.minutes >= POTM_MIN_MINUTES));
  if (played.length < POTM_MIN_PLAYERS) return null;
  const candidates = played.filter((p) => featured.consent.has(p.playerId));
  return rotationOrder(candidates, featured.lastSolo, perfKey, now)[0] ?? null;
}

/** The session's facts with every child who may not be in a public post taken out of the lists a template shows. */
export function consentedFacts(facts: SessionFacts, featured: FeaturedFacts): SessionFacts {
  return {
    ...facts,
    players: facts.players.filter((p) => featured.consent.has(p.playerId)),
    squad: facts.squad?.filter((p) => featured.consent.has(p.playerId)),
  };
}

const statLine = (s: Partial<AcademyPlayerStats> | null | undefined): StatLine =>
  (s ? { goals: s.goals, dribblesWon: s.dribblesWon, passesCompleted: s.passesCompleted, touches: s.touches, distanceKm: s.distanceKm, topSpeedKmh: s.topSpeedKmh } : {});

const STAT_LABELS: Record<string, { en: string; ar: string }> = {
  goals: { en: "Goals", ar: "أهداف" },
  dribblesWon: { en: "Dribbles won", ar: "مراوغات ناجحة" },
  passesCompleted: { en: "Completed passes", ar: "تمريرات صحيحة" },
  topSpeedKmh: { en: "Top speed, km/h", ar: "أعلى سرعة كم/س" },
  distanceKm: { en: "Km run", ar: "كم ركض" },
  touches: { en: "Touches", ar: "لمسات" },
};

export type FeaturedPlan = {
  kind: "improved" | "firstgoal" | "meet" | "streak" | "weekmoment";
  originKey: string;
  templateKey: string;
  sessionId: number | null;
  data: CreativeData;
  playerId: number | null;
  momentFrom: SessionFacts | null;
  /** Shown in the title after the kind. */
  label: string | null;
};

/** Draft ideas for one finished, analysed match: most improved and first goals. */
export function matchFeaturedPlans(facts: SessionFacts, base: CreativeData, featured: FeaturedFacts, now: Date, locale: CreativeLocale): FeaturedPlan[] {
  const s = facts.session;
  const out: FeaturedPlan[] = [];
  const earlier = (playerId: number) => featured.history
    .filter((h) => h.playerId === playerId && h.sessionId !== s.id && h.startsAt < s.startsAt)
    .map((h) => h.stats);
  const label = (p: SessionPlayerFacts) => (featured.showNames ? firstName(p.name) : null) ?? (p.number !== null ? `#${p.number}` : null);
  const { player: _player, stats: _stats, ...matchOnly } = base;

  // Most improved: the child whose numbers beat HIS OWN usual the most, by rotation.
  const improved = facts.players
    .filter((p) => featured.consent.has(p.playerId))
    .map((p) => ({ playerId: p.playerId, p, note: ownBaselineNote(statLine(p.stats), earlier(p.playerId)) }))
    .filter((c): c is { playerId: number; p: SessionPlayerFacts; note: Extract<BaselineNote, { kind: "above" | "best" }> } => c.note !== null && c.note.kind !== "first");
  const ratio = (n: Extract<BaselineNote, { kind: "above" | "best" }>) => (n.kind === "best" ? 2 : 1) * 1000 + (n.kind === "above" && n.usual > 0 ? Math.round((n.value / n.usual) * 100) : 0);
  const pick = rotationOrder(improved, featured.lastSolo, (c) => [ratio(c.note)], now)[0];
  if (pick) {
    const lbl = STAT_LABELS[pick.note.stat] ?? { en: pick.note.stat, ar: pick.note.stat };
    out.push({
      kind: "improved", originKey: `improved:session:${s.id}`, templateKey: "improved", sessionId: s.id, playerId: pick.playerId, momentFrom: facts,
      label: label(pick.p),
      data: {
        ...matchOnly,
        player: playerData(pick.p, featured, s.squad),
        stats: { value: pick.note.value, label: lbl[locale] },
        custom: { since: noteWords(pick.note, locale).replace(/^ — /, "") },
      },
    });
  }

  // First goal: a child's first goal in any analysed match.
  const firsts = facts.players
    .filter((p) => featured.consent.has(p.playerId) && (p.stats?.goals ?? 0) > 0)
    .filter((p) => earlier(p.playerId).every((e) => !e.goals))
    .sort((a, b) => a.playerId - b.playerId)
    .slice(0, FIRST_GOALS_PER_MATCH);
  for (const p of firsts) {
    out.push({
      kind: "firstgoal", originKey: `firstgoal:player:${p.playerId}`, templateKey: "firstgoal", sessionId: s.id, playerId: p.playerId, momentFrom: facts,
      label: label(p),
      data: { ...matchOnly, player: playerData(p, featured, s.squad) },
    });
  }
  return out;
}

/** The week's drafts: meet the player, an attendance streak, the moment of the week. */
export function weekFeaturedPlans(input: {
  isoWeek: string;
  featured: FeaturedFacts;
  /** This week's finished sessions (matches and trainings) with footage. */
  weekSessions: SessionFacts[];
  academy: CreativeData["academy"];
  now: Date;
  locale: CreativeLocale;
}): FeaturedPlan[] {
  const { featured, now, locale } = input;
  const out: FeaturedPlan[] = [];
  const consented = featured.roster.filter((p) => featured.consent.has(p.playerId));
  const label = (p: FeaturedPlayer) => (featured.showNames ? firstName(p.name) : null) ?? (p.number !== null ? `#${p.number}` : null);

  const meet = rotationOrder(consented, featured.lastSolo, (p) => [p.picture ? 1 : 0], now)[0];
  if (meet) {
    out.push({
      kind: "meet", originKey: `meet:${input.isoWeek}`, templateKey: "meetplayer", sessionId: null, playerId: meet.playerId, momentFrom: null, label: label(meet),
      data: { academy: input.academy, player: playerData(meet, featured), custom: { fact: "" } },
    });
  }

  const streakers = consented.filter((p) => (featured.streaks.get(p.playerId) ?? 0) >= STREAK_MIN);
  const streak = rotationOrder(streakers, featured.lastSolo, (p) => [featured.streaks.get(p.playerId) ?? 0], now)[0];
  if (streak) {
    out.push({
      kind: "streak", originKey: `streak:${input.isoWeek}`, templateKey: "streak", sessionId: null, playerId: streak.playerId, momentFrom: null, label: label(streak),
      data: { academy: input.academy, player: playerData(streak, featured), custom: { streak: String(featured.streaks.get(streak.playerId)) } },
    });
  }

  // The week's best footage: the most-voted goal, else the best-scored saved clip, of any filmed session.
  const best = input.weekSessions
    .flatMap((f) => rankedMoments(f).slice(0, 1).map((m) => ({ f, m })))
    .sort((a, b) => b.m.weight - a.m.weight || b.m.atMs - a.m.atMs)[0];
  if (best) {
    out.push({
      kind: "weekmoment", originKey: `weekmoment:${input.isoWeek}`, templateKey: "weekmoment", sessionId: best.f.session.id, playerId: null, momentFrom: best.f, label: null,
      data: {
        academy: input.academy,
        match: buildSessionData(consentedFacts(best.f, featured), locale).match,
        media: windowSource(best.m),
        custom: { headline: locale === "ar" ? "أحلى لقطة من هالأسبوع" : "The best of this week" },
      },
    });
  }
  return out;
}

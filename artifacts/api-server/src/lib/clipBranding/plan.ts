import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  db,
  academiesTable,
  academyPlayersTable,
  academySquadsTable,
  brandingProfilesTable,
  fieldsTable,
  footageRequestsTable,
  matchPlayersTable,
  matchPlayerStatsCacheTable,
  matchRoomsTable,
  motmVotesTable,
  usersTable,
  type BrandingProfileRow,
  type MatchPlayerStatsCacheValue,
} from "@workspace/db";
import { loadImage } from "@napi-rs/canvas";
import { logger } from "../logger";
import { getSettingValue, type SettingsContext } from "../settings";
import { loadCommerce } from "../commerce";
import { statsAccess } from "../statsAccess";
import { ammanLocalInstant, loadRoomByCode, loadRoomByRequestId, type RoomContext } from "../matchRooms";
import { cachedCompetitionSummariesForUser } from "../matchStatsCache";
import { historyBeforeMatch, personalBestMetrics, type PlayerMetricValues } from "../matchStatsRules";
import { shareCardPath } from "../shareCard";
import { fetchBrandingAsset } from "../brandingFetch";
import { brandingAssetDir, ensureBrandingFonts, loadLocalImage, replayMarkPath } from "./assets";
import { renderOverlayPng } from "./overlay";
import { getOutputDims } from "../ffmpegExport";
import type { EndScreenJob } from "./endScreenVideo";
import {
  END_SCREEN_KINDS,
  END_SCREEN_STATS,
  END_SCREEN_STAT_KEYS,
  MAX_CARD_STATS,
  OVERLAY_STYLES,
  type BrandLook,
  type Dims,
  type EndScreen,
  type EndScreenChoice,
  type EndScreenKind,
  type EndScreenStatKey,
  type OverlayStyle,
  type StatLine,
} from "./types";

/**
 * Everything the export needs to know about drawn branding for one clip:
 * which overlay, which end screen, and the data on it.
 *
 * Every lookup here is best-effort. A missing table, an unreachable crest or an
 * unanalysed match degrades to less branding, never to a failed clip — the
 * same rule withBookends and brandingFetch follow.
 */

export type BrandingClip = {
  id: number;
  userId: number;
  academyId: number | null;
  matchCode: string | null;
  footageRequestId: number | null;
  /** The player's choice of card and numbers (user_clips.end_screen), if any. */
  endScreen?: unknown;
};

export type ClipBrandingPlan = {
  /** A local PNG to use instead of the uploaded overlay. */
  overlayPath: string | null;
  endScreen: EndScreenJob | null;
  /** Local temp files the caller deletes when the export is done. */
  temps: string[];
};

export const AWARD_AR: Record<string, string> = {
  distance: "متصدّر المسافة",
  speed: "متصدّر السرعة",
  touches: "ملك اللمسات",
  passes: "ملك التمرير",
  dribbles: "الساحر",
  goals: "الهدّاف",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** "2026-10-24 22:00" (Amman local) → "SAT 24 OCT · 22:00". */
export function dateLabelFromLocal(startLocal: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(startLocal ?? "");
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  // The weekday of a calendar date does not depend on the time zone.
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  return `${DAYS[day]} ${Number(d)} ${MONTHS[Number(mo) - 1]} · ${hh}:${mm}`;
}

export function publicBase(): string {
  const raw = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || "https://replayjo.com";
  return raw.replace(/\/+$/, "");
}

/**
 * A crest stored as "preset:<file>" is one of the bundled venue crests
 * (assets/branding/presets). Applying a preset therefore works on a deployment
 * without object storage, and the crest can never go missing from a CDN.
 */
export function presetFileFromUrl(url: string | null | undefined): string | null {
  const m = /^preset:([a-z0-9-]+\.png)$/.exec(url ?? "");
  if (!m) return null;
  const file = path.join(brandingAssetDir(), "presets", m[1]);
  return fs.existsSync(file) ? file : null;
}

function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === "42P01" || /relation .* does not exist/i.test(String((err as Error)?.message ?? ""));
}

/** Academy, then field, then global — the order every other piece of branding uses. */
export async function loadBrandingProfile(scope: {
  academyId?: number | null;
  fieldId?: number | null;
}): Promise<BrandingProfileRow | null> {
  try {
    const rows = await db.select().from(brandingProfilesTable);
    const find = (type: string, id: number | null | undefined) =>
      id ? rows.find((r) => r.scopeType === type && r.scopeId === id) : undefined;
    return find("academy", scope.academyId) ?? find("field", scope.fieldId)
      ?? rows.find((r) => r.scopeType === "global") ?? null;
  } catch (err) {
    if (!isMissingTable(err)) logger.warn({ err }, "Could not read branding profiles");
    return null;
  }
}

/**
 * The look for a scope. Without a profile, the academy's or field's own name
 * (and an academy's logo) in Turf — enough that turning the end screen on for a
 * venue nobody has set up yet still produces something with its name on.
 */
export async function lookFor(
  scope: { academyId: number | null; fieldId: number | null },
  temps: string[],
): Promise<BrandLook | null> {
  const profile = await loadBrandingProfile(scope);
  let crestUrl = profile?.crestUrl ?? null;
  let nameEn = profile?.nameEn ?? "";
  const isAcademy = profile ? profile.scopeType === "academy" : !!scope.academyId;
  if (!profile || !nameEn) {
    try {
      if (scope.academyId) {
        const [a] = await db.select({ name: academiesTable.name, logoUrl: academiesTable.logoUrl })
          .from(academiesTable).where(eq(academiesTable.id, scope.academyId));
        if (a) {
          nameEn ||= a.name;
          if (!crestUrl && a.logoUrl && /^https?:\/\//i.test(a.logoUrl)) crestUrl = a.logoUrl;
        }
      }
      if (!nameEn && scope.fieldId) {
        const [f] = await db.select({ name: fieldsTable.name }).from(fieldsTable).where(eq(fieldsTable.id, scope.fieldId));
        if (f) nameEn = f.name;
      }
    } catch (err) {
      logger.warn({ err }, "Could not read the venue name for branding");
    }
  }
  if (!nameEn) return null;

  let crest = null;
  const presetFile = presetFileFromUrl(crestUrl);
  if (presetFile) {
    crest = await loadLocalImage(presetFile);
  } else if (crestUrl) {
    const local = await fetchBrandingAsset(crestUrl, "crest", {
      referer: (() => { try { return `https://${new URL(crestUrl!).host}/`; } catch { return undefined; } })(),
    });
    if (local) {
      if (local !== crestUrl) temps.push(local);
      crest = await loadImage(local).catch((err: unknown) => {
        logger.warn({ err }, "Branding crest is not a readable image — drawing initials instead");
        return null;
      });
    }
  }
  return {
    nameEn,
    nameAr: profile?.nameAr ?? null,
    taglineAr: profile?.taglineAr ?? null,
    primaryColor: profile?.primaryColor ?? "#2FD8C4",
    accentColor: profile?.accentColor ?? null,
    bookingPhone: profile?.bookingPhone ?? null,
    instagram: profile?.instagram ?? null,
    crest,
    isAcademy,
  };
}

async function roomForClip(clip: BrandingClip): Promise<RoomContext | null> {
  try {
    if (clip.matchCode) {
      const ctx = await loadRoomByCode(clip.matchCode);
      if (ctx) return ctx;
    }
    if (clip.footageRequestId) return await loadRoomByRequestId(clip.footageRequestId);
  } catch (err) {
    logger.warn({ err, clipId: clip.id }, "Could not resolve the clip's match for its end screen");
  }
  return null;
}

type StatsHistory = { startLocal: string; stats: MatchPlayerStatsCacheValue }[];

async function userHistory(userId: number, excludeMatchId: number): Promise<StatsHistory> {
  return db.select({ startLocal: footageRequestsTable.startLocal, stats: matchPlayerStatsCacheTable.stats })
    .from(matchPlayerStatsCacheTable)
    .innerJoin(matchRoomsTable, eq(matchRoomsTable.id, matchPlayerStatsCacheTable.matchId))
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .where(and(eq(matchPlayerStatsCacheTable.userId, userId), ne(matchPlayerStatsCacheTable.matchId, excludeMatchId)));
}

/**
 * The numbers on a card. Without a choice: up to four, in the order a player
 * cares about — goals if he scored, shots on target, then speed, distance,
 * passes, dribbles — leaving out zeros and anything not measured. With a
 * choice: exactly the numbers he picked, in his order, zeros included (he
 * asked for them), only leaving out what was not measured. Personal bests are
 * only claimed against at least three earlier matches, as the match report does.
 */
export function statLines(
  stats: PlayerMetricValues,
  earlier: PlayerMetricValues[],
  opts: { deltas?: boolean; pick?: EndScreenStatKey[] | null; max?: number } = {},
): StatLine[] {
  const bests = earlier.length >= 3 ? new Set<string>(personalBestMetrics(stats, earlier)) : new Set<string>();
  const lastFive = earlier.slice(0, 5);
  const avg = (key: keyof PlayerMetricValues) => {
    const values = lastFive.map((row) => row[key]).filter((v): v is number => typeof v === "number");
    return values.length >= 2 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const max = Math.max(1, Math.min(MAX_CARD_STATS, opts.max ?? MAX_CARD_STATS));
  const picked = opts.pick?.length
    ? opts.pick.map((key) => END_SCREEN_STATS.find((c) => c.key === key)).filter((c): c is (typeof END_SCREEN_STATS)[number] => !!c)
    : null;
  const lines: StatLine[] = [];
  for (const c of picked ?? END_SCREEN_STATS) {
    const value = stats[c.metric as keyof PlayerMetricValues];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (!picked && value <= 0) continue;
    let delta: StatLine["delta"] = null;
    if (opts.deltas) {
      const base = avg(c.metric as keyof PlayerMetricValues);
      if (base !== null && base > 0) {
        const diff = value - base;
        if (Math.abs(diff) > (c.decimals ? 0.05 : 0.5)) {
          delta = c.pct
            ? { text: `${Math.round(Math.abs(diff) / base * 100)}%`, up: diff > 0 }
            : { text: Math.abs(diff).toFixed(c.decimals), up: diff > 0 };
        }
      }
    }
    lines.push({
      value,
      decimals: c.decimals,
      unit: c.unit,
      labelAr: c.labelAr,
      best: bests.has(c.metric),
      delta,
    });
    if (lines.length === max) break;
  }
  return lines;
}

/** The kinds this clip could get, in priority order, given the switches. */
export type EndScreenSwitches = { player: boolean; match: boolean; academy: boolean; signOff: boolean };

/** The automatic order: the most personal card that has data wins. */
const AUTO_ORDER: EndScreenKind[] = ["academy", "player", "match", "signOff"];

/**
 * Everything the four cards are built from, loaded once per clip. Each
 * builder returns its card or null when it has nothing to show, so the
 * automatic choice, the player's choice and the options screen all use the
 * same code.
 */
type CardSources = {
  common: { look: BrandLook; dateLabel: string | null; link: string };
  namesAllowed: boolean;
  mine: { stats: MatchPlayerStatsCacheValue; matchPlayerId: number } | null;
  earlier: () => Promise<PlayerMetricValues[]>;
};

async function cardSources(
  clip: BrandingClip,
  look: BrandLook,
  room: RoomContext | null,
  fieldId: number | null,
  link: string,
  wantStats: boolean,
): Promise<CardSources> {
  const dateLabel = dateLabelFromLocal(room?.request.startLocal);
  const common = { look, dateLabel, link };

  // On an academy clip, names appear only when the academy's own profile says
  // so: most of its players are children. One rule for every card, so a
  // switched-off academy card cannot fall through to a card that prints names.
  let namesAllowed = true;
  if (clip.academyId) {
    const profile = await loadBrandingProfile({ academyId: clip.academyId, fieldId });
    namesAllowed = profile?.scopeType === "academy" && profile.scopeId === clip.academyId ? profile.showPlayerNames : false;
  }

  // Stats are only ever the clip owner's own, and only when he can see them.
  let mine: CardSources["mine"] = null;
  if (room && wantStats) {
    try {
      const commerce = await loadCommerce({ userId: clip.userId, fieldId: room.room.fieldId });
      if (commerce.statsEnabled && (await statsAccess(clip.userId, room.room.id, commerce)).unlocked) {
        const [row] = await db.select({ stats: matchPlayerStatsCacheTable.stats, matchPlayerId: matchPlayerStatsCacheTable.matchPlayerId })
          .from(matchPlayerStatsCacheTable)
          .where(and(eq(matchPlayerStatsCacheTable.matchId, room.room.id), eq(matchPlayerStatsCacheTable.userId, clip.userId)));
        if (row) mine = row;
      }
    } catch (err) {
      logger.warn({ err, clipId: clip.id }, "Could not load the player's stats for the end screen");
    }
  }
  let earlierCache: Promise<PlayerMetricValues[]> | null = null;
  const earlier = () => {
    earlierCache ??= (async () => {
      if (!room) return [] as PlayerMetricValues[];
      const history = await userHistory(clip.userId, room.room.id).catch(() => [] as StatsHistory);
      return historyBeforeMatch(
        history.map((h) => ({ matchId: 0, code: "", startLocal: h.startLocal, stats: h.stats })),
        room.request.startLocal,
      ).sort((a, b) => (a.startLocal < b.startLocal ? 1 : -1)).map((h) => h.stats);
    })();
    return earlierCache;
  };
  return { common, namesAllowed, mine, earlier };
}

async function academyCard(
  clip: BrandingClip,
  src: CardSources,
  pick: EndScreenStatKey[] | null,
): Promise<EndScreen | null> {
  if (!clip.academyId) return null;
  try {
    const [player] = await db.select({
      name: academyPlayersTable.name,
      jerseyNumber: academyPlayersTable.jerseyNumber,
      squadName: academySquadsTable.name,
      ageGroup: academySquadsTable.ageGroup,
    }).from(academyPlayersTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
      .where(and(
        eq(academyPlayersTable.academyId, clip.academyId),
        eq(academyPlayersTable.userId, clip.userId),
        eq(academyPlayersTable.isActive, true),
      ))
      .limit(1);
    if (!player) return null;
    const showNames = src.namesAllowed;
    const number = player.jerseyNumber != null && String(player.jerseyNumber).trim() !== "" ? `#${player.jerseyNumber}` : null;
    const firstName = player.name?.trim().split(/\s+/)[0] ?? "";
    const big = number ?? (showNames && firstName ? firstName.toUpperCase() : "PLAYER");
    // Only the first name under the number, and only when the academy allows names (no minutes line).
    const sub = showNames && number ? firstName : null;
    return {
      ...src.common,
      kind: "academy",
      player: { big, sub },
      ageGroup: player.ageGroup ?? player.squadName ?? null,
      stats: src.mine ? statLines(src.mine.stats, await src.earlier(), { deltas: true, pick, max: 3 }) : [],
    };
  } catch (err) {
    logger.warn({ err, clipId: clip.id }, "Could not load the academy player for the end screen");
    return null;
  }
}

async function playerCard(
  clip: BrandingClip,
  room: RoomContext | null,
  src: CardSources,
  pick: EndScreenStatKey[] | null,
): Promise<EndScreen | null> {
  if (!room || !src.mine) return null;
  const lines = statLines(src.mine.stats, await src.earlier(), { pick });
  if (!lines.length) return null;
  const [me] = await db.select({ displayName: matchPlayersTable.displayName, shirtNumber: matchPlayersTable.shirtNumber })
    .from(matchPlayersTable).where(eq(matchPlayersTable.id, src.mine.matchPlayerId));
  const [user] = await db.select({ name: usersTable.name, shirtNumber: usersTable.shirtNumber })
    .from(usersTable).where(eq(usersTable.id, clip.userId));
  const name = src.namesAllowed ? (me?.displayName || user?.name || "").trim().split(/\s+/)[0] ?? "" : "";
  const shirt = me?.shirtNumber ?? user?.shirtNumber ?? null;
  const number = shirt != null && String(shirt).trim() !== "" ? `#${shirt}` : null;
  let awardAr: string | null = null;
  try {
    const ids = await db.select({ id: matchPlayerStatsCacheTable.matchPlayerId })
      .from(matchPlayerStatsCacheTable).where(eq(matchPlayerStatsCacheTable.matchId, room.room.id));
    const summary = (await cachedCompetitionSummariesForUser(
      clip.userId, new Map([[room.room.id, ids.map((r) => r.id)]]),
    )).get(room.room.id);
    // Touches are no longer on the card, so neither is the touches award.
    const key = summary?.awardKeys.find((k) => k !== "touches" && AWARD_AR[k]);
    awardAr = key ? AWARD_AR[key] ?? null : null;
  } catch (err) {
    logger.warn({ err, clipId: clip.id }, "Could not work out awards for the end screen");
  }
  return {
    ...src.common,
    kind: "player",
    player: { big: number ?? (name ? name.toUpperCase() : "PLAYER"), sub: number && name ? name : null, awardAr },
    stats: lines,
  };
}

async function matchCard(room: RoomContext | null, src: CardSources): Promise<EndScreen | null> {
  if (!room || room.room.teamCount >= 3 || room.room.scoreA == null || room.room.scoreB == null) return null;
  const r = room.room;
  let aGoals: number[] | null = null;
  let bGoals: number[] | null = null;
  try {
    const rows = await db.select({ stats: matchPlayerStatsCacheTable.stats })
      .from(matchPlayerStatsCacheTable).where(eq(matchPlayerStatsCacheTable.matchId, r.id));
    const bySide = { A: [] as number[], B: [] as number[] };
    for (const row of rows) {
      const team = row.stats.extras?.team;
      if (team !== "A" && team !== "B") continue;
      for (const t of row.stats.extras?.goalTimes ?? []) bySide[team].push(Math.floor(t / 60) + 1);
    }
    // Only when every goal on that side is accounted for: a partial list of
    // minutes under a final score reads as a mistake.
    if (bySide.A.length === r.scoreA) aGoals = bySide.A.sort((x, y) => x - y);
    if (bySide.B.length === r.scoreB) bGoals = bySide.B.sort((x, y) => x - y);
  } catch { /* minutes are optional */ }
  let motm: string | null = null;
  try {
    const end = ammanLocalInstant(room.request.endLocal);
    if (Number.isFinite(end) && Date.now() > end + 24 * 60 * 60 * 1000) {
      const votes = await db.select({ id: motmVotesTable.candidatePlayerId }).from(motmVotesTable)
        .where(eq(motmVotesTable.matchId, r.id));
      const tally = new Map<number, number>();
      for (const v of votes) tally.set(v.id, (tally.get(v.id) ?? 0) + 1);
      const max = Math.max(0, ...tally.values());
      const winners = [...tally.entries()].filter(([, n]) => n === max && max > 0).map(([id]) => id);
      if (winners.length === 1) {
        const [p] = await db.select({ displayName: matchPlayersTable.displayName, shirtNumber: matchPlayersTable.shirtNumber })
          .from(matchPlayersTable).where(inArray(matchPlayersTable.id, winners));
        if (p) {
          const first = p.displayName.split(/\s+/)[0];
          // Without names allowed, only a shirt number — or nothing.
          motm = src.namesAllowed
            ? (p.shirtNumber ? `#${p.shirtNumber} ${first}` : first)
            : (p.shirtNumber ? `#${p.shirtNumber}` : null);
        }
      }
    }
  } catch { /* MOTM is optional */ }
  return {
    ...src.common,
    kind: "match",
    score: {
      a: r.scoreA!,
      b: r.scoreB!,
      aName: r.teamAName || "Team A",
      bName: r.teamBName || "Team B",
      aColor: r.teamAColor,
      bColor: r.teamBColor,
      aGoals,
      bGoals,
    },
    motm,
  };
}

function buildCard(
  kind: EndScreenKind,
  clip: BrandingClip,
  room: RoomContext | null,
  src: CardSources,
  pick: EndScreenStatKey[] | null,
): Promise<EndScreen | null> {
  switch (kind) {
    case "academy": return academyCard(clip, src, pick);
    case "player": return playerCard(clip, room, src, pick);
    case "match": return matchCard(room, src);
    default: return Promise.resolve({ ...src.common, kind: "signOff" });
  }
}

/** A stored choice, cleaned: unknown kinds and stat keys are dropped. */
export function cleanChoice(raw: unknown): EndScreenChoice {
  const out: EndScreenChoice = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.card === "auto" || (END_SCREEN_KINDS as readonly unknown[]).includes(r.card)) out.card = r.card as EndScreenChoice["card"];
  if (Array.isArray(r.stats)) {
    const keys = [...new Set(r.stats.filter((k): k is EndScreenStatKey => (END_SCREEN_STAT_KEYS as unknown[]).includes(k)))];
    out.stats = keys.slice(0, MAX_CARD_STATS);
  }
  return out;
}

async function buildEndScreen(
  clip: BrandingClip,
  look: BrandLook,
  room: RoomContext | null,
  switches: EndScreenSwitches,
  fieldId: number | null,
  link: string,
): Promise<EndScreen | null> {
  const choice = cleanChoice(clip.endScreen);
  const pick = choice.stats?.length ? choice.stats : null;
  // The player's card first, if the venue allows it; then the automatic order.
  const order = [
    ...(choice.card && choice.card !== "auto" && switches[choice.card] ? [choice.card] : []),
    ...AUTO_ORDER.filter((k) => switches[k] && k !== choice.card),
  ];
  if (!order.length) return null;
  const src = await cardSources(clip, look, room, fieldId, link, order.includes("player") || order.includes("academy"));
  for (const kind of order) {
    const card = await buildCard(kind, clip, room, src, pick);
    if (card) return card;
  }
  return null;
}

/**
 * What the player can choose between on one clip: the cards the venue has
 * switched on, whether each has something to show, and his numbers. Never
 * throws; a venue with the end screen off answers `enabled: false`.
 */
export type EndScreenOptions = {
  enabled: boolean;
  seconds: number;
  choice: EndScreenChoice;
  /** The card the export uses now, with the stored choice. */
  current: EndScreenKind | null;
  cards: Array<{ kind: EndScreenKind; available: boolean }>;
  stats: Array<{ key: EndScreenStatKey; labelEn: string; labelAr: string; value: number | null; unit: string; decimals: number }>;
};

export async function endScreenOptions(
  clip: BrandingClip,
  fieldId: number | null,
  ctx: SettingsContext,
  link?: string,
): Promise<EndScreenOptions> {
  const choice = cleanChoice(clip.endScreen);
  const off: EndScreenOptions = { enabled: false, seconds: 3, choice, current: null, cards: [], stats: [] };
  const temps: string[] = [];
  try {
    const [endOn, player, match, academy, signOff, seconds] = await Promise.all([
      getSettingValue<boolean>("branding.endScreenEnabled", ctx),
      getSettingValue<boolean>("branding.endScreen.player", ctx),
      getSettingValue<boolean>("branding.endScreen.match", ctx),
      getSettingValue<boolean>("branding.endScreen.academy", ctx),
      getSettingValue<boolean>("branding.endScreen.signOff", ctx),
      getSettingValue<number>("branding.endScreen.seconds", ctx),
    ]);
    if (!endOn) return off;
    const switches: EndScreenSwitches = { player, match, academy, signOff };
    const look = await lookFor({ academyId: clip.academyId, fieldId }, temps);
    if (!look) return off;
    const room = await roomForClip(clip);
    const src = await cardSources(clip, look, room, fieldId, link ?? `${publicBase()}${shareCardPath(clip.id)}`, true);
    const cards: EndScreenOptions["cards"] = [];
    for (const kind of AUTO_ORDER) {
      if (!switches[kind]) continue;
      cards.push({ kind, available: !!(await buildCard(kind, clip, room, src, null)) });
    }
    const current = (await buildEndScreen(clip, look, room, switches, fieldId, src.common.link))?.kind ?? null;
    const stats = END_SCREEN_STATS.map((s) => {
      const v = src.mine?.stats[s.metric as keyof PlayerMetricValues];
      return {
        key: s.key,
        labelEn: s.labelEn,
        labelAr: s.labelAr,
        value: typeof v === "number" && Number.isFinite(v) ? v : null,
        unit: s.unit,
        decimals: s.decimals,
      };
    });
    return {
      enabled: true,
      seconds: Math.min(6, Math.max(2, Number(seconds) || 3)),
      choice,
      current,
      cards,
      stats: src.mine ? stats : [],
    };
  } catch (err) {
    logger.warn({ err, clipId: clip.id }, "Could not work out the end screen options");
    return off;
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
}

/**
 * The card this clip would get, drawn for a still preview: the player's real
 * numbers and look, with `choice` in place of the stored one.
 */
export async function endScreenFor(
  clip: BrandingClip,
  fieldId: number | null,
  ctx: SettingsContext,
  temps: string[],
  link?: string,
): Promise<{ spec: EndScreen; blur: number; dim: number } | null> {
  const [endOn, player, match, academy, signOff, blur, dim] = await Promise.all([
    getSettingValue<boolean>("branding.endScreenEnabled", ctx),
    getSettingValue<boolean>("branding.endScreen.player", ctx),
    getSettingValue<boolean>("branding.endScreen.match", ctx),
    getSettingValue<boolean>("branding.endScreen.academy", ctx),
    getSettingValue<boolean>("branding.endScreen.signOff", ctx),
    getSettingValue<number>("branding.endScreen.blur", ctx),
    getSettingValue<number>("branding.endScreen.dim", ctx),
  ]);
  if (!endOn) return null;
  const look = await lookFor({ academyId: clip.academyId, fieldId }, temps);
  if (!look) return null;
  ensureBrandingFonts();
  const room = await roomForClip(clip);
  const spec = await buildEndScreen(clip, look, room, { player, match, academy, signOff }, fieldId,
    link ?? `${publicBase()}${shareCardPath(clip.id)}`);
  if (!spec) return null;
  return {
    spec,
    blur: Math.min(40, Math.max(0, Number(blur) || 0)),
    dim: Math.min(0.9, Math.max(0, (Number(dim) || 0) / 100)),
  };
}

/**
 * Whether the console has drawn branding switched on for this clip's venue.
 *
 * The vps1 renderer cannot draw it, so a clip that wants it waits for a local
 * render slot rather than overflowing there. Errors read as "no": overflow then
 * behaves exactly as it did before drawn branding existed.
 */
export async function clipWantsDrawnBranding(ctx: SettingsContext): Promise<boolean> {
  try {
    const [overlayOn, style, endOn] = await Promise.all([
      getSettingValue<boolean>("branding.overlayEnabled", ctx),
      getSettingValue<string>("branding.overlayStyle", ctx),
      getSettingValue<boolean>("branding.endScreenEnabled", ctx),
    ]);
    return endOn === true
      || (overlayOn === true && style !== "uploaded" && (OVERLAY_STYLES as readonly string[]).includes(style));
  } catch {
    return false;
  }
}

/**
 * Decide and prepare the drawn branding for one clip. Never throws.
 */
export async function planClipBranding(
  clip: BrandingClip,
  fieldId: number | null,
  portrait: boolean,
  ctx: SettingsContext,
  opts: {
    /** What the card's QR opens; the clip's own share card by default. */
    link?: string;
    /** Leave the end screen out (a reel's segments: only its end gets one). */
    noEndScreen?: boolean;
    /** Leave the overlay out. */
    noOverlay?: boolean;
  } = {},
): Promise<ClipBrandingPlan> {
  const plan: ClipBrandingPlan = { overlayPath: null, endScreen: null, temps: [] };
  try {
    // The export's own size, so the overlay is drawn at exactly the frame it covers.
    const dims: Dims = getOutputDims(portrait);
    const [overlayOn, styleRaw, endOn] = await Promise.all([
      // The existing master switch still means "no overlay at all".
      getSettingValue<boolean>("branding.overlayEnabled", ctx),
      getSettingValue<string>("branding.overlayStyle", ctx),
      getSettingValue<boolean>("branding.endScreenEnabled", ctx),
    ]);
    const style = !opts.noOverlay && overlayOn && (OVERLAY_STYLES as readonly string[]).includes(styleRaw)
      ? (styleRaw as OverlayStyle)
      : "uploaded";
    const endScreenOn = endOn && !opts.noEndScreen;
    if (style === "uploaded" && !endScreenOn) return plan;

    const scope = { academyId: clip.academyId, fieldId };
    const look = await lookFor(scope, plan.temps);
    if (!look) return plan;
    ensureBrandingFonts();
    const room = await roomForClip(clip);
    const mark = await loadLocalImage(replayMarkPath());

    if (style !== "uploaded") {
      let tag: string | null = null;
      if (style === "academyFrame" && clip.academyId) {
        const [p] = await db.select({ ageGroup: academySquadsTable.ageGroup, squadName: academySquadsTable.name })
          .from(academyPlayersTable)
          .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
          .where(and(eq(academyPlayersTable.academyId, clip.academyId), eq(academyPlayersTable.userId, clip.userId)))
          .limit(1)
          .catch(() => [] as Array<{ ageGroup: string | null; squadName: string | null }>);
        tag = p?.ageGroup ?? p?.squadName ?? null;
      }
      const png = renderOverlayPng({
        style,
        look,
        dims,
        dateLabel: dateLabelFromLocal(room?.request.startLocal),
        tag,
        mark,
      });
      const file = path.join(os.tmpdir(), `soccerwatch-overlay-${randomUUID()}.png`);
      await fs.promises.writeFile(file, png);
      plan.temps.push(file);
      plan.overlayPath = file;
    }

    if (endScreenOn) {
      const [player, match, academy, signOff, seconds, blur, dim] = await Promise.all([
        getSettingValue<boolean>("branding.endScreen.player", ctx),
        getSettingValue<boolean>("branding.endScreen.match", ctx),
        getSettingValue<boolean>("branding.endScreen.academy", ctx),
        getSettingValue<boolean>("branding.endScreen.signOff", ctx),
        getSettingValue<number>("branding.endScreen.seconds", ctx),
        getSettingValue<number>("branding.endScreen.blur", ctx),
        getSettingValue<number>("branding.endScreen.dim", ctx),
      ]);
      const link = opts.link ?? `${publicBase()}${shareCardPath(clip.id)}`;
      const spec = await buildEndScreen(clip, look, room, { player, match, academy, signOff }, fieldId, link);
      if (spec) {
        plan.endScreen = {
          spec,
          seconds: Math.min(6, Math.max(2, Number(seconds) || 3)),
          blur: Math.min(40, Math.max(0, Number(blur) || 0)),
          dim: Math.min(0.9, Math.max(0, (Number(dim) || 0) / 100)),
        };
      }
    }
  } catch (err) {
    logger.error({ err, clipId: clip.id }, "Could not plan drawn branding — exporting with uploaded branding only");
  }
  return plan;
}

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
  OVERLAY_STYLES,
  type BrandLook,
  type Dims,
  type EndScreen,
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
 * Up to four lines, in the order a player cares about: goals if he scored,
 * then speed, distance, touches, passes, dribbles. Personal bests are only
 * claimed against at least three earlier matches, as the match report does.
 */
export function statLines(
  stats: PlayerMetricValues,
  earlier: PlayerMetricValues[],
  opts: { deltas?: boolean } = {},
): StatLine[] {
  const bests = earlier.length >= 3 ? new Set(personalBestMetrics(stats, earlier)) : new Set<string>();
  const lastFive = earlier.slice(0, 5);
  const avg = (key: keyof PlayerMetricValues) => {
    const values = lastFive.map((row) => row[key]).filter((v): v is number => typeof v === "number");
    return values.length >= 2 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const candidates: Array<{ key: keyof PlayerMetricValues; decimals: number; unit: string; labelAr: string; pct: boolean }> = [
    { key: "goals", decimals: 0, unit: "", labelAr: "أهداف", pct: false },
    { key: "topSpeedKmh", decimals: 1, unit: "km/h", labelAr: "أعلى سرعة", pct: false },
    { key: "distanceKm", decimals: 1, unit: "km", labelAr: "مسافة", pct: true },
    { key: "touches", decimals: 0, unit: "", labelAr: "لمسة", pct: false },
    { key: "passesCompleted", decimals: 0, unit: "", labelAr: "تمريرة صحيحة", pct: false },
    { key: "dribblesWon", decimals: 0, unit: "", labelAr: "مراوغة ناجحة", pct: false },
  ];
  const lines: StatLine[] = [];
  for (const c of candidates) {
    const value = stats[c.key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (c.key === "goals" && value <= 0) continue;
    if (value <= 0 && c.key !== "goals") continue;
    let delta: StatLine["delta"] = null;
    if (opts.deltas) {
      const base = avg(c.key);
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
      best: bests.has(c.key as string),
      delta,
    });
    if (lines.length === 4) break;
  }
  return lines;
}

/** The kinds this clip could get, in priority order, given the switches. */
export type EndScreenSwitches = { player: boolean; match: boolean; academy: boolean; signOff: boolean };

async function buildEndScreen(
  clip: BrandingClip,
  look: BrandLook,
  room: RoomContext | null,
  switches: EndScreenSwitches,
  fieldId: number | null,
): Promise<EndScreen | null> {
  const dateLabel = dateLabelFromLocal(room?.request.startLocal);
  const link = room ? `${publicBase()}/m/${room.room.code}` : `${publicBase()}${shareCardPath(clip.id)}`;
  const common = { look, dateLabel, link };

  // Stats are only ever the clip owner's own, and only when he can see them.
  let mine: { stats: MatchPlayerStatsCacheValue; matchPlayerId: number } | null = null;
  if (room && (switches.player || switches.academy)) {
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
  const earlier = async () => {
    if (!room) return [] as PlayerMetricValues[];
    const history = await userHistory(clip.userId, room.room.id).catch(() => [] as StatsHistory);
    return historyBeforeMatch(
      history.map((h) => ({ matchId: 0, code: "", startLocal: h.startLocal, stats: h.stats })),
      room.request.startLocal,
    ).sort((a, b) => (a.startLocal < b.startLocal ? 1 : -1)).map((h) => h.stats);
  };

  if (switches.academy && clip.academyId) {
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
      if (player) {
        const profile = await loadBrandingProfile({ academyId: clip.academyId, fieldId });
        const showNames = profile?.scopeType === "academy" ? profile.showPlayerNames : false;
        const number = player.jerseyNumber != null && String(player.jerseyNumber).trim() !== "" ? `#${player.jerseyNumber}` : null;
        const firstName = player.name?.trim().split(/\s+/)[0] ?? "";
        const big = number ?? (showNames && firstName ? firstName.toUpperCase() : "PLAYER");
        const minutes = mine?.stats.minutes;
        const sub = showNames && number ? firstName : (minutes ? `${Math.round(minutes)} MIN ON CAMERA` : null);
        return {
          ...common,
          kind: "academy",
          player: { big, sub },
          ageGroup: player.ageGroup ?? player.squadName ?? null,
          stats: mine ? statLines(mine.stats, await earlier(), { deltas: true }).slice(0, 3) : [],
        };
      }
    } catch (err) {
      logger.warn({ err, clipId: clip.id }, "Could not load the academy player for the end screen");
    }
  }

  if (switches.player && room && mine) {
    const [me] = await db.select({ displayName: matchPlayersTable.displayName, shirtNumber: matchPlayersTable.shirtNumber })
      .from(matchPlayersTable).where(eq(matchPlayersTable.id, mine.matchPlayerId));
    const [user] = await db.select({ name: usersTable.name, shirtNumber: usersTable.shirtNumber })
      .from(usersTable).where(eq(usersTable.id, clip.userId));
    const name = (me?.displayName || user?.name || "").trim().split(/\s+/)[0] ?? "";
    const shirt = me?.shirtNumber ?? user?.shirtNumber ?? null;
    const number = shirt != null && String(shirt).trim() !== "" ? `#${shirt}` : null;
    let awardAr: string | null = null;
    try {
      const ids = await db.select({ id: matchPlayerStatsCacheTable.matchPlayerId })
        .from(matchPlayerStatsCacheTable).where(eq(matchPlayerStatsCacheTable.matchId, room.room.id));
      const summary = (await cachedCompetitionSummariesForUser(
        clip.userId, new Map([[room.room.id, ids.map((r) => r.id)]]),
      )).get(room.room.id);
      const key = summary?.awardKeys[0];
      awardAr = key ? AWARD_AR[key] ?? null : null;
    } catch (err) {
      logger.warn({ err, clipId: clip.id }, "Could not work out awards for the end screen");
    }
    const lines = statLines(mine.stats, await earlier());
    if (lines.length) {
      return {
        ...common,
        kind: "player",
        player: { big: number ?? (name ? name.toUpperCase() : "PLAYER"), sub: number && name ? name : null, awardAr },
        stats: lines,
      };
    }
  }

  if (switches.match && room && room.room.teamCount < 3 && room.room.scoreA != null && room.room.scoreB != null) {
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
          if (p) motm = p.shirtNumber ? `#${p.shirtNumber} ${p.displayName.split(/\s+/)[0]}` : p.displayName.split(/\s+/)[0];
        }
      }
    } catch { /* MOTM is optional */ }
    return {
      ...common,
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

  if (switches.signOff) return { ...common, kind: "signOff" };
  return null;
}

/**
 * Decide and prepare the drawn branding for one clip. Never throws.
 */
export async function planClipBranding(
  clip: BrandingClip,
  fieldId: number | null,
  portrait: boolean,
  ctx: SettingsContext,
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
    const style = overlayOn && (OVERLAY_STYLES as readonly string[]).includes(styleRaw)
      ? (styleRaw as OverlayStyle)
      : "uploaded";
    if (style === "uploaded" && !endOn) return plan;

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

    if (endOn) {
      const [player, match, academy, signOff, seconds, blur, dim] = await Promise.all([
        getSettingValue<boolean>("branding.endScreen.player", ctx),
        getSettingValue<boolean>("branding.endScreen.match", ctx),
        getSettingValue<boolean>("branding.endScreen.academy", ctx),
        getSettingValue<boolean>("branding.endScreen.signOff", ctx),
        getSettingValue<number>("branding.endScreen.seconds", ctx),
        getSettingValue<number>("branding.endScreen.blur", ctx),
        getSettingValue<number>("branding.endScreen.dim", ctx),
      ]);
      const spec = await buildEndScreen(clip, look, room, { player, match, academy, signOff }, fieldId);
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

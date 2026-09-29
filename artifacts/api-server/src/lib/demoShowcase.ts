/**
 * The public sales demo (/demo): what it shows, taken from real data only.
 *
 * Nothing here is invented. Every number comes from the database or from the
 * analysis bundle of one real match, and a part with no real data is returned
 * as null so the page can hide it rather than fill it with an example.
 *
 * People are never named. Clips carry no creator, and match players are
 * labelled by shirt number when the bundle read one, otherwise by letter.
 */
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  fieldsTable,
  recordingsTable,
  recordingTrackingBundlesTable,
  userClipsTable,
} from "@workspace/db";

import {
  getBunnyPlaybackUrl,
  getBunnyProxiedPlaybackUrl,
  getBunnyProxiedThumbnailUrl,
} from "./bunny";
import { readClaimSegment } from "./claimMatchStorage";
import { logger } from "./logger";
import { loadRecordingPlay } from "./matchPlayLoad";
import {
  detectedGoals,
  detectedShots,
  passEvents,
  pitchSizeOf,
  playerPlay,
  seedTeams,
  sideOfKit,
  teamDribbles,
  teamStats,
  type Lab,
} from "./matchPlay";
import { buildPlayerMetrics } from "./playerMetrics";
import { extractBunnyVideoId } from "./publicFootage";
import { getSettingValue } from "./settings";
import { shareToken } from "./shareCard";

export const DEMO_FIELD_NAME = "Jordan Galaxy";
const MAX_DEMO_CLIPS = 8;
const MIN_CLIP_SECONDS = 4;
const MAX_CLIP_SECONDS = 60;

export type DemoClip = {
  id: number;
  aspectRatio: "16:9" | "9:16";
  durationSeconds: number;
  src: string;
  poster: string;
};

export type DemoMatch = {
  recordingId: number;
  date: string;
  timeSlot: string;
  src: string;
  rawSrc: string;
  poster: string;
  /** True when an analysis bundle exists, so the report endpoint has something to say. */
  analysed: boolean;
};

export type DemoShowcase = {
  counts: { recordings: number; clips: number; analysed: number };
  match: DemoMatch | null;
  clips: DemoClip[];
  salesWhatsapp: string | null;
};

export type DemoMoment = { type: "goal" | "shot"; t: number; side: 0 | 1 | null };

export type DemoPlayer = {
  label: string;
  number: string | null;
  side: 0 | 1 | null;
  minutes: number;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesCompleted: number | null;
  /** 12 x 8 grid over the pitch, weights summing to ~1. */
  heatmap: Array<{ x: number; y: number; weight: number }>;
};

export type DemoReport = {
  recordingId: number;
  date: string;
  timeSlot: string;
  durationSeconds: number;
  hasBall: boolean;
  hasPitch: boolean;
  team: {
    colours: [string, string];
    possessionPercent: [number, number];
    passesCompleted: [number, number];
    passesTried: [number, number];
    shots: [number, number];
    goals: [number, number];
    dribblesWon: [number, number];
  } | null;
  moments: DemoMoment[];
  players: DemoPlayer[];
};

/** OpenCV 8-bit Lab (L 0-255, a/b offset by 128) back to #rrggbb; the inverse of matchPlay.hexToLab. */
export function labToHex(lab: Lab): string {
  const L = (lab[0] * 100) / 255;
  const a = lab[1] - 128;
  const b = lab[2] - 128;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047;
  const Y = inv(fy);
  const Z = inv(fz) * 1.08883;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const gamma = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return `#${[R, G, B].map((c) => gamma(c).toString(16).padStart(2, "0")).join("")}`;
}

/** "12, 40,x, 7" -> [12, 40, 7]. Anything that is not a positive integer is dropped. */
export function parseIdList(raw: string): number[] {
  const ids: number[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const id = Number(part);
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Shirt number when one was read, otherwise A, B, ... in the order given. */
export function playerLabels(numbers: Array<string | null>): string[] {
  let letter = 0;
  const used = new Set<string>();
  return numbers.map((number) => {
    if (number && !used.has(number)) {
      used.add(number);
      return `#${number}`;
    }
    const label = letter < 26 ? String.fromCharCode(65 + letter) : `P${letter + 1}`;
    letter += 1;
    return label;
  });
}

/**
 * wa.me wants the full international number as digits only. Accept what an
 * admin is likely to type: "+962 7 9…", "00962…" or the local "079…".
 */
export function whatsappDigits(raw: string): string | null {
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^07\d{8}$/.test(digits)) digits = `962${digits.slice(1)}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

async function settingString(key: string): Promise<string> {
  try {
    const value = await getSettingValue<string>(key);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

async function settingNumber(key: string): Promise<number> {
  try {
    const value = await getSettingValue<number>(key);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function demoFieldIds(): Promise<number[]> {
  const rows = await db.select({ id: fieldsTable.id }).from(fieldsTable).where(eq(fieldsTable.name, DEMO_FIELD_NAME));
  return rows.map((row) => row.id);
}

/**
 * The match the demo plays and reports on: the admin's pick, else the most
 * recently analysed recording (one with a match roster first, because that is
 * the one with per-player numbers), else the newest recording at the field.
 */
export async function pickDemoRecording(): Promise<{ recording: typeof recordingsTable.$inferSelect; analysed: boolean } | null> {
  const pinned = await settingNumber("demo.recordingId");
  if (pinned > 0) {
    const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, pinned));
    if (recording?.videoUrl) {
      const [bundle] = await db.select({ id: recordingTrackingBundlesTable.id })
        .from(recordingTrackingBundlesTable)
        .where(eq(recordingTrackingBundlesTable.recordingId, pinned));
      return { recording, analysed: Boolean(bundle) };
    }
  }

  const bundles = await db
    .select({ recordingId: recordingTrackingBundlesTable.recordingId, manifest: recordingTrackingBundlesTable.manifest, updatedAt: recordingTrackingBundlesTable.updatedAt })
    .from(recordingTrackingBundlesTable)
    .orderBy(desc(recordingTrackingBundlesTable.updatedAt))
    .limit(40);
  const ranked = [...bundles].sort((a, b) => {
    const rosterA = a.manifest?.matchRosterPath ? 1 : 0;
    const rosterB = b.manifest?.matchRosterPath ? 1 : 0;
    if (rosterA !== rosterB) return rosterB - rosterA;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  for (const candidate of ranked) {
    const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, candidate.recordingId));
    if (recording?.videoUrl && extractBunnyVideoId(recording.videoUrl)) return { recording, analysed: true };
  }

  const fieldIds = await demoFieldIds();
  if (!fieldIds.length) return null;
  const [latest] = await db
    .select()
    .from(recordingsTable)
    .where(inArray(recordingsTable.fieldId, fieldIds))
    .orderBy(desc(recordingsTable.createdAt))
    .limit(1);
  return latest?.videoUrl ? { recording: latest, analysed: false } : null;
}

function matchMedia(recording: typeof recordingsTable.$inferSelect, analysed: boolean): DemoMatch | null {
  const videoId = extractBunnyVideoId(recording.videoUrl);
  if (!videoId || videoId.startsWith("live:")) return null;
  return {
    recordingId: recording.id,
    date: recording.date,
    timeSlot: recording.timeSlot,
    src: getBunnyProxiedPlaybackUrl(videoId),
    rawSrc: getBunnyPlaybackUrl(videoId),
    poster: getBunnyProxiedThumbnailUrl(videoId),
    analysed,
  };
}

/**
 * Finished player clips, newest-and-most-watched first, or the admin's list.
 * Deleted, reported and admin-hidden clips never appear.
 */
async function pickDemoClips(): Promise<DemoClip[]> {
  const pinned = parseIdList(await settingString("demo.clipIds"));
  const base = and(
    eq(userClipsTable.exportStatus, "done"),
    eq(userClipsTable.isHidden, false),
    isNull(userClipsTable.hiddenReason),
  );
  const rows = pinned.length
    ? await db.select().from(userClipsTable).where(and(base, inArray(userClipsTable.id, pinned)))
    : await db
      .select()
      .from(userClipsTable)
      .where(base)
      .orderBy(desc(userClipsTable.score), desc(userClipsTable.viewCount), desc(userClipsTable.createdAt))
      .limit(60);

  const usable = rows.filter((row) => {
    if (!row.exportedUrl) return false;
    const seconds = Number(row.endTime) - Number(row.startTime);
    return Number.isFinite(seconds) && seconds >= MIN_CLIP_SECONDS && seconds <= MAX_CLIP_SECONDS;
  });
  const ordered = pinned.length
    ? pinned.map((id) => usable.find((row) => row.id === id)).filter((row): row is (typeof usable)[number] => Boolean(row))
    : usable.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .sort((a, b) => (b.likeCount + b.shareCount + b.viewCount) - (a.likeCount + a.shareCount + a.viewCount));

  // Automatic picks: at most two clips from the same source video, so the
  // rail is not eight angles of one goal.
  const perVideo = new Map<string, number>();
  const picked: typeof usable = [];
  for (const row of ordered) {
    const n = perVideo.get(row.videoId) ?? 0;
    if (!pinned.length && n >= 2) continue;
    perVideo.set(row.videoId, n + 1);
    picked.push(row);
    if (picked.length >= MAX_DEMO_CLIPS) break;
  }

  return picked.map((row) => {
    const token = shareToken(row.id);
    return {
      id: row.id,
      aspectRatio: row.aspectRatio === "9:16" ? "9:16" : "16:9",
      durationSeconds: Math.round((Number(row.endTime) - Number(row.startTime)) * 10) / 10,
      src: `/api/s/${row.id}/${token}/clip.mp4`,
      poster: `/api/s/${row.id}/${token}/poster.jpg`,
    };
  });
}

async function demoCounts(): Promise<DemoShowcase["counts"]> {
  const fieldIds = await demoFieldIds();
  const [recordings] = fieldIds.length
    ? await db.select({ n: count() }).from(recordingsTable).where(inArray(recordingsTable.fieldId, fieldIds))
    : [{ n: 0 }];
  const [clips] = await db.select({ n: count() }).from(userClipsTable).where(isNull(userClipsTable.hiddenReason));
  const [analysed] = await db.select({ n: count() }).from(recordingTrackingBundlesTable);
  return { recordings: Number(recordings?.n ?? 0), clips: Number(clips?.n ?? 0), analysed: Number(analysed?.n ?? 0) };
}

export async function buildDemoShowcase(): Promise<DemoShowcase> {
  const [counts, picked, clips, whatsapp] = await Promise.all([
    demoCounts(),
    pickDemoRecording(),
    pickDemoClips(),
    settingString("demo.salesWhatsapp"),
  ]);
  return {
    counts,
    match: picked ? matchMedia(picked.recording, picked.analysed) : null,
    clips,
    salesWhatsapp: whatsappDigits(whatsapp),
  };
}

/**
 * The match report for the demo recording, computed the same way the match
 * page computes claimed players' numbers, but over the bundle's own roster
 * (people/match.json) so it needs nobody to have claimed themselves.
 */
export async function buildDemoReport(recordingId: number): Promise<DemoReport | null> {
  const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, recordingId));
  if (!recording) return null;
  const play = await loadRecordingPlay(recordingId, { keepSegments: true });
  if (!play) return null;

  const pick = play.hasKits ? seedTeams(null, play.kitOptions) : null;
  const events = passEvents(play.touches, pick);
  const pitch = pitchSizeOf(play.manifest);
  const goals = detectedGoals(play.events, play.touches, pitch);
  const shots = detectedShots(play.events, play.touches, pitch);

  let team: DemoReport["team"] = null;
  if (pick && play.touches.length) {
    const s = teamStats(play.touches, events, pick);
    const dr = teamDribbles(play.dribbles, play.kits, pick);
    const perSide = (items: Array<{ kit: Lab | null }>): [number, number] => {
      const out: [number, number] = [0, 0];
      for (const item of items) {
        const side = sideOfKit(item.kit, pick);
        if (side !== null) out[side] += 1;
      }
      return out;
    };
    team = {
      colours: [labToHex(pick.a), labToHex(pick.b)],
      possessionPercent: s.possessionPercent,
      passesCompleted: s.passesCompleted,
      passesTried: s.passesTried,
      shots: perSide(shots),
      goals: perSide(goals),
      dribblesWon: dr.won,
    };
  }

  const moments: DemoMoment[] = [
    ...goals.map((goal) => ({ type: "goal" as const, t: Math.round(goal.t * 10) / 10, side: sideOfKit(goal.kit, pick) })),
    ...shots
      .filter((shot) => !goals.some((goal) => Math.abs(goal.t - shot.t) < 8))
      .map((shot) => ({ type: "shot" as const, t: Math.round(shot.t * 10) / 10, side: sideOfKit(shot.kit, pick) })),
  ].sort((a, b) => a.t - b.t);

  const players: DemoPlayer[] = [];
  const manifestRoster = play.manifest.matchRosterPath;
  if (manifestRoster && play.segments) {
    try {
      const roster = JSON.parse((await readClaimSegment(manifestRoster)).toString("utf8")) as {
        players?: Array<{ number?: string | number | null; parts?: Array<{ trackId: string; fromFrame: number; toFrame: number }> }>;
      };
      const rows = (roster.players ?? [])
        .map((player) => ({
          number: player.number === null || player.number === undefined || player.number === "" ? null : String(player.number),
          parts: (player.parts ?? [])
            .filter((part) => typeof part.trackId === "string" && Number.isFinite(part.fromFrame) && Number.isFinite(part.toFrame) && part.toFrame > part.fromFrame)
            .map((part) => ({ trackId: part.trackId, fromFrame: part.fromFrame, toFrame: part.toFrame })),
        }))
        .filter((player) => player.parts.length > 0);
      const measured = rows.map((player) => {
        const seconds = player.parts.reduce((sum, part) => sum + (part.toFrame - part.fromFrame) / play.fps, 0);
        const metrics = buildPlayerMetrics(play.manifest, play.segments!, player.parts, seconds, 0, 0, 0, 0, 0, 0, []);
        const mine = play.hasBall ? playerPlay(play.touches, events, player.parts, Boolean(pick)) : null;
        const kitVotes: [number, number] = [0, 0];
        for (const part of player.parts) {
          const side = sideOfKit(play.kits.get(part.trackId) ?? null, pick);
          if (side !== null) kitVotes[side] += part.toFrame - part.fromFrame;
        }
        const side: 0 | 1 | null = kitVotes[0] === 0 && kitVotes[1] === 0 ? null : kitVotes[0] >= kitVotes[1] ? 0 : 1;
        const top = metrics.adminPlayerStats.topSpeedMetresPerSecond;
        return {
          number: player.number,
          side,
          minutes: Math.round(seconds / 6) / 10,
          distanceKm: metrics.distanceMetres === null ? null : Math.round(metrics.distanceMetres / 10) / 100,
          topSpeedKmh: typeof top === "number" ? Math.round(top * 36) / 10 : null,
          touches: mine ? mine.touches.length : null,
          passesCompleted: mine && pick ? mine.passesCompleted : null,
          heatmap: metrics.heatmap.coordinateSpace === "pitch" ? metrics.heatmap.cells : [],
        };
      })
        // A few minutes of someone walking past is not a player's match.
        .filter((player) => player.minutes >= 5)
        .sort((a, b) => (b.distanceKm ?? b.minutes / 100) - (a.distanceKm ?? a.minutes / 100))
        .slice(0, 14);
      const labels = playerLabels(measured.map((player) => player.number));
      measured.forEach((player, index) => players.push({ label: labels[index], ...player }));
    } catch (error) {
      logger.warn({ recordingId, err: error }, "demo report: could not read the match roster");
    }
  }

  return {
    recordingId,
    date: recording.date,
    timeSlot: recording.timeSlot,
    durationSeconds: Math.round(play.manifest.duration ?? 0),
    hasBall: play.hasBall,
    hasPitch: play.hasPitch,
    team,
    moments,
    players,
  };
}

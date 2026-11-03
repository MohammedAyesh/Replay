import type { SceneMusic } from "./creativeScene";

/**
 * Creative hub music library (creative_music_tracks, 0063): shared facts the
 * API and the console both use, so the editor's preview plays the soundtrack
 * the way the export mixes it.
 *
 * Two scopes: "replay" (Replay's own library, managed in /admin, open to every
 * academy) and "academy" (a track an academy uploaded; only that academy sees
 * or uses it). A scene points at a track by trackId (see sceneMusicSchema).
 */

export const MUSIC_MOODS = ["hype", "epic", "chill", "fun", "emotional", "cinematic"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];
export const MUSIC_SCOPES = ["replay", "academy"] as const;
export type MusicScope = (typeof MUSIC_SCOPES)[number];
export const MUSIC_STATUSES = ["active", "hidden"] as const;
export type MusicStatus = (typeof MUSIC_STATUSES)[number];

/** Uploads: what the console lets through and the API enforces. */
export const MUSIC_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const MUSIC_MAX_DURATION_MS = 10 * 60_000;
/** Shorter than this is a sound, not a soundtrack. */
export const MUSIC_MIN_DURATION_MS = 3_000;
export const MUSIC_UPLOAD_EXTENSIONS = ["mp3", "m4a", "aac", "wav"] as const;
export const MUSIC_UPLOAD_ACCEPT = ".mp3,.m4a,.aac,.wav,audio/mpeg,audio/mp4,audio/aac,audio/x-m4a,audio/wav,audio/x-wav,audio/wave";
/** Peaks stored per track for the editor's waveform (0..1, one per slice). */
export const MUSIC_WAVEFORM_PEAKS = 200;

/** Licence lines a track carries. */
export const MUSIC_LICENSES = {
  generated: "Replay original (generated)",
  replay: "Replay licensed",
  academy: "Academy confirms rights",
} as const;

/**
 * Every track is brought to this integrated loudness before its volume is
 * applied, so 0.6 sounds the same on a quiet acoustic loop and a loud drop.
 */
export const MUSIC_TARGET_LUFS = -16;

/** Gain (dB) that takes a track measured at `lufs` to MUSIC_TARGET_LUFS; null when unmeasured. */
export function musicLoudnessGainDb(lufs: number | null | undefined): number | null {
  if (lufs === null || lufs === undefined || !Number.isFinite(lufs)) return null;
  return Math.max(-20, Math.min(12, MUSIC_TARGET_LUFS - lufs));
}

/** The scene's fades, shortened so in + out never exceed the scene. */
export function musicFades(music: Pick<SceneMusic, "fadeInMs" | "fadeOutMs">, durationMs: number): { inMs: number; outMs: number } {
  let inMs = Math.max(0, music.fadeInMs ?? 0);
  let outMs = Math.max(0, music.fadeOutMs ?? 0);
  const D = Math.max(0, durationMs);
  if (inMs + outMs > D && inMs + outMs > 0) {
    const k = D / (inMs + outMs);
    inMs = Math.floor(inMs * k);
    outMs = Math.floor(outMs * k);
  }
  return { inMs, outMs };
}

/** Where in the track (ms) scene time t plays: startMs + t, looping over the track's length. */
export function musicTrackTimeAt(music: Pick<SceneMusic, "startMs">, trackDurationMs: number, t: number): number {
  const L = trackDurationMs > 0 ? trackDurationMs : 0;
  const at = (music.startMs ?? 0) + Math.max(0, t);
  if (!L) return at;
  return ((at % L) + L) % L;
}

/** The fade envelope at scene time t (0..1, linear, as afade's default curve). */
export function musicFadeGainAt(music: Pick<SceneMusic, "fadeInMs" | "fadeOutMs">, durationMs: number, t: number): number {
  const { inMs, outMs } = musicFades(music, durationMs);
  let g = 1;
  if (inMs > 0 && t < inMs) g = Math.min(g, Math.max(0, t / inMs));
  if (outMs > 0 && t > durationMs - outMs) g = Math.min(g, Math.max(0, (durationMs - t) / outMs));
  return g;
}

/** A start point that leaves a whole scene's worth of track after it when the track is long enough. */
export function clampMusicStart(startMs: number, trackDurationMs: number, sceneDurationMs: number): number {
  const s = Math.max(0, Math.round(startMs));
  if (trackDurationMs <= 0) return s;
  const latest = trackDurationMs > sceneDurationMs ? trackDurationMs - sceneDurationMs : trackDurationMs - 1;
  return Math.min(s, Math.max(0, latest));
}

/**
 * The soundtrack a video template starts with, by mood, when Replay's library
 * has a track of that mood. Talk keeps the music low and ducks it under the
 * coach's voice; a goal and a training clip play it out.
 */
export type TemplateMusicDefault = { mood: MusicMood; volume: number; duck: boolean; fadeInMs: number; fadeOutMs: number };
export const TEMPLATE_MUSIC: Record<string, TemplateMusicDefault> = {
  goal: { mood: "hype", volume: 0.7, duck: false, fadeInMs: 300, fadeOutMs: 1500 },
  training: { mood: "fun", volume: 0.55, duck: false, fadeInMs: 500, fadeOutMs: 1500 },
  talk: { mood: "chill", volume: 0.25, duck: true, fadeInMs: 1000, fadeOutMs: 1500 },
};

/**
 * The default music for a template, or null: the first track of the
 * template's mood among `tracks` (Replay's active library, in its own order).
 */
export function templateDefaultMusic(templateKey: string | null | undefined, tracks: Array<{ trackId: number; mood: string }>): SceneMusic | null {
  const def = templateKey ? TEMPLATE_MUSIC[templateKey] : undefined;
  if (!def) return null;
  const track = tracks.find((t) => t.mood === def.mood);
  if (!track) return null;
  return { trackId: track.trackId, volume: def.volume, startMs: 0, fadeInMs: def.fadeInMs, fadeOutMs: def.fadeOutMs, duck: def.duck };
}

/** Does the scene's music point at a track at all? */
export const hasMusic = (music: SceneMusic | undefined | null): music is SceneMusic => !!music && (music.trackId !== undefined || !!music.trackKey);

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

/** How a template's soundtrack plays: volume 0..1, ducking under voices, fades and where in the track it starts. */
export type TemplateMusicSettings = { volume: number; duck: boolean; fadeInMs: number; fadeOutMs: number; startMs: number };

/** What a template's music is when nothing more is said: 60 %, no ducking, a short fade in and a long fade out. */
export const TEMPLATE_MUSIC_DEFAULTS: TemplateMusicSettings = { volume: 0.6, duck: false, fadeInMs: 300, fadeOutMs: 1500, startMs: 0 };

/** Limits an admin's template music must keep (the same the scene accepts). */
export const TEMPLATE_MUSIC_MAX_TRACKS = 5;
export const TEMPLATE_MUSIC_MAX_FADE_MS = 10_000;
export const TEMPLATE_MUSIC_MAX_START_MS = MUSIC_MAX_DURATION_MS;

/**
 * Replay's own pick of music for a template: 1–3 bundled tracks by key
 * (assets/creative/music/library.json), the first the one a video starts
 * with, and how it plays. `mood` is the first track's mood: when every track
 * of the pick is gone (hidden or deleted), a video gets the first active
 * Replay track of that mood instead.
 */
export type BuiltInTemplateMusic = TemplateMusicSettings & { tracks: readonly string[]; mood: MusicMood };

const pick = (mood: MusicMood, tracks: string[], settings: Partial<TemplateMusicSettings> = {}): BuiltInTemplateMusic =>
  ({ ...TEMPLATE_MUSIC_DEFAULTS, ...settings, tracks, mood });

/**
 * Every template's recommended music (CREATIVE_TEMPLATES, all 37; a test
 * fails when one is missing or names a track library.json doesn't have).
 * Admins can replace any of them in /admin (creative_template_music, 0064);
 * this is what "Reset to Replay's recommendation" goes back to.
 */
export const TEMPLATE_RECOMMENDED_MUSIC: Record<string, BuiltInTemplateMusic> = {
  fulltime: pick("hype", ["cc0/energetic-electro-tune", "cc0/warped", "replay/matchday-anthem"]),
  matchday: pick("epic", ["cc0/determined-pursuit", "cc0/now-thats-automation", "replay/stadium-stomp"]),
  potm: pick("epic", ["cc0/great-mission", "cc0/epic-endgame", "replay/rising-star"]),
  goal: pick("hype", ["cc0/energetic-electro-tune", "cc0/fight-for-a-better-future", "replay/matchday-anthem"], { volume: 0.7 }),
  lineup: pick("hype", ["cc0/now-thats-automation", "cc0/serum-patches", "replay/stadium-stomp"]),
  potmonth: pick("cinematic", ["cc0/flags", "cc0/adventure-intro", "replay/rising-star"]),
  standings: pick("fun", ["cc0/cafe-part-time", "cc0/elevate"]),
  nextround: pick("epic", ["cc0/determined-pursuit", "cc0/great-mission", "replay/final-whistle"]),
  champions: pick("epic", ["cc0/epic-endgame", "cc0/great-mission", "replay/final-whistle"]),
  freetrial: pick("fun", ["cc0/elevate", "cc0/thats-what-friends-do", "replay/little-legends"]),
  cleansheet: pick("hype", ["cc0/warped", "cc0/serum-patches"]),
  birthday: pick("fun", ["cc0/beach-sports", "cc0/thats-what-friends-do", "replay/little-legends"]),
  pricing: pick("chill", ["cc0/feel-good-summer", "cc0/cafe-part-time"]),
  newgroup: pick("fun", ["cc0/elevate", "cc0/beach-sports", "replay/little-legends"]),
  // The coach is talking: music low and ducked under the voice.
  talk: pick("chill", ["cc0/chill-lofi", "cc0/synthwave-calm", "replay/sunday-session"], { volume: 0.25, duck: true, fadeInMs: 1000 }),
  training: pick("fun", ["cc0/elevate", "cc0/cafe-part-time", "replay/little-legends"], { volume: 0.55, fadeInMs: 500 }),
  welcome: pick("chill", ["cc0/feel-good-summer", "cc0/thats-what-friends-do"]),
  getwell: pick("emotional", ["cc0/elevate-soft-piano", "replay/proud-moments"]),
  staff: pick("cinematic", ["cc0/flags", "cc0/chill-lofi"]),
  alumni: pick("emotional", ["replay/proud-moments", "cc0/elevate-soft-piano", "cc0/flags"]),
  tournament: pick("epic", ["cc0/determined-pursuit", "cc0/epic-endgame", "replay/final-whistle"]),
  poll: pick("fun", ["cc0/cafe-part-time", "cc0/beach-sports"]),
  map: pick("chill", ["cc0/a-chill-fever", "cc0/feel-good-summer"]),
  manifesto: pick("cinematic", ["cc0/adventure-intro", "cc0/flags", "replay/rising-star"]),
  kickoff: pick("hype", ["cc0/fight-for-a-better-future", "cc0/energetic-electro-tune", "replay/stadium-stomp"]),
  goalflash: pick("hype", ["cc0/energetic-electro-tune", "cc0/warped"]),
  halftime: pick("chill", ["cc0/a-chill-fever", "cc0/synthwave-calm"]),
  livescore: pick("hype", ["cc0/now-thats-automation", "cc0/serum-patches"]),
  countdown: pick("epic", ["cc0/determined-pursuit", "cc0/adventure-intro"]),
  callup: pick("hype", ["cc0/now-thats-automation", "replay/stadium-stomp"]),
  matchstats: pick("fun", ["cc0/cafe-part-time", "cc0/synthwave-calm"]),
  meetplayer: pick("fun", ["cc0/thats-what-friends-do", "cc0/elevate", "replay/little-legends"]),
  improved: pick("epic", ["cc0/great-mission", "cc0/adventure-intro", "replay/rising-star"]),
  streak: pick("fun", ["cc0/elevate", "cc0/beach-sports", "replay/little-legends"]),
  firstgoal: pick("hype", ["cc0/energetic-electro-tune", "cc0/fight-for-a-better-future", "replay/matchday-anthem"]),
  goalduo: pick("hype", ["cc0/energetic-electro-tune", "cc0/fight-for-a-better-future", "replay/matchday-anthem"], { volume: 0.7 }),
  weekmoment: pick("hype", ["cc0/energetic-electro-tune", "cc0/warped", "replay/matchday-anthem"], { volume: 0.7 }),
  // Football fields' Instagram pack (fieldPack.ts): the pitch's own sound stays under the music.
  "field-booking-clip": pick("hype", ["cc0/energetic-electro-tune", "cc0/warped", "replay/matchday-anthem"], { volume: 0.6 }),
  "field-award": pick("epic", ["cc0/great-mission", "cc0/epic-endgame", "replay/rising-star"], { volume: 0.7 }),
  "field-potm": pick("epic", ["cc0/great-mission", "cc0/epic-endgame", "replay/rising-star"], { volume: 0.7 }),
  "field-potw": pick("epic", ["cc0/great-mission", "cc0/epic-endgame", "replay/rising-star"], { volume: 0.7 }),
  "field-match-week": pick("hype", ["cc0/fight-for-a-better-future", "cc0/energetic-electro-tune", "replay/stadium-stomp"], { volume: 0.7 }),
  "field-top5": pick("hype", ["cc0/now-thats-automation", "cc0/serum-patches", "replay/stadium-stomp"], { volume: 0.7 }),
  "field-versus": pick("fun", ["cc0/cafe-part-time", "cc0/beach-sports"], { volume: 0.6 }),
  "field-versus-story": pick("fun", ["cc0/cafe-part-time", "cc0/beach-sports"], { volume: 0.6 }),
  "field-nominee-slide": pick("hype", ["cc0/energetic-electro-tune", "cc0/warped"], { volume: 0.6 }),
  "field-thanks": pick("cinematic", ["cc0/flags", "cc0/adventure-intro", "replay/proud-moments"]),
  "field-milestone": pick("epic", ["cc0/epic-endgame", "cc0/great-mission", "replay/final-whistle"]),
  "field-match-highlights": pick("hype", ["cc0/energetic-electro-tune", "cc0/fight-for-a-better-future", "replay/matchday-anthem"], { volume: 0.7 }),
  "field-day-best": pick("hype", ["cc0/now-thats-automation", "cc0/serum-patches", "replay/stadium-stomp"], { volume: 0.7 }),
  // Academies' pack (clubPack.ts).
  "club-highlights": pick("hype", ["cc0/energetic-electro-tune", "cc0/fight-for-a-better-future", "replay/matchday-anthem"], { volume: 0.7 }),
  "club-goal": pick("hype", ["cc0/energetic-electro-tune", "cc0/warped", "replay/matchday-anthem"], { volume: 0.6 }),
  "club-fulltime": pick("epic", ["cc0/epic-endgame", "cc0/great-mission", "replay/final-whistle"], { volume: 0.7 }),
  "club-potm": pick("epic", ["cc0/great-mission", "cc0/epic-endgame", "replay/rising-star"], { volume: 0.7 }),
  "club-award": pick("epic", ["cc0/great-mission", "cc0/epic-endgame", "replay/rising-star"], { volume: 0.7 }),
  "club-top5": pick("hype", ["cc0/now-thats-automation", "cc0/serum-patches", "replay/stadium-stomp"], { volume: 0.7 }),
  "club-week": pick("cinematic", ["cc0/flags", "cc0/adventure-intro", "replay/proud-moments"]),
  "club-milestone": pick("epic", ["cc0/epic-endgame", "cc0/great-mission", "replay/final-whistle"]),
  "club-versus": pick("fun", ["cc0/cafe-part-time", "cc0/beach-sports"], { volume: 0.6 }),
  "club-versus-story": pick("fun", ["cc0/cafe-part-time", "cc0/beach-sports"], { volume: 0.6 }),
  "club-nominee-slide": pick("hype", ["cc0/energetic-electro-tune", "cc0/warped"], { volume: 0.6 }),
};

/** The settings of a template's built-in pick (the defaults for a template without one). */
export function builtInTemplateSettings(templateKey: string): TemplateMusicSettings {
  const b = TEMPLATE_RECOMMENDED_MUSIC[templateKey];
  return b ? { volume: b.volume, duck: b.duck, fadeInMs: b.fadeInMs, fadeOutMs: b.fadeOutMs, startMs: b.startMs } : { ...TEMPLATE_MUSIC_DEFAULTS };
}

/** A template's recommendation with track ids: Replay's built-in one (keys looked up) or an admin's. */
export type TemplateMusicRecommendation = TemplateMusicSettings & { trackIds: number[] };

/** A library track as recommendations need it (Replay's active library, in its own order). */
export type RecommendableTrack = { trackId: number; key?: string | null; mood: string };

/** Replay's built-in pick for a template with its keys turned into ids (keys the library lacks are dropped), or null. */
export function builtInTemplateMusic(templateKey: string, tracks: RecommendableTrack[]): TemplateMusicRecommendation | null {
  const b = TEMPLATE_RECOMMENDED_MUSIC[templateKey];
  if (!b) return null;
  const byKey = new Map(tracks.filter((t) => t.key).map((t) => [t.key as string, t.trackId]));
  const trackIds = b.tracks.map((k) => byKey.get(k)).filter((id): id is number => id !== undefined);
  return { ...builtInTemplateSettings(templateKey), trackIds };
}

/**
 * The music a template recommends now. An admin's choice wins over Replay's
 * built-in pick; tracks not in `tracks` (hidden, deleted, not Replay's) are
 * skipped. When none is left the first track of the template's mood stands
 * in (the mood logic videos used before recommendations), and when the
 * library has none of that either, `trackIds` is empty. An admin who saved
 * an empty list chose no music: nothing stands in.
 */
export function effectiveTemplateMusic(
  templateKey: string,
  override: TemplateMusicRecommendation | null | undefined,
  tracks: RecommendableTrack[],
): (TemplateMusicRecommendation & { customised: boolean; fallback: boolean }) | null {
  const builtIn = builtInTemplateMusic(templateKey, tracks);
  const base = override ?? builtIn;
  if (!base) return null;
  const active = new Set(tracks.map((t) => t.trackId));
  const trackIds = [...new Set(base.trackIds)].filter((id) => active.has(id));
  const settings = { volume: base.volume, duck: base.duck, fadeInMs: base.fadeInMs, fadeOutMs: base.fadeOutMs, startMs: base.startMs };
  if (trackIds.length || (override && override.trackIds.length === 0)) return { ...settings, trackIds, customised: !!override, fallback: false };
  const mood = TEMPLATE_RECOMMENDED_MUSIC[templateKey]?.mood;
  const stand = mood ? tracks.find((t) => t.mood === mood) : undefined;
  return { ...settings, trackIds: stand ? [stand.trackId] : [], customised: !!override, fallback: !!stand };
}

/** A recommendation as the scene music a video starts with (its first track), or null when it has no track. */
export function recommendationSceneMusic(rec: TemplateMusicRecommendation | null | undefined): SceneMusic | null {
  const trackId = rec?.trackIds[0];
  if (!rec || trackId === undefined) return null;
  return { trackId, volume: rec.volume, startMs: rec.startMs, fadeInMs: rec.fadeInMs, fadeOutMs: rec.fadeOutMs, duck: rec.duck };
}

/**
 * The default music for a template by mood alone, or null: the first track of
 * the template's mood among `tracks` (Replay's active library, in its own
 * order), with the template's built-in settings. What a video falls back to
 * when every recommended track is gone.
 */
export function templateDefaultMusic(templateKey: string | null | undefined, tracks: Array<{ trackId: number; mood: string }>): SceneMusic | null {
  const def = templateKey ? TEMPLATE_RECOMMENDED_MUSIC[templateKey] : undefined;
  if (!def || !templateKey) return null;
  const track = tracks.find((t) => t.mood === def.mood);
  if (!track) return null;
  return recommendationSceneMusic({ ...builtInTemplateSettings(templateKey), trackIds: [track.trackId] });
}

/** An admin's template music from a request body, checked against the limits; `error` names the field that's wrong. */
export function parseTemplateMusicInput(body: unknown):
  | { ok: true; value: TemplateMusicRecommendation }
  | { ok: false; error: string; field: keyof TemplateMusicRecommendation } {
  const b = (body ?? {}) as Record<string, unknown>;
  const ids = b.trackIds;
  if (!Array.isArray(ids) || ids.length > TEMPLATE_MUSIC_MAX_TRACKS || !ids.every((id) => Number.isSafeInteger(id) && (id as number) > 0)) {
    return { ok: false, field: "trackIds", error: `Pick up to ${TEMPLATE_MUSIC_MAX_TRACKS} tracks` };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, field: "trackIds", error: "A track is in the list twice" };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const volume = num(b.volume);
  if (!(volume >= 0 && volume <= 1)) return { ok: false, field: "volume", error: "Volume is between 0 and 1" };
  if (typeof b.duck !== "boolean") return { ok: false, field: "duck", error: "Say whether the music lowers under voices" };
  const ms = (v: unknown, max: number) => { const n = num(v); return n >= 0 && n <= max ? Math.round(n) : null; };
  const fadeInMs = ms(b.fadeInMs, TEMPLATE_MUSIC_MAX_FADE_MS);
  if (fadeInMs === null) return { ok: false, field: "fadeInMs", error: `Fade in is 0–${TEMPLATE_MUSIC_MAX_FADE_MS / 1000} seconds` };
  const fadeOutMs = ms(b.fadeOutMs, TEMPLATE_MUSIC_MAX_FADE_MS);
  if (fadeOutMs === null) return { ok: false, field: "fadeOutMs", error: `Fade out is 0–${TEMPLATE_MUSIC_MAX_FADE_MS / 1000} seconds` };
  const startMs = ms(b.startMs, TEMPLATE_MUSIC_MAX_START_MS);
  if (startMs === null) return { ok: false, field: "startMs", error: `The start point is 0–${TEMPLATE_MUSIC_MAX_START_MS / 60_000} minutes into the track` };
  return { ok: true, value: { trackIds: ids as number[], volume: Math.round(volume * 100) / 100, duck: b.duck, fadeInMs, fadeOutMs, startMs } };
}

/** Does the scene's music point at a track at all? */
export const hasMusic = (music: SceneMusic | undefined | null): music is SceneMusic => !!music && (music.trackId !== undefined || !!music.trackKey);

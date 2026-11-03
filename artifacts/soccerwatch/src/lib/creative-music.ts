import {
  clampMusicStart,
  hasMusic,
  musicFadeGainAt,
  musicLoudnessGainDb,
  musicTrackTimeAt,
  type SceneMusic,
  type TemplateMusicRecommendation,
} from "@workspace/api-zod";

/**
 * Creative hub → Music: the editor's arithmetic, kept pure so it is tested
 * (creative-music.test.ts). The renderer's semantics live in
 * @workspace/api-zod creativeMusic.ts; the preview follows them.
 */

/** `peaks` resampled to `n` bars (max of each span), for a waveform of any width. */
export function waveformBars(peaks: number[], n: number): number[] {
  if (!peaks.length || n < 1) return new Array(Math.max(0, n)).fill(0.08);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let j = from; j < to && j < peaks.length; j++) m = Math.max(m, peaks[j] ?? 0);
    out.push(Math.max(0.06, Math.min(1, m)));
  }
  return out;
}

/**
 * The start point after a drag on the waveform. `frac` is where the pointer is
 * (0..1 of the track), `grabMs` how far into the scene's window the pointer
 * took hold of it (0 when the press landed outside the window: the window then
 * starts at the pointer).
 */
export function dragMusicStart(frac: number, grabMs: number, trackMs: number, sceneMs: number): number {
  const at = Math.max(0, Math.min(1, frac)) * trackMs - grabMs;
  return clampMusicStart(at, trackMs, sceneMs);
}

/** Where the press landed relative to the window [startMs, startMs + sceneMs): ms into it, or null outside. */
export function grabInWindow(frac: number, startMs: number, trackMs: number, sceneMs: number): number | null {
  const at = Math.max(0, Math.min(1, frac)) * trackMs;
  const end = Math.min(trackMs, startMs + sceneMs);
  return at >= startMs && at <= end ? at - startMs : null;
}

/** The scene window on the waveform as fractions (it may wrap when the track loops; the bar shows the first pass). */
export function windowOnTrack(startMs: number, trackMs: number, sceneMs: number): { left: number; width: number; loops: boolean } {
  if (trackMs <= 0) return { left: 0, width: 1, loops: false };
  const left = Math.min(1, Math.max(0, startMs / trackMs));
  const width = Math.min(1 - left, sceneMs / trackMs);
  return { left, width, loops: startMs + sceneMs > trackMs };
}

/**
 * The preview's volume at scene time t: the scene's volume × the fades × the
 * loudness gain the export applies (an <audio> can't go above 1, so a quiet
 * track previews a little quieter than it exports).
 */
export function previewVolume(music: Pick<SceneMusic, "volume" | "fadeInMs" | "fadeOutMs">, sceneMs: number, t: number, loudnessLufs: number | null): number {
  const gainDb = musicLoudnessGainDb(loudnessLufs) ?? 0;
  const v = (music.volume ?? 0.6) * musicFadeGainAt(music, sceneMs, t) * Math.pow(10, gainDb / 20);
  return Math.max(0, Math.min(1, v));
}

export type SyncAction = { seekSec: number | null; play: boolean; pause: boolean };

/**
 * What to do with the <audio> so it follows the scene clock: seek when it has
 * drifted more than `toleranceMs` (or jumped, e.g. the playhead was dragged or
 * the scene looped), play when the scene plays, pause when it doesn't.
 */
export function musicSyncAction(o: {
  playing: boolean;
  sceneMs: number;
  t: number;
  trackMs: number;
  startMs: number;
  audioSec: number;
  audioPaused: boolean;
  toleranceMs?: number;
}): SyncAction {
  const want = musicTrackTimeAt({ startMs: o.startMs }, o.trackMs, o.t);
  const drift = Math.abs(o.audioSec * 1000 - want);
  // Near the loop point the two clocks wrap at different moments: compare across the wrap too.
  const wrapped = o.trackMs > 0 ? Math.min(drift, Math.abs(o.trackMs - drift)) : drift;
  const tol = o.toleranceMs ?? (o.playing ? 250 : 40);
  const seekSec = wrapped > tol ? want / 1000 : null;
  return { seekSec, play: o.playing && o.audioPaused, pause: !o.playing && !o.audioPaused };
}

/**
 * Bars for the timeline's music lane: what the scene plays, from the start
 * point and looping, sampled `n` times across the scene.
 */
export function laneBars(peaks: number[], trackMs: number, startMs: number, sceneMs: number, n: number): number[] {
  if (!peaks.length || trackMs <= 0 || n < 1) return new Array(Math.max(0, n)).fill(0.08);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = musicTrackTimeAt({ startMs }, trackMs, ((i + 0.5) / n) * sceneMs);
    const idx = Math.min(peaks.length - 1, Math.floor((at / trackMs) * peaks.length));
    out.push(Math.max(0.06, Math.min(1, peaks[idx] ?? 0)));
  }
  return out;
}

/** The track a scene's music names: by id, else (older designs) by bundled key. */
export function sceneTrack<T extends { trackId: number; key: string | null }>(music: Pick<SceneMusic, "trackId" | "trackKey"> | undefined, tracks: T[] | undefined): T | null {
  if (!music || !tracks) return null;
  if (music.trackId !== undefined) return tracks.find((t) => t.trackId === music.trackId) ?? null;
  if (music.trackKey) return tracks.find((t) => t.key === music.trackKey) ?? null;
  return null;
}

export const formatTrackLength = (ms: number) => {
  const s = Math.round(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Using a recommended track: a video without music takes the template's
 * settings with it; one that has music keeps its volume, fades and ducking
 * and starts the new track where the recommendation says.
 */
export function recommendedMusicChange(current: SceneMusic | undefined, rec: TemplateMusicRecommendation, trackId: number): SceneMusic {
  if (!hasMusic(current)) return { trackId, volume: rec.volume, startMs: rec.startMs, fadeInMs: rec.fadeInMs, fadeOutMs: rec.fadeOutMs, duck: rec.duck };
  const next: SceneMusic = { ...current, trackId, startMs: rec.startMs };
  delete next.trackKey;
  return next;
}

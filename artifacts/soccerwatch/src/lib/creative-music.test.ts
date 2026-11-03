import { describe, expect, it } from "vitest";
import {
  CREATIVE_TEMPLATES,
  TEMPLATE_RECOMMENDED_MUSIC,
  builtInTemplateMusic,
  clampMusicStart,
  effectiveTemplateMusic,
  musicFadeGainAt,
  musicFades,
  musicTrackTimeAt,
  parseTemplateMusicInput,
  recommendationSceneMusic,
  sceneSchema,
  templateDefaultMusic,
} from "@workspace/api-zod";
import { creativeMusicStrings } from "@/i18n/creative-music-strings";
import {
  dragMusicStart,
  grabInWindow,
  laneBars,
  musicSyncAction,
  previewVolume,
  recommendedMusicChange,
  sceneTrack,
  waveformBars,
  windowOnTrack,
} from "./creative-music";

describe("music timing (shared with the export)", () => {
  it("plays the track from its start point and loops it", () => {
    expect(musicTrackTimeAt({ startMs: 5000 }, 30_000, 0)).toBe(5000);
    expect(musicTrackTimeAt({ startMs: 5000 }, 30_000, 10_000)).toBe(15_000);
    expect(musicTrackTimeAt({ startMs: 25_000 }, 30_000, 10_000)).toBe(5000);
    expect(musicTrackTimeAt({}, 0, 1234)).toBe(1234);
  });

  it("fades in and out linearly and squeezes fades into a short scene", () => {
    const m = { fadeInMs: 1000, fadeOutMs: 2000 };
    expect(musicFadeGainAt(m, 10_000, 0)).toBe(0);
    expect(musicFadeGainAt(m, 10_000, 500)).toBeCloseTo(0.5);
    expect(musicFadeGainAt(m, 10_000, 5000)).toBe(1);
    expect(musicFadeGainAt(m, 10_000, 9000)).toBeCloseTo(0.5);
    expect(musicFades({ fadeInMs: 3000, fadeOutMs: 3000 }, 4000)).toEqual({ inMs: 2000, outMs: 2000 });
  });

  it("keeps a whole scene of track after the start point when the track is long enough", () => {
    expect(clampMusicStart(50_000, 60_000, 15_000)).toBe(45_000);
    expect(clampMusicStart(-5, 60_000, 15_000)).toBe(0);
    // A track shorter than the scene loops: any point of it can start.
    expect(clampMusicStart(9_000, 10_000, 15_000)).toBe(9_000);
  });

  it("falls back to a track of the template's mood", () => {
    const lib = [{ trackId: 1, mood: "epic" }, { trackId: 2, mood: "hype" }, { trackId: 3, mood: "chill" }, { trackId: 4, mood: "hype" }];
    expect(templateDefaultMusic("goal", lib)).toMatchObject({ trackId: 2, volume: 0.7, duck: false });
    expect(templateDefaultMusic("talk", lib)).toMatchObject({ trackId: 3, volume: 0.25, duck: true, fadeInMs: 1000 });
    expect(templateDefaultMusic("training", lib)).toBeNull();
    expect(templateDefaultMusic("fulltime", lib)).toMatchObject({ trackId: 2, volume: 0.6, duck: false, fadeInMs: 300, fadeOutMs: 1500 });
    expect(templateDefaultMusic("nope", lib)).toBeNull();
  });

  it("reads designs saved before the library (trackKey only) and the new fields", () => {
    const base = { v: 1, format: "story", durationMs: 15000, layers: [], locale: "en" };
    expect(sceneSchema.parse({ ...base, music: { trackKey: "replay/old", volume: 0.5 } }).music).toEqual({ trackKey: "replay/old", volume: 0.5 });
    expect(sceneSchema.parse({ ...base, music: { trackId: 7, startMs: 1200, fadeInMs: 300, fadeOutMs: 900, duck: true } }).music)
      .toEqual({ trackId: 7, volume: 0.6, startMs: 1200, fadeInMs: 300, fadeOutMs: 900, duck: true });
    expect(sceneSchema.safeParse({ ...base, music: { trackId: 7, volume: 2 } }).success).toBe(false);
    expect(sceneSchema.safeParse({ ...base, music: { trackId: -1, volume: 0.5 } }).success).toBe(false);
  });
});

describe("template recommendations", () => {
  const lib = [
    { trackId: 10, key: "cc0/energetic-electro-tune", mood: "hype" },
    { trackId: 11, key: "cc0/fight-for-a-better-future", mood: "hype" },
    { trackId: 12, key: "replay/matchday-anthem", mood: "hype" },
    { trackId: 13, key: "cc0/chill-lofi", mood: "chill" },
    { trackId: 20, key: null, mood: "epic" },
  ];

  it("has 1–3 tracks for every template in the catalogue and nothing else", () => {
    expect(Object.keys(TEMPLATE_RECOMMENDED_MUSIC).sort()).toEqual(CREATIVE_TEMPLATES.map((t) => t.key).sort());
    expect(CREATIVE_TEMPLATES).toHaveLength(37);
    for (const [key, r] of Object.entries(TEMPLATE_RECOMMENDED_MUSIC)) {
      expect(r.tracks.length, key).toBeGreaterThanOrEqual(1);
      expect(r.tracks.length, key).toBeLessThanOrEqual(3);
      expect(new Set(r.tracks).size, key).toBe(r.tracks.length);
      for (const k of r.tracks) expect(k, key).toMatch(/^(replay|cc0)\/[a-z0-9-]+$/);
    }
    expect(TEMPLATE_RECOMMENDED_MUSIC.talk).toMatchObject({ volume: 0.25, duck: true, fadeInMs: 1000, fadeOutMs: 1500 });
    expect(TEMPLATE_RECOMMENDED_MUSIC.goal).toMatchObject({ volume: 0.7, duck: false });
    expect(TEMPLATE_RECOMMENDED_MUSIC.training).toMatchObject({ volume: 0.55 });
    expect(TEMPLATE_RECOMMENDED_MUSIC.potm).toMatchObject({ volume: 0.6, duck: false, fadeInMs: 300, fadeOutMs: 1500, startMs: 0 });
  });

  it("looks Replay's keys up in order and drops keys the library lacks", () => {
    expect(builtInTemplateMusic("goal", lib)?.trackIds).toEqual([10, 11, 12]);
    expect(builtInTemplateMusic("goal", lib.filter((t) => t.trackId !== 11))?.trackIds).toEqual([10, 12]);
    expect(builtInTemplateMusic("nope", lib)).toBeNull();
  });

  it("lets an admin's choice win, skips hidden tracks and falls back to the mood when none is left", () => {
    const override = { trackIds: [12, 99, 10], volume: 0.4, duck: true, fadeInMs: 0, fadeOutMs: 800, startMs: 4000 };
    expect(effectiveTemplateMusic("goal", null, lib)).toMatchObject({ trackIds: [10, 11, 12], volume: 0.7, customised: false, fallback: false });
    expect(effectiveTemplateMusic("goal", override, lib)).toMatchObject({ trackIds: [12, 10], volume: 0.4, duck: true, startMs: 4000, customised: true });
    // Every recommended track hidden: the first track of the template's mood stands in, with its settings.
    expect(effectiveTemplateMusic("goal", { ...override, trackIds: [99] }, lib)).toMatchObject({ trackIds: [10], volume: 0.4, fallback: true });
    expect(effectiveTemplateMusic("talk", null, lib.filter((t) => t.key !== "cc0/chill-lofi"))).toMatchObject({ trackIds: [], fallback: false });
    // An admin who saved no tracks chose no music.
    expect(effectiveTemplateMusic("goal", { ...override, trackIds: [] }, lib)).toMatchObject({ trackIds: [], customised: true, fallback: false });
    expect(recommendationSceneMusic(effectiveTemplateMusic("goal", override, lib)))
      .toEqual({ trackId: 12, volume: 0.4, startMs: 4000, fadeInMs: 0, fadeOutMs: 800, duck: true });
    expect(recommendationSceneMusic(effectiveTemplateMusic("goal", { ...override, trackIds: [] }, lib))).toBeNull();
  });

  it("checks an admin's template music", () => {
    const ok = { trackIds: [3, 1], volume: 0.5, duck: false, fadeInMs: 300, fadeOutMs: 1500, startMs: 2500.4 };
    expect(parseTemplateMusicInput(ok)).toEqual({ ok: true, value: { ...ok, startMs: 2500 } });
    expect(parseTemplateMusicInput({ ...ok, trackIds: [] }).ok).toBe(true);
    const field = (body: unknown) => (parseTemplateMusicInput(body) as { field?: string }).field;
    expect(field({ ...ok, trackIds: [1, 2, 3, 4, 5, 6] })).toBe("trackIds");
    expect(field({ ...ok, trackIds: [1, 1] })).toBe("trackIds");
    expect(field({ ...ok, trackIds: [1.5] })).toBe("trackIds");
    expect(field({ ...ok, trackIds: "1" })).toBe("trackIds");
    expect(field({ ...ok, volume: 1.2 })).toBe("volume");
    expect(field({ ...ok, volume: "0.5" })).toBe("volume");
    expect(field({ ...ok, duck: "yes" })).toBe("duck");
    expect(field({ ...ok, fadeInMs: -1 })).toBe("fadeInMs");
    expect(field({ ...ok, fadeOutMs: 60_000 })).toBe("fadeOutMs");
    expect(field({ ...ok, startMs: 11 * 60_000 })).toBe("startMs");
    expect(field(null)).toBe("trackIds");
  });

  it("uses a recommended track with the template's settings, or keeps the owner's", () => {
    const rec = { trackIds: [5, 6], volume: 0.25, duck: true, fadeInMs: 1000, fadeOutMs: 1500, startMs: 3000 };
    expect(recommendedMusicChange(undefined, rec, 6)).toEqual({ trackId: 6, volume: 0.25, startMs: 3000, fadeInMs: 1000, fadeOutMs: 1500, duck: true });
    expect(recommendedMusicChange({ trackKey: "replay/old", volume: 0.9, duck: false }, rec, 5)).toEqual({ trackId: 5, volume: 0.9, duck: false, startMs: 3000 });
  });
});

describe("waveform and start point", () => {
  it("resamples peaks to any number of bars, never quite flat", () => {
    const peaks = Array.from({ length: 200 }, (_, i) => (i % 10) / 10);
    const bars = waveformBars(peaks, 50);
    expect(bars).toHaveLength(50);
    expect(Math.max(...bars)).toBeCloseTo(0.9);
    expect(Math.min(...waveformBars(new Array(200).fill(0), 20))).toBe(0.06);
    expect(waveformBars([], 5)).toEqual(new Array(5).fill(0.08));
  });

  it("moves the window by where it was grabbed, or jumps to a tap outside it", () => {
    // 60 s track, 15 s scene, window at 10–25 s.
    expect(grabInWindow(20 / 60, 10_000, 60_000, 15_000)).toBe(10_000);
    expect(grabInWindow(40 / 60, 10_000, 60_000, 15_000)).toBeNull();
    // Grabbed 10 s into the window and dragged to 30 s: the window starts at 20 s.
    expect(dragMusicStart(30 / 60, 10_000, 60_000, 15_000)).toBe(20_000);
    // Tap at 50 s: as late as a whole scene still fits.
    expect(dragMusicStart(50 / 60, 0, 60_000, 15_000)).toBe(45_000);
    expect(dragMusicStart(-1, 0, 60_000, 15_000)).toBe(0);
    expect(windowOnTrack(10_000, 60_000, 15_000)).toEqual({ left: 1 / 6, width: 0.25, loops: false });
    expect(windowOnTrack(0, 10_000, 15_000)).toEqual({ left: 0, width: 1, loops: true });
  });

  it("draws the timeline lane from the start point, looping", () => {
    const peaks = Array.from({ length: 100 }, (_, i) => (i < 50 ? 0.2 : 1));
    // Starting halfway: the loud half first, then (looped) the quiet half.
    const lane = laneBars(peaks, 10_000, 5000, 10_000, 10);
    expect(lane.slice(0, 5).every((v) => v === 1)).toBe(true);
    expect(lane.slice(5).every((v) => v === 0.2)).toBe(true);
  });

  it("finds the scene's track by id, or by bundled key for older designs", () => {
    const tracks = [{ trackId: 1, key: "replay/a" }, { trackId: 2, key: null }];
    expect(sceneTrack({ trackId: 2 }, tracks)?.trackId).toBe(2);
    expect(sceneTrack({ trackKey: "replay/a" }, tracks)?.trackId).toBe(1);
    expect(sceneTrack({ trackId: 9 }, tracks)).toBeNull();
    expect(sceneTrack(undefined, tracks)).toBeNull();
  });
});

describe("preview playback follows the scene clock", () => {
  const base = { sceneMs: 15_000, trackMs: 40_000, startMs: 10_000 };

  it("plays, pauses and seeks only when it drifts", () => {
    expect(musicSyncAction({ ...base, playing: true, t: 2000, audioSec: 12.1, audioPaused: true })).toEqual({ seekSec: null, play: true, pause: false });
    expect(musicSyncAction({ ...base, playing: true, t: 2000, audioSec: 13, audioPaused: false })).toEqual({ seekSec: 12, play: false, pause: false });
    expect(musicSyncAction({ ...base, playing: false, t: 2000, audioSec: 12, audioPaused: false })).toEqual({ seekSec: null, play: false, pause: true });
    // Scrubbing while paused lands exactly.
    expect(musicSyncAction({ ...base, playing: false, t: 7000, audioSec: 12, audioPaused: true }).seekSec).toBe(17);
  });

  it("goes back to the start point when the scene loops, but lets the track wrap by itself", () => {
    // Scene restarted at 0 while the audio was at 25 s: back to 10 s.
    expect(musicSyncAction({ ...base, playing: true, t: 0, audioSec: 25, audioPaused: false }).seekSec).toBe(10);
    // A 10 s track looping on its own: 9.95 s vs wanted 0.05 s is not drift.
    expect(musicSyncAction({ sceneMs: 15_000, trackMs: 10_000, startMs: 0, playing: true, t: 10_050, audioSec: 9.95, audioPaused: false }).seekSec).toBeNull();
  });

  it("sets the volume from the scene's volume, the fades and the track's loudness", () => {
    const m = { volume: 0.5, fadeInMs: 1000, fadeOutMs: 1000 };
    expect(previewVolume(m, 10_000, 5000, -16)).toBeCloseTo(0.5);
    expect(previewVolume(m, 10_000, 500, -16)).toBeCloseTo(0.25);
    // A loud master (-10 LUFS) is turned down 6 dB, as the export does.
    expect(previewVolume(m, 10_000, 5000, -10)).toBeCloseTo(0.5 * 10 ** (-6 / 20));
    expect(previewVolume({ volume: 1 }, 10_000, 5000, -30)).toBe(1);
  });
});

describe("music strings", () => {
  it("has every English line in Ammani Arabic", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(creativeMusicStrings.ar)).toEqual(keys(creativeMusicStrings.en));
    expect(keys(creativeMusicStrings.ar.moods)).toEqual(keys(creativeMusicStrings.en.moods));
    expect(creativeMusicStrings.ar.rights).not.toBe(creativeMusicStrings.en.rights);
  });
});

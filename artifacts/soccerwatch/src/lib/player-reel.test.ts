import { describe, expect, it } from "vitest";
import {
  REEL_CLIP_MAX_MS,
  REEL_INTRO_MS,
  REEL_MAX_MS,
  REEL_OUTRO_MS,
  PlayerReelError,
  buildPlayerReelScene,
  reelClipDurations,
  sceneSchema,
  type PlayerReelInput,
} from "@workspace/api-zod";
import type { PlayerStatsRow, AcademyPlayerStats } from "./academy-matches-api";
import { defaultStats, metaLine, reelClipOf, reelStat, reelStatValues } from "./player-reel";

const stats = (o: Partial<AcademyPlayerStats>): AcademyPlayerStats => ({
  playerId: 1, rosterPlayerId: "p", minutes: 40, distanceKm: 3, topSpeedKmh: 20, touches: 30, passesTried: 10, passesCompleted: 8,
  passesReceived: 5, dribbles: 2, dribblesWon: 1, dribblesLost: 1, shots: 2, goals: 1, ...o,
});
const row = (playerId: number, sessionId: number, o: Partial<AcademyPlayerStats>): PlayerStatsRow => ({
  playerId, playerName: `P${playerId}`, squadName: "U12", jerseyNumber: playerId, sessionId, startsAt: `2026-10-0${sessionId}T15:00:00Z`,
  type: "match", opponent: `Opp${sessionId}`, ownScore: 2, opponentScore: 1, published: true, stats: stats({ playerId, ...o }),
});

const input = (o: Partial<PlayerReelInput> = {}): PlayerReelInput => ({
  format: "story",
  locale: "en",
  player: { name: "Omar", number: 10, meta: "Age 12 · Winger" },
  photos: [{ type: "player-photo", photoId: 1 }, { type: "player-photo", photoId: 2 }],
  introStats: [{ label: "Goals", value: "6" }, { label: "Rating", value: "7.4" }],
  clips: [
    { src: { type: "recording", recordingId: 5, fromMs: 60_000, toMs: 70_000 }, durationMs: 10_000, framing: { zoom: 0.45, keys: [[0, 0.3, 0.5]] }, label: "Goal · 12'" },
    { src: { type: "clip", clipId: 9 }, durationMs: 6_000, label: "" },
  ],
  outroTitle: "6 matches",
  outroStats: [{ label: "Rating", value: "7.4" }, { label: "Goals", value: "6" }, { label: "Top speed", value: "24 km/h" }],
  ...o,
});

describe("player reel scene", () => {
  it("is an intro, the clips back to back, then the stats, and a valid scene", () => {
    const scene = buildPlayerReelScene(input());
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    expect(scene.durationMs).toBe(REEL_INTRO_MS + 16_000 + REEL_OUTRO_MS);
    const videos = scene.layers.filter((l) => l.kind === "video");
    expect(videos.map((v) => [v.startMs, v.endMs])).toEqual([[REEL_INTRO_MS, REEL_INTRO_MS + 10_000], [REEL_INTRO_MS + 10_000, REEL_INTRO_MS + 16_000]]);
    expect(videos[0]).toMatchObject({ framing: { zoom: 0.45 }, trimInMs: 0, trimOutMs: 10_000, muted: true });
    expect(videos[1]).not.toHaveProperty("framing");
    // Two photos split the intro; the number, name and both headline stats are there.
    const photos = scene.layers.filter((l) => l.id.startsWith("intro-photo-") && l.kind === "image");
    expect(photos).toHaveLength(2);
    const texts = scene.layers.filter((l) => l.kind === "text").map((l) => (l as { text: string }).text);
    expect(texts).toEqual(expect.arrayContaining(["10", "Omar", "Age 12 · Winger", "6", "7.4", "Goal · 12'", "#10  Omar", "6 matches", "24 km/h"]));
    // Only the first clip has a caption (the second's is empty).
    expect(scene.layers.filter((l) => l.id.startsWith("clip-label-"))).toHaveLength(1);
    // Every layer sits inside the scene's time.
    for (const l of scene.layers) expect((l.endMs ?? 0) <= scene.durationMs!).toBe(true);
  });

  it("shows the crest instead of photos, and leaves out what isn't there", () => {
    const scene = buildPlayerReelScene(input({ photos: [], player: { name: null, number: null, meta: "" }, introStats: [], outroStats: [], outroTitle: "" }));
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    expect(scene.layers.some((l) => l.id === "intro-crest-big")).toBe(true);
    expect(scene.layers.some((l) => l.id === "outro-crest")).toBe(true);
    expect(scene.layers.some((l) => l.id === "intro-number" || l.id === "intro-name" || l.id.startsWith("clip-tag-"))).toBe(false);
  });

  it("works in every format and in Arabic", () => {
    for (const format of ["story", "post", "wide"] as const) {
      const scene = buildPlayerReelScene(input({ format, locale: "ar" }));
      expect(sceneSchema.safeParse(scene).success, format).toBe(true);
      expect(scene.locale).toBe("ar");
    }
  });

  it("keeps the reel under three minutes and needs at least one clip", () => {
    const many = Array.from({ length: 8 }, () => ({ durationMs: 60_000 }));
    const d = reelClipDurations(many);
    expect(d.every((x) => x <= REEL_CLIP_MAX_MS)).toBe(true);
    const long = Array.from({ length: 8 }, () => ({ src: { type: "clip" as const, clipId: 1 }, durationMs: 20_000 }));
    const scene = buildPlayerReelScene(input({ clips: long }));
    expect(scene.durationMs!).toBeLessThanOrEqual(REEL_MAX_MS);
    expect(() => buildPlayerReelScene(input({ clips: [] }))).toThrow(PlayerReelError);
    expect(() => buildPlayerReelScene(input({ clips: [...long, ...long] }))).toThrow(PlayerReelError);
  });

  it("carries the soundtrack, ducked under the pitch sound when it is kept", () => {
    const music = { trackId: 3, volume: 0.6 };
    expect(buildPlayerReelScene(input({ music })).music).toMatchObject({ trackId: 3 });
    expect(buildPlayerReelScene(input({ music, footageSound: true })).music).toMatchObject({ trackId: 3, duck: true });
    expect(buildPlayerReelScene(input({ footageSound: true })).layers.find((l) => l.kind === "video")).toMatchObject({ muted: false });
  });
});

describe("reel numbers", () => {
  const rows = [
    row(1, 1, { goals: 2, minutes: 40, topSpeedKmh: 22 }),
    row(2, 1, { goals: 0 }),
    row(1, 2, { goals: 1, minutes: 30, topSpeedKmh: 25 }),
    row(2, 2, { goals: 3 }),
    // A rating needs three ranked players in the match.
    row(3, 1, { goals: 0, touches: 5 }),
    row(3, 2, { goals: 0, touches: 5 }),
  ];

  it("sums, averages and takes the best over his matches, or one match", () => {
    const season = reelStatValues(rows, 1, "season");
    expect(season.matches).toBe(2);
    expect(season.values.goals).toBe(3);
    expect(season.values.minutes).toBe(70);
    expect(season.values.topSpeed).toBe(25);
    expect(season.values.rating).not.toBeNull();
    const one = reelStatValues(rows, 1, 2);
    expect(one.matches).toBe(1);
    expect(one.values.goals).toBe(1);
    expect(reelStatValues(rows, 9, "season").values.goals).toBeNull();
  });

  it("formats each stat with its unit and picks defaults that have values", () => {
    const copy = { rating: "Rating", minutes: "Min", distance: "Distance", topSpeed: "Top speed", touches: "Touches", passes: "Passes", accuracy: "Pass %", dribbles: "Dribbles won", shots: "Shots", goals: "Goals", km: "km", kmh: "km/h" };
    expect(reelStat("topSpeed", 24.56, copy, "en")).toEqual({ label: "Top speed", value: "24.6 km/h" });
    expect(reelStat("rating", 7, copy, "en")).toEqual({ label: "Rating", value: "7.0" });
    expect(reelStat("goals", null, copy, "en")).toBeNull();
    expect(defaultStats({ rating: null, minutes: 1, distance: null, topSpeed: 2, touches: 3, passes: null, accuracy: null, dribbles: null, shots: null, goals: 4 }, ["goals", "rating", "topSpeed", "touches"], 2)).toEqual(["goals", "topSpeed"]);
  });

  it("writes the intro line from what is known and shown", () => {
    const age = (n: number) => `Age ${n}`;
    expect(metaLine({ age: 12, position: "Winger", squad: "U13" }, { age: true, position: true, squad: true }, age)).toBe("Age 12 · Winger · U13");
    expect(metaLine({ age: null, position: "Winger", squad: "U13" }, { age: true, position: false, squad: true }, age)).toBe("U13");
  });

  it("turns a saved clip on a recording into that window, framed", () => {
    const pick = { key: "c:9", src: { type: "clip" as const, clipId: 9 }, durationMs: 7000, label: "Clip" };
    const framed = reelClipOf(pick, { framing: { zoom: 0.45, keys: [[0, 0.4, 0.5]] }, source: "player", window: { recordingId: 4, fromMs: 1000, toMs: 9000 } });
    expect(framed).toMatchObject({ src: { type: "recording", recordingId: 4, fromMs: 1000, toMs: 9000 }, durationMs: 8000, framing: { zoom: 0.45 } });
    expect(reelClipOf(pick, null)).toMatchObject({ src: { type: "clip", clipId: 9 }, durationMs: 7000, framing: null });
    const centred = reelClipOf({ ...pick, src: { type: "recording", recordingId: 4, fromMs: 0, toMs: 5000 } }, { framing: { zoom: 0.45, keys: [[0, 0.5, 0.5]] }, source: "centre" });
    expect(centred.framing).toBeNull();
  });
});

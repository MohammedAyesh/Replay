import type { TrackingManifest } from "@workspace/api-client-react";
import { MAX_KITS, MIN_KIT_MEMBERS, rgbToHsl, splitKits, kitColourKey, type KitSplit } from "@/lib/claim-kit";
import { featureFromJpeg, lab8ToRgb } from "./appearance";
import { applyPeople, buildChunk, groupChunk, groupProfileOf, measureChunk, type BundleChunkInput, type PeopleSidecar } from "./build";
import type { Chunk, Game } from "./model";
import { complement, union } from "./model";
import { pitchFromManifest } from "./pitch";

/**
 * Loading the game: the manifest becomes the Game, each bundle segment becomes
 * a Chunk (built, measured, grouped, split into kits) the first time the claim
 * needs it.
 */

export function gameFromManifest(manifest: TrackingManifest, inPlaySpans: Array<[number, number]>): Game {
  const chunks = manifest.segments
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ k: s.index, start: s.startSeconds, dur: Math.max(0, s.endSeconds - s.startSeconds) }));
  const total = chunks.length
    ? Math.max(...chunks.map((c) => c.start + c.dur))
    : manifest.duration;
  const inplay = inPlaySpans.length ? union(inPlaySpans) : [[0, total] as [number, number]];
  return {
    chunks,
    total,
    srcW: manifest.width,
    srcH: manifest.height,
    frameRate: manifest.frameRate > 0 ? manifest.frameRate : 20,
    videoStartSeconds: manifest.videoStartSeconds || 0,
    matchOffset: manifest.matchOffset || 0,
    inplay,
    outOfPlay: inPlaySpans.length ? stoppages(complement(inplay, total), total) : [],
    pitch: pitchFromManifest(manifest.pitchModel ?? null),
  };
}

/** Out-of-play stretches closer than this are one stoppage. */
export const STOP_MERGE_S = 20;
/** Shorter stoppages inside the game are restarts, not something to review. */
export const STOP_MIN_S = 60;

/**
 * The in-play detector marks every dead ball (a throw-in, a goal kick, the
 * ball fetched from behind the wall) and a two-hour game has ~200 of them.
 * The first screen asks people to check the marking, so it shows what the
 * prototype showed: real stoppages. Dead balls a few seconds apart merge,
 * and only stoppages of a minute or more are kept, plus any dead time at the
 * very start or end (the warm-up, the walk off).
 */
export function stoppages(out: Array<[number, number]>, total: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of out) {
    if (b - a < 5) continue;
    const last = merged[merged.length - 1];
    if (last && a - last[1] < STOP_MERGE_S) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged.filter(([a, b]) => b - a >= STOP_MIN_S || a <= 0.5 || b >= total - 0.5);
}

export type ChunkExtras = {
  /** kit split over this chunk's groups; group.team holds the kit key */
  kits: KitSplit;
};

export type LoadedChunk = Chunk & ChunkExtras & { grouping: "pipeline" | "browser" };

/**
 * Seed groups from the identity board's rows: tracks it already put together
 * stay together.
 */
function seedFromIdentities(manifest: TrackingManifest, trackIds: Set<string>): string[][] {
  return (manifest.identities ?? [])
    .map((identity) => [...new Set(identity.parts.map((p) => p.trackId).filter((id) => trackIds.has(id)))])
    .filter((ids) => ids.length > 1);
}

export async function loadChunkData(opts: {
  manifest: TrackingManifest;
  k: number;
  fetchSegment: (index: number) => Promise<{
    startSeconds: number;
    endSeconds: number;
    tracks: BundleChunkInput["tracks"];
    crossings: BundleChunkInput["crossings"];
  }>;
  fetchSprites: (index: number) => Promise<BundleChunkInput["sprites"]>;
  /** the pipeline's grouping, when the bundle carries it (null otherwise) */
  fetchPeople?: (index: number) => Promise<PeopleSidecar | null>;
}): Promise<LoadedChunk> {
  const { manifest, k } = opts;
  const meta = manifest.segments.find((s) => s.index === k);
  if (!meta) throw new Error(`No segment ${k}`);
  const [segment, sprites, people] = await Promise.all([
    opts.fetchSegment(k),
    opts.fetchSprites(k).catch(() => ({})),
    opts.fetchPeople ? opts.fetchPeople(k).catch(() => null) : Promise.resolve(null),
  ]);
  const chunk = buildChunk({
    k,
    start: meta.startSeconds,
    dur: Math.max(0, meta.endSeconds - meta.startSeconds),
    frameRate: manifest.frameRate,
    tracks: segment.tracks,
    crossings: segment.crossings,
    sprites,
  });
  if (people?.groups?.length) {
    // The pipeline read every track at full resolution and grouped them the
    // prototype's way; crops only fill pieces it had no reading for.
    applyPeople(chunk, people);
    await measureChunk(chunk, featureFromJpeg);
  } else {
    await measureChunk(chunk, featureFromJpeg);
    groupChunk(chunk, seedFromIdentities(manifest, new Set(Object.keys(chunk.pieces))));
  }
  const pipelineKits = people?.groups?.length ? kitsFromPeople(chunk, people) : null;
  if (pipelineKits) return Object.assign(chunk, { kits: pipelineKits, grouping: "pipeline" as const });
  const kits = splitKits(
    chunk.groups.map((g) => {
      const p = groupProfileOf(chunk, g.members);
      if (!p) return { id: g.cid, colour: null };
      const [r, gr, b] = lab8ToRgb(p.to[0], p.to[1], p.to[2]);
      return { id: g.cid, colour: rgbToHsl(r, gr, b) };
    }),
  );
  if (kits.separated) {
    for (const kit of kits.groups) for (const cid of kit.memberIds) if (chunk.byCid[cid]) chunk.byCid[cid].team = kit.key;
  }
  return Object.assign(chunk, { kits, grouping: people?.groups?.length ? "pipeline" as const : "browser" as const });
}

/**
 * The pipeline already sorted every person into a kit (dark, light, bib, a
 * colour) from full-resolution readings of every detection, so its labels
 * are the kit tiles. The browser's split, on six crops a person, only runs
 * when the bundle has no grouping of its own. Labels are the same words in
 * every chunk, so the kit picked once carries on through the game.
 */
export function kitsFromPeople(chunk: Chunk, people: PeopleSidecar): KitSplit | null {
  const label = new Map(people.groups.map((g) => [g.cid, g] as const));
  const byKit = new Map<string, { ids: string[]; secs: number; lab: [number, number, number]; w: number }>();
  for (const g of chunk.groups) {
    const src = label.get(g.cid);
    const key = src?.team;
    if (!key) continue;
    g.team = key;
    const k = byKit.get(key) ?? { ids: [], secs: 0, lab: [0, 0, 0], w: 0 };
    k.ids.push(g.cid);
    k.secs += g.dur;
    if (src.torso) {
      for (let i = 0; i < 3; i++) k.lab[i] += src.torso[i] * g.dur;
      k.w += g.dur;
    }
    byKit.set(key, k);
  }
  const kept = [...byKit.entries()]
    .filter(([, k]) => k.ids.length >= MIN_KIT_MEMBERS)
    .sort((a, b) => b[1].secs - a[1].secs)
    .slice(0, MAX_KITS);
  if (kept.length < 2) return null;
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  const groups = kept.map(([key, k]) => {
    const [r, g, b] = k.w ? lab8ToRgb(k.lab[0] / k.w, k.lab[1] / k.w, k.lab[2] / k.w) : [128, 128, 128];
    return { key, swatch: `#${hex(r)}${hex(g)}${hex(b)}`, memberIds: k.ids };
  });
  const covered = new Set(groups.flatMap((g) => g.memberIds));
  return {
    separated: true,
    groups,
    unreadableIds: chunk.groups.filter((g) => !covered.has(g.cid)).map((g) => g.cid),
    meanSaturation: 0,
    coverage: chunk.groups.length ? covered.size / chunk.groups.length : 0,
  };
}

/** A kit's colour name key for the copy's `kit.names`. */
export const kitNameKey = (swatch: string) => kitColourKey(swatch);

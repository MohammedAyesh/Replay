import type { TrackingManifest } from "@workspace/api-client-react";
import { rgbToHsl, splitKits, kitColourKey, type KitSplit } from "@/lib/claim-kit";
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
    outOfPlay: inPlaySpans.length ? complement(inplay, total).filter(([a, b]) => b - a >= 5) : [],
    pitch: pitchFromManifest(manifest.pitchModel ?? null),
  };
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

/** A kit's colour name key for the copy's `kit.names`. */
export const kitNameKey = (swatch: string) => kitColourKey(swatch);

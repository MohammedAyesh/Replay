import { useCallback, useEffect, useState } from "react";
import { resolveSource, type BallTrailSample, type CreativeData, type MediaSource, type Scene } from "@workspace/api-zod";
import { fetchFraming, type FramingSource } from "@/lib/creative-framing";

type ConcreteSource = Exclude<MediaSource, { type: "binding" }>;

/** Ball paths already fetched, by academy and source (a design reopened doesn't ask again). */
const cache = new Map<string, BallTrailSample[]>();

const keyOf = (academyId: number, src: FramingSource) => `${academyId}:${JSON.stringify(src)}`;

function framingSourceOf(src: ConcreteSource | null): FramingSource | null {
  if (src?.type === "recording") return { type: "recording", recordingId: src.recordingId, fromMs: src.fromMs, toMs: src.toMs };
  // A clip may play as its saved file, already cut to its own camera: the trail would not sit on it.
  return null;
}

/**
 * The editor's preview of the red ball trail: the ball path of every footage
 * layer that has the trail on, on its video's own clock (the framing answer's
 * `ball`, seconds from the source's start). Returns a lookup for SceneCanvas.
 */
export function useBallTrails(academyId: number, scene: Scene, data: CreativeData) {
  const [, setVersion] = useState(0);
  const wanted = scene.layers
    .filter((l) => l.kind === "video" && l.ballTrail)
    .map((l) => (l.kind === "video" ? framingSourceOf(resolveSource(l.src, data)) : null))
    .filter((s): s is FramingSource => s !== null);
  const missing = wanted.filter((s) => !cache.has(keyOf(academyId, s)));
  const missingKey = JSON.stringify(missing);

  useEffect(() => {
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map(async (src) => {
      const answer = await fetchFraming(academyId, src).catch(() => null);
      cache.set(keyOf(academyId, src), answer?.ball ?? []);
    })).then(() => { if (!cancelled) setVersion((v) => v + 1); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academyId, missingKey]);

  return useCallback((src: ConcreteSource) => {
    const f = framingSourceOf(src);
    return f ? cache.get(keyOf(academyId, f)) ?? null : null;
  }, [academyId]);
}

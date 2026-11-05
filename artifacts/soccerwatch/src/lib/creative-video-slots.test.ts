import { describe, expect, it } from "vitest";
import { buildTemplateScene, type Scene, type SceneLayer } from "@workspace/api-zod";
import { layerWindow, retimeSlot, slotVideo, videoSlots } from "./creative-editor-state";

const win = (scene: Scene, id: string) => layerWindow(scene.layers.find((l) => l.id === id)!, scene.durationMs!);
const layer = (scene: Scene, id: string) => scene.layers.find((l) => l.id === id) as Extract<SceneLayer, { kind: "video" }>;

describe("video slots", () => {
  it("numbers a two-video template's slots in timeline order: Video 1 then Video 2", () => {
    const scene = buildTemplateScene("field-versus", "broadcast", "story", "en");
    const slots = videoSlots(scene);
    expect(slots.map((s) => [s.n, s.path])).toEqual([[1, "media"], [2, "more.0"]]);
    expect(slots[0]!.layerIds.sort()).toEqual(["a-again", "a-full", "a-split"]);
    expect(slots[0]!.anchorId).toBe("a-full");
    expect(slots[1]!.anchorId).toBe("b-full");
  });

  it("numbers top 5 by when each clip plays, not by its data path", () => {
    const scene = buildTemplateScene("field-top5", "broadcast", "story", "en");
    expect(videoSlots(scene).map((s) => s.path)).toEqual(["more.3", "more.2", "more.1", "more.0", "media"]);
  });

  it("stretches the compare template around Video 1's real length: B and the vote move, captions on A stretch", () => {
    const scene = buildTemplateScene("field-versus", "broadcast", "story", "en");
    const D = scene.durationMs!;
    const a = win(scene, "a-full"), b = win(scene, "b-full"), meta = win(scene, "a-meta"), split = win(scene, "a-split");
    const longer = retimeSlot(scene, "media", (a.end - a.start) + 4000);
    expect(longer.durationMs).toBe(D + 4000);
    expect(win(longer, "a-full")).toEqual({ start: a.start, end: a.end + 4000 });
    expect(win(longer, "b-full")).toEqual({ start: b.start + 4000, end: b.end + 4000 });
    expect(win(longer, "a-meta")).toEqual({ start: meta.start, end: meta.end + 4000 });
    expect(win(longer, "a-split")).toEqual(split);
    // The question with the vote is still on at the very end.
    expect(win(longer, "question-2").end).toBe(longer.durationMs);
    const shorter = retimeSlot(scene, "media", (a.end - a.start) - 2000);
    expect(shorter.durationMs).toBe(D - 2000);
    expect(win(shorter, "b-full").start).toBe(b.start - 2000);
  });

  it("keeps a one-video template's end card on its last seconds when the clip is longer", () => {
    const scene = buildTemplateScene("goal", "broadcast", "story", "en");
    const D = scene.durationMs!;
    const slot = videoSlots(scene)[0]!;
    const ends = scene.layers.filter((l) => l.id.startsWith("end")).map((l) => [l.id, win(scene, l.id)] as const);
    expect(ends.length).toBeGreaterThan(0);
    const next = slotVideo(scene, slot.path, 24_000);
    expect(next.durationMs).toBe(24_000);
    for (const [id, w] of ends) expect(win(next, id)).toEqual({ start: w.start + (24_000 - D), end: Math.min(w.end + (24_000 - D), 24_000) });
    expect(layer(next, slot.anchorId).trimOutMs).toBe(24_000);
  });

  it("gives two angles at once the length of the longer one", () => {
    const scene = buildTemplateScene("goalduo", "broadcast", "story", "en");
    const slots = videoSlots(scene);
    expect(slots.map((s) => s.path)).toEqual(["media", "more.0"]);
    const a = slotVideo(scene, "media", 20_000);
    expect(a.durationMs).toBe(20_000);
    const b = slotVideo(a, "more.0", 12_000);
    expect(b.durationMs).toBe(20_000);
    expect(layer(b, slots[1]!.anchorId).trimOutMs).toBe(12_000);
  });

  it("leaves the design alone without a length, and a scene without slots", () => {
    const scene = buildTemplateScene("field-versus", "broadcast", "story", "en");
    expect(slotVideo(scene, "media", null).durationMs).toBe(scene.durationMs);
    const still = buildTemplateScene("fulltime", "broadcast", "post", "en");
    expect(videoSlots(still)).toEqual([]);
    expect(retimeSlot(still, "media", 5000)).toBe(still);
  });
});

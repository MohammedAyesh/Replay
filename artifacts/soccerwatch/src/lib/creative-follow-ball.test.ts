import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ answer: null as unknown, fail: false, delayMs: 0, seen: [] as unknown[] }));
vi.mock("@/lib/academy-studio-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/academy-studio-api")>()),
  call: vi.fn(async (_path: string, init: RequestInit) => {
    calls.seen.push(JSON.parse(String(init.body)));
    if (calls.delayMs) await new Promise((r) => setTimeout(r, calls.delayMs));
    if (calls.fail) throw new Error("down");
    return calls.answer;
  }),
}));

import { followTheBall } from "./creative-framing";
import { setPlate } from "./creative-editor-state";
import { mainClipWindow } from "@/components/creative-hub/editor/style-panel";
import type { Scene, SceneLayer } from "@workspace/api-zod";

afterEach(() => { calls.answer = null; calls.fail = false; calls.delayMs = 0; calls.seen = []; });

describe("a picked clip follows the ball", () => {
  const ball = { zoom: 0.45, keys: [[0, 0.3, 0.5], [400, 0.32, 0.5]], mode: "ball" };
  it("asks for the clip's or the moment's camera and takes the ball's", async () => {
    calls.answer = { framing: ball, source: "ball", coverage: 0.9 };
    expect(await followTheBall(1, { type: "clip", clipId: 4 })).toEqual(ball);
    expect(await followTheBall(1, { type: "recording", recordingId: 2, fromMs: 1000, toMs: 9000 })).toEqual(ball);
    expect(calls.seen).toEqual([{ src: { type: "clip", clipId: 4 } }, { src: { type: "recording", recordingId: 2, fromMs: 1000, toMs: 9000 } }]);
  });
  it("leaves the footage as it is for the middle, a failure, a slow answer or a non-match picture", async () => {
    calls.answer = { framing: { zoom: 0.45, keys: [[0, 0.5, 0.52]], mode: "manual" }, source: "centre", coverage: 0 };
    expect(await followTheBall(1, { type: "clip", clipId: 4 })).toBeNull();
    calls.fail = true;
    expect(await followTheBall(1, { type: "clip", clipId: 4 })).toBeNull();
    calls.fail = false;
    calls.answer = { framing: ball, source: "ball", coverage: 1 };
    calls.delayMs = 200;
    expect(await followTheBall(1, { type: "clip", clipId: 4 }, 20)).toBeNull();
    expect(await followTheBall(1, { type: "upload", mediaId: 3 })).toBeNull();
  });
});

describe("background fades", () => {
  const plate = { id: "plate", kind: "image", src: { type: "artwork", key: "bg/broadcast/1" }, x: 0, y: 0, w: 1080, h: 1920 } as SceneLayer;
  const video = { id: "clip", kind: "video", src: { type: "binding", path: "media" }, x: 0, y: 400, w: 1080, h: 1080, startMs: 2500, endMs: 12000 } as SceneLayer;
  const scene = { v: 1, format: "story", durationMs: 15000, background: "#000000", locale: "en", layers: [plate, video] } as Scene;

  it("sets and clears the plate's fades and its dip", () => {
    const faded = setPlate(scene, { fadeInMs: 800, fadeOutMs: 1200 });
    expect(faded.layers[0]).toMatchObject({ fadeInMs: 800, fadeOutMs: 1200 });
    const dipped = setPlate(faded, { dip: { fromMs: 2500, toMs: 12000, fadeMs: 600 } });
    expect(dipped.layers[0]).toMatchObject({ dip: { fromMs: 2500, toMs: 12000, fadeMs: 600 } });
    const off = setPlate(setPlate(dipped, { dip: null }), { fadeInMs: 0 });
    expect(off.layers[0].dip).toBeUndefined();
    expect(off.layers[0].fadeInMs).toBeUndefined();
    expect(off.layers[0].fadeOutMs).toBe(1200);
  });

  it("steps aside for the template's clip", () => {
    expect(mainClipWindow(scene)).toEqual({ fromMs: 2500, toMs: 12000 });
    expect(mainClipWindow({ ...scene, layers: [plate] })).toBeNull();
  });
});

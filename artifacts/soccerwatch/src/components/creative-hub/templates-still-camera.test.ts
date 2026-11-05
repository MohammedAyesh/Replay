import { describe, expect, it } from "vitest";
import { buildTemplateScene, type Framing } from "@workspace/api-zod";
import { withStillCameras } from "./templates";

const cam: Framing = { zoom: 0.45, keys: [[0, 0.2, 0.5]], mode: "ball" };
const still = { type: "frame" as const, recordingId: 7, atMs: 61_000 };

describe("match stills keep up with the ball (2026-11-05: the stitch and an empty centre circle)", () => {
  it("gives the {{media}} footage slots the still's camera, and leaves a slot that has one", () => {
    const scene = buildTemplateScene("field-booking-clip", "field", "story", "en");
    const out = withStillCameras(scene, { media: still }, new Map([[JSON.stringify(still), cam]]));
    const slots = out.layers.filter((l) => l.kind === "video" && l.src.type === "binding" && l.src.path === "media");
    expect(slots.length).toBeGreaterThan(0);
    for (const l of slots) expect(l.kind === "video" && l.framing).toEqual(cam);
    expect(withStillCameras(out, { media: still }, new Map([[JSON.stringify(still), { ...cam, keys: [[0, 0.9, 0.5]] }]]))).toBe(out);
  });
  it("changes nothing for footage that isn't a still, or with no camera", () => {
    const scene = buildTemplateScene("field-booking-clip", "field", "story", "en");
    expect(withStillCameras(scene, { media: { type: "clip", clipId: 3 } }, new Map([[JSON.stringify(still), cam]]))).toBe(scene);
    expect(withStillCameras(scene, { media: still }, new Map())).toBe(scene);
  });
});

describe("number posts have no pitch behind them (2026-11-05)", () => {
  it("thank-you and milestone designs carry no footage", () => {
    for (const key of ["field-thanks", "field-milestone", "club-week", "club-milestone"]) {
      const scene = buildTemplateScene(key, key.startsWith("club") ? "club" : "field", "story", "en");
      expect(scene.layers.filter((l) => l.kind === "video"), key).toEqual([]);
    }
  });
});

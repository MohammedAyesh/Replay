import { describe, expect, it } from "vitest";
import { buildTemplateScene, type Scene } from "@workspace/api-zod";
import { photoFrom, photoVideoFrom } from "@/lib/creative-editor-state";
import { isPhotoWithMusic, isVideoProject, placementsFor, publishesAsVideo } from "./placements";

const music = { trackId: 3, volume: 0.6 };
const project = (scene: Scene, extra: Record<string, unknown> = {}) => ({
  kind: scene.durationMs ? "video" as const : "image" as const, format: scene.format, scene, outputMime: null, renderStatus: "none" as const, ...extra,
});

describe("Publish: a still with music goes out as a video", () => {
  it("a line-up post with music is a Reel (feed video), a birthday story a video story or Reel", () => {
    const lineup = photoVideoFrom(buildTemplateScene("lineup", "broadcast", "post", "en"), music);
    expect(publishesAsVideo(project(lineup))).toBe(true);
    expect(placementsFor(project(lineup))).toEqual(["reel"]);
    expect(isPhotoWithMusic(project(lineup))).toBe(true);
    const square = photoVideoFrom(buildTemplateScene("fulltime", "broadcast", "square", "en"), music);
    expect(placementsFor(project(square))).toEqual(["reel"]);
    const birthday = photoVideoFrom(buildTemplateScene("birthday", "broadcast", "story", "en"), music);
    expect(placementsFor(project(birthday))).toEqual(["story", "reel"]);
    // Download and WhatsApp hand out the MP4 once it's rendered, and say MP4 before that.
    expect(isVideoProject(project(birthday))).toBe(true);
    expect(isVideoProject(project(birthday, { outputMime: "video/mp4", renderStatus: "done" }))).toBe(true);
  });

  it("a still without music stays a photo exactly as before", () => {
    const still = buildTemplateScene("lineup", "broadcast", "post", "en");
    expect(placementsFor(project(still))).toEqual(["feed"]);
    expect(isVideoProject(project(still, { outputMime: "image/png", renderStatus: "done" }))).toBe(false);
    expect(isPhotoWithMusic(project(still))).toBe(false);
    const story = buildTemplateScene("birthday", "broadcast", "story", "en");
    expect(placementsFor(project(story))).toEqual(["story"]);
    // Back to a photo after having music: a photo again.
    const back = photoFrom(photoVideoFrom(story, music));
    expect(placementsFor(project(back))).toEqual(["story"]);
  });

  it("goes by the design, not an out-of-date render of it", () => {
    const v = photoVideoFrom(buildTemplateScene("fulltime", "broadcast", "post", "en"), music);
    // The PNG from before music was added is stale (render status none): the design is a video now.
    expect(isVideoProject(project(v, { outputMime: "image/png", renderStatus: "none" }))).toBe(true);
    // Without a scene, kind decides (the API's list rows).
    expect(placementsFor({ kind: "video", format: "post" })).toEqual(["reel"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  isPublicBunnyCollectionVideo,
  type PublicFootageContext,
} from "./publicFootage";

describe("public Bunny collection visibility", () => {
  const videoId = "8dcf10ce-86fe-45ed-9216-e7ea352d6d20";
  const title = "cam1_2026_09_26_00:00";
  const field = { id: 10, isHidden: false } as Parameters<typeof isPublicBunnyCollectionVideo>[0];

  function context(): PublicFootageContext {
    return {
      viewer: null,
      isAdmin: false,
      schedulesByField: new Map([[10, [{
        allowedDate: "2026-09-26",
        startTime: "00:00",
        endTime: "02:00",
      }]]]),
    };
  }

  function importedRecording(isVisible = true): Parameters<typeof isPublicBunnyCollectionVideo>[4][number] {
    return {
      fieldId: 10,
      isVisible,
      date: "2026-09-26",
      timeSlot: "00:00",
      videoUrl: `https://vz-example.b-cdn.net/${videoId}/playlist.m3u8`,
    } as unknown as Parameters<typeof isPublicBunnyCollectionVideo>[4][number];
  }

  it("lists a scheduled imported owner-request recording", () => {
    expect(isPublicBunnyCollectionVideo(
      field,
      videoId,
      title,
      context(),
      [importedRecording()],
    )).toBe(true);
  });

  it("keeps a visible scheduled imported recording available to guests", () => {
    expect(isPublicBunnyCollectionVideo(
      field,
      videoId,
      title,
      context(),
      [importedRecording()],
    )).toBe(true);
  });

  it("does not re-expose a hidden imported recording from its title timestamp", () => {
    expect(isPublicBunnyCollectionVideo(
      field,
      videoId,
      title,
      context(),
      [importedRecording(false)],
    )).toBe(false);
  });

  it("still shows an unimported Bunny video when its title matches a public schedule", () => {
    expect(isPublicBunnyCollectionVideo(field, videoId, title, context(), [])).toBe(true);
  });

  it("does not treat an owner marker in the title as a privacy restriction", () => {
    expect(isPublicBunnyCollectionVideo(
      field,
      videoId,
      "cam1_owner-9_2026-09-26_00:00",
      context(),
      [],
    )).toBe(true);
  });

  it("continues to hide recordings outside the schedule", () => {
    const outsideSchedule = {
      ...importedRecording(),
      timeSlot: "03:00",
    };
    expect(isPublicBunnyCollectionVideo(
      field,
      videoId,
      title,
      context(),
      [outsideSchedule],
    )).toBe(false);
  });

  it("continues to hide footage from hidden fields", () => {
    const hiddenField = { ...field, isHidden: true };
    expect(isPublicBunnyCollectionVideo(
      hiddenField,
      videoId,
      title,
      context(),
      [importedRecording()],
    )).toBe(false);
  });
});
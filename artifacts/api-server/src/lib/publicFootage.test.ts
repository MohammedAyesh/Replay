import { describe, expect, it } from "vitest";
import {
  isOwnerFootageTitle,
  isPublicBunnyCollectionVideo,
  type PublicFootageContext,
} from "./publicFootage";

describe("owner footage title filtering", () => {
  it("recognizes the new machine-readable owner title", () => {
    expect(isOwnerFootageTitle("cam1_owner-42_2026-09-22_23:00")).toBe(true);
    expect(isOwnerFootageTitle("cam1_owner-42_2026-09-22_23:00.mp4")).toBe(true);
  });

  it("keeps ordinary camera titles public-filterable", () => {
    expect(isOwnerFootageTitle("cam1_2026092219")).toBe(false);
    expect(isOwnerFootageTitle("cam1_Field_01_22092026_230000")).toBe(false);
  });
});

describe("public Bunny collection visibility", () => {
  const videoId = "8dcf10ce-86fe-45ed-9216-e7ea352d6d20";
  const title = "cam1_2026-09-26_00:00";
  const field = { id: 10, isHidden: false } as Parameters<typeof isPublicBunnyCollectionVideo>[0];

  function context(ownerVideoIds = new Set<string>()): PublicFootageContext {
    return {
      viewer: null,
      isAdmin: false,
      ownerVideoIds,
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

  it("does not list owner-request footage even when its schedule is public", () => {
    expect(isPublicBunnyCollectionVideo(
      field,
      videoId,
      title,
      context(new Set([videoId])),
      [importedRecording()],
    )).toBe(false);
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
});
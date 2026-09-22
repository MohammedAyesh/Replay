import { describe, expect, it } from "vitest";
import { parseVideoFilename } from "./field-detail";
import { parseVideoTitle } from "./admin";

describe("owner footage Format C titles", () => {
  it("keeps the owner request start date and time in the field archive parser", () => {
    expect(parseVideoFilename("cam1_owner-42_2026-09-22_23:00.mp4")).toEqual({
      isoDate: "2026-09-22",
      startSeconds: 23 * 60 * 60,
    });
  });

  it("keeps the camera/date/time in the admin recordings parser", () => {
    expect(parseVideoTitle("cam2_owner-42_2026-09-22_23:00.mp4")).toEqual({
      court: "Camera 2",
      date: "2026-09-22",
      timeSlot: "23:00",
      duration: "",
    });
  });
});
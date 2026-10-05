import { describe, expect, it } from "vitest";
import { isPublicStandalonePath } from "./public-paths";

describe("isPublicStandalonePath", () => {
  it("allows the public standalone path families", () => {
    for (const path of ["/join/ABC123", "/p/family-token", "/w/share-token", "/m/ABC123", "/f/ABC", "/privacy", "/terms", "/delete-account"]) {
      expect(isPublicStandalonePath(path), path).toBe(true);
    }
  });

  it("does not classify ordinary app pages as public standalone paths", () => {
    for (const path of ["/home", "/matches", "/fields", "/find/1"]) {
      expect(isPublicStandalonePath(path), path).toBe(false);
    }
  });
});
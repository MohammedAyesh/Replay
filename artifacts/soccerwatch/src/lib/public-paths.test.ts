import { describe, expect, it } from "vitest";
import { isPublicStandalonePath } from "./public-paths";

describe("isPublicStandalonePath", () => {
  it("allows the five public standalone path families", () => {
    for (const path of ["/w/share-token", "/m/ABC123", "/privacy", "/terms", "/delete-account"]) {
      expect(isPublicStandalonePath(path), path).toBe(true);
    }
  });

  it("does not classify ordinary app pages as public standalone paths", () => {
    for (const path of ["/home", "/matches", "/fields", "/find/1"]) {
      expect(isPublicStandalonePath(path), path).toBe(false);
    }
  });
});
import { describe, expect, it } from "vitest";
import { supportMailto } from "./client-settings";

describe("supportMailto", () => {
  it("returns null when the support email is empty or invalid", () => {
    expect(supportMailto("")).toBeNull();
    expect(supportMailto("support.example.com")).toBeNull();
  });

  it("returns a mailto URL for a configured support email", () => {
    expect(supportMailto(" support@example.com ")).toBe("mailto:support@example.com");
  });
});
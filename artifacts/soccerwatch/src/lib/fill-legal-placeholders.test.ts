import { describe, expect, it } from "vitest";
import { fillLegalPlaceholders } from "../legal/fill";

describe("fillLegalPlaceholders", () => {
  it("fills both placeholders", () => {
    expect(fillLegalPlaceholders(
      "{{COMPANY}} · {{SUPPORT_EMAIL}}",
      { company: "Replay Ltd", supportEmail: "help@replay.example" },
      "en",
    )).toBe("Replay Ltd · help@replay.example");
  });

  it("uses the English support label when support email is empty", () => {
    expect(fillLegalPlaceholders(
      "Contact {{SUPPORT_EMAIL}}",
      { company: "Replay", supportEmail: "" },
      "en",
    )).toBe("Contact Replay support");
  });

  it("uses the Arabic support label when support email is empty", () => {
    expect(fillLegalPlaceholders(
      "تواصل عبر {{SUPPORT_EMAIL}}",
      { company: "Replay", supportEmail: "" },
      "ar",
    )).toBe("تواصل عبر دعم ريبلاي");
  });
});
import { describe, expect, it } from "vitest";
import { guardianContactLinks } from "./guardian-contact";

describe("guardianContactLinks", () => {
  it("converts a Jordanian mobile number into callable and WhatsApp links", () => {
    expect(guardianContactLinks("079 123 4567")).toEqual({
      whatsappUrl: "https://wa.me/962791234567",
      callUrl: "tel:+962791234567",
    });
  });

  it("preserves an international number and ignores punctuation", () => {
    expect(guardianContactLinks("+962 (79) 123-4567")).toEqual({
      whatsappUrl: "https://wa.me/962791234567",
      callUrl: "tel:+962791234567",
    });
  });

  it("returns no contact links for missing or invalid numbers", () => {
    expect(guardianContactLinks(null)).toBeNull();
    expect(guardianContactLinks("   ")).toBeNull();
    expect(guardianContactLinks("123")).toBeNull();
  });
});
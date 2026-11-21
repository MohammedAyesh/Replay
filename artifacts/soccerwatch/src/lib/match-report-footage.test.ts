import { describe, expect, it } from "vitest";
import { canWatchFullMatch, matchReportFootageNotice } from "./match-report-footage";

const footage = { ready: true, readyAt: null, shareUrl: null, shareToken: "share-token", expiresAt: null };

describe("match report footage", () => {
  it("shows unavailable footage for refunded matches, not retention expiry", () => {
    expect(matchReportFootageNotice({ phase: "expired", status: "refunded" })).toBe("unavailable");
    expect(canWatchFullMatch({ phase: "expired", status: "refunded", footage })).toBe(false);
  });

  it("keeps the retention-expired notice and hides the full-match link", () => {
    expect(matchReportFootageNotice({ phase: "expired", status: "expired" })).toBe("expired");
    expect(canWatchFullMatch({ phase: "expired", status: "expired", footage })).toBe(false);
  });

  it("keeps cancelled bookings unavailable", () => {
    expect(matchReportFootageNotice({ phase: "cancelled", status: "rejected" })).toBe("unavailable");
    expect(canWatchFullMatch({ phase: "cancelled", status: "rejected", footage })).toBe(false);
  });

  it("offers the full-match link only when footage is ready and shareable", () => {
    expect(canWatchFullMatch({ phase: "ready", status: "ready", footage })).toBe(true);
    expect(canWatchFullMatch({
      phase: "ready",
      status: "ready",
      footage: { ...footage, ready: false },
    })).toBe(false);
  });
});

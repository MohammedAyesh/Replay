import { describe, expect, it } from "vitest";
import { bookingPostable, consentForNewBooking, consentMode, consentQuestion } from "./igConsent";

const booking = (extra: Partial<Parameters<typeof bookingPostable>[1]> = {}) => ({
  id: 7, igConsent: null, igConsentSource: null, under18: false, status: "completed", ...extra,
});

describe("Instagram consent", () => {
  it("is off unless a field is set to ask or owner", () => {
    expect(consentMode(undefined)).toBe("off");
    expect(consentMode("anything")).toBe("off");
    expect(consentMode("ask")).toBe("ask");
    expect(bookingPostable("off", booking({ igConsent: "yes" }))).toEqual({ ok: false, reason: "mode_off" });
  });

  it("asks the captain in Ammani Arabic and English", () => {
    expect(consentQuestion("Jordan Galaxy", "en")).toBe("Allow Jordan Galaxy to post a highlight from our match on Instagram?");
    expect(consentQuestion("جوردن جالاكسي", "ar")).toContain("إنستغرام");
  });

  it("stores what each booking flow collected", () => {
    expect(consentForNewBooking("off", { answer: true, source: "website" })).toEqual({ igConsent: null, igConsentSource: null });
    expect(consentForNewBooking("ask", { answer: true, source: "website" })).toEqual({ igConsent: "yes", igConsentSource: "captain_web" });
    expect(consentForNewBooking("ask", { answer: false, source: "whatsapp" })).toEqual({ igConsent: "no", igConsentSource: "captain_whatsapp" });
    expect(consentForNewBooking("ask", { answer: undefined, source: "website" })).toEqual({ igConsent: null, igConsentSource: null });
    expect(consentForNewBooking("ask", { answer: true, source: "console" })).toEqual({ igConsent: "yes", igConsentSource: "staff" });
    // Owner mode: consented by default; only the front desk marks a refusal.
    expect(consentForNewBooking("owner", { source: "website" })).toEqual({ igConsent: "yes", igConsentSource: "owner_default" });
    expect(consentForNewBooking("owner", { answer: false, source: "console" })).toEqual({ igConsent: "no", igConsentSource: "staff" });
    expect(consentForNewBooking("owner", { answer: false, source: "website" })).toEqual({ igConsent: "yes", igConsentSource: "owner_default" });
  });

  it("posts in ask mode only on the captain's own yes", () => {
    expect(bookingPostable("ask", booking())).toEqual({ ok: false, reason: "not_asked" });
    expect(bookingPostable("ask", booking({ igConsent: "yes", igConsentSource: "owner_default" }))).toEqual({ ok: false, reason: "not_asked" });
    const ok = bookingPostable("ask", booking({ igConsent: "yes", igConsentSource: "captain_web", igConsentAt: new Date("2026-11-03T18:00:00Z") }));
    expect(ok).toEqual({ ok: true, mode: "ask", ref: { bookingId: 7, mode: "ask", consent: "yes", source: "captain_web", at: "2026-11-03T18:00:00.000Z" } });
  });

  it("posts in owner mode unless the booking said no, and records the field's wording", () => {
    const since = new Date("2026-11-01T09:00:00Z");
    const ok = bookingPostable("owner", booking(), { since, wording: "Matches here may be filmed and posted." });
    expect(ok).toMatchObject({ ok: true, ref: { mode: "owner", source: "owner_default", modeSince: since.toISOString(), wording: "Matches here may be filmed and posted." } });
    expect(bookingPostable("owner", booking({ igConsent: "no", igConsentSource: "staff" }))).toEqual({ ok: false, reason: "no_consent" });
  });

  it("never posts under-18s, academy footage, or games that weren't played, whatever the mode", () => {
    for (const mode of ["ask", "owner"] as const) {
      expect(bookingPostable(mode, booking({ igConsent: "yes", igConsentSource: "staff", under18: true }))).toEqual({ ok: false, reason: "under_18" });
      expect(bookingPostable(mode, booking({ igConsent: "yes", igConsentSource: "staff", academyFootage: true }))).toEqual({ ok: false, reason: "academy" });
      expect(bookingPostable(mode, booking({ igConsent: "yes", igConsentSource: "staff", status: "no_show" }))).toEqual({ ok: false, reason: "not_played" });
      expect(bookingPostable(mode, booking({ igConsent: "no", igConsentSource: "removal" }))).toEqual({ ok: false, reason: "no_consent" });
    }
  });
});

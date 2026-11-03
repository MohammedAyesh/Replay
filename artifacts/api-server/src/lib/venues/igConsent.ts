/**
 * Instagram consent: the pure rules (no database), so every door — the booking site, the
 * WhatsApp agent, staff bookings, the autopilot and the match page — asks the same question.
 *
 * A field has one consent mode, set by a Replay admin only:
 *   ask   — Replay asks the captain "Allow <field> to post a highlight from our match on
 *           Instagram" in every booking flow. Only a "yes" may be posted.
 *   owner — the field collects consent itself (signage, its own terms, the front desk). Replay
 *           doesn't ask players. Bookings count as consented unless the front desk marks one "no".
 *   off   — nothing from this field is posted. The default for a new field.
 *
 * Whatever the mode, a booking marked under-18, a booking marked "no consent" (by the captain,
 * the front desk, or a player who asked to take a post down) and anything filmed for an
 * academy are never posted.
 */

export type IgConsentMode = "ask" | "owner" | "off";
export type IgConsent = "yes" | "no";
export type IgConsentSource = "captain_web" | "captain_whatsapp" | "staff" | "owner_default" | "removal";

export const IG_CONSENT_MODES: readonly IgConsentMode[] = ["ask", "owner", "off"];

export function consentMode(value: unknown): IgConsentMode {
  return value === "ask" || value === "owner" ? value : "off";
}

/** The question the captain is asked, in each language (Ammani Arabic). */
export function consentQuestion(fieldName: string, locale: "en" | "ar"): string {
  return locale === "ar"
    ? `بتسمح لـ${fieldName} ينزّل لقطة من ماتشكم على إنستغرام؟`
    : `Allow ${fieldName} to post a highlight from our match on Instagram?`;
}

/**
 * What a new booking stores, given the mode and what the booking flow collected.
 * `answer` is the captain's (web / WhatsApp) or the front desk's switch; undefined = not asked.
 */
export function consentForNewBooking(
  mode: IgConsentMode,
  input: { answer?: boolean | null; source: "website" | "whatsapp" | "console" | "app" },
): { igConsent: IgConsent | null; igConsentSource: IgConsentSource | null } {
  if (mode === "off") return { igConsent: null, igConsentSource: null };
  const asked = input.answer === true || input.answer === false;
  if (mode === "ask") {
    if (!asked) return { igConsent: null, igConsentSource: null };
    return {
      igConsent: input.answer ? "yes" : "no",
      igConsentSource: input.source === "website" ? "captain_web" : input.source === "whatsapp" ? "captain_whatsapp" : "staff",
    };
  }
  // owner: consented by default; only the front desk marks a booking that refused.
  if (input.source === "console" && input.answer === false) return { igConsent: "no", igConsentSource: "staff" };
  return { igConsent: "yes", igConsentSource: "owner_default" };
}

export type ConsentBooking = {
  id: number;
  igConsent: string | null;
  igConsentSource: string | null;
  igConsentAt?: Date | null;
  under18: boolean;
  status: string;
  /** Footage filmed for an academy (footage_requests.academy_id) is never the field's to post. */
  academyFootage?: boolean;
};

export type ConsentVerdict =
  | { ok: true; mode: Exclude<IgConsentMode, "off">; ref: ConsentRef }
  | { ok: false; reason: "mode_off" | "under_18" | "no_consent" | "not_asked" | "academy" | "not_played" };

/** What a post relied on: kept on the post so it can be traced back. */
export type ConsentRef = {
  bookingId: number;
  mode: Exclude<IgConsentMode, "off">;
  consent: IgConsent;
  source: IgConsentSource | null;
  at: string | null;
  /** owner mode: when the admin turned it on, and the field's wording then. */
  modeSince?: string | null;
  wording?: string | null;
};

/** May this booking's footage be posted, and on what consent. */
export function bookingPostable(
  mode: IgConsentMode,
  booking: ConsentBooking,
  modeFacts: { since?: Date | null; wording?: string | null } = {},
): ConsentVerdict {
  if (mode === "off") return { ok: false, reason: "mode_off" };
  if (booking.under18) return { ok: false, reason: "under_18" };
  if (booking.academyFootage) return { ok: false, reason: "academy" };
  if (booking.status === "cancelled" || booking.status === "no_show" || booking.status === "held") return { ok: false, reason: "not_played" };
  if (booking.igConsent === "no") return { ok: false, reason: "no_consent" };
  let consent: IgConsent;
  if (mode === "ask") {
    if (booking.igConsent !== "yes") return { ok: false, reason: "not_asked" };
    // A "yes" given while the field was on owner mode is not the captain's answer.
    if (booking.igConsentSource === "owner_default") return { ok: false, reason: "not_asked" };
    consent = "yes";
  } else {
    consent = "yes"; // owner mode: null or "yes" both count; "no" was refused above
  }
  return {
    ok: true,
    mode,
    ref: {
      bookingId: booking.id,
      mode,
      consent,
      source: (booking.igConsentSource as IgConsentSource | null) ?? (mode === "owner" ? "owner_default" : null),
      at: booking.igConsentAt ? booking.igConsentAt.toISOString() : null,
      ...(mode === "owner" ? { modeSince: modeFacts.since ? modeFacts.since.toISOString() : null, wording: modeFacts.wording ?? null } : {}),
    },
  };
}

export const CONSENT_REASON_TEXT: Record<Exclude<ConsentVerdict, { ok: true }>["reason"], { en: string; ar: string }> = {
  mode_off: { en: "Instagram consent is off for this field", ar: "موافقة إنستغرام مطفية لهالملعب" },
  under_18: { en: "Marked under 18", ar: "معلّم إنه تحت 18" },
  no_consent: { en: "They said no to Instagram", ar: "رفضوا إنستغرام" },
  not_asked: { en: "The captain hasn't said yes", ar: "الكابتن ما وافق" },
  academy: { en: "Filmed for an academy", ar: "مصوّر لأكاديمية" },
  not_played: { en: "Not played", ar: "ما انلعب" },
};

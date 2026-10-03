import { useLocale } from "./context";

export type SafetyLocale = "en" | "ar";
export type ReportReason =
  | "nudity"
  | "violence"
  | "harassment"
  | "hate"
  | "spam"
  | "personal_info"
  | "im_in_this_clip"
  | "other";

const en = {
  report: "Report",
  block: (name: string) => `Block ${name}`,
  unblock: "Unblock",
  reportTitle: "Report",
  reportDescription: "Tell us what is wrong with this clip or profile. Your report is private.",
  send: "Send",
  cancel: "Cancel",
  back: "Back",
  retry: "Try again",
  success: "Thanks — we'll review this.",
  alreadyReported: "You've already reported this.",
  rateLimited: "You've sent a lot of reports today. Try again tomorrow.",
  self: "You can't report or block yourself.",
  genericError: "Something went wrong. Try again.",
  guest: "Sign in to report or block",
  blockTitle: (name: string) => `Block ${name}?`,
  blockBody: "You won't see each other's clips or profiles, and they can't follow you or invite you to matches.",
  blocked: "Blocked",
  unblocked: "Unblocked",
  blockFailed: "Couldn't block this player. Try again.",
  unblockFailed: "Couldn't unblock this player. Try again.",
  blockedPlayers: "Blocked players",
  noBlockedPlayers: "No blocked players",
  notAvailable: "Not available",
  youBlocked: "You blocked this player",
  noteLabel: "Add a note",
  notePlaceholder: "Give us a little more context (optional)",
  charactersRemaining: (count: number) => `${count} characters remaining`,
  reasons: {
    nudity: "Nudity or sexual content",
    violence: "Violence or threats",
    harassment: "Harassment or bullying",
    hate: "Hate",
    spam: "Spam",
    personal_info: "Shares someone's personal information",
    im_in_this_clip: "I'm in this clip and want it removed",
    other: "Something else",
  } satisfies Record<ReportReason, string>,
  hidden: {
    removal_request: "Hidden because someone in this clip asked for it to be removed.",
    reports: "Hidden after reports. We're reviewing it.",
    admin: "Hidden by Replay.",
  },
} as const;

const ar = {
  report: "بلّغ",
  block: (name: string) => `احظر ${name}`,
  unblock: "فك الحظر",
  reportTitle: "بلاغ",
  reportDescription: "احكيلنا شو المشكلة بالمقطع أو الحساب. بلاغك خاص.",
  send: "ابعت",
  cancel: "إلغاء",
  back: "رجوع",
  retry: "جرّب كمان مرة",
  success: "شكرًا — رح نراجع البلاغ.",
  alreadyReported: "إنت بلّغت عن هاد من قبل.",
  rateLimited: "بعثت بلاغات كثيرة اليوم. جرّب بكرا.",
  self: "ما بتقدر تبلّغ أو تحظر حالك.",
  genericError: "صار إشي غلط. جرّب كمان مرة.",
  guest: "سجّل دخول لتبلّغ أو تحظر",
  blockTitle: (name: string) => `تحظر ${name}؟`,
  blockBody: "ما رح تشوفوا مقاطع أو حسابات بعض، وما بيقدر يتابعك أو يعزمك على ماتشات.",
  blocked: "انحظر",
  unblocked: "انفك الحظر",
  blockFailed: "ما قدرنا نحظر اللاعب. جرّب كمان مرة.",
  unblockFailed: "ما قدرنا نفك حظر اللاعب. جرّب كمان مرة.",
  blockedPlayers: "اللاعبين المحظورين",
  noBlockedPlayers: "ما في لاعبين محظورين",
  notAvailable: "مش متاح",
  youBlocked: "إنت حاظر هاد اللاعب",
  noteLabel: "ضيف ملاحظة",
  notePlaceholder: "احكيلنا تفاصيل أكثر (اختياري)",
  charactersRemaining: (count: number) => `باقي ${count} حرف`,
  reasons: {
    nudity: "عري أو محتوى جنسي",
    violence: "عنف أو تهديدات",
    harassment: "مضايقة أو تنمّر",
    hate: "كراهية",
    spam: "سبام",
    personal_info: "بينشر معلومات شخصية عن حدا",
    im_in_this_clip: "أنا بهالمقطع وبدي ينشال",
    other: "إشي ثاني",
  } satisfies Record<ReportReason, string>,
  hidden: {
    removal_request: "مخفي لأنه حدا بهالمقطع طلب ينشال.",
    reports: "مخفي بعد بلاغات. إحنا عم نراجعه.",
    admin: "مخفي من ريبلاي.",
  },
} as const;

export const safetyStrings = { en, ar } as const;
export type SafetyStrings = typeof en;

export function useSafetyCopy() {
  const { locale } = useLocale();
  return { ...safetyStrings[locale], locale };
}

export function reportReasonsFor(targetType: "user_clip" | "user"): ReportReason[] {
  const reasons: ReportReason[] = ["nudity", "violence", "harassment", "hate", "spam", "personal_info", "other"];
  return targetType === "user_clip" ? [...reasons.slice(0, 6), "im_in_this_clip", "other"] : reasons;
}

export function reportErrorMessage(reason: unknown, locale: SafetyLocale): string {
  const copy = safetyStrings[locale];
  switch (reason) {
    case "already_reported":
      return copy.alreadyReported;
    case "rate_limited":
      return copy.rateLimited;
    case "self":
      return copy.self;
    default:
      return copy.genericError;
  }
}

export function hiddenNoticeFor(
  hiddenReason: string | null | undefined,
  locale: SafetyLocale,
): string {
  const reason = hiddenReason === "removal_request" || hiddenReason === "reports" || hiddenReason === "admin"
    ? hiddenReason
    : "admin";
  return safetyStrings[locale].hidden[reason];
}

export function hiddenClipNoticeText(
  hiddenReason: string | null | undefined,
  locale: SafetyLocale,
): string {
  return hiddenNoticeFor(hiddenReason, locale);
}

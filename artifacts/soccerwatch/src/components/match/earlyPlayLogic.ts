/**
 * Early Play decisions, kept free of React and the DOM so every branch is
 * unit-tested (earlyPlayLogic.test.ts). EarlyPlay.tsx only wires these up.
 *
 * Facts this is built on (measured 2026-10-30):
 * - The original is HEVC 4096x1152 tagged hvc1, served by Bunny's pull zone
 *   only to Referer https://replayjo.com (www., replit.dev and no referer 403).
 * - A <video> whose URL answers 403/404 raises MediaError 4, the same code as
 *   "this phone cannot decode HEVC". Code 4 alone proves nothing: probe first.
 */

export type EarlyPlayState = "waiting" | "early" | "ready" | "unavailable";
export type EarlyPlayReason =
  | "early_play_off" | "bunny_failed" | "bunny_not_found" | "bunny_error"
  | "vps_unreachable" | "disabled" | "request_cancelled";
export type EarlyPlayStatus = {
  state: EarlyPlayState;
  reason?: string;
  reasonCode?: EarlyPlayReason;
  phase?: string | null;
  encodeProgress?: number | null;
  streamUrl?: string;
  directUrl?: string;
  durationSec?: number | null;
};
export type Source = "direct" | "proxy";
export type Locale = "en" | "ar" | string;

export const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L150.B0"';
export const FIRST_FRAME_TIMEOUT_MS = 8_000;
export const STALL_TIMEOUT_MS = 15_000;
export const POLL_MS = 30_000;

export const earlyPlayPositionKey = (code: string) => `replay:early-play-position:${code.toUpperCase()}`;

type CanPlay = { canPlayType: (type: string) => string };
type MediaSourceLike = { isTypeSupported: (type: string) => boolean } | undefined;

/** True when this browser says it can decode the original (hvc1, Level 5.0). */
export function canDecodeHevc(video: CanPlay, mediaSource: MediaSourceLike): boolean {
  try {
    if (video.canPlayType(HEVC_TYPE) !== "") return true;
  } catch { /* some engines throw on unknown codecs strings */ }
  try {
    return Boolean(mediaSource?.isTypeSupported(HEVC_TYPE));
  } catch {
    return false;
  }
}

/** The card is hidden entirely when there is nothing to offer. */
export function showCard(status: EarlyPlayStatus | null): boolean {
  if (!status) return false;
  if (status.state === "ready") return false;
  if (status.state === "unavailable" && status.reasonCode === "disabled") return false;
  return true;
}

export function initialSource(status: EarlyPlayStatus): Source {
  return status.directUrl ? "direct" : "proxy";
}

export function sourceUrl(status: EarlyPlayStatus | null, source: Source): string | null {
  if (!status || status.state !== "early" || !status.streamUrl) return null;
  if (source === "direct" && status.directUrl) return status.directUrl;
  return status.streamUrl;
}

/**
 * What the <video> must be (re)loaded for. The player only reloads when this
 * string changes: a new URL, a fallback, or an explicit retry. The 30 s status
 * poll and every timeupdate leave it unchanged, so playback is never reset by
 * them (the first build reloaded the video on every timeupdate and every poll).
 */
export function loadKey(status: EarlyPlayStatus | null, source: Source, retryNonce: number, open: boolean): string {
  const url = sourceUrl(status, source);
  return open && url ? `${source}|${url}|${retryNonce}` : "";
}

export type ErrorPlan = { kind: "fallback" } | { kind: "probe" } | { kind: "message"; mediaCode: number };

/** What to do with a MediaError. The direct URL always falls back to the proxy first. */
export function planForMediaError(source: Source, mediaCode: number | null | undefined, status: EarlyPlayStatus | null): ErrorPlan {
  if (source === "direct" && status?.streamUrl) return { kind: "fallback" };
  const code = mediaCode && mediaCode >= 1 && mediaCode <= 4 ? mediaCode : 2;
  if (code === 4) return { kind: "probe" };
  return { kind: "message", mediaCode: code };
}

/** The first frame did not arrive in time: only the direct URL has somewhere to fall back to. */
export function onFirstFrameTimeout(source: Source, gotFrame: boolean, status: EarlyPlayStatus | null): "fallback" | "wait" {
  return !gotFrame && source === "direct" && Boolean(status?.streamUrl) ? "fallback" : "wait";
}

/** Playback stalled for STALL_TIMEOUT_MS. */
export function onStall(source: Source, status: EarlyPlayStatus | null): "fallback" | "offer-retry" {
  return source === "direct" && status?.streamUrl ? "fallback" : "offer-retry";
}

export type ProbeOutcome =
  | { kind: "unsupported" }
  | { kind: "ready" }
  | { kind: "gone" }
  | { kind: "not_allowed" }
  | { kind: "reason"; reasonCode?: EarlyPlayReason }
  | { kind: "network" };

/**
 * After MediaError 4 on the proxied stream: re-read /early-play, then probe the
 * stream with a 2-byte range. Only "still early AND the probe answers 206"
 * means the phone cannot decode it.
 */
export function interpretProbe(
  latest: EarlyPlayStatus | null,
  probeStatus: number | null,
  probeReasonCode?: EarlyPlayReason,
): ProbeOutcome {
  if (!latest) return { kind: "network" };
  if (latest.state === "ready") return { kind: "ready" };
  if (latest.state !== "early") return { kind: "reason", reasonCode: latest.reasonCode };
  if (probeStatus === null) return { kind: "network" };
  if (probeStatus === 206 || probeStatus === 200) return { kind: "unsupported" };
  if (probeStatus === 409) return { kind: "ready" };
  if (probeStatus === 404 || probeStatus === 410) return { kind: "gone" };
  if (probeStatus === 401 || probeStatus === 403) return { kind: "not_allowed" };
  if (probeStatus === 503) return { kind: "reason", reasonCode: probeReasonCode ?? "bunny_error" };
  return { kind: "network" };
}

const pick = (locale: Locale, en: string, ar: string) => (locale === "ar" ? ar : en);

const reasonCopy: Record<Exclude<EarlyPlayReason, "disabled">, [string, string]> = {
  early_play_off: ["Early playback isn't available for this video.", "التشغيل المبكر مش متاح لهاد الفيديو."],
  bunny_failed: ["Video processing failed. The footage may need to be requested again.", "معالجة الفيديو فشلت. ممكن لازم نطلب التسجيل من جديد."],
  bunny_not_found: ["The video is no longer available.", "الفيديو ما عاد موجود."],
  bunny_error: ["We couldn't check the video right now.", "ما قدرنا نتأكد من الفيديو هلّق."],
  vps_unreachable: ["The camera status is temporarily unavailable.", "حالة الكاميرا مش متاحة هلّق."],
  request_cancelled: ["This footage request was cancelled.", "طلب التسجيل انلغى."],
};

export function reasonMessage(code: EarlyPlayReason | undefined, locale: Locale): string {
  const copy = code && code !== "disabled" ? reasonCopy[code] : undefined;
  return copy ? pick(locale, copy[0], copy[1]) : pick(locale, "The early version couldn't be played.", "ما قدرنا نشغّل النسخة المبكرة.");
}

const mediaCopy: Record<number, [string, string]> = {
  1: ["Playback was stopped.", "التشغيل وقف."],
  2: ["A network problem interrupted the video.", "مشكلة بالنت وقّفت الفيديو."],
  3: ["The video couldn't be decoded on this device.", "الجهاز ما قدر يفك ترميز الفيديو."],
  4: ["The video source isn't available.", "مصدر الفيديو مش متاح."],
};

export function mediaMessage(mediaCode: number, locale: Locale): string {
  const copy = mediaCopy[mediaCode] ?? mediaCopy[2];
  return pick(locale, copy[0], copy[1]);
}

export function probeMessage(outcome: ProbeOutcome, locale: Locale): string {
  switch (outcome.kind) {
    case "unsupported": return pick(locale, "Your phone can't play the early version. The match will be ready in a few minutes.", "موبايلك ما بقدر يشغّل النسخة المبكرة. الماتش بكون جاهز بعد كم دقيقة.");
    case "ready": return pick(locale, "The full match is ready now.", "الماتش كامل صار جاهز هلّق.");
    case "gone": return pick(locale, "The early version is no longer available.", "النسخة المبكرة ما عادت متاحة.");
    case "not_allowed": return pick(locale, "You don't have access to this video.", "ما عندك صلاحية تشوف هاد الفيديو.");
    case "reason": return reasonMessage(outcome.reasonCode, locale);
    case "network": return pick(locale, "We couldn't reach the video. Check your connection and retry.", "ما قدرنا نوصل للفيديو. تأكد من النت وجرّب مرة ثانية.");
  }
}

export const stallMessage = (locale: Locale) => pick(locale, "The video stopped loading.", "الفيديو وقف تحميل.");
export const offlineMessage = (locale: Locale) => pick(locale, "You're offline. Reconnect, then tap Retry.", "إنت مش متصل. ارجع على النت واكبس جرّب مرة ثانية.");
export const pollFailedMessage = (locale: Locale) => pick(locale, "Couldn't check for the early version. Retrying…", "ما قدرنا نتأكد من النسخة المبكرة. عم نجرّب كمان مرة…");

/** Restore a saved playback position (seconds); bad or missing values give 0. */
export function savedPosition(raw: string | null | undefined, durationSec?: number | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (durationSec && n >= durationSec - 1) return 0;
  return n;
}

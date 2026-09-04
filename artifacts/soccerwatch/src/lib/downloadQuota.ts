/**
 * The download allowance, as the user sees it.
 *
 * The counter is not an error message. A free user who does not know a limit
 * exists discovers it as a failure at the worst possible moment — the evening of
 * the match, with the clip they wanted in front of them. A user who can see
 * "2 of 5 left" all along understands the shape of the product, and the moment
 * they reach zero is the one moment they are genuinely in the market for a
 * subscription. That is why this is rendered next to the button rather than
 * raised as a toast on failure.
 *
 * The reset date is shown for the same reason and has to be exact: the window is
 * rolling, so "next month" is wrong. It is the day their oldest download turns
 * thirty days old.
 */

export interface DownloadQuota {
  used: number;
  limit: number;
  /** -1 when the account is not metered. */
  remaining: number;
  windowDays: number;
  /** ISO timestamp, or null when nothing has been used. */
  resetAt: string | null;
  unlimited: boolean;
}

export async function fetchDownloadQuota(): Promise<DownloadQuota | null> {
  try {
    const res = await fetch("/api/user-clips/download-quota", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as DownloadQuota;
  } catch {
    return null;
  }
}

export function isQuotaExhausted(q: DownloadQuota | null): boolean {
  return !!q && !q.unlimited && q.remaining <= 0;
}

/**
 * "14 Sep" / "١٤ سبتمبر" — day and month only; the year is never useful here.
 *
 * The English default is en-GB, not en: `en` is US English and renders this as
 * "Sep 14", which reads as the wrong date to everyone in Jordan. The app passes
 * its own locale where it has one.
 */
export function formatResetDate(resetAt: string | null, locale = "en-GB"): string | null {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(resolveLocale(locale), { day: "numeric", month: "short" }).format(d);
}

/** The app's own locale tag is a bare "en", which Intl reads as US English. */
function resolveLocale(locale: string): string {
  return locale === "en" ? "en-GB" : locale;
}

/**
 * The line under the Download button.
 *
 * Phrased as what is left rather than what is spent: "2 of 5 downloads left"
 * reads as an allowance, "3 of 5 used" reads as a meter running down on you.
 */
export function formatQuotaLabel(q: DownloadQuota | null, locale = "en-GB"): string | null {
  if (!q || q.unlimited) return null;
  const reset = formatResetDate(q.resetAt, locale);
  if (q.remaining <= 0) {
    return reset
      ? `No downloads left — 1 more on ${reset}`
      : "No downloads left";
  }
  const noun = q.remaining === 1 ? "download" : "downloads";
  return reset
    ? `${q.remaining} of ${q.limit} ${noun} left — resets ${reset}`
    : `${q.remaining} of ${q.limit} ${noun} left`;
}

/**
 * The line under the spinner while a render waits its turn.
 *
 * A queued export used to look identical to a stalled one, and the honest
 * difference — "you are third in line" — is what stops people tapping again and
 * queueing a fourth copy of the same clip.
 *
 * `position` is null when the server is not tracking this clip, which happens
 * after an API restart. That is reported as plain "Preparing" rather than a
 * confident position that would be a lie.
 */
export function formatQueueLabel(
  position: number | null | undefined,
  stepLabel?: string | null,
): string {
  if (position === 0) return stepLabel ?? "Rendering";
  if (typeof position === "number" && position > 0) {
    return position === 1 ? "Next in the render queue" : `${ordinal(position + 1)} in the render queue`;
  }
  return stepLabel ?? "Preparing";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

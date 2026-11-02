/**
 * Amman wall-clock helpers for the schedule picker. The picker's value is a
 * bare "YYYY-MM-DDTHH:mm" in Amman time and is sent as-is: the API reads it as
 * Amman time (lib/creative/publish.ts parseScheduledAt), whatever zone the
 * phone is set to.
 */
const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Amman", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

export function ammanLocal(date: Date): string {
  const p = Object.fromEntries(parts.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A sensible default: the next round hour at least an hour from now, in Amman. */
export function defaultScheduleLocal(now = new Date()): string {
  const next = new Date(now.getTime() + 60 * 60_000);
  next.setUTCMinutes(0, 0, 0);
  return ammanLocal(new Date(next.getTime() + 60 * 60_000));
}

/** "2026-11-03T18:30" → "Tue 3 Nov, 18:30" (no zone conversion: it already is Amman time). */
export function formatAmmanLocal(local: string, locale: "ar" | "en"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return local;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
  }).format(d);
}

/** An instant (ISO) shown in Amman time. */
export function formatAmman(iso: string, locale: "ar" | "en"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Amman",
  }).format(new Date(iso));
}

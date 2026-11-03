import type { CreativeForYouStrings } from "@/i18n/creative-foryou-strings";
import type { ForYouDraft } from "@/lib/creative-hub-foryou-api";

const TZ = "Asia/Amman";

/** "2026-11-02" on the Amman calendar. */
export function ammanDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "today" / "yesterday" / "tomorrow", else the Amman weekday ("Saturday" / "السبت"). */
export function dayWord(startsAt: Date, now: Date, copy: Pick<CreativeForYouStrings, "day">, locale: "en" | "ar"): string {
  const key = ammanDateKey(startsAt);
  const shift = (days: number) => ammanDateKey(new Date(now.getTime() + days * 86_400_000));
  if (key === shift(0)) return copy.day.today;
  if (key === shift(-1)) return copy.day.yesterday;
  if (key === shift(1)) return copy.day.tomorrow;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { timeZone: TZ, weekday: "long" }).format(startsAt);
}

/** Why a draft is in the feed: "After Saturday's 3–1 win vs Al-Wehdat". */
export function whyLine(reason: ForYouDraft["reason"], copy: CreativeForYouStrings, locale: "en" | "ar", now = new Date()): string {
  if (reason.kind === "weekly" || reason.kind === "meet" || reason.kind === "streak" || reason.kind === "weekmoment") return copy.why[reason.kind];
  if (!reason.startsAt) return copy.why.generic;
  const day = dayWord(new Date(reason.startsAt), now, copy, locale);
  const vs = reason.opponent ? copy.vs(reason.opponent) : "";
  const scored = reason.ownScore !== null && reason.opponentScore !== null;
  // Scores read left to right in both languages ("3–1").
  const score = scored ? `⁦${reason.ownScore}–${reason.opponentScore}⁩` : "";
  switch (reason.kind) {
    case "matchday": return copy.why.matchday(day, vs);
    case "countdown": return copy.why.countdown(day, vs);
    case "callup": return copy.why.callup(day, vs);
    case "matchstats": return copy.why.matchstats(day, vs);
    case "cleansheet": return copy.why.cleansheet(day, vs);
    case "potm": return copy.why.potm(day, vs);
    case "goal": return copy.why.goal(day, vs);
    case "improved": return copy.why.improved(day, vs);
    case "firstgoal": return copy.why.firstgoal(day, vs);
    default:
      if (!scored) return copy.why.played(day, vs);
      return reason.ownScore! > reason.opponentScore! ? copy.why.win(day, score, vs)
        : reason.ownScore === reason.opponentScore ? copy.why.draw(day, score, vs)
          : copy.why.loss(day, score, vs);
  }
}

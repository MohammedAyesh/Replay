import { useLocale } from "./context";

/** Copy for the moment popup on the Moments tab (components/match/MomentPlayer.tsx). English is the type. */
const en = {
  title: "Moment",
  close: "Close",
  back5: "Back 5 seconds",
  fwd5: "Forward 5 seconds",
  play: "Play",
  pause: "Pause",
  previous: "Previous moment",
  next: "Next moment",
  of: (i: number, n: number) => `${i} / ${n}`,
  loading: "Loading the moment…",
  failed: "This bit of the match won't load.",
  retry: "Try again",
  fullMatch: "Watch the full match",
  follow: "Follow the ball",
  wide: "Whole pitch",
  dragHint: "Drag to look around",
  moment: "The moment",
};

export type MomentPlayerStrings = typeof en;

const ar: MomentPlayerStrings = {
  title: "لقطة",
  close: "سكّر",
  back5: "ارجع ٥ ثواني",
  fwd5: "قدّم ٥ ثواني",
  play: "شغّل",
  pause: "وقّف",
  previous: "اللقطة اللي قبل",
  next: "اللقطة اللي بعد",
  of: (i: number, n: number) => `⁦${i} / ${n}⁩`,
  loading: "عم نحمّل اللقطة…",
  failed: "هالجزء من الماتش مش راضي يحمّل.",
  retry: "جرّب كمان مرة",
  fullMatch: "شوف الماتش كامل",
  follow: "لاحق الطابة",
  wide: "الملعب كامل",
  dragHint: "اسحب لتتفرّج حوالين",
  moment: "اللقطة",
};

export function useMomentPlayerCopy(): MomentPlayerStrings & { locale: "en" | "ar" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}

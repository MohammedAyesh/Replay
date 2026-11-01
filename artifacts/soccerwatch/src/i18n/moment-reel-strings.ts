import { useLocale } from "./context";
import { arCount } from "./ar-count";

/** Copy for the "Your moments" reel (components/match/MomentReel.tsx). English is the type. */
const en = {
  title: "Your moments",
  fieldView: "field view",
  open: (n: number) => (n === 1 ? "Keep or drop your 1 moment" : `Keep or drop your ${n} moments`),
  openNote: "A few seconds each. Save it to your clips or let it go.",
  loading: "Getting your moments ready…",
  error: "Couldn't load your moments. Try again.",
  retry: "Try again",
  close: "Close",
  save: "Save",
  drop: "Don't save",
  later: "Later",
  back: "Back",
  tag: "You",
  videoSlow: "Loading the clip…",
  videoFailed: "This clip won't play. Decide from memory or leave it for later.",
  toastSaved: "Saved to your clips",
  toastDropped: "Won't be saved",
  doneTitle: "All decided",
  pausedTitle: (n: number) => (n === 1 ? "1 moment left" : `${n} moments left`),
  doneDesc: "The ones you saved are in My Clips. The ones you didn't are gone from there.",
  pausedDesc: "Your choices are kept. Open your moments again to finish the rest.",
  saved: "Saved",
  dropped: "Not saved",
  later_: "Later",
  done: "Done",
  dropFailed: "Some moments couldn't be removed. They're still in My Clips; remove them there.",
  noneTitle: "Nothing left to decide",
  noneDesc: "Every moment of yours in this match has an answer.",
};

export type MomentReelStrings = typeof en;

const ar: MomentReelStrings = {
  title: "لقطاتك",
  fieldView: "الملعب",
  open: (n: number) => (n === 1 ? "احفظ لقطتك أو اتركها" : `احفظ أو اترك لقطاتك (⁦${n}⁩)`),
  openNote: "كل وحدة كم ثانية. احفظها بمقاطعك أو خليها تروح.",
  loading: "عم نجهّز لقطاتك…",
  error: "ما قدرنا نحمّل لقطاتك. جرّب كمان مرة.",
  retry: "جرّب كمان مرة",
  close: "سكّر",
  save: "احفظ",
  drop: "لا تحفظ",
  later: "بعدين",
  back: "ارجع",
  tag: "إنت",
  videoSlow: "عم نحمّل اللقطة…",
  videoFailed: "هاي اللقطة مش راضية تشتغل. قرّر من ذاكرتك أو خليها لبعدين.",
  toastSaved: "انحفظت بمقاطعك",
  toastDropped: "ما رح تنحفظ",
  doneTitle: "خلصت كلها",
  pausedTitle: (n: number) => `ضايل ${arCount(n, "لقطة وحدة", "لقطتين", "لقطات", "لقطة")}`,
  doneDesc: "اللي حفظتها موجودة بمقاطعي. واللي ما حفظتها انشالت من هناك.",
  pausedDesc: "اختياراتك محفوظة. افتح لقطاتك كمان مرة لتكمّل الباقي.",
  saved: "انحفظت",
  dropped: "ما انحفظت",
  later_: "بعدين",
  done: "تمام",
  dropFailed: "في لقطات ما قدرنا نشيلها. لسا موجودة بمقاطعي، شيلها من هناك.",
  noneTitle: "ما ضل إشي تقرّره",
  noneDesc: "كل لقطة إلك بهالمباراة إلها جواب.",
};

export function useMomentReelCopy(): MomentReelStrings & { locale: "en" | "ar" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}

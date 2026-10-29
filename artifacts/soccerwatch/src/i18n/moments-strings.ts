import { useLocale } from "./context";
import { arCount } from "./ar-count";

/**
 * Copy for My Clips → Moments and the swipe deck that picks moments for a
 * reel. Two objects, one hook, English as the type.
 */
const en = {
  title: "Your moments",
  subtitle: "Every goal, shot, take-on and long pass Replay found for you. Each one is saved for good, even after the match video is gone.",
  count: (n: number) => (n === 1 ? "1 moment" : `${n} moments`),
  allSaved: "All saved",
  savingSome: (n: number) => `Saving ${n}…`,
  lostSome: (n: number) => (n === 1 ? "1 couldn't be saved" : `${n} couldn't be saved`),
  saved: "Saved",
  saving: "Saving…",
  lost: "Not saved",
  lostHint: "The match video was deleted before this one was saved.",
  pick: "Pick moments for a reel",
  pickHint: "Swipe through them: right to keep, left to skip.",
  pickMatch: "Make a reel",
  needTwo: "A reel needs at least 2 moments.",
  kinds: {
    "your-goal": "Your goal",
    "your-shot": "Your shot",
    dribble: "Take-on",
    "long-pass": "Long pass",
    goal: "Team goal",
  } as Record<string, string>,
  kindFallback: "Moment",
  // The deck
  eyebrow: "Pick your moments",
  close: "Close",
  keep: "Keep",
  skip: "Skip",
  undo: "Undo",
  kept: (n: number, max: number) => `${n}/${max} kept`,
  hintRight: "Swipe right",
  hintLeft: "Swipe left",
  videoSlow: "Loading the clip…",
  videoFailed: "This one won't play right now. You can still keep it.",
  cantUse: "This one can't go in a reel yet: the match video won't play and it isn't saved yet.",
  stillSaving: "Still saving",
  full: (max: number) => `That's ${max}: a full reel.`,
  doneTitle: (n: number) => (n === 1 ? "You kept 1 moment" : `You kept ${n} moments`),
  doneNone: "You didn't keep any",
  doneDesc: "Next, name your reel and choose what plays at the end. You can change the order there too.",
  needMore: "Keep at least 2 to make a reel.",
  makeReel: "Make my reel",
  again: "Go through them again",
  empty: "No moments to pick from yet.",
};

type MomentStrings = typeof en;

const ar: MomentStrings = {
  title: "لحظاتك",
  subtitle: "كل جول وتسديدة ومراوغة وتمريرة طويلة لقطتها Replay إلك. كل وحدة بتنحفظ للأبد، حتى بعد ما ينحذف فيديو الماتش.",
  count: (n: number) => arCount(n, "لحظة وحدة", "لحظتين", "لحظات", "لحظة"),
  allSaved: "كلها محفوظة",
  savingSome: (n: number) => `بنحفظ ${n}…`,
  lostSome: (n: number) => (n === 1 ? "وحدة ما انحفظت" : n === 2 ? "ثنتين ما انحفظوا" : `${n} ما انحفظوا`),
  saved: "محفوظة",
  saving: "بنحفظها…",
  lost: "ما انحفظت",
  lostHint: "فيديو الماتش انحذف قبل ما تنحفظ هاي.",
  pick: "اختار لحظات لريل",
  pickHint: "مرّ عليهم: يمين عشان تخليها، يسار عشان تتخطاها.",
  pickMatch: "اعمل ريل",
  needTwo: "الريل بدّه لحظتين على الأقل.",
  kinds: {
    "your-goal": "جولك",
    "your-shot": "تسديدتك",
    dribble: "مراوغة",
    "long-pass": "تمريرة طويلة",
    goal: "جول للفريق",
  } as Record<string, string>,
  kindFallback: "لحظة",
  eyebrow: "اختار لحظاتك",
  close: "سكّر",
  keep: "خلّيها",
  skip: "تخطّى",
  undo: "رجّع",
  kept: (n: number, max: number) => `خلّيت ${n} من ${max}`,
  hintRight: "اسحب يمين",
  hintLeft: "اسحب يسار",
  videoSlow: "الكليب بيحمّل…",
  videoFailed: "هاي ما بتشتغل هلأ. بتقدر تخليها برضه.",
  cantUse: "هاي ما بتقدر تدخل بريل هلأ: فيديو الماتش مش شغّال ولسا ما انحفظت.",
  stillSaving: "لسا بتنحفظ",
  full: (max: number) => `هيك صاروا ${max}: ريل كامل.`,
  doneTitle: (n: number) => `خلّيت ${arCount(n, "لحظة وحدة", "لحظتين", "لحظات", "لحظة")}`,
  doneNone: "ما خلّيت ولا وحدة",
  doneDesc: "هلأ سمّي الريل واختار شو يطلع بالآخر. وبتقدر تغيّر الترتيب كمان.",
  needMore: "خلّي لحظتين على الأقل عشان تعمل ريل.",
  makeReel: "اعمل الريل تبعي",
  again: "ارجع مرّ عليهم",
  empty: "لسا ما في لحظات تختار منها.",
};

export type { MomentStrings };

export function useMomentsCopy(): MomentStrings & { locale: "en" | "ar"; isRtl: boolean } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale, isRtl: locale === "ar" };
}

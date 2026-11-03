import { useLocale } from "./context";
import { useConsoleWording } from "@/lib/console-kind";
import { arCount } from "./ar-count";

/**
 * Creative hub → For you: drafts Replay prepares after the academy's matches
 * and before its fixtures. English is the type; Arabic is Ammani, as across
 * the console. `day` arguments are already words ("Saturday", "yesterday" /
 * "السبت", "مبارح"); `vs` is " vs Al-Wehdat" / " ضد الوحدات" or "".
 */
const en = {
  intro: "Ready-made posts from your matches, in your academy's look. Edit, publish or skip.",
  groups: { after: "After your matches", upcoming: "Coming up", week: "This week" },
  kinds: {
    fulltime: "Full time",
    cleansheet: "Clean sheet",
    potm: "Player of the match",
    goal: "Goal",
    matchday: "Matchday",
    weekly: "Training clip",
  },
  video: "Video",
  day: { today: "today", yesterday: "yesterday", tomorrow: "tomorrow" },
  why: {
    win: (day: string, score: string, vs: string) => `After ${day}'s ${score} win${vs}`,
    draw: (day: string, score: string, vs: string) => `After ${day}'s ${score} draw${vs}`,
    loss: (day: string, score: string, vs: string) => `After ${day}'s game${vs} (${score})`,
    played: (day: string, vs: string) => `After ${day}'s game${vs}`,
    cleansheet: (day: string, vs: string) => `Nothing conceded${vs} ${day === "today" || day === "yesterday" ? day : `on ${day}`}`,
    potm: (day: string, vs: string) => `Best numbers in ${day}'s game${vs}`,
    goal: (day: string, vs: string) => `A goal from ${day}'s game${vs}, from your own footage`,
    matchday: (day: string, vs: string) => `${day[0]?.toUpperCase() ?? ""}${day.slice(1)}${vs}: let your fans know`,
    weekly: "A clip from this week's training, from your own footage",
    generic: "Made from your academy's matches",
  },
  vs: (opponent: string) => ` vs ${opponent}`,
  edit: "Edit",
  publish: "Publish",
  skip: "Skip",
  skipped: "Skipped. It won't come back.",
  skipFailed: "Couldn't skip it. Try again.",
  fixtureCta: "Make a matchday post",
  fixtureOpen: "Open the draft",
  fixtureTitle: (vs: string) => `Matchday${vs}`,
  emptyTitle: "Nothing new yet",
  emptyBody: "After your next match Replay prepares full-time, goal and player posts here. Until then, start from a template.",
  emptyCta: "Browse templates",
  error: "Couldn't load your drafts.",
  retry: "Try again",
  count: (n: number) => (n === 1 ? "1 draft" : `${n} drafts`),
};

const ar: typeof en = {
  intro: "بوستات جاهزة من مبارياتكم، بهوية أكاديميتكم. عدّلها، انشرها، أو تخطّاها.",
  groups: { after: "بعد مبارياتكم", upcoming: "جاي قريب", week: "هالأسبوع" },
  kinds: {
    fulltime: "نهاية المباراة",
    cleansheet: "شباك نظيفة",
    potm: "نجم المباراة",
    goal: "هدف",
    matchday: "يوم المباراة",
    weekly: "كليب التمرين",
  },
  video: "فيديو",
  day: { today: "اليوم", yesterday: "مبارح", tomorrow: "بكرا" },
  why: {
    win: (day, score, vs) => `بعد فوز ${day} ${score}${vs}`,
    draw: (day, score, vs) => `بعد تعادل ${day} ${score}${vs}`,
    loss: (day, score, vs) => `بعد مباراة ${day}${vs} (${score})`,
    played: (day, vs) => `بعد مباراة ${day}${vs}`,
    cleansheet: (day, vs) => `ولا هدف علينا${vs} ${day === "اليوم" || day === "مبارح" ? day : `يوم ${day}`}`,
    potm: (day, vs) => `أحسن أرقام بمباراة ${day}${vs}`,
    goal: (day, vs) => `هدف من مباراة ${day}${vs}، من تصويركم`,
    matchday: (day, vs) => `${day}${vs}: خبّروا جمهوركم`,
    weekly: "كليب من تمرين هالأسبوع، من تصويركم",
    generic: "معمول من مباريات أكاديميتكم",
  },
  vs: (opponent) => ` ضد ${opponent}`,
  edit: "تعديل",
  publish: "نشر",
  skip: "تخطّي",
  skipped: "تخطّيناه. ما رح يرجع.",
  skipFailed: "ما زبط التخطّي. جرّب كمان مرة.",
  fixtureCta: "اعمل بوست يوم المباراة",
  fixtureOpen: "افتح المسودة",
  fixtureTitle: (vs) => `يوم المباراة${vs}`,
  emptyTitle: "ما في إشي جديد لسّا",
  emptyBody: "بعد مباراتكم الجاي، Replay بجهّزلكم هون بوستات نهاية المباراة والأهداف ونجم المباراة. لهلأ، ابدأ من قالب.",
  emptyCta: "شوف القوالب",
  error: "ما قدرنا نجيب المسودات.",
  retry: "جرّب كمان مرة",
  count: (n) => arCount(n, "مسودة وحدة", "مسودتين", "مسودات", "مسودة"),
};

export type CreativeForYouStrings = typeof en;
export const forYouStrings = { en, ar };

export function useForYouCopy(): CreativeForYouStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return useConsoleWording({ ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" });
}

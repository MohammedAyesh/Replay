import { useLocale } from "./context";

/** Academy console menu groups and the merged Sessions page (schedule, results, videos, analysis). */
const en = {
  groups: {
    overview: "Overview",
    players: "Players",
    sessions: "Training & matches",
    money: "Money",
    families: "Families & marketing",
    settings: "Settings",
  },
  sessions: {
    nav: "Sessions",
    title: "Sessions",
    description: "Every training and match in one place: plan it, see its video and analysis, coach on it and record the result.",
    tabs: { sessions: "Sessions", videos: "Videos to attach", compare: "Compare players" },
    openVideo: "Video & analysis",
    noUnattached: "Every video is attached to a session.",
    unattachedHint: "These videos aren't attached to a session yet. Attach each one to its training or match so its analysis, Coach view and stats appear with the session.",
  },
};

type ConsoleNavStrings = typeof en;

const ar: ConsoleNavStrings = {
  groups: {
    overview: "نظرة عامة",
    players: "اللاعبين",
    sessions: "التمارين والمباريات",
    money: "الفلوس",
    families: "الأهالي والتسويق",
    settings: "الإعدادات",
  },
  sessions: {
    nav: "الحصص",
    title: "الحصص",
    description: "كل تمرين ومباراة بمكان واحد: خطّط إلها، شوف الفيديو والتحليل، درّب عليها وسجّل النتيجة.",
    tabs: { sessions: "الحصص", videos: "فيديوهات بدها ربط", compare: "قارن اللاعبين" },
    openVideo: "الفيديو والتحليل",
    noUnattached: "كل الفيديوهات مربوطة بحصص.",
    unattachedHint: "هالفيديوهات لسا مش مربوطة بحصة. اربط كل واحد بتمرينه أو مباراته عشان يطلع تحليله ووضع المدرب والإحصائيات مع الحصة.",
  },
};

export function useConsoleNavCopy(): ConsoleNavStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

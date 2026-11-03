import type { CreativeFormat, CreativeStyle, TemplateCategory } from "@workspace/api-zod";
import { useLocale } from "./context";
import { useConsoleWording } from "@/lib/console-kind";

/**
 * Creative hub → Templates tab. Arabic is Ammani, as across the console.
 * Template names themselves come from the catalogue (TemplateMeta.title).
 */
const en = {
  heading: "Templates",
  intro: "Pick a look, then tap a design to open it in the editor with your academy's colours, crest and footage.",
  all: "All",
  categories: {
    matchday: "Matchday",
    results: "Results",
    players: "Players",
    recruitment: "Join us",
    "academy-life": "Academy life",
    community: "Community",
  } satisfies Record<TemplateCategory, string>,
  styleLabel: "Look",
  styles: {
    broadcast: "Broadcast",
    street: "Street",
    editorial: "Editorial",
    luxury: "Luxury",
    playful: "Playful",
    cinematic: "Cinematic",
    stadium: "Stadium",
  } satisfies Record<CreativeStyle, string>,
  styleHints: {
    broadcast: "TV match graphics",
    street: "Loud and bold",
    editorial: "Calm magazine page",
    luxury: "Quiet and premium",
    playful: "Bright, for the little ones",
    cinematic: "Dark and dramatic",
    stadium: "Floodlit night",
  } satisfies Record<CreativeStyle, string>,
  formatLabel: "Size",
  formats: { post: "Post", square: "Square", story: "Story" } satisfies Record<CreativeFormat, string>,
  formatHints: { post: "4:5", square: "1:1", story: "9:16" } satisfies Record<CreativeFormat, string>,
  languageLabel: "Post language",
  languages: { ar: "عربي", en: "English" },
  video: "Video",
  seconds: (n: number) => `${n}s`,
  startingFrom: "Starting from",
  seeds: {
    clip: "a saved clip",
    recording: "a moment from your footage",
    upload: "something you uploaded",
    frame: "a still from your footage",
    session: "a match",
  },
  clearSeed: "Start from scratch",
  loadingSession: "Getting the match details…",
  sessionFailed: "Couldn't load the match details. The designs use sample text you can edit.",
  creating: "Opening…",
  createFailed: "Couldn't create the design. Try again.",
  noTemplates: "No designs in this group yet.",
  sampleNote: "Previews use sample text. You'll edit everything in the editor.",
  open: (title: string) => `Open ${title} in the editor`,
};

const ar: typeof en = {
  heading: "القوالب",
  intro: "اختار الستايل، وبعدين اضغط على التصميم عشان يفتح بالتعديل بألوان أكاديميتك وشعارها وتصويركم.",
  all: "الكل",
  categories: {
    matchday: "يوم الماتش",
    results: "النتائج",
    players: "اللاعبين",
    recruitment: "التسجيل",
    "academy-life": "جوّا الأكاديمية",
    community: "العيلة",
  },
  styleLabel: "الستايل",
  styles: {
    broadcast: "بث تلفزيوني",
    street: "ستريت",
    editorial: "مجلة",
    luxury: "فخم",
    playful: "للصغار",
    cinematic: "سينمائي",
    stadium: "ستاد",
  },
  styleHints: {
    broadcast: "زي جرافيكس المباريات عالتلفزيون",
    street: "عالي وجريء",
    editorial: "هادي زي صفحة مجلة",
    luxury: "راقي وهادي",
    playful: "ملوّن للأعمار الصغيرة",
    cinematic: "غامق ودرامي",
    stadium: "ليلة تحت الأضواء",
  },
  formatLabel: "المقاس",
  formats: { post: "بوست", square: "مربّع", story: "ستوري" },
  formatHints: { post: "4:5", square: "1:1", story: "9:16" },
  languageLabel: "لغة البوست",
  languages: { ar: "عربي", en: "English" },
  video: "فيديو",
  seconds: (n: number) => `${n} ثانية`,
  startingFrom: "رح نبلّش من",
  seeds: {
    clip: "كليب محفوظ",
    recording: "لقطة من تصويركم",
    upload: "إشي رفعته",
    frame: "صورة من تصويركم",
    session: "ماتش",
  },
  clearSeed: "بلّش من الصفر",
  loadingSession: "عم نجيب تفاصيل الماتش…",
  sessionFailed: "ما قدرنا نجيب تفاصيل الماتش. التصاميم فيها نص تجريبي بتقدر تعدّله.",
  creating: "عم يفتح…",
  createFailed: "ما زبط نعمل التصميم. جرّب كمان مرة.",
  noTemplates: "لسا ما في تصاميم بهالقسم.",
  sampleNote: "المعاينة فيها نص تجريبي، وكل إشي بتعدّله بالتعديل.",
  open: (title: string) => `افتح ${title} بالتعديل`,
};

export type CreativeTemplatesStrings = typeof en;

export function useCreativeTemplatesCopy(): CreativeTemplatesStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return useConsoleWording({ ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" });
}

export const creativeTemplatesStrings = { en, ar };

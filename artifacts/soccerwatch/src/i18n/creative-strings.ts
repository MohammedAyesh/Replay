import { useLocale } from "./context";

/**
 * Academy console → Creative hub: the shell only. Each section keeps its own
 * strings in i18n/creative-<section>-strings.ts. Arabic is Ammani, as across
 * the console.
 */
const en = {
  nav: "Creative hub",
  title: "Creative hub",
  intro: "Posts, stories and videos in your academy's look, made from your own footage.",
  tabs: { forYou: "For you", library: "Library", templates: "Templates", editor: "Editor", publish: "Publish" },
  noProject: "Pick a template or a draft to start.",
};

const ar: typeof en = {
  nav: "استوديو المحتوى",
  title: "استوديو المحتوى",
  intro: "بوستات وستوريز وفيديوهات بهوية أكاديميتك، من تصويركم إنتو.",
  tabs: { forYou: "إلك", library: "المكتبة", templates: "القوالب", editor: "التعديل", publish: "النشر" },
  noProject: "اختار قالب أو مسودة عشان تبلّش.",
};

export type CreativeStrings = typeof en;

export function useCreativeCopy(): CreativeStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

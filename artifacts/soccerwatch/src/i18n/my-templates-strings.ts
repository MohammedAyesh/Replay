import { useLocale } from "./context";

/** Creative hub → My templates: saving an edited design as a template, and using it. Arabic is Ammani. */
const en = {
  save: "Save as template",
  dialogTitle: "Save as a template",
  dialogBody: "Keeps this design (layout, words, colours, music, timing) to start from next time. Each time it fills with that game's footage and facts.",
  name: "Template name",
  update: (name: string) => `Update “${name}”`,
  updateHint: "Saves your changes over the template you started from.",
  asNew: "Save as a new template",
  replace: (base: string) => `Use it instead of “${base}”`,
  replaceHintVenue: "Everywhere the original would be used, the Instagram autopilot included.",
  replaceHintAcademy: "Everywhere the original would be used, Replay's ready-made drafts included.",
  saving: "Saving…",
  saved: (name: string) => `Saved as “${name}”`,
  cancel: "Cancel",
  noTemplate: "This design wasn't started from a template, so it can't be saved as one.",
  chip: "My templates",
  hint: "Designs you saved from the editor. A template marked “In use” replaces the original everywhere.",
  empty: "No templates yet. Edit any design and tap “Save as template”.",
  inUse: "In use",
  useInstead: "Use instead of the original",
  stopUsing: "Stop using instead",
  remove: "Delete",
  confirmRemove: (name: string) => `Delete “${name}”? Designs already made from it stay.`,
  basedOn: (base: string) => `From ${base}`,
  fromReplay: "New from Replay",
  formatOf: (f: string) => ({ story: "Story", post: "Post", square: "Square", wide: "Wide" } as Record<string, string>)[f] ?? f,
};
type Strings = typeof en;

const ar: Strings = {
  save: "احفظ كقالب",
  dialogTitle: "احفظه كقالب",
  dialogBody: "بنحفظ هالتصميم (الترتيب، الكلام، الألوان، الموسيقى، التوقيت) عشان تبدأ منه المرة الجاية. كل مرة بتعبّى بفيديو ومعلومات الماتش.",
  name: "اسم القالب",
  update: (name: string) => `حدّث «${name}»`,
  updateHint: "بتنحفظ تعديلاتك على القالب اللي بلشت منه.",
  asNew: "احفظه كقالب جديد",
  replace: (base: string) => `استخدمه بدل «${base}»`,
  replaceHintVenue: "بكل مكان بينستخدم فيه الأصلي، ومعه الأوتوبايلوت تبع إنستغرام.",
  replaceHintAcademy: "بكل مكان بينستخدم فيه الأصلي، ومعه المسودات الجاهزة من ريبلاي.",
  saving: "عم نحفظ…",
  saved: (name: string) => `انحفظ باسم «${name}»`,
  cancel: "إلغاء",
  noTemplate: "هالتصميم ما بلش من قالب، فما بنقدر نحفظه كقالب.",
  chip: "قوالبي",
  hint: "تصاميم حفظتها من المحرر. القالب اللي عليه «مستخدم» بيحل محل الأصلي بكل مكان.",
  empty: "لسا ما في قوالب. عدّل أي تصميم واكبس «احفظ كقالب».",
  inUse: "مستخدم",
  useInstead: "استخدمه بدل الأصلي",
  stopUsing: "وقّف استخدامه بدل الأصلي",
  remove: "احذف",
  confirmRemove: (name: string) => `تحذف «${name}»؟ التصاميم اللي انعملت منه بتضل.`,
  basedOn: (base: string) => `من ${base}`,
  fromReplay: "جديد من ريبلاي",
  formatOf: (f: string) => ({ story: "ستوري", post: "بوست", square: "مربّع", wide: "عريض" } as Record<string, string>)[f] ?? f,
};

export function useMyTemplatesCopy(): Strings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

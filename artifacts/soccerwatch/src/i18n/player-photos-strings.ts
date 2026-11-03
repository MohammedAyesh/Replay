import { useLocale } from "./context";
import { arCount } from "./ar-count";

/**
 * Academy console → Players → photos (a player's gallery and the photoshoot
 * upload). Arabic is Ammani, as across the console.
 */
const en = {
  photos: "Photos",
  photosOf: (who: string) => `${who}'s photos`,
  galleryHint: "Cut-outs on a transparent background (PNG or WebP) look best in line-ups and player posts. The main photo is the one line-ups use.",
  add: "Add photos",
  adding: "Uploading…",
  empty: "No photos yet.",
  main: "Main",
  makeMain: "Make main",
  cutout: "Cut-out",
  label: "Label",
  labelPlaceholder: "e.g. home kit, celebration",
  saveLabel: "Save",
  remove: "Delete",
  removeConfirm: "Delete this photo?",
  close: "Close",
  shoot: "Photoshoot upload",
  shootTitle: "Upload a photoshoot",
  shootHint: "Drop all the photos at once. Name each file after the shirt number (7.png, 07-omar.png, #10.png) and we match it to the player. Check the list, fix anything, then save.",
  drop: "Drop photos here, or choose them",
  choose: "Choose photos",
  file: "File",
  player: "Player",
  noPlayer: "Skip this photo",
  matched: "Matched by number",
  noNumber: "No shirt number in the name",
  noMatch: (n: number) => `Nobody wears #${n}`,
  twoMatch: (n: number) => `More than one player wears #${n}`,
  ready: (n: number, of: number) => `${n} of ${of} photos will be saved`,
  save: "Save photos",
  saving: "Saving…",
  saved: (n: number) => (n === 1 ? "1 photo saved" : `${n} photos saved`),
  skipped: (n: number) => `${n} skipped`,
  badType: "Use PNG, WebP or JPG",
  tooBig: (mb: number) => `At most ${mb} MB`,
  failed: "That didn't work. Try again.",
  namesOffNote: "Your academy doesn't show players' names, so these photos stay out of Creative hub designs until you turn names on in Branding.",
  noShirt: "No number",
};

const ar: typeof en = {
  photos: "الصور",
  photosOf: (who: string) => `صور ${who}`,
  galleryHint: "الصور المقصوصة على خلفية شفافة (PNG أو WebP) بتطلع أحلى إشي بالتشكيلة وبوستات اللاعبين. الصورة الأساسية هي اللي بتستعملها التشكيلة.",
  add: "ضيف صور",
  adding: "عم نرفع…",
  empty: "لسا ما في صور.",
  main: "الأساسية",
  makeMain: "خلّيها الأساسية",
  cutout: "مقصوصة",
  label: "وصف",
  labelPlaceholder: "مثلاً: طقم البيت، احتفال",
  saveLabel: "احفظ",
  remove: "احذف",
  removeConfirm: "بدك تحذف هالصورة؟",
  close: "سكّر",
  shoot: "رفع جلسة تصوير",
  shootTitle: "ارفع جلسة تصوير",
  shootHint: "نزّل كل الصور مرة وحدة. سمّي كل ملف برقم القميص (7.png، 07-omar.png، #10.png) وإحنا بنطابقه مع اللاعب. راجع القائمة وصلّح أي غلط، وبعدين احفظ.",
  drop: "نزّل الصور هون، أو اختارهم",
  choose: "اختار صور",
  file: "الملف",
  player: "اللاعب",
  noPlayer: "تخطّى هالصورة",
  matched: "انطابقت بالرقم",
  noNumber: "ما في رقم قميص بالاسم",
  noMatch: (n: number) => `ما حدا لابس #${n}`,
  twoMatch: (n: number) => `أكتر من لاعب لابس #${n}`,
  ready: (n: number, of: number) => `رح نحفظ ${n} من ${of}`,
  save: "احفظ الصور",
  saving: "عم نحفظ…",
  saved: (n: number) => `انحفظ: ${arCount(n, "صورة وحدة", "صورتين", "صور", "صورة")}`,
  skipped: (n: number) => `انتخطّى: ${arCount(n, "صورة وحدة", "صورتين", "صور", "صورة")}`,
  badType: "استعمل PNG أو WebP أو JPG",
  tooBig: (mb: number) => `${mb} ميغا كحد أقصى`,
  failed: "ما زبطت. جرّب كمان مرة.",
  namesOffNote: "أكاديميتك ما بتظهر أسماء اللاعبين، فهالصور ما رح تنحط بتصاميم استوديو المحتوى لحد ما تشغّل الأسماء من الهوية.",
  noShirt: "بدون رقم",
};

export type PlayerPhotosStrings = typeof en;

export function usePlayerPhotosCopy(): PlayerPhotosStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

export const playerPhotosStrings = { en, ar };

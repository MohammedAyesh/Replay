import { useLocale } from "./context";

/** Favourite stars and the Studio tabs folded into the Creative hub. */
const en = {
  add: "Add to favourites (shows first)",
  remove: "Remove from favourites",
  tabs: { clips: "Clips", quick: "Quick posts" },
  studioMoved: "Studio is now part of the Creative hub.",
};
const ar: typeof en = {
  add: "أضف للمفضلة (بيطلع أول)",
  remove: "شيل من المفضلة",
  tabs: { clips: "المقاطع", quick: "منشورات سريعة" },
  studioMoved: "الاستوديو صار جزء من استوديو المحتوى.",
};
export const favoriteStrings = { en, ar };
export function useFavoriteCopy(): typeof en & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

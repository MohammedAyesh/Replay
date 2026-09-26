import { useLocale } from "./context";

const en = {
  back: "Back",
  lastUpdated: "Last updated",
  privacyPolicy: "Privacy Policy",
  termsOfUse: "Terms of Use",
  contactSupport: "Contact support",
  legal: "Legal",
};

type LegalStrings = typeof en;

const ar: LegalStrings = {
  back: "رجوع",
  lastUpdated: "آخر تحديث",
  privacyPolicy: "سياسة الخصوصية",
  termsOfUse: "شروط الاستخدام",
  contactSupport: "تواصل مع الدعم",
  legal: "قانوني",
};

export function useLegalCopy(): LegalStrings & { locale: "en" | "ar" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}
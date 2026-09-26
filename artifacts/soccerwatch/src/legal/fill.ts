export type LegalLocale = "en" | "ar";

export function fillLegalPlaceholders(
  text: string,
  values: { company: string; supportEmail: string },
  locale: LegalLocale,
): string {
  const supportContact = values.supportEmail.trim()
    || (locale === "ar" ? "نموذج التواصل في التطبيق" : "the contact form in the app");

  return text
    .replaceAll("{{COMPANY}}", values.company)
    .replaceAll("{{SUPPORT_EMAIL}}", supportContact);
}
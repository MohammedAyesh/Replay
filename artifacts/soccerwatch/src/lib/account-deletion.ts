import {
  accountDeletionStrings,
  type LegalLocale,
} from "@/i18n/legal-strings";

export function isDeleteConfirmation(text: string): boolean {
  const normalized = text.trim();
  return normalized.toUpperCase() === "DELETE" || normalized === "حذف";
}

export function deletionErrorMessage(reason: string | undefined, locale: LegalLocale): string {
  const errors = accountDeletionStrings[locale].errors as Record<string, string>;
  return errors[reason ?? ""] ?? errors.unknown;
}
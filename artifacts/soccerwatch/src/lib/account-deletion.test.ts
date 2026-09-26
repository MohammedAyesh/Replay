import { describe, expect, it } from "vitest";
import { accountDeletionStrings } from "@/i18n/legal-strings";
import { deletionErrorMessage, isDeleteConfirmation } from "./account-deletion";

describe("isDeleteConfirmation", () => {
  it("accepts trimmed, case-insensitive English confirmation", () => {
    expect(isDeleteConfirmation("DELETE")).toBe(true);
    expect(isDeleteConfirmation(" delete ")).toBe(true);
    expect(isDeleteConfirmation("DeLeTe")).toBe(true);
  });

  it("accepts Arabic confirmation in either locale", () => {
    expect(isDeleteConfirmation("حذف")).toBe(true);
    expect(isDeleteConfirmation("  حذف  ")).toBe(true);
  });

  it("rejects incomplete or extra text", () => {
    expect(isDeleteConfirmation("DEL")).toBe(false);
    expect(isDeleteConfirmation("DELETE account")).toBe(false);
    expect(isDeleteConfirmation("حذف الحساب")).toBe(false);
  });
});

describe("deletionErrorMessage", () => {
  const reasons = [
    "upcoming_booking",
    "admin",
    "field_owner",
    "rate_limited",
    "clerk_failed",
    "data_failed",
    "not_found",
    "unauthenticated",
    "forbidden",
    "invalid_id",
    "self_delete",
    "last_admin",
  ];

  it.each(reasons)("maps the %s reason in English and Arabic", (reason) => {
    expect(deletionErrorMessage(reason, "en")).toBe(accountDeletionStrings.en.errors[reason as keyof typeof accountDeletionStrings.en.errors]);
    expect(deletionErrorMessage(reason, "ar")).toBe(accountDeletionStrings.ar.errors[reason as keyof typeof accountDeletionStrings.ar.errors]);
  });

  it("uses the generic message for missing and unknown reasons", () => {
    expect(deletionErrorMessage(undefined, "en")).toBe(accountDeletionStrings.en.errors.unknown);
    expect(deletionErrorMessage("new_server_reason", "ar")).toBe(accountDeletionStrings.ar.errors.unknown);
  });
});
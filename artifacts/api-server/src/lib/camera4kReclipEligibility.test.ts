import { describe, expect, it } from "vitest";
import { createLegacyReclipSkipItem, MISSING_ORIGINAL_SETTINGS_REASON } from "./camera4kReclipEligibility";

describe("legacy 4K re-clip eligibility", () => {
  it.each([1121, 1126, 1263])("keeps legacy clip %i on its old export without a settings snapshot", (clipId) => {
    const now = new Date("2026-11-08T22:00:00.000Z");
    const item = createLegacyReclipSkipItem({
      batchId: 7,
      clipId,
      videoId: "5ad7fb5d-4477-45c8-8f21-c6d7bb723d66",
      recordingId: 403,
      now,
    });

    expect(item).toMatchObject({
      batchId: 7,
      clipId,
      status: "skipped",
      failureReason: MISSING_ORIGINAL_SETTINGS_REASON,
      completedAt: now,
      updatedAt: now,
    });
  });
});

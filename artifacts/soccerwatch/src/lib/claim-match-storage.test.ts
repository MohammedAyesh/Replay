import { describe, expect, it } from "vitest";
import type { ClaimQueueAction } from "./claim-match-storage";
import { filterClaimActionsForRecording } from "./claim-match-storage";

const action = (id: string, recordingId: number): ClaimQueueAction => ({
  id,
  kind: "progress",
  recordingId,
  payload: { stage: "following" },
  createdAt: Number(id),
});

describe("Claim Match queue reset filtering", () => {
  it("removes only actions belonging to the reset recording", () => {
    const otherRecordingAction = action("1", 42);
    const demoProgress = action("2", 288);
    const demoCorrection = {
      ...action("3", 288),
      kind: "correction" as const,
      payload: { clientId: "demo-correction" },
    };

    expect(filterClaimActionsForRecording(
      [otherRecordingAction, demoProgress, demoCorrection],
      288,
    )).toEqual([otherRecordingAction]);
  });
});
import { describe, expect, it } from "vitest";
import { waitingSteps } from "./waiting-steps";
import type { MatchRoom } from "@/lib/match-api";

const room = (progress: number, statsEnabled = true) => ({
  startMs: 0,
  endMs: 90 * 60_000,
  progress,
  stats: { enabled: statsEnabled },
}) as MatchRoom;

describe("waitingSteps", () => {
  it("marks the whistle done and preparing footage current", () => {
    const steps = waitingSteps(room(42), 95 * 60_000);
    expect(steps[0]).toMatchObject({ key: "whistle", state: "done", matchMinutes: 90, minutesAgo: 5 });
    expect(steps[1]).toMatchObject({ key: "processing", state: "current", progressPercent: 42 });
    expect(steps[2]).toMatchObject({ key: "footage", state: "upcoming" });
  });

  it("hides find-yourself and stats steps when stats are disabled", () => {
    expect(waitingSteps(room(25, false), 95 * 60_000).map((step) => step.key))
      .toEqual(["whistle", "processing", "footage"]);
  });

  it.each([0, 100])("does not show a progress percentage at %i", (progress) => {
    expect(waitingSteps(room(progress), 95 * 60_000)[1].progressPercent).toBeUndefined();
  });
});

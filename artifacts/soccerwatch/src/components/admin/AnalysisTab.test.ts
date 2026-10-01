import { describe, expect, it } from "vitest";
import { analysisGpuQueueLabel, buildAnalysisJobParams } from "./AnalysisTab";

describe("analysis GPU params", () => {
  it("queues each finish-time choice on the Salad auto-fleet", () => {
    for (const targetMin of [60, 120, 240, 480] as const) {
      expect(buildAnalysisJobParams("finish", [], "auto", targetMin)).toEqual({
        gpu: "salad-fleet",
        cards: "auto",
        fleetTargetMin: targetMin,
      });
    }
  });

  it("sends Salad auto-fleet as a card count with no GPU list", () => {
    expect(buildAnalysisJobParams("salad-fleet", [], "auto")).toEqual({
      gpu: "salad-fleet",
      cards: "auto",
    });
    expect(buildAnalysisJobParams("salad-fleet", [], 5)).toEqual({
      gpu: "salad-fleet",
      cards: 5,
    });
  });

  it("preserves the existing single-card payload", () => {
    expect(buildAnalysisJobParams("manual", [{ gpu: "auto", saladTier: "cheapest" }], "auto"))
      .toEqual({ gpu: "auto" });
  });

  it("preserves the existing ordered multi-card payload", () => {
    expect(buildAnalysisJobParams("manual", [
      { gpu: "salad:RTX 3090", saladTier: "batch" },
      { gpu: "RTX 5090", saladTier: "cheapest" },
    ], "auto")).toEqual({
      gpu: "multi",
      gpus: ["salad:RTX 3090@batch", "RTX 5090"],
    });
  });
});

describe("analysis GPU queue labels", () => {
  it("labels auto-fleet jobs by their requested card count", () => {
    expect(analysisGpuQueueLabel({ gpu: "salad-fleet", cards: "auto" }))
      .toBe("Salad auto-fleet (auto)");
    expect(analysisGpuQueueLabel({ gpu: "salad-fleet", cards: 5 }))
      .toBe("Salad auto-fleet (5 cards)");
  });

  it("labels finish-time fleet jobs with their target", () => {
    expect(analysisGpuQueueLabel({ gpu: "salad-fleet", cards: "auto", fleetTargetMin: 60 }))
      .toBe("Salad fleet · finish within ~1 h");
    expect(analysisGpuQueueLabel({ gpu: "salad-fleet", cards: "auto", fleetTargetMin: 120 }))
      .toBe("Salad fleet · finish within ~2 h");
    expect(analysisGpuQueueLabel({ gpu: "salad-fleet", cards: "auto", fleetTargetMin: 240 }))
      .toBe("Salad fleet · finish within ~4 h");
    expect(analysisGpuQueueLabel({ gpu: "salad-fleet", cards: "auto", fleetTargetMin: 480 }))
      .toBe("Salad fleet · finish within no rush");
  });
});
import { describe, expect, it } from "vitest";
import { analysisGpuQueueLabel, buildAnalysisJobParams } from "./AnalysisTab";

describe("analysis GPU params", () => {
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
});
import { describe, expect, it } from "vitest";
import { analysisDetailLabel, analysisDetailParams, analysisGpuQueueLabel, buildAnalysisJobParams } from "./AnalysisTab";

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

  it("sends Vast single-card values unchanged without a Salad tier suffix", () => {
    expect(buildAnalysisJobParams("manual", [{ gpu: "vast", saladTier: "batch" }], "auto"))
      .toEqual({ gpu: "vast" });
    expect(buildAnalysisJobParams("manual", [{ gpu: "vast:RTX 4090", saladTier: "low" }], "auto"))
      .toEqual({ gpu: "vast:RTX 4090" });
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

  it("sends Vast multi-card values unchanged alongside Salad cards", () => {
    expect(buildAnalysisJobParams("manual", [
      { gpu: "vast:RTX 4090", saladTier: "batch" },
      { gpu: "vast", saladTier: "low" },
      { gpu: "salad:RTX 3090", saladTier: "batch" },
    ], "auto")).toEqual({
      gpu: "multi",
      gpus: ["vast:RTX 4090", "vast", "salad:RTX 3090@batch"],
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

  it("labels Vast jobs readably", () => {
    expect(analysisGpuQueueLabel({ gpu: "vast" })).toBe("Vast (cheapest)");
    expect(analysisGpuQueueLabel({ gpu: "vast:RTX 4090" })).toBe("Vast RTX 4090");
    expect(analysisGpuQueueLabel({ gpu: "multi", gpus: ["vast:RTX 5090", "vast:RTX 3090"] }))
      .toBe("2 cards: Vast RTX 5090 + Vast RTX 3090");
  });
});
describe("analysis detail params", () => {
  it("sends nothing extra by default", () => {
    expect(analysisDetailParams(false, false)).toEqual({});
    expect(analysisDetailLabel({ gpu: "auto" })).toBe("");
  });

  it("asks the worker for the 8K original and for a one-chunk test", () => {
    expect(analysisDetailParams(true, false)).toEqual({ prefer8k: true });
    expect(analysisDetailParams(true, true)).toEqual({ prefer8k: true, maxChunks: 1 });
    expect(analysisDetailParams(false, true)).toEqual({ maxChunks: 1 });
  });

  it("labels 8K and test jobs in the queue", () => {
    expect(analysisDetailLabel({ prefer8k: true })).toBe(" · 8K native");
    expect(analysisDetailLabel({ prefer8k: true, maxChunks: 1 })).toBe(" · 8K native · test: 1 chunk");
  });
});

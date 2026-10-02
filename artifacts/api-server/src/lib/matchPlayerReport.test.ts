import { describe, expect, it } from "vitest";

import { MatchPlayerReportBuilder } from "./matchPlayerReport";
import { buildPlayerMetrics } from "./playerMetrics";

describe("MatchPlayerReportBuilder", () => {
  it("shares a span's seconds out over the five-minute blocks it crosses and merges near-touching spans", () => {
    const builder = new MatchPlayerReportBuilder();
    builder.beginRecording();
    builder.addSpan(280, 320);
    builder.addSpan(321, 400);
    const report = builder.build();
    expect(report.spans).toEqual([[280, 400]]);
    expect(report.blocks).toEqual([
      { index: 0, seconds: 20, metres: null, touches: null },
      { index: 1, seconds: 99, metres: null, touches: null },
    ]);
  });

  it("counts touches per block from zero only in blocks the recording covered", () => {
    const builder = new MatchPlayerReportBuilder();
    builder.beginRecording();
    builder.addSpan(0, 600);
    builder.addTouches([10, 20, 310]);
    builder.beginRecording();
    builder.addSpan(900, 1000);
    const report = builder.build();
    expect(report.blocks.map((block) => [block.index, block.touches])).toEqual([[0, 2], [1, 1], [3, null]]);
    expect(report.touchTimes).toEqual([10, 20, 310]);
  });

  it("marks covered blocks measured for distance and adds the metres per block", () => {
    const builder = new MatchPlayerReportBuilder();
    builder.beginRecording();
    builder.addSpan(0, 600);
    builder.markDistanceMeasured();
    builder.addDistance({ 1: 412.4 });
    expect(builder.build().blocks.map((block) => block.metres)).toEqual([0, 412]);
  });

  it("keeps the fastest run across recordings and never mixes camera and pitch heatmaps", () => {
    const builder = new MatchPlayerReportBuilder();
    builder.addTopSpeed(24, 100);
    builder.addTopSpeed(27.4, 1400);
    builder.addTopSpeed(null, 50);
    builder.addHeatmap("camera", [{ x: 0.05, y: 0.05, weight: 1 }], 60);
    builder.addHeatmap("pitch", [{ x: 0.95, y: 0.95, weight: 0.5 }, { x: 0.5, y: 0.5, weight: 0.5 }], 120);
    builder.addHeatmap("camera", [{ x: 0.05, y: 0.05, weight: 1 }], 60);
    const report = builder.build();
    expect(report.topSpeedAt).toBe(1400);
    expect(report.heatmap?.coordinateSpace).toBe("pitch");
    expect(report.heatmap?.weights[0]).toBe(0);
    expect(report.heatmap?.weights[7 * 12 + 11]).toBe(0.5);
    expect(report.heatmap?.weights[4 * 12 + 6]).toBe(0.5);
  });

  it("orders shots, passes and dribbles across recordings and drops impossible times", () => {
    const builder = new MatchPlayerReportBuilder();
    builder.addShots([900.04, 120, -1, Number.NaN]);
    builder.addPasses([{ t: 400, completed: true }, { t: 35.26, completed: null }, { t: -3, completed: false }]);
    builder.addDribbles([{ t: 700, outcome: "lost" }, { t: 50, outcome: null }, { t: 60, outcome: "won" }]);
    const report = builder.build();
    expect(report.shotTimes).toEqual([120, 900]);
    expect(report.passes).toEqual([{ t: 35.3, completed: null }, { t: 400, completed: true }]);
    expect(report.dribbles).toEqual([{ t: 50, outcome: null }, { t: 60, outcome: "won" }, { t: 700, outcome: "lost" }]);
  });

  it("returns an empty report with no heatmap when nothing was added", () => {
    expect(new MatchPlayerReportBuilder().build()).toEqual({
      spans: [], blocks: [], touchTimes: [], goalTimes: [], dribbleWonTimes: [], shotTimes: [], passes: [], dribbles: [], topSpeedAt: null, heatmap: null,
    });
  });
});

describe("buildPlayerMetrics timing", () => {
  it("only adds timing when asked for it", () => {
    const manifest = { frameRate: 10, width: 100, height: 100, duration: 10, pitchModel: null } as never;
    const plain = buildPlayerMetrics(manifest, [], [], 0, 0, 0, 0, 0, 0, 0, []);
    expect("timing" in plain).toBe(false);
    const timed = buildPlayerMetrics(manifest, [], [], 0, 0, 0, 0, 0, 0, 0, [], { bucketOfFrame: () => 0 });
    expect(timed.timing).toEqual({ distanceByBucket: {}, topSpeedFrame: null });
  });
});

import { describe, expect, it } from "vitest";
import { parseJerseySidecar } from "./jerseySidecar";

describe("parseJerseySidecar", () => {
  it("drops readings seen on fewer than three frames", () => {
    const parsed = parseJerseySidecar({
      tracks: {
        t7: { number: "7", seenFrames: 3, confidence: 0.8 },
        t8: { number: "8", seenFrames: 2, confidence: 0.99 },
      },
    }, 0);

    expect(parsed?.tracks).toEqual({
      "s0:t7": { number: "7", seenFrames: 3, confidence: 0.8 },
    });
    expect(parsed?.numbers).toEqual({ "7": ["s0:t7"] });
  });

  it("rejects multi-digit leading-zero artefacts but keeps a single zero", () => {
    const parsed = parseJerseySidecar({
      tracks: {
        t0: { number: "0", seenFrames: 3, confidence: 0.7 },
        t07: { number: "07", seenFrames: 9, confidence: 0.99 },
      },
    }, 0);

    expect(Object.keys(parsed?.tracks ?? {})).toEqual(["s0:t0"]);
    expect(parsed?.numbers).toEqual({ "0": ["s0:t0"] });
  });

  it("namespaces track IDs and lifts chunk-local frames", () => {
    const parsed = parseJerseySidecar({
      tracks: {
        t7: {
          number: "10",
          seenFrames: 3,
          bestConfidence: 0.91,
          frames: [3, 18, 42],
        },
      },
      numbers: { "wrong-rollup": ["t7"] },
      reads: [{ trackId: "t7", frame: 3, number: "10" }],
    }, 2, 100);

    expect(parsed?.tracks["s2:t7"]).toEqual({
      number: "10",
      seenFrames: 3,
      confidence: 0.91,
      frames: [103, 118, 142],
    });
    expect(parsed?.numbers).toEqual({ "10": ["s2:t7"] });
    expect(parsed).not.toHaveProperty("reads");
  });

  it("rebuilds the number roll-up from surviving track readings", () => {
    const parsed = parseJerseySidecar({
      tracks: {
        t1: { number: "7", seenFrames: 3, confidence: 0.7 },
        t2: { number: "7", seenFrames: 4, confidence: 0.8 },
        t3: { number: "8", seenFrames: 1, confidence: 0.9 },
      },
      numbers: { "7": ["t3"], "8": ["t1", "t2"] },
      reads: Array.from({ length: 100 }, () => ({ frame: 1 })),
    }, 1);

    expect(parsed?.numbers).toEqual({ "7": ["s1:t1", "s1:t2"] });
    expect(parsed).not.toHaveProperty("reads");
  });
});
import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  STALE_HEARTBEAT_MS,
  bunnyGuidFromUrl,
  bunnyTitleFor,
  canTransition,
  describeSource,
  durationToSeconds,
  isWorkerOnline,
  normaliseParams,
  queuePosition,
  reclaimDecision,
  validateMatchStart,
  validateSources,
  workerKeyMatches,
} from "./analysisJobs";

const NOW = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function source(id: number, overrides: Partial<Parameters<typeof describeSource>[0]> = {}) {
  return {
    id,
    court: "cam1",
    date: "2026-09-01",
    timeSlot: "20:00",
    duration: "60:00",
    videoUrl: `https://vz-abc.b-cdn.net/1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b/playlist.m3u8`,
    ...overrides,
  };
}

describe("status transitions", () => {
  it("lets a claimed job start, finish, fail or go back to the queue", () => {
    expect(canTransition("queued", "claimed")).toBe(true);
    expect(canTransition("claimed", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
    expect(canTransition("claimed", "queued")).toBe(true);
  });

  it("never reopens a finished job", () => {
    // A late heartbeat from the worker that produced the bundle must not undo
    // the bundle, and a cancelled job must not restart because a worker that
    // was mid-run has not noticed yet.
    expect(canTransition("succeeded", "running")).toBe(false);
    expect(canTransition("succeeded", "queued")).toBe(false);
    expect(canTransition("cancelled", "running")).toBe(false);
    expect(canTransition("cancelled", "succeeded")).toBe(false);
    expect(canTransition("failed", "succeeded")).toBe(false);
  });

  it("allows an operator to requeue a failed or cancelled job", () => {
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("cancelled", "queued")).toBe(true);
  });
});

describe("reclaiming a job from a worker that went quiet", () => {
  const base = { id: 1, status: "running" as const, attempts: 1, claimedAt: ago(60_000) };

  it("leaves a job alone while the heartbeat is recent", () => {
    expect(reclaimDecision({ ...base, heartbeatAt: ago(30_000) }, NOW)).toEqual({ action: "leave" });
  });

  it("leaves a job alone one second before the deadline", () => {
    const decision = reclaimDecision({ ...base, heartbeatAt: ago(STALE_HEARTBEAT_MS - 1000) }, NOW);
    expect(decision).toEqual({ action: "leave" });
  });

  it("requeues once the heartbeat has been silent past the deadline", () => {
    const decision = reclaimDecision({ ...base, heartbeatAt: ago(STALE_HEARTBEAT_MS + 1000) }, NOW);
    expect(decision.action).toBe("requeue");
  });

  it("falls back to the claim time when the worker never heartbeat at all", () => {
    const decision = reclaimDecision(
      { ...base, heartbeatAt: null, claimedAt: ago(STALE_HEARTBEAT_MS + 1000) },
      NOW,
    );
    expect(decision.action).toBe("requeue");
  });

  it("stops retrying at the attempt limit instead of requeuing forever", () => {
    const decision = reclaimDecision(
      { ...base, attempts: MAX_ATTEMPTS, heartbeatAt: ago(STALE_HEARTBEAT_MS + 1000) },
      NOW,
    );
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") expect(decision.reason).toContain("Not retrying");
  });

  it("ignores jobs that are not held by a worker", () => {
    expect(reclaimDecision({ ...base, status: "queued", heartbeatAt: ago(10 * STALE_HEARTBEAT_MS) }, NOW))
      .toEqual({ action: "leave" });
    expect(reclaimDecision({ ...base, status: "succeeded", heartbeatAt: ago(10 * STALE_HEARTBEAT_MS) }, NOW))
      .toEqual({ action: "leave" });
  });
});

describe("worker key", () => {
  it("accepts the exact key and nothing else", () => {
    expect(workerKeyMatches("s3cret-key", "s3cret-key")).toBe(true);
    expect(workerKeyMatches("s3cret-key", "s3cret-keY")).toBe(false);
    expect(workerKeyMatches("s3cret-key", "s3cret-key-longer")).toBe(false);
    expect(workerKeyMatches("s3cret-key", "")).toBe(false);
    expect(workerKeyMatches("s3cret-key", undefined)).toBe(false);
    expect(workerKeyMatches("s3cret-key", ["s3cret-key"])).toBe(false);
  });

  it("refuses everything when the server has no key configured", () => {
    // The dangerous shape: an unset key must not mean "any key works", which is
    // what a plain equality check would do for a request that also sends "".
    expect(workerKeyMatches("", "")).toBe(false);
    expect(workerKeyMatches("", "anything")).toBe(false);
  });
});

describe("describing a source for the worker", () => {
  it("pulls the guid out of a Bunny playback url", () => {
    expect(bunnyGuidFromUrl("https://vz-abc.b-cdn.net/1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b/playlist.m3u8"))
      .toBe("1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b");
    expect(bunnyGuidFromUrl("https://example.test/not-a-guid/playlist.m3u8")).toBeNull();
    expect(bunnyGuidFromUrl(null)).toBeNull();
  });

  it("rebuilds the Bunny title the import parsed the row out of", () => {
    expect(bunnyTitleFor(source(1))).toBe("cam1_2026-09-01_20:00");
    expect(bunnyTitleFor(source(1, { timeSlot: "" }))).toBeNull();
  });

  it("reads both duration shapes and refuses nonsense", () => {
    expect(durationToSeconds("12:34")).toBe(754);
    expect(durationToSeconds("1:02:03")).toBe(3723);
    expect(durationToSeconds("")).toBeNull();
    expect(durationToSeconds("about an hour")).toBeNull();
  });
});

describe("validating the chosen sources", () => {
  it("keeps the operator's order, not the database's", () => {
    // The rows come back in id order; the operator asked for 3 then 1 then 2,
    // because that is the order the match was played in.
    const found = [source(1), source(2), source(3)];
    const result = validateSources([3, 1, 2], found);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ordered.map((s) => s.recordingId)).toEqual([3, 1, 2]);
  });

  it("rejects an empty selection, a duplicate, and an unknown id", () => {
    expect(validateSources([], [])).toMatchObject({ ok: false });
    expect(validateSources([1, 1], [source(1)])).toMatchObject({ ok: false });
    const missing = validateSources([1, 9], [source(1)]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("9");
  });

  it("rejects a recording with no video attached", () => {
    const result = validateSources([1], [source(1, { videoUrl: "" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no video");
  });
});

describe("validating the match start", () => {
  const twoHours = [describeSource(source(1)), describeSource(source(2))];

  it("accepts a kick-off inside the footage", () => {
    expect(validateMatchStart(0, twoHours)).toBeNull();
    expect(validateMatchStart(5400, twoHours)).toBeNull();
  });

  it("rejects a kick-off past the end of the footage", () => {
    // 60:00 + 60:00 = 7200s of footage; a match starting at 7200 has nothing
    // after it, and the failure would otherwise only show up as empty boxes.
    expect(validateMatchStart(7200, twoHours)).toContain("past the end");
    expect(validateMatchStart(-1, twoHours)).toContain("zero or more");
    expect(validateMatchStart(Number.NaN, twoHours)).toContain("zero or more");
  });

  it("trusts the operator when a duration is unknown", () => {
    const unknown = [describeSource(source(1, { duration: "" }))];
    expect(validateMatchStart(99999, unknown)).toBeNull();
  });
});

describe("params", () => {
  it("keeps sane values and drops the rest", () => {
    expect(normaliseParams({ chunkSeconds: 600, maxChunks: 6 })).toEqual({ chunkSeconds: 600, maxChunks: 6 });
    expect(normaliseParams({ chunkSeconds: 5 })).toEqual({});
    expect(normaliseParams({ maxChunks: 999 })).toEqual({});
    expect(normaliseParams(null)).toEqual({});
    expect(normaliseParams([1, 2])).toEqual({});
  });

  it("passes unknown knobs through untouched", () => {
    expect(normaliseParams({ model: "yolov8x", conf: 0.25 })).toEqual({ model: "yolov8x", conf: 0.25 });
  });
});

describe("queue position and worker liveness", () => {
  it("numbers waiting jobs from one and gives a running job no position", () => {
    expect(queuePosition({ id: 7, status: "queued" }, [4, 7, 9])).toBe(2);
    expect(queuePosition({ id: 4, status: "queued" }, [4, 7, 9])).toBe(1);
    expect(queuePosition({ id: 4, status: "running" }, [4, 7, 9])).toBeNull();
  });

  it("calls a workstation offline once its ping is old", () => {
    expect(isWorkerOnline(ago(30_000), NOW)).toBe(true);
    expect(isWorkerOnline(ago(10 * 60_000), NOW)).toBe(false);
    expect(isWorkerOnline(null, NOW)).toBe(false);
  });
});

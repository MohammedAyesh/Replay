import { describe, it, expect } from "vitest";
import {
  formatQuotaLabel, formatQueueLabel, formatResetDate, isQuotaExhausted, reconcileExportState,
  type DownloadQuota,
} from "./downloadQuota";

const q = (over: Partial<DownloadQuota> = {}): DownloadQuota => ({
  used: 2, limit: 5, remaining: 3, windowDays: 30,
  resetAt: "2026-09-14T18:00:00.000Z", unlimited: false, ...over,
});

describe("the counter", () => {
  it("says what is left, with the exact reset day", () => {
    expect(formatQuotaLabel(q())).toBe("3 of 5 downloads left — resets 14 Sept");
  });

  it("uses the singular on the last one", () => {
    expect(formatQuotaLabel(q({ remaining: 1, used: 4 }))).toBe("1 of 5 download left — resets 14 Sept");
  });

  it("names the day a slot comes back once the allowance is spent", () => {
    // Not "next month": the window is rolling, so a calendar answer is wrong.
    expect(formatQuotaLabel(q({ remaining: 0, used: 5 }))).toBe("No downloads left — 1 more on 14 Sept");
  });

  it("omits the reset when nothing has been used", () => {
    expect(formatQuotaLabel(q({ remaining: 5, used: 0, resetAt: null })))
      .toBe("5 of 5 downloads left");
  });

  it("shows nothing at all for a paid account", () => {
    expect(formatQuotaLabel(q({ unlimited: true, remaining: -1 }))).toBeNull();
    expect(formatQuotaLabel(null)).toBeNull();
  });

  it("reads the app's bare \"en\" as British, not American", () => {
    expect(formatResetDate("2026-09-14T18:00:00.000Z", "en")).toBe("14 Sept");
  });

  it("defaults to day-then-month, not the US order", () => {
    // `en` would render this as "Sep 14", which reads as the wrong date here.
    expect(formatResetDate("2026-09-14T18:00:00.000Z")).toBe("14 Sept");
    expect(formatResetDate("2026-09-14T18:00:00.000Z", "en-US")).toBe("Sep 14");
  });

  it("localises the date", () => {
    expect(formatResetDate("2026-09-14T18:00:00.000Z", "ar")).toMatch(/١٤|14/);
  });

  it("survives a malformed date rather than rendering Invalid Date", () => {
    expect(formatResetDate("not-a-date")).toBeNull();
    expect(formatQuotaLabel(q({ resetAt: "not-a-date" }))).toBe("3 of 5 downloads left");
  });
});

describe("exhaustion", () => {
  it("is only true for a metered account at zero", () => {
    expect(isQuotaExhausted(q({ remaining: 0 }))).toBe(true);
    expect(isQuotaExhausted(q({ remaining: 1 }))).toBe(false);
    expect(isQuotaExhausted(q({ remaining: -1, unlimited: true }))).toBe(false);
    expect(isQuotaExhausted(null)).toBe(false);   // unknown is not blocked
  });
});

describe("queue position", () => {
  it("shows the render stage when the clip is actually rendering", () => {
    expect(formatQueueLabel(0, "Step 2/3")).toBe("Step 2/3");
  });

  it("says next, then counts places", () => {
    expect(formatQueueLabel(1)).toBe("Next in the render queue");
    expect(formatQueueLabel(2)).toBe("3rd in the render queue");
    expect(formatQueueLabel(3)).toBe("4th in the render queue");
    expect(formatQueueLabel(11)).toBe("12th in the render queue");
  });

  it("does not invent a position the server did not give", () => {
    // Null means the API restarted and is no longer tracking this clip.
    expect(formatQueueLabel(null, "Step 1/3")).toBe("Step 1/3");
    expect(formatQueueLabel(undefined)).toBe("Preparing");
  });
});

describe("reconciling with the server on reopen", () => {
  it("resumes polling for a render that is still running", () => {
    // The bug: closing the clip and coming back showed the idle Download button
    // while the server was still rendering, so tapping it queued a second copy.
    expect(reconcileExportState({ status: "pending", queuePosition: 2 })).toEqual({
      state: "polling",
      url: null,
      label: "3rd in the render queue",
      resume: true,
    });
  });

  it("says Preparing rather than an error when the server is not tracking a position", () => {
    // Null position is normal — an API restart, or the moment before the job is
    // enqueued. It is not a failure, and must not read like one.
    expect(reconcileExportState({ status: "pending", queuePosition: null })).toMatchObject({
      state: "polling",
      label: "Preparing",
      resume: true,
    });
  });

  it("comes back ready, without re-downloading, when the render finished while away", () => {
    expect(reconcileExportState({ status: "done", url: "https://cdn/clip.mp4" })).toEqual({
      state: "ready",
      url: "https://cdn/clip.mp4",
      label: null,
      resume: false,
    });
  });

  it("treats done-without-a-url as not ready", () => {
    expect(reconcileExportState({ status: "done", url: null }).state).toBe("idle");
  });

  it("returns the button to idle after a failed render", () => {
    expect(reconcileExportState({ status: "error" })).toMatchObject({ state: "idle", resume: false });
  });

  it("does not blank a live button when the status call itself fails", () => {
    expect(reconcileExportState(null)).toEqual({ state: "idle", url: null, label: null, resume: false });
  });
});

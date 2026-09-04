import { describe, it, expect } from "vitest";
import {
  evaluateQuota,
  consumeQuota,
  eventsInWindow,
  buildLimitReachedEvent,
  toQuotaResponse,
  LIMIT_REACHED_EVENT,
  type DownloadEvent,
} from "./downloadQuota";

const DAY = 86_400_000;
const at = (daysAgo: number, clipId = 1): DownloadEvent => ({
  at: new Date(NOW.getTime() - daysAgo * DAY),
  clipId,
});
const NOW = new Date("2026-09-04T18:00:00.000Z");

describe("the rolling window", () => {
  it("counts only downloads inside the last 30 days", () => {
    const events = [at(45, 1), at(31, 2), at(29, 3), at(2, 4)];
    expect(eventsInWindow(events, NOW).map((e) => e.clipId)).toEqual([3, 4]);
    expect(evaluateQuota(events, NOW)).toMatchObject({ used: 2, remaining: 3, allowed: true });
  });

  it("is rolling, not calendar — crossing a month boundary changes nothing", () => {
    // Five downloads taken across late August, evaluated on 4 September. A
    // calendar-month limit would have reset all five on 1 September; a rolling
    // one has not released any of them yet.
    const events = [at(20, 1), at(19, 2), at(18, 3), at(17, 4), at(16, 5)];
    const state = evaluateQuota(events, NOW);
    expect(state).toMatchObject({ used: 5, remaining: 0, allowed: false });
    expect(state.resetAt?.toISOString()).toBe("2026-09-14T18:00:00.000Z");
  });

  it("reports the next slot to free, not the last", () => {
    const events = [at(28, 1), at(10, 2), at(1, 3)];
    // The oldest download (28 days ago) is the one about to age out, so the
    // answer to 'when can I download again' is two days from now.
    expect(evaluateQuota(events, NOW).resetAt?.toISOString()).toBe("2026-09-06T18:00:00.000Z");
  });

  it("has no reset date when nothing has been used", () => {
    expect(evaluateQuota([], NOW)).toMatchObject({ used: 0, remaining: 5, resetAt: null, allowed: true });
  });

  it("releases exactly one slot as the oldest download ages out", () => {
    const events = [at(30 - 0.5, 1), at(3, 2), at(2, 3), at(1, 4), at(0.5, 5)];
    expect(evaluateQuota(events, NOW)).toMatchObject({ used: 5, allowed: false });
    const later = new Date(NOW.getTime() + DAY); // the oldest is now 31 days old
    expect(evaluateQuota(events, later)).toMatchObject({ used: 4, remaining: 1, allowed: true });
  });

  it("treats an event exactly at the boundary as expired", () => {
    const events = [{ at: new Date(NOW.getTime() - 30 * DAY), clipId: 1 }];
    expect(evaluateQuota(events, NOW).used).toBe(0);
  });
});

describe("consuming a download", () => {
  it("counts a new clip and decrements the allowance", () => {
    const r = consumeQuota([at(1, 1)], 99, NOW);
    expect(r).toMatchObject({ allowed: true, shouldRecord: true, repeat: false, limitReachedNow: false });
    expect(r.state).toMatchObject({ used: 2, remaining: 3 });
  });

  it("does not charge for re-downloading a clip already counted in the window", () => {
    // A dropped connection at a floodlit pitch must not cost a slot.
    const events = [at(1, 42), at(2, 7)];
    const r = consumeQuota(events, 42, NOW);
    expect(r).toMatchObject({ allowed: true, shouldRecord: false, repeat: true });
    expect(r.state.used).toBe(2);
  });

  it("still allows a repeat when the account is already at 5/5", () => {
    const events = [at(1, 1), at(2, 2), at(3, 3), at(4, 4), at(5, 5)];
    expect(consumeQuota(events, 3, NOW)).toMatchObject({ allowed: true, repeat: true, shouldRecord: false });
  });

  it("refuses a new clip at the limit", () => {
    const events = [at(1, 1), at(2, 2), at(3, 3), at(4, 4), at(5, 5)];
    const r = consumeQuota(events, 6, NOW);
    expect(r).toMatchObject({ allowed: false, shouldRecord: false, limitReachedNow: false });
    expect(r.state.resetAt?.toISOString()).toBe("2026-09-29T18:00:00.000Z")   // oldest (5 days ago) + 30 days;
  });

  it("charges a clip whose earlier download has aged out of the window", () => {
    const r = consumeQuota([at(40, 42)], 42, NOW);
    expect(r).toMatchObject({ repeat: false, shouldRecord: true });
  });

  it("never charges an unlimited account", () => {
    const events = [at(1, 1), at(2, 2), at(3, 3), at(4, 4), at(5, 5)];
    const r = consumeQuota(events, 6, NOW, { unlimited: true });
    expect(r).toMatchObject({ allowed: true, shouldRecord: false, limitReachedNow: false });
    expect(r.state.unlimited).toBe(true);
  });
});

describe("the 5/5 instrumentation", () => {
  it("fires exactly once — on the download that reaches the limit", () => {
    const events: DownloadEvent[] = [at(1, 1), at(2, 2), at(3, 3), at(4, 4)];
    const fifth = consumeQuota(events, 5, NOW);
    expect(fifth.limitReachedNow).toBe(true);
    expect(fifth.state.remaining).toBe(0);

    // A sixth attempt is refused, and refusal is not a second 5/5 event.
    const sixth = consumeQuota([...events, { at: NOW, clipId: 5 }], 6, NOW);
    expect(sixth).toMatchObject({ allowed: false, limitReachedNow: false });

    // Nor is re-downloading one they already have.
    const again = consumeQuota([...events, { at: NOW, clipId: 5 }], 2, NOW);
    expect(again).toMatchObject({ repeat: true, limitReachedNow: false });
  });

  it("does not fire on the fourth download", () => {
    expect(consumeQuota([at(1, 1), at(2, 2), at(3, 3)], 4, NOW).limitReachedNow).toBe(false);
  });

  it("carries the wall the user just hit", () => {
    const events = [at(20, 1), at(19, 2), at(18, 3), at(17, 4)];
    const r = consumeQuota(events, 5, NOW);
    const ev = buildLimitReachedEvent(77, 5, r.state, NOW);
    expect(ev).toEqual({
      event: LIMIT_REACHED_EVENT,
      userId: 77,
      clipId: 5,
      limit: 5,
      windowDays: 30,
      at: "2026-09-04T18:00:00.000Z",
      resetAt: "2026-09-14T18:00:00.000Z",   // oldest (20 days ago) + 30 days
    });
  });
});

describe("what the client is given", () => {
  it("serialises the counter and the reset date the UI shows", () => {
    const state = evaluateQuota([at(28, 1), at(2, 2)], NOW);
    expect(toQuotaResponse(state)).toEqual({
      used: 2, limit: 5, remaining: 3, windowDays: 30,
      resetAt: "2026-09-06T18:00:00.000Z", unlimited: false,
    });
  });

  it("sends -1 rather than Infinity for unlimited accounts, which JSON cannot carry", () => {
    const state = evaluateQuota([], NOW, { unlimited: true });
    expect(state.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(JSON.parse(JSON.stringify(toQuotaResponse(state)))).toMatchObject({ remaining: -1, unlimited: true });
  });
});

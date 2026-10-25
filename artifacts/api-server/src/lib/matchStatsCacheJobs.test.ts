import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ matchId: number }>,
  fill: vi.fn(async (_matchId: number) => {}),
}));

vi.mock("@workspace/db", () => ({
  db: { selectDistinct: () => ({ from: () => ({ orderBy: () => Promise.resolve(mocks.rows) }) }) },
  matchPlayerStatsCacheTable: { matchId: "match_id" },
}));
vi.mock("./matchFeed", () => ({
  fillMatchStatsCacheForMatch: mocks.fill,
  fillMatchStatsCacheForRecording: vi.fn(),
}));

import { refreshStaleMatchStatsCaches } from "./matchStatsCacheJobs";

describe("refreshing cached stats after a rules change", () => {
  beforeEach(() => {
    mocks.fill.mockClear();
  });

  it("puts every cached match through its fill, one at a time", async () => {
    mocks.rows = [{ matchId: 9 }, { matchId: 7 }, { matchId: 3 }];
    let running = 0;
    let most = 0;
    mocks.fill.mockImplementation(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
    expect(await refreshStaleMatchStatsCaches(0)).toBe(3);
    expect(mocks.fill.mock.calls.map(([id]) => id)).toEqual([9, 7, 3]);
    expect(most).toBe(1);
  });

  it("goes on past a match that fails", async () => {
    mocks.rows = [{ matchId: 2 }, { matchId: 1 }];
    mocks.fill.mockImplementationOnce(async () => { throw new Error("bundle gone"); });
    expect(await refreshStaleMatchStatsCaches(0)).toBe(1);
    expect(mocks.fill).toHaveBeenCalledTimes(2);
  });
});

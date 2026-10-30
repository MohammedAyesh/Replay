import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../routes/contabo", () => ({ controlFetch: vi.fn() }));
vi.mock("./logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { controlFetch } from "../routes/contabo";
import {
  chooseFootageSource,
  gapPullPath,
  isGapStoreJob,
  mergeAvailability,
  remoteJobPath,
  withGapStore,
} from "./gapStore";

const mockedFetch = vi.mocked(controlFetch);

beforeEach(() => mockedFetch.mockReset());

describe("job paths", () => {
  it("sends gap-store jobs to /gapstore and everything else to /record-hq", () => {
    expect(isGapStoreJob("gs-0123456789ab")).toBe(true);
    expect(isGapStoreJob("cam1_ab12")).toBe(false);
    expect(remoteJobPath("camera1", "gs-0123456789ab")).toBe("/gapstore/camera1/pull/gs-0123456789ab");
    expect(remoteJobPath("camera1", "abc")).toBe("/record-hq/camera1/abc");
    expect(gapPullPath("camera1", "2026-10-30 15:00:00", "2026-10-30 16:00:00", "t 1"))
      .toBe("/gapstore/camera1/pull?start=2026-10-30%2015%3A00%3A00&end=2026-10-30%2016%3A00%3A00&title=t%201");
  });
});

describe("mergeAvailability", () => {
  it("adds store-only hours, keeps SD entries, and lists every store hour", () => {
    const merged = mergeAvailability(
      { cam: "camera1", date: "2026-10-30", hours: [{ hour: 20, segments: 12, bytes: 9 }] },
      { hours: [{ hour: 3, seconds: 3600, segments: 300, bytes: 5 }, { hour: 20, seconds: 60, segments: 1, bytes: 1 }] },
    );
    expect(merged.hours).toEqual([
      { hour: 3, segments: 300, bytes: 5, seconds: 3600, source: "ftp" },
      { hour: 20, segments: 12, bytes: 9 },
    ]);
    expect(merged.ftpHours).toEqual([3, 20]);
    expect(merged.cam).toBe("camera1");
  });

  it("works with the store alone when the camera can't be reached", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 200, body: { hours: [{ hour: 13, seconds: 3600 }] } });
    const merged = await withGapStore("camera1", "2026-10-30", () => Promise.reject(new Error("camera down")));
    expect((merged.hours as Array<{ hour: number }>).map((h) => h.hour)).toEqual([13]);
  });

  it("still fails when neither the camera nor the store has anything", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false, status: 502, body: null });
    await expect(withGapStore("camera1", "2026-10-30", () => Promise.reject(new Error("camera down"))))
      .rejects.toThrow("camera down");
  });
});

describe("chooseFootageSource", () => {
  const sdAt20 = async () => ({ hours: [{ hour: 20, segments: 12, bytes: 9 }, { hour: 13, source: "ftp" }] });

  it("uses the store for an hour the SD card doesn't record", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 200, body: { coveredSeconds: 3500 } });
    expect(await chooseFootageSource("camera1", "2026-10-30 13:00:00", "2026-10-30 14:00:00", sdAt20)).toBe("ftp");
    expect(mockedFetch.mock.calls[0][0]).toContain("/gapstore/camera1/coverage?start=");
  });

  it("keeps the SD card for the hours it records", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 200, body: { coveredSeconds: 120 } });
    expect(await chooseFootageSource("camera1", "2026-10-30 20:00:00", "2026-10-30 21:00:00", sdAt20)).toBe("sd");
  });

  it("falls back to the SD card when the store can't be asked", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("timeout"));
    expect(await chooseFootageSource("camera1", "2026-10-30 13:00:00", "2026-10-30 14:00:00", sdAt20)).toBe("sd");
  });
});

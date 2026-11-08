import { describe, expect, it } from "vitest";
import { camera4kReclipRevision, isCamera4kReclipWindow } from "./camera4kReclipBatch";

describe("camera 4K re-clip batch timing", () => {
  it("allows only the 22:00–06:00 UTC window", () => {
    expect(isCamera4kReclipWindow(new Date("2026-11-08T21:59:59.999Z"))).toBe(false);
    expect(isCamera4kReclipWindow(new Date("2026-11-08T22:00:00.000Z"))).toBe(true);
    expect(isCamera4kReclipWindow(new Date("2026-11-09T05:59:59.999Z"))).toBe(true);
    expect(isCamera4kReclipWindow(new Date("2026-11-09T06:00:00.000Z"))).toBe(false);
  });

  it("uses a stable revision for safe restart checks", () => {
    expect(camera4kReclipRevision(1126)).toBe("camera4k-20261108-1126");
  });
});

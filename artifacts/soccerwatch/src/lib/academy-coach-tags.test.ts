import { describe, expect, it } from "vitest";
import { canTagNow } from "@/lib/academy-coach-api";

describe("canTagNow", () => {
  const start = "2026-11-16T14:00:00.000Z";
  const t = (iso: string) => Date.parse(iso);
  it("opens 30 minutes before and closes 30 minutes after the session", () => {
    expect(canTagNow(start, "2026-11-16T16:00:00.000Z", t("2026-11-16T13:31:00Z"))).toBe(true);
    expect(canTagNow(start, "2026-11-16T16:00:00.000Z", t("2026-11-16T13:29:00Z"))).toBe(false);
    expect(canTagNow(start, "2026-11-16T16:00:00.000Z", t("2026-11-16T16:29:00Z"))).toBe(true);
    expect(canTagNow(start, "2026-11-16T16:00:00.000Z", t("2026-11-16T16:31:00Z"))).toBe(false);
  });
  it("gives a session with no end three hours", () => {
    expect(canTagNow(start, null, t("2026-11-16T17:20:00Z"))).toBe(true);
    expect(canTagNow(start, null, t("2026-11-16T17:31:00Z"))).toBe(false);
  });
});

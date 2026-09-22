import { describe, expect, it } from "vitest";
import { buildOwnerEndTimeOptions } from "./owner";

describe("owner booking end-time options", () => {
  it("orders end times by elapsed duration across midnight", () => {
    expect(buildOwnerEndTimeOptions("22:45", "en").slice(0, 5)).toEqual([
      { value: "23:00", label: "23:00" },
      { value: "23:15", label: "23:15" },
      { value: "23:30", label: "23:30" },
      { value: "23:45", label: "23:45" },
      { value: "00:00", label: "00:00 (next day)" },
    ]);
  });

  it("uses the Arabic next-day label", () => {
    expect(buildOwnerEndTimeOptions("23:45", "ar")[0]).toEqual({
      value: "00:00",
      label: "00:00 (اليوم التالي)",
    });
  });
});
import { describe, expect, it } from "vitest";
import type { TrackingManifest } from "@workspace/api-client-react";
import {
  MIN_PERSON_SECONDS,
  buildGallery,
  cropsForPerson,
  formatClock,
  formatDuration,
  galleryCrops,
  mergeSprites,
  spread,
} from "./claim-gallery";

const base = {
  version: 1,
  label: "hour",
  width: 3840,
  height: 1080,
  frameRate: 10,
  frameCount: 36000,
  duration: 3600,
  matchOffset: 0,
  videoStartSeconds: 0,
  segmentCount: 1,
  segments: [],
} as unknown as TrackingManifest;

describe("buildGallery", () => {
  it("treats each identity row as one person, longest first", () => {
    const gallery = buildGallery({
      ...base,
      identities: [
        { id: "p1", name: null, parts: [{ trackId: "s0:t1", fromFrame: 0, toFrame: 300 }] },
        {
          id: "p2",
          name: "Yousef",
          parts: [
            { trackId: "s0:t4", fromFrame: 0, toFrame: 600 },
            { trackId: "s0:t9", fromFrame: 900, toFrame: 1200 },
          ],
        },
      ],
    } as TrackingManifest);
    expect(gallery.source).toBe("identities");
    expect(gallery.people.map((person) => person.id)).toEqual(["p2", "p1"]);
    expect(gallery.people[0].onCameraSeconds).toBe(90);
    expect(gallery.people[0].name).toBe("Yousef");
    expect(gallery.people[0].firstFrame).toBe(0);
    expect(gallery.people[0].lastFrame).toBe(1200);
  });

  it("falls back to the tracks that have crops, and drops fragments too short to recognise", () => {
    const gallery = buildGallery(base, {
      "s0:long": Array.from({ length: 30 }, (_, index) => ({ f: index * 100, j: "x" })),
      "s0:short": [{ f: 0, j: "x" }, { f: 10, j: "x" }],
      "s0:nocrops": [{ f: 0, j: "" }, { f: 3000, j: "" }],
    });
    expect(gallery.source).toBe("tracks");
    expect(gallery.people.map((person) => person.id)).toEqual(["s0:long"]);
    expect(gallery.people[0].onCameraSeconds).toBeGreaterThanOrEqual(MIN_PERSON_SECONDS);
  });

  it("has no people rather than fake ones when there is nothing to offer", () => {
    expect(buildGallery(base).people).toEqual([]);
  });
});

describe("spread", () => {
  it("keeps the ends and spaces the middle", () => {
    expect(spread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 6)).toEqual([0, 2, 4, 5, 7, 9]);
  });

  it("returns everything when there is less than asked for", () => {
    expect(spread([1, 2], 6)).toEqual([1, 2]);
  });
});

describe("crops", () => {
  const person = {
    id: "p1",
    name: null,
    parts: [
      { trackId: "t1", fromFrame: 0, toFrame: 100 },
      { trackId: "t2", fromFrame: 200, toFrame: 300 },
    ],
    firstFrame: 0,
    lastFrame: 300,
    onCameraSeconds: 20,
  };

  it("takes only the frames inside the person's own parts", () => {
    const crops = cropsForPerson(person, {
      t1: [{ f: 50, j: "a" }, { f: 150, j: "b" }],
      t2: [{ f: 250, j: "c" }],
      t9: [{ f: 60, j: "d" }],
    });
    expect(crops.map((crop) => crop.frame)).toEqual([50, 250]);
  });

  it("drops strips with no picture in them", () => {
    expect(cropsForPerson(person, { t1: [{ f: 10, j: "" }] })).toEqual([]);
  });

  it("returns at most six, spread across the whole time on camera", () => {
    const strips = Array.from({ length: 40 }, (_, index) => ({ f: index * 2, j: "x" }));
    expect(galleryCrops(person, { t1: strips })).toHaveLength(6);
  });
});

describe("mergeSprites", () => {
  it("joins the per-segment objects and keeps them in time order", () => {
    const merged = mergeSprites([{ t1: [{ f: 300, j: "b" }] }, { t1: [{ f: 10, j: "a" }] }]);
    expect(merged.t1.map((strip) => strip.f)).toEqual([10, 300]);
  });
});

describe("formatting", () => {
  it("writes a clock without an hour until there is one", () => {
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(3675)).toBe("1:01:15");
  });

  it("writes a duration without an empty half", () => {
    const unit = { minutes: "min", seconds: "s" };
    expect(formatDuration(45, unit)).toBe("45 s");
    expect(formatDuration(120, unit)).toBe("2 min");
    expect(formatDuration(135, unit)).toBe("2 min 15 s");
  });
});

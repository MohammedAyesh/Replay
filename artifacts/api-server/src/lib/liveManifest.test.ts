import { describe, expect, it } from "vitest";
import {
  describeLive,
  formatAge,
  livenessSeconds,
  parseLiveManifest,
  stalenessThresholdSeconds,
} from "./liveManifest";

/**
 * The playlist below is RECORDED, not invented: cam1's live.m3u8 as the origin
 * was serving it on 2026-09-05, read off the VPS. It is the reason this module
 * exists — the origin answered 200 with it, four days after the last camera
 * push, and the app played the spinner rather than saying so.
 */
const CAM1_REAL = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:950
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-PROGRAM-DATE-TIME:2026-09-01T08:51:08.000Z
#EXTINF:4.000,
s_000951.ts
#EXTINF:4.000,
s_000952.ts
#EXTINF:0.150,
s_000953.ts
#EXTINF:4.000,
s_000954.ts
#EXTINF:3.000,
s_000955.ts
#EXTINF:4.000,
s_000956.ts
#EXTINF:1.000,
s_000957.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-01T08:51:32.000Z
#EXTINF:4.000,
s_000958.ts
#EXTINF:4.000,
s_000959.ts
`;

describe("reading a real live playlist", () => {
  const m = parseLiveManifest(CAM1_REAL);

  it("counts every segment and the scrubbable window", () => {
    expect(m.segments).toHaveLength(9);
    // 4+4+0.15+4+3+4+1+4+4 — the 0.15 is real: the copier emits a short
    // segment when an FTP clip boundary lands mid-segment.
    expect(m.dvrSeconds).toBeCloseTo(28.15, 2);
    expect(m.targetDurationSeconds).toBe(5);
    expect(m.mediaSequence).toBe(950);
    expect(m.ended).toBe(false);
  });

  it("anchors the live edge on the LAST program-date-time, not the first", () => {
    // Anchoring on the first PDT gives 08:51:08 + 28.15 = 08:51:36.15.
    // The second PDT exists precisely to correct that drift: 08:51:32 + 8 = 08:51:40.
    expect(m.liveEdgeAt?.toISOString()).toBe("2026-09-01T08:51:40.000Z");
  });
});

describe("is anything actually arriving", () => {
  const m = parseLiveManifest(CAM1_REAL);

  it("calls a four-day-old playlist what it is", () => {
    const status = describeLive(m, new Date("2026-09-05T18:00:00Z"));
    expect(status.live).toBe(false);
    expect(status.reason).toBe("stale");
    expect(status.behindSeconds).toBeGreaterThan(4 * 86400 - 3600);
  });

  it("calls the same playlist live a few seconds after its edge", () => {
    const status = describeLive(m, new Date("2026-09-01T08:51:45.000Z"));
    expect(status.live).toBe(true);
    expect(status.reason).toBe("live");
    expect(status.behindSeconds).toBe(5);
  });

  it("scales the threshold to the playlist's own segment length", () => {
    // 4-second segments and 10-second segments disagree about what "a moment
    // ago" means, and the playlist is the only thing that knows which it is.
    expect(stalenessThresholdSeconds(m)).toBe(30);
    expect(stalenessThresholdSeconds(parseLiveManifest("#EXT-X-TARGETDURATION:20\n"))).toBe(60);
  });

  it("tolerates a live edge slightly in the future", () => {
    // The origin stamps a segment's PDT at the start of the period it covers,
    // so the edge routinely reads a second or two ahead of the fetch. Treating
    // that as an error would make every healthy stream flap.
    const status = describeLive(m, new Date("2026-09-01T08:51:38.000Z"));
    expect(status.behindSeconds).toBe(-2);
    expect(status.live).toBe(true);
  });
});

describe("the shapes that are not a live stream", () => {
  it("reports an empty playlist rather than dividing by nothing", () => {
    const status = describeLive(parseLiveManifest("#EXTM3U\n#EXT-X-TARGETDURATION:4\n"), new Date());
    expect(status).toMatchObject({ live: false, reason: "empty", dvrSeconds: 0, segmentCount: 0 });
  });

  it("reports a finished stream as ended, not stale", () => {
    const ended = parseLiveManifest(CAM1_REAL + "#EXT-X-ENDLIST\n");
    expect(describeLive(ended, new Date("2026-09-05T18:00:00Z")).reason).toBe("ended");
  });

  it("plays a playlist with no timestamps rather than refusing it", () => {
    // Cannot prove live, cannot prove dead. Refusing to play a stream that is
    // fine is the worse error, and the viewer finds out in seconds either way.
    const noPdt = parseLiveManifest("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\na.ts\n");
    const status = describeLive(noPdt, new Date());
    expect(status.live).toBe(true);
    expect(status.reason).toBe("no-timestamps");
    expect(status.behindSeconds).toBeNull();
    expect(livenessSeconds(noPdt, new Date())).toBeNull();
  });

  it("ignores a media line with no EXTINF in front of it", () => {
    const stray = parseLiveManifest("#EXTM3U\nnot-a-segment.ts\n#EXTINF:4.000,\nreal.ts\n");
    expect(stray.segments.map((s) => s.name)).toEqual(["real.ts"]);
  });
});

describe("saying how old", () => {
  it("reads the way someone would say it", () => {
    expect(formatAge(12)).toBe("12s ago");
    expect(formatAge(200)).toBe("3 min ago");
    expect(formatAge(7200)).toBe("2 h ago");
    expect(formatAge(4 * 86400)).toBe("4 d ago");
  });
});

import { describe, expect, it } from "vitest";
import {
  academyHashtag,
  addDownload,
  allowedPlacements,
  alreadyPosted,
  ammanLocalToDate,
  checkPlacement,
  dateToAmmanLocal,
  deriveProjectStatus,
  mediaIdForRender,
  nextScheduledAt,
  parseScheduledAt,
  readTargets,
  targetState,
  withoutPost,
  type LinkedPost,
  type PublishTarget,
} from "./publish";

const post = (id: number, patch: Partial<LinkedPost> = {}): LinkedPost => ({
  id, status: "scheduled", error: null, igMediaId: null, igPermalink: null, fbPostId: null, fbPermalink: null,
  scheduledFor: null, publishedAt: null, ...patch,
});
const t = (patch: Partial<PublishTarget>): PublishTarget => ({ channel: "instagram", at: "2026-11-02T10:00:00.000Z", ...patch });

describe("placements", () => {
  it("matches the format: stills feed/story, videos reel/story", () => {
    expect(allowedPlacements({ kind: "image", format: "post" })).toEqual(["feed"]);
    expect(allowedPlacements({ kind: "image", format: "square" })).toEqual(["feed"]);
    expect(allowedPlacements({ kind: "image", format: "story" })).toEqual(["story"]);
    expect(allowedPlacements({ kind: "video", format: "post" })).toEqual(["reel"]);
    expect(allowedPlacements({ kind: "video", format: "story" })).toEqual(["story", "reel"]);
  });

  it("story format goes out as a story, to Instagram only", () => {
    const ok = checkPlacement({ kind: "image", format: "story" }, ["instagram"]);
    expect(ok).toEqual({ ok: true, placement: "story", format: "story", targets: ["instagram"] });
    const fb = checkPlacement({ kind: "image", format: "story" }, ["instagram", "facebook"]);
    expect(fb).toMatchObject({ ok: false, code: "story_facebook" });
  });

  it("a 9:16 video may go as a reel to both", () => {
    expect(checkPlacement({ kind: "video", format: "story" }, ["instagram", "facebook"], "reel"))
      .toEqual({ ok: true, placement: "reel", format: "reel", targets: ["instagram", "facebook"] });
  });

  it("refuses a placement the format can't take", () => {
    expect(checkPlacement({ kind: "image", format: "post" }, ["instagram"], "story")).toMatchObject({ ok: false, code: "placement" });
    expect(checkPlacement({ kind: "image", format: "post" }, ["instagram"], "reel")).toMatchObject({ ok: false, code: "placement" });
    expect(checkPlacement({ kind: "image", format: "post" }, [])).toMatchObject({ ok: false, code: "targets" });
  });

  it("feed stills post as image", () => {
    expect(checkPlacement({ kind: "image", format: "post" }, ["facebook", "facebook"])).toEqual({ ok: true, placement: "feed", format: "image", targets: ["facebook"] });
  });
});

describe("Amman time", () => {
  it("reads a bare date-time as Amman wall clock (UTC+3), whatever the server's zone", () => {
    expect(ammanLocalToDate("2026-11-03T18:30")?.toISOString()).toBe("2026-11-03T15:30:00.000Z");
    expect(ammanLocalToDate("2026-07-15 00:10")?.toISOString()).toBe("2026-07-14T21:10:00.000Z");
    expect(ammanLocalToDate("2027-01-01T01:00:30")?.toISOString()).toBe("2026-12-31T22:00:30.000Z");
  });

  it("rejects impossible dates", () => {
    expect(ammanLocalToDate("2026-02-30T10:00")).toBeNull();
    expect(ammanLocalToDate("2026-11-03T25:00")).toBeNull();
    expect(ammanLocalToDate("tomorrow")).toBeNull();
  });

  it("round-trips to what a datetime-local input shows", () => {
    expect(dateToAmmanLocal(new Date("2026-11-03T15:30:00Z"))).toBe("2026-11-03T18:30");
    expect(dateToAmmanLocal(new Date("2026-12-31T21:59:00Z"))).toBe("2027-01-01T00:59");
    expect(dateToAmmanLocal(ammanLocalToDate("2026-11-20T09:05")!)).toBe("2026-11-20T09:05");
  });

  it("schedules: empty is now, bare is Amman, zoned is as given", () => {
    const now = new Date("2026-11-02T20:00:00Z"); // 23:00 in Amman
    expect(parseScheduledAt(undefined, now)).toEqual({ ok: true, at: null });
    expect(parseScheduledAt("", now)).toEqual({ ok: true, at: null });
    const bare = parseScheduledAt("2026-11-03T18:30", now);
    expect(bare.ok && bare.at?.toISOString()).toBe("2026-11-03T15:30:00.000Z");
    const zoned = parseScheduledAt("2026-11-03T18:30:00+03:00", now);
    expect(zoned.ok && zoned.at?.toISOString()).toBe("2026-11-03T15:30:00.000Z");
    const z = parseScheduledAt("2026-11-03T15:30:00Z", now);
    expect(z.ok && z.at?.toISOString()).toBe("2026-11-03T15:30:00.000Z");
  });

  it("'22:30 tonight' in Amman is still in the future when UTC already says 19:30", () => {
    const now = new Date("2026-11-02T19:00:00Z"); // 22:00 Amman
    const r = parseScheduledAt("2026-11-02T22:30", now);
    expect(r.ok && r.at?.toISOString()).toBe("2026-11-02T19:30:00.000Z");
  });

  it("refuses the past, far future and junk; a minute ahead counts as now", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    expect(parseScheduledAt("2026-11-02T22:00", now)).toMatchObject({ ok: false, code: "schedule_past" }); // 19:00Z
    expect(parseScheduledAt("2027-03-01T10:00", now)).toMatchObject({ ok: false, code: "schedule_far" });
    expect(parseScheduledAt("2026-11-03 nope", now)).toMatchObject({ ok: false, code: "schedule" });
    expect(parseScheduledAt("2026-11-03T10:00:00", now)).toMatchObject({ ok: true });
    expect(parseScheduledAt("2026-11-02T23:01", now)).toEqual({ ok: true, at: null });
    expect(parseScheduledAt(12345, now)).toMatchObject({ ok: false });
  });
});

describe("publish_targets bookkeeping", () => {
  it("reads only well-formed entries", () => {
    expect(readTargets(null)).toEqual([]);
    expect(readTargets([{ channel: "instagram", at: "x" }, null, 3, { nope: 1 }])).toEqual([{ channel: "instagram", at: "x" }]);
  });

  it("reuses the media copy of the same render only", () => {
    const r1 = new Date("2026-11-01T10:00:00Z");
    const r2 = new Date("2026-11-02T10:00:00Z");
    const targets = [t({ mediaId: 5, renderedAt: r1.toISOString() }), t({ channel: "ad", mediaId: 9, renderedAt: r2.toISOString() })];
    expect(mediaIdForRender(targets, r1)).toBe(5);
    expect(mediaIdForRender(targets, r2)).toBe(9);
    expect(mediaIdForRender(targets, new Date("2026-11-03T00:00:00Z"))).toBeNull();
  });

  it("records a download once per render", () => {
    const r = new Date("2026-11-01T10:00:00Z");
    const once = addDownload([], r);
    expect(once).toHaveLength(1);
    expect(addDownload(once, r)).toBe(once);
    expect(addDownload(once, new Date("2026-11-02T10:00:00Z"))).toHaveLength(2);
  });

  it("drops a cancelled post's entries", () => {
    const targets = [t({ postId: 1 }), t({ channel: "facebook", postId: 1 }), t({ postId: 2 })];
    expect(withoutPost(targets, 1)).toEqual([t({ postId: 2 })]);
  });
});

describe("status sync", () => {
  it("per-channel state of a partial post", () => {
    const p = post(1, { status: "partial", igMediaId: "ig1", igPermalink: "https://ig/p/1", error: "Facebook: Page token expired" });
    expect(targetState(t({ postId: 1 }), p)).toEqual({ state: "published", permalink: "https://ig/p/1", error: null });
    expect(targetState(t({ channel: "facebook", postId: 1 }), p)).toEqual({ state: "failed", permalink: null, error: "Facebook: Page token expired" });
    expect(targetState(t({ postId: 7 }), undefined).state).toBe("removed");
    expect(targetState(t({ channel: "whatsapp" }), undefined).state).toBe("sent");
  });

  it("scheduled while waiting, published once the worker posts, ready when all failed", () => {
    const targets = [t({ postId: 1 }), t({ channel: "facebook", postId: 1 })];
    expect(deriveProjectStatus("ready", targets, new Map([[1, post(1)]])).status).toBe("scheduled");
    const publishedAt = new Date("2026-11-03T15:30:05Z");
    expect(deriveProjectStatus("scheduled", targets, new Map([[1, post(1, { status: "published", igMediaId: "a", fbPostId: "b", publishedAt })]])))
      .toEqual({ status: "published", publishedAt });
    expect(deriveProjectStatus("scheduled", targets, new Map([[1, post(1, { status: "failed", error: "x" })]])).status).toBe("ready");
    expect(deriveProjectStatus("scheduled", targets, new Map()).status).toBe("ready");
  });

  it("WhatsApp makes it published; ads and downloads don't change the status", () => {
    expect(deriveProjectStatus("ready", [t({ channel: "whatsapp", at: "2026-11-02T08:00:00.000Z" })], new Map()))
      .toEqual({ status: "published", publishedAt: new Date("2026-11-02T08:00:00.000Z") });
    expect(deriveProjectStatus("draft", [t({ channel: "ad" }), t({ channel: "download" })], new Map())).toEqual({ status: "draft", publishedAt: null });
  });

  it("the next due time among waiting posts", () => {
    const a = new Date("2026-11-05T10:00:00Z");
    const b = new Date("2026-11-04T10:00:00Z");
    const posts = new Map([[1, post(1, { scheduledFor: a })], [2, post(2, { scheduledFor: b })], [3, post(3, { status: "published", scheduledFor: new Date(0) })]]);
    expect(nextScheduledAt([t({ postId: 1 }), t({ postId: 2 }), t({ postId: 3 })], posts)).toEqual(b);
  });

  it("knows a render already went to a channel", () => {
    const r = new Date("2026-11-01T10:00:00Z");
    const targets = [t({ postId: 1, renderedAt: r.toISOString() })];
    const live = new Map([[1, post(1, { status: "published", igMediaId: "x" })]]);
    expect(alreadyPosted(targets, live, ["instagram", "facebook"], r)).toEqual(["instagram"]);
    expect(alreadyPosted(targets, live, ["instagram"], new Date())).toEqual([]);
    expect(alreadyPosted(targets, new Map([[1, post(1, { status: "failed" })]]), ["instagram"], r)).toEqual([]);
  });
});

describe("hashtag", () => {
  it("joins the academy's name", () => {
    expect(academyHashtag("Galaxy football academy")).toBe("#GalaxyFootballAcademy");
    expect(academyHashtag("أكاديمية النجوم")).toBe("#أكاديميةالنجوم");
    expect(academyHashtag("  ")).toBeNull();
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import { academiesTable, db, fieldsTable, recordingsTable, userClipsTable, usersTable } from "@workspace/db";

/**
 * Picking a clip in the Creative hub must give that clip's footage — the
 * seconds the player cut — in the preview, the poster and the export.
 * user_clips stores start/end as shares of the video; reading them as seconds
 * (the old bug) played the first second of the match instead.
 */

const fetched: Array<{ how: string; url: string; from: number; to: number }> = [];

vi.mock("../bunny", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bunny")>();
  return {
    ...real,
    isBunnyConfigured: () => true,
    isBunnyStorageConfigured: () => false,
    getBunnyVideoInfo: vi.fn(async () => ({ duration: 5400 })),
    getBunnyPlaybackUrl: (id: string) => `https://play.test/${id}/playlist.m3u8`,
    getBunnyProxiedThumbnailUrl: (id: string, t: number) => `https://thumb.test/${id}?t=${t}`,
  };
});

vi.mock("../goalReelClip", async (importOriginal) => {
  const real = await importOriginal<typeof import("../goalReelClip")>();
  return {
    ...real,
    reelClip: vi.fn(async (url: string, from: number, to: number) => {
      fetched.push({ how: "preview", url, from, to });
      return { path: "/tmp/never-written.mp4" };
    }),
    mediaPlaylistFor: vi.fn(async () => ({ init: null, segments: [] })),
    segmentsFor: vi.fn((_playlist: unknown, from: number, to: number) => {
      fetched.push({ how: "export", url: "", from, to });
      return { segments: [], offset: 0 };
    }),
  };
});

import { browserMedia, creativeVideoResolver } from "./renderMedia";
import { clearClipSpanCache } from "./clipSpan";
import type { AcademyOwnerAccess } from "../academyOwner";

const tag = Date.now();
let venueId: number;
let clipId: number;
const videoId = `pick-${tag}`;

beforeAll(async () => {
  clearClipSpanCache();
  const [user] = await db.insert(usersTable).values({ name: `Pick ${tag}`, email: `pick-${tag}@test.local` }).returning({ id: usersTable.id });
  const [field] = await db.insert(fieldsTable).values({ name: `Pick field ${tag}`, cameraId: `pick-cam-${tag}` }).returning({ id: fieldsTable.id });
  const [venue] = await db.insert(academiesTable).values({ name: `Pick venue ${tag}`, kind: "venue", fieldId: field.id }).returning({ id: academiesTable.id });
  venueId = venue.id;
  const [rec] = await db.insert(recordingsTable).values({
    fieldId: field.id, court: "1", date: "2026-11-02", timeSlot: "20:00", duration: "90 min", videoUrl: `https://vz.test/${videoId}/playlist.m3u8`,
  } as typeof recordingsTable.$inferInsert).returning({ id: recordingsTable.id });
  // 40%–41% of a 90-minute match: 36:00 to 36:54.
  const [row] = await db.insert(userClipsTable).values({
    userId: user.id, videoId, title: "Top corner", startTime: "0.40", endTime: "0.41", thumbnailTime: "2170", sourceRecordingId: rec.id,
  }).returning({ id: userClipsTable.id });
  clipId = row.id;
});

describe("picking a clip in the Creative hub", () => {
  const access = () => ({ academyId: venueId }) as AcademyOwnerAccess;

  it("previews the clip's own 54 seconds, from 36:00", async () => {
    fetched.length = 0;
    const res = await browserMedia(access(), { type: "clip", clipId }, "video", []);
    expect(res).toMatchObject({ type: "video/mp4" });
    expect(fetched).toEqual([{ how: "preview", url: `https://play.test/${videoId}/playlist.m3u8`, from: 2160, to: 2214 }]);
  });

  it("shows the clip's own poster frame", async () => {
    const res = await browserMedia(access(), { type: "clip", clipId }, "still", []);
    expect(res).toEqual({ redirect: `https://thumb.test/${videoId}?t=2170` });
  });

  it("exports from the clip's footage, not the start of the match", async () => {
    fetched.length = 0;
    const resolve = creativeVideoResolver(venueId, "/tmp", []);
    await expect(resolve({} as never, { type: "clip", clipId }, { fromMs: 0, toMs: 54_000 })).rejects.toThrow(/no footage/i);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].from).toBe(2160);
    expect(fetched[0].to).toBeCloseTo(2214.5, 3);
  });
});

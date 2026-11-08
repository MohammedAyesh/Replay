import { beforeAll, describe, expect, it, vi } from "vitest";
import { academiesTable, db, fieldsTable, recordingsTable, userClipsTable, usersTable } from "@workspace/db";

/**
 * Picking a clip in the Creative hub must give that clip's footage — the
 * seconds the player cut — in the preview and the export, from camera 4K.
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

vi.mock("../clipExportSource", () => ({
  waitForCamera4kSource: vi.fn(async (id: string) => ({
    kind: "camera-4k",
    url: `https://replayjo.b-cdn.net/vod/${id}/4k.m3u8`,
    playlist: "#EXTM3U",
    path: "camera-original-4k HLS",
    duration: 5400,
    renditionLabel: null,
  })),
  Camera4kNotReadyError: class Camera4kNotReadyError extends Error {},
}));

vi.mock("../ffmpegExport", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ffmpegExport")>();
  return {
    ...real,
    bufferCameraHlsClip: vi.fn(async (options: { remoteUrl: string; startSec: number; clipDuration: number }) => {
      fetched.push({
        how: "4k-window",
        url: options.remoteUrl,
        from: options.startSec,
        to: options.startSec + options.clipDuration,
      });
      return {
        bufferPath: "/tmp/creative-4k-test.mp4",
        bufferedDuration: options.clipDuration,
        adjustedOffsetSec: 0,
        sourceDimensions: { width: 4096, height: 1152 },
        sourceTimeOffsetSec: 0,
        downloadedBytes: 1024,
      };
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

  it("previews only the clip's camera-4K window, from 36:00", async () => {
    fetched.length = 0;
    const res = await browserMedia(access(), { type: "clip", clipId }, "video", []);
    expect(res).toMatchObject({ type: "video/mp4" });
    expect(fetched).toEqual([{
      how: "4k-window",
      url: `https://replayjo.b-cdn.net/vod/${videoId}/4k.m3u8`,
      from: 2160,
      to: 2214,
    }]);
  });

  it("renders from camera 4K and keeps the saved clip's source time", async () => {
    fetched.length = 0;
    const resolve = creativeVideoResolver(venueId, "/tmp", []);
    const result = await resolve({} as never, { type: "clip", clipId }, { fromMs: 0, toMs: 54_000 });
    expect(result).toMatchObject({
      path: "/tmp/creative-4k-test.mp4",
      zeroAtSec: -0,
      durationMs: 54_000,
      sourceDimensions: { width: 4096, height: 1152 },
    });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toEqual({
      how: "4k-window",
      url: `https://replayjo.b-cdn.net/vod/${videoId}/4k.m3u8`,
      from: 2160,
      to: 2214,
    });
  });
});

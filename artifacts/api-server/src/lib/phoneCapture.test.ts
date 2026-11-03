import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyCapture,
  parseExifDate,
  parseIso6709,
  parseOffsetDate,
  readJpegExif,
  readMp4Meta,
  resolveCaptureTime,
  whatsappNameDate,
  type SessionWindow,
} from "@workspace/api-zod";
import { ammanDay } from "./phoneMedia";
import { jpegWithExif } from "./phoneCapture.test-helpers";

/**
 * Files made here copy each phone's metadata layout (an iPhone MOV's
 * QuickTime keys, an Android MP4's mvhd time, a WhatsApp forward's name, a
 * photo's EXIF); the reader is also checked on real photos in the findings doc.
 */

let dir: string;
const reader = (p: string) => {
  const fd = fs.openSync(p, "r");
  return async (o: number, n: number) => {
    const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, o);
    return new Uint8Array(b.subarray(0, r));
  };
};
const meta = async (p: string) => readMp4Meta(reader(p), fs.statSync(p).size);
const ff = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args]);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-capture-"));
  // iPhone: QuickTime keys with local time and its offset, and an ISO 6709 location.
  ff(["-f", "lavfi", "-i", "testsrc=d=4:s=320x180:r=30", "-c:v", "libx264",
    "-metadata", "creation_time=2026-11-01T15:05:32Z",
    "-metadata", "com.apple.quicktime.creationdate=2026-11-01T18:05:32+0300",
    "-metadata", "com.apple.quicktime.location.ISO6709=+31.9539+035.9106+0800.000/",
    "-metadata", "com.apple.quicktime.make=Apple", "-movflags", "use_metadata_tags", path.join(dir, "IMG_4821.MOV")]);
  // Samsung that writes Amman time labelled UTC, at the moment recording stopped; saved at the true stop time.
  ff(["-f", "lavfi", "-i", "testsrc=d=6:s=320x180:r=30", "-c:v", "libx264", "-metadata", "creation_time=2026-11-01T18:20:06Z", path.join(dir, "samsung.mp4")]);
  // A standard Android: UTC start.
  ff(["-f", "lavfi", "-i", "testsrc=d=10:s=320x180:r=30", "-c:v", "libx264", "-metadata", "creation_time=2026-11-01T16:40:00Z", path.join(dir, "pixel.mp4")]);
  // WhatsApp: re-encoded on forward, dated when it was forwarded.
  ff(["-f", "lavfi", "-i", "testsrc=d=5:s=320x180:r=30", "-c:v", "libx264", "-metadata", "creation_time=2026-11-02T09:41:10Z", path.join(dir, "VID-20261101-WA0007.mp4")]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const UPLOADED = new Date("2026-11-03T12:00:00Z");

describe("reading when a phone file was filmed", () => {
  it("iPhone: the QuickTime creation date with its offset, and the location", async () => {
    const m = await meta(path.join(dir, "IMG_4821.MOV"));
    expect(m).toMatchObject({ quicktimeCreationDate: "2026-11-01T18:05:32+0300", durationSec: 4, make: "Apple" });
    expect(parseIso6709(m!.location)).toEqual({ lat: 31.9539, lon: 35.9106 });
    const t = resolveCaptureTime({ kind: "video", fileName: "IMG_4821.MOV", ...m }, UPLOADED);
    expect(t).toMatchObject({ start: "2026-11-01T15:05:32.000Z", end: "2026-11-01T15:05:36.000Z", source: "quicktime", confidence: "high" });
  });

  it("Android writing Amman time labelled UTC, at the stop: both corrections, checked against the save time", async () => {
    const m = await meta(path.join(dir, "samsung.mp4"));
    expect(m?.mvhdCreation).toBe("2026-11-01T18:20:06.000Z");
    const t = resolveCaptureTime({ kind: "video", fileName: "samsung.mp4", lastModifiedMs: Date.parse("2026-11-01T15:20:06Z"), ...m }, UPLOADED);
    expect(t).toMatchObject({ start: "2026-11-01T15:20:00.000Z", end: "2026-11-01T15:20:06.000Z", source: "mvhd_local_stop", confidence: "high" });
  });

  it("standard Android: UTC start, confirmed by the save time", async () => {
    const m = await meta(path.join(dir, "pixel.mp4"));
    const t = resolveCaptureTime({ kind: "video", fileName: "pixel.mp4", lastModifiedMs: Date.parse("2026-11-01T16:40:11Z"), ...m }, UPLOADED);
    expect(t).toMatchObject({ start: "2026-11-01T16:40:00.000Z", source: "mvhd", confidence: "high" });
    // Without a save time it is still read as a UTC start, with less confidence.
    expect(resolveCaptureTime({ kind: "video", fileName: "pixel.mp4", ...m }, UPLOADED)).toMatchObject({ start: "2026-11-01T16:40:00.000Z", confidence: "medium" });
    // A file whose UTC reading would be after the upload must be local-labelled-UTC.
    const late = resolveCaptureTime({ kind: "video", fileName: "x.mp4", mvhdCreation: "2026-11-03T13:30:00.000Z", durationSec: 10 }, UPLOADED);
    expect(late.start).toBe("2026-11-03T10:30:00.000Z");
  });

  it("WhatsApp forward: only the day in the name, and the coach is asked", async () => {
    const m = await meta(path.join(dir, "VID-20261101-WA0007.mp4"));
    expect(whatsappNameDate("VID-20261101-WA0007.mp4")).toBe("2026-11-01");
    const t = resolveCaptureTime({ kind: "video", fileName: "VID-20261101-WA0007.mp4", ...m }, UPLOADED);
    expect(t).toMatchObject({ start: null, dateOnly: "2026-11-01", source: "whatsapp_date", confidence: "low" });
  });

  it("photos: EXIF DateTimeOriginal with its offset, GPS and orientation", () => {
    const jpg = jpegWithExif({ date: "2026:11:01 18:31:00", offset: "+03:00", lat: 31.954, lon: 35.9105, orientation: 6 });
    const e = readJpegExif(new Uint8Array(jpg));
    expect(e).toMatchObject({ dateTimeOriginal: "2026:11:01 18:31:00", offsetTimeOriginal: "+03:00", make: "Apple", orientation: 6 });
    expect(e!.gps!.lat).toBeCloseTo(31.954, 4);
    expect(e!.gps!.lon).toBeCloseTo(35.9105, 4);
    expect(resolveCaptureTime({ kind: "image", fileName: "IMG_1.jpg", ...e }, UPLOADED)).toMatchObject({ start: "2026-11-01T15:31:00.000Z", confidence: "high" });
    // No offset written: Amman time assumed.
    expect(parseExifDate("2026:11:01 18:31:00", null)).toEqual({ at: new Date("2026-11-01T15:31:00Z"), hadOffset: false });
    expect(readJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda]))).toBeNull();
  });

  it("parses offset dates and refuses a time without a zone", () => {
    expect(parseOffsetDate("2026-11-01T18:05:32+0300")?.toISOString()).toBe("2026-11-01T15:05:32.000Z");
    expect(parseOffsetDate("2026-11-01T18:05:32+03:00")?.toISOString()).toBe("2026-11-01T15:05:32.000Z");
    expect(parseOffsetDate("2026-11-01T15:05:32Z")?.toISOString()).toBe("2026-11-01T15:05:32.000Z");
    expect(parseOffsetDate("2026-11-01T18:05:32")).toBeNull();
  });

  it("a Samsung file name with date and time, when the file says nothing", () => {
    expect(resolveCaptureTime({ kind: "video", fileName: "20261101_183000.mp4", durationSec: 20 }, UPLOADED))
      .toMatchObject({ start: "2026-11-01T15:30:00.000Z", source: "file_date", confidence: "medium" });
    expect(resolveCaptureTime({ kind: "video", fileName: "clip.mp4" }, UPLOADED)).toMatchObject({ start: null, source: "none" });
  });
});

describe("before, during, after", () => {
  // Saturday 1 Nov: a match 18:00–19:40 Amman (15:00–16:40Z) with its recording from 18:00, and a training 20:30.
  const match: SessionWindow = {
    id: 1, start: new Date("2026-11-01T15:00:00Z"), end: new Date("2026-11-01T16:40:00Z"),
    recordingId: 900, recordingStart: new Date("2026-11-01T15:00:00Z"), recordingDurationSec: 6000,
  };
  const training: SessionWindow = { id: 2, start: new Date("2026-11-01T17:30:00Z"), end: new Date("2026-11-01T19:00:00Z"), recordingId: null, recordingStart: null, recordingDurationSec: null };
  const at = (start: string, seconds = 20) => ({ start, end: new Date(Date.parse(start) + seconds * 1000).toISOString(), dateOnly: null });
  const sort = (c: ReturnType<typeof at>, s = [match, training]) => classifyCapture(c, s, ammanDay);

  it("during: overlaps the session, with its offset into the panoramic recording", () => {
    expect(sort(at("2026-11-01T15:05:32Z"))).toMatchObject({ phase: "during", sessionId: 1, offsetSec: 332, recordingId: 900, needsReview: false });
    // 4 minutes after the planned end still counts (±5 minutes).
    expect(sort(at("2026-11-01T16:44:00Z"))).toMatchObject({ phase: "during", sessionId: 1 });
  });

  it("before: ends before kick-off and starts at most 3 hours before", () => {
    expect(sort(at("2026-11-01T14:20:00Z"))).toMatchObject({ phase: "before", sessionId: 1, offsetSec: null });
    expect(sort(at("2026-11-01T12:10:00Z"))).toMatchObject({ phase: "before", sessionId: 1 });
    expect(sort(at("2026-11-01T11:50:00Z"))).toMatchObject({ phase: "unlinked", needsReview: true, reason: "no_session" });
  });

  it("after: starts after the end, within 3 hours; with two sessions, the nearest", () => {
    // 16:50Z: 10 min after the match, 40 min before the training → after the match.
    expect(sort(at("2026-11-01T16:50:00Z"))).toMatchObject({ phase: "after", sessionId: 1 });
    // 17:20Z: 40 min after the match, 10 min before the training → before the training.
    expect(sort(at("2026-11-01T17:20:00Z"))).toMatchObject({ phase: "before", sessionId: 2 });
    // Overlapping one session wins over being near another.
    expect(sort(at("2026-11-01T17:25:00Z", 600))).toMatchObject({ phase: "during", sessionId: 2, offsetSec: null });
  });

  it("only a date: the coach picks from that day's sessions", () => {
    expect(classifyCapture({ start: null, end: null, dateOnly: "2026-11-01" }, [match, training], ammanDay))
      .toMatchObject({ phase: "unlinked", needsReview: true, reason: "date_only", candidates: [1, 2] });
    expect(classifyCapture({ start: null, end: null, dateOnly: null }, [match], ammanDay)).toMatchObject({ reason: "no_time", candidates: [] });
  });
});

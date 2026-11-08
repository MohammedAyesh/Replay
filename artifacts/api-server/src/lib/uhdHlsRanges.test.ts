import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  calculateSourceTimestampOffset,
  downloadHlsByteRangePlan,
  parseHlsByteRangePlan,
} from "./uhdHlsRanges";

const playlist = [
  "#EXTM3U",
  '#EXT-X-MAP:URI="4k.mp4",BYTERANGE="100@0"',
  ...Array.from({ length: 12 }, (_, index) => [
    "#EXTINF:3.000,",
    `#EXT-X-BYTERANGE:300@${100 + index * 300}`,
    "4k.mp4",
  ]).flat(),
  "#EXT-X-ENDLIST",
].join("\n");

describe("camera fMP4 HLS byte ranges", () => {
  it("selects only time-overlapping segments plus the init section", () => {
    const plan = parseHlsByteRangePlan(
      playlist,
      "https://storage.example/vod/original/4k.m3u8",
      15,
      16,
      { prerollSeconds: 4, postrollSeconds: 1 },
    );
    expect(plan.init).toEqual({
      url: "https://storage.example/vod/original/4k.mp4",
      start: 0,
      end: 99,
      length: 100,
    });
    expect(plan.segments.map(({ startTime, endTime, start, end }) => ({ startTime, endTime, start, end })))
      .toEqual([
        { startTime: 9, endTime: 12, start: 1000, end: 1299 },
        { startTime: 12, endTime: 15, start: 1300, end: 1599 },
        { startTime: 15, endTime: 18, start: 1600, end: 1899 },
      ]);
    expect(plan.selectedStartTime).toBe(9);
  });

  it("downloads ranges in parallel batches and writes init then segments in order", async () => {
    const plan = parseHlsByteRangePlan(playlist, "https://storage.example/4k.m3u8", 5, 6);
    const dir = await mkdtemp(path.join(os.tmpdir(), "uhd-range-test-"));
    const outputPath = path.join(dir, "assembled.mp4");
    const calls: string[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range")!;
      calls.push(range);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const length = Number(end) - Number(start) + 1;
      const body = new Uint8Array(length).fill(Number(start) % 251);
      return new Response(body, {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/10000` },
      });
    });
    try {
      const bytes = await downloadHlsByteRangePlan(plan, outputPath, "https://replayjo.com/", { fetcher, concurrency: 3 });
      const contents = await readFile(outputPath);
      expect(bytes).toBe(100 + plan.segments.reduce((sum, item) => sum + item.length, 0));
      expect(calls).toEqual([
        "bytes=0-99",
        "bytes=100-399",
        "bytes=400-699",
        "bytes=700-999",
      ]);
      expect(contents[0]).toBe(0);
      expect(contents[100]).toBe(100);
      expect(contents[400]).toBe(400 % 251);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed if the CDN ignores a Range header", async () => {
    const plan = parseHlsByteRangePlan(playlist, "https://storage.example/4k.m3u8", 5, 6);
    const dir = await mkdtemp(path.join(os.tmpdir(), "uhd-range-test-"));
    const outputPath = path.join(dir, "assembled.mp4");
    try {
      await expect(downloadHlsByteRangePlan(
        plan,
        outputPath,
        "https://replayjo.com/",
        { fetcher: vi.fn().mockResolvedValue(new Response("whole file", { status: 200 })) },
      )).rejects.toThrow("Byte-range request returned HTTP 200");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the measured container timestamp origin instead of assuming zero", () => {
    expect(calculateSourceTimestampOffset(0.033, 0)).toBeCloseTo(0.033, 3);
    expect(calculateSourceTimestampOffset(146.033, 146)).toBeCloseTo(0.033, 3);
    expect(() => calculateSourceTimestampOffset(4, 0)).toThrow("Unexpected HLS source timestamp offset");
  });
});

/**
 * Early Play: the full API matrix (2026-10-30).
 *
 * vps1, Bunny and the database are mocked; earlyPlay.ts and the shared
 * proxyProgressiveMp4 in hlsProxy.ts run for real. Every test uses its own
 * footage-request id, because earlyPlay.ts caches per request id for 30 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import express, { type Express } from "express";

type Row = { id: number };
const state = vi.hoisted(() => ({
  ctx: null as null | Record<string, any>,
  viewer: null as null | Record<string, any>,
  roster: [] as Array<{ userId: number; rsvp: string }>,
  academyRows: [] as Row[],
  ownerRows: [] as Row[],
  setting: true as boolean | (() => Promise<boolean>),
  job: null as null | (() => Promise<{ ok: boolean; status: number; body: unknown }>),
  play: null as null | (() => Promise<Response>),
  original: Buffer.alloc(0),
  originalStatus: 0,
  upstreamSignals: [] as AbortSignal[],
  hangAfterFirstChunk: false,
}));

vi.mock("@workspace/db", () => {
  const academyMembersTable = { __t: "academy", id: "id", academyId: "academyId", userId: "userId" };
  const fieldOwnersTable = { __t: "owner", id: "id", fieldId: "fieldId", userId: "userId" };
  const db = {
    select: () => ({
      from: (table: { __t: string }) => ({
        where: () => ({
          limit: async () => (table.__t === "academy" ? state.academyRows : state.ownerRows),
        }),
      }),
    }),
  };
  return { db, academyMembersTable, fieldOwnersTable };
});
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }));
vi.mock("../lib/bunny", () => ({ BUNNY_API_KEY: "lib-key", BUNNY_LIBRARY_ID: "694315" }));
vi.mock("../lib/clerkUserBridge", () => ({ getLocalUserRecord: vi.fn(async () => state.viewer) }));
vi.mock("../lib/settings", () => ({
  getSettingValue: vi.fn(async () => (typeof state.setting === "function" ? state.setting() : state.setting)),
}));
vi.mock("../lib/matchRooms", () => ({
  loadRoomByCode: vi.fn(async () => state.ctx),
  rosterFor: vi.fn(async () => state.roster),
  isPlaying: (p: { rsvp?: string } | null | undefined) => p?.rsvp === "in",
}));
vi.mock("../lib/gapStore", () => ({
  remoteJobPath: (cam: string, job: string) => (job.startsWith("gs-") ? `/gapstore/${cam}/pull/${job}` : `/record-hq/${cam}/${job}`),
}));
vi.mock("./contabo", () => ({
  controlFetch: vi.fn(async () => {
    if (!state.job) throw new Error("no job configured");
    return state.job();
  }),
}));
vi.mock("../lib/publicFootage", () => ({ canViewBunnyVideo: vi.fn(async () => true), extractBunnyVideoId: () => null }));
vi.mock("../lib/backupExport", () => ({ CHUNKED_EXPORT_LENGTH_THRESHOLD_BYTES: 30 * 1024 * 1024 }));

import router from "./earlyPlay";
import { PROGRESSIVE_MP4_RESPONSE_MAX_BYTES } from "./hlsProxy";
import { controlFetch } from "./contabo";

const GUID = "5f83ad1e-5856-4f61-8fd0-3f8a1cbdaa28";
const ORIGINAL = `https://vz-03425ccd-3d0.b-cdn.net/${GUID}/original`;
let nextId = 1000;

function ctx(over: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    room: { id, code: `M${id}`, captainUserId: 1, fieldId: 7 },
    request: { id, status: "running", academyId: null, vpsJobId: "8a4cc5a60c24", cameraId: "camera1", videoId: null, ...over },
    field: { id: 7 },
  };
}
const job = (body: unknown, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, body });
const uploadedJob = (extra: Record<string, unknown> = {}) =>
  job({ status: "running", phase: "encode", uploaded: true, videoId: GUID, encodeProgress: 37, ...extra });
const playJson = (body: unknown, status = 200) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const earlyPlay = (videoOver: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  playJson({ allowEarlyPlay: true, originalUrl: ORIGINAL, video: { status: 3, length: 1801, ...videoOver }, ...top });

function serveOriginal(url: string, init?: RequestInit): Response {
  if (init?.signal) state.upstreamSignals.push(init.signal);
  if (state.originalStatus) return new Response("denied", { status: state.originalStatus });
  const total = state.original.length;
  const range = new Headers(init?.headers).get("range") ?? "";
  const m = range.match(/^bytes=(\d+)-(\d*)$/);
  const start = m ? Number(m[1]) : 0;
  if (start >= total) {
    return new Response("", { status: 416, headers: { "content-range": `bytes */${total}` } });
  }
  const end = Math.min(m && m[2] ? Number(m[2]) : total - 1, total - 1);
  const slice = state.original.subarray(start, end + 1);
  if (state.hangAfterFirstChunk) {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(slice.subarray(0, 65536)));
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return new Response(body, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${total}`, "content-type": "application/octet-stream" } });
  }
  return new Response(slice, {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${total}`, "content-type": "application/octet-stream" },
  });
}

let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  app = express();
  app.use("/api", router);
  state.ctx = ctx();
  state.viewer = { id: 1, isAdmin: false, isGuest: false };
  state.roster = [{ userId: 1, rsvp: "in" }];
  state.academyRows = [];
  state.ownerRows = [];
  state.setting = true;
  state.job = uploadedJob();
  state.play = earlyPlay();
  state.original = Buffer.alloc(0);
  state.originalStatus = 0;
  state.upstreamSignals = [];
  state.hangAfterFirstChunk = false;
  vi.mocked(controlFetch).mockClear();
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://video.bunnycdn.com/")) {
      if (!state.play) throw new Error("no play configured");
      return state.play();
    }
    if (url.includes(".b-cdn.net/")) return serveOriginal(url, init);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const status = (code = state.ctx!.room.code) => request(app).get(`/api/matches/${code}/early-play`);
const video = (range?: string, code = state.ctx!.room.code) => {
  const r = request(app).get(`/api/matches/${code}/early-play/video`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  return range ? r.set("Range", range) : r;
};
const bunnyCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("video.bunnycdn.com")).length;

describe("early-play status: states", () => {
  it("ready when the footage request is already ready", async () => {
    state.ctx = ctx({ status: "ready" });
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("ready");
    expect(controlFetch).not.toHaveBeenCalled();
  });
  it("ready when the footage request is partial", async () => {
    state.ctx = ctx({ status: "partial" });
    expect((await status()).body.state).toBe("ready");
  });
  it("waiting when vps1 has no job yet", async () => {
    state.ctx = ctx({ vpsJobId: null });
    const r = await status();
    expect(r.body).toMatchObject({ state: "waiting" });
    expect(controlFetch).not.toHaveBeenCalled();
  });
  it("waiting when the videoId exists but the upload has not finished", async () => {
    state.job = job({ status: "running", phase: "upload", uploaded: false, videoId: GUID });
    const r = await status();
    expect(r.body).toMatchObject({ state: "waiting", phase: "upload" });
    expect(bunnyCalls()).toBe(0);
  });
  it("waiting when there is no videoId at all", async () => {
    state.job = job({ status: "running", phase: "download", percent: 40 });
    expect((await status()).body).toMatchObject({ state: "waiting", phase: "download" });
  });
  it("early once uploaded:true, with streamUrl, codec, progress and duration", async () => {
    const r = await status();
    expect(r.body).toMatchObject({
      state: "early",
      streamUrl: `/api/matches/${state.ctx!.room.code}/early-play/video`,
      codec: "hvc1",
      encodeProgress: 37,
      durationSec: 1801,
    });
  });
  it("early for an old job with no `uploaded` field in phase encode", async () => {
    state.job = job({ status: "running", phase: "encode", videoId: GUID });
    expect((await status()).body.state).toBe("early");
  });
  it("an old job with no `uploaded` field in phase upload is still waiting", async () => {
    state.job = job({ status: "running", phase: "upload", videoId: GUID });
    expect((await status()).body.state).toBe("waiting");
  });
  it("uses the gapstore status path for gs- jobs", async () => {
    state.ctx = ctx({ vpsJobId: "gs-31afa0d9b27b" });
    await status();
    expect(vi.mocked(controlFetch).mock.calls[0][0]).toBe("/gapstore/camera1/pull/gs-31afa0d9b27b");
  });
  it("encodeProgress is clamped to 0..100", async () => {
    state.job = uploadedJob({ encodeProgress: 250 });
    expect((await status()).body.encodeProgress).toBe(100);
  });
});

describe("early-play status: Bunny outcomes", () => {
  it("Bunny status 4 → ready", async () => {
    state.play = earlyPlay({ status: 4 });
    expect((await status()).body.state).toBe("ready");
  });
  it.each([5, 6])("Bunny status %i → bunny_failed", async (s) => {
    state.play = earlyPlay({ status: s });
    expect((await status()).body).toMatchObject({ state: "unavailable", reasonCode: "bunny_failed" });
  });
  it("allowEarlyPlay false → early_play_off", async () => {
    state.play = earlyPlay({}, { allowEarlyPlay: false });
    expect((await status()).body).toMatchObject({ state: "unavailable", reasonCode: "early_play_off" });
  });
  it("originalUrl null (uploaded before the setting) → early_play_off", async () => {
    state.play = earlyPlay({}, { originalUrl: null });
    expect((await status()).body.reasonCode).toBe("early_play_off");
  });
  it("originalUrl on a foreign host is refused → early_play_off", async () => {
    state.play = earlyPlay({}, { originalUrl: `https://evil.example.com/${GUID}/original` });
    expect((await status()).body.reasonCode).toBe("early_play_off");
  });
  it("originalUrl for a different guid is refused → early_play_off", async () => {
    state.play = earlyPlay({}, { originalUrl: "https://vz-03425ccd-3d0.b-cdn.net/other-guid/original" });
    expect((await status()).body.reasonCode).toBe("early_play_off");
  });
  it("Bunny 404 → bunny_not_found", async () => {
    state.play = playJson("", 404);
    expect((await status()).body).toMatchObject({ state: "unavailable", reasonCode: "bunny_not_found" });
  });
  it("Bunny 500 → bunny_error", async () => {
    state.play = playJson({ error: "boom" }, 500);
    expect((await status()).body.reasonCode).toBe("bunny_error");
  });
  it("Bunny timeout / network error → bunny_error", async () => {
    state.play = async () => { throw new DOMException("timed out", "TimeoutError"); };
    expect((await status()).body.reasonCode).toBe("bunny_error");
  });
  it("Bunny bad JSON → bunny_error", async () => {
    state.play = playJson("<html>not json</html>");
    expect((await status()).body.reasonCode).toBe("bunny_error");
  });
  it("Bunny JSON array → bunny_error", async () => {
    state.play = playJson([1, 2]);
    expect((await status()).body.reasonCode).toBe("bunny_error");
  });
  it("Bunny with no numeric status → bunny_error", async () => {
    state.play = earlyPlay({ status: "3" });
    expect((await status()).body.reasonCode).toBe("bunny_error");
  });
});

describe("early-play status: vps1 outcomes", () => {
  it("vps1 throws (unreachable / timeout) → vps_unreachable", async () => {
    state.job = async () => { throw new Error("ETIMEDOUT"); };
    expect((await status()).body).toMatchObject({ state: "unavailable", reasonCode: "vps_unreachable" });
  });
  it("vps1 404 → vps_unreachable", async () => {
    state.job = job({ detail: "Not Found" }, 404);
    expect((await status()).body.reasonCode).toBe("vps_unreachable");
  });
  it("vps1 non-JSON body → vps_unreachable", async () => {
    state.job = job("Internal Server Error", 200);
    expect((await status()).body.reasonCode).toBe("vps_unreachable");
  });
  it("vps1 500 → vps_unreachable", async () => {
    state.job = job({ error: "x" }, 500);
    expect((await status()).body.reasonCode).toBe("vps_unreachable");
  });
  it("job cancelled on vps1 → request_cancelled", async () => {
    state.job = job({ status: "cancelled", phase: "failed" });
    expect((await status()).body).toMatchObject({ state: "unavailable", reasonCode: "request_cancelled" });
  });
  it("admin setting off → disabled, with no vps1 or Bunny calls", async () => {
    state.setting = false;
    expect((await status()).body).toMatchObject({ state: "unavailable", reasonCode: "disabled" });
    expect(controlFetch).not.toHaveBeenCalled();
    expect(bunnyCalls()).toBe(0);
  });
  it("the settings lookup crashing is reported, not a 500", async () => {
    state.setting = async () => { throw new Error("db down"); };
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("unavailable");
  });
});

describe("early-play access", () => {
  it("a player booking is 404 for a signed-in non-member", async () => {
    state.viewer = { id: 99, isAdmin: false, isGuest: false };
    expect((await status()).status).toBe(404);
    expect((await video("bytes=0-1")).status).toBe(404);
  });
  it("a player booking is 404 for a signed-out visitor", async () => {
    state.viewer = null;
    expect((await status()).status).toBe(404);
  });
  it("a roster member who said no is not let in", async () => {
    state.viewer = { id: 5, isAdmin: false, isGuest: false };
    state.roster = [{ userId: 5, rsvp: "out" }];
    expect((await status()).status).toBe(404);
  });
  it("the captain is let in", async () => {
    state.roster = [];
    expect((await status()).status).toBe(200);
  });
  it("the field owner is let in", async () => {
    state.viewer = { id: 50, isAdmin: false, isGuest: false };
    state.ownerRows = [{ id: 3 }];
    expect((await status()).status).toBe(200);
  });
  it("an admin is let in", async () => {
    state.viewer = { id: 51, isAdmin: true, isGuest: false };
    expect((await status()).status).toBe(200);
  });
  it("an academy match is 404 for a non-member, even an admin player", async () => {
    state.ctx = ctx({ academyId: 4 });
    state.viewer = { id: 1, isAdmin: false, isGuest: false };
    state.academyRows = [];
    expect((await status()).status).toBe(404);
  });
  it("an academy match is OK for an academy member", async () => {
    state.ctx = ctx({ academyId: 4 });
    state.academyRows = [{ id: 9 }];
    expect((await status()).status).toBe(200);
  });
  it("an academy guest account is refused", async () => {
    state.ctx = ctx({ academyId: 4 });
    state.viewer = { id: 1, isAdmin: false, isGuest: true };
    state.academyRows = [{ id: 9 }];
    expect((await status()).status).toBe(404);
  });
  it.each(["cancelled", "failed", "refunded"])("a %s request is 404 for everyone", async (s) => {
    state.ctx = ctx({ status: s });
    state.viewer = { id: 51, isAdmin: true, isGuest: false };
    expect((await status()).status).toBe(404);
  });
  it("an unknown match code is 404", async () => {
    state.ctx = null;
    expect((await request(app).get("/api/matches/NOPE/early-play")).status).toBe(404);
  });
  it("a getLocalUserRecord crash is treated as signed out, not a 500", async () => {
    const { getLocalUserRecord } = await import("../lib/clerkUserBridge");
    vi.mocked(getLocalUserRecord).mockRejectedValueOnce(new Error("clerk down"));
    expect((await status()).status).toBe(404);
  });
});

describe("early-play directUrl host gate", () => {
  it("is present only for Host replayjo.com", async () => {
    const r = await status().set("Host", "replayjo.com");
    expect(r.body.directUrl).toBe(ORIGINAL);
  });
  it.each(["www.replayjo.com", "x.kirk.replit.dev", "replayjo.replit.app", "replayjo.com.evil.io"])("is absent for %s", async (host) => {
    const r = await status().set("Host", host);
    expect(r.body.state).toBe("early");
    expect(r.body.directUrl).toBeUndefined();
  });
  it("uses x-forwarded-host only when trust proxy is on", async () => {
    const r1 = await status().set("Host", "internal.local").set("X-Forwarded-Host", "replayjo.com");
    expect(r1.body.directUrl).toBeUndefined();
    app.set("trust proxy", true);
    const r2 = await status().set("Host", "internal.local").set("X-Forwarded-Host", "replayjo.com, proxy");
    expect(r2.body.directUrl).toBe(ORIGINAL);
  });
  it("is never sent for non-early states", async () => {
    state.job = job({ status: "running", phase: "upload", uploaded: false, videoId: GUID });
    const r = await status().set("Host", "replayjo.com");
    expect(r.body.directUrl).toBeUndefined();
  });
});

describe("early-play cache", () => {
  it("two calls within 30 s make one vps1 call and one Bunny call", async () => {
    await status();
    await status();
    expect(controlFetch).toHaveBeenCalledTimes(1);
    expect(bunnyCalls()).toBe(1);
  });
  it("concurrent calls share one in-flight lookup", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    state.job = async () => { await gate; return { ok: true, status: 200, body: { status: "running", phase: "encode", uploaded: true, videoId: GUID } }; };
    const a = status();
    const b = status();
    const c = status();
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra.body.state, rb.body.state, rc.body.state]).toEqual(["early", "early", "early"]);
    expect(controlFetch).toHaveBeenCalledTimes(1);
  });
  it("after 30 s it looks again", async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    await status();
    spy.mockReturnValue(now + 31_000);
    await status();
    expect(controlFetch).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("early-play video proxy", () => {
  beforeEach(() => {
    state.original = Buffer.alloc(40 * 1024 * 1024);
    for (let i = 0; i < state.original.length; i += 4096) state.original.writeUInt32BE(i, i);
  });

  it("bytes=0-1 → 206 with exactly 2 bytes, video/mp4", async () => {
    const r = await video("bytes=0-1");
    expect(r.status).toBe(206);
    expect(r.headers["content-type"]).toBe("video/mp4");
    expect(r.headers["content-range"]).toBe(`bytes 0-1/${state.original.length}`);
    expect((r.body as Buffer).length).toBe(2);
  });
  it("bytes=0- is capped at PROGRESSIVE_MP4_RESPONSE_MAX_BYTES with an honest Content-Range", async () => {
    const r = await video("bytes=0-");
    expect(r.status).toBe(206);
    const len = (r.body as Buffer).length;
    expect(len).toBe(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES);
    expect(r.headers["content-length"]).toBe(String(len));
    expect(r.headers["content-range"]).toBe(`bytes 0-${len - 1}/${state.original.length}`);
    expect((r.body as Buffer).equals(state.original.subarray(0, len))).toBe(true);
  });
  it("a bounded range larger than the cap is capped too", async () => {
    const r = await video(`bytes=1000-${30 * 1024 * 1024}`);
    expect(r.status).toBe(206);
    expect((r.body as Buffer).length).toBe(PROGRESSIVE_MP4_RESPONSE_MAX_BYTES);
    expect(r.headers["content-range"]).toBe(`bytes 1000-${1000 + PROGRESSIVE_MP4_RESPONSE_MAX_BYTES - 1}/${state.original.length}`);
  });
  it("a mid-file range returns the right bytes", async () => {
    const start = 20 * 1024 * 1024 + 4096;
    const r = await video(`bytes=${start}-${start + 8191}`);
    expect(r.status).toBe(206);
    expect((r.body as Buffer).equals(state.original.subarray(start, start + 8192))).toBe(true);
  });
  it("the last bytes of the file", async () => {
    const total = state.original.length;
    const r = await video(`bytes=${total - 10}-`);
    expect(r.status).toBe(206);
    expect((r.body as Buffer).length).toBe(10);
    expect(r.headers["content-range"]).toBe(`bytes ${total - 10}-${total - 1}/${total}`);
  });
  it("start beyond the end → 416", async () => {
    const r = await video(`bytes=${state.original.length + 5}-`);
    expect(r.status).toBe(416);
  });
  it.each(["bytes=abc", "bytes=5-2", "items=0-1", "bytes=0-1,5-6"])("malformed Range %s → 416", async (range) => {
    const r = await video(range);
    expect(r.status).toBe(416);
  });
  it("upstream 403 → 403 with a plain message, no stack trace", async () => {
    state.originalStatus = 403;
    const r = await video("bytes=0-1");
    expect(r.status).toBe(403);
    expect(String(r.body)).not.toMatch(/at .*\.ts|Error:/);
  });
  it("upstream 404 → 404 'Original video not found'", async () => {
    state.originalStatus = 404;
    const r = await video("bytes=0-1");
    expect(r.status).toBe(404);
    expect(String(r.body)).toContain("Original video not found");
  });
  it("Bunny reaching status 4 meanwhile → 409 {state: ready}", async () => {
    state.play = earlyPlay({ status: 4 });
    const r = await request(app).get(`/api/matches/${state.ctx!.room.code}/early-play/video`).set("Range", "bytes=0-1");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ state: "ready" });
  });
  it("not early yet → 503 with the reason, never the bytes", async () => {
    state.job = job({ status: "running", phase: "upload", uploaded: false, videoId: GUID });
    const r = await request(app).get(`/api/matches/${state.ctx!.room.code}/early-play/video`).set("Range", "bytes=0-1");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("waiting");
  });
  it("a cancelled job → 404", async () => {
    state.job = job({ status: "cancelled" });
    const r = await request(app).get(`/api/matches/${state.ctx!.room.code}/early-play/video`).set("Range", "bytes=0-1");
    expect(r.status).toBe(404);
  });
  it("sends the Referer Bunny's pull zone needs, and never the client's own headers", async () => {
    await video("bytes=0-1").set("Cookie", "session=secret");
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/original"))!;
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get("referer")).toMatch(/^https:\/\/.+\.b-cdn\.net\/$/);
    expect(headers.get("cookie")).toBeNull();
  });
  it("only ever fetches the guid Bunny reported, whatever the client sends", async () => {
    await request(app).get(`/api/matches/${state.ctx!.room.code}/early-play/video?url=https://evil.example.com/x`).set("Range", "bytes=0-1");
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(".b-cdn.net"));
    expect(urls.every((u) => u === ORIGINAL)).toBe(true);
  });
  it("a client that disconnects aborts the upstream fetch", async () => {
    state.hangAfterFirstChunk = true;
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = http.get({ port, path: `/api/matches/${state.ctx!.room.code}/early-play/video`, headers: { Range: "bytes=0-" } }, (res) => {
        res.once("data", () => { req.destroy(); resolve(); });
      });
      req.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));
    server.close();
    expect(state.upstreamSignals.length).toBeGreaterThan(0);
    expect(state.upstreamSignals.some((s) => s.aborted)).toBe(true);
  });
});

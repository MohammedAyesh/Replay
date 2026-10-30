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

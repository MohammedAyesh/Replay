import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLocalUserRecord = vi.fn();
const mockIsFieldOwner = vi.fn();
const mockCaptainMatches = vi.fn();
const mockLoadRoomByCode = vi.fn();
const mockControlFetch = vi.fn();

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: (...args: unknown[]) => mockGetLocalUserRecord(...args),
  unauthenticatedResponse: (_res: express.Response, _req: express.Request) => {},
}));
vi.mock("@workspace/db", () => {
  const fieldsTable = { id: "fields.id", cameraId: "fields.cameraId" };
  const fieldOwnersTable = { id: "owners.id", userId: "owners.userId", fieldId: "owners.fieldId" };
  const matchRoomsTable = { code: "rooms.code", fieldId: "rooms.fieldId", captainUserId: "rooms.captainUserId" };
  return {
    db: {
      select: () => {
        let selectedTable: unknown;
        return {
          from: (table: unknown) => {
            selectedTable = table;
            return {
              where: () => ({
                limit: async () => {
                  if (selectedTable === fieldsTable) return [{ id: 5, cameraId: "camera1" }];
                  if (selectedTable === fieldOwnersTable) return mockIsFieldOwner() ? [{ id: 1 }] : [];
                  if (selectedTable === matchRoomsTable) return mockCaptainMatches() ? [{ code: "ABC123" }] : [];
                  return [];
                },
              }),
            };
          },
        };
      },
    },
    fieldOwnersTable,
    fieldsTable,
    matchRoomsTable,
  };
});
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
}));
vi.mock("../lib/matchRooms", () => ({
  loadRoomByCode: (...args: unknown[]) => mockLoadRoomByCode(...args),
  matchPhase: () => "live",
}));
vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./contabo", () => ({
  controlFetch: (...args: unknown[]) => mockControlFetch(...args),
}));

import streamingRouter from "./streaming";

const YOUTUBE_URL = "rtmp://a.rtmp.youtube.com/live2";
const FACEBOOK_URL = "rtmps://live-api-s.facebook.com:443/rtmp/";
const streamKeyForTest = "secret-stream-key";

function appFor(user: { id: number; isAdmin: boolean; isGuest: boolean } | null) {
  mockGetLocalUserRecord.mockResolvedValue(user);
  const app = express();
  app.use(express.json());
  app.use("/api", streamingRouter);
  return app;
}

function controlResult(
  body: unknown,
  status = 200,
): { ok: boolean; status: number; body: unknown } {
  return { ok: status >= 200 && status < 300, status, body };
}

describe("RTMP streaming routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTABO_CONTROL_KEY = "test-control-key";
    mockIsFieldOwner.mockReturnValue(false);
    mockLoadRoomByCode.mockResolvedValue({
      room: { captainUserId: 2, fieldId: 5 },
      field: { cameraId: "camera1" },
    });
  });

  it("proxies status only for admins when no field or match context is supplied", async () => {
    mockControlFetch.mockResolvedValue(controlResult({
      cam: "camera1",
      state: "running",
      variant: "pan",
      rtmp_url: YOUTUBE_URL,
      startedAt: 123,
      stream_key: streamKeyForTest,
      privateToken: "must-not-leak",
    }));

    const response = await request(appFor({ id: 1, isAdmin: true, isGuest: false }))
      .get("/api/live/rtmp/status/camera1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      cam: "camera1",
      state: "running",
      variant: "pan",
      rtmp_url: YOUTUBE_URL,
      startedAt: 123,
    });
    expect(mockControlFetch).toHaveBeenCalledWith(
      "/live/rtmp/status/camera1",
      {},
      15_000,
      "http://169.58.73.17:8080",
    );
  });

  it("allows a field owner only when the camera matches that field", async () => {
    mockIsFieldOwner.mockReturnValue(true);
    mockControlFetch.mockResolvedValue(controlResult({ cam: "camera1", state: "off" }));

    const response = await request(appFor({ id: 2, isAdmin: false, isGuest: false }))
      .get("/api/live/rtmp/status/camera1");
    expect(response.status).toBe(200);

    const wrongCamera = await request(appFor({ id: 2, isAdmin: false, isGuest: false }))
      .get("/api/live/rtmp/status/camera2");
    expect(wrongCamera.status).toBe(404);
    expect(mockControlFetch).toHaveBeenCalledTimes(1);
  });

  it("allows the captain of an active match to read the camera status", async () => {
    mockCaptainMatches.mockReturnValue(true);
    mockControlFetch.mockResolvedValue(controlResult({ cam: "camera1", state: "off" }));

    const response = await request(appFor({ id: 2, isAdmin: false, isGuest: false }))
      .get("/api/live/rtmp/status/camera1");
    expect(response.status).toBe(200);
    expect(mockLoadRoomByCode).toHaveBeenCalledWith("ABC123");

    mockCaptainMatches.mockReturnValue(false);
    const denied = await request(appFor({ id: 3, isAdmin: false, isGuest: false }))
      .get("/api/live/rtmp/status/camera1");
    expect(denied.status).toBe(403);
    expect(mockControlFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream key out of the browser-facing response and POST body", async () => {
    mockControlFetch.mockResolvedValue(controlResult({
      cam: "camera1",
      state: "starting",
      variant: "hevc",
      rtmp_url: YOUTUBE_URL,
      startedAt: 456,
      stream_key: streamKeyForTest,
    }));

    const response = await request(appFor({ id: 1, isAdmin: true, isGuest: false }))
      .post("/api/live/rtmp/start/camera1")
      .send({
        platform: "youtube",
        rtmpUrl: YOUTUBE_URL,
        streamKey: streamKeyForTest,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      cam: "camera1",
      state: "starting",
      variant: "hevc",
      rtmp_url: YOUTUBE_URL,
      startedAt: 456,
    });
    expect(JSON.stringify(response.body)).not.toContain(streamKeyForTest);

    const [upstreamPath, upstreamOptions, timeoutMs, baseUrl] = mockControlFetch.mock.calls[0] as [
      string,
      RequestInit,
      number,
      string,
    ];
    const upstreamUrl = new URL(upstreamPath, baseUrl);
    expect(baseUrl).toBe("http://169.58.73.17:8080");
    expect(upstreamUrl.pathname).toBe("/live/rtmp/start/camera1");
    expect(upstreamUrl.searchParams.get("rtmp_url")).toBe(YOUTUBE_URL);
    expect(upstreamUrl.searchParams.get("stream_key")).toBe(streamKeyForTest);
    expect(upstreamOptions.method).toBe("POST");
    expect(upstreamOptions.body).toBeUndefined();
    expect(timeoutMs).toBe(15_000);
  });

  it("rejects RTMP URLs with query parameters before forwarding credentials", async () => {
    const response = await request(appFor({ id: 1, isAdmin: true, isGuest: false }))
      .post("/api/live/rtmp/start/camera1")
      .send({
        platform: "youtube",
        rtmpUrl: `${YOUTUBE_URL}?key=should-not-be-forwarded`,
        streamKey: streamKeyForTest,
      });

    expect(response.status).toBe(400);
    expect(mockControlFetch).not.toHaveBeenCalled();
  });

  it("stops an authorized stream and returns only the off state", async () => {
    mockControlFetch.mockResolvedValue(controlResult({
      cam: "camera1",
      state: "off",
      stream_key: streamKeyForTest,
      rtmp_url: `${YOUTUBE_URL}?key=${streamKeyForTest}`,
    }));

    const response = await request(appFor({ id: 1, isAdmin: true, isGuest: false }))
      .post("/api/live/rtmp/stop/camera1")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cam: "camera1", state: "off" });
    expect(mockControlFetch).toHaveBeenCalledWith(
      "/live/rtmp/stop/camera1",
      { method: "POST" },
      15_000,
      "http://169.58.73.17:8080",
    );
  });

  it("does not allow a regular signed-in user to use direct camera controls", async () => {
    const response = await request(appFor({ id: 3, isAdmin: false, isGuest: false }))
      .get("/api/live/rtmp/status/camera1");
    expect(response.status).toBe(403);
    expect(mockControlFetch).not.toHaveBeenCalled();
  });

  it("does not allow guest accounts to control streams", async () => {
    const response = await request(appFor({ id: 4, isAdmin: false, isGuest: true }))
      .get("/api/live/rtmp/status/camera1");
    expect(response.status).toBe(403);
    expect(mockControlFetch).not.toHaveBeenCalled();
  });
});
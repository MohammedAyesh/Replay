import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import {
  db,
  fieldOwnersTable,
  fieldsTable,
  footagePaymentsTable,
  footageRequestsTable,
  varMarksTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(),
  unauthenticatedResponse: vi.fn(),
}));

import { getLocalUserRecord } from "../lib/clerkUserBridge";
import ownerRouter from "./owner";
import { isVarActive } from "./owner";

const mockedGetLocalUserRecord = vi.mocked(getLocalUserRecord);
const TAG = `owner_${Date.now()}`;
const oldStart = "2020-01-01 10:00";
const oldEnd = "2020-01-01 10:15";

let app: Express;
let ownerId: number;
let otherUserId: number;
let adminId: number;
let fieldAId: number;
let fieldBId: number;
let requestIds: number[] = [];
let paymentIds: number[] = [];
let realFetch: typeof fetch;
let availableHours = Array.from({ length: 24 }, (_, hour) => ({ hour }));
let recordPostUrls: string[] = [];
let varUrls: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function futureLocalWindow(daysAhead: number): { startLocal: string; endLocal: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000))
    .map((part) => [part.type, part.value]));
  const startLocal = `${parts.year}-${parts.month}-${parts.day} 10:00`;
  return { startLocal, endLocal: `${parts.year}-${parts.month}-${parts.day} 10:15` };
}

function activeLocalWindow(): { startLocal: string; endLocal: string } {
  const startMs = Math.floor((Date.now() - 60 * 1000) / (60 * 1000)) * (60 * 1000);
  const format = (value: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Amman",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  return { startLocal: format(startMs), endLocal: format(startMs + 15 * 60 * 1000) };
}

function localInstantSeconds(value: string): number {
  return Math.floor(Date.parse(`${value.replace(" ", "T")}:00.000Z`) / 1000) - 3 * 60 * 60;
}

beforeAll(async () => {
  process.env.CONTABO_CONTROL_URL = "https://owner-control.test";
  process.env.CONTABO_CONTROL_KEY = "test-control-key";
  process.env.PUBLIC_SHARE_BASE_URL = "https://owner.example.test";

  app = express();
  app.use(express.json());
  app.use("/api", ownerRouter);

  const [owner] = await db.insert(usersTable).values({
    name: `Owner ${TAG}`,
    email: `${TAG}_owner@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  const [other] = await db.insert(usersTable).values({
    name: `Other ${TAG}`,
    email: `${TAG}_other@test.local`,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  const [admin] = await db.insert(usersTable).values({
    name: `Admin ${TAG}`,
    email: `${TAG}_admin@test.local`,
    isAdmin: true,
    profileComplete: true,
  }).returning({ id: usersTable.id });
  ownerId = owner.id;
  otherUserId = other.id;
  adminId = admin.id;

  const [fieldA] = await db.insert(fieldsTable).values({
    name: `Owner Field A ${TAG}`,
    location: "Test",
    cameraId: `owner-camera-a-${TAG}`,
  }).returning({ id: fieldsTable.id });
  const [fieldB] = await db.insert(fieldsTable).values({
    name: `Owner Field B ${TAG}`,
    location: "Test",
    cameraId: `owner-camera-b-${TAG}`,
  }).returning({ id: fieldsTable.id });
  fieldAId = fieldA.id;
  fieldBId = fieldB.id;
  await db.insert(fieldOwnersTable).values({ userId: ownerId, fieldId: fieldAId });

  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/var/")) {
      varUrls.push(url);
      if (url.includes("/playlist.m3u8")) {
        return new Response([
          "#EXTM3U",
          '#EXT-X-MAP:URI="/var/cam1/hls/seg/init.mp4"',
          "#EXTINF:1.0,",
          "/var/cam1/hls/seg/one.m4s",
          "/var/cam1/hls/seg/two.m4s",
          "",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (url.includes("/seg/")) {
        return new Response("segment-bytes", {
          headers: { "content-type": "video/mp4" },
        });
      }
      if (url.includes("/window")) {
        return jsonResponse({
          cam: "cam1",
          variants: {
            hls: { present: true, segments: 3, newestAgeSec: 4.3, live: true },
            hevc: { present: true, segments: 3, newestAgeSec: 4.3, live: true },
          },
        });
      }
    }
    if (url.includes("/sd/")) {
      return jsonResponse({ hours: availableHours });
    }
    if (url.includes("/record-hq/") && init?.method === "POST") {
      recordPostUrls.push(url);
      return jsonResponse({ jobId: "job-owner-test" });
    }
    if (url.includes("/record-hq/")) {
      return jsonResponse({
        status: "done",
        videoId: "video-owner-test",
        updatedAt: "2026-09-21T12:00:00.000Z",
      });
    }
    return realFetch(input, init);
  });
});

beforeEach(() => {
  availableHours = Array.from({ length: 24 }, (_, hour) => ({ hour }));
  recordPostUrls = [];
  varUrls = [];
  mockedGetLocalUserRecord.mockResolvedValue({
    id: ownerId,
    isGuest: false,
    isAdmin: false,
  } as Awaited<ReturnType<typeof getLocalUserRecord>>);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (requestIds.length) {
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, requestIds));
  }
  if (paymentIds.length) {
    await db.delete(footagePaymentsTable).where(inArray(footagePaymentsTable.id, paymentIds));
  }
  await db.delete(fieldOwnersTable).where(inArray(fieldOwnersTable.fieldId, [fieldAId, fieldBId]));
  await db.delete(fieldsTable).where(inArray(fieldsTable.id, [fieldAId, fieldBId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerId, otherUserId, adminId]));
});

describe("owner access guards", () => {
  it("returns 403 when an owner tampers with the field id", async () => {
    await request(app).get(`/api/owner/fields/${fieldBId}/requests`).expect(403);
  });

  it("returns 403 for a non-owner", async () => {
    mockedGetLocalUserRecord.mockResolvedValue({
      id: otherUserId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    await request(app).get(`/api/owner/fields/${fieldAId}/requests`).expect(403);
  });

  it("allows an admin to list all camera-backed fields", async () => {
    mockedGetLocalUserRecord.mockResolvedValue({
      id: adminId,
      isGuest: false,
      isAdmin: true,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    const response = await request(app).get("/api/owner/fields").expect(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fieldAId, cameraId: `owner-camera-a-${TAG}` }),
      expect.objectContaining({ id: fieldBId, cameraId: `owner-camera-b-${TAG}` }),
    ]));
  });
});

describe("owner request validation", () => {
  it.each([
    ["more than 4 hours", "2020-01-01 00:00", "2020-01-01 04:15", "Footage requests cannot exceed 4 hours"],
    ["less than 15 minutes", "2020-01-01 00:00", "2020-01-01 00:00", "Footage requests must be at least 15 minutes"],
    ["not a 15-minute step", "2020-01-01 00:00", "2020-01-01 00:10", "Start and end must be on a 15-minute step"],
    ["too far ahead", "2999-01-01 10:00", "2999-01-01 10:15", "Footage can only be booked up to 14 days ahead"],
  ])("rejects %s with 400", async (_name, startLocal, endLocal, message) => {
    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send({ startLocal, endLocal })
      .expect(400);
    expect(response.body.error).toBe(message);
  });

  it("rejects a request for an unavailable hour", async () => {
    availableHours = [];
    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send({ startLocal: oldStart, endLocal: oldEnd })
      .expect(400);
    expect(response.body.error).toBe("No footage on the camera for 10:00");
  });

  it("rejects a third unfinished request", async () => {
    const inserted = await db.insert(footageRequestsTable).values([
      {
        fieldId: fieldAId,
        cameraId: `owner-camera-a-${TAG}`,
        requestedBy: ownerId,
        startLocal: "2020-01-01 08:00",
        endLocal: "2020-01-01 08:15",
        requestedSeconds: 900,
        status: "queued",
        vpsJobId: "unfinished-1",
      },
      {
        fieldId: fieldAId,
        cameraId: `owner-camera-a-${TAG}`,
        requestedBy: ownerId,
        startLocal: "2020-01-01 09:00",
        endLocal: "2020-01-01 09:15",
        requestedSeconds: 900,
        status: "running",
        vpsJobId: "unfinished-2",
      },
    ]).returning({ id: footageRequestsTable.id });
    requestIds.push(...inserted.map(({ id }) => id));

    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send({ startLocal: oldStart, endLocal: oldEnd })
      .expect(400);
    expect(response.body.error).toBe("You already have 2 unfinished footage requests");
    await db.delete(footageRequestsTable).where(inArray(footageRequestsTable.id, inserted.map(({ id }) => id)));
    requestIds = requestIds.filter((id) => !inserted.some((row) => row.id === id));
  });

  it("accepts a future window without checking historical SD availability", async () => {
    availableHours = [];
    const window = futureLocalWindow(1);
    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send(window)
      .expect(201);
    requestIds.push(response.body.id);
    expect(response.body).toMatchObject({
      status: "scheduled",
      startLocal: window.startLocal,
      endLocal: window.endLocal,
    });
    const remoteUrl = recordPostUrls.at(-1);
    expect(remoteUrl).toBeTruthy();
    expect(new URL(remoteUrl!).searchParams.get("start")).toBe(`${window.startLocal}:00`);
    expect(new URL(remoteUrl!).searchParams.get("end")).toBe(`${window.endLocal}:00`);
  });

  it("rejects an overlapping active booking", async () => {
    const window = futureLocalWindow(2);
    const [existing] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: `owner-camera-a-${TAG}`,
      requestedBy: ownerId,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: 900,
      status: "scheduled",
      vpsJobId: "scheduled-overlap",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(existing.id);

    const response = await request(app)
      .post(`/api/owner/fields/${fieldAId}/requests`)
      .send(window)
      .expect(400);
    expect(response.body.error).toBe("You already booked footage for this time");
  });
});

describe("owner request status sync", () => {
  it("marks VAR active only inside the Amman-adjusted window and for supported states", () => {
    const row = {
      startLocal: "2026-09-21 10:00",
      endLocal: "2026-09-21 10:15",
      status: "scheduled",
      varState: "on",
    } as const;
    const opensAt = Date.parse("2026-09-21T06:57:00.000Z");
    const closesAt = Date.parse("2026-09-21T07:20:00.000Z");

    expect(isVarActive(row, opensAt)).toBe(true);
    expect(isVarActive(row, opensAt - 1)).toBe(false);
    expect(isVarActive(row, closesAt + 1)).toBe(false);
    expect(isVarActive({ ...row, varState: "unsupported" }, opensAt)).toBe(false);
    expect(isVarActive({ ...row, varState: "ftp-failed" }, opensAt)).toBe(false);
  });

  it("transitions a completed VPS request to ready with a charge and token", async () => {
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: `owner-camera-a-${TAG}`,
      requestedBy: ownerId,
      startLocal: oldStart,
      endLocal: oldEnd,
      requestedSeconds: 900,
      status: "queued",
      vpsJobId: "job-owner-test",
      rateFils: 1000,
    }).returning();
    requestIds.push(inserted.id);

    const response = await request(app)
      .get(`/api/owner/fields/${fieldAId}/requests`)
      .expect(200);
    const result = response.body.find((row: { id: number }) => row.id === inserted.id);
    expect(result).toMatchObject({
      id: inserted.id,
      status: "ready",
      billableHours: 1,
      amountFils: 1000,
    });
    expect(result.shareUrl).toMatch(/^https:\/\/owner\.example\.test\/w\/[0-9a-f]{32}$/);
    expect(result.playbackManifestUrl).toBe(
      `https://owner.example.test/w/${result.shareUrl.split("/").pop()}/manifest.m3u8`,
    );
  });

  it("rejects VAR playlist access for a non-owner", async () => {
    const window = activeLocalWindow();
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "owner-camera-a-var",
      requestedBy: ownerId,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);
    mockedGetLocalUserRecord.mockResolvedValue({
      id: otherUserId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);

    await request(app)
      .get(`/api/owner/requests/${inserted.id}/var/hls/playlist.m3u8`)
      .expect(403);
  });

  it("returns 404 for VAR outside the request window", async () => {
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "owner-camera-a-var",
      requestedBy: ownerId,
      startLocal: oldStart,
      endLocal: oldEnd,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);

    await request(app)
      .get(`/api/owner/requests/${inserted.id}/var/hls/playlist.m3u8`)
      .expect(404);
  });

  it("rewrites VAR playlist segments and EXT-X-MAP and forwards the since window", async () => {
    const window = activeLocalWindow();
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "camera1",
      requestedBy: ownerId,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);

    const response = await request(app)
      .get(`/api/owner/requests/${inserted.id}/var/hls/playlist.m3u8`)
      .expect(200);
    const proxyPrefix = `/api/owner/requests/${inserted.id}/var/hls/seg/`;
    expect(response.text).toContain(`#EXT-X-MAP:URI="${proxyPrefix}init.mp4"`);
    expect(response.text).toContain(`${proxyPrefix}one.m4s`);
    expect(response.text).toContain(`${proxyPrefix}two.m4s`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(new URL(varUrls.at(-1)!).searchParams.get("since"))
      .toBe(String(localInstantSeconds(window.startLocal) - 3 * 60));
    expect(varUrls.at(-1)).toContain("/var/cam1/hls/playlist.m3u8");
  });

  it("reads live status from the VPS hls variant payload", async () => {
    const window = activeLocalWindow();
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "camera1",
      requestedBy: ownerId,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);

    const response = await request(app)
      .get(`/api/owner/requests/${inserted.id}/var/status`)
      .expect(200);

    expect(response.body).toMatchObject({
      live: true,
      newestAgeSec: 4.3,
      varActive: true,
    });
    expect(varUrls.at(-1)).toContain("/var/cam1/window");
  });

  it("streams VAR segments and rejects unsafe segment names", async () => {
    const window = activeLocalWindow();
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "owner-camera-a-var",
      requestedBy: ownerId,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);

    const segment = await request(app)
      .get(`/api/owner/requests/${inserted.id}/var/hls/seg/one.m4s`)
      .expect(200);
    expect(segment.body.toString()).toBe("segment-bytes");
    expect(segment.headers["content-type"]).toContain("video/mp4");
    expect(segment.headers["cache-control"]).toBe("private, max-age=3600");

    await request(app)
      .get(`/api/owner/requests/${inserted.id}/var/hls/seg/bad!.m4s`)
      .expect(400);
  });

  it("creates VAR marks with request-relative offsets and restricts deletion", async () => {
    const window = activeLocalWindow();
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "owner-camera-a-var",
      requestedBy: ownerId,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);

    const atUtc = new Date(localInstantSeconds(window.startLocal) * 1000 + 90_000).toISOString();
    const created = await request(app)
      .post(`/api/owner/requests/${inserted.id}/var-marks`)
      .send({ atUtc, kind: "goal", note: "Good finish" })
      .expect(201);
    expect(created.body).toMatchObject({
      kind: "goal",
      note: "Good finish",
      offsetSeconds: 90,
      createdBy: ownerId,
    });

    const listed = await request(app)
      .get(`/api/owner/fields/${fieldAId}/requests`)
      .expect(200);
    expect(listed.body.find((row: { id: number }) => row.id === inserted.id).marks)
      .toEqual([expect.objectContaining({ id: created.body.id, offsetSeconds: 90 })]);

    mockedGetLocalUserRecord.mockResolvedValue({
      id: otherUserId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    await request(app).delete(`/api/owner/var-marks/${created.body.id}`).expect(403);

    mockedGetLocalUserRecord.mockResolvedValue({
      id: ownerId,
      isGuest: false,
      isAdmin: false,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
    await request(app).delete(`/api/owner/var-marks/${created.body.id}`).expect(204);
    expect(await db.select().from(varMarksTable).where(eq(varMarksTable.id, created.body.id))).toHaveLength(0);
  });

  it("closes VAR mark creation after the grace period", async () => {
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: "owner-camera-a-var",
      requestedBy: ownerId,
      startLocal: oldStart,
      endLocal: oldEnd,
      requestedSeconds: 900,
      status: "recording",
      varState: "on",
    }).returning({ id: footageRequestsTable.id });
    requestIds.push(inserted.id);

    await request(app)
      .post(`/api/owner/requests/${inserted.id}/var-marks`)
      .send({ atUtc: new Date(`${oldStart.replace(" ", "T")}:00.000Z`).toISOString(), kind: "other" })
      .expect(409);
  });

  it("cancels a scheduled request only after the remote delete succeeds", async () => {
    const [inserted] = await db.insert(footageRequestsTable).values({
      fieldId: fieldAId,
      cameraId: `owner-camera-a-${TAG}`,
      requestedBy: ownerId,
      startLocal: futureLocalWindow(3).startLocal,
      endLocal: futureLocalWindow(3).endLocal,
      requestedSeconds: 900,
      status: "scheduled",
      vpsJobId: "scheduled-to-cancel",
    }).returning();
    requestIds.push(inserted.id);

    const response = await request(app)
      .post(`/api/owner/requests/${inserted.id}/cancel`)
      .expect(200);
    expect(response.body).toMatchObject({ id: inserted.id, status: "cancelled" });
  });
});

describe("admin owner and billing management", () => {
  beforeEach(() => {
    mockedGetLocalUserRecord.mockResolvedValue({
      id: adminId,
      isGuest: false,
      isAdmin: true,
    } as Awaited<ReturnType<typeof getLocalUserRecord>>);
  });

  it("assigns and removes an owner by email", async () => {
    const created = await request(app)
      .post("/api/admin/footage-owners")
      .send({ fieldId: fieldBId, email: `${TAG}_other@test.local` })
      .expect(201);
    expect(created.body).toMatchObject({ fieldId: fieldBId, userId: otherUserId });

    const listed = await request(app).get("/api/admin/footage-owners").expect(200);
    expect(listed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: fieldBId, email: `${TAG}_other@test.local` }),
    ]));

    await request(app)
      .delete("/api/admin/footage-owners")
      .send({ fieldId: fieldBId, email: `${TAG}_other@test.local` })
      .expect(200);
  });

  it("converts JOD payments to fils and returns billing totals", async () => {
    const created = await request(app)
      .post(`/api/admin/fields/${fieldAId}/payments`)
      .send({ amountJod: 12.345, method: "CliQ", note: "March balance" })
      .expect(201);
    paymentIds.push(created.body.id);
    expect(created.body).toMatchObject({
      fieldId: fieldAId,
      amountFils: 12345,
      amountJod: 12.345,
      method: "CliQ",
      note: "March balance",
    });

    const overview = await request(app).get("/api/admin/footage-billing").expect(200);
    expect(overview.body).toMatchObject({
      totalPaidFils: expect.any(Number),
      totalBalanceFils: expect.any(Number),
    });
    expect(overview.body.payments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.id, amountFils: 12345 }),
    ]));
  });

  it("proxies the admin VAR window without an owner request", async () => {
    const response = await request(app)
      .get("/api/admin/var/camera1/window")
      .expect(200);
    expect(response.body).toEqual({
      cam: "cam1",
      variants: {
        hls: { present: true, segments: 3, newestAgeSec: 4.3, live: true },
        hevc: { present: true, segments: 3, newestAgeSec: 4.3, live: true },
      },
    });
    expect(varUrls.at(-1)).toContain("/var/cam1/window");
  });

  it("rewrites admin VAR playlists from the VPS camera name", async () => {
    const response = await request(app)
      .get("/api/admin/var/camera1/hls/playlist.m3u8")
      .expect(200);
    const proxyPrefix = "/api/admin/var/camera1/hls/seg/";
    expect(response.text).toContain(`#EXT-X-MAP:URI="${proxyPrefix}init.mp4"`);
    expect(response.text).toContain(`${proxyPrefix}one.m4s`);
    expect(response.text).toContain(`${proxyPrefix}two.m4s`);
    expect(varUrls.at(-1)).toContain("/var/cam1/hls/playlist.m3u8");
  });
});
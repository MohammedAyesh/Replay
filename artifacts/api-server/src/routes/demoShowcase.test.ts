import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/demoShowcase", () => ({
  buildDemoShowcase: vi.fn(),
  buildDemoReport: vi.fn(),
}));

vi.mock("./share", () => ({
  proxyStorageObject: vi.fn(async (_req: unknown, res: { status: (n: number) => { send: (b: string) => void } }, storagePath: string) => {
    res.status(206).send(storagePath);
  }),
}));

vi.mock("../lib/bunny", () => ({ isBunnyStorageConfigured: () => true }));

const servable = new Set<number>();
vi.mock("../lib/demoBrandedClips", () => ({
  demoBrandedVideoPath: (id: number, brand = "galaxy") => `demo/branded/${brand === "academy" ? "jufa-v1" : "galaxy-v1"}/c${id}.mp4`,
  demoBrandedPosterPath: (id: number, brand = "galaxy") => `demo/branded/${brand === "academy" ? "jufa-v1" : "galaxy-v1"}/c${id}.jpg`,
  isServableDemoCopy: async (id: number, brand = "galaxy") => servable.has(brand === "academy" ? -id : id),
  onDemoBrandedReady: () => () => {},
}));

import { buildDemoReport, buildDemoShowcase } from "../lib/demoShowcase";
import { proxyStorageObject } from "./share";
import demoShowcaseRouter, { resetDemoShowcaseCache } from "./demoShowcase";

const app = express();
app.use("/api", demoShowcaseRouter);

const showcase = {
  counts: { recordings: 40, clips: 12, analysed: 3 },
  returnRatePercent: 87,
  match: null,
  clips: [],
  socialClips: [],
  academyClips: [],
  salesWhatsapp: null,
  leadsEnabled: false,
  fieldName: "Jordan Galaxy",
  testimonial: null,
};

afterEach(() => {
  vi.mocked(buildDemoShowcase).mockReset();
  vi.mocked(buildDemoReport).mockReset();
  resetDemoShowcaseCache();
});

describe("GET /api/demo/showcase", () => {
  it("is anonymous and cached between requests", async () => {
    vi.mocked(buildDemoShowcase).mockResolvedValue(showcase);
    const first = await request(app).get("/api/demo/showcase").expect(200);
    await request(app).get("/api/demo/showcase").expect(200);
    expect(first.body).toEqual(showcase);
    expect(buildDemoShowcase).toHaveBeenCalledTimes(1);
  });

  it("answers 500 without leaking the error", async () => {
    vi.mocked(buildDemoShowcase).mockRejectedValue(new Error("db down: secret"));
    const response = await request(app).get("/api/demo/showcase").expect(500);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});

describe("GET /api/demo/showcase/report", () => {
  it("says unavailable when no analysed match exists, without building anything", async () => {
    vi.mocked(buildDemoShowcase).mockResolvedValue(showcase);
    const response = await request(app).get("/api/demo/showcase/report").expect(200);
    expect(response.body).toEqual({ available: false, report: null });
    expect(buildDemoReport).not.toHaveBeenCalled();
  });

  it("builds the report once for concurrent requests", async () => {
    vi.mocked(buildDemoShowcase).mockResolvedValue({
      ...showcase,
      match: { recordingId: 387, analysed: true } as never,
    });
    vi.mocked(buildDemoReport).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { recordingId: 387, date: "2026-09-28", timeSlot: "22:00", durationSeconds: 3600, hasBall: true, hasPitch: true, team: null, moments: [], players: [], broadcast: null };
    });
    const [a, b] = await Promise.all([
      request(app).get("/api/demo/showcase/report"),
      request(app).get("/api/demo/showcase/report"),
    ]);
    expect(a.status).toBe(200);
    expect(b.body.report.recordingId).toBe(387);
    expect(buildDemoReport).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/demo/clips/:file", () => {
  it("serves a clip's branded copy, whichever showcase this instance has cached", async () => {
    servable.clear();
    servable.add(5);
    servable.add(8);
    const video = await request(app).get("/api/demo/clips/5.mp4").expect(206);
    expect(video.text).toBe("demo/branded/galaxy-v1/c5.mp4");
    const poster = await request(app).get("/api/demo/clips/8.jpg").expect(206);
    expect(poster.text).toBe("demo/branded/galaxy-v1/c8.jpg");
  });

  it("serves the academy view's copies from their own set", async () => {
    servable.clear();
    servable.add(-5);
    const video = await request(app).get("/api/demo/clips/academy-5.mp4").expect(206);
    expect(video.text).toBe("demo/branded/jufa-v1/c5.mp4");
    await request(app).get("/api/demo/clips/5.mp4").expect(404);
  });

  it("serves nothing else", async () => {
    servable.clear();
    servable.add(6);
    vi.mocked(proxyStorageObject).mockClear();
    await request(app).get("/api/demo/clips/5.mp4").expect(404);
    await request(app).get("/api/demo/clips/6.png").expect(404);
    await request(app).get("/api/demo/clips/..%2Fsecret.mp4").expect(404);
    await request(app).get("/api/demo/clips/6.mp4.mp4").expect(404);
    expect(proxyStorageObject).not.toHaveBeenCalled();
  });
});

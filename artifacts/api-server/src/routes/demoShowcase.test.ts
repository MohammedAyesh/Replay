import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/demoShowcase", () => ({
  buildDemoShowcase: vi.fn(),
  buildDemoReport: vi.fn(),
  pickDemoRecording: vi.fn(),
}));

import { buildDemoReport, buildDemoShowcase, pickDemoRecording } from "../lib/demoShowcase";
import demoShowcaseRouter, { resetDemoShowcaseCache } from "./demoShowcase";

const app = express();
app.use("/api", demoShowcaseRouter);

const showcase = {
  counts: { recordings: 40, clips: 12, analysed: 3 },
  match: null,
  clips: [],
  salesWhatsapp: null,
  leadsEnabled: false,
};

afterEach(() => {
  vi.mocked(buildDemoShowcase).mockReset();
  vi.mocked(buildDemoReport).mockReset();
  vi.mocked(pickDemoRecording).mockReset();
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
    vi.mocked(pickDemoRecording).mockResolvedValue(null);
    const response = await request(app).get("/api/demo/showcase/report").expect(200);
    expect(response.body).toEqual({ available: false, report: null });
    expect(buildDemoReport).not.toHaveBeenCalled();
  });

  it("builds the report once for concurrent requests", async () => {
    vi.mocked(pickDemoRecording).mockResolvedValue({ recording: { id: 387 } as never, analysed: true });
    vi.mocked(buildDemoReport).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { recordingId: 387, date: "2026-09-28", timeSlot: "22:00", durationSeconds: 3600, hasBall: true, hasPitch: true, team: null, moments: [], players: [] };
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

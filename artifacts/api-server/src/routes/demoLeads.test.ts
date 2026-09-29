import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const inserted: unknown[] = [];

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      insert: () => ({
        values: (row: unknown) => {
          inserted.push(row);
          return { returning: async () => [{ id: inserted.length }] };
        },
      }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    },
  };
});

vi.mock("../lib/demoLeads", () => ({
  demoLeadsReady: vi.fn().mockResolvedValue(true),
  resetDemoLeadsReady: vi.fn(),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn().mockResolvedValue(null),
}));

import { demoLeadsReady } from "../lib/demoLeads";
import demoLeadsRouter, { resetDemoLeadsState } from "./demoLeads";

const app = express();
app.use(express.json());
app.use("/api", demoLeadsRouter);

const good = { name: "Abu Ahmad", place: "Test pitch", phone: "0790000000", persona: "pitch", locale: "ar" };

afterEach(() => {
  inserted.length = 0;
  resetDemoLeadsState();
  vi.mocked(demoLeadsReady).mockResolvedValue(true);
});

describe("POST /api/demo/leads", () => {
  it("saves a valid request", async () => {
    await request(app).post("/api/demo/leads").send(good).expect(201);
    expect(inserted).toEqual([{ name: "Abu Ahmad", place: "Test pitch", phone: "0790000000", persona: "pitch", locale: "ar" }]);
  });

  it("refuses a bad phone number and a filled honeypot", async () => {
    await request(app).post("/api/demo/leads").send({ ...good, phone: "call me" }).expect(400);
    await request(app).post("/api/demo/leads").send({ ...good, website: "http://spam" }).expect(400);
    expect(inserted).toHaveLength(0);
  });

  it("answers 503 until the table exists", async () => {
    vi.mocked(demoLeadsReady).mockResolvedValue(false);
    await request(app).post("/api/demo/leads").send(good).expect(503);
    expect(inserted).toHaveLength(0);
  });

  it("limits one address to five requests in ten minutes", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/demo/leads").set("X-Forwarded-For", "10.0.0.9").send(good).expect(201);
    }
    await request(app).post("/api/demo/leads").set("X-Forwarded-For", "10.0.0.9").send(good).expect(429);
    await request(app).post("/api/demo/leads").set("X-Forwarded-For", "10.0.0.10").send(good).expect(201);
  });
});

describe("admin lead routes", () => {
  it("are closed to people who are not admins", async () => {
    await request(app).get("/api/admin/demo-leads").expect(403);
    await request(app).patch("/api/admin/demo-leads/1").send({ handled: true }).expect(403);
  });
});

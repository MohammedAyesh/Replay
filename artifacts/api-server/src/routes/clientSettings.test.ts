import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { invalidateSettingsCache } from "../lib/settings";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: vi.fn().mockResolvedValue(null),
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
import clientSettingsRouter from "./clientSettings";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const app = express();
app.use("/api", clientSettingsRouter);

afterEach(() => {
  mockedGetLocalUserId.mockReset();
  mockedGetLocalUserId.mockResolvedValue(null as never);
  invalidateSettingsCache();
});

describe("GET /api/client-settings", () => {
  it("includes the shipped legal and support defaults", async () => {
    const response = await request(app).get("/api/client-settings").expect(200);
    expect(response.body.settings).toMatchObject({
      "legal.companyName": "Replay",
      "support.email": "",
    });
  });
});
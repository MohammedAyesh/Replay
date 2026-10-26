import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { renderPreviewPng, renderPreviewMp4 } = vi.hoisted(() => ({
  renderPreviewPng: vi.fn(),
  renderPreviewMp4: vi.fn(),
}));

vi.mock("../lib/clipBranding/preview", () => ({
  PREVIEW_DIMS: { "9:16": { w: 608, h: 1080 }, "16:9": { w: 1920, h: 1080 } },
  renderPreviewPng,
  renderPreviewMp4,
}));

import demoBrandingRouter, { demoBrandLook, resetDemoBrandingPreviewCache } from "./demoBranding";

const app = express();
app.use("/api", demoBrandingRouter);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-branding-test-"));
const mp4File = path.join(tempDir, "preview.mp4");

beforeAll(() => {
  fs.writeFileSync(mp4File, Buffer.from("0123456789"));
  renderPreviewPng.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  renderPreviewMp4.mockResolvedValue(mp4File);
});

afterEach(() => {
  resetDemoBrandingPreviewCache();
  renderPreviewPng.mockClear();
  renderPreviewMp4.mockClear();
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("public demo branding previews", () => {
  it("uses the exact bundled Jordan Galaxy preset, independent of typed branding", async () => {
    const look = await demoBrandLook({
      look: "galaxy",
      name: "Ignored custom name",
      color: "#123456",
      persona: "pitch",
    });
    expect(look).toMatchObject({
      nameEn: "JORDAN GALAXY",
      nameAr: "ملاعب جوردن جلاكسي",
      primaryColor: "#F4CF1F",
      taglineAr: "كل ماتش هون متصوّر",
      bookingPhone: "07 9920 4098",
      isAcademy: false,
    });
    expect(look.crest).not.toBeNull();
  });

  it("assigns custom Arabic names to nameAr and disables unrelated branding fields", async () => {
    const look = await demoBrandLook({
      look: "custom",
      name: "  أكاديمية  ",
      color: "#12abef",
      persona: "academy",
    });
    expect(look).toMatchObject({
      nameEn: "",
      nameAr: "أكاديمية",
      primaryColor: "#12ABEF",
      taglineAr: null,
      bookingPhone: null,
      instagram: null,
      isAcademy: true,
    });
    expect(look.crest).toBeNull();
  });

  it("renders and caches a public PNG preview", async () => {
    const url = "/api/demo/branding/preview.png?look=custom&what=player&name=My%20Pitch&color=%23AABBCC&persona=pitch&aspect=16%3A9";
    await request(app).get(url).expect("Content-Type", /image\/png/).expect(200);
    await request(app).get(url).expect(200);
    expect(renderPreviewPng).toHaveBeenCalledTimes(1);
    expect(renderPreviewPng).toHaveBeenCalledWith(expect.objectContaining({
      what: "player",
      dims: { w: 1920, h: 1080 },
      blur: 22,
      dim: 0.5,
    }));
  });

  it("rejects malformed colors instead of rendering arbitrary inputs", async () => {
    await request(app)
      .get("/api/demo/branding/preview.png?look=custom&what=signOff&color=red")
      .expect(400);
    expect(renderPreviewPng).not.toHaveBeenCalled();
  });

  it("serves bounded MP4 byte ranges for browser playback", async () => {
    const response = await request(app)
      .get("/api/demo/branding/preview.mp4?look=custom&kind=signOff&aspect=16%3A9")
      .set("Range", "bytes=0-2")
      .expect(206);
    expect(response.headers["content-type"]).toMatch(/video\/mp4/);
    expect(response.headers["content-range"]).toBe("bytes 0-2/10");
    expect(response.body.toString()).toBe("012");
  });

  it("does not offer portrait MP4 previews for custom branding", async () => {
    await request(app)
      .get("/api/demo/branding/preview.mp4?look=custom&kind=signOff&aspect=9%3A16")
      .expect(400);
    expect(renderPreviewMp4).not.toHaveBeenCalled();
  });
});

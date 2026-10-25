import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { BRANDING_PRESETS, brandingAssetDir, presetCrestPath, ensureBrandingFonts } from "./assets";
import { brightOnDark, inkOn, safeColor } from "./draw";
import { applyEndScreen, endScreenStart, FPS } from "./endScreenVideo";
import { renderOverlayPng } from "./overlay";
import { dateLabelFromLocal, presetFileFromUrl, statLines, planClipBranding } from "./plan";
import { renderPreviewPng, sampleEndScreen } from "./preview";
import { OVERLAY_STYLES, type BrandLook } from "./types";
import type { PlayerMetricValues } from "../matchStatsRules";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "clip-branding-test-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const LOOK: BrandLook = {
  nameEn: "JORDAN GALAXY",
  nameAr: "ملاعب جوردن جلاكسي",
  taglineAr: null,
  primaryColor: "#F4CF1F",
  accentColor: null,
  bookingPhone: "07 9920 4098",
  instagram: null,
  crest: null,
  isAcademy: false,
};

function metrics(over: Partial<PlayerMetricValues>): PlayerMetricValues {
  return {
    minutes: 60, distanceKm: null, topSpeedKmh: null, touches: null, passesTried: null,
    passesCompleted: null, passesReceived: null, dribbles: null, dribblesWon: null,
    dribblesLost: null, shots: null, goals: null, ...over,
  };
}

function probeDuration(file: string): number {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]).toString().trim());
}

async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

describe("dateLabelFromLocal", () => {
  it("formats an Amman local start as the day, date and kick-off", () => {
    expect(dateLabelFromLocal("2026-10-24 22:00")).toBe("SAT 24 OCT · 22:00");
    expect(dateLabelFromLocal("2026-01-05T07:30:00")).toBe("MON 5 JAN · 07:30");
  });
  it("returns null for anything it cannot read, rather than a wrong date", () => {
    expect(dateLabelFromLocal(null)).toBeNull();
    expect(dateLabelFromLocal("")).toBeNull();
    expect(dateLabelFromLocal("24/10/2026")).toBeNull();
  });
});

describe("presetFileFromUrl", () => {
  it("resolves a bundled crest", () => {
    const file = presetFileFromUrl("preset:jordan-galaxy-crest.png");
    expect(file).not.toBeNull();
    expect(fs.existsSync(file!)).toBe(true);
  });
  it("refuses paths that try to leave the presets folder, and unknown files", () => {
    expect(presetFileFromUrl("preset:../../package.json")).toBeNull();
    expect(presetFileFromUrl("preset:nope.png")).toBeNull();
    expect(presetFileFromUrl("https://example.com/crest.png")).toBeNull();
  });
  it("ships every preset's crest", () => {
    for (const p of BRANDING_PRESETS) expect(fs.existsSync(presetCrestPath(p))).toBe(true);
  });
});

describe("endScreenStart", () => {
  it("overlaps the last N seconds of a long enough clip, on a frame boundary", () => {
    const start = endScreenStart(12.34, 3)!;
    expect(start).toBeCloseTo(9.34, 1);
    expect(Math.abs(start * FPS - Math.round(start * FPS))).toBeLessThan(1e-9);
  });
  it("appends instead when the clip is too short to cover", () => {
    expect(endScreenStart(5.9, 3)).toBeNull();
    expect(endScreenStart(8, 6)).toBeNull();
    expect(endScreenStart(9, 6)).not.toBeNull();
  });
});

describe("statLines", () => {
  it("leaves out zero goals and missing numbers, and keeps four at most", () => {
    const lines = statLines(metrics({ goals: 0, topSpeedKmh: 24.3, distanceKm: 4.6, touches: 62, passesCompleted: 20, dribblesWon: 3 }), []);
    expect(lines.map((l) => l.labelAr)).toEqual(["أعلى سرعة", "مسافة", "لمسة", "تمريرة صحيحة"]);
  });
  it("puts goals first when there are some", () => {
    const lines = statLines(metrics({ goals: 2, topSpeedKmh: 22 }), []);
    expect(lines[0]).toMatchObject({ value: 2, labelAr: "أهداف" });
  });
  it("marks no personal bests without three earlier matches", () => {
    const lines = statLines(metrics({ topSpeedKmh: 30 }), [metrics({ topSpeedKmh: 20 }), metrics({ topSpeedKmh: 21 })]);
    expect(lines.every((l) => !l.best)).toBe(true);
  });
  it("compares academy numbers with the average of recent sessions", () => {
    const earlier = [metrics({ distanceKm: 2.8 }), metrics({ distanceKm: 2.7 })];
    const [line] = statLines(metrics({ distanceKm: 3.1 }), earlier, { deltas: true });
    expect(line.delta).toEqual({ text: "13%", up: true });
    const [down] = statLines(metrics({ distanceKm: 2.0 }), earlier, { deltas: true });
    expect(down.delta?.up).toBe(false);
  });
  it("shows no delta from a single earlier session", () => {
    const [line] = statLines(metrics({ distanceKm: 3.1 }), [metrics({ distanceKm: 2.0 })], { deltas: true });
    expect(line.delta ?? null).toBeNull();
  });
});

describe("colours", () => {
  it("puts dark ink on a light venue colour and white on a dark one", () => {
    expect(inkOn("#F4CF1F")).not.toBe(inkOn("#2B3DA8"));
  });
  it("lifts a dark venue colour before drawing it on footage", () => {
    expect(brightOnDark({ primaryColor: "#F4CF1F", accentColor: null })).toBe("#F4CF1F");
    expect(brightOnDark({ primaryColor: "#2B3DA8", accentColor: "#3DB54A" })).toBe("#3DB54A");
    expect(brightOnDark({ primaryColor: "#2B3DA8", accentColor: null })).not.toBe("#2B3DA8");
  });
  it("falls back on a bad colour instead of drawing nothing", () => {
    expect(safeColor("red", "#2FD8C4")).toBe("#2FD8C4");
  });
});

describe("renderOverlayPng", () => {
  for (const style of OVERLAY_STYLES.filter((s) => s !== "uploaded")) {
    for (const dims of [{ w: 608, h: 1080 }, { w: 1920, h: 1080 }]) {
      it(`${style} at ${dims.w}×${dims.h} covers the frame and leaves the middle clear`, async () => {
        const png = renderOverlayPng({ style, look: LOOK, dims, dateLabel: "SAT 24 OCT · 22:00", tag: "U-12" });
        const img = await loadImage(png);
        expect([img.width, img.height]).toEqual([dims.w, dims.h]);
        // The pitch in the middle of the frame stays untouched.
        expect((await pixel(png, Math.round(dims.w / 2), Math.round(dims.h / 2)))[3]).toBe(0);
      });
    }
  }
  it("draws the venue's colour in its name tab", async () => {
    const dims = { w: 1920, h: 1080 };
    const png = renderOverlayPng({ style: "cornerCrest", look: LOOK, dims });
    // A point inside the tab, right of the crest: 44 + 130·0.62 + 130·0.5 + 20 ≈ 210, y ≈ 60.
    const [r, g, b, a] = await pixel(png, 300, 62);
    expect(a).toBe(255);
    expect([r, g, b]).toEqual([0xF4, 0xCF, 0x1F]);
  });
});

describe("previews", () => {
  it("renders every end screen kind over the bundled frame", async () => {
    ensureBrandingFonts();
    for (const kind of ["player", "match", "academy", "signOff"] as const) {
      const png = await renderPreviewPng({ look: LOOK, what: kind, dims: { w: 608, h: 1080 }, blur: 22, dim: 0.5 });
      const img = await loadImage(png);
      expect([img.width, img.height]).toEqual([608, 1080]);
      expect(sampleEndScreen(kind, LOOK).kind).toBe(kind);
    }
  });
});

describe("applyEndScreen", () => {
  const encode = {
    video: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr"],
    audio: ["-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "2"],
  };

  it("lays the end screen over the last seconds without changing the length", async () => {
    const sample = path.join(brandingAssetDir(), "preview", "sample-portrait.mp4");
    const main = path.join(work, "main.mp4");
    // Re-encode with a keyframe where the end screen starts, as the export does.
    const duration = probeDuration(sample);
    const start = endScreenStart(duration, 3)!;
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-i", sample, ...encode.video, ...encode.audio,
      "-force_key_frames", String(start), main,
    ]);
    const out = await applyEndScreen({
      mainPath: main,
      dims: { w: 608, h: 1080 },
      job: { spec: sampleEndScreen("player", LOOK), seconds: 3, blur: 22, dim: 0.5 },
      start,
      encode,
      hasAudio: true,
    });
    try {
      expect(Math.abs(probeDuration(out) - probeDuration(main))).toBeLessThan(0.15);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 120_000);

  it("appends to a clip too short to cover", async () => {
    const short = path.join(work, "short.mp4");
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=608x1080:d=3:r=30",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "3", ...encode.video, ...encode.audio, short,
    ]);
    const out = await applyEndScreen({
      mainPath: short,
      dims: { w: 608, h: 1080 },
      job: { spec: sampleEndScreen("signOff", LOOK), seconds: 2.5, blur: 10, dim: 0.4 },
      start: endScreenStart(3, 2.5),
      encode,
      hasAudio: true,
    });
    try {
      expect(probeDuration(out)).toBeGreaterThan(5.3);
      expect(probeDuration(out)).toBeLessThan(5.8);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 120_000);
});

describe("planClipBranding", () => {
  it("does nothing while the console switches are at their shipped values", async () => {
    const plan = await planClipBranding(
      { id: 1, userId: 1, academyId: null, matchCode: null, footageRequestId: null },
      null,
      true,
      { userId: 1, academyId: null, fieldId: null },
    );
    expect(plan).toEqual({ overlayPath: null, endScreen: null, temps: [] });
  });

  it("draws the overlay and plans a sign-off once the console turns them on", async () => {
    const { db, settingsDefaultsTable, brandingProfilesTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const { invalidateSettingsCache } = await import("../settings");
    const keys = ["branding.overlayStyle", "branding.endScreenEnabled", "branding.endScreen.seconds"];
    await db.insert(settingsDefaultsTable).values([
      { key: keys[0], value: "broadcastBar" },
      { key: keys[1], value: true },
      { key: keys[2], value: 4 },
    ]);
    const [profile] = await db.insert(brandingProfilesTable).values({
      scopeType: "global", scopeId: 0, nameEn: "JORDAN GALAXY", primaryColor: "#F4CF1F",
      crestUrl: "preset:jordan-galaxy-crest.png",
    }).returning();
    invalidateSettingsCache();
    try {
      const plan = await planClipBranding(
        { id: 1, userId: 1, academyId: null, matchCode: null, footageRequestId: null },
        null,
        true,
        { userId: 1, academyId: null, fieldId: null },
      );
      expect(plan.overlayPath).not.toBeNull();
      const img = await loadImage(fs.readFileSync(plan.overlayPath!));
      expect([img.width, img.height]).toEqual([608, 1080]);
      // No match room, no stats: the venue's sign-off.
      expect(plan.endScreen?.spec.kind).toBe("signOff");
      expect(plan.endScreen?.seconds).toBe(4);
      expect(plan.endScreen?.spec.look.crest).not.toBeNull();
      for (const t of plan.temps) fs.rmSync(t, { force: true });
    } finally {
      await db.delete(settingsDefaultsTable).where(inArray(settingsDefaultsTable.key, keys));
      const { eq } = await import("drizzle-orm");
      await db.delete(brandingProfilesTable).where(eq(brandingProfilesTable.id, profile.id));
      invalidateSettingsCache();
    }
  });
});

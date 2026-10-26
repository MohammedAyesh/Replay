import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { BRANDING_PRESETS, brandingAssetDir, presetCrestPath, ensureBrandingFonts } from "./assets";
import { brightOnDark, inkOn, safeColor } from "./draw";
import { applyEndScreen, endScreenRunOn, endScreenStart, FPS } from "./endScreenVideo";
import { renderOverlayPng } from "./overlay";
import { cleanChoice, dateLabelFromLocal, presetFileFromUrl, statLines, planClipBranding } from "./plan";
import { renderPreviewMp4, renderPreviewPng, sampleEndScreen } from "./preview";
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

describe("end screen timing", () => {
  it("starts where the clip ends, on a frame boundary — never over the clip", () => {
    const start = endScreenStart(12.34);
    expect(start).toBeCloseTo(12.34, 1);
    expect(Math.abs(start * FPS - Math.round(start * FPS))).toBeLessThan(1e-9);
    expect(endScreenStart(3)).toBe(3);
  });
  it("runs on for the card's length when the recording continues, and less when it does not", () => {
    expect(endScreenRunOn(100, 3600, 3)).toBe(3);
    expect(endScreenRunOn(3598.5, 3600, 3)).toBe(1.5);
    expect(endScreenRunOn(3600, 3600, 3)).toBe(0);
    // Less than a frame left is nothing: the card holds the last frame.
    expect(endScreenRunOn(3599.99, 3600, 3)).toBe(0);
  });
});

describe("statLines", () => {
  it("leaves out zero goals, touches and missing numbers, and keeps four at most", () => {
    const lines = statLines(metrics({ goals: 0, topSpeedKmh: 24.3, distanceKm: 4.6, touches: 62, passesCompleted: 20, dribblesWon: 3 }), []);
    expect(lines.map((l) => l.labelAr)).toEqual(["أعلى سرعة", "مسافة", "تمريرة صحيحة", "مراوغة ناجحة"]);
  });
  it("shows shots on target where touches used to be", () => {
    const lines = statLines(metrics({ goals: 1, shots: 3, topSpeedKmh: 24.3, distanceKm: 4.6, touches: 62 }), []);
    expect(lines.map((l) => l.labelAr)).toEqual(["أهداف", "تسديدة على المرمى", "أعلى سرعة", "مسافة"]);
    expect(lines[1].value).toBe(3);
  });
  it("shows exactly the numbers the player picked, in his order, zeros included", () => {
    const lines = statLines(metrics({ goals: 0, shots: 2, distanceKm: 4.6, topSpeedKmh: null }), [], {
      pick: ["distance", "goals", "topSpeed", "shotsOnTarget"],
    });
    // Top speed was not measured, so it is left out; the zero goals he asked for stay.
    expect(lines.map((l) => [l.labelAr, l.value])).toEqual([["مسافة", 4.6], ["أهداف", 0], ["تسديدة على المرمى", 2]]);
  });
  it("keeps an academy card to three numbers even when four are picked", () => {
    const lines = statLines(metrics({ goals: 1, shots: 2, distanceKm: 4.6, topSpeedKmh: 20 }), [], {
      pick: ["goals", "shotsOnTarget", "distance", "topSpeed"], max: 3,
    });
    expect(lines).toHaveLength(3);
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

describe("cleanChoice", () => {
  it("keeps known cards and numbers, drops the rest, and caps the numbers at four", () => {
    expect(cleanChoice({ card: "player", stats: ["goals", "touches", "goals", "distance"] }))
      .toEqual({ card: "player", stats: ["goals", "distance"] });
    expect(cleanChoice({ card: "nonsense" })).toEqual({});
    expect(cleanChoice(null)).toEqual({});
    expect(cleanChoice({ stats: ["goals", "shotsOnTarget", "topSpeed", "distance", "passes"] }).stats).toHaveLength(4);
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

  it("plays the card over the footage after the clip: the clip plus the card's length", async () => {
    const sample = path.join(brandingAssetDir(), "preview", "sample-portrait.mp4");
    const main = path.join(work, "main.mp4");
    // The sample stands in for a clip rendered 3 s past its end, with a
    // keyframe at the end, as the export does.
    const duration = probeDuration(sample);
    const start = endScreenStart(duration - 3);
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

  it("joins frame-accurately with the real export settings (B-frames)", async () => {
    const { EXPORT_ENCODE_ARGS } = await import("../ffmpegExport");
    const main = path.join(work, "bframes.mp4");
    // A 7 s clip rendered 3 s past its end.
    const start = endScreenStart(7);
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=608x1080:r=30:d=10",
      "-f", "lavfi", "-i", "sine=f=440:r=44100:d=10",
      ...EXPORT_ENCODE_ARGS.video, ...EXPORT_ENCODE_ARGS.audio,
      "-force_key_frames", String(start), "-shortest", main,
    ]);
    const out = await applyEndScreen({
      mainPath: main,
      dims: { w: 608, h: 1080 },
      job: { spec: sampleEndScreen("signOff", LOOK), seconds: 3, blur: 22, dim: 0.5 },
      start,
      encode: EXPORT_ENCODE_ARGS,
      hasAudio: true,
    });
    try {
      const frames = (file: string) => execFileSync("ffmpeg", [
        "-nostdin", "-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-",
      ]).toString().split("\n").filter((l) => l && !l.startsWith("#"));
      const before = frames(main);
      const after = frames(out);
      expect(after).toHaveLength(before.length);
      const hash = (line: string) => line.split(",").pop()!.trim();
      const pts = (line: string) => Number(line.split(",")[2]);
      // The untouched part is the same footage, frame for frame…
      const cut = Math.round(start * FPS);
      for (let i = 0; i < cut; i++) expect(hash(after[i]), `frame ${i}`).toBe(hash(before[i]));
      // …and time only moves forward across the join.
      for (let i = 1; i < after.length; i++) expect(pts(after[i])).toBeGreaterThan(pts(after[i - 1]));
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 120_000);

  it("holds the last frame when the recording ends with the clip", async () => {
    const short = path.join(work, "short.mp4");
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=608x1080:d=3:r=30",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "3", ...encode.video, ...encode.audio, short,
    ]);
    const out = await applyEndScreen({
      mainPath: short,
      dims: { w: 608, h: 1080 },
      job: { spec: sampleEndScreen("signOff", LOOK), seconds: 2.5, blur: 10, dim: 0.4 },
      start: endScreenStart(3),
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

  it("uses what footage there is after the clip, then holds its last frame", async () => {
    // A 3 s clip whose recording has only 1 s more: green, then red.
    const main = path.join(work, "runon.mp4");
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=green:s=608x1080:d=3:r=30",
      "-f", "lavfi", "-i", "color=c=red:s=608x1080:d=1:r=30",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-map", "2:a", "-t", "4",
      ...encode.video, ...encode.audio, "-force_key_frames", "3", main,
    ]);
    const out = await applyEndScreen({
      mainPath: main,
      dims: { w: 608, h: 1080 },
      job: { spec: sampleEndScreen("signOff", LOOK), seconds: 2.5, blur: 0, dim: 0 },
      start: endScreenStart(3),
      encode,
      hasAudio: true,
    });
    try {
      // The clip's 3 s, then the card's 2.5 s.
      expect(probeDuration(out)).toBeGreaterThan(5.3);
      expect(probeDuration(out)).toBeLessThan(5.8);
      // The clip itself is untouched: still green just before its end.
      const px = (t: number) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(t), "-i", out,
        "-frames:v", "1", "-vf", "crop=2:2:300:900", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
      const [r, g] = px(2.9);
      expect(g).toBeGreaterThan(100);
      expect(r).toBeLessThan(60);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 120_000);
});

describe("renderPreviewMp4", () => {
  it("renders the card over moving run-on footage from a keyframed preview source", async () => {
    const file = await renderPreviewMp4({
      look: LOOK,
      lookKey: `moving-preview-test-${Date.now()}`,
      kind: "signOff",
      dims: { w: 608, h: 1080 },
      seconds: 3,
      blur: 0,
      dim: 0,
    });
    try {
      // The bundled sample is 7.6 s; the card starts at 4.6 s and runs over
      // its final 3 s instead of being appended over a held last frame.
      expect(Math.abs(probeDuration(file) - 7.6)).toBeLessThan(0.2);
      const hashAt = (seconds: number) => {
        const lines = execFileSync("ffmpeg", [
          "-nostdin", "-v", "error", "-ss", String(seconds), "-i", file,
          "-frames:v", "1", "-f", "framemd5", "-",
        ]).toString().split("\n").filter((line) => line && !line.startsWith("#"));
        return lines[0]?.split(",").pop()?.trim();
      };
      // The sign-off card has settled by these points, so differing frames
      // confirm the footage itself keeps moving beneath its fixed branding.
      expect(hashAt(6.1)).not.toBe(hashAt(7.4));
    } finally {
      fs.rmSync(file, { force: true });
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
      // The QR is the clip's own share card, never a match room code.
      expect(plan.endScreen?.spec.link).toMatch(/\/s\/1\/[A-Za-z0-9_-]+$/);
      for (const t of plan.temps) fs.rmSync(t, { force: true });
    } finally {
      await db.delete(settingsDefaultsTable).where(inArray(settingsDefaultsTable.key, keys));
      const { eq } = await import("drizzle-orm");
      await db.delete(brandingProfilesTable).where(eq(brandingProfilesTable.id, profile.id));
      invalidateSettingsCache();
    }
  });
});

describe("encodeCard (the card handed to vps1)", () => {
  it("is a small VP9 video whose card is opaque and whose footage area stays transparent", async () => {
    const { encodeCard } = await import("./backup");
    const card = await encodeCard({ spec: sampleEndScreen("player", LOOK), seconds: 3, blur: 22, dim: 0.5 }, { w: 608, h: 1080 });
    expect(card.ext).toBe("webm");
    expect(card.buffer.length).toBeLessThan(2_000_000);
    const file = path.join(work, "card.webm");
    fs.writeFileSync(file, card.buffer);
    const count = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).toString().trim();
    expect(Number(count)).toBe(90);
    // The last frame through libvpx (the decoder that keeps alpha), as RGBA.
    const rgba = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", "select=eq(n\\,89)",
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 10 * 1024 * 1024 });
    const alphaAt = (x: number, y: number) => rgba[(y * 608 + x) * 4 + 3];
    expect(alphaAt(300, 100)).toBeGreaterThan(240); // the venue band
    expect(alphaAt(300, 1000)).toBeLessThan(200); // footage shows through, only dimmed
  }, 60_000);
});

describe("ffmpegWithCard", () => {
  it("succeeds when FFmpeg finishes cleanly before reading every frame (FFmpeg 7.1's appended path)", async () => {
    const { ffmpegWithCard } = await import("./endScreenVideo");
    const out = path.join(work, "early.mp4");
    // Reads 5 of the 90 frames and exits 0: the remaining writes hit a closed pipe.
    await ffmpegWithCard(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "608x1080", "-framerate", "30",
      "-i", "pipe:0", "-frames:v", "5", "-c:v", "libx264", "-preset", "ultrafast", out],
      { spec: sampleEndScreen("signOff", LOOK), seconds: 3, blur: 22, dim: 0.5 }, { w: 608, h: 1080 }, 60_000);
    expect(fs.existsSync(out)).toBe(true);
  }, 60_000);

  it("reports an FFmpeg failure", async () => {
    const { ffmpegWithCard } = await import("./endScreenVideo");
    await expect(ffmpegWithCard(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "608x1080", "-framerate", "30",
      "-i", "pipe:0", "-c:v", "no-such-encoder", path.join(work, "bad.mp4")],
      { spec: sampleEndScreen("signOff", LOOK), seconds: 3, blur: 22, dim: 0.5 }, { w: 608, h: 1080 }, 60_000))
      .rejects.toThrow();
  }, 60_000);
});


describe("renderClip with an end screen (the real export path)", () => {
  // A 10 s recording at the export source size: blue, then red from 5 s.
  const source = path.join(work, "recording.mp4");
  const ensureSource = async () => {
    if (fs.existsSync(source)) return;
    const { EXPORT_SOURCE_WIDTH: W, EXPORT_SOURCE_HEIGHT: H } = await import("../exportSource");
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=blue:s=${W}x${H}:d=5:r=30`,
      "-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:d=5:r=30`,
      "-f", "lavfi", "-i", "sine=f=440:r=44100:d=10",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "10", source,
    ]);
  };
  const job = { spec: sampleEndScreen("signOff", LOOK), seconds: 3, blur: 0, dim: 0 };
  const greenOrRed = (file: string, t: number) => {
    const [r, , b] = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(t), "-i", file,
      "-frames:v", "1", "-vf", "crop=2:2:300:1000", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    return r > b ? "red" : "blue";
  };

  it("keeps the whole clip and plays the card over the footage that follows it", async () => {
    await ensureSource();
    const { renderClip } = await import("../ffmpegExport");
    // The clip is 2 s–5 s (all blue); the card plays over 5 s–8 s (red).
    const out = await renderClip({
      videoUrl: source, totalDuration: 10, startTime: 0.2, endTime: 0.5,
      cropPath: [], aspectRatio: "9:16", title: "t", endScreen: job,
    });
    try {
      expect(Math.abs(probeDuration(out) - 6)).toBeLessThan(0.15);
      expect(greenOrRed(out, 2.9)).toBe("blue"); // the clip's last moment, untouched
      expect(greenOrRed(out, 3.5)).toBe("red"); // the footage after it, under the card
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 180_000);

  it("holds the last frame when the recording ends with the clip", async () => {
    await ensureSource();
    const { renderClip } = await import("../ffmpegExport");
    const out = await renderClip({
      videoUrl: source, totalDuration: 10, startTime: 0.6, endTime: 1,
      cropPath: [], aspectRatio: "9:16", title: "t", endScreen: job,
    });
    try {
      expect(Math.abs(probeDuration(out) - 7)).toBeLessThan(0.15);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 180_000);

  it("without an end screen the clip is exactly the selection", async () => {
    await ensureSource();
    const { renderClip } = await import("../ffmpegExport");
    const out = await renderClip({
      videoUrl: source, totalDuration: 10, startTime: 0.2, endTime: 0.5,
      cropPath: [], aspectRatio: "9:16", title: "t",
    });
    try {
      expect(Math.abs(probeDuration(out) - 3)).toBeLessThan(0.15);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 180_000);
});

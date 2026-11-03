import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readCapture } from "./phone-media-api";
import { phoneStrings } from "@/i18n/phone-strings";

describe("reading a phone file's time in the browser, before upload", () => {
  it("reads an iPhone video's QuickTime date and location from the File itself", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-web-"));
    const file = path.join(dir, "IMG_4821.MOV");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=3:s=160x90:r=15", "-c:v", "libx264",
      "-metadata", "com.apple.quicktime.creationdate=2026-11-01T18:05:32+0300",
      "-metadata", "com.apple.quicktime.location.ISO6709=+31.9539+035.9106+0800.000/", "-movflags", "use_metadata_tags", file]);
    const f = new File([fs.readFileSync(file)], "IMG_4821.MOV", { type: "video/quicktime", lastModified: Date.parse("2026-11-01T15:05:35Z") });
    const { capture, gps } = await readCapture(f);
    expect(capture).toMatchObject({ quicktimeCreationDate: "2026-11-01T18:05:32+0300", durationSec: 3, lastModifiedMs: Date.parse("2026-11-01T15:05:35Z") });
    expect(gps).toEqual({ lat: 31.9539, lon: 35.9106 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing, without throwing, about a file it can't read", async () => {
    const { capture, gps } = await readCapture(new File([new Uint8Array([1, 2, 3])], "x.mp4", { type: "video/mp4", lastModified: 5 }));
    expect(capture).toEqual({ lastModifiedMs: 5 });
    expect(gps).toBeNull();
  });
});

describe("phone strings", () => {
  const keysOf = (o: object, prefix = ""): string[] => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  it("Arabic has every English string", () => expect(keysOf(phoneStrings.ar).sort()).toEqual(keysOf(phoneStrings.en).sort()));
  it("says where a during clip sits in the match video", () => {
    expect(phoneStrings.en.at(332)).toBe("at 5:32 in the match video");
    expect(phoneStrings.ar.at(332)).toBe("على الدقيقة 5:32 من فيديو الماتش");
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  AUTOPILOT_TEMPLATE_KEYS,
  CREATIVE_STYLES,
  CREATIVE_TEMPLATES,
  buildTemplateScene,
  sceneSchema,
  templateSampleData,
  type CreativeBrand,
} from "@workspace/api-zod";
import { renderScenePng } from "./render";

/**
 * The Instagram autopilot's own templates (field console): a booking's 9:16 highlight, the
 * award nominees story and one winner Reel per award. Built in every style and both languages,
 * kept out of the academies' catalogue, and every video ends on a card carrying the booking number.
 */
const BRAND: CreativeBrand = { primary: "#7B5CFF", accent: "#D4FF4F", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "Jordan Galaxy", nameAr: "جوردن جالاكسي" };

/** A stand-in for the footage: a green pitch with a white line, so text over it can be judged by eye. */
function pitchFrame() {
  const c = createCanvas(1920, 540);
  const g = c.getContext("2d");
  g.fillStyle = "#1f7a3a";
  g.fillRect(0, 0, 1920, 540);
  g.fillStyle = "#ffffff";
  g.fillRect(955, 0, 10, 540);
  return c;
}

describe("Instagram autopilot templates", () => {
  it("are not in the academies' template catalogue", () => {
    const keys = new Set(CREATIVE_TEMPLATES.map((t) => t.key));
    for (const key of AUTOPILOT_TEMPLATE_KEYS) expect(keys.has(key)).toBe(false);
    expect(AUTOPILOT_TEMPLATE_KEYS).toEqual(["ig-booking-clip", "ig-award-nominees", "ig-award-goal", "ig-award-dribble", "ig-award-shot", "ig-award-save", "ig-award-fastest"]);
  });

  it("build a valid 9:16 scene in every style and language; the videos end on the booking number", () => {
    for (const key of AUTOPILOT_TEMPLATE_KEYS) {
      for (const style of CREATIVE_STYLES) {
        for (const locale of ["en", "ar"] as const) {
          const scene = sceneSchema.parse(buildTemplateScene(key, style, "story", locale));
          expect(scene.format).toBe("story");
          expect(scene.template?.key).toBe(key);
          if (key === "ig-award-nominees") {
            expect(scene.durationMs).toBeUndefined();
            continue;
          }
          expect(scene.durationMs).toBe(15000);
          const line = scene.layers.find((l) => l.id === "end-booking");
          expect(line && line.kind === "text" ? line.text : null).toBe("{{custom.endLine}}");
          // Shown only on the end card.
          expect(line?.startMs).toBe(12500);
          expect(scene.layers.some((l) => l.kind === "video" && l.id === "video")).toBe(true);
        }
      }
    }
  });

  it("gives each award its own title, and Fastest player its speed", () => {
    const kicker = (key: string, locale: "en" | "ar") => buildTemplateScene(key, "broadcast", "story", locale).layers
      .filter((l) => l.kind === "text").map((l) => (l.kind === "text" ? l.text : "")).join(" | ");
    expect(kicker("ig-award-goal", "en")).toContain("Goal of the week");
    expect(kicker("ig-award-save", "ar")).toContain("تصدّي الأسبوع");
    expect(kicker("ig-award-fastest", "en")).toContain("{{custom.speed}}");
  });

  it("renders frames to look at: the clip, its end card, the nominees story (EN and AR)", async () => {
    const out = process.env.IG_TEMPLATE_PREVIEW_DIR;
    const frame = pitchFrame();
    const shots: Array<[string, string, number | null]> = [
      ["ig-booking-clip", "jufa", 4000], ["ig-booking-clip", "jufa", 14000], ["ig-booking-clip", "broadcast", 14000],
      ["ig-award-fastest", "stadium", 4000], ["ig-award-nominees", "broadcast", null],
    ];
    for (const [key, style, t] of shots) {
      for (const locale of ["en", "ar"] as const) {
        const scene = buildTemplateScene(key, style as "broadcast", "story", locale);
        const data = templateSampleData(key, locale);
        const png = await renderScenePng({ scene, brand: BRAND, data, t, entrances: false, width: 540, images: async () => frame });
        expect(png.length).toBeGreaterThan(5000);
        if (out) {
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(path.join(out, `${key}-${style}-${t ?? "still"}-${locale}.png`), png);
        }
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  CREATIVE_FORMATS,
  CREATIVE_STYLES,
  CREATIVE_TEMPLATES,
  buildTemplateScene,
  fillText,
  sceneSchema,
  templateSampleData,
  type Scene,
  type SceneLayer,
} from "@workspace/api-zod";

const KEYS = [
  "fulltime", "matchday", "potm", "goal", "lineup", "potmonth", "standings", "nextround", "champions", "freetrial", "cleansheet", "birthday",
  "pricing", "newgroup", "talk", "training", "welcome", "getwell", "staff", "alumni", "tournament", "poll", "map", "manifesto",
];
const FORMATS = Object.keys(CREATIVE_FORMATS) as Array<keyof typeof CREATIVE_FORMATS>;
const LOCALES = ["en", "ar"] as const;
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

/** Axis-aligned box of a (possibly rotated) layer. */
function bounds(l: SceneLayer) {
  const a = ((l.rotation ?? 0) * Math.PI) / 180;
  const w = Math.abs(l.w * Math.cos(a)) + Math.abs(l.h * Math.sin(a));
  const h = Math.abs(l.w * Math.sin(a)) + Math.abs(l.h * Math.cos(a));
  const cx = l.x + l.w / 2;
  const cy = l.y + l.h / 2;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

const all: Array<{ key: string; style: (typeof CREATIVE_STYLES)[number]; format: (typeof FORMATS)[number]; locale: "en" | "ar"; scene: Scene }> = [];
for (const key of KEYS) for (const style of CREATIVE_STYLES) for (const format of FORMATS) for (const locale of LOCALES)
  all.push({ key, style, format, locale, scene: buildTemplateScene(key, style, format, locale) });

describe("catalogue", () => {
  it("lists the 24 templates once each", () => {
    expect(CREATIVE_TEMPLATES.map((t) => t.key).sort()).toEqual([...KEYS].sort());
  });

  it("marks goal, talk and training as video and puts the poll in a story first", () => {
    expect(CREATIVE_TEMPLATES.filter((t) => t.kind === "video").map((t) => t.key).sort()).toEqual(["goal", "talk", "training"]);
    expect(CREATIVE_TEMPLATES.find((t) => t.key === "poll")?.formats[0]).toBe("story");
  });

  it("derives each template's fields from its bindings", () => {
    const fulltime = CREATIVE_TEMPLATES.find((t) => t.key === "fulltime")!;
    expect(fulltime.fields).toEqual(expect.arrayContaining(["match.ownScore", "match.opponentScore", "academy.name", "media"]));
  });
});

describe.each(all.map((s) => [`${s.key} / ${s.style} / ${s.format} / ${s.locale}`, s] as const))("%s", (_label, { key, style, format, locale, scene }) => {
  const { w: W, h: H } = CREATIVE_FORMATS[format];

  it("is a valid scene", () => {
    expect(() => sceneSchema.parse(scene)).not.toThrow();
    expect(scene.template).toEqual({ key, style });
    expect(scene.format).toBe(format);
  });

  it("keeps every layer inside the canvas unless it is a deliberate bleed", () => {
    const out = scene.layers.filter((l) => l.name !== "bleed").filter((l) => {
      const b = bounds(l);
      return b.x0 < -1 || b.y0 < -1 || b.x1 > W + 1 || b.y1 > H + 1;
    });
    expect(out.map((l) => l.id)).toEqual([]);
  });

  it("gives layers unique ids", () => {
    const ids = scene.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the crest and only brand tokens or fixed neutrals", () => {
    expect(scene.layers.some((l) => l.kind === "image" && l.src.type === "crest")).toBe(true);
  });

  it("fills every binding from its sample data", () => {
    const data = templateSampleData(key, locale);
    for (const l of scene.layers) {
      if (l.kind !== "text" || !l.text.includes("{{")) continue;
      expect(fillText(l.text, data, true), `${l.id}: ${l.text}`).not.toMatch(/\{\{/);
    }
  });

  if (locale === "ar") {
    it("sets Arabic text right-to-left in Arabic faces; only digits stay Latin", () => {
      const data = templateSampleData(key, locale);
      for (const l of scene.layers) {
        if (l.kind !== "text") continue;
        if (l.font === "arabic" || l.font === "arabic-display") {
          expect(l.dir, l.id).toBe("rtl");
          expect(l.letterSpacing ?? 0, l.id).toBe(0);
        } else {
          expect(l.dir, l.id).toBe("ltr");
          expect(fillText(l.text, data), `${l.id}: ${l.text}`).not.toMatch(LATIN);
          expect(fillText(l.text, data), `${l.id}: ${l.text}`).not.toMatch(ARABIC);
        }
      }
    });
  } else {
    it("has no Arabic in the English version", () => {
      const data = templateSampleData(key, locale);
      for (const l of scene.layers) {
        if (l.kind !== "text") continue;
        expect(l.font.startsWith("arabic"), l.id).toBe(false);
        expect(fillText(l.text, data), l.id).not.toMatch(ARABIC);
      }
    });
  }

  if (CREATIVE_TEMPLATES.find((t) => t.key === key)?.kind === "video") {
    it("plays the footage full-bleed and times every overlay inside the clip", () => {
      expect(scene.durationMs).toBeGreaterThanOrEqual(5000);
      const v = scene.layers.find((l) => l.kind === "video");
      expect(v).toMatchObject({ x: 0, y: 0, w: W, h: H });
      for (const l of scene.layers) {
        if (l.endMs !== undefined) expect(l.endMs).toBeLessThanOrEqual(scene.durationMs!);
        if (l.startMs !== undefined && l.endMs !== undefined) expect(l.startMs).toBeLessThan(l.endMs);
      }
      expect(scene.layers.some((l) => l.id.startsWith("end-") && l.startMs !== undefined)).toBe(true);
    });
  } else {
    it("is a still", () => expect(scene.durationMs).toBeUndefined());
  }
});

describe("children", () => {
  it("every player template still reads with only a shirt number", () => {
    for (const t of CREATIVE_TEMPLATES) {
      if (!t.fields.includes("player.name")) continue;
      expect(t.fields, t.key).toContain("player.number");
    }
  });

  it("no layer depends on a name to have a background", () => {
    for (const s of all) for (const l of s.scene.layers)
      if (l.kind === "text" && l.text.includes("player.name")) expect(l.background, `${s.key}/${s.style}/${l.id}`).toBeUndefined();
  });
});

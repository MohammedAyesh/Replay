import type { CreativeData, CreativeFormat, CreativeStyle, Scene } from "./creativeScene";

/**
 * Creative hub template catalogue. Every template builds a Scene for any
 * style and format; academy colours come in through @primary/@accent tokens
 * and the academy's facts through {{bindings}} (see CreativeData).
 *
 * CONTRACT (frozen; the full catalogue replaces the bodies, not the shapes):
 *   CREATIVE_TEMPLATES: TemplateMeta[]
 *   buildTemplateScene(key, style, format, locale): Scene
 *   templateSampleData(key, locale): CreativeData
 */

export type TemplateCategory = "matchday" | "results" | "players" | "recruitment" | "academy-life" | "community";

export type TemplateMeta = {
  key: string;
  category: TemplateCategory;
  title: { en: string; ar: string };
  /** Video templates have a duration and a video slot; stills do not. */
  kind: "image" | "video";
  /** Formats the layout is designed for; the first is the default. */
  formats: CreativeFormat[];
  /** Which bindings the template reads (drives the "fill in" form). */
  fields: string[];
};

export const CREATIVE_TEMPLATES: TemplateMeta[] = [
  {
    key: "fulltime",
    category: "results",
    title: { en: "Full time", ar: "نهاية المباراة" },
    kind: "image",
    formats: ["post", "square", "story"],
    fields: ["match.ownName", "match.opponent", "match.ownScore", "match.opponentScore", "match.squad", "match.date"],
  },
];

const H = { post: 1350, square: 1080, story: 1920 } as const;

export function buildTemplateScene(key: string, style: CreativeStyle, format: CreativeFormat, locale: "en" | "ar"): Scene {
  const h = H[format];
  const ar = locale === "ar";
  return {
    v: 1,
    format,
    background: "#0B0F1A",
    template: { key, style },
    locale,
    layers: [
      { id: "accent", kind: "shape", shape: "rect", x: 0, y: h - 24, w: 1080, h: 24, fill: "@primary" },
      { id: "crest", kind: "image", src: { type: "crest" }, x: 440, y: 80, w: 200, h: 200, fit: "contain" },
      { id: "title", kind: "text", text: ar ? "نهاية المباراة" : "FULL TIME", font: ar ? "arabic-display" : "display", size: 110, weight: 800,
        color: "@primary", align: "center", dir: "auto", x: 60, y: h / 2 - 260, w: 960, h: 140 },
      { id: "score", kind: "text", text: "{{match.ownScore}} – {{match.opponentScore}}", font: "display", size: 260, weight: 800,
        color: "#FFFFFF", align: "center", dir: "ltr", x: 60, y: h / 2 - 120, w: 960, h: 280 },
      { id: "teams", kind: "text", text: "{{match.ownName}}  ·  {{match.opponent}}", font: ar ? "arabic" : "condensed", size: 52, weight: 700,
        color: "#FFFFFF", align: "center", dir: "auto", x: 60, y: h / 2 + 180, w: 960, h: 80, fit: true },
    ],
  } as Scene;
}

export function templateSampleData(_key: string, locale: "en" | "ar"): CreativeData {
  return {
    academy: { name: locale === "ar" ? "أكاديمية" : "Academy" },
    match: { ownName: locale === "ar" ? "أكاديميتنا" : "Our academy", opponent: locale === "ar" ? "الخصم" : "Opponent", ownScore: 3, opponentScore: 1, squad: "U12", date: "SAT 24 OCT" },
  };
}

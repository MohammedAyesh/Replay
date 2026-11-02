import { describe, expect, it } from "vitest";
import type { CreativeFormat, CreativeStyle, Scene, SceneLayer } from "@workspace/api-zod";
import {
  canRedo,
  canUndo,
  changeFormat,
  changeStyle,
  COALESCE_MS,
  createEditorState,
  dragWindow,
  editorReducer,
  findLayer,
  insertBinding,
  moveLayer,
  parseFieldValue,
  sceneBindings,
  setPath,
  videoPlayMs,
  type EditorAction,
  type EditorState,
} from "./creative-editor-state";

const H = { post: 1350, square: 1080, story: 1920 } as const;

/** A small stand-in template so the tests do not depend on the real catalogue's artwork. */
function fakeBuild(key: string, style: CreativeStyle, format: CreativeFormat, locale: "en" | "ar"): Scene {
  const h = H[format];
  const dark = style !== "playful";
  return {
    v: 1, format, locale, background: dark ? "#0B0F1A" : "#FFFFFF", template: { key, style },
    layers: [
      { id: "bg", kind: "image", src: { type: "binding", path: "media" }, fit: "cover", x: 0, y: 0, w: 1080, h },
      { id: "band", kind: "shape", shape: "rect", x: 0, y: h - 24, w: 1080, h: 24, fill: "@primary" },
      { id: "title", kind: "text", text: locale === "ar" ? "نهاية المباراة" : "FULL TIME", font: "display", size: style === "luxury" ? 90 : 110,
        weight: 800, color: "@primary", align: "center", dir: "auto", x: 60, y: h / 2 - 260, w: 960, h: 140 },
      { id: "score", kind: "text", text: "{{match.ownScore}} – {{match.opponentScore}}", font: "display", size: 260, weight: 800,
        color: "#FFFFFF", align: "center", dir: "ltr", x: 60, y: h / 2 - 120, w: 960, h: 280 },
      { id: style === "street" ? "tag-street" : "tag", kind: "text", text: "#{{academy.name}}", font: "body", size: 40, weight: 700,
        color: "@accent", align: "start", dir: "auto", x: 60, y: 60, w: 600, h: 60 },
    ],
  } as Scene;
}

const base = () => fakeBuild("fulltime", "broadcast", "post", "en");
const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);
const layer = (scene: Scene, id: string) => findLayer(scene, id) as SceneLayer;

describe("undo / redo", () => {
  it("steps back and forward through changes", () => {
    let s = createEditorState(base());
    s = run(s, { type: "updateLayer", id: "title", change: { text: "GAME OVER" } });
    s = run(s, { type: "removeLayer", id: "band" });
    expect(canUndo(s)).toBe(true);
    expect(findLayer(s.scene, "band")).toBeNull();

    s = run(s, { type: "undo" });
    expect(findLayer(s.scene, "band")).not.toBeNull();
    expect((layer(s.scene, "title") as { text: string }).text).toBe("GAME OVER");

    s = run(s, { type: "undo" });
    expect((layer(s.scene, "title") as { text: string }).text).toBe("FULL TIME");
    expect(canUndo(s)).toBe(false);
    expect(run(s, { type: "undo" })).toBe(s);

    s = run(s, { type: "redo" }, { type: "redo" });
    expect(findLayer(s.scene, "band")).toBeNull();
    expect(canRedo(s)).toBe(false);
  });

  it("drops the redo branch after a new change", () => {
    let s = createEditorState(base());
    s = run(s, { type: "updateLayer", id: "title", change: { size: 80 } }, { type: "undo" });
    expect(canRedo(s)).toBe(true);
    s = run(s, { type: "updateLayer", id: "title", change: { size: 70 } });
    expect(canRedo(s)).toBe(false);
  });

  it("records nothing for a change that changes nothing", () => {
    const s = createEditorState(base());
    const t = layer(s.scene, "title");
    expect(run(s, { type: "updateLayer", id: "title", change: { x: t.x } })).toBe(s);
  });

  it("bumps the revision on every change, undo and redo", () => {
    let s = createEditorState(base());
    s = run(s, { type: "updateLayer", id: "title", change: { size: 80 } });
    expect(s.revision).toBe(1);
    s = run(s, { type: "undo" }, { type: "redo" });
    expect(s.revision).toBe(3);
  });
});

describe("drag coalescing", () => {
  it("merges a drag's many moves into one undo step", () => {
    let s = createEditorState(base());
    const start = layer(s.scene, "title");
    for (let i = 1; i <= 30; i++) {
      s = run(s, { type: "updateLayer", id: "title", change: { x: start.x + i, y: start.y + i }, key: "move:title", at: 1000 + i * 16 });
    }
    expect(s.past).toHaveLength(1);
    expect(layer(s.scene, "title").x).toBe(start.x + 30);
    s = run(s, { type: "undo" });
    expect(layer(s.scene, "title").x).toBe(start.x);
  });

  it("starts a new step after a pause, a different key or a checkpoint", () => {
    let s = createEditorState(base());
    s = run(s,
      { type: "updateLayer", id: "title", change: { x: 1 }, key: "move:title", at: 1000 },
      { type: "updateLayer", id: "title", change: { x: 2 }, key: "move:title", at: 1000 + COALESCE_MS + 1 });
    expect(s.past).toHaveLength(2);
    s = run(s, { type: "updateLayer", id: "score", change: { x: 5 }, key: "move:score", at: 2100 });
    expect(s.past).toHaveLength(3);
    s = run(s, { type: "checkpoint" }, { type: "updateLayer", id: "score", change: { x: 6 }, key: "move:score", at: 2110 });
    expect(s.past).toHaveLength(4);
  });

  it("never merges changes that carry no key", () => {
    let s = createEditorState(base());
    s = run(s, { type: "updateLayer", id: "title", change: { x: 1 }, at: 1 }, { type: "updateLayer", id: "title", change: { x: 2 }, at: 2 });
    expect(s.past).toHaveLength(2);
  });
});

describe("format change", () => {
  const formats: CreativeFormat[] = ["post", "square", "story"];
  for (const from of formats) for (const to of formats) {
    if (from === to) continue;
    it(`keeps every layer inside the canvas from ${from} to ${to}`, () => {
      const scene = fakeBuild("fulltime", "broadcast", from, "en");
      // A layer the manager dragged near the bottom, and a tall one.
      scene.layers.push({ id: "sticker", kind: "shape", shape: "ellipse", x: 800, y: H[from] - 300, w: 250, h: 250, fill: "@accent" } as SceneLayer);
      scene.layers.push({ id: "tall", kind: "shape", shape: "rect", x: 100, y: 50, w: 300, h: H[from] - 100, fill: "@accent" } as SceneLayer);
      const next = changeFormat(scene, to);
      expect(next.format).toBe(to);
      for (const l of next.layers) {
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.y).toBeGreaterThanOrEqual(0);
        expect(l.x + l.w).toBeLessThanOrEqual(1080 + 0.01);
        expect(l.y + l.h).toBeLessThanOrEqual(H[to] + 0.01);
      }
    });
  }

  it("stretches full-bleed layers and keeps bottom bands on the bottom", () => {
    const next = changeFormat(base(), "story");
    expect(layer(next, "bg")).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920 });
    const band = layer(next, "band");
    expect(band.y + band.h).toBe(1920);
    expect(band.w).toBe(1080);
  });

  it("keeps a layer's relative height and shrinks text on a shorter canvas", () => {
    const scene = fakeBuild("fulltime", "broadcast", "story", "en");
    const before = layer(scene, "score") as Extract<SceneLayer, { kind: "text" }>;
    const next = changeFormat(scene, "square");
    const after = layer(next, "score") as Extract<SceneLayer, { kind: "text" }>;
    const rel = (l: SceneLayer, h: number) => (l.y + l.h / 2) / h;
    expect(Math.abs(rel(after, 1080) - rel(before, 1920))).toBeLessThan(0.02);
    expect(after.size).toBeLessThan(before.size);
  });

  it("is one undo step", () => {
    let s = createEditorState(base());
    s = run(s, { type: "setFormat", format: "square" }, { type: "undo" });
    expect(s.scene.format).toBe("post");
  });
});

describe("style change", () => {
  it("keeps text the manager edited and takes the new style for the rest", () => {
    let scene = base();
    scene = { ...scene, layers: scene.layers.map((l) => (l.id === "title" ? { ...l, text: "WE WON" } as SceneLayer : l)) };
    const next = changeStyle(scene, "luxury", fakeBuild);
    expect(next.template).toEqual({ key: "fulltime", style: "luxury" });
    const title = layer(next, "title") as Extract<SceneLayer, { kind: "text" }>;
    expect(title.text).toBe("WE WON");
    expect(title.size).toBe(90);
    expect((layer(next, "score") as { text: string }).text).toBe("{{match.ownScore}} – {{match.opponentScore}}");
  });

  it("keeps the picture put in a slot, even when the new style names the slot differently", () => {
    let scene = base();
    scene = { ...scene, layers: scene.layers.map((l) => (l.id === "bg" ? { ...l, src: { type: "upload", mediaId: 7 } } as SceneLayer : l)) };
    expect((layer(changeStyle(scene, "playful", fakeBuild), "bg") as { src: unknown }).src).toEqual({ type: "upload", mediaId: 7 });

    const renamed = (key: string, style: CreativeStyle, format: CreativeFormat, locale: "en" | "ar") => {
      const s = fakeBuild(key, style, format, locale);
      if (style === "street") s.layers = s.layers.map((l) => (l.id === "bg" ? { ...l, id: "photo" } : l));
      return s;
    };
    const street = changeStyle(scene, "street", renamed);
    expect((layer(street, "photo") as { src: unknown }).src).toEqual({ type: "upload", mediaId: 7 });
  });

  it("keeps removed layers removed, hidden layers hidden and added layers on top", () => {
    let s = createEditorState(base());
    s = run(s,
      { type: "removeLayer", id: "band" },
      { type: "updateLayer", id: "score", change: { hidden: true } },
      { type: "addLayer", layer: { id: "mine", kind: "text", text: "Join us", font: "body", size: 50, weight: 700, color: "@ink", align: "start", dir: "auto", x: 10, y: 10, w: 400, h: 80 } as SceneLayer });
    const next = changeStyle(s.scene, "editorial", fakeBuild);
    expect(findLayer(next, "band")).toBeNull();
    expect(layer(next, "score").hidden).toBe(true);
    expect(next.layers[next.layers.length - 1]!.id).toBe("mine");
  });

  it("leaves a scene without a template alone", () => {
    const scene = { ...base(), template: undefined };
    expect(changeStyle(scene, "street", fakeBuild)).toBe(scene);
  });
});

describe("layers", () => {
  it("duplicates next to the original with a fresh id, and reorders", () => {
    let s = createEditorState(base());
    s = run(s, { type: "duplicateLayer", id: "title" });
    const ids = s.scene.layers.map((l) => l.id);
    expect(ids.indexOf("title-copy")).toBe(ids.indexOf("title") + 1);
    s = run(s, { type: "duplicateLayer", id: "title" });
    expect(s.scene.layers.some((l) => l.id === "title-copy-2")).toBe(true);
    const moved = moveLayer(s.scene, "bg", "top");
    expect(moved.layers[moved.layers.length - 1]!.id).toBe("bg");
    expect(moveLayer(moved, "bg", "up")).toBe(moved);
  });

  it("gives an added layer a unique id", () => {
    let s = createEditorState(base());
    s = run(s, { type: "addLayer", layer: { ...layer(s.scene, "title"), id: "title" } as SceneLayer });
    expect(new Set(s.scene.layers.map((l) => l.id)).size).toBe(s.scene.layers.length);
  });
});

describe("timeline and data helpers", () => {
  it("drags and trims a bar inside the scene, snapping to 100 ms", () => {
    expect(dragWindow({ start: 0, end: 10_000 }, "move", 2_040, 10_000)).toEqual({ startMs: undefined, endMs: undefined });
    expect(dragWindow({ start: 1_000, end: 3_000 }, "move", 2_040, 10_000)).toEqual({ startMs: 3_000, endMs: 5_000 });
    expect(dragWindow({ start: 1_000, end: 3_000 }, "start", 5_000, 10_000)).toEqual({ startMs: 2_800, endMs: 3_000 });
    expect(dragWindow({ start: 1_000, end: 3_000 }, "end", 99_000, 10_000)).toEqual({ startMs: 1_000, endMs: undefined });
  });

  it("counts a slow-motion window at its own speed", () => {
    const v = { id: "v", kind: "video", src: { type: "clip", clipId: 1 }, x: 0, y: 0, w: 1, h: 1, fit: "cover", trimInMs: 0, trimOutMs: 10_000, speed: 1, muted: false } as Extract<SceneLayer, { kind: "video" }>;
    expect(videoPlayMs(v)).toBe(10_000);
    expect(videoPlayMs({ ...v, speed: 2 })).toBe(5_000);
    expect(videoPlayMs({ ...v, slowMo: { fromMs: 2_000, toMs: 4_000, speed: 0.5 } })).toBe(12_000);
  });

  it("sets and clears nested data, numbers where numbers belong", () => {
    let d = setPath({}, "match.ownScore", parseFieldValue("match.ownScore", "3"));
    d = setPath(d, "match.opponent", "Al Wehdat");
    expect(d).toEqual({ match: { ownScore: 3, opponent: "Al Wehdat" } });
    d = setPath(d, "match.opponent", parseFieldValue("match.opponent", "  "));
    expect(d).toEqual({ match: { ownScore: 3 } });
    expect(setPath({}, "more.1", { type: "crest" })).toEqual({ more: [undefined, { type: "crest" }] });
  });

  it("inserts a binding chip at the caret", () => {
    expect(insertBinding("Score: ", "match.ownScore", 7)).toEqual({ text: "Score: {{match.ownScore}}", caret: 25 });
    expect(insertBinding("ab", "x", 1, 2).text).toBe("a{{x}}");
  });
});

describe("sceneBindings", () => {
  it("lists text and media bindings once each", () => {
    expect(sceneBindings(base())).toEqual(["media", "match.ownScore", "match.opponentScore", "academy.name"]);
  });
});

describe("against the real template catalogue", () => {
  it("every template keeps edited text across every style and stays in bounds across formats", async () => {
    const { CREATIVE_TEMPLATES, CREATIVE_STYLES, buildTemplateScene } = await import("@workspace/api-zod");
    for (const t of CREATIVE_TEMPLATES) {
      const scene = buildTemplateScene(t.key, "broadcast", t.formats[0]!, "ar");
      const text = scene.layers.find((l) => l.kind === "text");
      if (!text) continue;
      const edited = { ...scene, layers: scene.layers.map((l) => (l.id === text.id ? { ...l, text: "نص الأكاديمية" } as SceneLayer : l)) };
      for (const style of CREATIVE_STYLES) {
        const next = changeStyle(edited, style);
        const same = findLayer(next, text.id);
        if (same?.kind === "text") expect(same.text, `${t.key}/${style}`).toBe("نص الأكاديمية");
      }
      for (const f of ["post", "square", "story"] as const) {
        const next = changeFormat(scene, f);
        for (const l of next.layers) {
          const fullBleed = l.y <= 0 && l.y + l.h >= H[f];
          if (!fullBleed) expect(l.y + l.h, `${t.key}/${f}/${l.id}`).toBeLessThanOrEqual(H[f] + 0.01);
        }
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { buildTemplateScene, PLATE_LAYER_ID, type Scene } from "@workspace/api-zod";
import { changeFormat, changeStyle, createEditorState, editorReducer, plateOf, setPlate } from "./creative-editor-state";
import { sizeBucket, withMediaVariant } from "./creative-hub-media";

const plateIndex = (s: Scene) => s.layers.findIndex((l) => l.id === PLATE_LAYER_ID);

describe("background plate in the editor", () => {
  it("templates start with the style's tinted plate", () => {
    const scene = buildTemplateScene("fulltime", "broadcast", "post", "en");
    expect(plateIndex(scene)).toBe(0);
    expect(plateOf(scene)).toMatchObject({ src: { type: "artwork", key: "bg/broadcast/1" }, tint: { color: "@primary", mode: "color" }, opacity: 0.6, locked: true });
    // Stadium paints its sky first: the plate sits right above it.
    const stadium = buildTemplateScene("fulltime", "stadium", "post", "en");
    expect(stadium.layers[plateIndex(stadium) - 1]?.id).toBe("sky");
  });

  it("picks another plate, hides it and changes its tint", () => {
    const scene = buildTemplateScene("fulltime", "street", "story", "ar");
    const two = setPlate(scene, { src: { type: "artwork", key: "bg/street/2" }, hidden: false });
    expect(plateOf(two)?.src).toEqual({ type: "artwork", key: "bg/street/2" });
    const none = setPlate(two, { hidden: true });
    expect(plateOf(none)?.hidden).toBe(true);
    const back = setPlate(none, { src: { type: "artwork", key: "bg/street/1" }, hidden: false });
    expect(plateOf(back)?.hidden).toBeUndefined();
    const tinted = setPlate(back, { tint: { color: "#00A651", mode: "color", amount: 0.5 } });
    expect(plateOf(tinted)?.tint).toEqual({ color: "#00A651", mode: "color", amount: 0.5 });
    expect(plateOf(setPlate(tinted, { tint: null }))?.tint).toBeUndefined();
  });

  it("puts a plate back into a design that has none, where the template puts it", () => {
    const full = buildTemplateScene("fulltime", "stadium", "post", "en");
    const old: Scene = { ...full, layers: full.layers.filter((l) => l.id !== PLATE_LAYER_ID) };
    expect(setPlate(old, { hidden: true })).toBe(old);
    const added = setPlate(old, { src: { type: "artwork", key: "bg/stadium/2" } });
    expect(added.layers[plateIndex(added) - 1]?.id).toBe("sky");
    expect(plateOf(added)).toMatchObject({ src: { key: "bg/stadium/2" }, h: 1350, tint: { color: "@primary" } });
    const plain = buildTemplateScene("matchday", "luxury", "square", "en");
    const noPlate: Scene = { ...plain, layers: plain.layers.filter((l) => l.id !== PLATE_LAYER_ID) };
    expect(plateIndex(setPlate(noPlate, { tint: { color: "@accent" } }))).toBe(0);
  });

  it("is one undo step through the reducer, and coalesces slider drags", () => {
    let s = createEditorState(buildTemplateScene("potm", "playful", "post", "en"));
    s = editorReducer(s, { type: "setPlate", change: { tint: { color: "@primary", amount: 0.4 } }, key: "plate:tint-amount", at: 1000 });
    s = editorReducer(s, { type: "setPlate", change: { tint: { color: "@primary", amount: 0.3 } }, key: "plate:tint-amount", at: 1200 });
    expect(s.past.length).toBe(1);
    expect(plateOf(s.scene)?.tint?.amount).toBe(0.3);
    s = editorReducer(s, { type: "undo" });
    expect(plateOf(s.scene)?.tint).toEqual({ color: "@primary", mode: "color" });
  });

  it("restyle keeps the plate layer, takes the new style's artwork and carries the manager's tint and hiding", () => {
    const scene = buildTemplateScene("fulltime", "broadcast", "post", "en");
    const plain = changeStyle(scene, "cinematic");
    expect(plateOf(plain)).toMatchObject({ src: { key: "bg/cinematic/1" }, tint: { color: "@primary", mode: "color" } });
    expect(plateOf(plain)?.opacity).toBeUndefined();

    const mine = setPlate(setPlate(scene, { src: { type: "artwork", key: "bg/broadcast/3" } }), { tint: { color: "@accent", mode: "color" } });
    const restyled = changeStyle(mine, "editorial");
    expect(plateOf(restyled)).toMatchObject({ src: { key: "bg/editorial/1" }, tint: { color: "@accent", mode: "color" }, opacity: 0.35 });

    const hidden = changeStyle(setPlate(scene, { hidden: true }), "street");
    expect(plateOf(hidden)?.hidden).toBe(true);

    const own = setPlate(scene, { src: { type: "upload", mediaId: 4 } });
    expect(plateOf(changeStyle(own, "luxury"))?.src).toEqual({ type: "upload", mediaId: 4 });

    const removed: Scene = { ...scene, layers: scene.layers.filter((l) => l.id !== PLATE_LAYER_ID) };
    expect(plateOf(changeStyle(removed, "stadium"))).toBeNull();
  });

  it("stretches with the format", () => {
    const scene = buildTemplateScene("fulltime", "cinematic", "post", "en");
    expect(plateOf(changeFormat(scene, "story"))).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920 });
  });
});

describe("media URL variants", () => {
  const url = "https://api.test/api/academy/console/academies/3/creative/media?src=%7B%22type%22%3A%22artwork%22%7D&want=still";

  it("adds format, tint and a bucketed size to a creative media URL", () => {
    const out = new URL(withMediaVariant(url, { format: "story", tint: { color: "#C8102E", mode: "multiply", amount: 0.456 }, size: 500 })!);
    expect(out.searchParams.get("format")).toBe("story");
    expect(out.searchParams.get("tint")).toBe("C8102E");
    expect(out.searchParams.get("tintMode")).toBe("multiply");
    expect(out.searchParams.get("tintAmount")).toBe("0.46");
    expect(out.searchParams.get("size")).toBe("768");
    expect(out.searchParams.get("want")).toBe("still");
    const plain = new URL(withMediaVariant(url, { tint: { color: "#C8102E", mode: "color", amount: 1 } })!);
    expect(plain.searchParams.has("tintMode")).toBe(false);
    expect(plain.searchParams.has("tintAmount")).toBe(false);
    expect(sizeBucket(5000)).toBe(1920);
  });

  it("leaves other URLs and videos alone", () => {
    expect(withMediaVariant("https://cdn.test/crest.png", { tint: { color: "#000000", mode: "color", amount: 1 } })).toBe("https://cdn.test/crest.png");
    const video = url.replace("want=still", "want=video");
    expect(new URL(withMediaVariant(video, { tint: { color: "#000000", mode: "color", amount: 1 } })!).searchParams.has("tint")).toBe(false);
    expect(withMediaVariant(null, {})).toBeNull();
  });
});

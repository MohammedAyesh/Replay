import { describe, expect, it } from "vitest";
import { CREATIVE_STYLES, CREATIVE_FORMATS, MAX_SCENE_LAYERS, buildTemplateScene, sceneForData, type CreativeData } from "@workspace/api-zod";
import { startingData } from "./data";

const FORMATS = Object.keys(CREATIVE_FORMATS) as Array<keyof typeof CREATIVE_FORMATS>;
const photos = (n: number, cutout = true): CreativeData["photos"] => Array.from({ length: n }, (_, i) => ({ type: "player" as const, playerId: i + 1, cutout }));
const ids = (data: CreativeData, key: string, style: (typeof CREATIVE_STYLES)[number], format: (typeof FORMATS)[number]) =>
  sceneForData(buildTemplateScene(key, style, format, "en"), data).layers.map((l) => l.id);

describe("line-ups with player photos", () => {
  for (const key of ["lineup", "callup"]) for (const style of CREATIVE_STYLES) for (const format of FORMATS) {
    const rows = key === "lineup" ? 7 : 9;
    it(`${key} / ${style} / ${format}: numbers-only without photos, photo tiles with them`, () => {
      const scene = buildTemplateScene(key, style, format, "en");
      expect(scene.layers.length).toBeLessThanOrEqual(MAX_SCENE_LAYERS);
      const plain = ids({}, key, style, format);
      expect(plain.some((id) => id.endsWith("-photo") || id.endsWith("-card"))).toBe(false);
      expect(plain).toContain("row-1-lead");
      const cut = ids({ photos: photos(rows) }, key, style, format);
      expect(cut).toContain(`row-${rows}-photo`);
      expect(cut).not.toContain("row-1-card");
      expect(cut).not.toContain("row-1-lead");
      // An ordinary photo draws as a card, a missing one leaves the number alone.
      const mixed = ids({ photos: [{ type: "player", playerId: 1, cutout: false }, null, ...photos(rows - 2)!] }, key, style, format);
      expect(mixed).toContain("row-1-card");
      expect(mixed).not.toContain("row-1-photo");
      expect(mixed).toContain("row-2-num-solo");
      expect(mixed).not.toContain("row-2-photo");
    });
  }

  it("other lists never draw photo tiles", () => {
    for (const key of ["standings", "pricing", "matchstats"]) for (const style of CREATIVE_STYLES)
      expect(buildTemplateScene(key, style, "post", "en").layers.some((l) => l.when?.length)).toBe(false);
  });

  it("player posts show the player's cut-out only when there is one", () => {
    for (const style of CREATIVE_STYLES) {
      const scene = buildTemplateScene("potm", style, "post", "en");
      expect(sceneForData(scene, {}).layers.some((l) => l.id.startsWith("player-"))).toBe(false);
      const cut = sceneForData(scene, { player: { photo: { type: "player", playerId: 1, cutout: true } } }).layers.map((l) => l.id);
      expect(cut, style).toContain("player-photo");
      expect(cut).not.toContain("player-card");
      const card = sceneForData(scene, { player: { photo: { type: "player", playerId: 1 } } }).layers.map((l) => l.id);
      expect(card).toContain("player-card");
    }
  });
});

describe("starting data: player photos follow the names rule", () => {
  const academy = { nameEn: "Jordan Knights", nameAr: null, phone: null, instagram: null, showPlayerNames: false };
  const session: CreativeData = { match: { ownName: "Knights" }, photos: photos(3), player: { name: "Omar", number: 7, photo: { type: "player", playerId: 9, cutout: true } } };
  it("takes a real match's row photos and player photo only when the academy shows names", () => {
    const off = startingData({ key: "callup", locale: "en", academy, seed: { type: "session", sessionId: 1 }, session });
    expect(off.photos).toBeUndefined();
    const offPotm = startingData({ key: "potm", locale: "en", academy, seed: { type: "session", sessionId: 1 }, session });
    expect(offPotm.player?.photo).toBeUndefined();
    const on = startingData({ key: "callup", locale: "en", academy: { ...academy, showPlayerNames: true }, seed: { type: "session", sessionId: 1 }, session });
    expect(on.photos).toHaveLength(3);
    const onPotm = startingData({ key: "potm", locale: "en", academy: { ...academy, showPlayerNames: true }, seed: { type: "session", sessionId: 1 }, session });
    expect(onPotm.player?.photo).toEqual({ type: "player", playerId: 9, cutout: true });
  });
  it("never puts photos into a design that has no real match", () => {
    expect(startingData({ key: "lineup", locale: "en", academy: { ...academy, showPlayerNames: true }, seed: null }).photos).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { CREATIVE_TEMPLATES, buildTemplateScene, fillText, type CreativeData } from "@workspace/api-zod";
import { creativeTemplatesStrings } from "@/i18n/creative-templates-strings";
import { projectTitle, seedKind, seedMedia, startingData, type StartingInput } from "./data";

const academy: StartingInput["academy"] = { nameEn: "Jordan Knights", nameAr: "فرسان الأردن", phone: "079 000 1111", instagram: "@knights", showPlayerNames: false };
const still = { type: "frame", recordingId: 41, atMs: 90_000 } as const;

describe("startingData", () => {
  it("puts a field's own name, phone and booking line on a field pack design, and no sample player names", () => {
    const field = { ...academy, nameEn: "North Pitches", nameAr: "ملاعب الشمال", phone: "078 222 3333" };
    const clip = startingData({ key: "field-booking-clip", locale: "ar", academy: field, seed: { type: "clip", clipId: 5 } });
    expect(clip.custom?.field).toBe("ملاعب الشمال");
    expect(clip.custom?.endBig).toBe("078 222 3333");
    expect(clip.media).toEqual({ type: "clip", clipId: 5 });
    expect(JSON.stringify(clip)).not.toMatch(/Galaxy|جلاكسي|9920/);
    const potm = startingData({ key: "field-potm", locale: "en", academy: field, seed: null });
    expect(potm.custom?.title).toBe("Player name");
    expect(potm.custom?.initials ?? "").toBe("");
    expect(startingData({ key: "field-leaderboard", locale: "en", academy: field, seed: null }).custom?.r1n).toBe("Player 1");
    const named = startingData({ key: "field-potm", locale: "en", academy: { ...field, showPlayerNames: true }, seed: null });
    expect(named.custom?.title).toBe("Mohammed A.");
    expect(startingData({ key: "field-award", locale: "en", academy: { ...field, phone: null }, seed: null }).custom?.endBig ?? "").toBe("");
  });

  it("puts the academy's own name, phone and Instagram in, never the sample's", () => {
    const d = startingData({ key: "freetrial", locale: "ar", academy, seed: null });
    expect(d.academy?.name).toBe("فرسان الأردن");
    expect(d.academy?.phone).toBe("079 000 1111");
    const blank = startingData({ key: "freetrial", locale: "en", academy: { ...academy, phone: null, instagram: null }, seed: null });
    expect(blank.academy?.phone ?? "").toBe("");
    expect(blank.academy?.name).toBe("Jordan Knights");
  });

  it("keeps sample free text so a design never opens empty", () => {
    const d = startingData({ key: "pricing", locale: "en", academy, seed: null });
    expect(d.custom?.plan1).toBeTruthy();
    expect(d.custom?.price1).toBeTruthy();
  });

  it("drops player names unless the academy shows them", () => {
    expect(startingData({ key: "potm", locale: "en", academy, seed: null }).player).toMatchObject({ number: 10, name: null });
    expect(startingData({ key: "potm", locale: "en", academy: { ...academy, showPlayerNames: true }, seed: null }).player?.name).toBe("Omar K.");
  });

  it("uses a real match's facts, not the sample's, and never a sample name on it", () => {
    const session: CreativeData = { match: { ownName: "Knights", opponent: "Wehdat U12", ownScore: 2, opponentScore: 2, date: "FRI 30 OCT" }, player: { number: 7, name: "Sami" } };
    const d = startingData({ key: "fulltime", locale: "en", academy: { ...academy, showPlayerNames: true }, seed: { type: "session", sessionId: 9 }, session });
    expect(d.match).toMatchObject({ opponent: "Wehdat U12", ownScore: 2 });
    expect(d.match?.competition).toBeUndefined();
    expect(d.player).toMatchObject({ number: 7, name: "Sami" });
    const hidden = startingData({ key: "potm", locale: "en", academy, seed: { type: "session", sessionId: 9 }, session });
    expect(hidden.player).toMatchObject({ number: 7, name: null });
  });

  it("takes the picture from the seed, then the academy's footage, then the sample artwork", () => {
    expect(startingData({ key: "potm", locale: "en", academy, seed: { type: "clip", clipId: 5 }, stills: [still] }).media).toEqual({ type: "clip", clipId: 5 });
    expect(startingData({ key: "potm", locale: "en", academy, seed: null, stills: [still] }).media).toEqual(still);
    expect(startingData({ key: "potm", locale: "en", academy, seed: null }).media).toMatchObject({ type: "artwork" });
  });

  it("fills the poll's two pictures from the academy's footage", () => {
    const other = { type: "frame", recordingId: 42, atMs: 10_000 } as const;
    expect(startingData({ key: "poll", locale: "en", academy, seed: null, stills: [still, other] }).more).toEqual([still, other]);
  });

  it("leaves no {{binding}} unfilled in any template's starting text", () => {
    for (const t of CREATIVE_TEMPLATES) {
      for (const locale of ["en", "ar"] as const) {
        const scene = buildTemplateScene(t.key, "broadcast", "post", locale);
        const data = startingData({ key: t.key, locale, academy, seed: null });
        for (const l of scene.layers) if (l.kind === "text") expect(fillText(l.text, data, true), `${t.key}/${locale}/${l.id}`).not.toMatch(/\{\{\s*(custom|stats)\./);
      }
    }
  });
});

describe("seeds", () => {
  it("maps media seeds to sources and sorts by kind", () => {
    expect(seedMedia({ type: "recording", recordingId: 3, fromMs: 1000, toMs: 9000 })).toEqual({ type: "recording", recordingId: 3, fromMs: 1000, toMs: 9000 });
    expect(seedMedia({ type: "session", sessionId: 1 })).toBeNull();
    expect(seedKind({ type: "clip", clipId: 1 })).toBe("video");
    expect(seedKind({ type: "frame", recordingId: 1, atMs: 0 })).toBe("image");
    expect(seedKind({ type: "upload", mediaId: 1 })).toBeNull();
  });

  it("names a match project after the opponent", () => {
    expect(projectTitle("Full time", { match: { opponent: "Wehdat" } }, { type: "session", sessionId: 1 })).toBe("Full time · Wehdat");
    expect(projectTitle("Full time", { match: { opponent: "Wehdat" } }, null)).toBe("Full time");
  });
});

describe("strings", () => {
  it("has every key in both languages", () => {
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(creativeTemplatesStrings.ar).sort()).toEqual(keys(creativeTemplatesStrings.en).sort());
  });

  it("speaks Ammani, not MSA, for the everyday labels", () => {
    expect(creativeTemplatesStrings.ar.clearSeed).toContain("بلّش");
    expect(creativeTemplatesStrings.ar.seconds(15)).toBe("15 ثانية");
  });
});

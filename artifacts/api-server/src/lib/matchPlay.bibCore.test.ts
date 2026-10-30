import { describe, expect, it } from "vitest";
import { playedOnly } from "./matchFeed";
import { PASS, bibKit, bibMargin, bibObservedKits, bibPick, isBibKit, kitAcrossBib, passEvents, sideOfKit, teamStats, type Lab, type Touch } from "./matchPlay";

type Kit = [number, number, number, number];
const sidecarOf = (kits: Kit[]) => [{ v: 1, fps: 20, touches: [], ball: [], kits: Object.fromEntries(kits.map((k, i) => [`t${i}`, k])) }] as never;
const lab = (k: Kit): Lab => [k[0], k[1], k[2]];

// Recording 403 (76P7TR, 26 Oct): pink bibs against white, black, grey and red
// shirts. Every 4th of 112 hand-labelled tracks, [L, a, b, seconds on camera].
const PINK: Kit[] = [[114, 153, 127, 600], [88, 146, 128, 600], [138, 144, 132, 542], [128, 143, 132, 567], [104, 142, 132, 86], [106, 141, 131, 600], [135, 141, 131, 600], [112, 140, 131, 600], [139, 139, 132, 469], [106, 138, 129, 600], [132, 138, 130, 533]];
const RED: Kit[] = [[103, 165, 143, 253], [97, 150, 135, 599]];
const OTHER: Kit[] = [[55, 135, 130, 366], [54, 132, 126, 117], [126, 131, 126, 70], [45, 130, 129, 600], [60, 130, 127, 570], [68, 130, 127, 578], [111, 130, 128, 572], [140, 130, 128, 600], [156, 130, 128, 600], [164, 130, 128, 578], [49, 129, 128, 594], [89, 129, 129, 110], [53, 128, 129, 600]];
// a bib in deep shadow and a dark shirt with a pink cast, both a few units from grey
const NEAR_GREY: Kit[] = [[87, 134, 130, 218], [69, 136, 130, 93]];
const rec403 = sidecarOf([...PINK, ...RED, ...OTHER, ...NEAR_GREY]);
// tracks the old 15-unit sphere round the bib colour got wrong
const BIB_IN_SHADOW: Lab[] = [[70, 138, 129], [88, 146, 128], [90, 146, 127], [87, 145, 127], [113, 154, 128], [164, 137, 130]];
const WHITE_IN_A_DIM_CORNER: Lab[] = [[110, 133, 128], [111, 130, 128], [136, 131, 124], [140, 130, 128], [145, 130, 128]];
// Mohammed's claimed shirt on side B: white
const CLAIMANT_WHITE: Lab = [162, 130, 127];

describe("the bib line on 76P7TR (pink bibs)", () => {
  it("puts the core on the pink side of grey", () => {
    const bib = bibKit(rec403)!;
    expect(bib.core![0]).toBeGreaterThan(12);
    expect(Math.abs(bib.core![1])).toBeLessThan(6);
  });

  it("counts every pink bib, in shadow too, and no white, grey or black shirt", () => {
    const bib = bibKit(rec403)!;
    for (const k of PINK) expect(isBibKit(lab(k), bib)).toBe(true);
    for (const k of BIB_IN_SHADOW) expect(isBibKit(k, bib)).toBe(true);
    for (const k of OTHER) expect(isBibKit(lab(k), bib)).toBe(false);
    for (const k of WHITE_IN_A_DIM_CORNER) expect(isBibKit(k, bib)).toBe(false);
  });

  it("known misses: a red shirt the colour of the bibs, and shirts a few units from grey", () => {
    const bib = bibKit(rec403)!;
    for (const k of RED) expect(isBibKit(lab(k), bib)).toBe(true);
    for (const k of NEAR_GREY) expect(Math.abs(bibMargin(lab(k), bib))).toBeLessThan(PASS.ambiguousKit);
  });

  it("gives the unclaimed side the bib when the claimant is in white", () => {
    const bib = bibKit(rec403)!;
    const observed = bibObservedKits(rec403, bib)!;
    const other = kitAcrossBib(CLAIMANT_WHITE, bib, observed);
    expect(other).toEqual(bib.lab);
    const pick = bibPick(bib, other, CLAIMANT_WHITE)!;
    expect(pick).not.toBeNull();
    for (const k of PINK) expect(sideOfKit(lab(k), pick)).toBe(0);
    for (const k of OTHER) expect(sideOfKit(lab(k), pick)).toBe(1);
    // and a claimant in a bib gives the other side everything else
    expect(kitAcrossBib(lab(PINK[0]), bib, observed)).toEqual(observed[1]);
  });

  it("no longer splits light against dark: alternating bib and white touches come out even", () => {
    const bib = bibKit(rec403)!;
    const observed = bibObservedKits(rec403, bib)!;
    const pick = bibPick(bib, kitAcrossBib(CLAIMANT_WHITE, bib, observed), CLAIMANT_WHITE)!;
    const kits = [lab(PINK[1]), lab(OTHER[3]), lab(PINK[5]), lab(OTHER[9]), lab(PINK[9]), lab(OTHER[0])];
    const touches: Touch[] = Array.from({ length: 60 }, (_, i) => ({
      f: i * 40, t: i * 2, segmentIndex: 0, trackId: `s0:t${i % 6}`, kit: kits[i % 6], ball: [10 + (i % 5), 10], foot: [10, 10], d: 0.5, reassigned: false,
    }));
    const s = teamStats(touches, passEvents(touches, pick), pick);
    expect(s.touches).toEqual([30, 30]);
    expect(Math.abs(s.possessionPercent[0] - 50)).toBeLessThan(3);
    // the old pick (dark grey against white) put the dark shirts with the bibs
    const old = { a: observed[1], b: CLAIMANT_WHITE };
    const t = teamStats(touches, passEvents(touches, old), old);
    expect(t.touches[0]).toBeGreaterThan(30);
  });
});

// 15 Oct (job26): magenta bibs, blue bibs, one player in a peach bib and a red
// shirt. Every 5th track with five minutes or more on camera, plus a few by hand.
const REC26: Kit[] = [[169, 128, 128, 600], [102, 150, 126, 600], [121, 140, 134, 600], [99, 150, 125, 600], [91, 148, 125, 600], [78, 125, 127, 600], [79, 149, 125, 600], [93, 148, 125, 600], [37, 129, 128, 600], [96, 154, 124, 600], [45, 129, 128, 600], [76, 152, 124, 600], [76, 125, 127, 600], [102, 153, 124, 600], [42, 129, 127, 600], [47, 129, 129, 599], [41, 128, 129, 599], [96, 152, 125, 598], [38, 129, 128, 598], [86, 142, 126, 596], [70, 133, 119, 595], [69, 129, 126, 595], [66, 129, 126, 592], [90, 136, 131, 591], [78, 149, 125, 588], [94, 147, 125, 578], [93, 160, 120, 573], [61, 129, 128, 569], [51, 130, 126, 563], [44, 130, 128, 561], [160, 126, 135, 556], [94, 150, 125, 548], [87, 152, 124, 538], [76, 142, 127, 529], [82, 132, 127, 523], [178, 129, 129, 518], [47, 128, 127, 512], [56, 130, 128, 497], [167, 128, 129, 493], [89, 144, 126, 477], [51, 128, 129, 463], [107, 136, 132, 456], [85, 134, 132, 449], [57, 128, 128, 440], [73, 129, 128, 418], [92, 153, 125, 408], [103, 158, 124, 386], [15, 128, 127, 365], [51, 128, 125, 349], [96, 145, 126, 335], [42, 128, 127, 323], [142, 129, 129, 302]];

describe("the bib line with more than one saturated colour (job26)", () => {
  const bib = bibKit(sidecarOf(REC26))!;

  it("finds the magenta bib", () => {
    expect(bib.core![0]).toBeGreaterThan(15);
    expect(isBibKit([96, 154, 124], bib)).toBe(true);
    // magenta in shadow, seen as bibs on the crops
    expect(isBibKit([59, 139, 126], bib)).toBe(true);
    expect(isBibKit([120, 143, 125], bib)).toBe(true);
  });

  it("does not count a blue bib, the peach bib or a red shirt as magenta", () => {
    for (const k of [[62, 137, 111], [65, 138, 109], [57, 139, 107], [43, 147, 95]] as Lab[]) expect(isBibKit(k, bib)).toBe(false);
    for (const k of [[121, 140, 134], [126, 141, 134], [132, 142, 136]] as Lab[]) expect(isBibKit(k, bib)).toBe(false);
    for (const k of [[80, 157, 138], [63, 148, 135]] as Lab[]) expect(isBibKit(k, bib)).toBe(false);
  });
});

describe("team totals count the game, not the warm-up", () => {
  it("keeps only moments inside a game phase", () => {
    const played = playedOnly({ phases: [{ kind: "before", start: 0, end: 1514 }, { kind: "game", start: 1514, end: 4000 }, { kind: "break", start: 4000, end: 4300 }, { kind: "game", start: 4300, end: 7200 }] });
    expect(played(100)).toBe(false);
    expect(played(1514)).toBe(true);
    expect(played(4100)).toBe(false);
    expect(played(7199)).toBe(true);
    expect(played(7200)).toBe(false);
  });

  it("counts everything when a bundle has no phases", () => {
    expect(playedOnly({ phases: null })(100)).toBe(true);
    expect(playedOnly({ phases: [{ kind: "before", start: 0, end: 7200 }] })(100)).toBe(true);
  });
});

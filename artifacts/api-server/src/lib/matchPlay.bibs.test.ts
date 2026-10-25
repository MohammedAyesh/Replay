import { describe, expect, it } from "vitest";
import { bibKit, bibObservedKits, bibPick, isBibKit, passEvents, seedTeams, sideOfKit, type Lab, type Touch } from "./matchPlay";

// Shirt colours measured on recording 401 (yellow bibs against a no-bib side in
// whatever they wore), seconds on camera as the bundle's kits carry them.
const YELLOW: Lab[] = [[142, 121, 151], [140, 121, 149], [140, 120, 150], [137, 123, 144], [138, 120, 151], [164, 121, 147], [151, 123, 141]];
const NO_BIB: Record<string, Lab> = {
  purple11: [71, 134, 129],
  white6: [167, 129, 130],
  black12: [53, 128, 130],
  maroon0: [63, 132, 130],
  black25: [86, 129, 130],
  red44: [102, 148, 139],
  pink10: [161, 131, 134],
};

const kitsOf = (labs: Lab[], secs: number) => Object.fromEntries(labs.map((lab, i) => [`t${i}`, [...lab, secs]]));
const bibMatch = [{
  v: 1, fps: 20, touches: [], ball: [],
  kits: { ...kitsOf(YELLOW, 600), ...Object.fromEntries(Object.entries(NO_BIB).map(([k, lab]) => [k, [...lab, 900]])) },
}] as never;

// White against black, no bibs (recordings 394 / 396).
const plainMatch = [{
  v: 1, fps: 20, touches: [], ball: [],
  kits: kitsOf([[162, 128, 130], [147, 129, 129], [177, 129, 128], [133, 130, 130], [43, 129, 128], [45, 128, 129], [72, 133, 120], [68, 136, 127]], 900),
}] as never;

describe("teams when one side wears bibs", () => {
  it("finds the bib colour and an edge that keeps white and pink shirts off it", () => {
    const bib = bibKit(bibMatch)!;
    expect(bib).not.toBeNull();
    expect(bib.lab[2]).toBeGreaterThan(140);
    for (const lab of YELLOW) expect(sideOfKit(lab, { a: lab, b: lab, bib })).toBe(0);
    const pick = seedTeams(NO_BIB.purple11, [], bib)!;
    for (const lab of YELLOW) expect(sideOfKit(lab, pick)).toBe(1);
    for (const lab of Object.values(NO_BIB)) expect(sideOfKit(lab, pick)).toBe(0);
  });

  it("puts a bib claimant's teammates in bibs and everyone else on the other side", () => {
    const bib = bibKit(bibMatch)!;
    const pick = seedTeams(YELLOW[0], [], bib)!;
    expect(sideOfKit(YELLOW[5], pick)).toBe(0);
    expect(sideOfKit(NO_BIB.white6, pick)).toBe(1);
    expect(sideOfKit(NO_BIB.red44, pick)).toBe(1);
  });

  it("counts a pass from the purple 11 to the white 6 as completed", () => {
    const bib = bibKit(bibMatch)!;
    const pick = seedTeams(NO_BIB.purple11, [], bib);
    const touch = (t: number, trackId: string, kit: Lab, x: number): Touch => ({ f: t * 20, t, segmentIndex: 0, trackId, kit, ball: [x, 10], foot: [x, 10], d: 0.5, reassigned: false });
    const [event] = passEvents([touch(10, "s0:t1", NO_BIB.purple11, 5), touch(11.5, "s0:t2", NO_BIB.white6, 21)], pick);
    expect(event?.kind).toBe("pass");
    expect(event?.sameTeam).toBe(true);
    // without the bib line the white shirt sat nearer the yellow bib than the purple one
    const old = seedTeams(NO_BIB.purple11, [{ lab: [71, 134, 129], secs: 900 }, { lab: [146, 124, 141], secs: 1200 }]);
    expect(old && sideOfKit(NO_BIB.white6, old)).toBe(1);
  });

  it("finds no bib in a white-against-black match and leaves the old split alone", () => {
    expect(bibKit(plainMatch)).toBeNull();
  });
});

describe("match rooms when one side wears bibs", () => {
  // the room on recording 401 measured these two side colours from its claimants:
  // a white shirt on one side, red + purple on the other -- all three not in bibs
  const roomWhite: Lab = [165.9, 128.3, 129.6];
  const roomDark: Lab = [84.5, 142.6, 133.4];

  it("shows the bib colour against the mean of every shirt outside the bib line", () => {
    const bib = bibKit(bibMatch)!;
    const kits = bibObservedKits(bibMatch, bib)!;
    expect(kits[0]).toEqual(bib.lab);
    expect(isBibKit(kits[1], bib)).toBe(false);
    const pick = bibPick(bib, kits[0], kits[1])!;
    for (const lab of YELLOW) expect(sideOfKit(lab, pick)).toBe(0);
    for (const lab of Object.values(NO_BIB)) expect(sideOfKit(lab, pick)).toBe(1);
  });

  it("splits on the bib line once the room's sides are bib and not-bib", () => {
    const bib = bibKit(bibMatch)!;
    const pick = bibPick(bib, roomDark, bib.lab)!;
    expect(sideOfKit(NO_BIB.white6, pick)).toBe(0);
    expect(sideOfKit(NO_BIB.pink10, pick)).toBe(0);
    expect(sideOfKit(YELLOW[3], pick)).toBe(1);
  });

  it("keeps the colour split when both room sides are outside the bib line", () => {
    const bib = bibKit(bibMatch)!;
    expect(bibPick(bib, roomWhite, roomDark)).toBeNull();
    expect(bibPick(null, roomWhite, roomDark)).toBeNull();
  });

  it("would have put the white shirt with the bibs by plain colour distance", () => {
    // the old room colours for an unclaimed side came from a light/dark 2-means;
    // against white, the yellow bibs are nearer white than the dark side
    const nearest = { a: roomWhite, b: roomDark };
    expect(sideOfKit(YELLOW[0], nearest)).toBe(0);
  });
});

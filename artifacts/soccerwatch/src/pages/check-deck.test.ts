import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Layout and colour rules of the "Is this you?" deck, read off its source:
 * the page renders hls.js video and pointer drags, which a node test cannot
 * mount, and these rules are about class names.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const page = read("./check-deck.tsx");
const video = read("../components/check-deck/DeckVideo.tsx");

const lineWith = (src: string, needle: string) => src.split("\n").find((line) => line.includes(needle)) ?? "";

describe("swipe stamps sit on fixed sides", () => {
  // right is yes in every language, so the stamps must not swap in Arabic
  it("puts 'yes' on the left and 'no' on the right in both directions", () => {
    const yes = lineWith(page, "ref={yesRef}");
    const no = lineWith(page, "ref={noRef}");
    expect(yes).toMatch(/\bleft-5\b/);
    expect(no).toMatch(/\bright-5\b/);
    for (const stamp of [yes, no]) expect(stamp).not.toMatch(/\b(start|end)-5\b/);
  });
});

describe("no English left in the deck video", () => {
  it("takes the 'field view' label from the copy", () => {
    expect(video).not.toMatch(/>\s*field view\s*</);
  });
});

describe("live red is for a live camera only", () => {
  // #FF5A3C / --replay-live / text-live mean "this camera is live"
  it("is not used anywhere in the deck", () => {
    const live = /(text|bg|border|ring|fill|stroke)-live\b|replay-live|#?ff5a3c|255,\s*90,\s*60/i;
    expect(page).not.toMatch(live);
    expect(video).not.toMatch(live);
  });
});

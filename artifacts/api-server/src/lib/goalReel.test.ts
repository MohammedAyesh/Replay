import { describe, expect, it } from "vitest";
import { REEL, reelCards, reelOrder, type ReelPlay } from "./goalReel";
import type { ReplayGoal } from "./matchFeed";

const goal = (over: Partial<ReplayGoal>): ReplayGoal => ({
  atSeconds: 600,
  side: "A",
  scorer: null,
  scorers: [],
  recordingId: 1,
  gameIndex: null,
  t: 500,
  status: "open",
  source: "shot",
  key: 5000,
  ownGoal: false,
  confirmedBy: [],
  rejectedBy: [],
  myVote: null,
  ...over,
});

// a ball every quarter second (4 Hz at 20 fps = every 5 frames), moving right
const ball: ReelPlay["ball"] = Array.from({ length: 4000 }, (_, k) => [k * 5, 100 + k, 500] as const);
const play: ReelPlay = { manifest: { frameRate: 20, width: 3840, height: 1080, videoStartSeconds: 1.48 }, ball };

describe("goal reel", () => {
  it("plays open chances only, likely goals first, then the rest in match order", () => {
    const order = reelOrder([
      goal({ key: 1, atSeconds: 900, source: "shot" }),
      goal({ key: 2, atSeconds: 300, source: "event" }),
      goal({ key: 3, atSeconds: 1200, source: "goal" }),
      goal({ key: 4, atSeconds: 100, source: "goal" }),
      goal({ key: 5, atSeconds: 50, status: "confirmed" }),
      goal({ key: 6, atSeconds: 60, status: "rejected" }),
    ]);
    expect(order.map((g) => g.key)).toEqual([4, 3, 2, 1]);
  });

  it("puts each card on the video clock and follows the ball through it", () => {
    const [card] = reelCards([goal({ t: 500, atSeconds: 610, key: 5000, recordingId: 1, source: "goal", scorer: { playerId: 9, name: "Ali" } })], new Map([[1, play]]));
    expect(card.id).toBe("1:5000");
    expect(card.at).toBeCloseTo(501.48, 3);
    expect(card.start).toBeCloseTo(500 - REEL.before + 1.48, 3);
    expect(card.end).toBeCloseTo(500 + REEL.after + 1.48, 3);
    expect(card.minute).toBe(11);
    expect(card.clock).toBe("10:10");
    expect(card.likely).toBe(true);
    expect(card.scorer).toBe("Ali");
    // focus starts at the card's start, on the video clock, as fractions of the frame
    expect(card.focus[0][0]).toBeCloseTo(card.start, 3);
    expect(card.focus.every((f) => f[1] > 0 && f[1] < 1 && f[2] > 0 && f[2] < 1)).toBe(true);
    expect(card.focus[card.focus.length - 1][1]).toBeGreaterThan(card.focus[0][1]);
  });

  it("drops chances whose recording cannot play and caps the reel", () => {
    const review = Array.from({ length: 10 }, (_, k) => goal({ key: k, atSeconds: k * 60, t: k * 60, recordingId: k % 2 ? 2 : 1 }));
    const cards = reelCards(review, new Map([[1, play]]), 3);
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => c.recordingId === 1)).toBe(true);
  });

  it("never starts a card before the video", () => {
    const [card] = reelCards([goal({ t: 1, atSeconds: 1 })], new Map([[1, { ...play, manifest: { ...play.manifest, videoStartSeconds: 0 } }]]));
    expect(card.start).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { focusFromCrop, MOMENT_REEL, momentReelCards, type MomentInput } from "./momentReel";

const input = (over: Omit<Partial<MomentInput>, "moment"> & { moment?: Partial<MomentInput["moment"]> } = {}): MomentInput => ({
  recordingId: 401,
  recordingOffsetSec: 100,
  videoStartSeconds: 0,
  recordingDuration: 3600,
  ...over,
  moment: { id: "dribble-600", title: "Your dribble · 9 m past 1 player · 10:00", kind: "dribble", momentSeconds: 600, userClipId: 7, ...over.moment },
  clip: over.clip === undefined
    ? { id: 7, startTime: 592 / 3600, endTime: 608 / 3600, cropPath: [{ t: 0, x: 0.1, y: 0.2, w: 0.34, h: 0.9 }, { t: 1, x: 0.3, y: 0.05, w: 0.34, h: 0.9 }], isHidden: false }
    : over.clip,
});

describe("moment reel", () => {
  it("plays each kept moment around its time, on the booking minute, following him", () => {
    const [card] = momentReelCards([input()]);
    expect(card.id).toBe("401:dribble-600");
    expect(card.userClipIds).toEqual([7]);
    expect(card.at).toBe(600);
    expect(card.start).toBe(600 - MOMENT_REEL.before);
    expect(card.end).toBe(600 + MOMENT_REEL.after);
    expect(card.minute).toBe(12); // 600 + 100 booking seconds
    expect(card.clock).toBe("11:40");
    expect(card.focus[0]).toEqual([592, 0.27, 0.695, MOMENT_REEL.ringW, MOMENT_REEL.ringH]);
    expect(card.focus[1][0]).toBe(608);
  });

  it("leaves out moments without a clip and clips he deleted or that were hidden", () => {
    expect(momentReelCards([
      input({ clip: null }),
      input({ moment: { id: "a", userClipId: undefined } }),
      input({ clip: { id: 7, startTime: 0.1, endTime: 0.2, cropPath: [], isHidden: true } }),
    ])).toHaveLength(0);
  });

  it("shows a moment once when the footage was analysed twice, and dropping it drops both clips", () => {
    const cards = momentReelCards([
      input({ moment: { id: "late", momentSeconds: 900, userClipId: 9 } }),
      input(),
      input({ recordingId: 402, moment: { id: "dribble-600b", userClipId: 8, momentSeconds: 601 } }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["401:dribble-600", "401:late"]);
    expect(cards[0].userClipIds).toEqual([7, 8]);
  });

  it("follows nobody when the clip has no follow path", () => {
    expect(focusFromCrop({ id: 1, startTime: 0.1, endTime: 0.2, cropPath: [], isHidden: false }, 3600)).toEqual([]);
  });
});

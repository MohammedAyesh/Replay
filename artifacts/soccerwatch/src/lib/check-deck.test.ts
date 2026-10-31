import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnswerQueue, deckTally, toastKind, type AnswerOutcome, type DeckCard } from "./check-deck";

const you = (id: string): DeckCard => ({ id: `you:${id}`, kind: "you", at: 0, start: 0, end: 8, clock: "00:10", focus: [] });
const goal = (key: number): DeckCard => ({ id: `goal:${key}`, kind: "goal", at: 0, start: 0, end: 8, clock: "00:10", focus: [] });
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); });

describe("answer queue: what the server said about each answer", () => {
  it("a 404 (a card that is no longer waiting) is not a clip", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404, { error: "That moment is not waiting for an answer" })));
    const failed: string[] = [];
    const outcome = await createAnswerQueue(1, (id) => failed.push(id)).push("you:m1", "yes");
    expect(outcome).toEqual({ status: "stale", clip: false, completed: null });
    expect(failed).toEqual([]);
  });

  it("passes on the clip and completion the server reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { ok: true, clip: true, userClipId: 9, completed: true })));
    expect(await createAnswerQueue(1, () => {}).push("you:m1", "yes")).toEqual({ status: "saved", clip: true, completed: true });
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { ok: true, clip: false, userClipId: null, completed: false })));
    expect(await createAnswerQueue(1, () => {}).push("you:m1", "yes")).toEqual({ status: "saved", clip: false, completed: false });
  });

  it("an answer that fails twice is reported, and is no clip", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(503)));
    const failed: string[] = [];
    const outcome = await createAnswerQueue(1, (id) => failed.push(id)).push("you:m1", "yes");
    expect(outcome).toEqual({ status: "failed", clip: false, completed: null });
    expect(failed).toEqual(["you:m1"]);
  });
});

describe("toast: '+1 clip' only for a clip that is made", () => {
  const saved = (clip: boolean): AnswerOutcome => ({ status: "saved", clip, completed: clip });

  it("on a claim that does not count yet says 'kept' at once, never '+1 clip'", () => {
    expect(toastKind(you("a"), "yes", false)).toBe("kept");
  });

  it("on a claim that counts waits for the server, then says what it did", () => {
    expect(toastKind(you("a"), "yes", true)).toBe("wait");
    expect(toastKind(you("a"), "yes", true, saved(true))).toBe("clip");
    expect(toastKind(you("a"), "yes", true, saved(false))).toBe("kept");
    expect(toastKind(you("a"), "yes", true, { status: "stale", clip: false, completed: null })).toBe("stale");
    expect(toastKind(you("a"), "yes", true, { status: "failed", clip: false, completed: null })).toBeNull();
  });

  it("keeps the other answers' toasts", () => {
    expect(toastKind(you("a"), "no", true)).toBe("notYou");
    expect(toastKind(goal(3), "yes", false)).toBe("goal");
    expect(toastKind(goal(3), "no", false)).toBe("noGoal");
    expect(toastKind(you("a"), "skip", true)).toBeNull();
  });
});

describe("done screen: clips counted from what the server made", () => {
  it("counts a kept moment as a clip only when the server made one", () => {
    const tally = deckTally([
      { card: you("a"), verdict: "yes", outcome: { status: "saved", clip: true, completed: true } },
      { card: you("b"), verdict: "yes", outcome: { status: "saved", clip: false, completed: false } },
      { card: you("c"), verdict: "yes", outcome: { status: "stale", clip: false, completed: null } },
      { card: you("d"), verdict: "yes" }, // not answered by the server yet
      { card: you("e"), verdict: "no" },
      { card: goal(1), verdict: "yes" },
      { card: goal(2), verdict: "skip" },
    ]);
    expect(tally).toEqual({ clips: 1, kept: 2, sentBack: 1, goals: 1, answered: 6 });
  });

  it("an under-the-bar claim makes no clips however many are kept", () => {
    const tally = deckTally([
      { card: you("a"), verdict: "yes", outcome: { status: "saved", clip: false, completed: false } },
      { card: you("b"), verdict: "yes", outcome: { status: "saved", clip: false, completed: false } },
    ]);
    expect(tally.clips).toBe(0);
    expect(tally.kept).toBe(2);
  });
});

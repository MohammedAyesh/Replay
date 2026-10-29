import { describe, expect, it } from "vitest";
import type { ClaimMatchClipGroup, UserClip } from "@workspace/api-client-react";
import { buildMomentDeck, keptClipIds, momentNumbers, momentPlayback, momentSave, momentTitle, saveSummary, visibleMoments } from "./moment-deck";

const clip = (id: number, over: Partial<UserClip> = {}) => ({
  id, title: `clip ${id}`, isHidden: false, exportStatus: "done", exportedUrl: `https://storage.bunnycdn.com/galaxyfield/clips/${id}.mp4`,
  playbackUrl: `/api/bunny/play/${id}.m3u8`, aspectRatio: "16:9", ...over,
} as unknown as UserClip);
const moment = (id: string, t: number, userClipId?: number) => ({ id, title: id, momentSeconds: t, kind: "long-pass", status: "ready", userClipId });

const groups: ClaimMatchClipGroup[] = [
  { recordingId: 394, recordingLabel: "Galaxy · 1", fieldName: "Galaxy", date: "2026-10-12", clips: [moment("b", 3098, 12), moment("a", 1597, 11)] },
  { recordingId: 401, recordingLabel: "Galaxy · 1", fieldName: "Galaxy", date: "2026-10-22", clips: [moment("c", 2380, 21), moment("d", 600, 22), moment("e", 900)] },
];

describe("saved state", () => {
  it("is saved only with a finished export file", () => {
    expect(momentSave(clip(1))).toBe("saved");
    expect(momentSave(clip(1, { exportStatus: "pending" }))).toBe("saving");
    expect(momentSave(clip(1, { exportStatus: "done", exportedUrl: null }))).toBe("saving");
    expect(momentSave(clip(1, { exportStatus: null }))).toBe("saving");
    expect(momentSave(clip(1, { exportStatus: "error" }))).toBe("saving");
    expect(momentSave(clip(1, { exportStatus: "expired" }))).toBe("lost");
    expect(momentSave(undefined)).toBe("saving");
  });

  it("plays the saved file when there is one, else the match video", () => {
    expect(momentPlayback(clip(7))).toEqual({ kind: "file", url: "/api/user-clips/7/playback" });
    expect(momentPlayback(clip(7, { exportStatus: "pending" }))).toEqual({ kind: "stream", url: "/api/bunny/play/7.m3u8" });
    expect(momentPlayback(clip(7, { exportStatus: "pending", playbackUrl: null }))).toBeNull();
  });
});

describe("visible moments", () => {
  const byId = new Map([11, 12, 21].map((id) => [id, clip(id)]));
  it("leaves out a moment whose clip was deleted, once the clip list is in", () => {
    expect(visibleMoments(groups[1], byId, true).map((m) => m.id)).toEqual(["c", "e"]);
    expect(visibleMoments(groups[1], byId, false).map((m) => m.id)).toEqual(["c", "d", "e"]);
  });
  it("counts saved, saving and lost across matches", () => {
    const mixed = new Map([[11, clip(11)], [12, clip(12, { exportStatus: "pending" })], [21, clip(21, { exportStatus: "expired" })]]);
    expect(saveSummary(groups, mixed, true)).toEqual({ saved: 1, saving: 2, lost: 1, total: 4 });
  });
});

describe("the deck", () => {
  it("runs newest match first, in match order, without lost, missing or hidden clips", () => {
    const byId = new Map([[11, clip(11)], [12, clip(12)], [21, clip(21)], [22, clip(22, { exportStatus: "expired" })]]);
    expect(buildMomentDeck(groups, byId).map((c) => c.clipId)).toEqual([21, 11, 12]);
    byId.set(21, clip(21, { isHidden: true }));
    expect(buildMomentDeck(groups, byId).map((c) => c.clipId)).toEqual([11, 12]);
  });
  it("can be one match only, and offers a clip once", () => {
    const byId = new Map([[11, clip(11)], [12, clip(12)], [21, clip(21)]]);
    expect(buildMomentDeck(groups, byId, 394).map((c) => c.clipId)).toEqual([11, 12]);
    const twice = [{ ...groups[0], clips: [moment("a", 10, 11), moment("a2", 20, 11)] }];
    expect(buildMomentDeck(twice, byId).map((c) => c.clipId)).toEqual([11]);
  });
  it("keeps the kept clips in the order they were kept, up to the reel's limit", () => {
    const choices = [{ clipId: 3, keep: true }, { clipId: 4, keep: false }, { clipId: 1, keep: true }, { clipId: 3, keep: true }, { clipId: 9, keep: true }];
    expect(keptClipIds(choices, 10)).toEqual([3, 1, 9]);
    expect(keptClipIds(choices, 2)).toEqual([3, 1]);
  });
});

describe("titles in the player's language", () => {
  it("reads the numbers out of the server's title", () => {
    expect(momentNumbers("Pass found · 18 m · 26:36")).toEqual({ metres: 18, beaten: null });
    expect(momentNumbers("Your dribble · 9 m past 2 players · 52:00")).toEqual({ metres: 9, beaten: 2 });
    expect(momentNumbers("Your goal · 14:48")).toEqual({ metres: null, beaten: null });
  });
  it("writes Arabic for the kinds it knows and keeps English as the server wrote it", () => {
    expect(momentTitle({ kind: "long-pass", title: "Pass found · 18 m · 26:36" }, "ar")).toBe("تمريرة وصلت · 18 م");
    expect(momentTitle({ kind: "dribble", title: "Your dribble · 9 m past 1 player · 52:00" }, "ar")).toBe("مراوغتك · 9 م، تخطّيت لاعب");
    expect(momentTitle({ kind: "dribble", title: "Your dribble · 12 m past 3 players · 52:00" }, "ar")).toBe("مراوغتك · 12 م، تخطّيت 3 لاعبين");
    expect(momentTitle({ kind: "your-shot", title: "Your shot on target · 25:41" }, "ar")).toBe("تسديدتك على المرمى");
    expect(momentTitle({ kind: "goal", title: "Goal · Yellow · 40:02" }, "ar")).toBe("Goal · Yellow · 40:02");
    expect(momentTitle({ kind: "long-pass", title: "Pass found · 18 m · 26:36" }, "en")).toBe("Pass found · 18 m");
    expect(momentTitle({ kind: "goal", title: "Goal · Yellow · 1:40:02" }, "en")).toBe("Goal · Yellow");
    expect(momentTitle({ kind: "goal", title: "Goal" }, "en")).toBe("Goal");
  });
});

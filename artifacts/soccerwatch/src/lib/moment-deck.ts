import type { ClaimEarnedClip, ClaimMatchClipGroup, UserClip } from "@workspace/api-client-react";

/**
 * My Clips → Moments: every moment Replay found for the player, whether its
 * clip is safely saved, and the deck he swipes through to pick a reel.
 *
 * A moment's clip is "saved" once its export is a file in Storage: those are
 * kept forever, so the moment (and any reel made from it) outlives the match
 * video, which the 14-day cleanup deletes.
 */

export type MomentSave = "saved" | "saving" | "lost";

/** Whether a moment's clip is kept forever yet. No clip row yet is still saving. */
export function momentSave(clip: Pick<UserClip, "exportStatus" | "exportedUrl"> | undefined | null): MomentSave {
  if (!clip) return "saving";
  if (clip.exportStatus === "done" && clip.exportedUrl) return "saved";
  if (clip.exportStatus === "expired") return "lost";
  return "saving";
}

/** How to play a moment in the deck: its saved file when there is one, else the match video. */
export function momentPlayback(clip: Pick<UserClip, "id" | "exportStatus" | "exportedUrl" | "playbackUrl">):
  { kind: "file"; url: string } | { kind: "stream"; url: string } | null {
  if (momentSave(clip) === "saved") return { kind: "file", url: `/api/user-clips/${clip.id}/playback` };
  if (clip.playbackUrl) return { kind: "stream", url: clip.playbackUrl };
  return null;
}

/**
 * The moments to show for one match. A moment whose clip the player deleted
 * (or an admin hid) is gone from his clip list, so it is left out here too;
 * until the clip list has loaded nothing is left out, so nothing flickers.
 */
export function visibleMoments(
  group: Pick<ClaimMatchClipGroup, "clips">,
  clipsById: ReadonlyMap<number, UserClip>,
  clipsLoaded: boolean,
): ClaimEarnedClip[] {
  return group.clips.filter((m) => !(clipsLoaded && m.userClipId && !clipsById.has(m.userClipId)));
}

export type SaveSummary = { saved: number; saving: number; lost: number; total: number };

export function saveSummary(
  groups: readonly Pick<ClaimMatchClipGroup, "clips">[] | undefined,
  clipsById: ReadonlyMap<number, UserClip>,
  clipsLoaded: boolean,
): SaveSummary {
  const out: SaveSummary = { saved: 0, saving: 0, lost: 0, total: 0 };
  for (const group of groups ?? []) {
    for (const m of visibleMoments(group, clipsById, clipsLoaded)) {
      out[momentSave(m.userClipId ? clipsById.get(m.userClipId) : undefined)]++;
      out.total++;
    }
  }
  return out;
}

export type DeckMoment = {
  /** the user clip's id: what a reel is made of */
  clipId: number;
  clip: UserClip;
  moment: ClaimEarnedClip;
  recordingId: number;
  matchLabel: string;
  date: string;
  save: MomentSave;
};

/**
 * The cards to swipe: every moment that can be played and put in a reel,
 * newest match first and in match order within a match. A moment whose clip
 * was lost (match video gone before it was saved) cannot be in a reel, so it
 * is not offered. Pass a recording id to swipe through one match only.
 */
export function buildMomentDeck(
  groups: readonly ClaimMatchClipGroup[] | undefined,
  clipsById: ReadonlyMap<number, UserClip>,
  recordingId?: number | null,
): DeckMoment[] {
  const ordered = [...(groups ?? [])]
    .filter((g) => recordingId == null || g.recordingId === recordingId)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.recordingId - a.recordingId);
  const seen = new Set<number>();
  const deck: DeckMoment[] = [];
  for (const group of ordered) {
    const moments = [...group.clips].sort((a, b) => a.momentSeconds - b.momentSeconds);
    for (const moment of moments) {
      const clip = moment.userClipId ? clipsById.get(moment.userClipId) : undefined;
      if (!clip || clip.isHidden || seen.has(clip.id)) continue;
      const save = momentSave(clip);
      if (save === "lost" || !momentPlayback(clip)) continue;
      seen.add(clip.id);
      deck.push({ clipId: clip.id, clip, moment, recordingId: group.recordingId, matchLabel: group.recordingLabel, date: group.date, save });
    }
  }
  return deck;
}

/** One swipe: what was decided about which card. */
export type DeckChoice = { clipId: number; keep: boolean };

/** The kept clips, in the order they were kept, at most `max`. */
export function keptClipIds(choices: readonly DeckChoice[], max: number): number[] {
  const out: number[] = [];
  for (const c of choices) {
    if (c.keep && !out.includes(c.clipId)) out.push(c.clipId);
    if (out.length >= max) break;
  }
  return out;
}

/** The numbers in a moment's server title ("Pass found · 18 m · 26:36", "Your dribble · 9 m past 2 players · 52:00"). */
export function momentNumbers(title: string): { metres: number | null; beaten: number | null } {
  const metres = title.match(/(\d+(?:\.\d+)?)\s*m\b/);
  const beaten = title.match(/past (\d+) player/);
  return { metres: metres ? Number(metres[1]) : null, beaten: beaten ? Number(beaten[1]) : null };
}

/**
 * A moment's title in Arabic. The server writes titles in English; for the
 * kinds the app knows, Arabic is built from the kind and the title's numbers,
 * without the clock (the row shows the time next to it). Anything else keeps
 * the server's title.
 */
export function arabicMomentTitle(moment: Pick<ClaimEarnedClip, "kind" | "title">): string {
  const { metres, beaten } = momentNumbers(moment.title);
  switch (moment.kind) {
    case "your-goal": return "جولك";
    case "your-shot": return "تسديدتك على المرمى";
    case "long-pass": return metres != null ? `تمريرة وصلت · ${metres} م` : "تمريرة وصلت";
    case "dribble": {
      const past = beaten == null ? "" : beaten === 1 ? "، تخطّيت لاعب" : beaten === 2 ? "، تخطّيت لاعبين" : `، تخطّيت ${beaten} لاعبين`;
      return metres != null ? `مراوغتك · ${metres} م${past}` : `مراوغتك${past}`;
    }
    default: return moment.title;
  }
}

/**
 * The title to show in the player's language. The match clock the server
 * appends ("· 26:36") is dropped: every place that shows a title shows the
 * time next to it.
 */
export function momentTitle(moment: Pick<ClaimEarnedClip, "kind" | "title">, locale: "en" | "ar"): string {
  if (locale === "ar") return arabicMomentTitle(moment);
  return moment.title.replace(/\s*·\s*\d+:\d{2}(?::\d{2})?\s*$/, "") || moment.title;
}

import { useQuery } from "@tanstack/react-query";
import { apiBase, matchKey } from "@/lib/match-api";
import type { FocusPoint } from "@/lib/check-deck";

/**
 * "Your moments" as a reel (GET /m/:code/moments/reel, 2026-11-01): the
 * player's own moments in this match that are clips in his My Clips, to keep
 * or drop one after another. Played like the goal reel: each card is a few
 * seconds on Bunny's CDN, following him.
 *
 * Keeping changes nothing on the server (the clip is already saved); the
 * moments he kept are remembered on this device so the reel does not ask
 * again. Dropping deletes the clip (DELETE /user-clips/:id, as in My Clips),
 * and only when the reel closes, so Back can take it back until then.
 */

export type MomentReelCard = {
  id: string;
  recordingId: number;
  momentId: string;
  userClipIds: number[];
  kind: string;
  title: string;
  at: number;
  start: number;
  end: number;
  minute: number;
  clock: string;
  focus: FocusPoint[];
  clip?: { url: string; offset: number } | null;
};

export type MomentReel = { recordings: Array<{ recordingId: number; srcW: number; srcH: number }>; cards: MomentReelCard[] };

export const momentReelKey = (code: string) => [...matchKey(code), "moment-reel"] as const;

export function useMomentReel(code: string, enabled: boolean) {
  return useQuery({
    queryKey: momentReelKey(code),
    queryFn: async (): Promise<MomentReel> => {
      const response = await fetch(`${apiBase}/m/${encodeURIComponent(code)}/moments/reel`, { credentials: "include" });
      if (!response.ok) throw new Error(`moment reel ${response.status}`);
      return response.json() as Promise<MomentReel>;
    },
    enabled: Boolean(code) && enabled,
    staleTime: 60_000,
    retry: 1,
  });
}

export const momentClipUrl = (code: string, card: Pick<MomentReelCard, "recordingId" | "momentId">) =>
  `${apiBase}/m/${encodeURIComponent(code)}/moments/reel/clip?recordingId=${card.recordingId}&momentId=${encodeURIComponent(card.momentId)}`;

/* ------------------------------------------------- kept, on this device */

const keptKey = (code: string) => `replay.momentReel.kept.${code.toUpperCase()}`;

/** The moments he kept in this match's reel before (this device). */
export function keptMoments(code: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(keptKey(code));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberKept(code: string, ids: Iterable<string>): void {
  try {
    const all = keptMoments(code);
    for (const id of ids) all.add(id);
    window.localStorage.setItem(keptKey(code), JSON.stringify([...all].slice(-500)));
  } catch { /* private mode: it asks again next time, nothing is lost */ }
}

/** The cards still to decide: not kept before on this device. */
export function undecided(code: string, cards: readonly MomentReelCard[] | undefined): MomentReelCard[] {
  if (!cards?.length) return [];
  const kept = keptMoments(code);
  return cards.filter((c) => !kept.has(c.id));
}

/* ------------------------------------------------- dropping, on close */

/**
 * Delete the dropped moments' clips. Sent once, when the reel closes (or the
 * page is being left), with keepalive so a closing tab still sends them. A
 * clip already deleted answers 200 again; a failure leaves the clip saved,
 * which is the safe side.
 */
export async function dropClips(clipIds: readonly number[]): Promise<{ failed: number[] }> {
  const failed: number[] = [];
  await Promise.all([...new Set(clipIds)].map(async (id) => {
    try {
      const response = await fetch(`${apiBase}/user-clips/${id}`, { method: "DELETE", credentials: "include", keepalive: true });
      if (!response.ok && response.status !== 404) failed.push(id);
    } catch {
      failed.push(id);
    }
  }));
  return { failed };
}

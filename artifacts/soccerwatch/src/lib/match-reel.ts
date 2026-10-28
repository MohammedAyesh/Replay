import { useMemo } from "react";
import { useListClaimMatchClips, getListClaimMatchClipsQueryKey } from "@workspace/api-client-react";
import { useMatchClips, useMatchReplay } from "@/lib/match-api";

/** Where "a reel of this match" opens: My Clips → Reels, builder open, this match's clips picked. */
export function matchReelPath(code: string): string {
  return `/my-clips?tab=reels&match=${encodeURIComponent(code)}`;
}

/** The match code a My Clips link asks for, if any (`?match=ABC123`). */
export function reelMatchFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get("match")?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

/**
 * The ids of the viewer's clips from one match: the ones he cut (they carry the
 * match's booking) and the moments Replay cut for him after he found himself
 * (those carry the recording instead, so they are matched by recording).
 */
export function useMyMatchClipIds(code: string | null, enabled: boolean): { ids: Set<number>; loading: boolean } {
  const on = Boolean(code) && enabled;
  const clips = useMatchClips(code ?? "", on);
  const replay = useMatchReplay(code ?? "", on);
  const moments = useListClaimMatchClips({ query: { enabled: on, queryKey: getListClaimMatchClipsQueryKey() } });
  const ids = useMemo(() => {
    const out = new Set<number>();
    for (const clip of clips.data ?? []) if (clip.mine) out.add(clip.id);
    const recordings = new Set(replay.data?.recordings ?? []);
    for (const group of moments.data ?? []) {
      if (!recordings.has(group.recordingId)) continue;
      for (const clip of group.clips) if (typeof clip.userClipId === "number") out.add(clip.userClipId);
    }
    return out;
  }, [clips.data, replay.data, moments.data]);
  return { ids, loading: on && (clips.isLoading || replay.isLoading || moments.isLoading) };
}

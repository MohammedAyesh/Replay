import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiBase, matchKey } from "@/lib/match-api";
import type { FocusPoint } from "@/lib/check-deck";

/**
 * "Was it a goal?" as a reel (GET /m/:code/goals/reel, 2026-10-31): every
 * chance nobody has decided, likely goals first, each a few seconds of the
 * match recording with the ball's path through it.
 */

export type ReelRecording = { recordingId: number; videoUrl: string; srcW: number; srcH: number };

export type ReelCard = {
  id: string;
  recordingId: number;
  key: number;
  /** video seconds on its recording */
  at: number;
  start: number;
  end: number;
  minute: number;
  clock: string;
  likely: boolean;
  source: "goal" | "shot" | "event";
  side: "A" | "B" | "C" | null;
  ownGoal: boolean;
  scorer: string | null;
  focus: FocusPoint[];
};

export type GoalReel = { recordings: ReelRecording[]; cards: ReelCard[]; open: number };

export type ReelVerdict = "goal" | "not_goal" | null;

export const goalReelKey = (code: string) => [...matchKey(code), "goal-reel"] as const;

export function useGoalReel(code: string, enabled: boolean) {
  return useQuery({
    queryKey: goalReelKey(code),
    queryFn: async (): Promise<GoalReel> => {
      const response = await fetch(`${apiBase}/m/${encodeURIComponent(code)}/goals/reel`, { credentials: "include" });
      if (!response.ok) throw new Error(`goal reel ${response.status}`);
      return response.json() as Promise<GoalReel>;
    },
    enabled: Boolean(code) && enabled,
    staleTime: 60_000,
    retry: 1,
  });
}

type Vote = { recordingId: number; key: number; verdict: ReelVerdict };

/**
 * The reel's answers, saved behind it. An answer goes at once; answers given
 * while a save is on its way wait and go together in the next one, so a quick
 * thumb never queues one request per card. The last answer on a chance wins
 * (an undo sends null). A failed save is tried once more, then reported.
 */
export function createVoteSaver(code: string, onFailed: (ids: string[]) => void) {
  const waiting = new Map<string, Vote>();
  let running: Promise<void> | null = null;
  const post = async (votes: Vote[]) => {
    const response = await fetch(`${apiBase}/m/${encodeURIComponent(code)}/goals/votes`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ votes }),
      keepalive: votes.length <= 20,
    });
    if (!response.ok) throw new Error(`votes ${response.status}`);
  };
  const pump = async () => {
    while (waiting.size) {
      const batch = [...waiting.entries()].slice(0, 50);
      for (const [id] of batch) waiting.delete(id);
      const votes = batch.map(([, v]) => v);
      try { await post(votes); } catch {
        try { await new Promise((r) => setTimeout(r, 800)); await post(votes); } catch { onFailed(batch.map(([id]) => id)); }
      }
    }
    running = null;
  };
  return {
    push(id: string, vote: Vote) {
      waiting.delete(id);
      waiting.set(id, vote);
      if (!running) running = pump();
    },
    async drain() {
      while (running) await running;
    },
  };
}

/* ------------------------------------------------------------- the clips */

export type ReelClipState =
  | { status: "loading" }
  | { status: "ready"; url: string; offset: number }
  | { status: "failed" };

export const reelClipUrl = (code: string, card: Pick<ReelCard, "recordingId" | "key">) =>
  `${apiBase}/m/${encodeURIComponent(code)}/goals/reel/clip?recordingId=${card.recordingId}&key=${card.key}`;

/** cards fetched ahead of the one on screen */
export const REEL_AHEAD = 3;
/** downloads at once; the card on screen always goes first */
const PARALLEL = 2;

/**
 * Each card's MP4, downloaded into memory ahead of time: the card on screen
 * first, then the next REEL_AHEAD, two at a time. A file is kept while its
 * card is within reach (one back for Back), then released. A failed download
 * is tried once more.
 */
export function useReelClips(code: string, cards: readonly ReelCard[] | null, index: number) {
  const [clips, setClips] = useState<Record<string, ReelClipState>>({});
  const urls = useRef(new Map<string, string>());
  const inFlight = useRef(new Map<string, AbortController>());
  const tries = useRef(new Map<string, number>());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!cards?.length) return;
    const keep = new Set(cards.slice(Math.max(0, index - 1), index + REEL_AHEAD + 1).map((c) => c.id));
    // release what is out of reach
    for (const [id, url] of urls.current) {
      if (keep.has(id)) continue;
      URL.revokeObjectURL(url);
      urls.current.delete(id);
      setClips((s) => { const { [id]: _, ...rest } = s; return rest; });
    }
    for (const [id, ctl] of inFlight.current) if (!keep.has(id)) { ctl.abort(); inFlight.current.delete(id); }
    // fetch in order of need: this card, the next ones, then the one before
    const order = [...cards.slice(index, index + REEL_AHEAD + 1), ...(index > 0 ? [cards[index - 1]!] : [])];
    for (const card of order) {
      if (inFlight.current.size >= PARALLEL) break;
      if (urls.current.has(card.id) || inFlight.current.has(card.id)) continue;
      if ((tries.current.get(card.id) ?? 0) >= 2) continue;
      const ctl = new AbortController();
      inFlight.current.set(card.id, ctl);
      tries.current.set(card.id, (tries.current.get(card.id) ?? 0) + 1);
      setClips((s) => (s[card.id]?.status === "loading" ? s : { ...s, [card.id]: { status: "loading" } }));
      void (async () => {
        try {
          const response = await fetch(reelClipUrl(code, card), { credentials: "include", signal: ctl.signal });
          if (!response.ok) throw new Error(`clip ${response.status}`);
          const offset = Number(response.headers.get("x-clip-offset") ?? "0") || 0;
          const blob = await response.blob();
          const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "video/mp4" }));
          urls.current.set(card.id, url);
          setClips((s) => ({ ...s, [card.id]: { status: "ready", url, offset } }));
        } catch {
          if (ctl.signal.aborted) return;
          if ((tries.current.get(card.id) ?? 0) >= 2) setClips((s) => ({ ...s, [card.id]: { status: "failed" } }));
        } finally {
          if (inFlight.current.get(card.id) === ctl) inFlight.current.delete(card.id);
          setNonce((n) => n + 1);
        }
      })();
    }
  }, [code, cards, index, nonce]);

  // everything goes when the reel closes
  useEffect(() => () => {
    for (const ctl of inFlight.current.values()) ctl.abort();
    for (const url of urls.current.values()) URL.revokeObjectURL(url);
  }, []);

  const retry = useCallback((id: string) => {
    tries.current.delete(id);
    setClips((s) => ({ ...s, [id]: { status: "loading" } }));
    setNonce((n) => n + 1);
  }, []);

  return { clips, retry };
}

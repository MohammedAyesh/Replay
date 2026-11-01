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
  /** the card's MP4 on Bunny's CDN when it is already there; else ask reelClipUrl */
  clip?: { url: string; offset: number } | null;
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
export const REEL_AHEAD = 6;
/** downloads at once (a card is ~0.45 MB from Bunny); the card on screen always goes first */
const PARALLEL = 3;

/** Any reel's card, as the downloader needs it: its id and, when it is already on Bunny, where. */
export type ClipCard = { id: string; clip?: { url: string; offset: number } | null };
/** The API route that cuts a card (once, onto Bunny) and says where it is. */
export type ClipRoute<C extends ClipCard> = (card: C) => string;

/** Where a card's MP4 is: on the card already, or from the API (which cuts it once and stores it on Bunny). */
async function clipLocation<C extends ClipCard>(route: ClipRoute<C>, card: C, signal: AbortSignal | undefined): Promise<{ url: string; offset: number }> {
  if (card.clip?.url) return card.clip;
  const response = await fetch(route(card), { credentials: "include", signal });
  if (!response.ok) throw new Error(`clip ${response.status}`);
  return response.json() as Promise<{ url: string; offset: number }>;
}

/** A card's file fetched before the reel opened (the first card, while the button is on screen). */
const early = new Map<string, Promise<{ blob: Blob; offset: number }>>();

async function downloadClip<C extends ClipCard>(route: ClipRoute<C>, card: C, signal?: AbortSignal): Promise<{ blob: Blob; offset: number }> {
  const ctl = signal ?? new AbortController().signal;
  const where = await clipLocation(route, card, ctl);
  // Bunny's edge (cross-origin, no cookies); in development the API itself
  const sameOrigin = where.url.startsWith("/");
  // The edge sometimes answers a first pull with 503 (seen on replayjo.com,
  // 1 Nov: three cards, all fine a moment later), so a 5xx is tried again
  // after a short pause before the card counts as failed.
  let response: Response | null = null;
  for (const pause of [0, 600, 1500]) {
    if (pause) await new Promise((r) => setTimeout(r, pause));
    if (ctl.aborted) throw new Error("aborted");
    response = await fetch(where.url, { credentials: sameOrigin ? "include" : "omit", signal: ctl });
    if (response.status < 500) break;
  }
  if (!response?.ok) throw new Error(`clip file ${response?.status}`);
  const blob = await response.blob();
  return { blob: blob.type ? blob : new Blob([blob], { type: "video/mp4" }), offset: where.offset };
}

/** Fetch the first card's file while the button is on screen, so the reel opens playing (~1-2 MB, from Bunny). */
export function prefetchFirstClip<C extends ClipCard>(route: ClipRoute<C>, card: C | undefined): void {
  if (!card || early.has(card.id)) return;
  const job = downloadClip(route, card);
  early.set(card.id, job);
  job.catch(() => early.delete(card.id));
}

/**
 * Each card's MP4, downloaded into memory ahead of time, from Bunny's CDN: the card on screen
 * first, then the next REEL_AHEAD, three at a time. A file is kept while its
 * card is within reach (one back for Back), then released. A failed download
 * is tried once more.
 */
export function useReelClips<C extends ClipCard>(route: ClipRoute<C>, cards: readonly C[] | null, index: number) {
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
          const prefetched = early.get(card.id);
          early.delete(card.id);
          const { blob, offset } = prefetched ? await prefetched.catch(() => downloadClip(route, card, ctl.signal)) : await downloadClip(route, card, ctl.signal);
          if (ctl.signal.aborted) return;
          const url = URL.createObjectURL(blob);
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
    // the route is a function of the match only; cards and index drive the downloads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, index, nonce]);

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

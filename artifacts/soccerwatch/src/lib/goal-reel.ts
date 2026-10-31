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

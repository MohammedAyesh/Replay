import { useQuery } from "@tanstack/react-query";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiBase = `${basePath}/api`;

/** [video seconds, centre x, centre y, width, height], fractions of the frame */
export type FocusPoint = [number, number, number, number, number];

export type DeckCard = {
  id: string;
  kind: "you" | "goal";
  at: number;
  start: number;
  end: number;
  clock: string;
  focus: FocusPoint[];
  you?: {
    momentId: string;
    momentKind: "your-goal" | "your-shot" | "dribble" | "long-pass";
    metres: number | null;
    beaten: number | null;
    reasons: Array<"teammate" | "join" | "crowd" | "short">;
  };
  goal?: {
    recordingId: number;
    key: number;
    source: "goal" | "shot" | "event";
    likely: boolean;
    side: "yours" | "theirs" | null;
    ownGoal: boolean;
  };
};

export type CheckDeck = {
  recordingId: number;
  videoUrl: string | null;
  srcW: number;
  srcH: number;
  videoStartSeconds: number;
  completed: boolean;
  cards: DeckCard[];
};

export type DeckVerdict = "yes" | "no" | "skip";

export const checkDeckKey = (recordingId: number) => ["check-deck", recordingId] as const;

export function useCheckDeck(recordingId: number, enabled = true) {
  return useQuery({
    queryKey: checkDeckKey(recordingId),
    queryFn: async (): Promise<CheckDeck> => {
      const response = await fetch(`${apiBase}/recordings/${recordingId}/claim-match/check-deck`, { credentials: "include" });
      if (!response.ok) throw new Error(`check deck ${response.status}`);
      return response.json() as Promise<CheckDeck>;
    },
    enabled: enabled && Number.isSafeInteger(recordingId) && recordingId > 0,
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * Answers go one at a time, in the order given: a "not me" rewrites the
 * claim, and two rewrites racing each other would each start from the claim
 * before the other. A failed answer is tried once more, then reported.
 */
export function createAnswerQueue(recordingId: number, onFailed: (cardId: string) => void) {
  let tail: Promise<unknown> = Promise.resolve();
  const send = async (cardId: string, verdict: DeckVerdict) => {
    const response = await fetch(`${apiBase}/recordings/${recordingId}/claim-match/check-deck/answer`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId, verdict }),
    });
    if (!response.ok && response.status !== 404) throw new Error(`answer ${response.status}`);
  };
  return {
    push(cardId: string, verdict: DeckVerdict) {
      tail = tail.then(async () => {
        try { await send(cardId, verdict); } catch {
          try { await new Promise((r) => setTimeout(r, 800)); await send(cardId, verdict); } catch { onFailed(cardId); }
        }
      });
      return tail;
    },
    drain() { return tail; },
  };
}

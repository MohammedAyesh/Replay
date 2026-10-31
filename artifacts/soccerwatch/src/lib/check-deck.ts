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
 * What the server did with one answer. `clip` is true only when a clip of
 * that moment is made (a "yes" on a claim that counts); `completed` is
 * whether his claim counts after it, when the server said. A 404 is a card
 * that is no longer waiting for an answer (answered elsewhere, or the claim
 * changed under it): nothing was saved, and it is no clip.
 */
export type AnswerOutcome = {
  status: "saved" | "stale" | "failed";
  clip: boolean;
  completed: boolean | null;
};

const STALE: AnswerOutcome = { status: "stale", clip: false, completed: null };
const FAILED: AnswerOutcome = { status: "failed", clip: false, completed: null };

/**
 * Answers go one at a time, in the order given: a "not me" rewrites the
 * claim, and two rewrites racing each other would each start from the claim
 * before the other. A failed answer is tried once more, then reported. Each
 * push resolves with what the server did with it.
 */
export function createAnswerQueue(recordingId: number, onFailed: (cardId: string) => void) {
  let tail: Promise<unknown> = Promise.resolve();
  const send = async (cardId: string, verdict: DeckVerdict): Promise<AnswerOutcome> => {
    const response = await fetch(`${apiBase}/recordings/${recordingId}/claim-match/check-deck/answer`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId, verdict }),
    });
    if (response.status === 404) return STALE;
    if (!response.ok) throw new Error(`answer ${response.status}`);
    const body = await response.json().catch(() => ({})) as { clip?: unknown; completed?: unknown };
    return { status: "saved", clip: body.clip === true, completed: typeof body.completed === "boolean" ? body.completed : null };
  };
  return {
    push(cardId: string, verdict: DeckVerdict): Promise<AnswerOutcome> {
      const done = tail.then(async () => {
        try { return await send(cardId, verdict); } catch {
          try { await new Promise((r) => setTimeout(r, 800)); return await send(cardId, verdict); } catch { onFailed(cardId); return FAILED; }
        }
      });
      tail = done;
      return done;
    },
    drain() { return tail; },
  };
}

export type ToastKind = "clip" | "kept" | "stale" | "notYou" | "goal" | "noGoal";

/**
 * Which toast an answer gets. "+1 clip" only for a clip that is made: on a
 * claim that does not count yet a kept moment makes no clip (it becomes one
 * once the claim counts), so that says "kept" at once; on a claim that counts
 * it waits for the server ("wait") and says what the server did. A failed
 * answer gets no toast: the done screen reports it.
 */
export function toastKind(card: DeckCard, verdict: DeckVerdict, deckCompleted: boolean, outcome?: AnswerOutcome): ToastKind | "wait" | null {
  if (verdict === "skip") return null;
  if (card.kind === "goal") return verdict === "yes" ? "goal" : "noGoal";
  if (verdict === "no") return "notYou";
  if (!outcome) return deckCompleted ? "wait" : "kept";
  if (outcome.status === "failed") return null;
  if (outcome.status === "stale") return "stale";
  return outcome.clip ? "clip" : "kept";
}

export type DeckResult = { card: DeckCard; verdict: DeckVerdict; outcome?: AnswerOutcome };

/**
 * The done screen's numbers. `clips` counts only the clips the server said it
 * made; `kept` every "that's me" it saved, clip or not.
 */
export function deckTally(results: readonly DeckResult[]) {
  const yesYou = results.filter((r) => r.card.kind === "you" && r.verdict === "yes");
  return {
    clips: yesYou.filter((r) => r.outcome?.status === "saved" && r.outcome.clip).length,
    kept: yesYou.filter((r) => r.outcome?.status === "saved").length,
    sentBack: results.filter((r) => r.card.kind === "you" && r.verdict === "no").length,
    goals: results.filter((r) => r.card.kind === "goal" && r.verdict === "yes").length,
    answered: results.filter((r) => r.verdict !== "skip").length,
  };
}

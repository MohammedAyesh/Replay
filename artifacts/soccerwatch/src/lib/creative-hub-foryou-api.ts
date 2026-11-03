import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "@/lib/academy-studio-api";
import { creativeKeys, creativePath, type CreativeProject } from "@/lib/creative-hub-api";

/**
 * Creative hub → For you. Client for routes/academyCreativeForYou.ts (owner only):
 * drafts Replay prepared after the academy's matches and before its fixtures.
 */

export type ForYouKind = "fulltime" | "cleansheet" | "potm" | "goal" | "matchday" | "countdown" | "callup" | "matchstats" | "weekly"
  | "improved" | "firstgoal" | "meet" | "streak" | "weekmoment";
export type ForYouGroup = "after" | "upcoming" | "week";

export type ForYouDraft = CreativeProject & {
  originKey: string;
  group: ForYouGroup;
  /** What the draft is about, for the "why it's suggested" line. */
  reason: {
    kind: ForYouKind;
    startsAt: string | null;
    opponent: string | null;
    ownScore: number | null;
    opponentScore: number | null;
    squad: string | null;
  };
};

export type ForYouFixture = {
  sessionId: number;
  startsAt: string;
  dateLabel: { en: string; ar: string };
  time: string;
  opponent: string | null;
  squad: string | null;
  place: string | null;
  /** The matchday draft already made for it, if any. */
  draftId: number | null;
};

export type ForYouFeed = { drafts: ForYouDraft[]; upcoming: ForYouFixture[] };

export const forYouKey = (academyId: number) => [...creativeKeys.all(academyId), "for-you"] as const;

export function useForYou(academyId: number) {
  return useQuery({
    queryKey: forYouKey(academyId),
    staleTime: 30_000,
    queryFn: () => call<ForYouFeed>(creativePath(academyId, "/for-you")),
  });
}

/** Not interested: the draft leaves the feed and is never made again. */
export function useSkipForYouDraft(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call<{ project: CreativeProject }>(creativePath(academyId, `/for-you/${id}/skip`), { method: "POST" }).then((r) => r.project),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: forYouKey(academyId) });
      const before = qc.getQueryData<ForYouFeed>(forYouKey(academyId));
      if (before) qc.setQueryData<ForYouFeed>(forYouKey(academyId), { ...before, drafts: before.drafts.filter((d) => d.id !== id) });
      return { before };
    },
    onError: (_error, _id, ctx) => {
      if (ctx?.before) qc.setQueryData(forYouKey(academyId), ctx.before);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["creative", academyId, "projects"] });
    },
  });
}

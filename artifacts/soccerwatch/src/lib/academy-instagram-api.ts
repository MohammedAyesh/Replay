import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "@/lib/academy-studio-api";

/** Academy console → Social → Instagram autopilot: routes/academyInstagram.ts (owner only). */

const path = (academyId: number, rest = "") => `/academy/console/academies/${academyId}/instagram${rest}`;
export type AcademyIgPlacement = "feed" | "reel" | "story";
export type AcademyIgTimes = Record<AcademyIgPlacement, string[]>;
export type AcademyIgSettings = { enabled: boolean; publishMode: "approve" | "auto"; times: AcademyIgTimes };
export type AcademyIgProject = {
  id: number; title: string; kind: "image" | "video"; format: string; templateKey: string | null; origin: "auto" | "manual";
  renderStatus: string; outputUrl: string | null; createdAt: string;
  /** Who it's about: the player (name when shown, else his number) and the opponent. */
  about?: string | null;
};
export type AcademyIgItem = {
  id: number; projectId: number; placement: AcademyIgPlacement;
  status: "planned" | "approved" | "publishing" | "published" | "skipped" | "failed";
  pinned: boolean; slotAt: string | null; slotLocal: string | null; error: string | null; igPermalink: string | null; publishedAt: string | null;
  project: AcademyIgProject | null;
};
export type AcademyIgSuggestion = AcademyIgProject & { placement: AcademyIgPlacement };
export type AcademyIgData = { settings: AcademyIgSettings; instagram: { connected: boolean; username: string | null }; items: AcademyIgItem[]; suggestions: AcademyIgSuggestion[] };
export type AcademyIgToday = { enabled: boolean; publishMode: "approve" | "auto"; connected: boolean; items: AcademyIgItem[]; suggestions: AcademyIgSuggestion[] };
export type AcademyIgAction = "approve" | "unapprove" | "skip" | "restore" | "now";

const key = (academyId: number) => ["academy-instagram", academyId] as const;

export function useAcademyInstagram(academyId: number) {
  return useQuery({ queryKey: [...key(academyId), "all"], queryFn: () => call<AcademyIgData>(path(academyId)), refetchInterval: 30_000 });
}
export function useAcademyInstagramToday(academyId: number, enabled = true) {
  return useQuery({ queryKey: [...key(academyId), "today"], queryFn: () => call<AcademyIgToday>(path(academyId, "/today")), enabled, refetchInterval: 60_000 });
}
export function useAcademyInstagramActions(academyId: number) {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: key(academyId) });
  const json = (body: unknown) => ({ body: JSON.stringify(body) });
  return {
    settings: useMutation({ mutationFn: (body: Partial<AcademyIgSettings>) => call(path(academyId, "/settings"), { method: "PUT", ...json(body) }), onSuccess }),
    add: useMutation({ mutationFn: (projectId: number) => call(path(academyId, "/suggestions"), { method: "POST", ...json({ projectId }) }), onSuccess }),
    action: useMutation({ mutationFn: ({ id, action }: { id: number; action: AcademyIgAction }) => call(path(academyId, `/items/${id}/action`), { method: "POST", ...json({ action }) }), onSuccess }),
    move: useMutation({ mutationFn: ({ id, slotLocal }: { id: number; slotLocal: string }) => call(path(academyId, `/items/${id}/slot`), { method: "PUT", ...json({ slotLocal }) }), onSuccess }),
  };
}

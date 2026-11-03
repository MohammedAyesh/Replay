import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "@/lib/academy-studio-api";

/**
 * "Every child appears": client for routes/academyFeatured.ts — the squad
 * grid, the owner's targets, public-post consent and each child's private clip.
 */

export type GridStatus = "green" | "amber" | "red";
export type GridCell = {
  playerId: number;
  number: number | null;
  name: string;
  squadName: string | null;
  mode: "public" | "private_only";
  status: GridStatus;
  lastFeaturedAt: string | null;
  daysSince: number | null;
  month: { publicSolo: number; publicAll: number; private: number; analysedMatches: number; clipsReceived: number };
  missing: Array<"public_post" | "private_clip" | "any">;
};
export type FeatureTargets = { publicPostsPerMonth: number; privateClipPerMatch: boolean };
export type FootageGap = { playerId: number; number: number | null; name: string; matches: number; latestSessionId: number };
export type SquadGrid = {
  month: string;
  targets: FeatureTargets;
  cells: GridCell[];
  summary: { featured: number; total: number; notYet: Array<{ playerId: number; number: number | null; name: string }> };
  gaps: FootageGap[];
  squads: Array<{ id: number; name: string }>;
  canEdit: boolean;
};

const root = (academyId: number) => `/academy/console/academies/${academyId}`;
const keys = {
  grid: (academyId: number, month: string | null, squadId: number | null) => ["academy", academyId, "featured", month ?? "now", squadId ?? "all"] as const,
  all: (academyId: number) => ["academy", academyId, "featured"] as const,
  consent: (academyId: number) => ["academy", academyId, "public-consent"] as const,
  clips: (academyId: number, sessionId: number) => ["academy", academyId, "private-clips", sessionId] as const,
};

export function useSquadGrid(academyId: number, month: string | null, squadId: number | null) {
  const q = new URLSearchParams();
  if (month) q.set("month", month);
  if (squadId) q.set("squadId", String(squadId));
  const qs = q.toString();
  return useQuery({
    queryKey: keys.grid(academyId, month, squadId),
    staleTime: 30_000,
    queryFn: () => call<SquadGrid>(`${root(academyId)}/featured${qs ? `?${qs}` : ""}`),
  });
}

export function useSaveTargets(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<FeatureTargets>) =>
      call<{ targets: FeatureTargets }>(`${root(academyId)}/featured/targets`, { method: "PUT", body: JSON.stringify(patch) }).then((r) => r.targets),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all(academyId) }),
  });
}

export type ConsentRow = { playerId: number; consent: boolean; consentAt: string | null };

export function usePublicConsent(academyId: number) {
  return useQuery({
    queryKey: keys.consent(academyId),
    staleTime: 30_000,
    queryFn: () => call<{ players: ConsentRow[] }>(`${root(academyId)}/players/public-consent`).then((r) => new Map(r.players.map((p) => [p.playerId, p]))),
  });
}

export function useSetConsent(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { playerId: number; consent: boolean }) =>
      call<{ playerId: number; consent: boolean }>(`${root(academyId)}/players/${v.playerId}/public-consent`, { method: "PUT", body: JSON.stringify({ consent: v.consent }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.consent(academyId) });
      void qc.invalidateQueries({ queryKey: keys.all(academyId) });
    },
  });
}

export type BaselineNote =
  | { kind: "above"; stat: string; value: number; usual: number; matches: number }
  | { kind: "best"; stat: string; value: number; matches: number }
  | { kind: "first" };

export type PrivateClip = {
  id: number;
  playerId: number;
  playerName: string;
  number: number | null;
  status: "prepared" | "sent" | "no_moment" | "failed";
  momentKind: string | null;
  momentSeconds: number | null;
  note: BaselineNote | null;
  exportStatus: string | null;
  url: string;
  sentAt: string | null;
  openedAt: string | null;
};

export function usePrivateClips(academyId: number, sessionId: number) {
  return useQuery({
    queryKey: keys.clips(academyId, sessionId),
    staleTime: 15_000,
    queryFn: () => call<{ clips: PrivateClip[] }>(`${root(academyId)}/matches/${sessionId}/private-clips`).then((r) => r.clips),
  });
}

export type PrepareResult = { prepared: number; already: number; noFootage: number[]; reason?: "not_analysed" | "no_recording" | "not_a_match"; clips: PrivateClip[] };
export type SendResult = { messages: number; children: number; unreachable: Array<{ playerId: number; name: string; number: number | null }>; reason?: string; clips: PrivateClip[] };

export function usePrepareClips(academyId: number, sessionId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<PrepareResult>(`${root(academyId)}/matches/${sessionId}/private-clips/prepare`, { method: "POST" }),
    onSuccess: (r) => qc.setQueryData(keys.clips(academyId, sessionId), r.clips),
  });
}

export function useSendClips(academyId: number, sessionId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (playerIds?: number[]) => call<SendResult>(`${root(academyId)}/matches/${sessionId}/private-clips/send`, { method: "POST", body: JSON.stringify(playerIds ? { playerIds } : {}) }),
    onSuccess: (r) => {
      qc.setQueryData(keys.clips(academyId, sessionId), r.clips);
      void qc.invalidateQueries({ queryKey: keys.all(academyId) });
    },
  });
}

/** A family's clip page (no account). */
export type KidClip = {
  firstName: string;
  academy: { name: string; nameAr: string | null } | null;
  match: { startsAt: string; opponent: string | null } | null;
  momentKind: string | null;
  note: BaselineNote | null;
  ready: boolean;
};

export function useKidClip(token: string) {
  return useQuery({
    queryKey: ["kid-clip", token],
    queryFn: () => call<KidClip>(`/kc/${token}`),
    retry: false,
    refetchInterval: (q) => (q.state.data && !q.state.data.ready ? 20_000 : false),
  });
}

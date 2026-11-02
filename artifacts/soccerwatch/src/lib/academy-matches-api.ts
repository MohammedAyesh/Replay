import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Academy match pages, lineups and per-player stats. Hand-written client for routes/academyMatches.ts. */

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (response.status === 204) return undefined as T;
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : `Request failed (${response.status})`) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = (data as { code?: string } | null)?.code;
    throw error;
  }
  return data as T;
}

export type AcademyPlayerStats = {
  playerId: number;
  rosterPlayerId: string;
  minutes: number | null;
  distanceKm: number | null;
  topSpeedKmh: number | null;
  touches: number | null;
  passesTried: number | null;
  passesCompleted: number | null;
  passesReceived: number | null;
  dribbles: number | null;
  dribblesWon: number | null;
  dribblesLost: number | null;
  shots: number | null;
  goals: number | null;
};

export type AcademyTeamStats = {
  touches: [number, number];
  passesTried: [number, number];
  passesCompleted: [number, number];
  possessionPercent: [number, number];
  completionPercent: number;
  dribbles: [number, number];
  dribblesWon: [number, number];
  shots: [number, number];
  goals: [number, number];
};

export type MatchSession = {
  id: number;
  type: "training" | "match";
  squadId?: number | null;
  squadName: string | null;
  startsAt: string;
  endsAt?: string | null;
  location: string;
  opponent: string | null;
  ownScore: number | null;
  opponentScore: number | null;
};

export type MatchListItem = MatchSession & {
  hasVideo: boolean;
  analysis: "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | null;
  playersWithStats: number;
  published: boolean;
};

export type LineupPlayer = {
  playerId: number;
  name: string;
  squadName: string | null;
  isActive: boolean;
  shirtNumber: number | null;
  inSquad: boolean;
  rosterPlayerId: string | null;
  boundBy: "owner" | null;
  saved: boolean;
  boundTo: string | null;
  boundHow: "owner" | "number" | null;
};

export type DetectedPlayer = { id: string; number: string | null; numberCandidate: string | null; minutes: number; photos: string[] };

export type MatchDetail = {
  session: MatchSession;
  role: "owner" | "coach";
  page: {
    published: boolean;
    recordingId: number | null;
    kitColor: string | null;
    opponentKitColor: string | null;
    playersPerSide: number | null;
    shirtsHaveNumbers: "yes" | "no" | "unknown";
  };
  recordings: Array<{ id: number; date: string; timeSlot: string; duration: string; videoUrl: string | null; court: string }>;
  analysis: {
    hasVideo: boolean;
    analysed: boolean;
    hasRoster: boolean;
    detectedPlayers: number;
    job: { id: number; status: string; stage: string | null; progress: number | null; error: string | null; createdAt: string } | null;
  };
  lineup: LineupPlayer[];
  detected: DetectedPlayer[];
  stats: { team: AcademyTeamStats | null; players: AcademyPlayerStats[]; hasBall: boolean; computedAt: string | null } | null;
};

export type PlayerStatsRow = {
  playerId: number;
  playerName: string;
  squadName: string | null;
  jerseyNumber: number | null;
  sessionId: number;
  startsAt: string;
  type: string;
  opponent: string | null;
  ownScore: number | null;
  opponentScore: number | null;
  published: boolean;
  stats: AcademyPlayerStats;
};

export type FamilyMatchListItem = MatchSession & { academyId: number; academyName: string };

export type FamilyMatch = {
  academy: { name: string; logoUrl: string | null };
  session: MatchSession;
  recording: { id: number; date: string; timeSlot: string; videoUrl: string | null; court: string } | null;
  analysed: boolean;
  team: AcademyTeamStats | null;
  hasBall: boolean;
  players: Array<{ playerId: number; name: string; shirtNumber: number | null; mine: boolean; stats: AcademyPlayerStats | null }>;
};

export type FamilyPlayerHistory = {
  player: { id: number; name: string };
  matches: Array<{ sessionId: number; startsAt: string; opponent: string | null; ownScore: number | null; opponentScore: number | null; stats: AcademyPlayerStats; squad: AcademyPlayerStats[] }>;
};

const consolePath = (academyId: number) => `/academy/console/academies/${academyId}`;
const keys = {
  list: (academyId: number) => ["academy-matches", academyId],
  detail: (academyId: number, sessionId: number) => ["academy-matches", academyId, sessionId],
  playerStats: (academyId: number) => ["academy-matches", academyId, "player-stats"],
};

export function useAcademyMatches(academyId: number) {
  return useQuery({ queryKey: keys.list(academyId), queryFn: () => call<MatchListItem[]>(`${consolePath(academyId)}/matches`), staleTime: 15_000 });
}

export function useAcademyMatch(academyId: number, sessionId: number | null) {
  return useQuery({
    queryKey: keys.detail(academyId, sessionId ?? 0),
    queryFn: () => call<MatchDetail>(`${consolePath(academyId)}/matches/${sessionId}`),
    enabled: sessionId !== null,
    // While an analysis is running, keep checking.
    refetchInterval: (query) => {
      const status = (query.state.data as MatchDetail | undefined)?.analysis.job?.status;
      return status && ["queued", "claimed", "running"].includes(status) ? 30_000 : false;
    },
  });
}

export function useAcademyPlayerStats(academyId: number, enabled = true) {
  return useQuery({ queryKey: keys.playerStats(academyId), queryFn: () => call<PlayerStatsRow[]>(`${consolePath(academyId)}/player-stats`), enabled });
}

function useInvalidate(academyId: number) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["academy-matches", academyId] });
}

export function useSaveMatchPage(academyId: number, sessionId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (body: Partial<MatchDetail["page"]>) => call(`${consolePath(academyId)}/matches/${sessionId}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useSaveLineup(academyId: number, sessionId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (body: { players: Array<{ playerId: number; shirtNumber: number | null; inSquad: boolean }>; rememberNumbers?: boolean }) =>
      call(`${consolePath(academyId)}/matches/${sessionId}/lineup`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useBindPlayer(academyId: number, sessionId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ playerId, rosterPlayerId }: { playerId: number; rosterPlayerId: string | null | "auto" }) =>
      call(`${consolePath(academyId)}/matches/${sessionId}/players/${playerId}/binding`, { method: "PUT", body: JSON.stringify({ rosterPlayerId }) }),
    onSuccess: invalidate,
  });
}

export function useAnalyseMatch(academyId: number, sessionId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (again: boolean) => call<{ jobId: number }>(`${consolePath(academyId)}/matches/${sessionId}/analyse`, { method: "POST", body: JSON.stringify({ again }) }),
    onSuccess: invalidate,
  });
}

export function useRefreshMatchStats(academyId: number, sessionId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: () => call(`${consolePath(academyId)}/matches/${sessionId}/stats/refresh`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useFamilyMatches(enabled = true) {
  return useQuery({ queryKey: ["family-matches"], queryFn: () => call<FamilyMatchListItem[]>("/academy/family/matches"), enabled, retry: false });
}

export function useFamilyMatch(sessionId: number | null) {
  return useQuery({
    queryKey: ["family-match", sessionId],
    queryFn: () => call<FamilyMatch>(`/academy/family/matches/${sessionId}`),
    enabled: sessionId !== null,
    retry: false,
  });
}

export function useFamilyPlayerHistory(playerId: number | null) {
  return useQuery({
    queryKey: ["family-player-history", playerId],
    queryFn: () => call<FamilyPlayerHistory>(`/academy/family/players/${playerId}/match-stats`),
    enabled: playerId !== null,
    retry: false,
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Match rooms: /m/:code. Hand-written client for the matchRooms router. */

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
export const apiBase = `${basePath}/api`;

export class MatchApiError extends Error {
  status: number;
  data: Record<string, unknown> | null;
  constructor(status: number, data: Record<string, unknown> | null) {
    super(typeof data?.error === "string" ? data.error : `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (response.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new MatchApiError(response.status, (data as Record<string, unknown>) ?? null);
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body ?? {});

export type MatchPhase = "pre" | "live" | "processing" | "ready" | "expired" | "failed" | "cancelled";
export type Rsvp = "invited" | "in" | "maybe" | "out";
export type TeamSide = "A" | "B" | "C";

export type MatchPlayer = {
  id: number;
  name: string;
  initials: string;
  avatarUrl: string | null;
  userId: number | null;
  signedUp: boolean;
  rsvp: Rsvp;
  team: TeamSide | null;
  shirtNumber: number | null;
  slotX: number | null;
  slotY: number | null;
  invitedBy: { id: number; name: string } | null;
  isMe: boolean;
};

export type MatchMark = {
  id: number;
  kind: string;
  note: string | null;
  atUtc: string;
  offsetSeconds: number | null;
  byName: string | null;
  mine: boolean;
};

export type TeamInfo = { name: string | null; color: string };
export type StandingRow = {
  team: TeamSide; played: number; won: number; drawn: number; lost: number;
  goalsFor: number; goalsAgainst: number; points: number;
};
export type MatchGame = {
  id: number; idx: number; startOffsetSec: number; endOffsetSec: number;
  /** The two teams that played; scoreA belongs to teamX, scoreB to teamY. */
  teamX: TeamSide; teamY: TeamSide;
  scoreA: number | null; scoreB: number | null;
};

export type MatchRoom = {
  code: string;
  url: string;
  serverNow: string;
  phase: MatchPhase;
  status: string;
  progress: number;
  startLocal: string;
  endLocal: string;
  startsAt: string | null;
  endsAt: string | null;
  varOpensAt: string | null;
  varClosesAt: string | null;
  voteClosesAt: string | null;
  startMs: number;
  endMs: number;
  field: { id: number; name: string; location: string | null; imageUrl: string | null };
  title: string | null;
  playersPerSide: number;
  teamCount: 2 | 3;
  teams: { A: TeamInfo; B: TeamInfo; C?: TeamInfo };
  score: { a: number; b: number } | null;
  /** Three-team matches only: the table, best first. */
  standings: StandingRow[] | null;
  leader: TeamSide | null;
  captain: { userId: number; name: string; avatarUrl: string | null } | null;
  isCaptain: boolean;
  isOwner: boolean;
  canManage: boolean;
  isMember: boolean;
  signedIn: boolean;
  players: MatchPlayer[];
  counts: { in: number; maybe: number; invited: number; out: number; needed: number };
  me: MatchPlayer | null;
  invitedBy: { playerId: number | null; name: string; avatarUrl: string | null } | null;
  personalInvite: { playerId: number; name: string } | null;
  myInviteUrl: string | null;
  captainUrl: string | null;
  var: { active: boolean; requestId: number | null; state: string | null };
  marks: MatchMark[];
  footage: { ready: boolean; readyAt: string | null; shareUrl: string | null; shareToken: string | null; expiresAt: string | null };
  games: MatchGame[];
  vote: {
    open: boolean;
    closed: boolean;
    closesAt: string | null;
    myVote: number | null;
    votesCast: number;
    eligibleVoters: number;
    tallies: Array<{ playerId: number; count: number }>;
    winners: number[];
  };
  stats: {
    unlocked: boolean;
    pending: { reference: string; kind: string; amountFils: number } | null;
    /** Admin → Settings → Match stats. */
    enabled: boolean;
    paywall: boolean;
    teamPack: boolean;
    monthly: boolean;
    prices: { matchFils: number; monthlyFils: number; teamFils: number };
    cliqAlias: string;
  };
  clips: { mine: number; match: number };
  prices: { bookingFils: number };
  booking: {
    status: "pending" | "paid" | "rejected";
    amountFils: number;
    reference: string | null;
    mine: boolean;
    requestId: number | null;
    cliqAlias: string;
  } | null;
};

export type MyMatchItem = {
  code: string;
  url: string;
  phase: MatchPhase;
  startLocal: string;
  endLocal: string;
  startsAt: string | null;
  endsAt?: string | null;
  startMs: number;
  field: { id: number; name: string; location: string | null; imageUrl: string | null };
  title: string | null;
  myRsvp?: Rsvp | null;
  myTeam?: TeamSide | null;
  isCaptain?: boolean;
  isOwner?: boolean;
  countIn?: number;
  needed?: number;
  score?: { a: number; b: number } | null;
  voteOpen?: boolean;
  inviteToken?: string;
};

export type MyMatches = { live: MyMatchItem[]; upcoming: MyMatchItem[]; recent: MyMatchItem[]; invites: MyMatchItem[] };

export type MatchClip = {
  id: number;
  title: string | null;
  startTime: number;
  endTime: number;
  duration: number;
  aspectRatio: string | null;
  visibility: string;
  createdAt: string;
  exportStatus: string | null;
  likeCount: number;
  mine: boolean;
  by: { userId: number; name: string; avatarUrl: string | null };
  matchStartMs: number;
};

export type ReplayProfile = {
  id: number;
  name: string;
  position: string | null;
  shirtNumber: number | null;
  avatarUrl: string | null;
  matchesPlayed: number;
  wins: number;
  motmCount: number;
  publicClips: number;
  recent: Array<{
    code: string; url: string; startLocal: string; field: { id: number; name: string };
    score: { a: number; b: number } | null; team: TeamSide | null; won: boolean; motm: boolean;
  }>;
};

export type StatUnlockResult = { reference: string; status: string; amountFils: number; cliqAlias: string };

export const matchKey = (code: string) => ["match-room", code.toUpperCase()] as const;
export const myMatchesKey = ["my-matches"] as const;

function roomQuery(search: string) {
  const params = new URLSearchParams(search);
  const keep = new URLSearchParams();
  for (const key of ["by", "i"]) {
    const value = params.get(key);
    if (value) keep.set(key, value);
  }
  const s = keep.toString();
  return s ? `?${s}` : "";
}

export function useMatchRoom(code: string, search = "") {
  return useQuery({
    queryKey: [...matchKey(code), roomQuery(search)],
    queryFn: () => call<MatchRoom>(`/m/${encodeURIComponent(code)}${roomQuery(search)}`),
    enabled: Boolean(code),
    retry: (count, error) => !(error instanceof MatchApiError && error.status === 404) && count < 2,
    // Live and pre-game pages tick; the server decides the phase.
    refetchInterval: (query) => {
      const phase = (query.state.data as MatchRoom | undefined)?.phase;
      if (phase === "live") return 15_000;
      if (phase === "pre" || phase === "processing") return 45_000;
      return false;
    },
    staleTime: 10_000,
  });
}

export function useMyMatches(enabled = true) {
  return useQuery({
    queryKey: myMatchesKey,
    queryFn: () => call<MyMatches>("/me/matches"),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useMatchClips(code: string, enabled = true) {
  return useQuery({
    queryKey: [...matchKey(code), "clips"],
    queryFn: () => call<MatchClip[]>(`/m/${encodeURIComponent(code)}/clips`),
    enabled: Boolean(code) && enabled,
    staleTime: 30_000,
  });
}

export function useReplayProfile(userId: number | null | undefined) {
  return useQuery({
    queryKey: ["replay-profile", userId],
    queryFn: () => call<ReplayProfile>(`/users/${userId}/replay-profile`),
    enabled: Boolean(userId),
    staleTime: 60_000,
  });
}

/** Mutations that return a fresh room refresh the cached room in place. */
function useRoomMutation<V, R>(code: string, fn: (vars: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      if (data && typeof data === "object" && "code" in (data as object) && "players" in (data as object)) {
        qc.setQueriesData({ queryKey: matchKey(code) }, (old: unknown) => (
          old && typeof old === "object" && "players" in (old as object) ? data : old
        ));
      }
      void qc.invalidateQueries({ queryKey: matchKey(code) });
      void qc.invalidateQueries({ queryKey: myMatchesKey });
    },
  });
}

export type JoinInput = {
  rsvp: "in" | "maybe" | "out";
  displayName?: string;
  shirtNumber?: number | null;
  by?: number | null;
  inviteToken?: string | null;
  captainToken?: string | null;
};

export const useJoinMatch = (code: string) =>
  useRoomMutation(code, (body: JoinInput) => call<MatchRoom>(`/m/${code}/join`, { method: "POST", body: json(body) }));

export const useInvitePlayer = (code: string) =>
  useRoomMutation(code, (body: { displayName: string; phone?: string | null; email?: string | null; shirtNumber?: number | null }) =>
    call<{ id: number; inviteUrl: string }>(`/m/${code}/players`, { method: "POST", body: json(body) }));

export const useUpdatePlayer = (code: string) =>
  useRoomMutation(code, ({ playerId, ...body }: { playerId: number; team?: TeamSide | null; shirtNumber?: number | null; slotX?: number | null; slotY?: number | null; displayName?: string; rsvp?: Rsvp }) =>
    call<{ id: number }>(`/m/${code}/players/${playerId}`, { method: "PATCH", body: json(body) }));

export const useRemovePlayer = (code: string) =>
  useRoomMutation(code, (playerId: number) => call<void>(`/m/${code}/players/${playerId}`, { method: "DELETE" }));

export const useAutoTeams = (code: string) =>
  useRoomMutation(code, (shuffle: boolean) => call<MatchRoom>(`/m/${code}/teams/auto`, { method: "POST", body: json({ shuffle }) }));

export const useUpdateRoom = (code: string) =>
  useRoomMutation(code, (body: {
    title?: string | null; teamAName?: string | null; teamBName?: string | null; teamCName?: string | null;
    teamAColor?: string; teamBColor?: string; teamCColor?: string; teamCount?: 2 | 3; playersPerSide?: number;
  }) =>
    call<MatchRoom>(`/m/${code}`, { method: "PATCH", body: json(body) }));

export const useSetScore = (code: string) =>
  useRoomMutation(code, (body: { scoreA: number; scoreB: number }) => call<MatchRoom>(`/m/${code}/score`, { method: "POST", body: json(body) }));

export const useSetGames = (code: string) =>
  useRoomMutation(code, (games: Array<{ startOffsetSec: number; endOffsetSec: number; teamX?: TeamSide; teamY?: TeamSide; scoreA?: number | null; scoreB?: number | null }>) =>
    call<MatchRoom>(`/m/${code}/games`, { method: "PUT", body: json({ games }) }));

export const useMakeCaptain = (code: string) =>
  useRoomMutation(code, (playerId: number) => call<MatchRoom>(`/m/${code}/captain`, { method: "POST", body: json({ playerId }) }));

export const useFlagMoment = (code: string) =>
  useRoomMutation(code, (body: { kind: "goal" | "foul" | "offside" | "other"; note?: string | null; atUtc?: string }) =>
    call<{ id: number; kind: string; atUtc: string; offsetSeconds: number }>(`/m/${code}/flags`, { method: "POST", body: json(body) }));

export const useVote = (code: string) =>
  useRoomMutation(code, (candidatePlayerId: number) => call<MatchRoom>(`/m/${code}/vote`, { method: "POST", body: json({ candidatePlayerId }) }));

export const useUnlockStats = (code: string) =>
  useRoomMutation(code, (kind: "match" | "team") => call<StatUnlockResult>(`/m/${code}/stats/unlock`, { method: "POST", body: json({ kind }) }));

export function useStatsPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<StatUnlockResult>("/me/stats-plan", { method: "POST", body: "{}" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["match-room"] }),
  });
}

export function useAvatarUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("photo", file);
      return call<{ avatarUrl: string }>("/me/avatar", { method: "POST", body: form });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["replay-profile"] });
      void qc.invalidateQueries({ queryKey: ["match-room"] });
    },
  });
}

export function useAvatarRemove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<void>("/me/avatar", { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["replay-profile"] });
      void qc.invalidateQueries({ queryKey: ["match-room"] });
    },
  });
}

export type AdminStatUnlock = {
  id: number;
  kind: "match" | "team" | "monthly" | "booking";
  amountFils: number;
  reference: string;
  status: "pending" | "paid" | "rejected";
  createdAt: string;
  confirmedAt: string | null;
  validUntil: string | null;
  user: { id: number; name: string | null; email: string | null; phone: string | null };
  matchCode: string | null;
};

export function useAdminStatUnlocks(enabled: boolean) {
  return useQuery({
    queryKey: ["admin-stat-unlocks"],
    queryFn: () => call<AdminStatUnlock[]>("/admin/stat-unlocks"),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useReviewStatUnlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: "confirm" | "reject" }) =>
      call<unknown>(`/admin/stat-unlocks/${id}/${action}`, { method: "POST", body: "{}" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-stat-unlocks"] }),
  });
}

// ---------------------------------------------------------------- helpers

export function formatJod(fils: number): string {
  const jod = fils / 1000;
  return Number.isInteger(jod) ? `${jod}` : jod.toFixed(jod * 10 % 1 === 0 ? 1 : 2);
}

export function whatsappLink(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function calendarUrl(code: string): string {
  return `${apiBase}/m/${code}/calendar.ics`;
}

export async function shareOrCopy(payload: { title?: string; text: string; url: string }): Promise<"shared" | "copied" | "failed"> {
  try {
    if (typeof navigator.share === "function") {
      await navigator.share(payload);
      return "shared";
    }
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return "failed";
  }
  try {
    await navigator.clipboard.writeText(`${payload.text} ${payload.url}`.trim());
    return "copied";
  } catch {
    return "failed";
  }
}


// ---------------------------------------------------------------- booking a recording

export type BookableField = { id: number; name: string; location: string | null; imageUrl: string | null };
export type BookingFields = {
  fields: BookableField[];
  pricePerHourFils: number;
  maxDaysAhead: number;
  maxMinutes: number;
  /** Admin → Settings → Bookings. Off hides the Book button on Home. */
  enabled: boolean;
  cliqAlias: string;
};
export type BookingResult = {
  code: string; requestId: number; amountFils: number; reference: string; cliqAlias: string;
  startLocal: string; endLocal: string; fieldName: string;
};

export function useBookingFields() {
  return useQuery({ queryKey: ["booking-fields"], queryFn: () => call<BookingFields>("/bookings/fields"), staleTime: 5 * 60_000 });
}

export function useTakenSlots(fieldId: number | null, date: string | null) {
  return useQuery({
    queryKey: ["booking-taken", fieldId, date],
    queryFn: () => call<{ taken: Array<{ startLocal: string; endLocal: string }>; now: string }>(`/bookings/taken?fieldId=${fieldId}&date=${date}`),
    enabled: Boolean(fieldId && date),
    refetchInterval: 60_000,
  });
}

export function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fieldId: number; startLocal: string; endLocal: string; title?: string | null }) =>
      call<BookingResult>("/bookings", { method: "POST", body: json(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["booking-taken"] });
      void qc.invalidateQueries({ queryKey: myMatchesKey });
    },
  });
}

export function useCancelBooking(code: string) {
  return useRoomMutation(code, (requestId: number) => call<void>(`/bookings/${requestId}`, { method: "DELETE" }));
}

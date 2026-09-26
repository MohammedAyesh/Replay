import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase, matchKey, myMatchesKey } from "@/lib/match-api";

export type FriendUser = {
  userId: number;
  name: string;
  avatarUrl: string | null;
  position: string | null;
  requestId?: number;
  since?: string;
};

export type FriendsData = {
  friends: FriendUser[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
};

export type FriendSuggestion = FriendUser & { matchesTogether: number };
export type PublicFriendLink = FriendUser;
export type FriendLink = { code: string; url: string };
export type FriendMutationResult = { requestId?: number; status?: "pending" | "accepted"; ok?: boolean };
export type InviteFriendsResult = {
  invited: Array<{ userId: number; name: string; playerId: number; inviteUrl: string }>;
  skipped: Array<{ userId: number; reason: "already_on_roster" | "not_friend" }>;
  shareText: string;
};

export class FriendsApiError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown> | null;

  constructor(status: number, data: Record<string, unknown> | null) {
    super(typeof data?.error === "string" ? data.error : `Request failed (${status})`);
    this.name = "FriendsApiError";
    this.status = status;
    this.data = data;
  }

  get reason(): string | undefined {
    return typeof this.data?.reason === "string" ? this.data.reason : undefined;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (response.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new FriendsApiError(response.status, (body as Record<string, unknown> | null) ?? null);
  }
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body ?? {});

function invalidateFriendViews(queryClient: ReturnType<typeof useQueryClient>, code?: string) {
  void queryClient.invalidateQueries({ queryKey: ["friends"] });
  void queryClient.invalidateQueries({ queryKey: ["friends", "suggestions"] });
  void queryClient.invalidateQueries({ queryKey: myMatchesKey });
  if (code) void queryClient.invalidateQueries({ queryKey: matchKey(code) });
}

export function useFriends(enabled = true) {
  return useQuery({
    queryKey: ["friends"],
    queryFn: () => call<FriendsData>("/friends"),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useFriendSuggestions(enabled = true) {
  return useQuery({
    queryKey: ["friends", "suggestions"],
    queryFn: () => call<FriendSuggestion[]>("/friends/suggestions"),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => call<FriendMutationResult>("/friends/requests", {
      method: "POST",
      body: json({ userId }),
    }),
    onSuccess: () => invalidateFriendViews(queryClient),
  });
}

export function useAcceptFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: number) => call<FriendMutationResult>(`/friends/requests/${requestId}/accept`, {
      method: "POST",
      body: "{}",
    }),
    onSuccess: () => invalidateFriendViews(queryClient),
  });
}

export function useDeclineFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: number) => call<{ ok: true }>(`/friends/requests/${requestId}/decline`, {
      method: "POST",
      body: "{}",
    }),
    onSuccess: () => invalidateFriendViews(queryClient),
  });
}

export function useRemoveFriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => call<{ ok: true }>(`/friends/${userId}`, { method: "DELETE" }),
    onSuccess: () => invalidateFriendViews(queryClient),
  });
}

export function useFriendLink(enabled = true) {
  return useQuery({
    queryKey: ["friends", "link"],
    queryFn: () => call<FriendLink>("/friends/link"),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useResetFriendLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call<FriendLink>("/friends/link/reset", { method: "POST", body: "{}" }),
    onSuccess: () => invalidateFriendViews(queryClient),
  });
}

export function usePublicFriendLink(code: string) {
  const normalizedCode = code.toUpperCase();
  return useQuery({
    queryKey: ["friends", "public-link", normalizedCode],
    queryFn: () => call<PublicFriendLink>(`/friends/link/${encodeURIComponent(normalizedCode)}`),
    enabled: Boolean(normalizedCode),
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof FriendsApiError && error.status === 404) && count < 2,
  });
}

export function useAcceptFriendLink(code: string) {
  const queryClient = useQueryClient();
  const normalizedCode = code.toUpperCase();
  return useMutation({
    mutationFn: () => call<FriendMutationResult>(`/friends/link/${encodeURIComponent(normalizedCode)}/accept`, {
      method: "POST",
      body: "{}",
    }),
    onSuccess: () => invalidateFriendViews(queryClient),
  });
}

export function useInviteFriends(code: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userIds: number[]) => call<InviteFriendsResult>(`/m/${encodeURIComponent(code)}/invite-friends`, {
      method: "POST",
      body: json({ userIds }),
    }),
    onSuccess: () => invalidateFriendViews(queryClient, code),
  });
}

export type FriendStatus = {
  status: "friends" | "outgoing" | "incoming" | "none";
  requestId?: number;
};

export function friendStatusFor(userId: number, data?: FriendsData | null): FriendStatus {
  if (!data) return { status: "none" };
  if (data.friends.some((friend) => friend.userId === userId)) return { status: "friends" };
  const incoming = data.incoming.find((request) => request.userId === userId);
  if (incoming) return { status: "incoming", ...(incoming.requestId ? { requestId: incoming.requestId } : {}) };
  const outgoing = data.outgoing.find((request) => request.userId === userId);
  if (outgoing) return { status: "outgoing", ...(outgoing.requestId ? { requestId: outgoing.requestId } : {}) };
  return { status: "none" };
}

/** Keep the selected IDs unique, eligible, off-roster, and within the API's 30-friend limit. */
export function normalizeFriendInviteSelection(
  selectedIds: number[],
  friends: Array<Pick<FriendUser, "userId">>,
  roster: Array<{ userId: number | null }>,
  max = 30,
): number[] {
  const eligible = new Set(friends.map((friend) => friend.userId));
  const alreadyOnRoster = new Set(roster.flatMap((player) => player.userId === null ? [] : [player.userId]));
  return Array.from(new Set(selectedIds))
    .filter((id) => eligible.has(id) && !alreadyOnRoster.has(id))
    .slice(0, Math.min(30, Math.max(0, max)));
}

export function friendErrorKey(error: unknown): string | undefined {
  if (error instanceof FriendsApiError) return error.reason;
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = (error as { data?: { reason?: unknown } }).data;
  return typeof data?.reason === "string" ? data.reason : undefined;
}
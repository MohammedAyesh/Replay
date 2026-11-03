import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Academy console → Team, and what the signed-in member may see. Client for routes/academyTeam.ts. */

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new Error(typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : `Request failed (${response.status})`);
  return data as T;
}

export type StaffRole = "owner" | "manager" | "coach";

export type MyAccess = { role: StaffRole; sections: string[]; manages: string[]; permissions: string[] };

export type TeamAccess = {
  sections: { manager: string[]; coach: string[] };
  family: { parent: string[]; player: string[] };
  permissions: { manager: string[]; coach: string[] };
};

export type Team = {
  members: Array<{ userId: number; name: string | null; email: string | null; role: StaffRole; since: string; isMe: boolean }>;
  invites: Array<{ id: number; role: "manager" | "coach"; label: string | null; url: string; expiresAt: string; createdAt: string }>;
  access: TeamAccess;
  catalog: { sections: string[]; ownerSections: string[]; familyScreens: string[]; permissions: string[] };
};

const teamKey = (academyId: number) => ["academy-team", academyId];

export function useMyAcademyAccess(academyId: number | null) {
  return useQuery({
    queryKey: ["academy-access", academyId],
    queryFn: () => call<MyAccess>(`/academy/console/academies/${academyId}/access`),
    enabled: academyId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useTeam(academyId: number) {
  return useQuery({ queryKey: teamKey(academyId), queryFn: () => call<Team>(`/academy/console/academies/${academyId}/team`), retry: false });
}

function useRefresh(academyId: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: teamKey(academyId) });
    void qc.invalidateQueries({ queryKey: ["academy-access", academyId] });
  };
}

export function useCreateInvite(academyId: number) {
  const refresh = useRefresh(academyId);
  return useMutation({
    mutationFn: (body: { role: "manager" | "coach"; label?: string }) => call<Team["invites"][number]>(`/academy/console/academies/${academyId}/team/invites`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: refresh,
  });
}

export function useRevokeInvite(academyId: number) {
  const refresh = useRefresh(academyId);
  return useMutation({ mutationFn: (id: number) => call(`/academy/console/academies/${academyId}/team/invites/${id}`, { method: "DELETE" }), onSuccess: refresh });
}

export function useMemberRole(academyId: number) {
  const refresh = useRefresh(academyId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: "manager" | "coach" | null }) =>
      role
        ? call(`/academy/console/academies/${academyId}/team/members/${userId}`, { method: "PUT", body: JSON.stringify({ role }) })
        : call(`/academy/console/academies/${academyId}/team/members/${userId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
}

export function useSaveAccess(academyId: number) {
  const refresh = useRefresh(academyId);
  return useMutation({
    mutationFn: (body: { sections?: Partial<Record<"manager" | "coach" | "parent" | "player", string[]>>; permissions?: Partial<Record<"manager" | "coach", string[]>> }) =>
      call<TeamAccess>(`/academy/console/academies/${academyId}/access`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: refresh,
  });
}

export async function peekInvite(token: string) {
  return call<{ state: "open" | "used" | "expired" | "revoked"; role: "manager" | "coach"; academyName: string; academyId: number; kind?: "academy" | "venue" }>(`/academy/invites/${encodeURIComponent(token)}`);
}

export async function acceptInvite(token: string) {
  return call<{ academyId: number; academyName: string; role: string }>(`/academy/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
}

export async function fetchFamilyScreens(playerId?: number | null) {
  return call<{ role: "parent" | "player"; screens: string[] }>(`/academy/family/screens${playerId ? `?playerId=${playerId}` : ""}`);
}

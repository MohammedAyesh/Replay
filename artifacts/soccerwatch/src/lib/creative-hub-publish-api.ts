import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase } from "@/lib/academy-studio-api";
import { creativeKeys, creativePath, type CreativeProject } from "@/lib/creative-hub-api";

/**
 * Creative hub → Publish. Client for routes/academyCreativePublish.ts (owner only).
 * Errors carry the server's `code` (already_posted, not_rendered, …) so the
 * console can answer each one in words.
 */

export class PublishError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly body: Record<string, unknown> | null) {
    super(message);
  }
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    throw new PublishError(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`, response.status, typeof body?.code === "string" ? body.code : null, body);
  }
  return (response.status === 204 ? null : await response.json().catch(() => null)) as T;
}

export type Placement = "feed" | "reel" | "story";
export type SocialTarget = "instagram" | "facebook";
export type AudienceRole = "parents" | "players" | "coaches";
export type Audience = { roles: AudienceRole[]; squadIds: number[] | null };

export type PublishChannels = {
  social: { status: "none" | "pending" | "connected" | "error"; instagram: { username: string | null } | null; facebook: { pageName: string | null } | null; error: string | null };
  whatsapp: { sender: "own" | "replay" | "off"; available: boolean; phone: string | null; roles: AudienceRole[]; squads: Array<{ id: number; name: string; players: number }>; players: number };
  ads: { available: boolean; mode: "own" | "replay"; walletFils: number };
  hashtag: string | null;
};

export type TargetState = "scheduled" | "publishing" | "published" | "failed" | "removed" | "sent" | "added" | "downloaded";

export type PublishTargetView = {
  channel: "instagram" | "facebook" | "whatsapp" | "ad" | "download";
  ref?: string;
  at: string;
  renderedAt?: string | null;
  mediaId?: number;
  postId?: number;
  placement?: Placement;
  scheduledAt: string | null;
  publishedAt: string | null;
  broadcastId?: number;
  recipients?: number;
  state: TargetState;
  permalink: string | null;
  error: string | null;
};

export type ProjectSummary = Omit<CreativeProject, "scene" | "data">;
export type HistoryItem = { project: ProjectSummary; targets: PublishTargetView[]; thumbUrl: string | null };

export const publishKeys = {
  channels: (academyId: number) => [...creativeKeys.all(academyId), "publish", "channels"] as const,
  history: (academyId: number) => [...creativeKeys.all(academyId), "publish", "history"] as const,
  project: (academyId: number, id: number) => [...creativeKeys.all(academyId), "publish", "project", id] as const,
  audience: (academyId: number, key: string) => [...creativeKeys.all(academyId), "publish", "audience", key] as const,
};

const waiting = (targets: PublishTargetView[]) => targets.some((t) => t.state === "scheduled" || t.state === "publishing");

export function usePublishChannels(academyId: number) {
  return useQuery({ queryKey: publishKeys.channels(academyId), staleTime: 30_000, queryFn: () => send<PublishChannels>(creativePath(academyId, "/publish/channels")) });
}

/** Published and scheduled projects; refreshes every 20 s while something is waiting to go out. */
export function usePublishHistory(academyId: number) {
  return useQuery({
    queryKey: publishKeys.history(academyId),
    queryFn: () => send<{ items: HistoryItem[] }>(creativePath(academyId, "/publish/history")).then((r) => r.items),
    refetchInterval: (q) => ((q.state.data ?? []).some((i) => waiting(i.targets)) ? 20_000 : false),
  });
}

/** Where one project went, with each social post's live status. */
export function useProjectTargets(academyId: number, projectId: number | null) {
  return useQuery({
    queryKey: publishKeys.project(academyId, projectId ?? 0),
    enabled: projectId !== null,
    queryFn: () => send<{ project: CreativeProject; targets: PublishTargetView[] }>(creativePath(academyId, `/projects/${projectId}/publish`)).then((r) => r.targets),
    refetchInterval: (q) => (waiting(q.state.data ?? []) ? 15_000 : false),
  });
}

type ProjectResult = { project: CreativeProject; targets: PublishTargetView[] };

function useAfter(academyId: number) {
  const qc = useQueryClient();
  return (r: ProjectResult) => {
    qc.setQueryData(creativeKeys.project(academyId, r.project.id), r.project);
    qc.setQueryData(publishKeys.project(academyId, r.project.id), r.targets);
    void qc.invalidateQueries({ queryKey: ["creative", academyId, "projects"] });
    void qc.invalidateQueries({ queryKey: publishKeys.history(academyId) });
  };
}

export type SocialPublishBody = { targets: SocialTarget[]; caption: string; placement: Placement; scheduledAt: string | null; again?: boolean };
export type SocialPublishResult = ProjectResult & { post: { id: number; status: string; error: string | null; igPermalink: string | null; fbPermalink: string | null; scheduledFor: string | null } };

export function usePublishToSocial(academyId: number) {
  const after = useAfter(academyId);
  return useMutation({
    mutationFn: ({ id, ...body }: SocialPublishBody & { id: number }) =>
      send<SocialPublishResult>(creativePath(academyId, `/projects/${id}/publish`), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (r) => after(r),
  });
}

export function useCancelSocialPost(academyId: number) {
  const after = useAfter(academyId);
  return useMutation({
    mutationFn: ({ id, postId }: { id: number; postId: number }) => send<ProjectResult>(creativePath(academyId, `/projects/${id}/publish/${postId}`), { method: "DELETE" }),
    onSuccess: (r) => after(r),
  });
}

export const audienceKey = (a: Audience) => `${[...a.roles].sort().join(",")}|${a.squadIds ? [...a.squadIds].sort((x, y) => x - y).join(",") : "all"}`;

export function useWhatsappReach(academyId: number, audience: Audience | null) {
  return useQuery({
    queryKey: publishKeys.audience(academyId, audience ? audienceKey(audience) : "none"),
    enabled: Boolean(audience && audience.roles.length > 0 && (audience.squadIds === null || audience.squadIds.length > 0)),
    queryFn: () => send<{ count: number; skipped: number; missing: number; squads: string[] }>(creativePath(academyId, "/publish/whatsapp/preview"), { method: "POST", body: JSON.stringify({ audience }) }),
  });
}

export function useSendOnWhatsapp(academyId: number) {
  const after = useAfter(academyId);
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; audience: Audience; message: string; again?: boolean }) =>
      send<ProjectResult & { broadcastId: number; queued: number }>(creativePath(academyId, `/projects/${id}/whatsapp`), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (r) => after(r),
  });
}

export function useAddToAds(academyId: number) {
  const after = useAfter(academyId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => send<ProjectResult & { media: { id: number; kind: string; thumbUrl: string | null } }>(creativePath(academyId, `/projects/${id}/to-ads`), { method: "POST" }),
    onSuccess: (r) => {
      after(r);
      void qc.invalidateQueries({ queryKey: ["academy-ad-media", academyId] });
      void qc.invalidateQueries({ queryKey: ["academy-ads", academyId] });
    },
  });
}

/** Bookkeeping only (the file itself is project.outputUrl?download=1). Never throws. */
export function markDownloaded(academyId: number, id: number): void {
  void send<null>(creativePath(academyId, `/projects/${id}/downloaded`), { method: "POST" }).catch(() => undefined);
}

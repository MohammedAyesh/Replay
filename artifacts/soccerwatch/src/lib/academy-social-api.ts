import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Academy console → Social, and Instagram/Messenger chats. Hand-written client for routes/academySocial.ts. */

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiBase = `${basePath}/api`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

const root = (academyId: number) => `/academy/console/academies/${academyId}/social`;

export type Insights = Record<string, number | null>;

export type SocialOverview = {
  connection: null | {
    status: "pending" | "connected" | "error";
    pageId: string | null;
    pageName: string | null;
    igUserId: string | null;
    igUsername: string | null;
    igPicture: string | null;
    subscribed: boolean;
    error: string | null;
    connectedAt: string | null;
    insights: { instagram?: Insights; facebook?: Insights } | null;
    insightsAt: string | null;
    postsSyncedAt: string | null;
  };
  app: { appId: string; graphVersion: string; loginConfigId: string; configured: boolean };
  canManage: boolean;
  unreadThreads: number;
  openComments: number;
};

export type PageChoice = { id: string; name: string; instagram: { id: string; username: string | null } | null };
export type InstagramAssetChoice = { id: string; username: string | null; profilePictureUrl: string | null };
export type InstagramLoginResult = {
  status: "connected" | "pending";
  igUsername?: string | null;
  accounts?: InstagramAssetChoice[];
  academyId: number;
};

export type SocialChannel = "instagram" | "messenger";
export type LeadStage = "new" | "contacted" | "trial" | "joined" | "lost";
export type ReplyWindow = "open" | "human_agent" | "closed";

export type SocialThreadSummary = {
  id: number;
  channel: SocialChannel;
  name: string | null;
  username: string | null;
  picture: string | null;
  stage: LeadStage | null;
  contact: null | { id: number; name: string | null; phone: string; display: string; kind: string; stage: LeadStage | null };
  archived: boolean;
  muted: boolean;
  blocked: boolean;
  replyWindow: ReplyWindow;
  assignedUserId?: number | null;
  lastInAt: string | null;
  lastAt: string | null;
  lastBody: string;
  lastDirection: "in" | "out";
  lastStatus: string;
  unread: number;
};

export type SocialMessage = {
  id: number;
  direction: "in" | "out";
  kind: string;
  body: string;
  attachments: Array<{ type: string; url: string | null; title: string | null }>;
  status: "received" | "sent" | "failed";
  error: string | null;
  createdAt: string;
};

export type SocialThread = Omit<SocialThreadSummary, "lastBody" | "lastDirection" | "lastStatus" | "unread"> & { canManage: boolean; messages: SocialMessage[] };

export type SocialComment = {
  id: number;
  channel: "instagram" | "facebook";
  body: string;
  fromName: string | null;
  postPermalink: string | null;
  postCaption: string | null;
  hidden: boolean;
  replyBody: string | null;
  repliedAt: string | null;
  privateRepliedAt: string | null;
  threadId: number | null;
  read: boolean;
  createdAt: string;
  canPrivateReply: boolean;
};

export type SocialPost = {
  id: number;
  source: "replay" | "synced";
  targets: Array<"instagram" | "facebook">;
  format: "image" | "carousel" | "video" | "reel" | "story";
  caption: string;
  status: "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed";
  scheduledFor: string | null;
  publishedAt: string | null;
  igPermalink: string | null;
  fbPermalink: string | null;
  thumbnail: string | null;
  error: string | null;
  insights: { instagram?: Insights; facebook?: Insights };
  mediaCount: number;
};

export type LibraryMedia = { id: number; kind: "image" | "video"; name: string; status: string; thumbUrl: string | null; durationSec: number | null };

const keys = {
  overview: (id: number) => ["academy-social", id, "overview"] as const,
  threads: (id: number) => ["academy-social", id, "threads"] as const,
  thread: (id: number, threadId: number) => ["academy-social", id, "thread", threadId] as const,
  comments: (id: number, filter: string) => ["academy-social", id, "comments", filter] as const,
  posts: (id: number) => ["academy-social", id, "posts"] as const,
  media: (id: number) => ["academy-social", id, "media"] as const,
  hidden: (id: number) => ["academy-social", id, "hidden"] as const,
};

function useInvalidate(academyId: number) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["academy-social", academyId] });
}

export function useSocialOverview(academyId: number | null, enabled = true) {
  return useQuery({
    queryKey: keys.overview(academyId ?? 0),
    queryFn: () => call<SocialOverview>(root(academyId!)),
    enabled: academyId !== null && enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useSocialConnect(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: (code: string) => call<{ status: string; pages: PageChoice[] }>(`${root(academyId)}/connect`, { method: "POST", body: JSON.stringify({ code }) }),
    onSuccess: done,
  });
}

export function useInstagramLoginStart(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: () => call<{ url: string }>(`${root(academyId)}/connect/instagram`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: done,
  });
}

export function completeInstagramLogin(input: { code?: string; state: string; error?: string; errorDescription?: string }) {
  return call<InstagramLoginResult>("/academy/console/social/instagram/callback", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function usePendingInstagramAssets(academyId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["academy-social", academyId, "instagram-assets"],
    queryFn: () => call<InstagramAssetChoice[]>(`${root(academyId)}/instagram-accounts`),
    enabled,
    retry: false,
  });
}

export function useSelectInstagramAsset(academyId: number) {
  const done = useInvalidate(academyId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (instagramId: string) => call<{ status: string; igUsername: string | null }>(`${root(academyId)}/instagram-account`, {
      method: "POST",
      body: JSON.stringify({ instagramId }),
    }),
    onSuccess: async () => {
      await done();
      await qc.invalidateQueries({ queryKey: ["venue", academyId, "instagram"] });
      await qc.invalidateQueries({ queryKey: ["academy-social", academyId, "instagram-assets"] });
    },
  });
}

export function useSocialPages(academyId: number, enabled: boolean) {
  return useQuery({ queryKey: ["academy-social", academyId, "pages"], queryFn: () => call<PageChoice[]>(`${root(academyId)}/pages`), enabled, retry: false });
}

export function useSelectPage(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: (pageId: string) => call(`${root(academyId)}/page`, { method: "PUT", body: JSON.stringify({ pageId }) }),
    onSuccess: done,
  });
}

export function useSocialDisconnect(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({ mutationFn: () => call(root(academyId), { method: "DELETE" }), onSuccess: done });
}

export function useSocialSync(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({ mutationFn: () => call<{ instagram: number; facebook: number }>(`${root(academyId)}/sync`, { method: "POST" }), onSuccess: done });
}

// ─── Threads ────────────────────────────────────────────────────────────────

export function useSocialThreads(academyId: number, enabled = true) {
  return useQuery({
    queryKey: keys.threads(academyId),
    queryFn: () => call<SocialThreadSummary[]>(`${root(academyId)}/threads`),
    enabled,
    refetchInterval: 8_000,
    retry: false,
  });
}

export function useSocialThread(academyId: number, threadId: number) {
  return useQuery({
    queryKey: keys.thread(academyId, threadId),
    queryFn: () => call<SocialThread>(`${root(academyId)}/threads/${threadId}`),
    refetchInterval: 5_000,
  });
}

export function useSendSocial(academyId: number, threadId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => call(`${root(academyId)}/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ body }) }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.thread(academyId, threadId) });
      void qc.invalidateQueries({ queryKey: keys.threads(academyId) });
    },
  });
}

export function useSocialThreadState(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ threadId, state }: { threadId: number; state: Partial<Record<"archived" | "muted" | "blocked" | "personal", boolean>> }) =>
      call(`${root(academyId)}/threads/${threadId}/state`, { method: "POST", body: JSON.stringify(state) }),
    onSuccess: done,
  });
}

export function useAssignSocialThread(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ threadId, userId }: { threadId: number; userId: number | null }) =>
      call(`${root(academyId)}/threads/${threadId}/assign`, { method: "POST", body: JSON.stringify({ userId }) }),
    onSuccess: done,
  });
}

export function useHiddenSocialThreads(academyId: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.hidden(academyId),
    queryFn: () => call<Array<{ id: number; channel: SocialChannel; name: string | null; username: string | null; personal: boolean; blocked: boolean }>>(`${root(academyId)}/threads-hidden`),
    enabled,
    retry: false,
  });
}

export function useSocialLead(academyId: number, threadId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: (body: { stage?: LeadStage | null; phone?: string; name?: string }) =>
      call(`${root(academyId)}/threads/${threadId}/lead`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: done,
  });
}

// ─── Comments ───────────────────────────────────────────────────────────────

export function useSocialComments(academyId: number, filter: "open" | "all") {
  return useQuery({
    queryKey: keys.comments(academyId, filter),
    queryFn: () => call<SocialComment[]>(`${root(academyId)}/comments?filter=${filter}`),
    refetchInterval: 20_000,
  });
}

export function useCommentAction(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ id, action, text, hidden }: { id: number; action: "reply" | "private-reply" | "hide" | "read"; text?: string; hidden?: boolean }) =>
      call<{ ok: boolean; threadId?: number }>(`${root(academyId)}/comments/${id}/${action}`, { method: "POST", body: JSON.stringify({ text, hidden }) }),
    onSuccess: done,
  });
}

// ─── Posts and media ────────────────────────────────────────────────────────

export function useSocialPosts(academyId: number) {
  return useQuery({ queryKey: keys.posts(academyId), queryFn: () => call<SocialPost[]>(`${root(academyId)}/posts`), refetchInterval: 30_000 });
}

export type NewPost = { targets: Array<"instagram" | "facebook">; format: SocialPost["format"]; caption: string; mediaIds: number[]; scheduledFor?: string | null };

export function useCreatePost(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: (post: NewPost) => call<{ id: number; status: SocialPost["status"]; error: string | null }>(`${root(academyId)}/posts`, { method: "POST", body: JSON.stringify(post) }),
    onSuccess: done,
  });
}

export function usePostAction(academyId: number) {
  const done = useInvalidate(academyId);
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: "publish" | "delete" }) =>
      action === "delete" ? call(`${root(academyId)}/posts/${id}`, { method: "DELETE" }) : call(`${root(academyId)}/posts/${id}/publish`, { method: "POST" }),
    onSuccess: done,
  });
}

export function useSocialMedia(academyId: number, enabled: boolean) {
  return useQuery({ queryKey: keys.media(academyId), queryFn: () => call<LibraryMedia[]>(`${root(academyId)}/media`), enabled, refetchInterval: enabled ? 15_000 : false });
}

export function useUploadSocialPhoto(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { dataUrl: string; name: string }) => call<{ id: number }>(`${root(academyId)}/media`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.media(academyId) }),
  });
}

export const apiUrl = (path: string) => (path.startsWith("/api") ? `${basePath}${path}` : path);

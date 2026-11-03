import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Academy WhatsApp (WAHA). Hand-written client for routes/academyWhatsapp.ts. */

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiBase = `${basePath}/api`;

export class WhatsappApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (response.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = typeof (data as { error?: unknown })?.error === "string"
      ? (data as { error: string }).error
      : `Request failed (${response.status})`;
    throw new WhatsappApiError(response.status, message);
  }
  return data as T;
}

export type AudienceRole = "parents" | "players" | "coaches";
export type WhatsappSender = "own" | "replay" | "off";

export type SessionInfo = { status: string; phone: string | null; name: string | null };

export type AutomationView = {
  key: string;
  enabled: boolean;
  audiences: AudienceRole[];
  template: string;
  customTemplate: boolean;
  timing: number | null;
  allowedAudiences: AudienceRole[];
  timingRule: { unit: "hoursBefore" | "daysBefore" | "daysAfter"; default: number; min: number; max: number } | null;
  placeholders: string[];
  defaultTemplate: string;
};

export type WhatsappOverview = {
  academyId: number;
  academyName: string;
  role: "owner" | "coach";
  configured: boolean;
  serviceReachable: boolean;
  sender: WhatsappSender;
  locale: "ar" | "en";
  dailyLimit: number;
  own: SessionInfo;
  replay: SessionInfo & { available: boolean };
  automations: AutomationView[];
  stats: {
    sentToday: number;
    queued: number;
    failed7d: number;
    sent7d: number;
    delivered7d: number;
    read7d: number;
    replies7d: number;
    optOuts: number;
  };
  squads: Array<{ id: number; name: string }>;
  players: Array<{ id: number; name: string; squadId: number | null }>;
};

export type Audience = { roles: AudienceRole[]; squadIds: number[] | null; playerIds: number[] | null };

export type AudiencePreview = {
  count: number;
  optedOut: number;
  playerCount: number;
  recipients: Array<{ phone: string; name: string | null; role: "parent" | "player" | "coach"; players: string[] }>;
  missing: Array<{ playerId: number; playerName: string; role: "parent" | "player" }>;
};

export type WhatsappMessage = {
  id: number;
  direction: "out" | "in";
  kind: string;
  broadcastId: number | null;
  phone: string;
  recipientName: string | null;
  recipientRole: string | null;
  playerName: string | null;
  body: string;
  status: "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "skipped" | "received";
  error: string | null;
  scheduledFor: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
};

export type WhatsappBroadcast = {
  id: number;
  body: string;
  recipientCount: number;
  scheduledFor: string;
  createdAt: string;
  statusCounts: Partial<Record<WhatsappMessage["status"], number>>;
};

export type QrState = SessionInfo & { qr: string | null };

const key = (academyId: number, ...rest: unknown[]) => ["academy-whatsapp", academyId, ...rest];
const json = (body: unknown) => JSON.stringify(body ?? {});

export function useWhatsappOverview(academyId: number) {
  return useQuery({
    queryKey: key(academyId),
    queryFn: () => call<WhatsappOverview>(`/academy/console/academies/${academyId}/whatsapp`),
    staleTime: 15_000,
  });
}

export function useWhatsappMessages(academyId: number, enabled = true) {
  return useQuery({
    queryKey: key(academyId, "messages"),
    queryFn: () => call<{ messages: WhatsappMessage[]; broadcasts: WhatsappBroadcast[] }>(
      `/academy/console/academies/${academyId}/whatsapp/messages`,
    ),
    enabled,
    refetchInterval: 20_000,
  });
}

/** Polls the link status every 3 s while the QR / pairing dialog is open. */
export function useWhatsappQr(academyId: number | "replay", open: boolean) {
  const path = academyId === "replay" ? "/admin/whatsapp/replay/qr" : `/academy/console/academies/${academyId}/whatsapp/qr`;
  return useQuery({
    queryKey: ["academy-whatsapp-qr", academyId],
    queryFn: () => call<QrState>(path),
    enabled: open,
    refetchInterval: open ? 3_000 : false,
  });
}

function useInvalidate(academyId: number) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key(academyId) });
}

export function useSaveWhatsappSettings(academyId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (body: Partial<{ sender: WhatsappSender; locale: "ar" | "en"; dailyLimit: number }>) =>
      call(`/academy/console/academies/${academyId}/whatsapp/settings`, { method: "PUT", body: json(body) }),
    onSuccess: invalidate,
  });
}

export function useSaveAutomation(academyId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (body: { key: string; enabled?: boolean; audiences?: AudienceRole[]; template?: string | null; timing?: number | null }) =>
      call(`/academy/console/academies/${academyId}/whatsapp/automations`, { method: "PUT", body: json(body) }),
    onSuccess: invalidate,
  });
}

export function useConnectWhatsapp(academyId: number | "replay") {
  const qc = useQueryClient();
  const path = academyId === "replay" ? "/admin/whatsapp/replay/connect" : `/academy/console/academies/${academyId}/whatsapp/connect`;
  return useMutation({
    mutationFn: (body: { method: "qr" | "code"; phone?: string }) =>
      call<{ status: string; code: string | null }>(path, { method: "POST", body: json(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy-whatsapp-qr", academyId] }),
  });
}

export function useDisconnectWhatsapp(academyId: number | "replay") {
  const qc = useQueryClient();
  const path = academyId === "replay" ? "/admin/whatsapp/replay/disconnect" : `/academy/console/academies/${academyId}/whatsapp/disconnect`;
  return useMutation({
    mutationFn: () => call(path, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["academy-whatsapp"] });
      void qc.invalidateQueries({ queryKey: ["admin-whatsapp"] });
    },
  });
}

export function usePreviewAudience(academyId: number) {
  return useMutation({
    mutationFn: (audience: Audience) =>
      call<AudiencePreview>(`/academy/console/academies/${academyId}/whatsapp/preview`, { method: "POST", body: json({ audience }) }),
  });
}

export function useSendBroadcast(academyId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (body: { body: string; audience: Audience; scheduledFor?: string | null }) =>
      call<{ broadcastId: number; queued: number; scheduledFor: string }>(
        `/academy/console/academies/${academyId}/whatsapp/broadcasts`,
        { method: "POST", body: json(body) },
      ),
    onSuccess: invalidate,
  });
}

export function useSendTest(academyId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (phone?: string) =>
      call<{ ok: true; phone: string }>(`/academy/console/academies/${academyId}/whatsapp/test`, { method: "POST", body: json({ phone }) }),
    onSuccess: invalidate,
  });
}

export function useRetryMessage(academyId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (messageId: number) =>
      call(`/academy/console/academies/${academyId}/whatsapp/messages/${messageId}/retry`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useOptOuts(academyId: number, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "opt-outs"),
    queryFn: () => call<Array<{ phone: string; display: string; createdAt: string }>>(
      `/academy/console/academies/${academyId}/whatsapp/opt-outs`,
    ),
    enabled,
  });
}

export function useRemoveOptOut(academyId: number) {
  const invalidate = useInvalidate(academyId);
  return useMutation({
    mutationFn: (phone: string) =>
      call(`/academy/console/academies/${academyId}/whatsapp/opt-outs/${encodeURIComponent(phone)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export type AdminWhatsapp = {
  configured: boolean;
  reachable: boolean;
  version: Record<string, unknown> | null;
  error: string | null;
  replay: SessionInfo;
  sessions: Array<SessionInfo & { session: string }>;
  academies: Array<{
    academyId: number;
    name: string;
    sender: WhatsappSender;
    sessionStatus: string | null;
    connectedPhone: string | null;
    sent7d: number;
    failed7d: number;
    queued: number;
  }>;
};

export function useAdminWhatsapp() {
  return useQuery({
    queryKey: ["admin-whatsapp"],
    queryFn: () => call<AdminWhatsapp>("/admin/whatsapp"),
    refetchInterval: 30_000,
  });
}

// ─── Chats & People ──────────────────────────────────────────────────────────

export type ContactKind = "unknown" | "lead" | "parent" | "player" | "coach" | "staff" | "other";
export type LeadStage = "new" | "contacted" | "trial" | "joined" | "lost";
export type Relationship = "father" | "mother" | "guardian" | "sibling" | "relative" | "self" | "other";
export const CONTACT_KINDS: ContactKind[] = ["parent", "player", "lead", "coach", "staff", "other", "unknown"];
export const LEAD_STAGES: LeadStage[] = ["new", "contacted", "trial", "joined", "lost"];
export const RELATIONSHIPS: Relationship[] = ["father", "mother", "guardian", "sibling", "relative", "self", "other"];

export type ContactPlayerLink = { playerId: number; playerName: string; squadName: string | null; relationship: Relationship; isActive: boolean };

export type Contact = {
  id: number;
  phone: string;
  display: string;
  name: string | null;
  kind: ContactKind;
  stage: LeadStage | null;
  source: string;
  tags: string[];
  notes: string | null;
  players: ContactPlayerLink[];
  lastMessageAt?: string | null;
  optedOut?: boolean;
  createdAt: string;
};

export type ChatSummary = {
  phone: string;
  display: string;
  lastAt: string;
  lastBody: string;
  lastDirection: "in" | "out";
  lastStatus: WhatsappMessage["status"];
  unread: number;
  archived: boolean;
  muted: boolean;
  blocked: boolean;
  linkLater: boolean;
  assignedUserId: number | null;
  avatarUrl: string | null;
  typing: boolean;
  group: ChatGroup | null;
  contact: Contact | null;
};

export type ChatGroup = { id: number; groupId: string; subject: string; origin: "replay" | "existing"; squadId: number | null };

/** A file as stored on the server (sent back unchanged when sending it). */
export type MediaRef = { path: string; mimetype: string; filename?: string | null; size?: number | null };
export type MediaView = { mimetype: string; filename: string | null; size: number | null; url: string | null; pending: boolean };

export type ChatContent =
  | { type: "image"; media: MediaView; caption?: string | null }
  | { type: "video"; media: MediaView; caption?: string | null; gif?: boolean; note?: boolean }
  | { type: "audio"; media: MediaView; voice?: boolean }
  | { type: "document"; media: MediaView; caption?: string | null }
  | { type: "sticker"; media: MediaView }
  | { type: "location"; latitude: number; longitude: number; name?: string | null; address?: string | null }
  | { type: "contact"; contacts: Array<{ name: string; phone: string; display: string }> }
  | { type: "poll"; name: string; options: string[]; multipleAnswers: boolean; voters: number; tally: Array<{ option: string; count: number; voters: string[] }> };

/** What the composer sends: files by their stored reference. */
export type OutgoingContent =
  | { type: "image"; media: MediaRef; caption?: string | null }
  | { type: "video"; media: MediaRef; caption?: string | null; gif?: boolean; note?: boolean }
  | { type: "audio"; media: MediaRef; voice?: boolean }
  | { type: "document"; media: MediaRef; caption?: string | null }
  | { type: "sticker"; media: MediaRef }
  | { type: "contact"; contacts: Array<{ name: string; phone: string }> }
  | { type: "location"; latitude: number; longitude: number; name?: string | null }
  | { type: "poll"; name: string; options: string[]; multipleAnswers: boolean };

export type MessageReply = { id: number | null; direction: "in" | "out"; body: string; deleted: boolean; type: string; author: string | null };
export type MessageReaction = { who: string; name: string | null; emoji: string };

export type ChatMessage = Pick<WhatsappMessage, "id" | "direction" | "kind" | "body" | "status" | "error" | "createdAt" | "sentAt"> & {
  content: ChatContent | null;
  author: { phone: string | null; name: string | null } | null;
  sentBy: string | null;
  scheduledFor: string | null;
  replyTo: MessageReply | null;
  reactions: MessageReaction[];
  mentions: string[];
  editedAt: string | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

export type ChatThread = {
  phone: string;
  display: string;
  avatarUrl: string | null;
  typing: boolean;
  group: ChatGroup | null;
  /** The group lives on the academy's other WhatsApp number. */
  wrongNumber: boolean;
  contact: Contact | null;
  optedOut: boolean;
  archived: boolean;
  muted: boolean;
  blocked: boolean;
  linkLater: boolean;
  assignedUserId: number | null;
  canManage: boolean;
  messages: ChatMessage[];
};

/** Chat keys are a phone or "g:<groupId>": always encode them in a URL. */
const chatPath = (academyId: number, phone: string | null, rest = "") =>
  `/academy/console/academies/${academyId}/whatsapp/chats/${encodeURIComponent(phone ?? "")}${rest}`;

export function useChats(academyId: number) {
  return useQuery({
    queryKey: key(academyId, "chats"),
    queryFn: () => call<ChatSummary[]>(`/academy/console/academies/${academyId}/whatsapp/chats`),
    refetchInterval: 8_000,
  });
}

export function useChatThread(academyId: number, phone: string | null) {
  return useQuery({
    queryKey: key(academyId, "chat", phone),
    queryFn: () => call<ChatThread>(chatPath(academyId, phone)),
    enabled: Boolean(phone),
    refetchInterval: 5_000,
  });
}

export type SendInput = string | { body?: string; content?: OutgoingContent; replyToId?: number; scheduledFor?: string };

export function useSendChat(academyId: number, phone: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: SendInput) =>
      call<{ id: number; outcome: "sent" | "queued" | "failed"; scheduled?: boolean }>(
        chatPath(academyId, phone, "/messages"),
        { method: "POST", body: json(typeof message === "string" ? { body: message } : message) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chat", phone) });
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
    },
  });
}

export type ChatState = { archived?: boolean; muted?: boolean; blocked?: boolean; personal?: boolean };

/** Archive, mute, block or mark personal (the owner, or a role he gave "manage chats"). */
export function useChatState(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ phone, state }: { phone: string; state: ChatState }) =>
      call<{ phone: string; archived: boolean; muted: boolean; blocked: boolean; personal: boolean }>(
        chatPath(academyId, phone, "/state"), { method: "POST", body: json(state) },
      ),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
      void qc.invalidateQueries({ queryKey: key(academyId, "chat", v.phone) });
      void qc.invalidateQueries({ queryKey: key(academyId, "hidden") });
      void qc.invalidateQueries({ queryKey: key(academyId, "contacts") });
    },
  });
}

/** "Who is this?": not a player's family ("none"), not now ("later"), or ask again ("ask"). */
export function useChatWho(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ phone, action }: { phone: string; action: "none" | "later" | "ask" }) =>
      call(chatPath(academyId, phone, "/who"), { method: "POST", body: json({ action }) }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
      void qc.invalidateQueries({ queryKey: key(academyId, "chat", v.phone) });
      void qc.invalidateQueries({ queryKey: key(academyId, "contacts") });
    },
  });
}

// ─── Files, GIFs, groups, assigning ─────────────────────────────────────────

export const MAX_CHAT_FILE_BYTES = 30 * 1024 * 1024;

/** Upload a file's bytes; a GIF comes back as a looping MP4 marked gif. */
export async function uploadChatFile(academyId: number, file: Blob, filename: string): Promise<{ media: MediaRef; gif: boolean }> {
  const response = await fetch(`${apiBase}/academy/console/academies/${academyId}/whatsapp/media?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const data = await response.json().catch(() => null) as { media?: MediaRef; gif?: boolean; error?: string } | null;
  if (!response.ok || !data?.media) throw new WhatsappApiError(response.status, data?.error ?? `Upload failed (${response.status})`);
  return { media: data.media, gif: data.gif === true };
}

export type GifResult = { id: string; title: string; preview: string | null; still: string | null };

export function useGifSearch(academyId: number, q: string, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "gifs", q),
    queryFn: () => call<{ enabled: boolean; results: GifResult[] }>(`/academy/console/academies/${academyId}/whatsapp/gifs?q=${encodeURIComponent(q)}`),
    enabled,
    staleTime: 60_000,
  });
}

export function pickGif(academyId: number, id: string) {
  return call<{ media: MediaRef; gif: boolean }>(`/academy/console/academies/${academyId}/whatsapp/gifs`, { method: "POST", body: json({ id }) });
}

export type TeamMember = { id: number; name: string; role: "owner" | "manager" | "coach"; me: boolean };

export function useChatAssignees(academyId: number) {
  return useQuery({
    queryKey: key(academyId, "assignees"),
    queryFn: () => call<TeamMember[]>(`/academy/console/academies/${academyId}/whatsapp/assignees`),
    staleTime: 5 * 60_000,
  });
}

export function useAssignChat(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ phone, userId }: { phone: string; userId: number | null }) =>
      call(chatPath(academyId, phone, "/assign"), { method: "POST", body: json({ userId }) }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
      void qc.invalidateQueries({ queryKey: key(academyId, "chat", v.phone) });
    },
  });
}

export function checkChatNumber(academyId: number, phone: string) {
  return call<{ phone: string; display: string; onWhatsapp: boolean | null; name: string | null }>(
    `/academy/console/academies/${academyId}/whatsapp/check`, { method: "POST", body: json({ phone }) },
  );
}

export type GroupInput = {
  subject: string;
  contactIds?: number[];
  phones?: string[];
  audience?: { roles: AudienceRole[]; squadIds: number[] | null; playerIds: null };
};

export function useCreateGroup(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GroupInput) =>
      call<{ phone: string; members: number }>(`/academy/console/academies/${academyId}/whatsapp/groups`, { method: "POST", body: json(input) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId, "chats") }),
  });
}

export type PhoneGroup = { id: string; subject: string; participants: number | null; followed: boolean };

export function usePhoneGroups(academyId: number, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "phone-groups"),
    queryFn: () => call<PhoneGroup[]>(`/academy/console/academies/${academyId}/whatsapp/groups/available`),
    enabled,
    retry: false,
  });
}

export function useFollowGroup(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (group: { groupId: string; subject: string }) =>
      call<{ phone: string }>(`/academy/console/academies/${academyId}/whatsapp/groups/follow`, { method: "POST", body: json(group) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
      void qc.invalidateQueries({ queryKey: key(academyId, "phone-groups") });
    },
  });
}

export function useAddToGroup(academyId: number) {
  return useMutation({
    mutationFn: ({ groupId, contactIds, phones }: { groupId: string; contactIds?: number[]; phones?: string[] }) =>
      call<{ added: number }>(`/academy/console/academies/${academyId}/whatsapp/groups/${encodeURIComponent(groupId)}/participants`, { method: "POST", body: json({ contactIds, phones }) }),
  });
}

export function useHiddenChats(academyId: number, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "hidden"),
    queryFn: () => call<Array<{ phone: string; display: string; name: string | null; personal: boolean; blocked: boolean }>>(`/academy/console/academies/${academyId}/whatsapp/hidden`),
    enabled,
  });
}

export function useContacts(academyId: number) {
  return useQuery({
    queryKey: key(academyId, "contacts"),
    queryFn: () => call<Contact[]>(`/academy/console/academies/${academyId}/contacts`),
    staleTime: 15_000,
  });
}

function useInvalidateContacts(academyId: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(academyId, "contacts") });
    void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
    void qc.invalidateQueries({ queryKey: key(academyId, "chat") });
  };
}

export type ContactInput = {
  phone?: string;
  name?: string | null;
  kind?: ContactKind;
  stage?: LeadStage | null;
  tags?: string[];
  notes?: string | null;
  links?: Array<{ playerId: number; relationship: Relationship }>;
};

export function useCreateContact(academyId: number) {
  const invalidate = useInvalidateContacts(academyId);
  return useMutation({
    mutationFn: (body: ContactInput) => call<Contact>(`/academy/console/academies/${academyId}/contacts`, { method: "POST", body: json(body) }),
    onSuccess: invalidate,
  });
}

export function useUpdateContact(academyId: number) {
  const invalidate = useInvalidateContacts(academyId);
  return useMutation({
    mutationFn: ({ id, ...body }: ContactInput & { id: number }) =>
      call<Contact>(`/academy/console/academies/${academyId}/contacts/${id}`, { method: "PATCH", body: json(body) }),
    onSuccess: invalidate,
  });
}

export function useDeleteContact(academyId: number) {
  const invalidate = useInvalidateContacts(academyId);
  return useMutation({
    mutationFn: (id: number) => call(`/academy/console/academies/${academyId}/contacts/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useLinkContact(academyId: number) {
  const invalidate = useInvalidateContacts(academyId);
  return useMutation({
    mutationFn: ({ contactId, playerId, relationship }: { contactId: number; playerId: number; relationship: Relationship }) =>
      call<Contact>(`/academy/console/academies/${academyId}/contacts/${contactId}/players/${playerId}`, { method: "PUT", body: json({ relationship }) }),
    onSuccess: invalidate,
  });
}

export function useUnlinkContact(academyId: number) {
  const invalidate = useInvalidateContacts(academyId);
  return useMutation({
    mutationFn: ({ contactId, playerId }: { contactId: number; playerId: number }) =>
      call<Contact>(`/academy/console/academies/${academyId}/contacts/${contactId}/players/${playerId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useSendToContacts(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { body: string; contactIds: number[] }) =>
      call<{ broadcastId: number; queued: number }>(`/academy/console/academies/${academyId}/whatsapp/broadcasts`, { method: "POST", body: json(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId) }),
  });
}

// ─── Replies, reactions, edit, delete, forward, search, media ───────────────

function useRefreshChat(academyId: number, phone: string | null) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(academyId, "chat", phone) });
    void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
    void qc.invalidateQueries({ queryKey: key(academyId, "chat-media", phone) });
  };
}

export function useReactToMessage(academyId: number, phone: string) {
  const refresh = useRefreshChat(academyId, phone);
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: number; emoji: string }) =>
      call(chatPath(academyId, phone, `/messages/${messageId}/reaction`), { method: "POST", body: json({ emoji }) }),
    onSuccess: refresh,
  });
}

export function useDeleteMessage(academyId: number, phone: string) {
  const refresh = useRefreshChat(academyId, phone);
  return useMutation({
    mutationFn: (messageId: number) => call(chatPath(academyId, phone, `/messages/${messageId}`), { method: "DELETE" }),
    onSuccess: refresh,
  });
}

export function useEditMessage(academyId: number, phone: string) {
  const refresh = useRefreshChat(academyId, phone);
  return useMutation({
    mutationFn: ({ messageId, text }: { messageId: number; text: string }) =>
      call(chatPath(academyId, phone, `/messages/${messageId}`), { method: "PUT", body: json({ text }) }),
    onSuccess: refresh,
  });
}

export function useForwardMessage(academyId: number, phone: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, targets }: { messageId: number; targets: string[] }) =>
      call<{ sent: number; skipped: string[] }>(chatPath(academyId, phone, `/messages/${messageId}/forward`), { method: "POST", body: json({ targets }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId, "chats") }),
  });
}

/** Fire and forget: shows "typing…" to the other person. */
export function sendTyping(academyId: number, phone: string, typing: boolean) {
  void call(chatPath(academyId, phone, "/typing"), { method: "POST", body: json({ typing }) }).catch(() => undefined);
}

export type SearchHit = { id: number; direction: "in" | "out"; body: string; createdAt: string; author: string | null };

export function useChatSearch(academyId: number, phone: string, q: string) {
  return useQuery({
    queryKey: key(academyId, "chat-search", phone, q),
    queryFn: () => call<SearchHit[]>(chatPath(academyId, phone, `/search?q=${encodeURIComponent(q)}`)),
    enabled: q.trim().length >= 2,
    staleTime: 10_000,
  });
}

export function useChatMedia(academyId: number, phone: string, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "chat-media", phone),
    queryFn: () => call<ChatMessage[]>(chatPath(academyId, phone, "/media")),
    enabled,
  });
}

// ─── Saved replies ───────────────────────────────────────────────────────────

export type SavedReply = { id: number; shortcut: string; title: string; body: string };

export function useSavedReplies(academyId: number) {
  return useQuery({
    queryKey: key(academyId, "saved-replies"),
    queryFn: () => call<{ canEdit: boolean; replies: SavedReply[] }>(`/academy/console/academies/${academyId}/whatsapp/saved-replies`),
    staleTime: 60_000,
  });
}

export function useSaveReply(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...reply }: { id?: number; shortcut: string; title: string; body: string }) =>
      call<SavedReply>(`/academy/console/academies/${academyId}/whatsapp/saved-replies${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: json(reply) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId, "saved-replies") }),
  });
}

export function useDeleteReply(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call(`/academy/console/academies/${academyId}/whatsapp/saved-replies/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId, "saved-replies") }),
  });
}

// ─── Chat options ────────────────────────────────────────────────────────────

export type AutoReplyOption = { enabled: boolean; text: string };
export type ChatOptions = {
  readReceipts: boolean;
  greeting: AutoReplyOption;
  away: AutoReplyOption & { days: number[]; start: string; end: string };
  missedCall: AutoReplyOption;
  channel: { id: string; name: string; invite: string | null } | null;
  canEdit: boolean;
};

export function useChatOptions(academyId: number, enabled = true) {
  return useQuery({
    queryKey: key(academyId, "options"),
    queryFn: () => call<ChatOptions>(`/academy/console/academies/${academyId}/whatsapp/options`),
    enabled,
    staleTime: 60_000,
  });
}

export function useSaveChatOptions(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<ChatOptions, "readReceipts" | "greeting" | "away" | "missedCall">>) =>
      call<ChatOptions>(`/academy/console/academies/${academyId}/whatsapp/options`, { method: "PUT", body: json(patch) }),
    onSuccess: (data) => qc.setQueryData(key(academyId, "options"), data),
  });
}

// ─── Status and Channel ──────────────────────────────────────────────────────

export type WhatsappPost = { id: number; target: "status" | "channel"; kind: "text" | "image" | "video"; text: string | null; mediaUrl: string | null; error: string | null; canDelete: boolean; createdAt: string };

export function useWhatsappPosts(academyId: number, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "posts"),
    queryFn: () => call<{ channel: ChatOptions["channel"]; ownNumber: boolean; posts: WhatsappPost[] }>(`/academy/console/academies/${academyId}/whatsapp/posts`),
    enabled,
    retry: false,
  });
}

export function useCreatePost(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (post: { target: "status" | "channel"; kind: "text" | "image" | "video"; text?: string; caption?: string; media?: MediaRef; backgroundColor?: string }) =>
      call<WhatsappPost>(`/academy/console/academies/${academyId}/whatsapp/posts`, { method: "POST", body: json(post) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: key(academyId, "posts") }),
  });
}

export function useDeletePost(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call(`/academy/console/academies/${academyId}/whatsapp/posts/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId, "posts") }),
  });
}

export function useCreateChannel(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description: string }) =>
      call<{ id: string; name: string; invite: string | null }>(`/academy/console/academies/${academyId}/whatsapp/channel`, { method: "POST", body: json(input) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(academyId, "posts") });
      void qc.invalidateQueries({ queryKey: key(academyId, "options") });
    },
  });
}

// ─── Group management ────────────────────────────────────────────────────────

export type GroupMember = { phone: string | null; display: string | null; name: string | null; admin: boolean };

const groupPath = (academyId: number, groupId: string, rest = "") => `/academy/console/academies/${academyId}/whatsapp/groups/${encodeURIComponent(groupId)}${rest}`;

export function useGroupMembers(academyId: number, groupId: string | null, enabled = true) {
  return useQuery({
    queryKey: key(academyId, "group-members", groupId),
    queryFn: () => call<GroupMember[]>(groupPath(academyId, groupId!, "/members")),
    enabled: enabled && Boolean(groupId),
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateGroup(academyId: number, groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { subject?: string; description?: string; adminsOnlyMessages?: boolean; adminsOnlyInfo?: boolean; picture?: MediaRef | null }) =>
      call(groupPath(academyId, groupId), { method: "PUT", body: json(patch) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
      void qc.invalidateQueries({ queryKey: key(academyId, "chat") });
    },
  });
}

export function useGroupMemberAction(academyId: number, groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, phones }: { action: "remove" | "promote" | "demote"; phones: string[] }) =>
      action === "remove"
        ? call(groupPath(academyId, groupId, "/members/remove"), { method: "POST", body: json({ phones }) })
        : call(groupPath(academyId, groupId, "/admins"), { method: "POST", body: json({ phones, admin: action === "promote" }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(academyId, "group-members", groupId) }),
  });
}

export function useGroupInvite(academyId: number, groupId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(academyId, "group-invite", groupId),
    queryFn: () => call<{ link: string | null }>(groupPath(academyId, groupId, "/invite")),
    enabled,
    retry: false,
  });
}

export function useResetGroupInvite(academyId: number, groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<{ link: string | null }>(groupPath(academyId, groupId, "/invite/revoke"), { method: "POST" }),
    onSuccess: (data) => qc.setQueryData(key(academyId, "group-invite", groupId), data),
  });
}

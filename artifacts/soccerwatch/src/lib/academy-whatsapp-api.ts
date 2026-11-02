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
  contact: Contact | null;
};

export type ChatThread = {
  phone: string;
  display: string;
  contact: Contact | null;
  optedOut: boolean;
  archived: boolean;
  muted: boolean;
  blocked: boolean;
  linkLater: boolean;
  canManage: boolean;
  messages: Array<Pick<WhatsappMessage, "id" | "direction" | "kind" | "body" | "status" | "error" | "createdAt" | "sentAt">>;
};

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
    queryFn: () => call<ChatThread>(`/academy/console/academies/${academyId}/whatsapp/chats/${phone}`),
    enabled: Boolean(phone),
    refetchInterval: 5_000,
  });
}

export function useSendChat(academyId: number, phone: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      call<{ id: number; outcome: "sent" | "queued" | "failed" }>(
        `/academy/console/academies/${academyId}/whatsapp/chats/${phone}/messages`,
        { method: "POST", body: json({ body }) },
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
        `/academy/console/academies/${academyId}/whatsapp/chats/${phone}/state`, { method: "POST", body: json(state) },
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
      call(`/academy/console/academies/${academyId}/whatsapp/chats/${phone}/who`, { method: "POST", body: json({ action }) }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: key(academyId, "chats") });
      void qc.invalidateQueries({ queryKey: key(academyId, "chat", v.phone) });
      void qc.invalidateQueries({ queryKey: key(academyId, "contacts") });
    },
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

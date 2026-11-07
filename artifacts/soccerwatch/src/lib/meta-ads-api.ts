import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Meta ads Replay runs for academies. Hand-written client for routes/metaAds.ts. */

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class AdsApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown> | null) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = data as Record<string, unknown> | null;
    throw new AdsApiError(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`, response.status, body);
  }
  return data as T;
}

export const apiUrl = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;

export type CampaignNumbers = { spend: number | null; impressions: number; reach: number; clicks: number; conversations: number; leads: number; currency: string | null };
export type Funnel = { leads: number; contacted: number; trial: number; joined: number; lost: number };

export type AdminMetaOverview = {
  connected: { token: boolean; adAccount: string | null; appSecret: boolean; graphVersion: string };
  account: { name: string | null; currency: string | null; status: number | null } | null;
  accountError: string | null;
  webhook: { url: string; verifyToken: string | null };
  lastSyncedAt: string | null;
  academies: Array<{ id: number; name: string }>;
  campaigns: Array<{
    id: string; name: string; status: string | null; objective: string | null; startedAt: string | null; academyId: number | null;
    insights: CampaignNumbers | null; insights30d: CampaignNumbers | null; leads: number; unassignedLeads: number; ownAccount: boolean;
  }>;
  leadsWithoutCampaign: number;
  connections: Array<{ academyId: number; academyName: string; mode: "replay" | "own"; status: string; pageName: string | null; adAccountName: string | null; leadsSubscribed: boolean; error: string | null }>;
};

export type MetaPage = { id: string; name: string; subscribed: boolean | null };

export type CampaignAd = { id: string; name: string | null; status: string | null; insights: CampaignNumbers | null; leads: number };

export type AcademyAds = {
  campaigns: Array<{ id: string; name: string; status: string | null; startedAt: string | null; insights: CampaignNumbers | null; insights30d: CampaignNumbers | null; funnel: Funnel; ads?: CampaignAd[] }>;
  otherLeads: Funnel;
  lastSyncedAt: string | null;
  leads: Array<{
    id: number; source: "lead_form" | "whatsapp"; campaignId: string | null; campaignName: string | null; name: string | null;
    phone: string | null; phoneDisplay: string | null; headline: string | null; message: string | null; answers: Record<string, string> | null;
    createdAt: string; contactId: number | null; stage: string | null; kind: string | null;
  }>;
};

export function useAdminMetaAds() {
  return useQuery({ queryKey: ["admin-meta-ads"], queryFn: () => call<AdminMetaOverview>("/admin/meta-ads"), retry: false });
}

export function useAdminMetaPages(enabled: boolean) {
  return useQuery({ queryKey: ["admin-meta-pages"], queryFn: () => call<MetaPage[]>("/admin/meta-ads/pages"), enabled, retry: false });
}

export function useSyncMetaAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<{ campaigns: number; ads: number }>("/admin/meta-ads/sync", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-meta-ads"] }),
  });
}

export function useAssignCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, academyId }: { campaignId: string; academyId: number | null }) =>
      call<{ filed: number }>(`/admin/meta-ads/campaigns/${campaignId}`, { method: "PUT", body: JSON.stringify({ academyId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-meta-ads"] }),
  });
}

export function useSubscribePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => call(`/admin/meta-ads/pages/${pageId}/subscribe`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-meta-pages"] }),
  });
}

export function useAcademyAds(academyId: number) {
  return useQuery({ queryKey: ["academy-ads", academyId], queryFn: () => call<AcademyAds>(`/academy/console/academies/${academyId}/ads`), retry: false });
}

export function formatMoney(amount: number | null | undefined, currency: string | null | undefined, locale: "ar" | "en"): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "–";
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { style: "currency", currency: currency || "JOD", maximumFractionDigits: amount < 100 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

// ─── Academy: connecting Meta and building ads ───────────────────────────────

export type MetaConnection = {
  mode: "replay" | "own";
  status: "pending" | "connected" | "error";
  pageId: string | null;
  pageName: string | null;
  whatsappNumber: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  currency: string | null;
  leadsSubscribed: boolean;
  error: string | null;
  connectedAt: string | null;
};

export type ConnectionInfo = {
  connection: MetaConnection | null;
  replay: { available: boolean; businessId: string };
  own: { appId: string; loginConfigId: string | null; graphVersion: string };
};

export type ShareCheck =
  | { status: "connected"; pageId: string; pageName: string; whatsappNumber: string | null; leadsSubscribed: boolean }
  | { status: "not_shared"; pageId: string | null; pageName: string | null; businessId: string }
  | { status: "invalid" };

export type OwnAssets = {
  adAccounts: Array<{ id: string; name: string; currency: string; status: number }>;
  pages: Array<{ id: string; name: string; whatsappNumber: string | null }>;
  issues: Array<{
    step: "ad_accounts" | "pages";
    reason: "not_shared" | "unavailable";
    referenceCode?: string;
  }>;
};

export type AdGoal = "whatsapp" | "lead_form";
export type AdStatus = "draft" | "pending_approval" | "launching" | "active" | "paused" | "rejected" | "failed";

export type AdVariant = { headline: string; primaryText: string };
export type AdQuestion = { label: string; options?: string[] };
export type AdCard = { mediaId: number; headline?: string | null; description?: string | null };

export type AdRequest = {
  id: number;
  mode: "replay" | "own";
  goal: AdGoal;
  name: string;
  status: AdStatus;
  pausedReason: string | null;
  variants: AdVariant[];
  questions: AdQuestion[];
  cards: AdCard[];
  templateId: number | null;
  metaAds: Array<{ adId: string; variant: number }>;
  dailyBudget: number;
  currency: string;
  startAt: string | null;
  endAt: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
  ageMin: number;
  ageMax: number;
  headline: string;
  primaryText: string;
  locale: "ar" | "en";
  extraQuestion: string | null;
  hasImage: boolean;
  imageData?: string | null;
  metaCampaignId: string | null;
  error: string | null;
  submittedAt: string | null;
  launchedAt: string | null;
  createdAt: string;
};

export type AdRequestBody = {
  goal: AdGoal;
  name: string;
  dailyBudget: number;
  startAt?: string | null;
  endAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  radiusKm: number;
  ageMin: number;
  ageMax: number;
  headline?: string;
  primaryText?: string;
  variants: AdVariant[];
  locale: "ar" | "en";
  imageData?: string | null;
  cards: AdCard[];
  questions?: AdQuestion[];
  extraQuestion?: string | null;
  templateId?: number | null;
};

const adsBase = (academyId: number) => `/academy/console/academies/${academyId}/ads`;

export function useAdsConnection(academyId: number) {
  return useQuery({ queryKey: ["academy-ads-connection", academyId], queryFn: () => call<ConnectionInfo>(`${adsBase(academyId)}/connection`), retry: false });
}

function useInvalidateAds(academyId: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["academy-ads-connection", academyId] });
    void qc.invalidateQueries({ queryKey: ["academy-ads", academyId] });
    void qc.invalidateQueries({ queryKey: ["academy-ad-requests", academyId] });
  };
}

export function useShareCheck(academyId: number) {
  const invalidate = useInvalidateAds(academyId);
  return useMutation({
    mutationFn: (page: string) => call<ShareCheck>(`${adsBase(academyId)}/connection/share`, { method: "POST", body: JSON.stringify({ page }) }),
    onSuccess: invalidate,
  });
}

export function useConnectOwn(academyId: number) {
  const invalidate = useInvalidateAds(academyId);
  return useMutation({
    mutationFn: (code: string) => call<{ assets: OwnAssets; connection: MetaConnection }>(`${adsBase(academyId)}/connection/own`, { method: "POST", body: JSON.stringify({ code }) }),
    onSuccess: invalidate,
  });
}

export function useOwnAssets(academyId: number, enabled: boolean) {
  return useQuery({ queryKey: ["academy-ads-own-assets", academyId], queryFn: () => call<OwnAssets | null>(`${adsBase(academyId)}/connection/own/assets`), enabled, retry: false });
}

export function useSelectOwn(academyId: number) {
  const invalidate = useInvalidateAds(academyId);
  return useMutation({
    mutationFn: (body: { adAccountId: string; pageId: string }) => call(`${adsBase(academyId)}/connection/own`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useDisconnectMeta(academyId: number) {
  const invalidate = useInvalidateAds(academyId);
  return useMutation({ mutationFn: () => call(`${adsBase(academyId)}/connection`, { method: "DELETE" }), onSuccess: invalidate });
}

export function useAdRequests(academyId: number) {
  return useQuery({
    queryKey: ["academy-ad-requests", academyId],
    queryFn: () => call<{ requests: AdRequest[]; defaults: { latitude: number | null; longitude: number | null; academyName: string } }>(`${adsBase(academyId)}/requests`),
    retry: false,
  });
}

export async function fetchAdRequest(academyId: number, id: number) {
  return call<AdRequest>(`${adsBase(academyId)}/requests/${id}`);
}

export function useSaveAdRequest(academyId: number) {
  const invalidate = useInvalidateAds(academyId);
  return useMutation({
    mutationFn: ({ id, body }: { id: number | null; body: AdRequestBody }) =>
      call<AdRequest>(id ? `${adsBase(academyId)}/requests/${id}` : `${adsBase(academyId)}/requests`, { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useAdRequestAction(academyId: number) {
  const invalidate = useInvalidateAds(academyId);
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: "submit" | "pause" | "resume" | "delete" }) =>
      action === "delete"
        ? call(`${adsBase(academyId)}/requests/${id}`, { method: "DELETE" })
        : call<AdRequest>(`${adsBase(academyId)}/requests/${id}/${action}`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

// ─── Admin: approvals ────────────────────────────────────────────────────────

export type AdminAdRequest = AdRequest & {
  academyId: number;
  academyName: string;
  metaDailyBudget: number;
  metaCurrency: string;
  walletBalance: number;
  fundsToStart: number | null;
};

export function useAdminAdRequests() {
  return useQuery({ queryKey: ["admin-ad-requests"], queryFn: () => call<AdminAdRequest[]>("/admin/meta-ads/requests"), retry: false });
}

export function useReviewAdRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approve, reason }: { id: number; approve: boolean; reason?: string }) =>
      call<AdRequest>(`/admin/meta-ads/requests/${id}/${approve ? "approve" : "reject"}`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-ad-requests"] });
      void qc.invalidateQueries({ queryKey: ["admin-meta-ads"] });
    },
  });
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

export type WalletEntry = {
  id: number | null;
  kind: "topup" | "spend" | "adjustment";
  amount: number;
  status: "pending" | "confirmed" | "rejected";
  method: string | null;
  reference: string | null;
  campaignName: string | null;
  note: string | null;
  createdAt: string | null;
  confirmedAt: string | null;
  date?: string | null;
};

export type Wallet = {
  balance: number;
  currency: "JOD";
  dailySpend: number;
  daysLeft: number | null;
  cliqAlias: string;
  minTopup: number;
  minDaily: number;
  daysToStart: number;
  pending: WalletEntry[];
  history: WalletEntry[];
};

export function useWallet(academyId: number, enabled = true) {
  return useQuery({ queryKey: ["academy-ad-wallet", academyId], queryFn: () => call<Wallet>(`${adsBase(academyId)}/wallet`), enabled, retry: false });
}

export function useRequestTopup(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amount: number) => call<WalletEntry & { cliqAlias: string }>(`${adsBase(academyId)}/wallet/topups`, { method: "POST", body: JSON.stringify({ amount }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy-ad-wallet", academyId] }),
  });
}

export function useCancelTopup(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call(`${adsBase(academyId)}/wallet/topups/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy-ad-wallet", academyId] }),
  });
}

export type AdminWallets = {
  margin: number;
  jodPerUsd: number;
  wallets: Array<{ academyId: number; academyName: string; balance: number; toppedUp: number; charged: number; metaCost: number; earned: number }>;
  pending: Array<WalletEntry & { academyId: number; academyName: string }>;
};

export function useAdminWallets() {
  return useQuery({ queryKey: ["admin-ad-wallets"], queryFn: () => call<AdminWallets>("/admin/meta-ads/wallets"), retry: false });
}

export function useAdminWalletAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: { kind: "confirm"; id: number; amount?: number } | { kind: "reject"; id: number; reason?: string } | { kind: "adjust"; academyId: number; amount: number; note: string }) =>
      action.kind === "adjust"
        ? call(`/admin/meta-ads/wallets/${action.academyId}/adjust`, { method: "POST", body: JSON.stringify({ amount: action.amount, note: action.note }) })
        : call(`/admin/meta-ads/wallets/topups/${action.id}/${action.kind}`, {
          method: "POST",
          body: JSON.stringify(action.kind === "confirm" ? (action.amount !== undefined ? { amount: action.amount } : {}) : { reason: action.reason }),
        }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-ad-wallets"] });
      void qc.invalidateQueries({ queryKey: ["admin-ad-requests"] });
    },
  });
}

// ─── Media ───────────────────────────────────────────────────────────────────

export type AdMedia = {
  id: number;
  kind: "image" | "video";
  name: string;
  source: "upload" | "studio_post" | "studio_clip";
  status: "processing" | "ready" | "failed";
  error: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  bytes: number | null;
  thumbUrl: string | null;
  fileUrl: string | null;
  userClipId: number | null;
  createdAt: string;
};

export function useAdMedia(academyId: number) {
  return useQuery({ queryKey: ["academy-ad-media", academyId], queryFn: () => call<AdMedia[]>(`${adsBase(academyId)}/media`), retry: false });
}

export function useUploadAdMedia(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, name, width, height }: { file: File | Blob; name: string; width?: number; height?: number }) => {
      const form = new FormData();
      form.append("name", name);
      if (width) form.append("width", String(width));
      if (height) form.append("height", String(height));
      form.append("file", file, name || "upload");
      return call<AdMedia>(`${adsBase(academyId)}/media`, { method: "POST", body: form });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy-ad-media", academyId] }),
  });
}

export function useDeleteAdMedia(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call(`${adsBase(academyId)}/media/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["academy-ad-media", academyId] }),
  });
}

// ─── Templates ───────────────────────────────────────────────────────────────

export type AdTemplate = {
  id: number;
  key: string | null;
  title: string;
  titleAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  goal: AdGoal;
  variants: Array<AdVariant & { locale: "ar" | "en" }>;
  questions: AdQuestion[];
  dailyBudget: number;
  days: number;
  ageMin: number;
  ageMax: number;
  radiusKm: number;
  imageData: string | null;
  isActive?: boolean;
  sortOrder?: number;
};

export function useAdTemplates(academyId: number) {
  return useQuery({ queryKey: ["academy-ad-templates", academyId], queryFn: () => call<AdTemplate[]>(`${adsBase(academyId)}/templates`), retry: false, staleTime: 5 * 60_000 });
}

export function useAdminTemplates() {
  return useQuery({ queryKey: ["admin-ad-templates"], queryFn: () => call<AdTemplate[]>("/admin/meta-ads/templates"), retry: false });
}

export type TemplateBody = Omit<AdTemplate, "id" | "key">;

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number | null; body: TemplateBody }) =>
      call<AdTemplate>(id ? `/admin/meta-ads/templates/${id}` : "/admin/meta-ads/templates", { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-ad-templates"] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call(`/admin/meta-ads/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-ad-templates"] }),
  });
}

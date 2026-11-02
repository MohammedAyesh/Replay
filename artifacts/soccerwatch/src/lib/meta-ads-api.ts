import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Meta ads Replay runs for academies. Hand-written client for routes/metaAds.ts. */

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

export type CampaignNumbers = { spend: number; impressions: number; reach: number; clicks: number; conversations: number; leads: number; currency: string | null };
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

export type AcademyAds = {
  campaigns: Array<{ id: string; name: string; status: string | null; startedAt: string | null; insights: CampaignNumbers | null; insights30d: CampaignNumbers | null; funnel: Funnel }>;
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
};

export type AdGoal = "whatsapp" | "lead_form";
export type AdStatus = "draft" | "pending_approval" | "launching" | "active" | "paused" | "rejected" | "failed";

export type AdRequest = {
  id: number;
  mode: "replay" | "own";
  goal: AdGoal;
  name: string;
  status: AdStatus;
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
  headline: string;
  primaryText: string;
  locale: "ar" | "en";
  imageData?: string | null;
  extraQuestion?: string | null;
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

export type AdminAdRequest = AdRequest & { academyId: number; academyName: string };

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

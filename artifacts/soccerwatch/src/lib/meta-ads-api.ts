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
    insights: CampaignNumbers | null; insights30d: CampaignNumbers | null; leads: number; unassignedLeads: number;
  }>;
  leadsWithoutCampaign: number;
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

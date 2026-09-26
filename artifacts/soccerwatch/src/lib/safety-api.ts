import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetFeedQueryKey, getGetUserProfileQueryKey } from "@workspace/api-client-react";
import { hiddenClipNoticeText } from "@/i18n/safety-strings";
import type { ReportReason } from "@/i18n/safety-strings";

export { hiddenClipNoticeText };

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
export const safetyApiBase = `${basePath}/api`;

export class SafetyApiError extends Error {
  status: number;
  data: Record<string, unknown> | null;
  constructor(status: number, data: Record<string, unknown> | null) {
    super(typeof data?.error === "string" ? data.error : `Request failed (${status})`);
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
  const response = await fetch(`${safetyApiBase}${path}`, { credentials: "include", ...init, headers });
  let data: unknown = null;
  if (response.status !== 204) {
    try { data = await response.json(); } catch { data = null; }
  }
  if (!response.ok) throw new SafetyApiError(response.status, (data as Record<string, unknown>) ?? null);
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body ?? {});

export type ReportInput = {
  targetType: "user_clip" | "user";
  targetId: number;
  reason: ReportReason;
  note?: string;
};
export type ReportResult = { ok: true; hidden: boolean };
export type BlockedPlayer = { userId: number; name: string; avatarUrl: string | null; blockedAt: string };
export type AdminReport = {
  id: number;
  targetType: "user_clip" | "user";
  targetId: number;
  reason: ReportReason;
  note: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  actionTaken: string | null;
  reporter: { id: number; name: string } | null;
  targetUser: { id: number; name: string; isDisabled: boolean } | null;
  openReportsForTarget: number;
  clip?: {
    title: string;
    visibility: string;
    isHidden: boolean;
    hiddenReason: string | null;
    matchCode: string | null;
    footageRequestId: number | null;
    posterUrl: string | null;
  };
};
export type ResolveAction = "dismiss" | "hide_clip" | "unhide_clip" | "remove_from_clip" | "disable_user";

export const myBlocksQueryKey = ["safety", "my-blocks"] as const;
const invalidateSafetySurface = (qc: ReturnType<typeof useQueryClient>, userId?: number) => {
  void qc.invalidateQueries({ queryKey: getGetFeedQueryKey() });
  void qc.invalidateQueries({ queryKey: ["match-room"] });
  if (userId) {
    void qc.invalidateQueries({ queryKey: getGetUserProfileQueryKey(userId) });
    void qc.invalidateQueries({ queryKey: ["getUserProfile", userId] });
  }
  void qc.invalidateQueries({ queryKey: ["replay-profile"] });
  void qc.invalidateQueries({ queryKey: myBlocksQueryKey });
};

export function useReportContent() {
  return useMutation({
    mutationFn: (body: ReportInput) => call<ReportResult>("/reports", { method: "POST", body: json(body) }),
  });
}

export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => call<{ ok: true }>(`/blocks/${userId}`, { method: "POST", body: "{}" }),
    onSuccess: (_data, userId) => invalidateSafetySurface(qc, userId),
  });
}

export function useUnblockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => call<{ ok: true }>(`/blocks/${userId}`, { method: "DELETE" }),
    onSuccess: (_data, userId) => invalidateSafetySurface(qc, userId),
  });
}

export function useMyBlocks(enabled = true) {
  return useQuery({
    queryKey: myBlocksQueryKey,
    queryFn: () => call<BlockedPlayer[]>("/blocks"),
    enabled,
    staleTime: 30_000,
  });
}

export function useAdminReports(status: "open" | "history", enabled = true) {
  return useQuery({
    queryKey: ["admin-reports", status],
    queryFn: () => call<AdminReport[]>(`/admin/reports/${status}`),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useResolveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: ResolveAction }) =>
      call<{ ok: true }>(`/admin/reports/${id}/resolve`, { method: "POST", body: json({ action }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-reports"] });
      void qc.invalidateQueries({ queryKey: ["match-room"] });
      void qc.invalidateQueries({ queryKey: getGetFeedQueryKey() });
    },
  });
}

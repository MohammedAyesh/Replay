import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "@/lib/academy-studio-api";

/** The monthly value report: client for routes/academyValueReport.ts. */
export type ValueReport = {
  academy: { id: number; name: string; logoUrl: string | null };
  month: string;
  partial: boolean;
  generatedAt: string;
  footage: { matchVideos: number; clipsMade: number; privateClipsSent: number };
  posts: { published: number; reach: number | null };
  messages: { sent: number; read: number };
  families: { total: number; reached: number; opened: number; openedPct: number | null };
  featured: { featured: number; total: number; publicTarget: number; notYet: Array<{ number: number | null }> };
  people: { enquiries: number; trials: number; joined: number; trackedSince: string | null };
  ads: { ran: boolean; spendJod: number | null; joinedFromAds: number; costPerJoinedJod: number | null };
};
export type ReportShare = { id: number; token: string; createdAt: string };

const root = (academyId: number) => `/academy/console/academies/${academyId}/value-report`;
const key = (academyId: number, month: string) => ["academy", academyId, "value-report", month] as const;

export function useValueReport(academyId: number, month: string) {
  return useQuery({
    queryKey: key(academyId, month),
    staleTime: 60_000,
    queryFn: () => call<{ report: ValueReport; share: ReportShare | null }>(`${root(academyId)}?month=${month}`),
  });
}

export function useShareReport(academyId: number, month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<{ share: ReportShare }>(`${root(academyId)}/share`, { method: "POST", body: JSON.stringify({ month }) }).then((r) => r.share),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(academyId, month) }),
  });
}

export function useRevokeShare(academyId: number, month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: number) => call<{ ok: true }>(`${root(academyId)}/share/${shareId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(academyId, month) }),
  });
}

export function useSharedReport(token: string) {
  return useQuery({
    queryKey: ["value-report-share", token],
    retry: false,
    queryFn: () => call<{ report: ValueReport }>(`/vr/${token}`).then((r) => r.report),
  });
}

/** "2026-11" → the last `count` months, newest first. */
export function recentMonths(current: string, count = 12): string[] {
  const out: string[] = [];
  let [y, m] = current.split("-").map(Number);
  for (let i = 0; i < count; i += 1) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export function currentAmmanMonth(now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit" }).formatToParts(now);
  const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${v.year}-${v.month}`;
}

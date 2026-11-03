import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiUrl, call } from "@/lib/academy-studio-api";

/** Like `call`, but the error keeps the API's `code` ("no_video", "whatsapp_off", …) for the message to show. */
async function callCoded<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw Object.assign(new Error(body?.error ?? `Request failed (${response.status})`), { code: body?.code ?? "generic", status: response.status });
  }
  return (await response.json()) as T;
}

/** Trial sessions (routes/academyTrials.ts) and the weekly content calendar (routes/academyCreativeForYou.ts). */
export type TrialView = {
  contactId: number;
  name: string | null;
  phone: string;
  display?: string;
  stage: string | null;
  session: { id: number; startsAt: string; endsAt: string | null; type: string; hasVideo: boolean } | null;
  dueBy: string | null;
  clip: {
    id: number;
    childName: string | null;
    momentSeconds: number;
    status: "prepared" | "sent" | "failed";
    exportStatus: string | null;
    url: string;
    sentAt: string | null;
    openedAt: string | null;
    followUpStatus: "pending" | "sent" | "skipped" | null;
    followUpAt: string | null;
  } | null;
};

const root = (academyId: number) => `/academy/console/academies/${academyId}`;
const trialsKey = (academyId: number) => ["academy", academyId, "trials"] as const;

export function useTrials(academyId: number) {
  return useQuery({
    queryKey: trialsKey(academyId),
    staleTime: 15_000,
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => t.clip && t.clip.status === "prepared" && t.clip.exportStatus !== "done") ? 10_000 : false),
    queryFn: () => call<{ trials: TrialView[] }>(`${root(academyId)}/trials`).then((r) => r.trials),
  });
}

export function useSetTrialSession(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { contactId: number; sessionId: number | null }) =>
      callCoded<{ trials: TrialView[] }>(`${root(academyId)}/contacts/${v.contactId}/trial`, { method: "PUT", body: JSON.stringify({ sessionId: v.sessionId }) }),
    onSuccess: (r) => {
      qc.setQueryData(trialsKey(academyId), r.trials);
      void qc.invalidateQueries({ queryKey: ["academy-whatsapp", academyId] });
    },
  });
}

export function useMakeTrialClip(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { contactId: number; momentSeconds: number; childName: string | null }) =>
      callCoded<{ clipId: number; trials: TrialView[] }>(`${root(academyId)}/contacts/${v.contactId}/trial-clip`, { method: "POST", body: JSON.stringify({ momentSeconds: v.momentSeconds, childName: v.childName }) }),
    onSuccess: (r) => qc.setQueryData(trialsKey(academyId), r.trials),
  });
}

export function useSendTrialClip(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clipId: number) => callCoded<{ queued: number; trials: TrialView[] }>(`${root(academyId)}/trial-clips/${clipId}/send`, { method: "POST" }),
    onSuccess: (r) => qc.setQueryData(trialsKey(academyId), r.trials),
  });
}

/** "12:30" → 750; "1:02:03" → 3723; anything else → null. */
export function parseMoment(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  const [h, m, s] = nums.length === 3 ? nums : [0, nums[0], nums[1]];
  if (s >= 60 || (nums.length === 3 && m >= 60)) return null;
  return h * 3600 + m * 60 + s;
}

export function formatMoment(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

// ── Content calendar ─────────────────────────────────────────────────────────

export const CALENDAR_KINDS = ["matchday", "fulltime", "player", "training", "weekly"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export type CalendarSlot = { day: number; kind: CalendarKind };

const calendarKey = (academyId: number) => ["academy", academyId, "content-calendar"] as const;

export function useContentCalendar(academyId: number) {
  return useQuery({
    queryKey: calendarKey(academyId),
    staleTime: 60_000,
    queryFn: () => call<{ slots: CalendarSlot[]; isDefault: boolean }>(`${root(academyId)}/creative/content-calendar`),
  });
}

export function useSaveContentCalendar(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slots: CalendarSlot[] | null) =>
      call<{ slots: CalendarSlot[]; isDefault: boolean }>(`${root(academyId)}/creative/content-calendar`, { method: "PUT", body: JSON.stringify({ slots }) }),
    onSuccess: (r) => qc.setQueryData(calendarKey(academyId), r),
  });
}

/** Which auto-draft kinds fill which calendar slot. */
export const SLOT_DRAFT_KINDS: Record<CalendarKind, string[]> = {
  matchday: ["matchday", "countdown", "callup"],
  fulltime: ["fulltime", "cleansheet", "matchstats", "goal", "goalduo", "phoneafter"],
  player: ["potm", "weekmoment", "improved", "firstgoal", "streak", "meet"],
  training: ["phonebefore", "weekmoment", "meet"],
  weekly: ["weekly"],
};

export type PlannedDay<D> = { date: string; day: number; slots: Array<{ kind: CalendarKind; draft: D | null }> };

/**
 * The next seven days (from today, Amman), each with its slots filled from the
 * drafts: a slot takes the first draft of its kinds not already used, in the
 * feed's order (newest first), so one draft never fills two days. A matchday
 * slot prefers the draft for the next match on or after that day.
 */
export function planWeek<D extends { id: number; kind: string; startsAt: string | null }>(slots: CalendarSlot[], drafts: D[], today: string): PlannedDay<D>[] {
  const used = new Set<number>();
  const [y, m, d] = today.split("-").map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1, d + i));
    const iso = date.toISOString().slice(0, 10);
    const day = date.getUTCDay();
    return {
      date: iso,
      day,
      slots: slots.filter((s) => s.day === day).map((s) => {
        const kinds = SLOT_DRAFT_KINDS[s.kind];
        let pool = drafts.filter((x) => kinds.includes(x.kind) && !used.has(x.id));
        if (s.kind === "matchday") {
          const ahead = pool.filter((x) => x.startsAt && x.startsAt.slice(0, 10) >= iso).sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));
          pool = ahead.length ? ahead : [];
        }
        const draft = pool[0] ?? null;
        if (draft) used.add(draft.id);
        return { kind: s.kind, draft };
      }),
    };
  });
}

export function ammanToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

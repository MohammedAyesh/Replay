import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListOwnerVarMarksQueryKey,
  useCreateOwnerVarMark,
  useDeleteOwnerVarMark,
  useListOwnerVarMarks,
  type VarMark,
  type VarMarkKind,
} from "@workspace/api-client-react";
import { VarPlayer, formatVarWallClock } from "@/components/var-player/VarPlayer";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "@/i18n";

type VarStatus = {
  fieldName: string;
  startLocal: string;
  endLocal: string;
  varActive: boolean;
  varState: string | null;
  live: boolean;
  newestAgeSec: number | null;
};

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const kinds: Array<{ value: VarMarkKind; en: string; ar: string; color: string }> = [
  { value: "goal", en: "Goal", ar: "هدف", color: "border-emerald-300/40 bg-emerald-400/15 text-emerald-100" },
  { value: "foul", en: "Foul", ar: "خطأ", color: "border-amber-300/40 bg-amber-400/15 text-amber-100" },
  { value: "offside", en: "Offside", ar: "تسلل", color: "border-sky-300/40 bg-sky-400/15 text-sky-100" },
  { value: "other", en: "Other", ar: "أخرى", color: "border-violet-300/40 bg-violet-400/15 text-violet-100" },
];

function localStartUtcMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) - 3 * 60 * 60 * 1000;
}

function useVarStatus(requestId: number, enabled: boolean) {
  const [status, setStatus] = useState<VarStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${basePath}/api/owner/requests/${requestId}/var/status`, { credentials: "include" });
      if (!response.ok) throw new Error("status");
      setStatus((await response.json()) as VarStatus);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [requestId]);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [enabled, load]);
  return { status, error, loading, refresh: load };
}

export default function OwnerVar() {
  const [, params] = useRoute("/owner/var/:requestId");
  const [, setLocation] = useLocation();
  const { locale } = useTranslation();
  const { isSignedIn, isGuest, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const requestId = Number(params?.requestId ?? 0);
  const isArabic = locale === "ar";
  const copy = isArabic
    ? {
        back: "العودة إلى لقطاتي",
        loading: "جاري تحميل VAR…",
        unavailable: "تعذر تحميل VAR الآن.",
        closed: "انتهت مراجعة VAR",
        closedDesc: "يمكنك العثور على اللقطات المحفوظة في لقطاتي.",
        error: "تعذر الاتصال بخدمة VAR.",
        retry: "إعادة المحاولة",
        markMoment: "ضع علامة على هذه اللحظة",
        currentFrame: "الوقت الحالي",
        note: "ملاحظة اختيارية",
        notePlaceholder: "أضف سياقًا قصيرًا…",
        saving: "جاري الحفظ…",
        marked: "اللحظات المحددة",
        delete: "حذف",
        noMarks: "لم تحدد أي لحظات بعد.",
        matchOver: "انتهت المباراة",
        matchOverDesc: "تم إغلاق نافذة VAR. يمكنك مراجعة لقطاتك المحفوظة.",
        openFootage: "فتح لقطاتي",
      }
    : {
        back: "Back to My footage",
        loading: "Loading VAR…",
        unavailable: "VAR is unavailable right now.",
        closed: "VAR review has ended",
        closedDesc: "You can find saved footage in My footage.",
        error: "VAR service could not be reached.",
        retry: "Retry",
        markMoment: "Mark this moment",
        currentFrame: "Current frame",
        note: "Optional note",
        notePlaceholder: "Add a short note…",
        saving: "Saving…",
        marked: "Marked moments",
        delete: "Delete",
        noMarks: "No moments marked yet.",
        matchOver: "Match over",
        matchOverDesc: "The VAR window is closed. Review your saved footage in My footage.",
        openFootage: "Open My footage",
      };

  const statusState = useVarStatus(requestId, isSignedIn && !isGuest && requestId > 0);
  const marksQuery = useListOwnerVarMarks(requestId, {
    query: {
      enabled: isSignedIn && !isGuest && requestId > 0,
      queryKey: getListOwnerVarMarksQueryKey(requestId),
      refetchInterval: 15_000,
    },
  });
  const createMark = useCreateOwnerVarMark();
  const deleteMark = useDeleteOwnerVarMark();
  const [currentFrameMs, setCurrentFrameMs] = useState<number | null>(null);
  const [selectedMomentMs, setSelectedMomentMs] = useState<number | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!authLoading && !isSignedIn) setLocation("/sign-in");
  }, [authLoading, isSignedIn, setLocation]);

  const marks = marksQuery.data ?? [];
  const markTicks = useMemo(
    () => marks.map((mark) => ({ atUtcMs: Date.parse(mark.atUtc), kind: mark.kind })),
    [marks],
  );
  const requestStartUtcMs = statusState.status ? localStartUtcMs(statusState.status.startLocal) : null;
  const minStartUtcMs = requestStartUtcMs == null ? undefined : requestStartUtcMs - 3 * 60 * 1000;
  const open = statusState.status?.varActive === true;
  const matchOver = Boolean(statusState.status && !open && statusState.status.varState !== "unsupported" && statusState.status.varState !== "ftp-failed");

  const markMoment = (kind: VarMarkKind) => {
    if (currentFrameMs == null || createMark.isPending) return;
    void createMark.mutateAsync({
      id: requestId,
      data: { atUtc: new Date(currentFrameMs).toISOString(), kind, note: note.trim() || null },
    }).then(() => {
      setNote("");
      setSelectedMomentMs(currentFrameMs);
      void queryClient.invalidateQueries({ queryKey: getListOwnerVarMarksQueryKey(requestId) });
    });
  };

  const onCurrentTimeChange = useCallback((value: number | null) => {
    setCurrentFrameMs(value);
  }, []);

  if (authLoading || statusState.loading) {
    return <main className="flex min-h-[100dvh] flex-1 items-center justify-center bg-[#0B0F1A] px-6 text-sm text-muted-foreground">{copy.loading}</main>;
  }

  return (
    <main dir={isArabic ? "rtl" : "ltr"} className="flex min-h-[100dvh] flex-1 flex-col overflow-y-auto bg-[#0B0F1A] text-foreground">
      <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-4">
        <button type="button" onClick={() => setLocation("/owner?tab=footage")} aria-label={copy.back} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05]">
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
        </button>
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-red-300">VAR</p>
          <h1 className="truncate text-lg font-bold">{statusState.status?.fieldName ?? "VAR"}</h1>
        </div>
      </header>

      {statusState.error ? (
        <section className="m-4 rounded-2xl border border-red-300/30 bg-red-500/10 p-4 text-sm">
          <div className="flex items-start gap-2"><CircleAlert className="mt-0.5 h-4 w-4 text-red-300" /><p className="flex-1">{copy.error}</p><button type="button" onClick={() => void statusState.refresh()} className="text-xs font-bold underline">{copy.retry}</button></div>
        </section>
      ) : matchOver ? (
        <section className="m-4 rounded-2xl border border-white/10 bg-white/[0.05] p-4">
          <p className="font-bold">{copy.matchOver}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.matchOverDesc}</p>
          <button type="button" onClick={() => setLocation("/owner?tab=footage")} className="mt-3 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground">{copy.openFootage}</button>
        </section>
      ) : !open ? (
        <section className="m-4 rounded-2xl border border-red-300/30 bg-red-500/10 p-4 text-sm">
          <p className="font-bold">{copy.closed}</p><p className="mt-1 text-xs text-red-100/70">{copy.closedDesc}</p>
        </section>
      ) : null}

      {open && (
        <div className="p-3 sm:p-5">
          <VarPlayer
            src={`${basePath}/api/owner/requests/${requestId}/var/hls/playlist.m3u8`}
            title={statusState.status?.fieldName ?? "VAR"}
            marks={markTicks}
            minStartUtcMs={minStartUtcMs}
            onCurrentTimeChange={onCurrentTimeChange}
            onMark={setCurrentFrameMs}
            seekToUtcMs={selectedMomentMs}
          />
        </div>
      )}

      <section className="mx-3 mb-4 rounded-2xl border border-white/[0.08] bg-[#141B2C] p-4">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-sm font-bold">{copy.markMoment}</h2><p className="mt-1 font-mono text-lg text-primary">{currentFrameMs == null ? "—" : formatVarWallClock(currentFrameMs).slice(0, 8)}</p></div>
          {createMark.isPending && <LoaderCircle className="h-4 w-4 animate-spin text-primary" />}
        </div>
        <label className="mt-3 block text-xs text-muted-foreground">{copy.note}<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={copy.notePlaceholder} className="mt-1 min-h-16 w-full resize-none rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-foreground outline-none focus:border-primary" /></label>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {kinds.map((kind) => <button key={kind.value} type="button" disabled={!open || currentFrameMs == null || createMark.isPending} onClick={() => markMoment(kind.value)} className={`min-h-11 rounded-xl border text-xs font-bold transition-opacity disabled:opacity-40 ${kind.color}`}>{isArabic ? kind.ar : kind.en}</button>)}
        </div>
      </section>

      <section className="mx-3 mb-8 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <h2 className="text-sm font-bold">{copy.marked}</h2>
        <div className="mt-3 space-y-2">
          {marks.length === 0 ? <p className="text-xs text-muted-foreground">{copy.noMarks}</p> : marks.map((mark) => (
            <div key={mark.id} className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-black/15 p-2.5">
              <button type="button" onClick={() => setSelectedMomentMs(Date.parse(mark.atUtc))} className="min-w-0 flex-1 text-start">
                <span className="block text-xs font-bold capitalize">{isArabic ? kinds.find((kind) => kind.value === mark.kind)?.ar : mark.kind}</span>
                <span className="font-mono text-[11px] text-primary">{formatVarWallClock(Date.parse(mark.atUtc)).slice(0, 8)}</span>
                {mark.note && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{mark.note}</span>}
              </button>
              <button type="button" onClick={() => void deleteMark.mutateAsync({ markId: mark.id }).then(() => void queryClient.invalidateQueries({ queryKey: getListOwnerVarMarksQueryKey(requestId) }))} disabled={deleteMark.isPending} aria-label={copy.delete} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.08] hover:text-red-300"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
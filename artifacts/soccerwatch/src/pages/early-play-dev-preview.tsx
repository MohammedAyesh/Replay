import { useSearch } from "wouter";
import { EarlyPlay } from "@/components/match/EarlyPlay";

export default function EarlyPlayDevPreview() {
  const params = new URLSearchParams(useSearch());
  const state = params.get("state") ?? "early";
  const locale = params.get("lang") === "ar" ? "ar" : "en";
  const previewOpen = params.get("open") === "1";
  const previewState = state === "unsupported" || state === "notAvailable" ? state : "early";
  return (
    <main dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-screen bg-void px-4 py-8 text-text">
      <div className="mx-auto max-w-xl">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-turf">Replay · Early play preview</p>
        <h1 className="font-display text-2xl font-bold">{locale === "ar" ? "التسجيل قيد المعالجة" : "Match processing"}</h1>
        <p className="mt-2 text-sm text-muted-text">{locale === "ar" ? "نسخة تجريبية لحالات التشغيل المبكر." : "Preview fixture for early-play states."}</p>
        <EarlyPlay code="PREVIEW" locale={locale} previewState={previewState} previewOpen={previewOpen} />
      </div>
    </main>
  );
}

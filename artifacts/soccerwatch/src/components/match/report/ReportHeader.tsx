import { ArrowLeft, Share2 } from "lucide-react";
import { useLocation } from "wouter";
import { usePageBack } from "@/lib/use-page-back";
import type { MatchStrings } from "@/i18n/match-strings";
import type { ReportStrings } from "@/i18n/report-strings";

type Copy = MatchStrings & { locale: "en" | "ar" };
type R = ReportStrings & { locale: "en" | "ar" };

export function ReportHeader({ copy, r, onShare }: { copy: Copy; r: R; onShare: () => void }) {
  const [, setLocation] = useLocation();
  const pageBack = usePageBack();
  return (
    <div className="flex items-center justify-between gap-2 pt-3">
      <button
        type="button"
        onClick={pageBack}
        aria-label={copy.back}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-line"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
      </button>
      <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:tracking-normal rtl:text-xs">{r.eyebrow}</span>
      <button type="button" onClick={onShare} aria-label={copy.share} className="flex h-11 w-11 items-center justify-center rounded-full border border-line">
        <Share2 className="h-4 w-4" />
      </button>
    </div>
  );
}

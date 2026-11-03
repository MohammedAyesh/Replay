import { useEffect } from "react";
import { useParams } from "wouter";
import { Download, Loader2 } from "lucide-react";
import { ValueReportView } from "@/components/academy-console/value-report";
import { useValueReportCopy } from "@/i18n/value-report-strings";
import { useLocale } from "@/i18n/context";
import { useSharedReport } from "@/lib/value-report-api";

/**
 * /vr/:token — an academy's monthly value report, shared by link. Counts only:
 * no child is named or numbered. The owner can turn the link off at any time.
 */
export default function ValueReportPage() {
  const { token = "" } = useParams<{ token: string }>();
  const c = useValueReportCopy();
  const { setLocale } = useLocale();
  const q = useSharedReport(token);
  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"]');
    if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "robots"); document.head.appendChild(meta); }
    meta.setAttribute("content", "noindex");
  }, []);
  return (
    <main className="mx-auto min-h-dvh max-w-4xl bg-void px-4 py-6 text-text print:bg-white print:px-0" dir={c.locale === "ar" ? "rtl" : "ltr"} data-testid="value-report-page">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <span className="text-xs font-bold tracking-[0.28em] text-floodlight">REPLAY</span>
        <div className="flex items-center gap-1">
          {q.data ? <button type="button" onClick={() => window.print()} className="me-2 inline-flex items-center gap-1 rounded-full bg-raised px-3 py-1 text-xs font-semibold text-text" data-testid="vr-page-download"><Download className="h-3.5 w-3.5" />{c.download}</button> : null}
          {(["ar", "en"] as const).map((l) => (
            <button key={l} type="button" onClick={() => setLocale(l)} className={`rounded-full px-3 py-1 text-xs font-semibold ${c.locale === l ? "bg-floodlight text-void" : "bg-raised text-muted-text"}`}>
              {l === "ar" ? "العربية" : "English"}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? <div className="grid h-64 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-text" /></div>
        : q.isError || !q.data ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-text" data-testid="value-report-missing">{c.notFound}</p>
        : <ValueReportView report={q.data} shared />}
    </main>
  );
}

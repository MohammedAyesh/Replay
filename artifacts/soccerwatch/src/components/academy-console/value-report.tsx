import { useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, Link2, Loader2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatReportDate, useValueReportCopy } from "@/i18n/value-report-strings";
import { currentAmmanMonth, recentMonths, useRevokeShare, useShareReport, useValueReport, type ValueReport } from "@/lib/value-report-api";

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);

function Tile({ label, value, sub, testId, wide }: { label: string; value: string; sub?: ReactNode; testId: string; wide?: boolean }) {
  return (
    <div className={`break-inside-avoid rounded-2xl border border-line bg-surface p-5 print:border-[#ccc] print:bg-white ${wide ? "sm:col-span-2" : ""}`} data-testid={testId}>
      <p className="text-sm font-semibold text-muted-text print:text-[#555]">{label}</p>
      <p className="mt-4 font-display text-4xl font-bold tabular-nums text-text print:text-black"><bdi>{value}</bdi></p>
      {sub ? <p className="mt-2 text-xs leading-5 text-muted-text print:text-[#555]">{sub}</p> : null}
    </div>
  );
}

/** The report itself: the same in the console, on the shared page and on paper. */
export function ValueReportView({ report, shared = false }: { report: ValueReport; shared?: boolean }) {
  const c = useValueReportCopy();
  const dir = c.locale === "ar" ? "rtl" : "ltr";
  const { featured, families, people, ads } = report;
  const monthStart = `${report.month}-01T00:00:00+03:00`;
  const peopleSince = people.trackedSince && people.trackedSince > new Date(monthStart).toISOString() ? c.people.since(formatReportDate(people.trackedSince, c.locale)) : null;
  const notYet = featured.notYet.map((p) => (p.number === null ? "—" : `#${p.number}`)).join(", ");
  const featuredSub = featured.total && featured.featured === featured.total ? c.featured.all
    : notYet ? <>{c.featured.notYet("")}<bdi dir="ltr">{notYet}</bdi></> : null;
  return (
    <article dir={dir} className="space-y-5 print:text-black" data-testid="value-report">
      <header className="flex items-center gap-4">
        {report.academy.logoUrl ? <img src={report.academy.logoUrl} alt="" className="h-14 w-14 rounded-2xl object-contain" /> : null}
        <div className="min-w-0">
          {report.partial || shared ? <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf print:text-black">{report.partial ? c.soFar : c.title}</p> : null}
          <h2 className="mt-1 font-display text-3xl font-bold text-text print:text-black" data-testid="value-report-heading">{shared ? c.sharedTitle(report.academy.name, c.month(report.month)) : c.month(report.month)}</h2>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile testId="vr-videos" label={c.footage.videos} value={fmt(report.footage.matchVideos)} />
        <Tile testId="vr-clips" label={c.footage.clips} value={fmt(report.footage.clipsMade)} sub={report.footage.privateClipsSent ? c.footage.privateSent(report.footage.privateClipsSent) : null} />
        <Tile testId="vr-posts" label={c.posts.title} value={fmt(report.posts.published)} sub={report.posts.reach ? c.posts.reach(report.posts.reach) : null} />
        <Tile testId="vr-messages" label={c.messages.title} value={fmt(report.messages.sent)} sub={report.messages.sent ? c.messages.read(report.messages.read) : null} />
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Tile testId="vr-families" label={c.families.title} value={families.openedPct === null ? "—" : `${families.openedPct}%`}
          sub={families.total ? c.families.of(families.opened, families.total) : c.families.none} />
        <Tile testId="vr-featured" label={c.featured.title} value={c.featured.of(featured.featured, featured.total)}
          sub={<>{c.featured.target(featured.publicTarget)}{featuredSub ? <> · {featuredSub}</> : null}</>} />
      </section>

      <section className="break-inside-avoid rounded-2xl border border-line bg-surface p-5 print:border-[#ccc] print:bg-white" data-testid="vr-people">
        <p className="text-sm font-semibold text-muted-text print:text-[#555]">{c.people.title}</p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {([[c.people.enquiries, people.enquiries], [c.people.trials, people.trials], [c.people.joined, people.joined]] as const).map(([label, v], i) => (
            <div key={label} className={i ? "border-s border-line ps-3 print:border-[#ccc]" : ""}>
              <p className="font-display text-3xl font-bold tabular-nums text-text print:text-black">{fmt(v)}</p>
              <p className="mt-1 text-xs text-muted-text print:text-[#555]">{label}</p>
            </div>
          ))}
        </div>
        {peopleSince ? <p className="mt-3 text-xs text-muted-text print:text-[#555]">{peopleSince}</p> : null}
      </section>

      <section className="break-inside-avoid rounded-2xl border border-line bg-surface p-5 print:border-[#ccc] print:bg-white" data-testid="vr-ads">
        <p className="text-sm font-semibold text-muted-text print:text-[#555]">{c.ads.title}</p>
        {ads.ran && ads.spendJod !== null ? (
          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <p className="font-display text-3xl font-bold text-text print:text-black"><bdi>{ads.costPerJoinedJod !== null ? c.ads.cost(ads.costPerJoinedJod) : c.ads.noJoin}</bdi></p>
            <p className="text-sm text-muted-text print:text-[#555]"><bdi>{c.ads.spend(ads.spendJod)}</bdi></p>
          </div>
        ) : <p className="mt-3 text-sm text-muted-text print:text-[#555]">{c.ads.none}</p>}
      </section>

      <footer className="text-xs text-muted-text print:text-[#555]">{c.footer(formatReportDate(report.generatedAt, c.locale))}</footer>
    </article>
  );
}

/** The console section: pick a month, share it by link, print it. Owner only. */
export function AcademyValueReportSection({ academyId }: { academyId: number }) {
  const c = useValueReportCopy();
  const current = currentAmmanMonth();
  const months = recentMonths(current, 12);
  const [month, setMonth] = useState(current);
  const q = useValueReport(academyId, month);
  const share = useShareReport(academyId, month);
  const revoke = useRevokeShare(academyId, month);
  const [copied, setCopied] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const link = q.data?.share ? `${origin}${basePath}/vr/${q.data.share.token}` : null;
  const idx = months.indexOf(month);
  const rtl = c.locale === "ar";
  const Prev = rtl ? ChevronRight : ChevronLeft;
  const Next = rtl ? ChevronLeft : ChevronRight;

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the link is on screen to copy by hand */ }
  };

  return (
    <div className="space-y-6" data-testid="academy-value-report-section">
      <div className="print:hidden">
        <h1 className="font-display text-3xl font-bold text-text">{c.title}</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-text">{c.subtitle}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1">
          <Button type="button" variant="ghost" size="icon" disabled={idx >= months.length - 1} onClick={() => setMonth(months[idx + 1])} aria-label="previous month" data-testid="vr-prev"><Prev className="h-4 w-4" /></Button>
          <select aria-label={c.pick} value={month} onChange={(e) => setMonth(e.target.value)} className="bg-transparent px-1 text-sm font-semibold text-text" data-testid="vr-month">
            {months.map((m) => <option key={m} value={m}>{c.month(m)}</option>)}
          </select>
          <Button type="button" variant="ghost" size="icon" disabled={idx <= 0} onClick={() => setMonth(months[idx - 1])} aria-label="next month" data-testid="vr-next"><Next className="h-4 w-4" /></Button>
        </div>
        {link ? (
          <>
            <Button type="button" variant="outline" onClick={copy} data-testid="vr-copy">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? c.copied : c.copy}</Button>
            <Button type="button" variant="ghost" disabled={revoke.isPending} onClick={() => q.data?.share && revoke.mutate(q.data.share.id)} data-testid="vr-turn-off"><Unlink className="h-4 w-4" />{c.turnOff}</Button>
          </>
        ) : (
          <Button type="button" variant="outline" disabled={share.isPending || !q.data} onClick={() => share.mutate()} data-testid="vr-share">{share.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}{c.share}</Button>
        )}
        <Button type="button" onClick={() => window.print()} disabled={!q.data} data-testid="vr-download"><Download className="h-4 w-4" />{c.download}</Button>
      </div>
      {link ? <p className="text-xs text-muted-text print:hidden" data-testid="vr-link"><bdi dir="ltr" className="select-all text-text">{link}</bdi> · {c.shareNote}</p> : null}
      {q.isLoading ? <p className="flex items-center gap-2 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{c.loading}</p>
        : q.isError || !q.data ? <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted-text">{c.error}</p>
        : <ValueReportView report={q.data.report} />}
    </div>
  );
}

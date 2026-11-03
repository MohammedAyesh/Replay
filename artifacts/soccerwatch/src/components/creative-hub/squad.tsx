import { useMemo, useState } from "react";
import { AlertTriangle, Lock, VideoOff } from "lucide-react";
import { Link } from "wouter";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { useFeaturedCopy } from "@/i18n/featured-strings";
import { useSaveTargets, useSquadGrid, type GridCell, type SquadGrid } from "@/lib/academy-featured-api";
import { cn } from "@/lib/utils";

/** "2026-11" for now and the five months before it, newest first. */
function recentMonths(now = new Date(), n = 6): string[] {
  const out: string[] = [];
  const amman = new Date(now.getTime() + 3 * 3600_000);
  let y = amman.getUTCFullYear();
  let m = amman.getUTCMonth() + 1;
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

const monthLabel = (month: string, locale: "ar" | "en") => {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
};

const TONE: Record<GridCell["status"], string> = {
  green: "border-emerald-400/60 bg-emerald-500/15",
  amber: "border-amber-400/60 bg-amber-500/15",
  red: "border-red-400/60 bg-red-500/15",
};
// Explicit colours: the app's stylesheet mutes the stock amber/red utilities on purpose.
const DOT: Record<GridCell["status"], string> = { green: "bg-[#34d399]", amber: "bg-[#f5b83d]", red: "bg-[#ff5a3c]" };

/**
 * Creative hub → Squad: every child, one square per shirt number, and whether
 * he has appeared this month (green), not yet this month (amber) or never
 * (red); the summary line; children the analysis has no footage of, linked to
 * the match's "Who's who" step; and the owner's targets.
 */
export function CreativeSquad({ academyId }: { academyId: number }) {
  const copy = useFeaturedCopy();
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState<string>(months[0]);
  const [squadId, setSquadId] = useState<number | null>(null);
  const grid = useSquadGrid(academyId, month === months[0] ? null : month, squadId);
  const t = copy.squad;

  return (
    <div className="space-y-5" data-testid="creative-squad">
      <header className="space-y-1">
        <h2 className="font-display text-2xl font-bold text-text">{t.title}</h2>
        <p className="max-w-2xl text-sm text-muted-text">{t.intro}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted-text">
          {t.month}
          <select value={month} onChange={(e) => setMonth(e.target.value)} data-testid="squad-month"
            className="min-h-9 rounded-full border border-line bg-surface px-3 text-sm text-text">
            {months.map((m) => <option key={m} value={m}>{monthLabel(m, copy.locale)}</option>)}
          </select>
        </label>
        {(grid.data?.squads.length ?? 0) > 1 && (
          <select value={squadId ?? ""} onChange={(e) => setSquadId(e.target.value ? Number(e.target.value) : null)} data-testid="squad-filter"
            className="min-h-9 rounded-full border border-line bg-surface px-3 text-sm text-text">
            <option value="">{t.squadAll}</option>
            {grid.data!.squads.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <div className="ms-auto flex items-center gap-3 text-xs text-muted-text">
          {(["green", "amber", "red"] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5"><span className={cn("h-2.5 w-2.5 rounded-full", DOT[s])} />{t.legend[s]}</span>
          ))}
        </div>
      </div>

      {grid.isLoading ? <div className="h-64 animate-pulse rounded-2xl bg-raised" />
        : grid.isError || !grid.data ? <p className="text-sm text-red-400" role="alert">{(grid.error as Error | null)?.message}</p>
        : <GridBody academyId={academyId} data={grid.data} />}
    </div>
  );
}

function GridBody({ academyId, data }: { academyId: number; data: SquadGrid }) {
  const copy = useFeaturedCopy();
  const t = copy.squad;
  if (!data.cells.length) return <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted-text">{t.empty}</p>;
  const label = (p: { number: number | null; name: string }) => (p.number !== null ? `#${p.number}` : p.name.split(/\s+/)[0]);
  return (
    <div className="space-y-5">
      <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm font-semibold text-text" data-testid="squad-summary">
        {t.summary(data.summary.featured, data.summary.total)}{" "}
        {data.summary.notYet.length
          ? <span className="text-muted-text">{t.notYet} <bdi dir="ltr">{data.summary.notYet.map(label).join(", ")}</bdi></span>
          : <span className="text-emerald-300">{t.allDone}</span>}
      </p>

      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8" data-testid="squad-grid">
        {data.cells.map((c) => (
          <li key={c.playerId} className={cn("flex min-h-28 flex-col rounded-2xl border p-2.5", TONE[c.status])} data-testid={`squad-cell-${c.number ?? c.playerId}`} data-status={c.status}>
            <div className="flex items-start justify-between gap-1">
              <span className="font-display text-2xl font-bold leading-none text-text tabular-nums" dir="ltr">{c.number !== null ? `#${c.number}` : "–"}</span>
              {c.mode === "private_only" && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-text" aria-label={t.privateOnly} />}
            </div>
            <span className="mt-1 truncate text-xs font-semibold text-text"><bdi>{c.name.split(/\s+/)[0]}</bdi></span>
            <span className="mt-auto text-[11px] leading-4 text-muted-text">
              {c.daysSince === null ? t.never : t.daysAgo(c.daysSince)}
            </span>
            {c.mode === "private_only" && <span className="text-[11px] font-semibold leading-4 text-muted-text">{t.privateOnly}</span>}
            {c.status !== "green" && c.missing.length > 0 && c.daysSince !== null && (
              <span className="text-[11px] leading-4 text-[#f5c86a]">{t.missing[c.missing[0]]}</span>
            )}
          </li>
        ))}
      </ul>

      {data.gaps.length > 0 && (
        <section className="rounded-2xl border border-line bg-surface p-4" data-testid="squad-gaps">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-text"><VideoOff className="h-4 w-4 text-amber-300" aria-hidden />{t.gapsTitle}</h3>
          <ul className="divide-y divide-line">
            {data.gaps.map((g) => (
              <li key={g.playerId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="flex items-center gap-2 text-text"><AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden />{t.gap(label(g), g.matches)}</span>
                <Link href={`/academy/matches?match=${g.latestSessionId}&step=who`} className="font-semibold text-turf hover:underline" data-testid={`squad-gap-fix-${g.playerId}`}>{t.fixWho}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Targets academyId={academyId} data={data} />
    </div>
  );
}

function Targets({ academyId, data }: { academyId: number; data: SquadGrid }) {
  const copy = useFeaturedCopy();
  const t = copy.squad;
  const save = useSaveTargets(academyId);
  const [perMonth, setPerMonth] = useState(data.targets.publicPostsPerMonth);
  const commit = (patch: Parameters<typeof save.mutate>[0]) =>
    save.mutate(patch, { onSuccess: () => toast({ description: t.saved }), onError: (e) => toast({ description: (e as Error).message, variant: "destructive" }) });
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-4" data-testid="squad-targets">
      <h3 className="text-sm font-bold text-text">{t.targets}</h3>
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm text-text">
        <span>{t.perMonth}</span>
        <input type="number" min={0} max={8} value={perMonth} disabled={!data.canEdit} data-testid="target-per-month"
          onChange={(e) => setPerMonth(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
          onBlur={() => perMonth !== data.targets.publicPostsPerMonth && commit({ publicPostsPerMonth: perMonth })}
          className="h-9 w-20 rounded-lg border border-line bg-raised px-2 text-center tabular-nums text-text" />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-text">
        <span>{t.perMatch}</span>
        <Switch checked={data.targets.privateClipPerMatch} disabled={!data.canEdit} onCheckedChange={(v) => commit({ privateClipPerMatch: v })} data-testid="target-per-match" />
      </label>
      <p className="text-xs text-muted-text">{t.targetHint}</p>
    </section>
  );
}

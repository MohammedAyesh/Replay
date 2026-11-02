import { useState } from "react";
import { MessageCircle, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useAdsWizardCopy } from "@/i18n/ads-wizard-strings";
import { AdsConnectCard } from "./ads-connect";
import { AdWizard } from "./ad-wizard";
import { AdsWalletCard } from "./ads-wallet";
import { useAdsExtraCopy } from "@/i18n/ads-extra-strings";
import { useAdsCopy } from "@/i18n/ads-strings";
import { formatMoney, useAcademyAds, useAdRequestAction, useAdRequests, useAdsConnection, type AdRequest, type CampaignNumbers, type Funnel } from "@/lib/meta-ads-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STAGE_TONE: Record<string, string> = {
  new: "bg-sky-400/15 text-sky-300",
  contacted: "bg-violet-400/15 text-violet-300",
  trial: "bg-amber-300/15 text-amber-200",
  joined: "bg-turf/15 text-turf",
  lost: "bg-raised text-muted-text",
};

function per(spend: number | null | undefined, count: number): number | null {
  return spend !== undefined && spend !== null && count > 0 ? spend / count : null;
}

function FunnelBars({ funnel, copy }: { funnel: Funnel; copy: ReturnType<typeof useAdsCopy> }) {
  const steps: Array<[keyof typeof copy.funnel, number]> = [["leads", funnel.leads], ["contacted", funnel.contacted], ["trial", funnel.trial], ["joined", funnel.joined]];
  const max = Math.max(1, funnel.leads);
  return (
    <div className="space-y-1.5" data-testid="ads-funnel">
      {steps.map(([key, n]) => (
        <div key={key} className="flex items-center gap-3 text-sm">
          <span className="w-24 shrink-0 text-muted-text">{copy.funnel[key]}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-raised">
            <div className={cn("h-full rounded-full", key === "joined" ? "bg-turf" : "bg-floodlight/70")} style={{ width: `${(n / max) * 100}%` }} />
          </div>
          <span className="w-8 shrink-0 text-end font-display font-bold tabular-nums text-text">{n}</span>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted-text">{label}</p>
      <p className={cn("mt-1 font-display text-2xl font-bold tabular-nums", accent ? "text-turf" : "text-text")}>{value}</p>
    </div>
  );
}

export function AcademyAdsSection({ academyId, onOpenChat }: { academyId: number; onOpenChat: (phone: string) => void }) {
  const copy = useAdsCopy();
  const ads = useAcademyAds(academyId);
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const dateFmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" });
  const timeFmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" });

  const header = (
    <header>
      <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.title}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
    </header>
  );

  const top = <>{header}<AdsConnectCard academyId={academyId} /><WalletIfReplay academyId={academyId} /><AdRequestsPanel academyId={academyId} /></>;
  if (ads.isLoading) return <section className="space-y-5" dir={dir}>{top}<div className="h-40 animate-pulse rounded-2xl bg-raised" /></section>;
  if (ads.isError || !ads.data) return <section className="space-y-5" dir={dir}>{top}<p className="text-sm text-red-400" role="alert">{copy.error} {(ads.error as Error | null)?.message}</p></section>;

  const data = ads.data;
  if (!data.campaigns.length && !data.leads.length) {
    return <section className="space-y-5" dir={dir} data-testid="academy-ads">{top}</section>;
  }

  const currency = data.campaigns.find((c) => c.insights?.currency)?.insights?.currency ?? "JOD";
  const spend = data.campaigns.reduce((t, c) => t + (c.insights?.spend ?? 0), 0);
  const reach = data.campaigns.reduce((t, c) => t + (c.insights?.reach ?? 0), 0);
  const leads = data.campaigns.reduce((t, c) => t + c.funnel.leads, 0);
  const joined = data.campaigns.reduce((t, c) => t + c.funnel.joined, 0);
  const money = (n: number | null | undefined, cur: string | null = currency) => formatMoney(n, cur, copy.locale);
  const count = (n: number) => new Intl.NumberFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB").format(n);
  const statusLabel = (s: string | null) => (s === "ACTIVE" ? copy.campaign.active : s && /PAUSED/.test(s) ? copy.campaign.paused : copy.campaign.ended);

  return (
    <section className="space-y-5" data-testid="academy-ads" dir={dir}>
      {top}
      {data.lastSyncedAt && <p className="text-xs text-muted-text">{copy.updated(timeFmt.format(new Date(data.lastSyncedAt)))}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Tile label={copy.totals.spent} value={money(spend)} />
        <Tile label={copy.totals.reached} value={count(reach)} />
        <Tile label={copy.totals.leads} value={count(leads)} />
        <Tile label={copy.totals.joined} value={count(joined)} accent />
        <Tile label={copy.totals.perLead} value={money(per(spend, leads))} />
        <Tile label={copy.totals.perJoined} value={money(per(spend, joined))} accent />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.campaigns.map((c) => {
          const n: CampaignNumbers | null = c.insights;
          return (
            <article key={c.id} className="rounded-2xl border border-line bg-surface p-5" data-testid={`ads-campaign-${c.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-bold text-text" dir="auto">{c.name}</h2>
                  {c.startedAt && <p className="text-xs text-muted-text">{copy.campaign.since(dateFmt.format(new Date(c.startedAt)))}</p>}
                </div>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold", c.status === "ACTIVE" ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{statusLabel(c.status)}</span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div><p className="text-xs text-muted-text">{copy.campaign.spent}</p><p className="font-display text-xl font-bold tabular-nums text-text">{money(n?.spend, n?.currency)}</p></div>
                <div><p className="text-xs text-muted-text">{copy.campaign.reach}</p><p className="font-display text-xl font-bold tabular-nums text-text">{count(n?.reach ?? 0)}</p></div>
                <div><p className="text-xs text-muted-text">{copy.campaign.clicks}</p><p className="font-display text-xl font-bold tabular-nums text-text">{count(n?.clicks ?? 0)}</p></div>
              </div>
              {c.insights30d && <p className="mt-1 text-xs text-muted-text">{copy.campaign.last30(money(c.insights30d.spend, c.insights30d.currency))}</p>}
              <div className="mt-4"><FunnelBars funnel={c.funnel} copy={copy} /></div>
              {(c.ads?.length ?? 0) > 1 && <VariantResults ads={c.ads!} money={money} count={count} />}
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-text">
                <span>{copy.campaign.perLead}: <b className="text-text">{money(per(n?.spend, c.funnel.leads), n?.currency)}</b></span>
                <span>{copy.campaign.perJoined}: <b className="text-turf">{money(per(n?.spend, c.funnel.joined), n?.currency)}</b></span>
                {n && n.conversations > 0 && <span>{copy.campaign.chats}: <b className="text-text">{count(n.conversations)}</b></span>}
                {n && n.leads > 0 && <span>{copy.campaign.forms}: <b className="text-text">{count(n.leads)}</b></span>}
              </div>
            </article>
          );
        })}
      </div>
      {data.otherLeads.leads > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="mb-3 text-sm font-semibold text-text">{copy.other}</p>
          <FunnelBars funnel={data.otherLeads} copy={copy} />
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="font-display text-xl font-bold text-text">{copy.recent}</h2>
          <p className="text-sm text-muted-text">{copy.recentHint}</p>
        </div>
        {!data.leads.length ? <p className="text-sm text-muted-text">{copy.noLeads}</p> : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {data.leads.map((l) => {
              const stage = l.kind === "parent" || l.kind === "player" ? "joined" : l.stage ?? "new";
              return (
                <li key={l.id} className="flex items-start gap-3 px-4 py-3" data-testid={`ads-lead-${l.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-text" dir="auto">{l.name || l.phoneDisplay || "—"}</span>
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", STAGE_TONE[stage] ?? STAGE_TONE.new)}>{copy.stage[stage] ?? stage}</span>
                      <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-text">{copy.source[l.source]}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-text">
                      {l.phoneDisplay && <span dir="ltr">{l.phoneDisplay}</span>}
                      {l.campaignName && <span dir="auto"> · {l.campaignName}</span>}
                      <span> · {timeFmt.format(new Date(l.createdAt))}</span>
                    </p>
                    {l.message && <p className="mt-1 line-clamp-2 text-sm text-text" dir="auto">“{l.message}”</p>}
                    {l.answers && (
                      <p className="mt-1 text-xs text-muted-text" dir="auto">
                        {Object.entries(l.answers).filter(([k]) => !["full_name", "phone_number", "email", "first_name", "last_name"].includes(k.toLowerCase()))
                          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}
                      </p>
                    )}
                  </div>
                  {l.phone && (
                    <Button type="button" size="sm" variant="ghost" className="h-8 shrink-0 px-2" onClick={() => onOpenChat(l.phone!)} aria-label={copy.openChat}>
                      <MessageCircle className="me-1 h-4 w-4" aria-hidden="true" />{copy.openChat}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}

/** Ads on Replay's account are prepaid: show the wallet once that's how the academy runs ads. */
function WalletIfReplay({ academyId }: { academyId: number }) {
  const info = useAdsConnection(academyId);
  const connection = info.data?.connection;
  if (!connection || connection.mode !== "replay" || connection.status !== "connected") return null;
  return <AdsWalletCard academyId={academyId} />;
}

/** A campaign's text versions side by side: what each cost and brought in. */
function VariantResults({ ads, money, count }: { ads: NonNullable<import("@/lib/meta-ads-api").AcademyAds["campaigns"][number]["ads"]>; money: (n: number | null | undefined, cur?: string | null) => string; count: (n: number) => string }) {
  const extra = useAdsExtraCopy();
  const sorted = [...ads].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return (
    <div className="mt-4 rounded-xl bg-raised/60 p-3" data-testid="variant-results">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-text">{extra.results.title}</p>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-text"><tr><th className="text-start font-medium" /><th className="text-end font-medium">{extra.results.cost}</th><th className="text-end font-medium">{extra.results.chats}</th><th className="text-end font-medium">{extra.results.leads}</th></tr></thead>
        <tbody>
          {sorted.map((a, i) => (
            <tr key={a.id}>
              <td className="py-1 font-bold text-turf">{/ · ([A-C])$/.exec(a.name ?? "")?.[1] ?? String.fromCharCode(65 + i)}</td>
              <td className="py-1 text-end tabular-nums text-text">{money(a.insights?.spend, a.insights?.currency)}</td>
              <td className="py-1 text-end tabular-nums text-text">{count(a.insights?.conversations ?? 0)}</td>
              <td className="py-1 text-end tabular-nums text-text">{count(Math.max(a.leads, a.insights?.leads ?? 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-raised text-muted-text",
  pending_approval: "bg-amber-300/15 text-amber-200",
  launching: "bg-sky-400/15 text-sky-300",
  active: "bg-turf/15 text-turf",
  paused: "bg-raised text-muted-text",
  rejected: "bg-red-500/15 text-red-400",
  failed: "bg-red-500/15 text-red-400",
};

/** The ads the owner builds in Replay, with the wizard. */
function AdRequestsPanel({ academyId }: { academyId: number }) {
  const copy = useAdsWizardCopy();
  const extra = useAdsExtraCopy();
  const requests = useAdRequests(academyId);
  const info = useAdsConnection(academyId);
  const act = useAdRequestAction(academyId);
  const [wizard, setWizard] = useState<{ open: boolean; editing: AdRequest | null }>({ open: false, editing: null });
  const connection = info.data?.connection;
  const connected = connection?.status === "connected";
  const mode = connection?.mode === "own" && connected ? "own" : "replay";
  const rows = requests.data?.requests ?? [];
  const currency = (mode === "own" ? connection?.currency : null) ?? rows[0]?.currency ?? "USD";

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="ad-requests">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-text">{copy.list.title}</h2>
        <Button type="button" onClick={() => setWizard({ open: true, editing: null })} disabled={!requests.data} className="min-h-10 rounded-xl bg-floodlight font-bold text-void" data-testid="button-new-ad">
          <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.list.newAd}
        </Button>
      </div>
      {requests.isError && <p className="mt-3 text-sm text-red-400" role="alert">{(requests.error as Error).message}</p>}
      {!rows.length ? <p className="mt-3 text-sm text-muted-text">{copy.list.empty}</p> : (
        <ul className="mt-3 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-3" data-testid={`ad-request-${r.id}`}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-text" dir="auto">{r.name}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", r.pausedReason === "funds" ? "bg-amber-300/15 text-amber-200" : STATUS_TONE[r.status])}>
                    {r.status === "paused" && r.pausedReason === "funds" ? extra.wallet.pausedFunds : r.status === "paused" && r.pausedReason === "ended" ? extra.wallet.ended : copy.list.status[r.status]}
                  </span>
                  {r.variants.length > 1 && <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-text">{r.variants.map((_, i) => String.fromCharCode(65 + i)).join("/")}</span>}
                  {r.cards.length > 1 && <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-text">{extra.media.selected(r.cards.length)}</span>}
                </p>
                <p className="mt-0.5 text-xs text-muted-text">{copy.list.goal[r.goal]} · {copy.list.perDay(formatMoney(r.dailyBudget, r.currency, copy.locale))}</p>
                {r.error && ["rejected", "failed"].includes(r.status) && <p className="mt-1 text-xs text-red-400" dir="auto">{r.error}</p>}
              </div>
              <div className="flex gap-1">
                {["draft", "rejected", "failed"].includes(r.status) && (
                  <>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setWizard({ open: true, editing: r })}><Pencil className="me-1 h-4 w-4" aria-hidden="true" />{copy.list.edit}</Button>
                    <Button type="button" size="sm" disabled={!connected || !r.hasImage || act.isPending} onClick={() => act.mutate({ id: r.id, action: "submit" })} className="bg-turf font-bold text-void">
                      {r.mode === "replay" ? copy.list.submitReplay : copy.list.submit}
                    </Button>
                  </>
                )}
                {r.status === "active" && <Button type="button" size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "pause" })}><Pause className="me-1 h-4 w-4" aria-hidden="true" />{copy.list.pause}</Button>}
                {r.status === "paused" && r.pausedReason !== "ended" && <Button type="button" size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "resume" })}><Play className="me-1 h-4 w-4" aria-hidden="true" />{copy.list.resume}</Button>}
                {r.status === "paused" && r.pausedReason === "funds" && (
                  <Button type="button" size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "pause" })} title={extra.wallet.keepOffHint}>
                    <Pause className="me-1 h-4 w-4" aria-hidden="true" />{extra.wallet.keepOff}
                  </Button>
                )}
                {["draft", "rejected", "failed", "pending_approval"].includes(r.status) && (
                  <Button type="button" size="sm" variant="ghost" className="text-red-400" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: "delete" })} aria-label={copy.list.delete}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {act.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(act.error as Error).message}</p>}
      {requests.data && (
        <AdWizard academyId={academyId} open={wizard.open} editing={wizard.editing} onClose={() => setWizard({ open: false, editing: null })}
          defaults={requests.data.defaults} mode={mode} currency={currency} pageName={connection?.pageName ?? null} />
      )}
    </section>
  );
}

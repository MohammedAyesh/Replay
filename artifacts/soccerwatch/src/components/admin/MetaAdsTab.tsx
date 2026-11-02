import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { formatMoney, useAdminAdRequests, useAdminMetaAds, useAdminMetaPages, useAssignCampaign, useReviewAdRequest, useSubscribePage, useSyncMetaAds } from "@/lib/meta-ads-api";
import { AdminAdTemplates, AdminWallets, ApprovalMedia } from "./MetaAdsWalletTemplates";
import { cn } from "@/lib/utils";

function CopyField({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="text-xs text-muted-text">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-raised px-2 py-1.5 text-xs text-text">{value ?? "— (set META_APP_SECRET first)"}</code>
        {value && (
          <button type="button" className="rounded-lg bg-raised p-1.5 text-muted-text hover:text-text" aria-label={`Copy ${label}`}
            onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}

/** Admin: Replay's Meta ad account, which academy each campaign is for, and Pages sending leads here. */
export default function MetaAdsTab() {
  const query = useAdminMetaAds();
  const sync = useSyncMetaAds();
  const assign = useAssignCampaign();
  const subscribe = useSubscribePage();
  const [showPages, setShowPages] = useState(false);
  const pages = useAdminMetaPages(showPages);
  const data = query.data;
  const ready = Boolean(data?.connected.token && data.connected.adAccount);

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-bold text-text">Meta ads</h2>
        <button type="button" onClick={() => void query.refetch()} className="inline-flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-xs text-muted-text hover:text-text">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh
        </button>
      </div>

      {query.isLoading ? <div className="h-32 animate-pulse rounded-2xl bg-raised" /> : !data ? (
        <p className="text-sm text-red-400">Could not load Meta ads{query.error ? `: ${(query.error as Error).message}` : "."}</p>
      ) : (
        <>
          <AdApprovals />
          <AdminWallets />

          <section className="rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="font-semibold text-text">Academies connected to Meta</p>
            {!data.connections.length ? <p className="mt-1 text-xs text-muted-text">None yet. Owners connect from Academy console → Ads.</p> : (
              <ul className="mt-2 divide-y divide-line text-xs">
                {data.connections.map((c) => (
                  <li key={c.academyId} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-semibold text-text">{c.academyName}</span>
                    <span className="rounded-full bg-raised px-2 py-0.5 text-muted-text">{c.mode === "own" ? "own ad account" : "via Replay"}</span>
                    <span className={c.status === "connected" ? "text-turf" : "text-amber-200"}>{c.status}</span>
                    <span className="text-muted-text">{c.pageName ?? "—"}{c.adAccountName ? ` · ${c.adAccountName}` : ""}</span>
                    {!c.leadsSubscribed && c.status === "connected" && <span className="text-amber-200">leads not subscribed</span>}
                    {c.error && <span className="text-red-400">{c.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="font-semibold text-text">Connection</p>
            <ul className="space-y-1 text-xs">
              <li className={data.connected.token ? "text-turf" : "text-red-400"}>META_ACCESS_TOKEN {data.connected.token ? "set" : "missing"}</li>
              <li className={data.connected.adAccount ? "text-turf" : "text-red-400"}>META_AD_ACCOUNT_ID {data.connected.adAccount ?? "missing"}</li>
              <li className={data.connected.appSecret ? "text-turf" : "text-red-400"}>META_APP_SECRET {data.connected.appSecret ? "set" : "missing (lead webhooks are refused without it)"}</li>
              <li className="text-muted-text">Graph API {data.connected.graphVersion}</li>
            </ul>
            {data.account && <p className="text-turf">Ad account: {data.account.name} · {data.account.currency}{data.account.status !== 1 ? ` · status ${data.account.status}` : ""}</p>}
            {data.accountError && <p className="text-red-400">Meta says: {data.accountError}</p>}
            <div className="grid gap-3 md:grid-cols-2">
              <CopyField label="Webhook callback URL (Meta app → Webhooks → Page → leadgen)" value={data.webhook.url} />
              <CopyField label="Verify token" value={data.webhook.verifyToken} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" disabled={!ready || sync.isPending} onClick={() => sync.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-floodlight px-3 py-1.5 text-xs font-bold text-void disabled:opacity-50" data-testid="button-meta-sync">
                <RefreshCw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} aria-hidden="true" />Sync now
              </button>
              <span className="text-xs text-muted-text">{data.lastSyncedAt ? `Last synced ${new Date(data.lastSyncedAt).toLocaleString()}` : "Never synced"} · syncs hourly from vps1's tick</span>
              {sync.isError && <span className="text-xs text-red-400">{(sync.error as Error).message}</span>}
              {sync.data && <span className="text-xs text-turf">{sync.data.campaigns} campaigns, {sync.data.ads} ads</span>}
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4 text-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-text">Facebook Pages sending instant-form leads here</p>
              {!showPages && <button type="button" disabled={!ready} onClick={() => setShowPages(true)} className="rounded-lg bg-raised px-3 py-1.5 text-xs text-muted-text hover:text-text disabled:opacity-50">Load Pages</button>}
            </div>
            {showPages && (pages.isLoading ? <p className="mt-2 text-xs text-muted-text">Loading…</p>
              : pages.isError ? <p className="mt-2 text-xs text-red-400">{(pages.error as Error).message}</p>
                : !pages.data?.length ? <p className="mt-2 text-xs text-muted-text">The token sees no Pages. Assign the academy Pages to Replay's system user in Business Settings.</p>
                  : (
                    <ul className="mt-2 divide-y divide-line">
                      {pages.data.map((page) => (
                        <li key={page.id} className="flex items-center justify-between gap-3 py-2">
                          <span className="text-text">{page.name} <span className="text-xs text-muted-text">{page.id}</span></span>
                          {page.subscribed ? <span className="text-xs font-semibold text-turf">Leads arrive here</span> : (
                            <button type="button" disabled={subscribe.isPending} onClick={() => subscribe.mutate(page.id)} className="rounded-lg bg-floodlight px-3 py-1 text-xs font-bold text-void">Send leads here</button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ))}
            {subscribe.isError && <p className="mt-2 text-xs text-red-400">{(subscribe.error as Error).message}</p>}
            <p className="mt-2 text-xs text-muted-text">Click-to-WhatsApp ads need nothing here: the chat itself carries the ad, on the academy's own number or Replay's.</p>
          </section>

          <section className="rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="font-semibold text-text">Campaigns</p>
            <p className="mt-0.5 text-xs text-muted-text">Pick the academy each campaign advertises. Its leads go to that academy's People, including any that arrived before you picked.</p>
            {!data.campaigns.length ? <p className="mt-3 text-xs text-muted-text">No campaigns yet. Press Sync now.</p> : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] text-xs">
                  <thead>
                    <tr className="border-b border-line text-start text-muted-text">
                      <th className="py-2 text-start">Campaign</th>
                      <th className="text-end">Spent</th>
                      <th className="text-end">Last 30d</th>
                      <th className="text-end">Reach</th>
                      <th className="text-end">Chats (Meta)</th>
                      <th className="text-end">Form leads (Meta)</th>
                      <th className="text-end">Leads here</th>
                      <th className="ps-3 text-start">Academy</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.campaigns.map((c) => (
                      <tr key={c.id} data-testid={`meta-campaign-${c.id}`}>
                        <td className="py-2">
                          <span className="font-semibold text-text">{c.name}</span>
                          <span className="block text-muted-text">{c.status ?? "—"} · {c.objective ?? ""}</span>
                        </td>
                        <td className="text-end tabular-nums text-text">{formatMoney(c.insights?.spend, c.insights?.currency, "en")}</td>
                        <td className="text-end tabular-nums text-muted-text">{formatMoney(c.insights30d?.spend, c.insights30d?.currency, "en")}</td>
                        <td className="text-end tabular-nums text-muted-text">{c.insights?.reach ?? 0}</td>
                        <td className="text-end tabular-nums text-muted-text">{c.insights?.conversations ?? 0}</td>
                        <td className="text-end tabular-nums text-muted-text">{c.insights?.leads ?? 0}</td>
                        <td className="text-end tabular-nums text-text">{c.leads}{c.unassignedLeads > 0 && <span className="ms-1 rounded-full bg-amber-300/15 px-1.5 text-amber-200">{c.unassignedLeads} waiting</span>}</td>
                        <td className="ps-3">
                          {c.ownAccount ? <span className="text-muted-text">{data.academies.find((a) => a.id === c.academyId)?.name ?? "—"} (own account)</span> : <select value={c.academyId ?? ""} disabled={assign.isPending}
                            onChange={(e) => assign.mutate({ campaignId: c.id, academyId: e.target.value ? Number(e.target.value) : null })}
                            className="h-8 w-48 rounded-lg border border-input bg-raised px-2 text-xs text-text" data-testid={`select-campaign-academy-${c.id}`}>
                            <option value="">Not assigned</option>
                            {data.academies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {assign.isError && <p className="mt-2 text-xs text-red-400">{(assign.error as Error).message}</p>}
            {data.leadsWithoutCampaign > 0 && <p className="mt-2 text-xs text-amber-200">{data.leadsWithoutCampaign} lead(s) came from an ad Meta couldn't match to a campaign.</p>}
          </section>

          <AdminAdTemplates />
        </>
      )}
    </div>
  );
}

/** Ads academies built to run on Replay's ad account: Replay pays, so each one needs a yes here. */
function AdApprovals() {
  const requests = useAdminAdRequests();
  const review = useReviewAdRequest();
  const [reason, setReason] = useState<Record<number, string>>({});
  const rows = requests.data ?? [];
  const waiting = rows.filter((r) => r.status === "pending_approval");
  const recent = rows.filter((r) => r.status !== "pending_approval").slice(0, 10);
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 text-sm" data-testid="admin-ad-approvals">
      <p className="font-semibold text-text">Ads waiting for approval {waiting.length > 0 && <span className="ms-1 rounded-full bg-amber-300/15 px-2 text-amber-200">{waiting.length}</span>}</p>
      <p className="mt-0.5 text-xs text-muted-text">These run on Replay's ad account and spend Replay's money. Approving publishes them on Meta straight away.</p>
      {requests.isError && <p className="mt-2 text-xs text-red-400">{(requests.error as Error).message}</p>}
      {!waiting.length ? <p className="mt-2 text-xs text-muted-text">Nothing waiting.</p> : (
        <ul className="mt-3 space-y-3">
          {waiting.map((r) => (
            <li key={r.id} className="grid gap-3 rounded-xl border border-line p-3 md:grid-cols-[160px_1fr]">
              <ApprovalMedia request={r} />
              <div className="space-y-1 text-xs">
                <p className="text-sm font-semibold text-text">{r.academyName} · {r.name}</p>
                <p className="text-muted-text">{r.goal === "whatsapp" ? "WhatsApp messages" : "Sign-up form"} · {formatMoney(r.dailyBudget, r.currency, "en")}/day
                  {r.mode === "replay" ? ` (Meta ${formatMoney(r.metaDailyBudget, r.metaCurrency, "en")})` : ""} · {r.radiusKm} km · ages {r.ageMin}–{r.ageMax}
                  {r.startAt ? ` · from ${new Date(r.startAt).toLocaleDateString()}` : ""}{r.endAt ? ` to ${new Date(r.endAt).toLocaleDateString()}` : " · no end date"}</p>
                {r.fundsToStart !== null && (
                  <p className={r.walletBalance >= r.fundsToStart ? "text-turf" : "text-amber-200"}>
                    Wallet {formatMoney(r.walletBalance, "JOD", "en")} · needs {formatMoney(r.fundsToStart, "JOD", "en")} to start
                  </p>
                )}
                {r.variants.map((v, i) => (
                  <div key={i} className="rounded-lg bg-raised/60 p-2">
                    {r.variants.length > 1 && <p className="font-bold text-turf">{String.fromCharCode(65 + i)}</p>}
                    <p className="font-semibold text-text" dir="auto">{v.headline}</p>
                    <p className="whitespace-pre-line text-text" dir="auto">{v.primaryText}</p>
                  </div>
                ))}
                {r.goal === "lead_form" && r.questions.length > 0 && (
                  <p className="text-muted-text" dir="auto">Questions: {r.questions.map((q) => `${q.label}${q.options?.length ? ` (${q.options.join(", ")})` : ""}`).join(" · ")}</p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <button type="button" disabled={review.isPending} onClick={() => review.mutate({ id: r.id, approve: true })} className="rounded-lg bg-turf px-3 py-1.5 font-bold text-void disabled:opacity-50">Approve and publish</button>
                  <input value={reason[r.id] ?? ""} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} placeholder="Reason (shown to the owner)" className="h-8 min-w-48 flex-1 rounded-lg border border-input bg-raised px-2 text-text" />
                  <button type="button" disabled={review.isPending} onClick={() => review.mutate({ id: r.id, approve: false, reason: reason[r.id] })} className="rounded-lg bg-raised px-3 py-1.5 text-red-400">Reject</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {review.isError && <p className="mt-2 text-xs text-red-400">{(review.error as Error).message}</p>}
      {recent.length > 0 && (
        <ul className="mt-3 divide-y divide-line text-xs">
          {recent.map((r) => <li key={r.id} className="flex flex-wrap gap-2 py-1.5"><span className="text-text">{r.academyName} · {r.name}</span><span className="text-muted-text">{r.status}{r.mode === "own" ? " · own account" : ""}</span>{r.error && <span className="text-red-400">{r.error}</span>}</li>)}
        </ul>
      )}
    </section>
  );
}

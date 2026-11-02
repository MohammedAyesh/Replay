import { useState } from "react";
import { Check, Copy, Loader2, Wallet as WalletIcon, X } from "lucide-react";
import { useAdsExtraCopy } from "@/i18n/ads-extra-strings";
import { formatMoney, useCancelTopup, useRequestTopup, useWallet, type WalletEntry } from "@/lib/meta-ads-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-0.5 text-xs text-text hover:bg-turf/15"
      onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <Check className="h-3 w-3 text-turf" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}{copied ? done : label}
    </button>
  );
}

/** Academy → Ads: the prepaid balance for ads on Replay's account. */
export function AdsWalletCard({ academyId }: { academyId: number }) {
  const copy = useAdsExtraCopy();
  const wallet = useWallet(academyId);
  const requestTopup = useRequestTopup(academyId);
  const cancel = useCancelTopup(academyId);
  const [amount, setAmount] = useState("20");
  const [open, setOpen] = useState(false);
  const money = (n: number | null | undefined) => formatMoney(n, "JOD", copy.locale);
  const dayFmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" });
  const when = (e: WalletEntry) => {
    const d = e.date ? new Date(`${e.date}T12:00:00+03:00`) : e.confirmedAt ? new Date(e.confirmedAt) : e.createdAt ? new Date(e.createdAt) : null;
    return d ? dayFmt.format(d) : "";
  };

  if (wallet.isLoading) return <div className="h-28 animate-pulse rounded-2xl bg-raised" />;
  if (wallet.isError || !wallet.data) return <p className="text-sm text-red-400" role="alert">{(wallet.error as Error | null)?.message}</p>;
  const w = wallet.data;
  const low = w.dailySpend > 0 && w.balance < w.dailySpend;

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="ads-wallet">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><WalletIcon className="h-5 w-5 text-turf" aria-hidden="true" />{copy.wallet.title}</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-text">{copy.wallet.hint}</p>
        </div>
        <div className="text-end">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-text">{copy.wallet.balance}</p>
          <p className={cn("font-display text-3xl font-bold tabular-nums", low ? "text-amber-300" : "text-turf")} data-testid="wallet-balance">{money(w.balance)}</p>
          {w.dailySpend > 0 && (
            <p className="text-xs text-muted-text">{copy.wallet.daily} {money(w.dailySpend)} {copy.wallet.perDay}{w.daysLeft !== null ? ` · ${copy.wallet.daysLeft(w.daysLeft)}` : ""}</p>
          )}
        </div>
      </div>
      {low && <p className="mt-3 rounded-xl bg-amber-300/10 p-3 text-sm text-amber-200">{copy.wallet.lowNote}</p>}

      {w.pending.map((p) => (
        <div key={p.id} className="mt-4 rounded-xl border border-floodlight/40 bg-floodlight/5 p-4" data-testid={`wallet-pending-${p.id}`}>
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-text">{copy.wallet.howTitle} · {money(p.amount)}</p>
            <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-[11px] font-bold text-amber-200">{copy.wallet.pending}</span>
          </div>
          <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm text-text">
            {copy.wallet.how(w.cliqAlias, money(p.amount), p.reference ?? "").map((line) => <li key={line}>{line}</li>)}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-text" dir="ltr">{w.cliqAlias}</span><CopyButton text={w.cliqAlias} label={copy.wallet.copy} done={copy.wallet.copied} />
            <span className="font-mono text-text" dir="ltr">{p.reference}</span><CopyButton text={p.reference ?? ""} label={copy.wallet.copy} done={copy.wallet.copied} />
            <button type="button" className="ms-auto inline-flex items-center gap-1 text-muted-text hover:text-red-400" onClick={() => p.id && cancel.mutate(p.id)} disabled={cancel.isPending}>
              <X className="h-3 w-3" aria-hidden="true" />{copy.wallet.cancel}
            </button>
          </div>
        </div>
      ))}

      <div className="mt-4">
        {!open ? (
          <Button type="button" onClick={() => setOpen(true)} className="rounded-xl bg-floodlight font-bold text-void" data-testid="button-topup">{copy.wallet.topUp}</Button>
        ) : (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            const n = Number(amount);
            if (!Number.isFinite(n) || n < w.minTopup) return;
            requestTopup.mutate(n, { onSuccess: () => setOpen(false) });
          }}>
            <label className="text-sm text-muted-text">{copy.wallet.amount}
              <Input type="number" inputMode="decimal" min={w.minTopup} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-32" data-testid="input-topup" />
            </label>
            <div className="flex gap-1.5">
              {[20, 50, 100].map((n) => (
                <button key={n} type="button" onClick={() => setAmount(String(n))} className={cn("h-10 rounded-lg border px-3 text-sm", amount === String(n) ? "border-turf text-turf" : "border-line text-text")}>{n}</button>
              ))}
            </div>
            <Button type="submit" disabled={requestTopup.isPending || Number(amount) < w.minTopup} className="h-10 rounded-xl bg-turf font-bold text-void">
              {requestTopup.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}{copy.wallet.request}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={() => setOpen(false)}>{copy.wallet.cancel}</Button>
            <p className="w-full text-xs text-muted-text">{copy.wallet.min(money(w.minTopup))}</p>
            {requestTopup.isError && <p className="w-full text-sm text-red-400" role="alert">{(requestTopup.error as Error).message}</p>}
          </form>
        )}
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-text">{copy.wallet.history}</summary>
        {!w.history.length ? <p className="mt-2 text-sm text-muted-text">{copy.wallet.noHistory}</p> : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {w.history.slice(0, 40).map((e, i) => (
              <li key={`${e.kind}-${e.id ?? e.date}-${i}`} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-text" dir="auto">
                  {copy.wallet.kind[e.kind]}{e.campaignName ? ` · ${e.campaignName}` : ""}{e.status === "rejected" ? ` · ${copy.wallet.rejected}` : ""}
                  <span className="ms-2 text-xs text-muted-text">{when(e)}</span>
                </span>
                <span className={cn("shrink-0 font-display font-bold tabular-nums", e.status === "rejected" ? "text-muted-text line-through" : e.amount < 0 ? "text-text" : "text-turf")}>
                  {e.amount > 0 ? "+" : ""}{money(e.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

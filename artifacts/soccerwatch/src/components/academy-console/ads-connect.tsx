import { useEffect, useState } from "react";
import { Check, Copy, Facebook, Link2, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { useAdsWizardCopy } from "@/i18n/ads-wizard-strings";
import {
  useAdsConnection,
  useConnectOwn,
  useDisconnectMeta,
  useOwnAssets,
  useSelectOwn,
  useShareCheck,
  type ConnectionInfo,
} from "@/lib/meta-ads-api";
import { facebookBusinessLogin } from "@/lib/facebook-sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Copy = ReturnType<typeof useAdsWizardCopy>;

/** Academy → Ads: how the academy's ads reach Meta (share the Page with Replay, or its own ad account). */
export function AdsConnectCard({ academyId }: { academyId: number }) {
  const copy = useAdsWizardCopy();
  const info = useAdsConnection(academyId);
  const disconnect = useDisconnectMeta(academyId);
  const [changing, setChanging] = useState(false);
  const data = info.data;
  const connection = data?.connection;
  const connected = connection?.status === "connected";

  if (info.isLoading) return <div className="h-32 animate-pulse rounded-2xl bg-raised" />;
  if (info.isError || !data) return <p className="text-sm text-red-400" role="alert">{(info.error as Error | null)?.message}</p>;

  if (connected && !changing) {
    return (
      <section className="rounded-2xl border border-turf/40 bg-turf/5 p-5" data-testid="ads-connected">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold text-text">
              <Check className="h-4 w-4 text-turf" aria-hidden="true" />
              <span dir="auto">{connection.mode === "own"
                ? copy.connect.connectedOwn(connection.pageName ?? "", connection.adAccountName ?? connection.adAccountId ?? "")
                : copy.connect.connectedReplay(connection.pageName ?? "")}</span>
            </p>
            <p className={cn("mt-1 text-xs", connection.leadsSubscribed ? "text-muted-text" : "text-amber-200")}>{connection.leadsSubscribed ? copy.connect.leadsOn : copy.connect.leadsOff}</p>
            <p className={cn("mt-0.5 text-xs", connection.whatsappNumber ? "text-muted-text" : "text-amber-200")} dir="auto">
              {connection.whatsappNumber ? copy.connect.whatsapp(connection.whatsappNumber) : copy.connect.noWhatsapp}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(true)}>{copy.connect.change}</Button>
            <Button type="button" size="sm" variant="ghost" className="text-red-400" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>{copy.connect.disconnect}</Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="ads-connect">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-text">{copy.connect.title}</h2>
          <p className="mt-1 text-sm text-muted-text">{copy.connect.hint}</p>
        </div>
        {changing && <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(false)}>✕</Button>}
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <ShareOption academyId={academyId} info={data} copy={copy} onDone={() => setChanging(false)} />
        <OwnOption academyId={academyId} info={data} copy={copy} onDone={() => setChanging(false)} />
      </div>
    </section>
  );
}

function ShareOption({ academyId, info, copy, onDone }: { academyId: number; info: ConnectionInfo; copy: Copy; onDone: () => void }) {
  const check = useShareCheck(academyId);
  const [page, setPage] = useState("");
  const [copied, setCopied] = useState(false);
  const result = check.data;
  useEffect(() => {
    if (result?.status === "connected") onDone();
  }, [result, onDone]);
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="flex items-center gap-2 font-semibold text-text"><ShieldCheck className="h-4 w-4 text-floodlight" aria-hidden="true" />{copy.connect.replayTitle}
        <span className="rounded-full bg-floodlight/15 px-2 py-0.5 text-[11px] font-bold text-floodlight">{copy.connect.recommended}</span></p>
      <p className="mt-1 text-sm text-muted-text">{copy.connect.replayBody}</p>
      <ol className="mt-3 list-decimal space-y-1 ps-5 text-sm text-text">
        {copy.connect.steps(info.replay.businessId).map((step) => <li key={step} dir="auto">{step}</li>)}
      </ol>
      <button type="button" className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1 text-xs text-muted-text hover:text-text"
        onClick={() => { void navigator.clipboard?.writeText(info.replay.businessId); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        <span dir="ltr">{info.replay.businessId}</span> · {copied ? copy.connect.copied : copy.connect.copyId}
      </button>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (page.trim()) check.mutate(page); }}>
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
          <Input value={page} onChange={(e) => setPage(e.target.value)} placeholder={copy.connect.pagePlaceholder} className="ps-9" dir="ltr" data-testid="input-share-page" />
        </div>
        <Button type="submit" disabled={!info.replay.available || check.isPending || !page.trim()} className="bg-turf font-bold text-void" data-testid="button-check-share">
          {check.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : copy.connect.check}
        </Button>
      </form>
      {result?.status === "not_shared" && <p className="mt-2 text-sm text-amber-200" dir="auto">{copy.connect.notShared(result.pageName)}</p>}
      {result?.status === "invalid" && <p className="mt-2 text-sm text-red-400">{copy.connect.invalid}</p>}
      {check.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(check.error as Error).message}</p>}
    </div>
  );
}

function OwnOption({ academyId, info, copy, onDone }: { academyId: number; info: ConnectionInfo; copy: Copy; onDone: () => void }) {
  const connect = useConnectOwn(academyId);
  const select = useSelectOwn(academyId);
  const pending = info.connection?.mode === "own" && info.connection.status === "pending";
  const assets = useOwnAssets(academyId, pending);
  const list = connect.data?.assets ?? assets.data ?? null;
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");
  const [sdkError, setSdkError] = useState(false);
  const ready = Boolean(info.own.loginConfigId);

  const start = async () => {
    setSdkError(false);
    try {
      const code = await facebookBusinessLogin(info.own.appId, info.own.graphVersion, info.own.loginConfigId!);
      if (code) connect.mutate(code, { onSuccess: (res) => { if (res.connection.status === "connected") onDone(); } });
    } catch {
      setSdkError(true);
    }
  };

  return (
    <div className={cn("rounded-xl border border-line p-4", !ready && "opacity-80")}>
      <p className="flex items-center gap-2 font-semibold text-text"><Wallet className="h-4 w-4 text-sky-300" aria-hidden="true" />{copy.connect.ownTitle}</p>
      <p className="mt-1 text-sm text-muted-text">{copy.connect.ownBody}</p>
      {!ready ? <p className="mt-3 text-sm text-amber-200">{copy.connect.ownNotReady}</p> : (
        <>
          <Button type="button" onClick={() => void start()} disabled={connect.isPending} className="mt-3 bg-[#1877F2] font-bold text-white hover:bg-[#166FE5]" data-testid="button-facebook-login">
            {connect.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Facebook className="me-2 h-4 w-4" aria-hidden="true" />}{copy.connect.signIn}
          </Button>
          <p className="mt-2 text-xs text-muted-text">{copy.connect.ownTesting}</p>
        </>
      )}
      {sdkError && <p className="mt-2 text-sm text-red-400">{copy.connect.sdkFailed}</p>}
      {connect.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(connect.error as Error).message}</p>}
      {list && (list.adAccounts.length > 1 || list.pages.length > 1 || pending) && (
        <div className="mt-4 space-y-2 rounded-xl bg-raised/60 p-3">
          <p className="text-sm font-semibold text-text">{copy.connect.pickTitle}</p>
          <label className="block text-xs text-muted-text">{copy.connect.adAccount}
            <select value={account} onChange={(e) => setAccount(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text">
              <option value="">–</option>
              {list.adAccounts.map((a) => <option key={a.id} value={a.id}>{`${a.name} · ${a.currency}`}</option>)}
            </select>
          </label>
          <label className="block text-xs text-muted-text">{copy.connect.page}
            <select value={page} onChange={(e) => setPage(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text">
              <option value="">–</option>
              {list.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <Button type="button" size="sm" disabled={!account || !page || select.isPending} className="bg-turf font-bold text-void"
            onClick={() => select.mutate({ adAccountId: account, pageId: page }, { onSuccess: onDone })}>{copy.connect.use}</Button>
          {select.isError && <p className="text-sm text-red-400" role="alert">{(select.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}

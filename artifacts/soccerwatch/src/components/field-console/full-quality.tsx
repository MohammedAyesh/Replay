import { useState } from "react";
import { Check, Copy, Download, Loader2, Router, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useKitCopy } from "@/i18n/kit-strings";
import { cn } from "@/lib/utils";
import {
  useCreateKitFtp, useCreateKitRouter, useKitLink, useRemoveKitFtp, useRemoveKitRouter,
  type Kit, type KitFtpLogin, type KitLink, type KitRouterFile,
} from "@/lib/kits-api";
import { ErrorText } from "./shared";

/**
 * Portable cameras connected from the app reach Replay through Reolink's cloud: live picture
 * only. Full-quality recordings need a real path, which the owner sets up here themselves:
 * a travel router with a private tunnel (vps1 kitnet.py), or encrypted FTP (kitftp.py).
 * Secrets (router file, FTP password) come back once and are never stored by the app.
 */

export function FullQualityRow({ kit }: { kit: Kit }) {
  const c = useKitCopy();
  const f = c.fq;
  const link = useKitLink(kit.id);
  const [open, setOpen] = useState(false);
  const l = link.data;
  const line = !l ? (link.isLoading ? null : f.rowNone)
    : l.router.configured ? (l.router.connected ? (l.router.camera ? f.rowRouterOk : f.rowRouterNoCam) : f.rowRouterWaiting)
      : l.ftp.configured ? (l.ftp.lastClipSecondsAgo != null ? f.rowFtpOk(f.ago(l.ftp.lastClipSecondsAgo)) : f.rowFtpWaiting)
        : f.rowNone;
  const ok = !!l && ((l.router.configured && l.router.connected && !!l.router.camera) || (!l.router.configured && l.ftp.configured && l.ftp.lastClipSecondsAgo != null));
  return (
    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-2.5">
      <span className="min-w-0 text-xs leading-5">
        <span className="block font-semibold text-text">{f.title}</span>
        <span className={cn("block", ok ? "text-turf" : "text-muted-text")}>{line ?? <Loader2 className="h-3.5 w-3.5 animate-spin" />}</span>
      </span>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-9 shrink-0 items-center rounded-xl border border-line bg-surface px-3 text-xs font-semibold text-text">
        {l && (l.router.configured || l.ftp.configured) ? f.manage : f.setUp}
      </button>
      {open && <FullQualityDialog kit={kit} link={l} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const c = useKitCopy();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-[11px] text-muted-text">{label}</span>
        <span className={cn("block truncate font-mono text-sm", secret && "tracking-wider")} dir="ltr">{value}</span>
      </span>
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold">
        {copied ? <Check className="h-3.5 w-3.5 text-turf" /> : <Copy className="h-3.5 w-3.5" />}{copied ? c.fq.copied : c.fq.copy}
      </button>
    </div>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-6">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-bold">{i + 1}</span>
          <span>{t}</span>
        </li>
      ))}
    </ol>
  );
}

function Check2({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <Check className="h-4 w-4 text-turf" /> : <Loader2 className="h-4 w-4 animate-spin text-muted-text" />}
      <span className={ok ? "text-text" : "text-muted-text"}>{label}</span>
    </div>
  );
}

function downloadFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function FullQualityDialog({ kit, link, onClose }: { kit: Kit; link?: KitLink; onClose: () => void }) {
  const c = useKitCopy();
  const f = c.fq;
  const initial = link?.router.configured ? "router" : link?.ftp.configured ? "ftp" : "pick";
  const [mode, setMode] = useState<"pick" | "router" | "ftp">(initial);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={c.locale === "ar" ? "rtl" : "ltr"} className="max-h-[90vh] overflow-y-auto border-line bg-surface text-text sm:max-w-lg">
        <DialogHeader className="text-start"><DialogTitle>{f.pickTitle} · {kit.name}</DialogTitle></DialogHeader>
        {mode === "pick" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-text">{f.pickSub}</p>
            <button type="button" onClick={() => setMode("router")} className="w-full rounded-2xl border border-turf/50 bg-turf/[0.06] p-4 text-start">
              <span className="flex items-center gap-2 font-semibold"><Router className="h-4 w-4" />{f.routerName}<span className="rounded-full bg-turf/15 px-2 py-0.5 text-[10px] font-bold text-turf">{f.routerTag}</span></span>
              <span className="mt-1 block text-sm leading-6 text-muted-text">{f.routerBody}</span>
              <span className="mt-1 block text-xs text-muted-text">{f.routerPrice}</span>
            </button>
            <button type="button" onClick={() => setMode("ftp")} className="w-full rounded-2xl border border-line bg-raised p-4 text-start">
              <span className="flex items-center gap-2 font-semibold"><Upload className="h-4 w-4" />{f.ftpName}</span>
              <span className="mt-1 block text-sm leading-6 text-muted-text">{f.ftpBody}</span>
            </button>
          </div>
        )}
        {mode === "router" && <RouterFlow kit={kit} onBack={() => setMode("pick")} onClose={onClose} />}
        {mode === "ftp" && <FtpFlow kit={kit} onBack={() => setMode("pick")} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function RouterFlow({ kit, onBack, onClose }: { kit: Kit; onBack: () => void; onClose: () => void }) {
  const c = useKitCopy();
  const f = c.fq;
  const make = useCreateKitRouter(kit.id);
  const remove = useRemoveKitRouter(kit.id);
  const [file, setFile] = useState<KitRouterFile | null>(null);
  const link = useKitLink(kit.id, true);
  const r = link.data?.router;
  const configured = !!file || !!r?.configured;
  const address = file?.routerAddress ?? r?.routerAddress ?? "";
  const fileName = `replay-${kit.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "camera"}.conf`;
  const create = () => make.mutate(undefined, { onSuccess: (d) => { setFile(d); downloadFile(fileName, d.config); } });

  return (
    <div className="space-y-5">
      {!configured && <button type="button" onClick={onBack} className="text-xs font-semibold text-muted-text underline">{f.back}</button>}
      <section className="space-y-2">
        <h3 className="text-sm font-bold">{f.r1Title}</h3>
        <Steps items={f.r1Steps} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-bold">{f.r2Title}</h3>
        <p className="text-xs leading-5 text-muted-text">{f.r2Body}</p>
        {file ? (
          <Button type="button" variant="outline" onClick={() => downloadFile(fileName, file.config)} className="min-h-11 w-full border-line bg-raised text-text"><Download className="me-2 h-4 w-4" />{f.r2Download}</Button>
        ) : (
          <Button type="button" onClick={create} disabled={make.isPending} className="min-h-11 w-full bg-floodlight font-bold text-void">
            {make.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Download className="me-2 h-4 w-4" />}{r?.configured ? f.remakeRouter : f.r2Make}
          </Button>
        )}
        <ErrorText error={make.error} />
      </section>
      {configured && address && (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-bold">{f.r3Title}</h3>
            <Steps items={f.r3Steps(address)} />
          </section>
          <section className="space-y-2 rounded-2xl border border-line bg-raised p-3">
            <h3 className="text-sm font-bold">{f.r4Title}</h3>
            <Check2 ok={!!r?.connected} label={f.chkRouter} />
            <Check2 ok={!!r?.connected && !!r?.camera} label={f.chkCamera} />
            {r?.connected && r?.camera && <p className="text-sm font-semibold text-turf">{f.chkDone}</p>}
          </section>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" onClick={onClose} className="min-h-11 bg-floodlight font-bold text-void">{f.done}</Button>
            <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })} className="min-h-11 border-line bg-raised text-text">{f.removeRouter}</Button>
          </div>
          <ErrorText error={remove.error} />
        </>
      )}
    </div>
  );
}

function FtpFlow({ kit, onBack, onClose }: { kit: Kit; onBack: () => void; onClose: () => void }) {
  const c = useKitCopy();
  const f = c.fq;
  const make = useCreateKitFtp(kit.id);
  const remove = useRemoveKitFtp(kit.id);
  const [login, setLogin] = useState<KitFtpLogin | null>(null);
  const link = useKitLink(kit.id, true);
  const ftp = link.data?.ftp;
  const configured = !!login || !!ftp?.configured;
  const server = login?.server ?? ftp?.server;
  const port = login?.port ?? ftp?.port;
  const user = login?.user ?? ftp?.user;
  const folder = login?.folder ?? ftp?.folder;

  return (
    <div className="space-y-5">
      {!configured && <button type="button" onClick={onBack} className="text-xs font-semibold text-muted-text underline">{f.back}</button>}
      <p className="rounded-xl border border-floodlight/40 bg-floodlight/[0.06] p-3 text-xs leading-5 text-text">{f.ftpBody} {f.f3Data}</p>
      <section className="space-y-2">
        <h3 className="text-sm font-bold">{f.f1Title}</h3>
        <p className="text-xs leading-5 text-muted-text">{f.f1Body}</p>
        {configured && server && (
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-raised">
            <CopyRow label={f.fServer} value={server} />
            <CopyRow label={f.fPort} value={String(port ?? 21)} />
            <CopyRow label={f.fUser} value={user ?? ""} />
            {login && <CopyRow label={f.fPassword} value={login.password} secret />}
            <CopyRow label={f.fFolder} value={folder ?? "/upload"} />
          </div>
        )}
        {!login && (
          <Button type="button" onClick={() => make.mutate(undefined, { onSuccess: setLogin })} disabled={make.isPending}
            className={cn("min-h-11 w-full font-bold", configured ? "border border-line bg-raised text-text" : "bg-floodlight text-void")}>
            {make.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}{configured ? f.remakeFtp : f.f1Make}
          </Button>
        )}
        <ErrorText error={make.error} />
      </section>
      {configured && (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-bold">{f.f2Title}</h3>
            <Steps items={f.f2Steps} />
          </section>
          <section className="rounded-2xl border border-line bg-raised p-3">
            <Check2 ok={ftp?.lastClipSecondsAgo != null} label={ftp?.lastClipSecondsAgo != null ? f.f3Ok(f.ago(ftp.lastClipSecondsAgo)) : f.f3Waiting} />
          </section>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" onClick={onClose} className="min-h-11 bg-floodlight font-bold text-void">{f.done}</Button>
            <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })} className="min-h-11 border-line bg-raised text-text">{f.removeFtp}</Button>
          </div>
          <ErrorText error={remove.error} />
        </>
      )}
    </div>
  );
}

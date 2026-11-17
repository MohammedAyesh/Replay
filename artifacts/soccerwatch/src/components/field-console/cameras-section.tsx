import { useState, type FormEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Copy, Plus, RotateCcw, Ruler, Video, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useKitCopy } from "@/i18n/kit-strings";
import { cn } from "@/lib/utils";
import { useAddKit, useKitWifi, useManageKits, useReviewSetup, type Kit, type KitSetup } from "@/lib/kits-api";
import { Card, ErrorText, SectionHeader, Skeleton } from "./shared";

/**
 * Console → Cameras (Labs): the venue's or academy's portable kits, every set-up they've
 * had, and the review of a measurement that didn't agree with the saved pitch size.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

function when(iso: string | null, locale: "en" | "ar"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { timeZone: "Asia/Amman", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function StatusPill({ status }: { status: string }) {
  const c = useKitCopy();
  const tone = status === "recording" ? "bg-[#FF5A3C]/12 text-[#FF5A3C]"
    : status === "needs_look" ? "bg-floodlight/12 text-floodlight"
      : status === "measured" || status === "approved" ? "bg-turf/10 text-turf"
        : "bg-raised text-muted-text";
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold", tone)}>{status === "recording" ? "● " : ""}{c.status[status] ?? status}</span>;
}

export function CamerasSection({ academyId }: { academyId: number }) {
  const c = useKitCopy();
  const q = useManageKits(academyId);
  const [filter, setFilter] = useState<"all" | "look">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [wifiKit, setWifiKit] = useState<Kit | null>(null);
  if (q.isLoading) return <Skeleton rows={3} />;
  if (q.isError || !q.data) return <ErrorText error={q.error} />;
  const { kits, setups, canAdd } = q.data;
  const current = setups.find((s) => s.id === open);
  if (current) return <ReviewPanel setup={current} onBack={() => setOpen(null)} />;
  const rows = filter === "look" ? setups.filter((s) => s.status === "needs_look") : setups;

  return (
    <section className="space-y-6" data-testid="field-cameras">
      <SectionHeader title={c.console.title} description={c.console.desc}
        action={canAdd ? <Button type="button" onClick={() => setAdding(true)} className="min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void"><Plus className="me-2 h-4 w-4" />{c.console.add}</Button> : undefined} />
      {kits.length === 0 ? <Card><p className="text-sm text-muted-text">{c.console.none}</p></Card> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kits.map((k) => <KitCard key={k.id} kit={k} onWifi={() => setWifiKit(k)} />)}
        </div>
      )}
      {setups.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-2 pt-4">
            <h2 className="font-display text-2xl font-bold text-text">{c.console.where}</h2>
            <div className="flex gap-2">
              {(["all", "look"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded-2xl border px-3 py-1.5 text-[13px] font-semibold", filter === f ? "border-turf bg-turf text-void" : "border-line bg-surface text-text")}>
                  {f === "all" ? c.console.all : c.console.needsLook}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-start text-[10px] font-bold uppercase tracking-[0.14em] text-muted-text">
                  {[c.console.cols.camera, c.console.cols.pitch, c.console.cols.when, c.console.cols.height, c.console.cols.size, c.console.cols.status, ""].map((h, i) => <th key={i} className="px-4 py-3 text-start font-bold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} onClick={() => setOpen(s.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-raised/60" data-testid={`setup-${s.id}`}>
                    <td className="px-4 py-3 font-bold text-text">{s.kitName}</td>
                    <td className="px-4 py-3 text-text">{(c.locale === "ar" ? s.pitchNameAr || s.pitchName : s.pitchName) ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-muted-text">{when(s.startedAt ?? s.createdAt, c.locale)}</td>
                    <td className="px-4 py-3 font-mono" dir="ltr">{s.mastHeightM.toFixed(1)} m</td>
                    <td className="px-4 py-3 font-mono" dir="ltr">{s.measuredLengthM && s.measuredWidthM ? `${round1(s.measuredLengthM)} × ${round1(s.measuredWidthM)} m` : "—"}</td>
                    <td className="px-4 py-3"><StatusPill status={s.status} /></td>
                    <td className="px-4 py-3 text-end text-muted-text"><ChevronRight className="inline h-4 w-4 rtl:rotate-180" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="text-xs leading-5 text-muted-text">{c.console.footnote}</p>
      {adding && <AddKitDialog academyId={academyId} onClose={() => setAdding(false)} />}
      {wifiKit && <WifiDialog kit={wifiKit} onClose={() => setWifiKit(null)} />}
    </section>
  );
}

function KitCard({ kit, onWifi }: { kit: Kit; onWifi: () => void }) {
  const c = useKitCopy();
  const [copied, setCopied] = useState(false);
  const live = kit.latest?.status === "recording";
  const look = kit.latest?.status === "needs_look";
  const sticker = kit.token ? `${window.location.origin}/kit?k=${kit.token}` : null;
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-bold text-text">{kit.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-text">{kit.latest?.placeName ?? kit.cameraId}</p>
        </div>
        {live ? <StatusPill status="recording" /> : look ? <StatusPill status="needs_look" /> : <span className="rounded-full bg-turf/10 px-2 py-1 text-[11px] font-bold text-turf">{c.main.ready}</span>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {kit.wifiSsid && <span className="inline-flex items-center gap-1.5 text-xs text-muted-text"><Wifi className="h-3.5 w-3.5" /><span dir="ltr">{kit.wifiSsid}</span></span>}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-text"><Video className="h-3.5 w-3.5" /><span dir="ltr">{kit.cameraId}</span></span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {sticker && (
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(sticker).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line bg-raised px-3 text-xs font-semibold text-text">
            {copied ? <Check className="h-3.5 w-3.5 text-turf" /> : <Copy className="h-3.5 w-3.5" />}{c.console.sticker}
          </button>
        )}
        <button type="button" onClick={onWifi} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line bg-raised px-3 text-xs font-semibold text-text"><Wifi className="h-3.5 w-3.5" />WiFi</button>
      </div>
    </div>
  );
}

function ReviewPanel({ setup, onBack }: { setup: KitSetup; onBack: () => void }) {
  const c = useKitCopy();
  const r = c.console.review;
  const review = useReviewSetup(setup.id);
  const cal = setup.calibration;
  const l = setup.measuredLengthM, w = setup.measuredWidthM;
  const nums: Array<[string, string, string?]> = [
    [r.numbers.pitch, l && w ? `${round1(l)} × ${round1(w)} m` : "—", setup.knownLengthM && setup.knownWidthM ? r.numbers.saved(setup.knownLengthM, setup.knownWidthM) : undefined],
    [r.numbers.height, `${setup.mastHeightM.toFixed(1)} m`, r.numbers.entered],
    [r.numbers.angle, cal?.tiltDeg != null ? r.numbers.tilt(round1(cal.tiltDeg), round1(Math.abs(cal.rollDeg ?? 0))) : "—"],
    [r.numbers.lines, cal?.linesPx != null ? `${round1(cal.linesPx)} px` : "—", r.numbers.linesGood],
    [r.numbers.circle, cal?.circleAspectPct != null ? r.numbers.round(Math.round(cal.circleAspectPct)) : "—"],
    [r.numbers.players, cal?.statureM != null ? r.numbers.tall(Math.round(cal.statureM * 100) / 100) : "—"],
  ];
  const reviewable = ["measured", "needs_look", "approved"].includes(setup.status);
  return (
    <section className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-muted-text hover:text-text"><ArrowLeft className="h-4 w-4 rtl:rotate-180" />{r.back}</button>
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-text">{setup.kitName} · {(c.locale === "ar" ? setup.pitchNameAr || setup.pitchName : setup.pitchName) ?? "—"}</h1>
          <p className="mt-1 text-sm text-muted-text">{r.setUpBy(when(setup.startedAt ?? setup.createdAt, c.locale))}{setup.title ? ` · ${setup.title}` : ""}</p>
        </div>
        <StatusPill status={setup.status} />
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-raised" style={{ aspectRatio: "3840 / 1080" }}>
            {cal?.overlayUrl ? <img src={cal.overlayUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-muted-text"><Ruler className="me-2 h-4 w-4" />{setup.hasModel ? "" : r.notYet}</div>}
          </div>
          {(cal?.warnings?.length ?? 0) > 0 && (
            <Card>
              <h2 className="font-display text-2xl font-bold text-text">{r.why}</h2>
              <ul className="mt-3 space-y-3">
                {cal!.warnings!.map((wn) => (
                  <li key={wn} className="flex gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#FF5A3C]/15 text-[#FF5A3C]"><AlertTriangle className="h-[18px] w-[18px]" /></span><span className="pt-2 text-sm text-text">{wn}</span></li>
                ))}
              </ul>
              {setup.status === "needs_look" && <p className="mt-4 text-xs leading-5 text-muted-text">{r.hold}</p>}
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {nums.map(([label, value, hint]) => (
              <div key={label} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                <span className="text-xs text-muted-text">{label}</span>
                <span className="text-end"><span className="block font-mono font-bold" dir="ltr">{value}</span>{hint && <span className="block text-xs text-muted-text">{hint}</span>}</span>
              </div>
            ))}
          </div>
          {reviewable && (
            <div className="flex flex-col gap-2">
              {setup.hasModel && setup.status !== "approved" && <Button type="button" disabled={review.isPending} onClick={() => review.mutate({ action: "approve" })} className="min-h-11 rounded-xl bg-floodlight font-bold text-void"><Check className="me-2 h-4 w-4" />{r.approve}</Button>}
              {setup.hasModel && setup.knownLengthM && setup.knownWidthM && <button type="button" disabled={review.isPending} onClick={() => review.mutate({ action: "use_saved" })} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-raised px-4 text-sm font-semibold text-text"><Ruler className="h-4 w-4" />{r.useSaved(setup.knownLengthM, setup.knownWidthM)}</button>}
              <button type="button" disabled={review.isPending} onClick={() => review.mutate({ action: "remeasure" })} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-raised px-4 text-sm font-semibold text-text"><RotateCcw className="h-4 w-4" />{r.remeasure}</button>
              <ErrorText error={review.error} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AddKitDialog({ academyId, onClose }: { academyId: number; onClose: () => void }) {
  const c = useKitCopy();
  const f = c.console.addForm;
  const add = useAddKit();
  const [name, setName] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate({ academyId, name: name.trim(), cameraId: cameraId.trim(), wifiSsid: ssid.trim() || null, wifiPassword: password || null, localUrl: localUrl.trim() || null }, { onSuccess: onClose });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={c.locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text sm:max-w-md">
        <DialogHeader className="text-start"><DialogTitle>{f.title}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5"><Label>{f.name}</Label><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="Kit 1" /></div>
          <div className="space-y-1.5"><Label>{f.camera}</Label><Input value={cameraId} onChange={(e) => setCameraId(e.target.value)} required dir="ltr" placeholder="camera3" /><p className="text-xs text-muted-text">{f.cameraHint}</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>{f.ssid}</Label><Input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} dir="ltr" placeholder="ReplayKit1" /></div>
            <div className="space-y-1.5"><Label>{f.password}</Label><Input value={password} onChange={(e) => setPassword(e.target.value)} maxLength={63} dir="ltr" /></div>
          </div>
          <div className="space-y-1.5"><Label>{f.local}</Label><Input value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} dir="ltr" placeholder="https://kit1.lan.replayjo.com" /><p className="text-xs text-muted-text">{f.localHint}</p></div>
          <ErrorText error={add.error} />
          <Button type="submit" disabled={add.isPending} className="min-h-11 w-full bg-floodlight font-bold text-void">{f.save}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WifiDialog({ kit, onClose }: { kit: Kit; onClose: () => void }) {
  const c = useKitCopy();
  const wifi = useKitWifi(kit.id);
  const [ssid, setSsid] = useState(kit.wifiSsid ?? "");
  const [password, setPassword] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={c.locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text sm:max-w-md">
        <DialogHeader className="text-start"><DialogTitle>{c.console.wifi.title} · {kit.name}</DialogTitle></DialogHeader>
        <p className="text-xs leading-5 text-muted-text">{c.console.wifi.hint}</p>
        <form onSubmit={(e) => { e.preventDefault(); wifi.mutate({ ssid: ssid.trim(), password }, { onSuccess: onClose }); }} className="space-y-3">
          <div className="space-y-1.5"><Label>{c.connect.network}</Label><Input value={ssid} onChange={(e) => setSsid(e.target.value)} required maxLength={32} dir="ltr" /></div>
          <div className="space-y-1.5"><Label>{c.connect.password}</Label><Input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={63} dir="ltr" /></div>
          <ErrorText error={wifi.error} />
          <Button type="submit" disabled={wifi.isPending} className="min-h-11 w-full bg-floodlight font-bold text-void">{c.console.wifi.save}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

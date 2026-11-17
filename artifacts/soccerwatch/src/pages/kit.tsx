import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  Battery,
  Check,
  Copy,
  Loader2,
  MapPin,
  Minus,
  Plus,
  QrCode,
  RefreshCw,
  Ruler,
  Trophy,
  Video,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useKitCopy } from "@/i18n/kit-strings";
import { cn } from "@/lib/utils";
import {
  kitSnapshotUrl,
  localFileUrl,
  localRecordings,
  useCancelSetup,
  useCreateSetup,
  useKitAccess,
  useKitByToken,
  useKitPlaces,
  useKits,
  useKitSetup,
  useKitStatus,
  usePatchSetup,
  useStartSetup,
  useStopSetup,
  type Kit,
  type KitPlace,
  type KitSetup,
  type KitSetupKind,
  type LocalRecording,
} from "@/lib/kits-api";

/**
 * Me → Set up a camera (Labs, hidden unless switched on). Built from the same parts as
 * Book a recording: numbered steps, turf-selected cards, floodlight pill buttons.
 *
 *   /kit                 pick the kit (or ?k=<sticker token>) → pitch → WiFi → mast
 *   /kit/s/:id           the set-up: view check → what we record → recording → result
 *   /kit/s/:id/watch     Watch on the pitch, straight off the camera's card
 */

const SIZES = ["5", "6", "7", "8", "9", "11"];
const MINUTES = [60, 90, 120, 180];
const cardSelected = "border-turf bg-turf/10";
const cardIdle = "border-line bg-surface";

function Page({ ar, children }: { ar: boolean; children: React.ReactNode }) {
  return <div dir={ar ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto no-scrollbar px-4 pb-32 pt-3 text-text">{children}</div>;
}

function Back({ label, href, onClick }: { label: string; href?: string; onClick?: () => void }) {
  const cls = "inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-muted-text hover:text-text";
  const body = <><ArrowLeft className="h-4 w-4 rtl:rotate-180" />{label}</>;
  return onClick ? <button type="button" onClick={onClick} className={cls}>{body}</button> : <Link href={href ?? "/account"} className={cls}>{body}</Link>;
}

function Title({ title, sub }: { title: string; sub?: string }) {
  return <>
    <h1 className="mt-3 font-display text-3xl font-bold">{title}</h1>
    {sub && <p className="mt-1 text-sm text-muted-text">{sub}</p>}
  </>;
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <p className="mb-2 flex items-center gap-2 text-sm font-bold">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-raised font-mono text-xs">{n}</span>{label}
      </p>
      {children}
    </section>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return <section className="mt-5 rounded-3xl border border-turf/25 p-4" style={{ background: "radial-gradient(120% 120% at 100% 0%, rgba(47,216,196,.12), transparent 60%), #141B2C" }}>{children}</section>;
}

function Primary({ children, disabled, onClick, busy }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; busy?: boolean }) {
  return (
    <button type="button" disabled={disabled || busy} onClick={onClick} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight text-base font-bold text-void disabled:opacity-40">
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}{children}
    </button>
  );
}

function Secondary({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) {
  return <button type="button" onClick={onClick} className={cn("flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-line bg-raised text-[15px] font-semibold", className)}>{children}</button>;
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="mt-3 text-sm text-red-400" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}

function ammanTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Amman", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function ammanDay(iso: string, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { timeZone: "Asia/Amman", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}

function ammanToday(): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ─── /kit ────────────────────────────────────────────────────────────────────

type Draft = { kit: Kit | null; pitchId: number | null; elsewhere: boolean; placeName: string; placeSize: string; length: string; width: string; height: string };
type FlowStep = "pick" | "place" | "connect" | "mast";

export function KitSetupStart() {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const [, setLocation] = useLocation();
  const token = new URLSearchParams(useSearch()).get("k");
  const access = useKitAccess();
  const enabled = access.data?.enabled === true;
  const kits = useKits(enabled);
  const byToken = useKitByToken(enabled ? token : null);
  const [step, setStep] = useState<FlowStep>("pick");
  const [draft, setDraft] = useState<Draft>({ kit: null, pitchId: null, elsewhere: false, placeName: "", placeSize: "5", length: "", width: "", height: "" });
  const places = useKitPlaces(draft.kit?.id ?? null);
  const create = useCreateSetup(draft.kit?.id ?? null);

  // A scanned sticker skips straight to the pitch.
  useEffect(() => {
    if (byToken.data?.kit && !draft.kit) { setDraft((d) => ({ ...d, kit: byToken.data!.kit })); setStep("place"); }
  }, [byToken.data, draft.kit]);

  // A kit already set up somewhere opens that set-up instead of a second one.
  const open = (kit: Kit) => {
    if (kit.latest && ["setting_up", "recording"].includes(kit.latest.status)) { setLocation(`/kit/s/${kit.latest.id}`); return; }
    setDraft((d) => ({ ...d, kit, pitchId: null, elsewhere: false })); setStep("place");
  };

  if (access.isLoading) return <Page ar={ar}><Loader2 className="mx-auto mt-16 h-6 w-6 animate-spin text-muted-text" /></Page>;
  if (!enabled) return <Page ar={ar}><Back label={c.back} /><Title title={c.main.title} /><p className="mt-3 rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{c.main.none}</p></Page>;

  if (step === "pick" || !draft.kit) {
    const list = kits.data?.kits ?? [];
    return (
      <Page ar={ar}>
        <Back label={c.back} />
        <Title title={c.main.title} sub={c.main.sub} />
        <Info>
          <div className="flex gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-floodlight text-void"><QrCode className="h-[18px] w-[18px]" /></span>
            <span><span className="block text-sm font-semibold">{c.main.scanTitle}</span><span className="block text-xs leading-5 text-muted-text">{c.main.scanBody}</span></span>
          </div>
        </Info>
        {token && byToken.isError && <ErrorLine error={byToken.error ?? c.main.unknownSticker} />}
        <Step n={1} label={c.main.pick}>
          {kits.isLoading ? <div className="h-20 animate-pulse rounded-2xl bg-raised" /> : list.length === 0 ? (
            <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{c.main.none}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {list.map((kit) => {
                const live = kit.latest?.status === "recording";
                return (
                  <button key={kit.id} type="button" onClick={() => open(kit)} className={cn("flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors", cardIdle)} data-testid={`kit-${kit.id}`}>
                    <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-xl bg-raised text-turf"><Video className="h-5 w-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{kit.name}</span>
                      <span className="block truncate text-xs leading-5 text-muted-text">{kit.latest ? c.main.lastAt(kit.latest.placeName ?? "—", ammanDay(kit.latest.createdAt, c.locale)) : c.main.neverUsed}</span>
                    </span>
                    {live
                      ? <span className="rounded-full bg-[#FF5A3C]/15 px-2 py-1 text-[11px] font-bold text-[#FF5A3C]">● {c.main.recording}</span>
                      : <span className="rounded-full bg-turf/10 px-2 py-1 text-[11px] font-bold text-turf">{c.main.ready}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </Step>
      </Page>
    );
  }

  const kit = draft.kit;
  const pitches = places.data?.pitches ?? [];
  const chosen = pitches.find((p) => p.id === draft.pitchId) ?? null;

  if (step === "place") {
    const lengthN = Number(draft.length.replace(",", ".")), widthN = Number(draft.width.replace(",", "."));
    const sizeOk = (!draft.length && !draft.width) || (lengthN >= 10 && lengthN <= 130 && widthN >= 5 && widthN <= 100);
    const ready = draft.elsewhere ? draft.placeName.trim().length > 0 && sizeOk : draft.pitchId != null;
    return (
      <Page ar={ar}>
        <Back label={c.back} onClick={() => setStep("pick")} />
        <Title title={c.place.title} sub={c.place.sub} />
        <Step n={1} label={c.place.pitch}>
          <div className="flex flex-col gap-2">
            {places.isLoading && <div className="h-20 animate-pulse rounded-2xl bg-raised" />}
            {pitches.map((p) => <PlaceButton key={p.id} p={p} on={!draft.elsewhere && draft.pitchId === p.id} venue={places.data?.venueName ?? null} onClick={() => setDraft((d) => ({ ...d, pitchId: p.id, elsewhere: false }))} />)}
            <button type="button" onClick={() => setDraft((d) => ({ ...d, elsewhere: true, pitchId: null }))} className={cn("flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors", draft.elsewhere ? cardSelected : cardIdle)}>
              <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-xl bg-raised text-turf"><Plus className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-bold">{c.place.elsewhere}</span><span className="block text-xs leading-5 text-muted-text">{c.place.elsewhereHint}</span></span>
            </button>
          </div>
        </Step>
        {!draft.elsewhere && chosen && (chosen.measured || (chosen.lengthM && chosen.widthM)) && (
          <Info>
            <div className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised text-turf"><Ruler className="h-[18px] w-[18px]" /></span>
              <span><span className="block text-sm font-semibold">{c.place.knownTitle}</span><span className="block text-xs leading-5 text-muted-text">{c.place.knownBody(chosen.lengthM ?? round1(chosen.measured!.lengthM), chosen.widthM ?? round1(chosen.measured!.widthM))}</span></span>
            </div>
          </Info>
        )}
        {draft.elsewhere && <>
          <Step n={2} label={c.place.name}>
            <input value={draft.placeName} onChange={(e) => setDraft((d) => ({ ...d, placeName: e.target.value }))} maxLength={80} placeholder={c.place.namePh}
              className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text outline-none focus:border-turf" />
          </Step>
          <Step n={3} label={c.place.size}>
            <div className="grid grid-cols-3 gap-2">
              {SIZES.map((s) => (
                <button key={s} type="button" onClick={() => setDraft((d) => ({ ...d, placeSize: s }))}
                  className={cn("min-h-11 rounded-xl border text-sm font-semibold", draft.placeSize === s ? "border-turf bg-turf/15 text-turf" : "border-line bg-surface")}>{c.place.sizes(s)}</button>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-text">{c.place.exact}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input value={draft.length} onChange={(e) => setDraft((d) => ({ ...d, length: e.target.value }))} inputMode="decimal" placeholder={c.place.length} className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text outline-none focus:border-turf" />
              <input value={draft.width} onChange={(e) => setDraft((d) => ({ ...d, width: e.target.value }))} inputMode="decimal" placeholder={c.place.width} className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text outline-none focus:border-turf" />
            </div>
          </Step>
        </>}
        <Primary disabled={!ready} onClick={() => setStep("connect")}>{c.cont}</Primary>
      </Page>
    );
  }

  if (step === "connect") {
    return <ConnectStep kit={kit} onBack={() => setStep("place")} onNext={() => setStep("mast")} />;
  }

  // mast
  const heightN = Number(draft.height.replace(",", "."));
  const heightOk = Number.isFinite(heightN) && heightN >= 1 && heightN <= 20;
  const submit = () => {
    const lengthN = Number(draft.length.replace(",", ".")), widthN = Number(draft.width.replace(",", "."));
    create.mutate(draft.elsewhere
      ? { placeName: draft.placeName.trim(), placeSize: draft.placeSize, knownLengthM: draft.length ? lengthN : null, knownWidthM: draft.width ? widthN : null, mastHeightM: round1(heightN) }
      : { pitchId: draft.pitchId, mastHeightM: round1(heightN) },
    { onSuccess: (r) => setLocation(`/kit/s/${r.setup.id}`) });
  };
  return (
    <Page ar={ar}>
      <Back label={c.back} onClick={() => setStep("connect")} />
      <Title title={c.mast.title} sub={c.mast.sub} />
      <MastDiagram height={heightOk ? `${round1(heightN)} m` : "? m"} back={c.mast.back} side={c.mast.side} />
      <Step n={1} label={c.mast.height}>
        <HeightInput value={draft.height} onChange={(v) => setDraft((d) => ({ ...d, height: v }))} />
        <p className="mt-2 text-xs leading-5 text-muted-text">{c.mast.heightHint}</p>
      </Step>
      <Checklist n={2} title={c.mast.before} items={[c.mast.goals, c.mast.straight, c.mast.cover]} onAll={() => undefined} />
      <ErrorLine error={create.error} />
      <Primary disabled={!heightOk} busy={create.isPending} onClick={submit}>{c.mast.next}</Primary>
    </Page>
  );
}

function PlaceButton({ p, on, venue, onClick }: { p: KitPlace; on: boolean; venue: string | null; onClick: () => void }) {
  const c = useKitCopy();
  const name = c.locale === "ar" ? p.nameAr || p.name : p.name;
  const line = p.measured
    ? c.place.measured(round1(p.measured.lengthM), round1(p.measured.widthM), p.measured.setups)
    : p.lengthM && p.widthM ? c.place.saved(p.lengthM, p.widthM) : c.place.notMeasured;
  return (
    <button type="button" onClick={onClick} className={cn("flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors", on ? cardSelected : cardIdle)}>
      <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-xl bg-raised text-turf"><Trophy className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{venue ? `${venue} · ${name}` : name}</span><span className="block truncate text-xs leading-5 text-muted-text">{line}</span></span>
      {on && <Check className="h-5 w-5 shrink-0 text-turf" />}
    </button>
  );
}

function HeightInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const n = Number(value.replace(",", "."));
  const has = value.trim() !== "" && Number.isFinite(n);
  const nudge = (d: number) => onChange(String(Math.max(1, Math.min(20, round1(n + d)))));
  return (
    <div className="flex items-stretch gap-2">
      <button type="button" aria-label="−0.1 m" disabled={!has} onClick={() => nudge(-0.1)} className="flex min-h-[52px] w-[52px] items-center justify-center rounded-xl border border-line bg-surface disabled:opacity-40"><Minus className="h-5 w-5" /></button>
      <label className="flex min-h-[52px] flex-1 items-center justify-center gap-1 rounded-xl border border-line bg-surface px-3 focus-within:border-turf">
        <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ""))} inputMode="decimal" placeholder="—" aria-label="m"
          className="w-20 bg-transparent text-center font-mono text-[22px] font-bold text-text outline-none placeholder:text-muted-text" data-testid="input-mast-height" />
        <span className="font-mono text-[22px] font-bold text-muted-text">m</span>
      </label>
      <button type="button" aria-label="+0.1 m" disabled={!has} onClick={() => nudge(0.1)} className="flex min-h-[52px] w-[52px] items-center justify-center rounded-xl border border-line bg-surface disabled:opacity-40"><Plus className="h-5 w-5" /></button>
    </div>
  );
}

function Checklist({ n, title, items, onAll }: { n: number; title: string; items: string[]; onAll: (all: boolean) => void }) {
  const [done, setDone] = useState<boolean[]>(items.map(() => false));
  useEffect(() => { onAll(done.every(Boolean)); }, [done, onAll]);
  return (
    <Step n={n} label={title}>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {items.map((item, i) => (
          <label key={item} className={cn("flex min-h-12 items-center justify-between gap-3 px-4 py-2.5 text-sm", i > 0 && "border-t border-line")}>
            <span className={done[i] ? "text-text" : "text-muted-text"}>{item}</span>
            <Switch checked={done[i]} onCheckedChange={(v) => setDone((d) => d.map((x, j) => (j === i ? v : x)))} />
          </label>
        ))}
      </div>
    </Step>
  );
}

function MastDiagram({ height, back, side }: { height: string; back: string; side: string }) {
  return (
    <div className="mt-4 flex justify-center rounded-2xl border border-line bg-surface pb-1 pt-2.5" aria-hidden="true" dir="ltr">
      <svg width="100%" viewBox="0 0 356 150" fill="none" strokeLinecap="round" style={{ maxWidth: 356 }}>
        <line x1="10" y1="128" x2="346" y2="128" stroke="#232c42" strokeWidth="2" />
        <rect x="80" y="126" width="266" height="4" rx="2" fill="#2fd8c4" opacity=".35" />
        <line x1="48" y1="128" x2="48" y2="30" stroke="#8a93a6" strokeWidth="3" />
        <line x1="38" y1="128" x2="58" y2="128" stroke="#8a93a6" strokeWidth="3" />
        <rect x="40" y="20" width="22" height="12" rx="3" fill="#d4ff4f" />
        <path d="M60 30 L346 112 M60 30 L84 126" stroke="#d4ff4f" strokeWidth="1.2" strokeDasharray="4 4" opacity=".6" />
        <line x1="24" y1="26" x2="24" y2="128" stroke="#d4ff4f" strokeWidth="1.5" />
        <line x1="19" y1="26" x2="29" y2="26" stroke="#d4ff4f" strokeWidth="1.5" />
        <line x1="19" y1="128" x2="29" y2="128" stroke="#d4ff4f" strokeWidth="1.5" />
        <text x="16" y="82" fill="#d4ff4f" fontFamily="ui-monospace,Menlo,monospace" fontSize="12" fontWeight="700" transform="rotate(-90 16 82)" textAnchor="middle">{height}</text>
        <line x1="48" y1="140" x2="80" y2="140" stroke="#8a93a6" strokeWidth="1" />
        <text x="64" y="149" fill="#8a93a6" fontFamily="Inter,sans-serif" fontSize="9" textAnchor="middle">{back}</text>
        <text x="212" y="146" fill="#8a93a6" fontFamily="Inter,sans-serif" fontSize="10" textAnchor="middle">{side}</text>
      </svg>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const c = useKitCopy();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="min-w-0"><span className="block text-xs text-muted-text">{label}</span><span className="block truncate font-mono text-base font-bold" dir="ltr">{value}</span></span>
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-xs font-semibold">
        {copied ? <Check className="h-3.5 w-3.5 text-turf" /> : <Copy className="h-3.5 w-3.5" />}{copied ? c.connect.copied : c.connect.copy}
      </button>
    </div>
  );
}

function ConnectStep({ kit, onBack, onNext }: { kit: Kit; onBack: () => void; onNext: () => void }) {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const status = useKitStatus(kit.id, true);
  const s = status.data;
  return (
    <Page ar={ar}>
      <Back label={c.back} onClick={onBack} />
      <Title title={c.connect.title} sub={c.connect.sub} />
      {kit.wifiSsid ? (
        <div className="mt-5 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          <CopyField label={c.connect.network} value={kit.wifiSsid} />
          {kit.wifiPassword && <CopyField label={c.connect.password} value={kit.wifiPassword} />}
        </div>
      ) : <p className="mt-5 rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{c.connect.noWifi}</p>}
      <div className={cn("mt-3 flex items-center gap-3 rounded-2xl border px-4 py-3.5", s?.online ? "border-turf/50 bg-turf/[0.08]" : "border-line bg-surface")}>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", s?.online ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>
          {status.isLoading ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : s?.online ? <Wifi className="h-[18px] w-[18px]" /> : <WifiOff className="h-[18px] w-[18px]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{status.isLoading ? c.connect.checking : s?.online ? (s.ssid ? c.connect.onlineOn(s.ssid) : c.connect.online) : c.connect.offline}</span>
          {!status.isLoading && !s?.online && <span className="block text-xs leading-5 text-muted-text">{s?.reason === "unsupported" ? c.connect.unsupported : c.connect.offlineHint}</span>}
        </span>
        {s?.battery != null && <span className="inline-flex items-center gap-1 text-xs text-muted-text"><Battery className="h-3.5 w-3.5" />{c.connect.battery(s.battery)}</span>}
      </div>
      <Primary onClick={onNext}>{c.cont}</Primary>
    </Page>
  );
}

// ─── /kit/s/:id ──────────────────────────────────────────────────────────────

export function KitSetupPage() {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const params = useParams<{ id: string }>();
  const id = Number(params.id) || null;
  const q = useKitSetup(id, true);
  const setup = q.data?.setup;

  if (q.isLoading) return <Page ar={ar}><Loader2 className="mx-auto mt-16 h-6 w-6 animate-spin text-muted-text" /></Page>;
  if (q.isError || !setup) return <Page ar={ar}><Back label={c.back} href="/kit" /><ErrorLine error={q.error ?? c.errors.generic} /></Page>;
  if (setup.status === "setting_up" && !setup.viewConfirmedAt) return <ViewStep setup={setup} />;
  if (setup.status === "setting_up") return <SessionStep setup={setup} />;
  if (setup.status === "recording" && !setup.stoppedAt) return <RecordingStep setup={setup} />;
  return <AfterStep setup={setup} />;
}

function ViewStep({ setup }: { setup: KitSetup }) {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const [, setLocation] = useLocation();
  const [bust, setBust] = useState(() => Date.now());
  const [shot, setShot] = useState<{ url?: string; state: "loading" | "ok" | "none" | "failed" }>({ state: "loading" });
  const [allOk, setAllOk] = useState(false);
  const patch = usePatchSetup(setup.id);
  const cancel = useCancelSetup(setup.id);

  useEffect(() => {
    let url: string | undefined;
    let alive = true;
    setShot({ state: "loading" });
    fetch(kitSnapshotUrl(setup.id, bust), { credentials: "include" }).then(async (r) => {
      if (!alive) return;
      if (r.status === 501) { setShot({ state: "none" }); return; }
      if (!r.ok) { setShot({ state: "failed" }); return; }
      url = URL.createObjectURL(await r.blob());
      setShot({ url, state: "ok" });
    }).catch(() => alive && setShot({ state: "failed" }));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [setup.id, bust]);

  return (
    <Page ar={ar}>
      <Back label={c.back} onClick={() => cancel.mutate({}, { onSuccess: () => setLocation("/kit") })} />
      <Title title={c.view.title} sub={c.view.sub} />
      <div className="relative mt-4 overflow-hidden rounded-2xl border border-line bg-raised" style={{ aspectRatio: "3840 / 1080" }}>
        {shot.state === "ok" && <img src={shot.url} alt="" className="h-full w-full object-cover" />}
        {shot.state === "loading" && <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-text" /></div>}
        {(shot.state === "none" || shot.state === "failed") && <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-text"><Video className="me-2 h-4 w-4 shrink-0" />{shot.state === "none" ? c.view.noPreview : c.view.failed}</div>}
        {shot.state === "ok" && <span className="absolute end-2 top-1.5 rounded-full bg-[#FF5A3C] px-2 py-0.5 text-[10px] font-bold text-white">LIVE</span>}
      </div>
      {shot.state !== "none" && <Secondary className="mt-3 min-h-10 text-sm" onClick={() => setBust(Date.now())}><RefreshCw className="h-4 w-4" />{c.view.refresh}</Secondary>}
      <Checklist n={1} title={c.mast.before} items={[c.view.corners, c.view.level]} onAll={setAllOk} />
      <Info><div className="flex gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised text-turf"><Ruler className="h-[18px] w-[18px]" /></span><span className="text-xs leading-5 text-muted-text">{c.view.after}</span></div></Info>
      <ErrorLine error={patch.error} />
      <Primary disabled={!allOk} busy={patch.isPending} onClick={() => patch.mutate({ viewConfirmed: true })}>{c.view.ok}</Primary>
    </Page>
  );
}

function SessionStep({ setup }: { setup: KitSetup }) {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const [kind, setKind] = useState<KitSetupKind>(setup.kind);
  const [title, setTitle] = useState(setup.title ?? "");
  const [minutes, setMinutes] = useState(90);
  const start = useStartSetup(setup.id);
  const patch = usePatchSetup(setup.id);
  return (
    <Page ar={ar}>
      <Back label={c.back} onClick={() => patch.mutate({ viewConfirmed: false })} />
      <Title title={c.session.title} />
      <Step n={1} label={c.session.type}>
        <div className="flex flex-wrap gap-2">
          {(["match", "training", "session"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded-2xl border px-4 py-2.5 text-sm font-semibold", kind === k ? "border-turf bg-turf text-void" : "border-line bg-surface text-text")}>{c.session.kinds[k]}</button>
          ))}
        </div>
      </Step>
      <Step n={2} label={c.session.name}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={c.session.namePh} className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-text outline-none focus:border-turf" />
      </Step>
      <Step n={3} label={c.session.howLong}>
        <div className="grid grid-cols-4 gap-2">
          {MINUTES.map((m) => (
            <button key={m} type="button" onClick={() => setMinutes(m)} className={cn("min-h-11 rounded-xl border text-sm font-semibold", minutes === m ? "border-turf bg-turf/15 text-turf" : "border-line bg-surface")}>{c.session.minutes(m)}</button>
          ))}
        </div>
      </Step>
      <div className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
        <span><span className="block text-sm font-semibold">{c.session.stats}</span><span className="block text-xs leading-5 text-muted-text">{c.session.statsHint}</span></span>
        <Check className="h-5 w-5 text-turf" />
      </div>
      <ErrorLine error={start.error} />
      <Primary busy={start.isPending} onClick={() => start.mutate({ minutes, kind, title: title.trim() || null })}><Video className="h-[18px] w-[18px]" />{c.session.start}</Primary>
    </Page>
  );
}

function useElapsed(startIso: string | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!startIso) return "00:00:00";
  const s = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, "0")).join(":");
}

function RecordingStep({ setup }: { setup: KitSetup }) {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const elapsed = useElapsed(setup.startedAt);
  const stop = useStopSetup(setup.id);
  const status = useKitStatus(setup.kitId, true);
  const name = setup.title || c.session.kinds[setup.kind];
  const place = c.locale === "ar" ? setup.pitchNameAr || setup.pitchName : setup.pitchName;
  return (
    <Page ar={ar}>
      <Back label={c.back} href="/home" />
      <Info>
        <div className="py-2 text-center">
          <span className="inline-flex rounded-full bg-[#FF5A3C] px-2.5 py-1 text-[11px] font-bold text-white">● {c.live.rec}</span>
          <p className="mt-3 font-mono text-[44px] font-bold leading-none tracking-wide" dir="ltr">{elapsed}</p>
          <p className="mt-2 text-sm text-muted-text">{name} · {place}</p>
          <p className="text-xs text-muted-text">{setup.kitName} · {c.live.stopsAt(ammanTime(setup.endsAt))}</p>
        </div>
      </Info>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Tile icon={<Ruler className="h-3.5 w-3.5" />} label={c.live.pitch} value={setup.knownLengthM && setup.knownWidthM ? `${setup.knownLengthM} × ${setup.knownWidthM} m` : "—"} hint={c.live.measuringSoon} />
        <Tile icon={<MapPin className="h-3.5 w-3.5" />} label={c.live.camera} value={`${setup.mastHeightM} m`} hint={c.live.height(setup.mastHeightM)} />
        <Tile icon={status.data?.online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />} label="WiFi" value={status.data?.online ? (status.data.ssid ?? "✓") : "—"} hint={status.data?.battery != null ? c.connect.battery(status.data.battery) : ""} />
        <Tile icon={<Video className="h-3.5 w-3.5" />} label={c.live.footage} value={c.status.recording} ltr={false} hint={setup.footage?.message ?? ""} />
      </div>
      {setup.localUrl && <Link href={`/kit/s/${setup.id}/watch`} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-line bg-raised text-[15px] font-semibold">{c.live.watch}</Link>}
      <ErrorLine error={stop.error} />
      <button type="button" disabled={stop.isPending} onClick={() => { if (window.confirm(c.live.stopConfirm)) stop.mutate({}); }}
        className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-[#FF5A3C]/50 bg-raised text-[15px] font-semibold text-[#FF5A3C] disabled:opacity-40">
        {stop.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{c.live.stop}
      </button>
    </Page>
  );
}

function Tile({ icon, label, value, hint, ltr = true }: { icon: React.ReactNode; label: string; value: string; hint?: string; ltr?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-text">{icon}{label}</span>
      <span className="mt-0.5 block truncate font-display text-[22px] font-bold rtl:text-right" dir={ltr ? "ltr" : undefined}>{value}</span>
      {hint && <span className="block truncate text-xs text-muted-text">{hint}</span>}
    </div>
  );
}

function AfterStep({ setup }: { setup: KitSetup }) {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const l = setup.measuredLengthM != null ? round1(setup.measuredLengthM) : null;
  const w = setup.measuredWidthM != null ? round1(setup.measuredWidthM) : null;
  const line =
    setup.status === "recording" ? c.after.pulling
      : setup.status === "measuring" ? c.after.measuring
        : setup.status === "measured" && l && w ? c.after.measured(l, w)
          : setup.status === "approved" && l && w ? c.after.approved(l, w)
            : setup.status === "needs_look" ? c.after.needsLook
              : setup.status === "failed" ? (setup.reviewNote || c.after.failed)
                : c.after.cancelled;
  const good = setup.status === "measured" || setup.status === "approved";
  const bad = setup.status === "failed" || setup.status === "needs_look";
  return (
    <Page ar={ar}>
      <Back label={c.back} href="/kit" />
      <Title title={c.after.title} sub={`${setup.title || c.session.kinds[setup.kind]} · ${(c.locale === "ar" ? setup.pitchNameAr || setup.pitchName : setup.pitchName) ?? ""}`} />
      <div className={cn("mt-5 flex items-center gap-3 rounded-2xl border px-4 py-3.5", good ? "border-turf/50 bg-turf/[0.08]" : bad ? "border-[#FF5A3C]/40 bg-[#FF5A3C]/[0.06]" : "border-line bg-surface")}>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", good ? "bg-turf/15 text-turf" : bad ? "bg-[#FF5A3C]/15 text-[#FF5A3C]" : "bg-raised text-muted-text")}>
          {good ? <Check className="h-[18px] w-[18px]" /> : bad ? <AlertTriangle className="h-[18px] w-[18px]" /> : <Loader2 className="h-[18px] w-[18px] animate-spin" />}
        </span>
        <span className="text-sm font-semibold">{line}</span>
      </div>
      {setup.footage && setup.status === "recording" && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-turf" style={{ width: `${Math.max(4, setup.footage.progress)}%` }} /></div>}
      {setup.localUrl && <Link href={`/kit/s/${setup.id}/watch`} className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-line bg-raised text-[15px] font-semibold">{c.live.watch}</Link>}
      <Link href="/kit" className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight text-base font-bold text-void">{c.after.newSetup}</Link>
    </Page>
  );
}

// ─── /kit/s/:id/watch ────────────────────────────────────────────────────────

export function KitWatchPage() {
  const c = useKitCopy();
  const ar = c.locale === "ar";
  const params = useParams<{ id: string }>();
  const id = Number(params.id) || null;
  const q = useKitSetup(id);
  const localUrl = q.data?.setup.localUrl ?? null;
  const [list, setList] = useState<{ state: "loading" | "ok" | "error"; items: LocalRecording[] }>({ state: "loading", items: [] });
  const [picked, setPicked] = useState<LocalRecording | null>(null);
  const [quality, setQuality] = useState<"sub" | "main">("sub");
  const [videoError, setVideoError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!localUrl) return;
    let alive = true;
    setList({ state: "loading", items: [] });
    localRecordings(localUrl, ammanToday())
      .then((items) => { if (!alive) return; setList({ state: "ok", items }); setPicked(items[items.length - 1] ?? null); })
      .catch(() => alive && setList({ state: "error", items: [] }));
    return () => { alive = false; };
  }, [localUrl]);

  const file = picked ? (quality === "main" ? picked.main ?? picked.sub : picked.sub ?? picked.main) : null;
  const src = useMemo(() => (localUrl && file ? localFileUrl(localUrl, file.name) : null), [localUrl, file]);
  useEffect(() => { setVideoError(false); }, [src]);

  return (
    <Page ar={ar}>
      <Back label={c.back} href={id ? `/kit/s/${id}` : "/kit"} />
      <Title title={c.watch.title} sub={c.watch.sub} />
      {q.data && !localUrl ? <p className="mt-5 rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{c.watch.noRelay}</p> : <>
        <div className="mt-5 grid grid-cols-2 gap-2">
          {(["sub", "main"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setQuality(k)} className={cn("min-h-12 rounded-xl border px-3 text-start", quality === k ? "border-turf bg-turf/15" : "border-line bg-surface")}>
              <span className={cn("block text-sm font-bold", quality === k && "text-turf")}>{k === "sub" ? c.watch.low : c.watch.high}</span>
              <span className="block text-xs text-muted-text">{k === "sub" ? c.watch.lowHint : c.watch.highHint}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: "3840 / 1080" }}>
          {src && <video ref={videoRef} key={src} src={src} controls playsInline preload="metadata" className="h-full w-full" onError={() => setVideoError(true)} />}
        </div>
        {videoError && <p className="mt-2 text-xs text-[#FF5A3C]">{quality === "main" ? c.watch.noHigh : c.watch.cantReach}</p>}
        {list.state === "loading" && <p className="mt-3 flex items-center gap-2 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{c.watch.loading}</p>}
        {list.state === "error" && <div className="mt-3 rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text"><p>{c.watch.cantReach}</p><p className="mt-1 text-xs">{c.watch.allow}</p></div>}
        {list.state === "ok" && list.items.length === 0 && <p className="mt-3 rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">{c.watch.none}</p>}
        {list.items.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {[...list.items].reverse().map((r) => (
              <button key={`${r.start}-${r.end}`} type="button" onClick={() => setPicked(r)} className={cn("flex items-center justify-between rounded-2xl border px-4 py-3 text-start", picked === r ? cardSelected : cardIdle)}>
                <span className="font-mono text-sm font-bold" dir="ltr">{r.start.slice(11, 16)}–{r.end.slice(11, 16)}</span>
                <span className="text-xs text-muted-text">{Math.round(((quality === "main" ? r.main?.size : r.sub?.size) ?? 0) / 1_000_000)} MB</span>
              </button>
            ))}
          </div>
        )}
      </>}
    </Page>
  );
}

export default KitSetupStart;

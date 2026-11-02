import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useStudioCopy } from "@/i18n/studio-strings";
import {
  apiUrl,
  brandingPreviewUrl,
  StudioError,
  useAcademyBranding,
  useBrandCrest,
  useBrandSetting,
  useSaveBrandLook,
  type AcademyBranding,
  type BrandingSetting,
  type BrandLook,
} from "@/lib/academy-studio-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-fA-F]{6}$/;
const KEYS = {
  overlayEnabled: "branding.overlayEnabled",
  style: "branding.overlayStyle",
  endOn: "branding.endScreenEnabled",
  seconds: "branding.endScreen.seconds",
  blur: "branding.endScreen.blur",
  dim: "branding.endScreen.dim",
  endCard: "branding.endCardEnabled",
} as const;
const CARD_KEYS = ["branding.endScreen.academy", "branding.endScreen.player", "branding.endScreen.match", "branding.endScreen.signOff"];
const STYLES = ["cornerCrest", "broadcastBar", "academyFrame", "uploaded"];
const PREVIEW_KINDS: Array<{ what: string; video: boolean }> = [
  { what: "signOff", video: true },
  { what: "academy", video: true },
  { what: "match", video: true },
  { what: "player", video: true },
  { what: "cornerCrest", video: false },
  { what: "broadcastBar", video: false },
  { what: "academyFrame", video: false },
];

function Card({ title, hint, badge, children }: { title: string; hint?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-bold text-text">{title}</h3>
          {hint ? <p className="mt-1 text-xs leading-5 text-muted-text">{hint}</p> : null}
        </div>
        {badge}
      </div>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

function OriginBadge({ own, overridden, onReset, busy }: { own: boolean; overridden?: boolean; onReset?: () => void; busy?: boolean }) {
  const copy = useStudioCopy().branding;
  return (
    <span className="inline-flex items-center gap-2 text-[11px] font-semibold">
      <span className={cn("rounded-full px-2 py-0.5", own ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>
        {overridden ? copy.overridden : own ? copy.setByYou : copy.replayDefault}
      </span>
      {onReset && (own || overridden) ? (
        <button type="button" onClick={onReset} disabled={busy} className="inline-flex items-center gap-1 text-muted-text underline-offset-2 hover:text-text hover:underline disabled:opacity-50">
          <RotateCcw className="h-3 w-3" aria-hidden="true" />{copy.reset}
        </button>
      ) : null}
    </span>
  );
}

function ColourField({ id, label, value, onChange, optional }: { id: string; label: string; value: string; onChange: (v: string) => void; optional?: boolean }) {
  const copy = useStudioCopy().branding;
  const valid = HEX.test(value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-semibold text-muted-text">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className={cn("h-10 w-12 shrink-0 cursor-pointer rounded-xl border border-line bg-raised p-1", optional && !valid && "opacity-40")}
        />
        <Input id={id} dir="ltr" value={value} placeholder={optional ? copy.noColour : "#F4CF1F"} onChange={(e) => onChange(e.target.value)} className="w-32 font-mono" />
        {optional && value ? <Button type="button" variant="ghost" size="sm" className="text-muted-text" onClick={() => onChange("")}>{copy.clear}</Button> : null}
      </div>
    </div>
  );
}

function lookForm(look: BrandLook) {
  return {
    nameEn: look.nameEn ?? "",
    nameAr: look.nameAr ?? "",
    taglineAr: look.taglineAr ?? "",
    primaryColor: look.primaryColor ?? "#2FD8C4",
    accentColor: look.accentColor ?? "",
    bookingPhone: look.bookingPhone ?? "",
    instagram: look.instagram ?? "",
    showPlayerNames: look.showPlayerNames,
  };
}
type LookForm = ReturnType<typeof lookForm>;

function BrandKit({ academyId, data }: { academyId: number; data: AcademyBranding }) {
  const copy = useStudioCopy().branding;
  const save = useSaveBrandLook(academyId);
  const crest = useBrandCrest(academyId);
  const [form, setForm] = useState<LookForm>(() => lookForm(data.look));
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { setForm(lookForm(data.look)); }, [data.look]);
  const dirty = JSON.stringify(form) !== JSON.stringify(lookForm(data.look));
  useEffect(() => { if (dirty) setSaved(false); }, [dirty]);
  const set = (patch: Partial<LookForm>) => setForm((f) => ({ ...f, ...patch }));
  const error = save.error instanceof StudioError ? save.error : null;
  const submit = () => save.mutate({
    ...form,
    nameAr: form.nameAr.trim() || null,
    taglineAr: form.taglineAr.trim() || null,
    accentColor: form.accentColor.trim() || null,
    bookingPhone: form.bookingPhone.trim() || null,
    instagram: form.instagram.trim() || null,
  }, { onSuccess: () => setSaved(true) });
  const crestSrc = data.crest.src ? (data.crest.source === "own" ? apiUrl(data.crest.src) : data.crest.src) : null;

  return (
    <Card title={copy.kit} hint={copy.kitHint} badge={<OriginBadge own={data.hasOwnLook} />}>
      <div className="flex items-start gap-4">
        <span
          className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line"
          style={{ background: form.primaryColor && HEX.test(form.primaryColor) ? form.primaryColor : undefined }}
        >
          {crestSrc ? <img src={crestSrc} alt={copy.crest} className="h-full w-full object-contain p-2" /> : <span className="font-display text-2xl font-bold text-void">{form.nameEn.trim().slice(0, 2).toUpperCase()}</span>}
        </span>
        <div className="min-w-0 space-y-2">
          <p className="text-xs text-muted-text">{data.crest.source === "logo" ? copy.crestFromLogo : data.crest.source === "none" ? copy.crestNone : copy.crestHint}</p>
          <div className="flex flex-wrap gap-2">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="input-brand-crest"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) crest.mutate({ file: f }); e.target.value = ""; }} />
            <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={crest.isPending} onClick={() => file.current?.click()}>
              {crest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}<span className="ms-1.5">{copy.uploadCrest}</span>
            </Button>
            {data.logoUrl ? (
              <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={crest.isPending} onClick={() => crest.mutate({ fromLogo: true })}>{copy.useLogo}</Button>
            ) : null}
            {data.crest.source === "own" ? (
              <Button type="button" variant="ghost" size="sm" className="rounded-xl text-muted-text" disabled={crest.isPending} onClick={() => crest.mutate({ remove: true })}>
                <Trash2 className="h-4 w-4" /><span className="ms-1.5">{copy.removeCrest}</span>
              </Button>
            ) : null}
          </div>
          {crest.error ? <p className="text-xs text-red-400" role="alert">{(crest.error as Error).message}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="brand-name-en" className="text-xs font-semibold text-muted-text">{copy.nameEn}</Label>
          <Input id="brand-name-en" dir="ltr" maxLength={40} value={form.nameEn} onChange={(e) => set({ nameEn: e.target.value })} />
          {error?.field === "nameEn" ? <p className="text-xs text-red-400" role="alert">{error.message}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-name-ar" className="text-xs font-semibold text-muted-text">{copy.nameAr}</Label>
          <Input id="brand-name-ar" dir="rtl" maxLength={60} value={form.nameAr} onChange={(e) => set({ nameAr: e.target.value })} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="brand-tagline" className="text-xs font-semibold text-muted-text">{copy.tagline}</Label>
          <Input id="brand-tagline" dir="rtl" maxLength={60} placeholder={copy.taglinePlaceholder} value={form.taglineAr} onChange={(e) => set({ taglineAr: e.target.value })} />
        </div>
        <ColourField id="brand-main" label={copy.mainColour} value={form.primaryColor} onChange={(v) => set({ primaryColor: v })} />
        <ColourField id="brand-second" label={copy.secondColour} value={form.accentColor} onChange={(v) => set({ accentColor: v })} optional />
        <div className="space-y-1.5">
          <Label htmlFor="brand-phone" className="text-xs font-semibold text-muted-text">{copy.bookingPhone}</Label>
          <Input id="brand-phone" dir="ltr" inputMode="tel" maxLength={30} placeholder="079 123 4567" value={form.bookingPhone} onChange={(e) => set({ bookingPhone: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-instagram" className="text-xs font-semibold text-muted-text">{copy.instagram}</Label>
          <Input id="brand-instagram" dir="ltr" maxLength={41} placeholder={copy.instagramPlaceholder} value={form.instagram} onChange={(e) => set({ instagram: e.target.value })} />
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-raised/50 p-4">
        <div>
          <Label htmlFor="brand-show-names" className="text-sm font-semibold text-text">{copy.showNames}</Label>
          <p className="mt-1 text-xs leading-5 text-muted-text">{copy.showNamesNote}</p>
        </div>
        <Switch id="brand-show-names" checked={form.showPlayerNames} onCheckedChange={(v) => set({ showPlayerNames: v })} />
      </div>

      {error && error.field !== "nameEn" ? <p className="text-xs text-red-400" role="alert">{error.message}</p> : null}
      <div className="flex items-center gap-3">
        <Button type="button" className="rounded-xl bg-floodlight font-bold text-void" disabled={!dirty || save.isPending || !form.nameEn.trim()} onClick={submit} data-testid="button-save-brand">
          {save.isPending ? copy.saving : copy.save}
        </Button>
        {saved && !dirty ? <span className="inline-flex items-center gap-1 text-xs text-turf" role="status"><Check className="h-3.5 w-3.5" />{copy.saved}</span> : null}
      </div>
    </Card>
  );
}

function SliderRow({ setting, label, unit, step, onCommit, onReset, busy, dir }: {
  setting: BrandingSetting; label: string; unit: string; step: number; busy: boolean; dir: "rtl" | "ltr";
  onCommit: (v: number) => void; onReset: () => void;
}) {
  const [local, setLocal] = useState(Number(setting.value));
  useEffect(() => setLocal(Number(setting.value)), [setting.value]);
  return (
    <div className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-text">{label}: <bdi className="font-mono">{local}{unit}</bdi></span>
        <OriginBadge own={setting.source === "academy"} overridden={setting.overridden} onReset={onReset} busy={busy} />
      </div>
      <Slider
        dir={dir}
        min={setting.min ?? 0}
        max={setting.max ?? 100}
        step={step}
        value={[local]}
        disabled={busy}
        aria-label={label}
        onValueChange={(v) => setLocal(v[0])}
        onValueCommit={(v) => { if (v[0] !== Number(setting.value)) onCommit(v[0]); }}
      />
    </div>
  );
}

function ClipSettings({ academyId, data, onChanged }: { academyId: number; data: AcademyBranding; onChanged: () => void }) {
  const all = useStudioCopy();
  const copy = all.branding;
  const write = useBrandSetting(academyId);
  const byKey = useMemo(() => new Map(data.settings.map((s) => [s.key, s])), [data.settings]);
  const busyKey = write.isPending ? (write.variables as { key: string } | undefined)?.key : undefined;
  const change = (key: string, value: boolean | number | string) => write.mutate({ key, value }, { onSuccess: onChanged });
  const reset = (key: string) => write.mutate({ key, reset: true }, { onSuccess: onChanged });
  const s = (key: string) => byKey.get(key);
  const dir = all.locale === "ar" ? "rtl" : "ltr";

  const toggle = (key: string, label: string) => {
    const setting = s(key);
    if (!setting) return null;
    return (
      <div key={key} className="flex flex-wrap items-center justify-between gap-3 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-3 text-sm text-text">
          <Switch checked={setting.value === true} disabled={busyKey === key} onCheckedChange={(v) => change(key, v)} aria-label={label} />
          <span className="min-w-0">{label}</span>
        </label>
        <OriginBadge own={setting.source === "academy"} overridden={setting.overridden} onReset={() => reset(key)} busy={busyKey === key} />
      </div>
    );
  };

  const style = s(KEYS.style);
  const overlayOn = s(KEYS.overlayEnabled)?.value === true;
  const endOn = s(KEYS.endOn)?.value === true;
  const sizes = copy.sizes(`${data.outputSizes.portrait.w}×${data.outputSizes.portrait.h}`, `${data.outputSizes.landscape.w}×${data.outputSizes.landscape.h}`);

  return (
    <Card title={copy.clips} hint={`${copy.clipsHint} ${sizes}`}>
      {write.error ? <p className="text-xs text-red-400" role="alert">{(write.error as Error).message}</p> : null}
      <div>
        {toggle(KEYS.overlayEnabled, copy.overlay)}
        {style ? (
          <div className={cn("space-y-2 ps-4", !overlayOn && "opacity-50")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-text">{copy.overlayStyle}</span>
              <OriginBadge own={style.source === "academy"} overridden={style.overridden} onReset={() => reset(KEYS.style)} busy={busyKey === KEYS.style} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={copy.overlayStyle}>
              {STYLES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={style.value === option}
                  disabled={busyKey === KEYS.style}
                  onClick={() => style.value !== option && change(KEYS.style, option)}
                  className={cn(
                    "overflow-hidden rounded-xl border text-start transition-colors",
                    style.value === option ? "border-turf ring-1 ring-turf" : "border-line hover:border-turf/50",
                  )}
                >
                  <span className="block aspect-[9/16] max-h-40 w-full overflow-hidden bg-raised">
                    {option === "uploaded"
                      ? <span className="grid h-full place-items-center text-xs text-muted-text">{copy.styles.uploaded}</span>
                      : <img loading="lazy" alt="" className="h-full w-full object-cover object-top" src={brandingPreviewUrl(academyId, { what: option, aspect: "9:16", v: data.profile?.updatedAt ?? "0" })} />}
                  </span>
                  <span className="block px-2 py-1.5">
                    <span className="block text-xs font-semibold text-text">{copy.styles[option]}</span>
                    <span className="block text-[11px] leading-4 text-muted-text">{copy.styleHints[option]}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-line pt-2">
        {toggle(KEYS.endOn, copy.endScreen)}
        <div className={cn("ps-4", !endOn && "opacity-50")}>
          <p className="pt-1 text-xs font-semibold text-muted-text">{copy.whichCards}</p>
          {CARD_KEYS.map((key) => toggle(key, copy.cards[key]))}
          {s(KEYS.seconds) ? <SliderRow setting={s(KEYS.seconds)!} label={copy.length} unit={all.locale === "ar" ? " ث" : " s"} step={0.5} dir={dir} busy={busyKey === KEYS.seconds} onCommit={(v) => change(KEYS.seconds, v)} onReset={() => reset(KEYS.seconds)} /> : null}
          {s(KEYS.blur) ? <SliderRow setting={s(KEYS.blur)!} label={copy.blur} unit=" px" step={1} dir={dir} busy={busyKey === KEYS.blur} onCommit={(v) => change(KEYS.blur, v)} onReset={() => reset(KEYS.blur)} /> : null}
          {s(KEYS.dim) ? <SliderRow setting={s(KEYS.dim)!} label={copy.dim} unit="%" step={5} dir={dir} busy={busyKey === KEYS.dim} onCommit={(v) => change(KEYS.dim, v)} onReset={() => reset(KEYS.dim)} /> : null}
        </div>
      </div>
      <div className="border-t border-line pt-2">{toggle(KEYS.endCard, copy.endCard)}</div>
    </Card>
  );
}

function Preview({ academyId, data, version }: { academyId: number; data: AcademyBranding; version: number }) {
  const copy = useStudioCopy().branding;
  const [what, setWhat] = useState("signOff");
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  const [asVideo, setAsVideo] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const kind = PREVIEW_KINDS.find((k) => k.what === what)!;
  const value = (key: string) => String(data.settings.find((s) => s.key === key)?.value ?? "");
  const src = brandingPreviewUrl(academyId, {
    what, aspect, seconds: value(KEYS.seconds), blur: value(KEYS.blur), dim: value(KEYS.dim),
    v: `${data.profile?.updatedAt ?? "0"}-${version}`,
    ...(asVideo && kind.video ? { format: "mp4" } : {}),
  });
  return (
    <Card title={copy.preview} hint={copy.previewHint}>
      <div className="flex flex-wrap gap-2">
        {PREVIEW_KINDS.map((k) => (
          <button key={k.what} type="button" onClick={() => setWhat(k.what)}
            className={cn("rounded-full border px-3 py-1.5 text-xs font-semibold", what === k.what ? "border-turf bg-turf text-void" : "border-line text-muted-text hover:text-text")}>
            {copy.previewKinds[k.what]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        {(["9:16", "16:9"] as const).map((a) => (
          <button key={a} type="button" onClick={() => setAspect(a)}
            className={cn("rounded-lg border px-2.5 py-1 font-mono", aspect === a ? "border-turf text-turf" : "border-line text-muted-text")}>{a}</button>
        ))}
        {kind.video ? (
          <label className="flex items-center gap-2 text-text"><Switch checked={asVideo} onCheckedChange={setAsVideo} />{copy.playVideo}</label>
        ) : null}
      </div>
      <div className={cn("overflow-hidden rounded-xl border border-line bg-void", aspect === "9:16" ? "max-w-[260px]" : "max-w-[640px]")}>
        {failed === src ? <p className="p-4 text-xs text-muted-text">{copy.previewFailed}</p>
          : asVideo && kind.video
            ? <video key={src} src={src} controls autoPlay muted loop playsInline className="block w-full" onError={() => setFailed(src)} />
            : <img key={src} src={src} alt={copy.previewKinds[what]} className="block w-full" onError={() => setFailed(src)} />}
      </div>
    </Card>
  );
}

/** Academy console → Branding (owner only): the brand kit, what clips get, and a live preview. */
export function AcademyBrandingSection({ academyId }: { academyId: number }) {
  const all = useStudioCopy();
  const copy = all.branding;
  const query = useAcademyBranding(academyId);
  const [version, setVersion] = useState(0);
  if (query.isLoading) return <div className="h-64 animate-pulse rounded-2xl bg-raised" />;
  if (query.isError || !query.data) {
    return <p className="text-sm text-red-400" role="alert">{(query.error as Error | null)?.message ?? copy.loadError}</p>;
  }
  const data = query.data;
  return (
    <section className="space-y-6 pb-16" dir={all.locale === "ar" ? "rtl" : "ltr"} data-testid="academy-branding">
      <div>
        <h2 className="font-display text-2xl font-bold text-text">{copy.title}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.intro}</p>
      </div>
      <BrandKit academyId={academyId} data={data} />
      <ClipSettings academyId={academyId} data={data} onChanged={() => setVersion((v) => v + 1)} />
      <Preview academyId={academyId} data={data} version={version} />
    </section>
  );
}

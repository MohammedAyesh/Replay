import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, Facebook, Globe, Star, ImagePlus, Instagram, Loader2, LocateFixed, MapPin, Trash2 } from "lucide-react";
import { useProfileCopy } from "@/i18n/profile-strings";
import { useMarketingCopy } from "@/i18n/marketing-strings";
import {
  ProfileError,
  formatPhone,
  useAcademyLogo,
  useAcademyProfile,
  useLocateFromLink,
  useSaveAcademyProfile,
  type AcademyProfile,
  type ProfileInput,
} from "@/lib/academy-profile-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Form = Record<Exclude<keyof ProfileInput, "latitude" | "longitude">, string> & { latitude: string; longitude: string };

function toForm(p: AcademyProfile): Form {
  return {
    name: p.name,
    nameAr: p.nameAr ?? "",
    description: p.description ?? "",
    contactPhone: p.contactPhone ?? "",
    whatsappPhone: p.whatsappPhone ? formatPhone(p.whatsappPhone) : "",
    email: p.email ?? "",
    address: p.address ?? "",
    latitude: p.latitude?.toString() ?? "",
    longitude: p.longitude?.toString() ?? "",
    instagramUrl: p.instagramUrl ?? "",
    facebookUrl: p.facebookUrl ?? "",
    websiteUrl: p.websiteUrl ?? "",
    googleReviewUrl: p.googleReviewUrl ?? "",
  };
}

function toInput(f: Form): ProfileInput {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return {
    name: f.name.trim(),
    nameAr: f.nameAr.trim() || null,
    description: f.description.trim() || null,
    contactPhone: f.contactPhone.trim() || null,
    whatsappPhone: f.whatsappPhone.trim() || null,
    email: f.email.trim() || null,
    address: f.address.trim() || null,
    latitude: num(f.latitude),
    longitude: num(f.longitude),
    instagramUrl: f.instagramUrl.trim() || null,
    facebookUrl: f.facebookUrl.trim() || null,
    websiteUrl: f.websiteUrl.trim() || null,
    googleReviewUrl: f.googleReviewUrl.trim() || null,
  };
}

function mapEmbed(lat: number, lng: number) {
  const d = 0.004;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d * 1.6},${lat - d},${lng + d * 1.6},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <h3 className="font-display text-base font-bold text-text">{title}</h3>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted-text">{hint}</p> : null}
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-semibold text-muted-text">{label}</Label>
      {children}
      {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : hint ? <p className="text-xs text-muted-text">{hint}</p> : null}
    </div>
  );
}

/** Academy console → Profile: name, logo, contact, location and links, edited by the owner. */
export function AcademyProfileSection({ academyId }: { academyId: number }) {
  const copy = useProfileCopy();
  const marketing = useMarketingCopy();
  const query = useAcademyProfile(academyId);
  const save = useSaveAcademyProfile(academyId);
  const logo = useAcademyLogo(academyId);
  const locate = useLocateFromLink(academyId);
  const [form, setForm] = useState<Form | null>(null);
  const [link, setLink] = useState("");
  const [geoError, setGeoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const profile = query.data;

  useEffect(() => {
    if (profile) setForm(toForm(profile));
  }, [profile]);

  const dirty = useMemo(() => !!profile && !!form && JSON.stringify(toForm(profile)) !== JSON.stringify(form), [profile, form]);
  useEffect(() => { if (dirty) setJustSaved(false); }, [dirty]);

  if (query.isLoading || (profile && !form)) return <div className="h-64 animate-pulse rounded-2xl bg-raised" />;
  if (query.isError || !profile || !form) return <p className="text-sm text-red-400" role="alert">{(query.error as Error | null)?.message}</p>;

  const editable = profile.canEdit;
  const fieldErrors = save.error instanceof ProfileError ? save.error.fields : {};
  const errorFor = (key: string) => (fieldErrors[key] ? copy.errors[fieldErrors[key]] ?? fieldErrors[key] : undefined);
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const lat = form.latitude.trim() === "" ? null : Number(form.latitude);
  const lng = form.longitude.trim() === "" ? null : Number(form.longitude);
  const hasPin = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);
  const fieldPin = profile.field?.latitude != null && profile.field?.longitude != null;
  const shownLat = hasPin ? lat! : fieldPin ? profile.field!.latitude! : null;
  const shownLng = hasPin ? lng! : fieldPin ? profile.field!.longitude! : null;
  const nameError = form.name.trim().length < 2 ? copy.errors.name : undefined;

  const useMyLocation = () => {
    setGeoError(null);
    if (!navigator.geolocation) { setGeoError(copy.geoDenied); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        set({ latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) });
      },
      () => { setLocating(false); setGeoError(copy.geoDenied); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const findLink = () => {
    if (!link.trim()) return;
    locate.mutate(link.trim(), {
      onSuccess: (c) => { set({ latitude: String(c.latitude), longitude: String(c.longitude) }); setLink(""); },
    });
  };

  const submit = () => {
    if (nameError) return;
    save.mutate(toInput(form), { onSuccess: () => setJustSaved(true) });
  };

  return (
    <section className="space-y-6 pb-24" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="academy-profile">
      <div>
        <h2 className="font-display text-2xl font-bold text-text">{copy.title}</h2>
        <p className="mt-1 text-sm text-muted-text">{editable ? copy.intro : copy.readOnly}</p>
      </div>

      <fieldset disabled={!editable} className="space-y-6">
        <Card title={copy.identity}>
          <div className="flex items-center gap-4">
            <span className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-raised">
              {profile.logoUrl ? <img src={profile.logoUrl} alt="" className="h-full w-full object-contain p-1" /> : <span className="font-display text-2xl font-bold text-turf">{Array.from(form.name.trim())[0]?.toLocaleUpperCase() ?? "A"}</span>}
            </span>
            <div className="space-y-2">
              <p className="text-xs text-muted-text">{copy.logoHint}</p>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="input-academy-logo"
                    onChange={(e) => { const file = e.target.files?.[0]; if (file) logo.mutate(file); e.target.value = ""; }} />
                  <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => fileInput.current?.click()} disabled={logo.isPending}>
                    {logo.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                    <span className="ms-1.5">{profile.logoUrl ? copy.replaceLogo : copy.uploadLogo}</span>
                  </Button>
                  {profile.logoUrl ? (
                    <Button type="button" variant="ghost" size="sm" className="rounded-xl text-muted-text" onClick={() => logo.mutate(null)} disabled={logo.isPending}>
                      <Trash2 className="h-4 w-4" /><span className="ms-1.5">{copy.removeLogo}</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {logo.error ? <p className="text-xs text-red-400" role="alert">{(logo.error as Error).message}</p> : null}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="profile-name" label={copy.name} error={nameError}>
              <Input id="profile-name" dir="auto" maxLength={80} value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field id="profile-name-ar" label={copy.nameAr} hint={copy.nameArHint}>
              <Input id="profile-name-ar" dir="rtl" maxLength={80} value={form.nameAr} onChange={(e) => set({ nameAr: e.target.value })} />
            </Field>
          </div>
          <Field id="profile-description" label={copy.description}>
            <Textarea id="profile-description" dir="auto" rows={4} maxLength={1000} placeholder={copy.descriptionPlaceholder} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </Card>

        <Card title={copy.contact}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="profile-phone" label={copy.phone} hint={copy.phoneHint} error={errorFor("contactPhone")}>
              <Input id="profile-phone" dir="ltr" inputMode="tel" placeholder="079 123 4567" value={form.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} />
            </Field>
            <Field id="profile-whatsapp" label={copy.whatsapp} hint={copy.whatsappHint} error={errorFor("whatsappPhone")}>
              <div className="flex gap-2">
                <Input id="profile-whatsapp" dir="ltr" inputMode="tel" placeholder="079 123 4567" value={form.whatsappPhone} onChange={(e) => set({ whatsappPhone: e.target.value })} />
                {editable && form.contactPhone && form.whatsappPhone !== form.contactPhone ? (
                  <Button type="button" variant="outline" size="sm" className="h-10 shrink-0 rounded-xl text-xs" onClick={() => set({ whatsappPhone: form.contactPhone })}>{copy.sameAsPhone}</Button>
                ) : null}
              </div>
            </Field>
          </div>
          <Field id="profile-email" label={copy.email} error={errorFor("email")}>
            <Input id="profile-email" dir="ltr" type="email" inputMode="email" placeholder="info@academy.jo" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
        </Card>

        <Card title={copy.location} hint={copy.locationHint}>
          <Field id="profile-address" label={copy.address}>
            <Input id="profile-address" dir="auto" maxLength={200} placeholder={copy.addressPlaceholder} value={form.address} onChange={(e) => set({ address: e.target.value })} />
          </Field>
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-text">{copy.pin}</Label>
            <div className="overflow-hidden rounded-xl border border-line bg-raised">
              {shownLat !== null && shownLng !== null ? (
                <iframe title={copy.pin} src={mapEmbed(shownLat, shownLng)} className="h-56 w-full border-0" loading="lazy" />
              ) : (
                <div className="grid h-40 place-items-center text-muted-text"><MapPin className="h-6 w-6" /></div>
              )}
            </div>
            <p className={cn("flex items-center gap-1.5 text-xs", hasPin ? "text-turf" : fieldPin ? "text-muted-text" : "text-amber-400")}>
              {hasPin ? <><Check className="h-3.5 w-3.5" />{copy.pinSet}</> : fieldPin ? copy.usingField(profile.field!.name) : copy.noLocation}
              {shownLat !== null && shownLng !== null ? (
                <a className="ms-2 inline-flex items-center gap-1 text-muted-text underline-offset-2 hover:underline" href={`https://www.google.com/maps/search/?api=1&query=${shownLat},${shownLng}`} target="_blank" rel="noreferrer">
                  {copy.openInMaps}<ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </p>
            {errorFor("location") ? <p className="text-xs text-red-400" role="alert">{errorFor("location")}</p> : null}
          </div>
          {editable ? (
            <div className="space-y-3">
              <Field id="profile-map-link" label={copy.mapLink} error={locate.error ? (locate.error as Error).message : undefined}>
                <div className="flex gap-2">
                  <Input id="profile-map-link" dir="ltr" placeholder={copy.mapLinkPlaceholder} value={link} onChange={(e) => setLink(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findLink(); } }} />
                  <Button type="button" variant="outline" className="h-10 shrink-0 rounded-xl" onClick={findLink} disabled={!link.trim() || locate.isPending}>
                    {locate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : copy.find}
                  </Button>
                </div>
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={useMyLocation} disabled={locating}>
                  {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <LocateFixed className="h-4 w-4" />}
                  <span className="ms-1.5">{locating ? copy.locating : copy.useMyLocation}</span>
                </Button>
                {hasPin && fieldPin ? (
                  <Button type="button" variant="ghost" size="sm" className="rounded-xl text-muted-text" onClick={() => set({ latitude: "", longitude: "" })}>{copy.clearPin}</Button>
                ) : null}
              </div>
              {geoError ? <p className="text-xs text-amber-400" role="alert">{geoError}</p> : null}
              <div className="grid grid-cols-2 gap-3">
                <Field id="profile-lat" label={copy.latitude}>
                  <Input id="profile-lat" dir="ltr" inputMode="decimal" value={form.latitude} onChange={(e) => set({ latitude: e.target.value })} />
                </Field>
                <Field id="profile-lng" label={copy.longitude}>
                  <Input id="profile-lng" dir="ltr" inputMode="decimal" value={form.longitude} onChange={(e) => set({ longitude: e.target.value })} />
                </Field>
              </div>
            </div>
          ) : null}
        </Card>

        <Card title={copy.social}>
          <Field id="profile-instagram" label={copy.instagram} error={errorFor("instagramUrl")}>
            <div className="relative"><Instagram className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
              <Input id="profile-instagram" dir="ltr" className="ps-9" placeholder="@your.academy" value={form.instagramUrl} onChange={(e) => set({ instagramUrl: e.target.value })} /></div>
          </Field>
          <Field id="profile-facebook" label={copy.facebook} error={errorFor("facebookUrl")}>
            <div className="relative"><Facebook className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
              <Input id="profile-facebook" dir="ltr" className="ps-9" placeholder="facebook.com/your-academy" value={form.facebookUrl} onChange={(e) => set({ facebookUrl: e.target.value })} /></div>
          </Field>
          <Field id="profile-website" label={copy.website} error={errorFor("websiteUrl")}>
            <div className="relative"><Globe className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
              <Input id="profile-website" dir="ltr" className="ps-9" placeholder="youracademy.jo" value={form.websiteUrl} onChange={(e) => set({ websiteUrl: e.target.value })} /></div>
          </Field>
          <Field id="profile-google-review" label={marketing.review.label} error={errorFor("googleReviewUrl")}>
            <div className="relative"><Star className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
              <Input id="profile-google-review" dir="ltr" className="ps-9" placeholder="g.page/r/…/review" value={form.googleReviewUrl} onChange={(e) => set({ googleReviewUrl: e.target.value })} data-testid="input-google-review" /></div>
            <p className="mt-1 text-xs text-muted-text">{marketing.review.hint}</p>
          </Field>
        </Card>
      </fieldset>

      {editable && (dirty || justSaved || save.isError) ? (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-lg backdrop-blur" data-testid="profile-save-bar">
          <p className={cn("text-sm", save.isError ? "text-red-400" : justSaved && !dirty ? "text-turf" : "text-muted-text")} role="status">
            {save.isError && Object.keys(fieldErrors).length === 0 ? (save.error as Error).message : save.isError ? Object.values(fieldErrors).map((k) => copy.errors[k] ?? k)[0] : justSaved && !dirty ? copy.saved : copy.unsaved}
          </p>
          {dirty ? (
            <div className="flex gap-2">
              <Button type="button" variant="ghost" className="rounded-xl" onClick={() => { setForm(toForm(profile)); save.reset(); }}>{copy.discard}</Button>
              <Button type="button" className="rounded-xl bg-floodlight font-bold text-void" onClick={submit} disabled={save.isPending || !!nameError} data-testid="button-save-profile">
                {save.isPending ? copy.saving : copy.save}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

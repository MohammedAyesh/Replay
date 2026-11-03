import { useEffect, useState } from "react";
import { Copy, ExternalLink, Globe, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useVenueCopy } from "@/i18n/venue-strings";
import { cn } from "@/lib/utils";
import { useCheckDomain, useSaveDomain, useSaveWebsite, useWebsite, type WebsiteData } from "@/lib/venue-api";
import { Card, ErrorText, SectionHeader, Skeleton, ToggleRow } from "./shared";

export function WebsiteSection({ venueId }: { venueId: number }) {
  const copy = useVenueCopy();
  const q = useWebsite(venueId);
  if (q.isLoading) return <Skeleton rows={3} />;
  if (q.isError || !q.data) return <ErrorText error={q.error} />;
  return (
    <section className="space-y-6" data-testid="field-website">
      <SectionHeader title={copy.website.title} description={copy.website.description} />
      <PageCard data={q.data} />
      <DomainCard venueId={venueId} data={q.data} />
      <ContentCard venueId={venueId} data={q.data} />
    </section>
  );
}

function PageCard({ data }: { data: WebsiteData }) {
  const copy = useVenueCopy();
  const [copied, setCopied] = useState(false);
  const live = data.settings.customDomain && data.settings.domainStatus === "live" ? `https://${data.settings.customDomain}` : data.settings.siteUrl;
  const qr = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/venue-site/${data.settings.slug}/qr.png`;
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.website.yourPage}</p>
        <p className="mt-2 truncate font-mono text-lg text-turf" dir="ltr">{live.replace(/^https?:\/\//, "")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(live); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><Copy className="me-1.5 h-3.5 w-3.5" />{copied ? copy.website.copied : copy.website.copy}</Button>
          <Button type="button" variant="ghost" size="sm" asChild><a href={live} target="_blank" rel="noreferrer"><ExternalLink className="me-1.5 h-3.5 w-3.5" />{copy.website.open}</a></Button>
          <Button type="button" variant="ghost" size="sm" asChild><a href={qr} target="_blank" rel="noreferrer" download="booking-qr.png"><QrCode className="me-1.5 h-3.5 w-3.5" />QR</a></Button>
        </div>
      </div>
      <img src={qr} alt="QR" className="h-28 w-28 rounded-xl bg-white p-1" loading="lazy" />
    </Card>
  );
}

function DomainCard({ venueId, data }: { venueId: number; data: WebsiteData }) {
  const copy = useVenueCopy();
  const save = useSaveDomain(venueId);
  const check = useCheckDomain(venueId);
  const [domain, setDomain] = useState(data.settings.customDomain ?? "");
  useEffect(() => setDomain(data.settings.customDomain ?? ""), [data.settings.customDomain]);
  const status = data.settings.domainStatus;
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><Globe className="h-5 w-5 text-turf" />{copy.website.domain}</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-text">{copy.website.domainHint}</p>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", status === "live" ? "bg-floodlight/15 text-floodlight" : status === "pending" ? "bg-amber-300/15 text-amber-200" : "bg-raised text-muted-text")}>{copy.website.statuses[status]}</span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={copy.website.domainPlaceholder} dir="ltr" className="min-h-11" data-testid="input-domain" />
        <Button type="button" onClick={() => save.mutate(domain.trim() || null)} disabled={save.isPending || !domain.trim()} className="min-h-11 bg-floodlight font-bold text-void">{copy.website.saveDomain}</Button>
        {data.settings.customDomain && <Button type="button" variant="ghost" onClick={() => save.mutate(null)}>{copy.website.removeDomain}</Button>}
      </div>
      <ErrorText error={save.error} />
      {data.settings.customDomain && (
        <>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm" dir="ltr">
              <thead className="bg-raised text-xs text-muted-text"><tr><th className="p-2.5 text-left">{copy.website.dnsType}</th><th className="p-2.5 text-left">{copy.website.dnsHost}</th><th className="p-2.5 text-left">{copy.website.dnsValue}</th></tr></thead>
              <tbody className="divide-y divide-line font-mono">
                {data.dns.hosts.map((h) => <tr key={h}><td className="p-2.5">{data.dns.type}</td><td className="p-2.5">{h}</td><td className="p-2.5">{data.dns.value}</td></tr>)}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>{copy.website.check}</Button>
            {data.settings.domainError && <span className="text-xs text-amber-200">{data.settings.domainError}</span>}
            {status === "live" && <span className="text-xs text-muted-text">{copy.website.liveHint}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

function ContentCard({ venueId, data }: { venueId: number; data: WebsiteData }) {
  const copy = useVenueCopy();
  const save = useSaveWebsite(venueId);
  const [s, setS] = useState(data.settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setS(data.settings), [data.settings]);
  const field = (key: keyof WebsiteData["settings"], label: string, opts: { area?: boolean; dir?: "rtl" | "ltr" | "auto"; placeholder?: string } = {}) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {opts.area
        ? <Textarea value={(s[key] as string | null) ?? ""} onChange={(e) => setS({ ...s, [key]: e.target.value })} rows={3} dir={opts.dir ?? "auto"} />
        : <Input value={(s[key] as string | null) ?? ""} onChange={(e) => setS({ ...s, [key]: e.target.value })} dir={opts.dir ?? "auto"} placeholder={opts.placeholder} />}
    </div>
  );
  return (
    <Card className="space-y-4">
      <ToggleRow label={copy.website.enabled}><Switch checked={s.siteEnabled} onCheckedChange={(v) => setS({ ...s, siteEnabled: v })} /></ToggleRow>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label>{copy.website.address}</Label>
          <div className="flex items-center gap-1 text-sm" dir="ltr"><span className="text-muted-text">replayjo.com/v/</span><Input value={s.slug} onChange={(e) => setS({ ...s, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} className="max-w-xs" /></div>
        </div>
        {field("siteTagline", copy.website.tagline, { dir: "ltr" })}
        {field("siteTaglineAr", copy.website.taglineAr, { dir: "rtl" })}
        {field("siteAbout", copy.website.about, { area: true, dir: "ltr" })}
        {field("siteAboutAr", copy.website.aboutAr, { area: true, dir: "rtl" })}
        {field("heroImageUrl", copy.website.hero, { dir: "ltr", placeholder: "https://…" })}
        <div className="space-y-1.5"><Label>{copy.website.accent}</Label><div className="flex items-center gap-2"><input type="color" value={s.accentColor ?? "#D4FF4F"} onChange={(e) => setS({ ...s, accentColor: e.target.value })} className="h-10 w-14 rounded-lg border border-line bg-transparent" /><span className="font-mono text-xs text-muted-text">{s.accentColor ?? "#D4FF4F"}</span></div></div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" disabled={save.isPending} className="bg-floodlight font-bold text-void" onClick={() => save.mutate({
          slug: s.slug, siteEnabled: s.siteEnabled, siteTagline: s.siteTagline || null, siteTaglineAr: s.siteTaglineAr || null, siteAbout: s.siteAbout || null, siteAboutAr: s.siteAboutAr || null,
          heroImageUrl: s.heroImageUrl || null, accentColor: s.accentColor || null,
        }, { onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); } })}>{copy.website.save}</Button>
        {saved && <span className="text-xs font-semibold text-turf">{copy.website.saved}</span>}
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}

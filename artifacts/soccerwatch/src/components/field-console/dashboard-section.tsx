import { useState } from "react";
import { AlertCircle, Bot, CalendarPlus, Copy, ExternalLink, Receipt, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVenueCopy } from "@/i18n/venue-strings";
import { clock, jod, useVenueDashboard } from "@/lib/venue-api";
import { Card, ErrorText, Pill, Skeleton, Stat } from "./shared";

export type FieldSection = "dashboard" | "bookings" | "customers" | "chats" | "people" | "agent" | "whatsapp" | "pitches" | "payments" | "website" | "ads" | "social" | "creative" | "studio" | "branding" | "profile" | "team";

export function DashboardSection({ venueId, onNavigate }: { venueId: number; onNavigate: (s: FieldSection) => void }) {
  const copy = useVenueCopy();
  const q = useVenueDashboard(venueId);
  const [copied, setCopied] = useState(false);
  if (q.isLoading) return <Skeleton rows={4} />;
  if (q.isError || !q.data) return <ErrorText error={q.error ?? copy.console.error} />;
  const d = q.data;
  const siteUrl = d.settings.customDomain && d.settings.domainStatus === "live" ? `https://${d.settings.customDomain}` : d.settings.siteUrl;
  const name = copy.locale === "ar" ? d.venue.nameAr || d.venue.name : d.venue.name;
  const attention = [
    d.attention.receipts > 0 && { icon: Receipt, text: copy.dashboard.receipts(d.attention.receipts), go: "bookings" as const },
    d.attention.held > 0 && { icon: Timer, text: copy.dashboard.held(d.attention.held), go: "bookings" as const },
    d.attention.handovers > 0 && { icon: Bot, text: copy.dashboard.handovers(d.attention.handovers), go: "agent" as const },
  ].filter(Boolean) as Array<{ icon: typeof Receipt; text: string; go: FieldSection }>;

  return (
    <div className="space-y-6" data-testid="field-dashboard">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{copy.dashboard.hello}</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{name}</h1>
        </div>
        {d.pitchCount > 0 && (
          <Button type="button" onClick={() => onNavigate("bookings")} className="min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void">
            <CalendarPlus className="me-2 h-4 w-4" aria-hidden="true" />{copy.dashboard.newBooking}
          </Button>
        )}
      </div>

      {d.pitchCount === 0 && d.isOwner && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-floodlight/40">
          <p className="text-sm font-semibold text-text">{copy.dashboard.noPitches}</p>
          <Button type="button" onClick={() => onNavigate("pitches")} className="bg-floodlight font-bold text-void">{copy.dashboard.addPitches}</Button>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label={copy.dashboard.todayBookings} value={d.today.filter((b) => b.status !== "cancelled").length} tone="turf" />
        <Stat label={copy.dashboard.monthRevenue} value={jod(d.month.revenue, copy.locale)} hint={copy.dashboard.collected(jod(d.month.collected, copy.locale))} tone="floodlight" />
        <Stat label={copy.dashboard.occupancy} value={`${Math.round(d.month.occupancy * 100)}%`} />
        <Stat label={copy.dashboard.online} value={d.month.online} hint={copy.dashboard.onlineHint} tone="violet" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <h2 className="font-display text-xl font-bold text-text">{copy.dashboard.timeline}</h2>
          {d.today.length === 0 ? <p className="mt-3 text-sm text-muted-text">{copy.dashboard.noGames}</p> : (
            <ol className="mt-4 space-y-2">
              {d.today.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-raised/40 p-3">
                  <span className="w-16 font-display text-sm font-bold tabular-nums text-text">{clock(b.startLocal, copy.locale)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{b.customerName || b.teamName || b.reference}</span>
                  <span className="text-xs text-muted-text">{copy.locale === "ar" ? b.pitchNameAr || b.pitchName : b.pitchName}</span>
                  <Pill kind={b.paymentStatus}>{copy.payment[b.paymentStatus]}</Pill>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-4">
          <Card>
            <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><AlertCircle className="h-5 w-5 text-amber-200" />{copy.dashboard.attention}</h2>
            {attention.length === 0 ? <p className="mt-3 text-sm text-muted-text">{copy.dashboard.allClear}</p> : (
              <div className="mt-3 space-y-2">
                {attention.map(({ icon: Icon, text, go }) => (
                  <button key={text} type="button" onClick={() => onNavigate(go)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-raised/40 p-3 text-start text-sm font-semibold text-text hover:border-turf">
                    <Icon className="h-4 w-4 text-turf" />{text}
                  </button>
                ))}
              </div>
            )}
            {d.settings.agentMode === "off" && d.isOwner && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-raised p-3 text-sm">
                <span className="text-muted-text">{copy.dashboard.agentOff}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => onNavigate("agent")}>{copy.dashboard.turnOnAgent}</Button>
              </div>
            )}
          </Card>
          <Card>
            <p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.dashboard.shareSite}</p>
            <p className="mt-2 truncate font-mono text-sm text-turf" dir="ltr">{siteUrl.replace(/^https?:\/\//, "")}</p>
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(siteUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                <Copy className="me-1.5 h-3.5 w-3.5" />{copied ? copy.dashboard.copied : copy.dashboard.copy}
              </Button>
              <Button type="button" size="sm" variant="ghost" asChild><a href={siteUrl} target="_blank" rel="noreferrer"><ExternalLink className="me-1.5 h-3.5 w-3.5" />{copy.website.open}</a></Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

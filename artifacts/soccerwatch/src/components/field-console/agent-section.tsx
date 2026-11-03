import { useEffect, useState } from "react";
import { Bot, ListOrdered, MessageCircle, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useVenueCopy } from "@/i18n/venue-strings";
import { useWhatsappOverview } from "@/lib/academy-whatsapp-api";
import { cn } from "@/lib/utils";
import { jod, useAgent, useSaveAgent, useThreadAction, type AgentData, type Automations } from "@/lib/venue-api";
import { Card, ErrorText, SectionHeader, Skeleton, Stat, ToggleRow } from "./shared";

export function AgentSection({ venueId, onOpenChat, onOpenWhatsapp }: { venueId: number; onOpenChat: (phone: string) => void; onOpenWhatsapp: () => void }) {
  const copy = useVenueCopy();
  const q = useAgent(venueId);
  const wa = useWhatsappOverview(venueId);
  if (q.isLoading) return <Skeleton rows={3} />;
  if (q.isError || !q.data) return <ErrorText error={q.error} />;
  const d = q.data;
  const needsNumber = wa.data && wa.data.sender !== "own";
  return (
    <section className="space-y-6" data-testid="field-agent">
      <SectionHeader title={copy.agent.title} description={copy.agent.description} />
      {needsNumber && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber-300/40">
          <p className="text-sm text-amber-100">{copy.agent.needsOwnNumber}</p>
          <Button type="button" variant="outline" onClick={onOpenWhatsapp}>{copy.agent.openWhatsapp}</Button>
        </Card>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Stat label={copy.agent.chats} value={d.stats.chats30d} hint={copy.agent.stats} />
        <Stat label={copy.agent.booked} value={d.stats.bookings30d} hint={jod(d.stats.bookedFils30d, copy.locale)} tone="floodlight" />
        <Stat label={copy.agent.handoversLabel} value={d.stats.handovers} tone={d.stats.handovers ? "live" : undefined} />
      </div>
      {d.isOwner && <SettingsCard venueId={venueId} data={d} />}
      <Threads venueId={venueId} data={d} onOpenChat={onOpenChat} />
    </section>
  );
}

function SettingsCard({ venueId, data }: { venueId: number; data: AgentData }) {
  const copy = useVenueCopy();
  const save = useSaveAgent(venueId);
  const [s, setS] = useState(data.settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setS(data.settings), [data.settings]);
  const modes = [
    { id: "ai" as const, label: copy.agent.ai, hint: copy.agent.aiHint, icon: Bot },
    { id: "menu" as const, label: copy.agent.menu, hint: copy.agent.menuHint, icon: ListOrdered },
    { id: "off" as const, label: copy.agent.off, hint: copy.agent.offHint, icon: PowerOff },
  ];
  const setAuto = (key: keyof Automations, patch: Partial<Automations[keyof Automations]>) => setS({ ...s, automations: { ...s.automations, [key]: { ...s.automations[key], ...patch } } });
  return (
    <Card className="space-y-5">
      <div>
        <Label>{copy.agent.mode}</Label>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {modes.map(({ id, label, hint, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setS({ ...s, agentMode: id })} className={cn("rounded-2xl border p-4 text-start", s.agentMode === id ? "border-turf bg-turf/10" : "border-line bg-raised/40")} data-testid={`agent-mode-${id}`}>
              <span className="flex items-center gap-2 font-bold text-text"><Icon className="h-4 w-4 text-turf" />{label}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-text">{hint}</span>
            </button>
          ))}
        </div>
        {s.agentMode === "ai" && !data.aiAvailable && <p className="mt-2 text-xs text-amber-200">{copy.agent.aiMissing}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>{copy.agent.name}</Label><Input value={s.agentName ?? ""} onChange={(e) => setS({ ...s, agentName: e.target.value })} placeholder={copy.agent.namePlaceholder} dir="auto" /></div>
        <div className="space-y-1.5"><Label>{copy.agent.pause}</Label><Input type="number" min={5} value={s.agentPauseMinutes} onChange={(e) => setS({ ...s, agentPauseMinutes: Number(e.target.value) })} /></div>
      </div>
      <div className="space-y-1.5">
        <Label>{copy.agent.notes}</Label>
        <Textarea value={s.agentNotes ?? ""} onChange={(e) => setS({ ...s, agentNotes: e.target.value })} rows={5} maxLength={4000} placeholder={copy.agent.notesPlaceholder} dir="auto" />
        <p className="text-xs text-muted-text">{copy.agent.notesHint}</p>
      </div>
      <div>
        <h3 className="font-display text-lg font-bold text-text">{copy.agent.messages}</h3>
        <p className="text-xs text-muted-text">{copy.agent.messagesHint}</p>
        <div className="mt-2 divide-y divide-line">
          {(Object.keys(s.automations) as Array<keyof Automations>).map((key) => (
            <ToggleRow key={key} label={copy.agent.m[key]}>
              <div className="flex items-center gap-2">
                {key === "reminder" && s.automations.reminder.enabled && (
                  <span className="flex items-center gap-1 text-xs text-muted-text"><Input type="number" min={1} max={48} value={s.automations.reminder.hours} onChange={(e) => setAuto("reminder", { hours: Number(e.target.value) })} className="h-8 w-16" />{copy.agent.hoursBefore}</span>
                )}
                <Switch checked={s.automations[key].enabled} onCheckedChange={(v) => setAuto(key, { enabled: v })} />
              </div>
            </ToggleRow>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => save.mutate(s, { onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); } })} disabled={save.isPending} className="bg-floodlight font-bold text-void" data-testid="button-save-agent">{copy.agent.save}</Button>
        {saved && <span className="text-xs font-semibold text-turf">{copy.agent.saved}</span>}
        <ErrorText error={save.error} />
      </div>
    </Card>
  );
}

function Threads({ venueId, data, onOpenChat }: { venueId: number; data: AgentData; onOpenChat: (phone: string) => void }) {
  const copy = useVenueCopy();
  const act = useThreadAction(venueId);
  const sorted = [...data.threads].sort((a, b) => Number(Boolean(b.handoverAt)) - Number(Boolean(a.handoverAt)));
  const time = (iso: string) => new Date(iso).toLocaleString(copy.locale === "ar" ? "ar-JO" : "en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Amman" });
  return (
    <Card>
      <h2 className="font-display text-xl font-bold text-text">{copy.agent.threads}</h2>
      {sorted.length === 0 ? <p className="mt-3 text-sm text-muted-text">{copy.agent.noThreads}</p> : (
        <ul className="mt-3 divide-y divide-line">
          {sorted.map((t) => (
            <li key={t.phone} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className="font-semibold text-text" dir="ltr">{t.display}</span>
              {t.handoverAt && <span className="rounded-full bg-[#FF5A3C]/15 px-2 py-0.5 text-[11px] font-bold text-[#FF8A73]">{copy.agent.handover}</span>}
              {t.pausedUntil && <span className="text-xs text-muted-text">{copy.agent.paused(time(t.pausedUntil))}</span>}
              <span className="text-xs text-muted-text">{t.lastInAt ? time(t.lastInAt) : ""}</span>
              <span className="ms-auto flex gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => onOpenChat(t.phone)}><MessageCircle className="me-1 h-3.5 w-3.5" />{copy.agent.openChat}</Button>
                {t.pausedUntil || t.handoverAt
                  ? <Button type="button" size="sm" variant="ghost" onClick={() => act.mutate({ phone: t.phone, action: "resume" })}>{copy.agent.resume}</Button>
                  : <Button type="button" size="sm" variant="ghost" onClick={() => act.mutate({ phone: t.phone, action: "pause" })}>{copy.agent.pauseChat}</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

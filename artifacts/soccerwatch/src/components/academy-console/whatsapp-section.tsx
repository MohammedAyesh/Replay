import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCheck, Loader2, MessageCircle, RotateCcw, Send, Trash2, Undo2 } from "lucide-react";
import { useWhatsappCopy, type WhatsappStrings } from "@/i18n/whatsapp-strings";
import {
  useOptOuts,
  usePreviewAudience,
  useRemoveOptOut,
  useRetryMessage,
  useSaveAutomation,
  useSaveWhatsappSettings,
  useSendBroadcast,
  useSendTest,
  useDisconnectWhatsapp,
  useWhatsappMessages,
  useWhatsappOverview,
  type Audience,
  type AudiencePreview,
  type AudienceRole,
  type AutomationView,
  type WhatsappMessage,
  type WhatsappOverview,
  type WhatsappSender,
} from "@/lib/academy-whatsapp-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useConsoleKind } from "@/lib/console-kind";
import { WhatsappLinkDialog } from "./whatsapp-link-dialog";

const ROLES: AudienceRole[] = ["parents", "players", "coaches"];

function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "min-h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors",
        active ? "border-turf bg-turf/15 text-turf" : "border-line bg-raised text-muted-text hover:text-text",
      )}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function StatusPill({ data, copy }: { data: WhatsappOverview; copy: WhatsappStrings }) {
  let tone = "bg-raised text-muted-text";
  let text = copy.status.off;
  if (data.sender === "own") {
    const ok = data.own.status === "WORKING";
    tone = ok ? "bg-turf/15 text-turf" : "bg-amber-300/15 text-amber-200";
    text = ok ? copy.status.own : copy.status.notLinked;
  } else if (data.sender === "replay") {
    tone = data.replay.available ? "bg-turf/15 text-turf" : "bg-amber-300/15 text-amber-200";
    text = data.replay.available ? copy.status.replay : copy.status.replayUnavailable;
  }
  return <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold", tone)} data-testid="whatsapp-status"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />{text}</span>;
}

export function AcademyWhatsappSection({ academyId }: { academyId: number }) {
  // A field's console sends from People and from bookings; its automations live in Booking agent.
  const venue = useConsoleKind() === "venue";
  const copy = useWhatsappCopy();
  const overview = useWhatsappOverview(academyId);
  const [tab, setTab] = useState(venue ? "settings" : "send");
  const data = overview.data;
  const isOwner = data?.role === "owner";

  return (
    <section className="space-y-6" data-testid="academy-whatsapp" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
        </div>
        {data && <StatusPill data={data} copy={copy} />}
      </header>

      {overview.isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((n) => <div key={n} className="h-24 animate-pulse rounded-2xl bg-raised" />)}</div>
      ) : overview.isError || !data ? (
        <div className="rounded-2xl border border-line bg-surface p-5"><p className="text-sm text-muted-text" role="alert">{copy.common.error}</p><Button type="button" variant="outline" className="mt-3" onClick={() => void overview.refetch()}>{copy.common.retry}</Button></div>
      ) : (
        <>
          {!data.configured ? (
            <Notice>{copy.notConfigured}</Notice>
          ) : !data.serviceReachable ? (
            <Notice>{copy.serviceDown}</Notice>
          ) : data.sender === "off" && tab !== "settings" ? (
            <Notice>{copy.turnOnFirst}</Notice>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="whatsapp-stats">
            <Stat label={copy.stats.today} value={data.stats.sentToday} />
            <Stat label={copy.stats.queued} value={data.stats.queued} />
            <Stat label={copy.stats.read} value={data.stats.read7d} />
            <Stat label={copy.stats.failed} value={data.stats.failed7d} warn={data.stats.failed7d > 0} />
            <Stat label={copy.stats.replies} value={data.stats.replies7d} />
          </div>

          <Tabs value={tab} onValueChange={setTab} dir={copy.locale === "ar" ? "rtl" : "ltr"}>
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-raised p-1">
              {!venue && <TabsTrigger value="send" data-testid="tab-whatsapp-send">{copy.tabs.send}</TabsTrigger>}
              {isOwner && !venue && <TabsTrigger value="automations" data-testid="tab-whatsapp-automations">{copy.tabs.automations}</TabsTrigger>}
              <TabsTrigger value="history" data-testid="tab-whatsapp-history">{copy.tabs.history}</TabsTrigger>
              {isOwner && <TabsTrigger value="settings" data-testid="tab-whatsapp-settings">{copy.tabs.settings}</TabsTrigger>}
            </TabsList>
            {!venue && <TabsContent value="send" className="mt-5"><SendPanel academyId={academyId} data={data} /></TabsContent>}
            {isOwner && !venue && <TabsContent value="automations" className="mt-5"><AutomationsPanel academyId={academyId} data={data} /></TabsContent>}
            <TabsContent value="history" className="mt-5"><HistoryPanel academyId={academyId} active={tab === "history"} /></TabsContent>
            {isOwner && <TabsContent value="settings" className="mt-5"><SettingsPanel academyId={academyId} data={data} /></TabsContent>}
          </Tabs>
        </>
      )}
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100" role="status"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{children}</div>;
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-text">{label}</p>
      <p className={cn("mt-2 font-display text-2xl font-bold tabular-nums", warn ? "text-red-400" : "text-text")}>{value}</p>
    </div>
  );
}

// ─── Send ────────────────────────────────────────────────────────────────────

function SendPanel({ academyId, data }: { academyId: number; data: WhatsappOverview }) {
  const copy = useWhatsappCopy();
  const [roles, setRoles] = useState<AudienceRole[]>(["parents"]);
  const [scope, setScope] = useState<"all" | "squads" | "players">("all");
  const [squadIds, setSquadIds] = useState<number[]>([]);
  const [playerIds, setPlayerIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = usePreviewAudience(academyId);
  const send = useSendBroadcast(academyId);

  const audience: Audience = useMemo(() => ({
    roles,
    squadIds: scope === "squads" ? squadIds : null,
    playerIds: scope === "players" ? playerIds : null,
  }), [roles, scope, squadIds, playerIds]);

  // Any change to the audience makes an old preview stale.
  useEffect(() => { preview.reset(); }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const filteredPlayers = data.players.filter((p) => p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  const runPreview = async (): Promise<AudiencePreview | null> => {
    setError(null);
    if (roles.length === 0) { setError(copy.send.pickRole); return null; }
    try { return await preview.mutateAsync(audience); } catch (e) { setError((e as Error).message); return null; }
  };

  const openConfirm = async () => {
    setNotice(null);
    if (!body.trim()) { setError(copy.send.empty); return; }
    const result = preview.data ?? await runPreview();
    if (result) setConfirmOpen(true);
  };

  const doSend = async () => {
    try {
      const result = await send.mutateAsync({ body: body.trim(), audience, scheduledFor: when ? new Date(when).toISOString() : null });
      setConfirmOpen(false);
      setNotice(copy.send.queued(result.queued));
      setBody("");
      setWhen("");
      preview.reset();
    } catch (e) {
      setConfirmOpen(false);
      setError((e as Error).message);
    }
  };

  const insert = (token: string) => setBody((b) => `${b}${b && !b.endsWith(" ") && !b.endsWith("\n") ? " " : ""}{${token}}`);
  const disabled = data.sender === "off";

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-5 rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="space-y-2">
          <Label>{copy.send.who}</Label>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((role) => <Chip key={role} active={roles.includes(role)} onClick={() => setRoles((r) => toggle(r, role))} testId={`chip-role-${role}`}>{copy.roles[role]}</Chip>)}
          </div>
        </div>

        <div className="space-y-2">
          <Label>{copy.send.scope}</Label>
          <div className="flex flex-wrap gap-2">
            <Chip active={scope === "all"} onClick={() => setScope("all")} testId="chip-scope-all">{copy.send.allSquads}</Chip>
            <Chip active={scope === "squads"} onClick={() => setScope("squads")} testId="chip-scope-squads">{copy.send.someSquads}</Chip>
            <Chip active={scope === "players"} onClick={() => setScope("players")} testId="chip-scope-players">{copy.send.somePlayers}</Chip>
          </div>
          {scope === "squads" && (
            <div className="flex flex-wrap gap-2 pt-1">
              {data.squads.map((s) => <Chip key={s.id} active={squadIds.includes(s.id)} onClick={() => setSquadIds((ids) => toggle(ids, s.id))}>{s.name}</Chip>)}
            </div>
          )}
          {scope === "players" && (
            <div className="space-y-2 pt-1">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={copy.send.searchPlayers} className="min-h-10" />
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
                {filteredPlayers.map((p) => (
                  <label key={p.id} className="flex min-h-9 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-raised">
                    <input type="checkbox" checked={playerIds.includes(p.id)} onChange={() => setPlayerIds((ids) => toggle(ids, p.id))} className="h-4 w-4 accent-[#2FD8C4]" />
                    <span dir="auto">{p.name}</span>
                    <span className="ms-auto text-xs text-muted-text">{data.squads.find((s) => s.id === p.squadId)?.name ?? ""}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="whatsapp-message">{copy.send.message}</Label>
          <Textarea id="whatsapp-message" dir="auto" rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={copy.send.messagePlaceholder} className="resize-y" data-testid="input-whatsapp-message" />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-text">{copy.send.insert}:</span>
            {["name", "player", "squad", "academy"].map((t) => (
              <button key={t} type="button" onClick={() => insert(t)} className="rounded-md bg-raised px-2 py-1 font-mono text-xs text-turf hover:bg-turf/10" dir="ltr">{`{${t}}`}</button>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-text">{copy.send.placeholderHelp}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="whatsapp-when">{copy.send.schedule}</Label>
          <Input id="whatsapp-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-10 max-w-xs" />
          <p className="text-xs text-muted-text">{copy.send.scheduleHint}</p>
        </div>

        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        {notice && <p className="flex items-center gap-2 text-sm text-turf" role="status"><CheckCheck className="h-4 w-4" aria-hidden="true" />{notice}</p>}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void runPreview()} disabled={preview.isPending} className="min-h-11" data-testid="button-whatsapp-preview">
            {preview.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}{copy.send.preview}
          </Button>
          <Button type="button" onClick={() => void openConfirm()} disabled={disabled || send.isPending} className="min-h-11 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="button-whatsapp-send">
            <Send className="me-2 h-4 w-4" aria-hidden="true" />{preview.data ? copy.send.sendTo(preview.data.count) : copy.send.send}
          </Button>
        </div>
      </div>

      <aside className="rounded-2xl border border-line bg-surface p-5" data-testid="whatsapp-preview">
        {preview.data ? <PreviewList preview={preview.data} copy={copy} /> : <p className="text-sm leading-6 text-muted-text">{copy.send.placeholderHelp}</p>}
      </aside>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!send.isPending) setConfirmOpen(open); }}>
        <AlertDialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{copy.send.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-muted-text">{copy.send.confirmBody(preview.data?.count ?? 0)}</AlertDialogDescription>
          </AlertDialogHeader>
          <p dir="auto" className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-raised p-3 text-sm">{body}</p>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={send.isPending}>{copy.common.cancel}</AlertDialogCancel>
            <Button type="button" onClick={() => void doSend()} disabled={send.isPending || (preview.data?.count ?? 0) === 0} className="bg-floodlight font-bold text-void" data-testid="button-whatsapp-confirm-send">
              {send.isPending ? copy.send.sending : copy.send.sendTo(preview.data?.count ?? 0)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PreviewList({ preview, copy }: { preview: AudiencePreview; copy: WhatsappStrings }) {
  return (
    <div className="space-y-3">
      <p className="font-display text-lg font-bold text-text">{copy.send.recipients(preview.count)}</p>
      {preview.optedOut > 0 && <p className="text-xs text-muted-text">{copy.send.optedOut(preview.optedOut)}</p>}
      <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm">
        {preview.recipients.map((r) => (
          <li key={r.phone} className="flex flex-col rounded-lg bg-raised px-3 py-2">
            <span className="font-semibold" dir="auto">{r.name ?? copy.roles[r.role]}{r.players.length > 0 && <span className="font-normal text-muted-text"> · {r.players.join("، ")}</span>}</span>
            <span className="text-xs text-muted-text" dir="ltr">{r.phone} · {copy.roles[r.role]}</span>
          </li>
        ))}
      </ul>
      {preview.missing.length > 0 && (
        <details className="text-xs text-amber-200">
          <summary className="cursor-pointer font-semibold">{copy.send.missing(preview.missing.length)}</summary>
          <ul className="mt-2 space-y-1 text-muted-text">{preview.missing.map((m) => <li key={`${m.playerId}-${m.role}`} dir="auto">{copy.send.missingRow(m.playerName, copy.roles[m.role])}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

// ─── Automations ─────────────────────────────────────────────────────────────

function AutomationsPanel({ academyId, data }: { academyId: number; data: WhatsappOverview }) {
  const copy = useWhatsappCopy();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-text">{copy.automations.description}</p>
      {data.automations.map((a) => <AutomationCard key={a.key} academyId={academyId} automation={a} />)}
    </div>
  );
}

function AutomationCard({ academyId, automation }: { academyId: number; automation: AutomationView }) {
  const copy = useWhatsappCopy();
  const save = useSaveAutomation(academyId);
  const item = copy.automations.items[automation.key] ?? { title: automation.key, body: "" };
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(automation.template);
  const [timing, setTiming] = useState(automation.timing ?? 0);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setTemplate(automation.template); setTiming(automation.timing ?? 0); }, [automation.template, automation.timing]);

  const patch = async (body: Parameters<typeof save.mutateAsync>[0]) => {
    setSaved(false);
    await save.mutateAsync(body);
    setSaved(true);
  };
  const isAnnouncement = automation.key === "announcement";

  return (
    <article className="rounded-2xl border border-line bg-surface p-5" data-testid={`automation-${automation.key}`}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-bold text-text">{item.title}</h3>
          <p className="mt-1 text-sm text-muted-text">{isAnnouncement ? copy.automations.announcementNote : item.body}</p>
          {automation.customTemplate && <span className="mt-2 inline-block rounded-full bg-violet-400/15 px-2 py-0.5 text-[11px] font-bold text-violet-300">{copy.automations.custom}</span>}
        </div>
        {!isAnnouncement && (
          <Switch checked={automation.enabled} disabled={save.isPending} onCheckedChange={(enabled) => void patch({ key: automation.key, enabled })} aria-label={item.title} data-testid={`switch-automation-${automation.key}`} />
        )}
      </div>

      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-3 text-xs font-semibold text-turf hover:underline">{open ? "−" : "+"} {copy.automations.template}</button>

      {open && (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {automation.allowedAudiences.length > 0 ? (
            <div className="space-y-2">
              <Label>{copy.automations.audience}</Label>
              <div className="flex flex-wrap gap-2">
                {automation.allowedAudiences.map((role) => (
                  <Chip key={role} active={automation.audiences.includes(role)} onClick={() => void patch({
                    key: automation.key,
                    audiences: automation.audiences.includes(role) ? automation.audiences.filter((r) => r !== role) : [...automation.audiences, role],
                  })}>{copy.roles[role]}</Chip>
                ))}
              </div>
            </div>
          ) : <p className="text-xs text-muted-text">{copy.automations.fixedRecipient}</p>}

          {automation.timingRule && (
            <div className="space-y-2">
              <Label htmlFor={`timing-${automation.key}`}>{copy.automations.timing[automation.timingRule.unit]}</Label>
              <Input id={`timing-${automation.key}`} type="number" min={automation.timingRule.min} max={automation.timingRule.max} value={timing} onChange={(e) => setTiming(Number(e.target.value))} onBlur={() => { if (timing !== automation.timing) void patch({ key: automation.key, timing }); }} className="min-h-10 w-28" />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor={`template-${automation.key}`}>{copy.automations.template}</Label>
            <Textarea id={`template-${automation.key}`} dir="auto" rows={5} value={template} onChange={(e) => setTemplate(e.target.value)} className="resize-y font-mono text-sm" />
            <div className="flex flex-wrap gap-1.5">
              {automation.placeholders.map((p) => <button key={p} type="button" onClick={() => setTemplate((t) => `${t}{${p}}`)} className="rounded-md bg-raised px-2 py-1 font-mono text-xs text-turf" dir="ltr">{`{${p}}`}</button>)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={save.isPending || template === automation.template} onClick={() => void patch({ key: automation.key, template })} className="bg-floodlight font-bold text-void">{copy.automations.save}</Button>
            {automation.customTemplate && <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={() => void patch({ key: automation.key, template: null })}><Undo2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />{copy.automations.reset}</Button>}
            {saved && !save.isPending && <span className="text-xs text-turf">{copy.automations.saved}</span>}
            {save.isError && <span className="text-xs text-red-400">{copy.common.error}</span>}
          </div>
        </div>
      )}
    </article>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<WhatsappMessage["status"], string> = {
  queued: "bg-raised text-muted-text",
  sending: "bg-raised text-muted-text",
  sent: "bg-sky-400/15 text-sky-300",
  delivered: "bg-sky-400/15 text-sky-300",
  read: "bg-turf/15 text-turf",
  failed: "bg-red-500/15 text-red-400",
  skipped: "bg-raised text-muted-text",
  received: "bg-violet-400/15 text-violet-300",
};

function HistoryPanel({ academyId, active }: { academyId: number; active: boolean }) {
  const copy = useWhatsappCopy();
  const history = useWhatsappMessages(academyId, active);
  const retry = useRetryMessage(academyId);
  const format = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Amman" });

  if (history.isLoading) return <div className="h-40 animate-pulse rounded-2xl bg-raised" />;
  if (history.isError || !history.data) return <p className="text-sm text-muted-text" role="alert">{copy.common.error}</p>;
  const { broadcasts, messages } = history.data;
  const kindLabel = (kind: string) => copy.history.kinds[kind] ?? copy.automations.items[kind]?.title ?? kind;

  return (
    <div className="space-y-6">
      {broadcasts.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-display text-lg font-bold">{copy.history.broadcasts}</h2>
          {broadcasts.map((b) => {
            const c = b.statusCounts;
            const sent = (c.sent ?? 0) + (c.delivered ?? 0) + (c.read ?? 0);
            return (
              <div key={b.id} className="rounded-2xl border border-line bg-surface p-4">
                <p dir="auto" className="line-clamp-2 whitespace-pre-wrap text-sm text-text">{b.body}</p>
                <p className="mt-2 text-xs text-muted-text">
                  {format.format(new Date(b.createdAt))}
                  {new Date(b.scheduledFor).getTime() > Date.now() && ` · ${copy.history.scheduled} ${format.format(new Date(b.scheduledFor))}`}
                  {" · "}{copy.history.counts(sent, c.read ?? 0, c.failed ?? 0, (c.queued ?? 0) + (c.sending ?? 0))}
                </p>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        <h2 className="font-display text-lg font-bold">{copy.history.all}</h2>
        {messages.length === 0 ? <p className="text-sm text-muted-text">{copy.history.none}</p> : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {messages.map((m) => (
              <li key={m.id} className="flex flex-col gap-1.5 p-4 sm:flex-row sm:items-start sm:gap-4" data-testid={`whatsapp-message-${m.id}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={cn("rounded-full px-2 py-0.5 font-bold", STATUS_TONE[m.status])}>{copy.history.statuses[m.status] ?? m.status}</span>
                    <span className="font-semibold text-text">{m.direction === "in" ? copy.history.reply : kindLabel(m.kind)}</span>
                    <span className="text-muted-text" dir="auto">{[m.recipientName, m.playerName && m.playerName !== m.recipientName ? m.playerName : null].filter(Boolean).join(" · ")}</span>
                    <span className="text-muted-text" dir="ltr">{m.phone}</span>
                  </div>
                  <p dir="auto" className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm text-muted-text">{m.body}</p>
                  {m.error && m.status === "failed" && <p className="mt-1 text-xs text-red-400">{m.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-text">
                  <time dateTime={m.createdAt}>{format.format(new Date(m.sentAt ?? m.createdAt))}</time>
                  {(m.status === "failed" || m.status === "skipped") && m.direction === "out" && (
                    <Button type="button" size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate(m.id)} className="h-8 px-2"><RotateCcw className="me-1 h-3.5 w-3.5" aria-hidden="true" />{copy.history.retry}</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

function SettingsPanel({ academyId, data }: { academyId: number; data: WhatsappOverview }) {
  const copy = useWhatsappCopy();
  const saveSettings = useSaveWhatsappSettings(academyId);
  const disconnect = useDisconnectWhatsapp(academyId);
  const sendTest = useSendTest(academyId);
  const optOuts = useOptOuts(academyId, true);
  const removeOptOut = useRemoveOptOut(academyId);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(data.dailyLimit);
  const [testPhone, setTestPhone] = useState("");
  const [testNote, setTestNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ownLinked = data.own.status === "WORKING";

  const choose = async (sender: WhatsappSender) => {
    setError(null);
    if (sender === "own" && !ownLinked) { setLinkOpen(true); return; }
    try { await saveSettings.mutateAsync({ sender }); } catch (e) { setError((e as Error).message); }
  };

  const options: Array<{ value: WhatsappSender; title: string; body: string; extra?: ReactNode }> = [
    {
      value: "own",
      title: copy.settings.own,
      body: copy.settings.ownBody,
      extra: (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={cn("text-xs font-semibold", ownLinked ? "text-turf" : "text-muted-text")} dir="auto">{ownLinked ? copy.settings.linked(data.own.phone, data.own.name) : copy.settings.notLinked}</span>
          <Button type="button" size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setLinkOpen(true); }} data-testid="button-whatsapp-link">{ownLinked ? copy.settings.relink : copy.settings.link}</Button>
          {ownLinked && <Button type="button" size="sm" variant="ghost" className="text-red-400" onClick={(e) => { e.stopPropagation(); setUnlinkOpen(true); }}>{copy.settings.unlink}</Button>}
        </div>
      ),
    },
    {
      value: "replay",
      title: copy.settings.replay,
      body: copy.settings.replayBody,
      extra: !data.replay.available ? <p className="mt-2 text-xs text-amber-200">{copy.status.replayUnavailable}</p> : null,
    },
    { value: "off", title: copy.settings.off, body: copy.settings.offBody },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Label>{copy.settings.sendFrom}</Label>
        <div className="grid gap-3 md:grid-cols-3" role="radiogroup">
          {options.map((o) => (
            <div
              key={o.value}
              role="radio"
              tabIndex={0}
              aria-checked={data.sender === o.value}
              onClick={() => void choose(o.value)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void choose(o.value); }}
              className={cn(
                "cursor-pointer rounded-2xl border p-4 transition-colors",
                data.sender === o.value ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text",
              )}
              data-testid={`whatsapp-sender-${o.value}`}
            >
              <p className="font-display text-base font-bold text-text">{o.title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-text">{o.body}</p>
              {o.extra}
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      </div>

      <div className="grid gap-5 rounded-2xl border border-line bg-surface p-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{copy.settings.language}</Label>
          <div className="flex gap-2">
            <Chip active={data.locale === "ar"} onClick={() => void saveSettings.mutateAsync({ locale: "ar" })}>العربية</Chip>
            <Chip active={data.locale === "en"} onClick={() => void saveSettings.mutateAsync({ locale: "en" })}>English</Chip>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="whatsapp-daily-limit">{copy.settings.dailyLimit}</Label>
          <div className="flex gap-2">
            <Input id="whatsapp-daily-limit" type="number" min={1} max={5000} value={dailyLimit} onChange={(e) => setDailyLimit(Number(e.target.value))} className="min-h-10 w-32" />
            <Button type="button" variant="outline" disabled={dailyLimit === data.dailyLimit || dailyLimit < 1} onClick={() => void saveSettings.mutateAsync({ dailyLimit })}>{copy.settings.save}</Button>
          </div>
          <p className="text-xs text-muted-text">{copy.settings.dailyLimitHint}</p>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="whatsapp-test-phone">{copy.settings.test}</Label>
          <div className="flex flex-wrap gap-2">
            <Input id="whatsapp-test-phone" dir="ltr" inputMode="tel" placeholder={copy.settings.testPhone} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} className="min-h-10 max-w-xs" />
            <Button type="button" variant="outline" disabled={sendTest.isPending || data.sender === "off"} onClick={() => {
              setTestNote(null);
              sendTest.mutate(testPhone.trim() || undefined, {
                onSuccess: (r) => setTestNote(copy.settings.testSent(r.phone)),
                onError: (e) => setTestNote((e as Error).message),
              });
            }} data-testid="button-whatsapp-test"><Send className="me-2 h-4 w-4" aria-hidden="true" />{copy.settings.test}</Button>
          </div>
          {testNote && <p className="text-xs text-muted-text" role="status">{testNote}</p>}
        </div>
      </div>

      <div className="space-y-2 rounded-2xl border border-line bg-surface p-5">
        <Label>{copy.settings.optOuts}</Label>
        {(optOuts.data ?? []).length === 0 ? <p className="text-sm text-muted-text">{copy.settings.optOutsNone}</p> : (
          <ul className="divide-y divide-line">
            {optOuts.data!.map((o) => (
              <li key={o.phone} className="flex items-center justify-between py-2 text-sm">
                <span dir="ltr">{o.display}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeOptOut.mutate(o.phone, { onSuccess: () => void optOuts.refetch() })}><Trash2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />{copy.settings.optOutRemove}</Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="rounded-2xl bg-raised p-4 text-xs leading-6 text-muted-text">{copy.settings.tips}</p>

      <WhatsappLinkDialog
        target={academyId}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onLinked={() => void saveSettings.mutateAsync({ sender: "own" })}
      />
      <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <AlertDialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{copy.settings.unlink}</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-muted-text">{copy.settings.unlinkConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={disconnect.isPending}>{copy.common.cancel}</AlertDialogCancel>
            <Button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined, { onSuccess: () => setUnlinkOpen(false) })} className="bg-destructive font-bold text-red-400-foreground">{copy.settings.unlink}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

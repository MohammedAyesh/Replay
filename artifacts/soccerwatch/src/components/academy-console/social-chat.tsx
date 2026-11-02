import { useEffect, useRef, useState, type FormEvent } from "react";
import { Archive, ArrowLeft, ArrowRight, BellOff, EyeOff, Facebook, Instagram, Loader2, MoreVertical, Send, ShieldOff, UserPlus, X } from "lucide-react";
import { useSocialCopy } from "@/i18n/social-strings";
import { useTeamCopy } from "@/i18n/team-strings";
import { useSendSocial, useSocialLead, useSocialThread, useSocialThreadState, type LeadStage, type SocialThreadSummary } from "@/lib/academy-social-api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ChannelIcon({ channel, className }: { channel: "instagram" | "messenger"; className?: string }) {
  return channel === "instagram"
    ? <Instagram className={cn("text-pink-400", className)} aria-label="Instagram" />
    : <Facebook className={cn("text-sky-400", className)} aria-label="Messenger" />;
}

function initials(name: string | null) {
  const s = (name ?? "").replace(/^@/, "").trim();
  return s ? s.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() : "?";
}

export function SocialChatRow({ thread, active, onClick }: { thread: SocialThreadSummary; active: boolean; onClick: () => void }) {
  const copy = useSocialCopy();
  const name = thread.name || (thread.username ? `@${thread.username}` : copy.chat[thread.channel]);
  const time = thread.lastAt ? new Date(thread.lastAt) : null;
  const sameDay = time?.toDateString() === new Date().toDateString();
  const label = time ? new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", sameDay ? { hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" } : { day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(time) : "";
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-start transition-colors", active ? "bg-turf/10" : "hover:bg-raised")} data-testid={`social-chat-row-${thread.id}`}>
      <span className="relative shrink-0">
        {thread.picture ? <img src={thread.picture} alt="" className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
          : <span className="grid h-10 w-10 place-items-center rounded-full bg-raised text-xs font-bold text-text">{initials(name)}</span>}
        <span className="absolute -bottom-0.5 -end-0.5 grid h-4 w-4 place-items-center rounded-full bg-surface"><ChannelIcon channel={thread.channel} className="h-3 w-3" /></span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-text" dir="auto">{name}</span>
          <span className="ms-auto shrink-0 text-[11px] text-muted-text">{label}</span>
        </span>
        {thread.stage && <span className="mt-0.5 inline-block rounded-full bg-amber-300/10 px-1.5 text-[10px] font-semibold text-amber-200">{copy.chat.stages[thread.stage]}</span>}
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="truncate text-xs text-muted-text" dir="auto">{thread.lastDirection === "out" ? "↪ " : ""}{thread.lastBody}</span>
          {thread.muted && <BellOff className="ms-auto h-3.5 w-3.5 shrink-0 text-muted-text" aria-label="muted" />}
          {thread.unread > 0 && <span className={cn("grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold", thread.muted ? "bg-raised text-muted-text" : "ms-auto bg-floodlight text-void")}>{thread.unread}</span>}
        </span>
      </span>
    </button>
  );
}

const STAGES: LeadStage[] = ["new", "contacted", "trial", "joined", "lost"];

export function SocialThreadView({ academyId, threadId, canManage, onBack, onHidden }: { academyId: number; threadId: number; canManage: boolean; onBack: () => void; onHidden: () => void }) {
  const copy = useSocialCopy();
  const team = useTeamCopy();
  const thread = useSocialThread(academyId, threadId);
  const send = useSendSocial(academyId, threadId);
  const state = useSocialThreadState(academyId);
  const lead = useSocialLead(academyId, threadId);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "personal" | "block">(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const data = thread.data;
  const count = data?.messages.length ?? 0;
  const manage = canManage || Boolean(data?.canManage);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [count, threadId]);
  useEffect(() => { setDraft(""); setError(null); setPhoneOpen(false); }, [threadId]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setError(null);
    send.mutate(body, { onSuccess: () => setDraft(""), onError: (err) => setError((err as Error).message) });
  };

  const BackIcon = copy.locale === "ar" ? ArrowRight : ArrowLeft;
  const fmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Amman" });
  const name = data ? data.name || (data.username ? `@${data.username}` : copy.chat[data.channel]) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="social-thread">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
        <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back"><BackIcon className="h-5 w-5" aria-hidden="true" /></Button>
        {data && <ChannelIcon channel={data.channel} className="h-5 w-5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-text" dir="auto">{name}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-text">
            {data?.username && data.name && <span dir="ltr">@{data.username}</span>}
            {data?.contact && <span>· {copy.chat.inPeople} · <span dir="ltr">{data.contact.display}</span></span>}
          </span>
        </div>
        {data && (
          <select value={data.stage ?? ""} onChange={(e) => lead.mutate({ stage: (e.target.value || null) as LeadStage | null })}
            className="h-9 rounded-lg border border-line bg-raised px-2 text-xs text-text" aria-label={copy.chat.stage} data-testid="select-social-stage">
            <option value="">—</option>
            {STAGES.map((s) => <option key={s} value={s}>{copy.chat.stages[s]}</option>)}
          </select>
        )}
        {data && !data.contact && (
          <Button type="button" variant="outline" size="sm" onClick={() => setPhoneOpen((v) => !v)} data-testid="button-social-add-people"><UserPlus className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.chat.addToPeople}</Button>
        )}
        {manage && data && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={team.chat.actions}><MoreVertical className="h-4 w-4" aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={() => state.mutate({ threadId, state: { archived: !data.archived } }, { onSuccess: () => { if (!data.archived) onHidden(); } })}>
                <Archive className="me-2 h-4 w-4" aria-hidden="true" />{data.archived ? team.chat.unarchive : team.chat.archive}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => state.mutate({ threadId, state: { muted: !data.muted } })}>
                <BellOff className="me-2 h-4 w-4" aria-hidden="true" />{data.muted ? team.chat.unmute : team.chat.mute}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => (data.blocked ? state.mutate({ threadId, state: { blocked: false } }) : setConfirm("block"))} className="text-red-300">
                <ShieldOff className="me-2 h-4 w-4" aria-hidden="true" />{data.blocked ? team.chat.unblock : team.chat.block}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setConfirm("personal")}>
                <EyeOff className="me-2 h-4 w-4" aria-hidden="true" />{team.chat.personal}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {confirm && (
        <div className="flex flex-wrap items-center gap-2 border-b border-red-400/30 bg-red-500/5 p-3 text-sm" role="alertdialog">
          <p className="w-full text-text">{confirm === "personal" ? team.chat.personalConfirm : team.chat.blockConfirm}</p>
          <Button type="button" size="sm" className="bg-red-500 font-bold text-white hover:bg-red-600" disabled={state.isPending}
            onClick={() => state.mutate({ threadId, state: confirm === "personal" ? { personal: true } : { blocked: true } }, { onSuccess: () => { setConfirm(null); onHidden(); } })}>
            {team.chat.confirm}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>{team.chat.cancel}</Button>
        </div>
      )}
      {phoneOpen && (
        <form className="flex flex-wrap items-center gap-2 border-b border-line bg-raised/40 p-3" onSubmit={(e) => { e.preventDefault(); lead.mutate({ phone, stage: data?.stage ?? "new" }, { onSuccess: () => setPhoneOpen(false) }); }}>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={copy.chat.phonePlaceholder} inputMode="tel" dir="ltr" className="max-w-56" />
          <Button type="submit" size="sm" disabled={!phone.trim() || lead.isPending}>{copy.chat.save}</Button>
          <button type="button" className="text-muted-text" onClick={() => setPhoneOpen(false)} aria-label="close"><X className="h-4 w-4" aria-hidden="true" /></button>
        </form>
      )}
      {(state.isError || lead.isError) && <p className="border-b border-line px-3 py-2 text-xs text-red-400" role="alert">{((state.error ?? lead.error) as Error).message}</p>}
      {data?.blocked && <p className="border-b border-line bg-red-500/5 px-3 py-2 text-xs text-red-300">{team.chat.blockedNote}</p>}
      {data && data.replyWindow !== "open" && <p className="border-b border-line bg-amber-300/5 px-3 py-2 text-xs text-amber-100">{copy.chat.window[data.replyWindow]}</p>}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {thread.isLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" aria-hidden="true" /> : data?.messages.map((m) => {
          const mine = m.direction === "out";
          return (
            <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm", mine ? "rounded-ee-md bg-turf/20 text-text" : "rounded-es-md bg-raised text-text")}>
                {copy.chat.kinds[m.kind] && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-turf/80">{copy.chat.kinds[m.kind]}</span>}
                {m.attachments.filter((a) => a.url && (a.type === "image" || a.type === "story")).map((a, i) => (
                  <img key={i} src={a.url!} alt="" className="mb-1 max-h-60 rounded-xl object-cover" referrerPolicy="no-referrer" loading="lazy" />
                ))}
                {m.body && <p dir="auto" className="whitespace-pre-wrap break-words leading-6">{m.body}</p>}
                <span className="mt-0.5 block text-end text-[10px] text-muted-text">{fmt.format(new Date(m.createdAt))}{m.status === "failed" ? " · ✕" : ""}</span>
                {m.status === "failed" && m.error && <p className="mt-1 text-[11px] text-red-400">{m.error}</p>}
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <form onSubmit={submit} className="flex items-end gap-2 border-t border-line p-3">
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={copy.chat.limit} rows={1} maxLength={1000} dir="auto" className="max-h-40 min-h-11 resize-none" disabled={data?.replyWindow === "closed" || data?.blocked} data-testid="input-social-message" />
        <Button type="submit" disabled={!draft.trim() || send.isPending || data?.replyWindow === "closed"} className="h-11 w-11 shrink-0 rounded-full bg-floodlight p-0 text-void" aria-label="Send">
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />}
        </Button>
      </form>
      {error && <p className="px-3 pb-2 text-xs text-red-400" role="alert">{error}</p>}
    </div>
  );
}

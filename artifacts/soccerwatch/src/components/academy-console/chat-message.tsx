import { useMemo, useState, type ReactNode } from "react";
import { Ban, CalendarClock, Check, CheckCheck, ChevronDown, Clock, Copy, CornerUpLeft, Forward, Loader2, Pencil, Phone, Search, Smartphone, Trash2, Users, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useChatExtrasCopy } from "@/i18n/chat-extras-strings";
import { useChatNativeCopy } from "@/i18n/chat-native-strings";
import {
  useChats,
  useContacts,
  useDeleteMessage,
  useForwardMessage,
  useReactToMessage,
  type ChatMessage,
} from "@/lib/academy-whatsapp-api";
import { splitMentions } from "@/lib/chat-mentions";
import { ChatContentView } from "./chat-native";

export function StatusTick({ status }: { status: string }) {
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 text-sky-300" aria-hidden="true" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "sent") return <Check className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "failed" || status === "skipped") return <X className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />;
  return <Clock className="h-3.5 w-3.5" aria-hidden="true" />;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

/** "@962795550003" shown as "@Name" when we know who it is. */
export function MentionText({ text, names }: { text: string; names?: Map<string, string> }) {
  return (
    <>
      {splitMentions(text).map((part, i) => part.phone
        ? <span key={i} className="font-semibold text-sky-300" dir="auto">@{names?.get(part.phone) ?? part.phone}</span>
        : <span key={i}>{part.text}</span>)}
    </>
  );
}

export function quotePreview(type: string, body: string, copy: ReturnType<typeof useChatNativeCopy>): string {
  if (body) return body;
  if (type === "image") return copy.photoVideo;
  if (type === "location") return copy.location;
  if (type === "poll") return copy.poll;
  return copy.document;
}

function whenLabel(date: string, locale: "ar" | "en") {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(new Date(date));
}

export function MessageBubble({ academyId, phone, m, isGroup, names, kindLabel, onReply, onEdit, onJumpTo }: {
  academyId: number;
  phone: string;
  m: ChatMessage;
  isGroup: boolean;
  names?: Map<string, string>;
  kindLabel: ReactNode;
  onReply: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onJumpTo?: (id: number) => void;
}) {
  const extras = useChatExtrasCopy();
  const native = useChatNativeCopy();
  const react = useReactToMessage(academyId, phone);
  const del = useDeleteMessage(academyId, phone);
  const [forwarding, setForwarding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const mine = m.direction === "out";
  const locale = extras.locale;

  if (m.kind === "call") {
    return (
      <div className="flex justify-center" data-testid={`chat-bubble-${m.id}`}>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-xs text-muted-text"><Phone className="h-3 w-3" aria-hidden="true" />{m.body} · {whenLabel(m.createdAt, locale)}</span>
      </div>
    );
  }

  const mineReaction = m.reactions.find((r) => r.who === "me")?.emoji ?? null;
  const grouped = new Map<string, number>();
  for (const r of m.reactions) grouped.set(r.emoji, (grouped.get(r.emoji) ?? 0) + 1);
  const bare = !m.deleted && m.content?.type === "sticker";
  const copyText = m.deleted ? "" : m.content?.type === "poll" ? m.content.name : m.body;
  const pending = m.status === "queued" && !m.scheduledFor;

  return (
    <div id={`msg-${m.id}`} className={cn("group flex items-start gap-1", mine ? "flex-row-reverse" : "flex-row")}>
      <div className={cn("max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm", bare ? "bg-transparent shadow-none" : mine ? "rounded-ee-md bg-turf/20 text-text" : "rounded-es-md bg-raised text-text")} data-testid={`chat-bubble-${m.id}`}>
        {!mine && m.author && (
          <span className="mb-0.5 block text-[11px] font-semibold text-sky-200" dir="auto">{m.author.name || m.author.phone}{m.author.name && m.author.phone ? <span className="ms-1 font-normal text-muted-text" dir="ltr">{m.author.phone}</span> : null}</span>
        )}
        {mine && kindLabel}
        {mine && m.kind === "chat" && m.sentBy && <span className="mb-0.5 block text-[10px] font-semibold text-turf/80" dir="auto">{m.sentBy}</span>}

        {m.replyTo && !m.deleted && (
          <button type="button" onClick={() => m.replyTo?.id && onJumpTo?.(m.replyTo.id)} className="mb-1.5 block w-full rounded-lg border-s-4 border-turf/70 bg-black/20 px-2 py-1 text-start" data-testid="chat-quote">
            <span className="block truncate text-[11px] font-semibold text-turf" dir="auto">{m.replyTo.author === "me" ? extras.you : m.replyTo.author ?? "…"}</span>
            <span className="block truncate text-xs text-muted-text" dir="auto">{m.replyTo.deleted ? extras.deleted : quotePreview(m.replyTo.type, m.replyTo.body, native) || "…"}</span>
          </button>
        )}

        {m.deleted ? (
          <p className="flex items-center gap-1.5 italic text-muted-text"><Ban className="h-3.5 w-3.5" aria-hidden="true" />{extras.deleted}</p>
        ) : m.content ? (
          <ChatContentView content={m.content} body={m.body} />
        ) : (
          <p dir="auto" className="whitespace-pre-wrap break-words leading-6"><MentionText text={m.body} names={names} /></p>
        )}

        <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted-text">
          {m.editedAt && !m.deleted && <span>{extras.edited}</span>}
          {m.scheduledFor ? <><CalendarClock className="h-3 w-3" aria-hidden="true" />{extras.scheduledFor(whenLabel(m.scheduledFor, locale))}</> : whenLabel(m.sentAt ?? m.createdAt, locale)}
          {mine && !m.scheduledFor && <StatusTick status={m.status} />}
        </span>
        {m.status === "failed" && m.error && <p className="mt-1 text-[11px] text-red-400">{m.error}</p>}
        {pending && mine && <p className="mt-1 text-[11px] text-muted-text">{native.locale === "ar" ? "رح تنبعت أول ما يتصل الرقم." : "Will send as soon as the number is connected."}</p>}

        {grouped.size > 0 && (
          <span className="mt-1 flex flex-wrap gap-1" data-testid="chat-reactions">
            {[...grouped.entries()].map(([emoji, n]) => (
              <span key={emoji} className="rounded-full bg-black/25 px-1.5 py-0.5 text-xs" title={m.reactions.filter((r) => r.emoji === emoji).map((r) => (r.who === "me" ? extras.you : r.name || r.who)).join("، ")}>{emoji}{n > 1 ? ` ${n}` : ""}</span>
            ))}
          </span>
        )}
      </div>

      {!m.deleted && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-text opacity-60 hover:bg-raised hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100" aria-label={extras.react} data-testid={`button-message-actions-${m.id}`}>
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={mine ? "end" : "start"} className="min-w-48">
            {m.status !== "queued" && m.status !== "failed" && (
              <div className="flex items-center justify-between gap-1 px-2 py-1.5" role="group" aria-label={extras.react}>
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} type="button" disabled={react.isPending}
                    onClick={() => react.mutate({ messageId: m.id, emoji: mineReaction === emoji ? "" : emoji })}
                    className={cn("grid h-8 w-8 place-items-center rounded-full text-lg hover:bg-raised", mineReaction === emoji && "bg-turf/20")}>{emoji}</button>
                ))}
              </div>
            )}
            {m.status !== "queued" && m.status !== "failed" && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => onReply(m)}><CornerUpLeft className="me-2 h-4 w-4" aria-hidden="true" />{extras.reply}</DropdownMenuItem>
            {copyText && <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(copyText)}><Copy className="me-2 h-4 w-4" aria-hidden="true" />{extras.copy}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => setForwarding(true)}><Forward className="me-2 h-4 w-4" aria-hidden="true" />{extras.forward}</DropdownMenuItem>
            {m.canEdit && <DropdownMenuItem onSelect={() => onEdit(m)}><Pencil className="me-2 h-4 w-4" aria-hidden="true" />{extras.edit}</DropdownMenuItem>}
            {m.canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setConfirming(true)} className="text-red-300"><Trash2 className="me-2 h-4 w-4" aria-hidden="true" />{extras.delete}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="border-line bg-surface text-text" dir={locale === "ar" ? "rtl" : "ltr"}>
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{extras.delete}</AlertDialogTitle>
            <AlertDialogDescription className="text-start">{m.status === "queued" ? extras.cancelScheduledConfirm : extras.deleteConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{native.cancel}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-500 text-white hover:bg-red-600" onClick={() => del.mutate(m.id)}>{extras.delete}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {forwarding && <ForwardDialog academyId={academyId} phone={phone} messageId={m.id} open={forwarding} onOpenChange={setForwarding} />}
    </div>
  );
}

/** Pick chats (people or groups) and send a copy of a message to each. */
export function ForwardDialog({ academyId, phone, messageId, open, onOpenChange }: { academyId: number; phone: string; messageId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const extras = useChatExtrasCopy();
  const chats = useChats(academyId);
  const contacts = useContacts(academyId);
  const forward = useForwardMessage(academyId, phone);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; name: string; sub: string; group: boolean }> = [];
    for (const c of chats.data ?? []) {
      if (c.blocked || c.phone === phone) continue;
      seen.add(c.phone);
      out.push({ key: c.phone, name: c.group?.subject ?? c.contact?.name ?? c.display, sub: c.group ? "" : c.display, group: Boolean(c.group) });
    }
    for (const c of contacts.data ?? []) {
      if (seen.has(c.phone) || c.phone === phone) continue;
      out.push({ key: c.phone, name: c.name ?? c.display, sub: c.display, group: false });
    }
    const needle = q.trim().toLocaleLowerCase();
    return out.filter((o) => !needle || `${o.name} ${o.sub}`.toLocaleLowerCase().includes(needle)).slice(0, 80);
  }, [chats.data, contacts.data, q, phone]);

  const toggle = (key: string) => setPicked((list) => (list.includes(key) ? list.filter((k) => k !== key) : list.length < 10 ? [...list, key] : list));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-line bg-surface text-text" dir={extras.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start">
          <DialogTitle>{extras.forwardTitle}</DialogTitle>
          <DialogDescription className="text-start">{extras.forwardPick}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="ps-9" placeholder="…" />
        </div>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {options.map((o) => (
            <li key={o.key}>
              <label className="flex cursor-pointer items-center gap-2 px-2.5 py-2 hover:bg-raised">
                <input type="checkbox" checked={picked.includes(o.key)} onChange={() => toggle(o.key)} className="h-4 w-4" />
                {o.group && <Users className="h-3.5 w-3.5 shrink-0 text-sky-200" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{o.name}</span>
                {o.sub && <span className="text-xs text-muted-text" dir="ltr">{o.sub}</span>}
              </label>
            </li>
          ))}
        </ul>
        {forward.isError && <p className="text-xs text-red-400" role="alert">{(forward.error as Error).message}</p>}
        {done && <p className="text-xs text-turf">{done}</p>}
        <Button type="button" disabled={picked.length === 0 || forward.isPending} className="bg-floodlight font-bold text-void"
          onClick={() => forward.mutate({ messageId, targets: picked }, { onSuccess: (r) => { setDone(extras.forwardSent(r.sent)); setPicked([]); setTimeout(() => onOpenChange(false), 900); } })}>
          {forward.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{extras.forward}{picked.length ? ` · ${picked.length}` : ""}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function SourceLabel({ kind, fromPhone, label }: { kind: string; fromPhone: string; label: string }) {
  if (kind === "phone") return <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-turf/80"><Smartphone className="h-3 w-3" aria-hidden="true" />{fromPhone}</span>;
  return <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-turf/80">{label}</span>;
}

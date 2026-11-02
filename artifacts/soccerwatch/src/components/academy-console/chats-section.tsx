import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCheck, Clock, HelpCircle, Loader2, MessagesSquare, Search, Send, Smartphone, UserRoundCog, X } from "lucide-react";
import { usePeopleCopy } from "@/i18n/people-strings";
import { useWhatsappCopy } from "@/i18n/whatsapp-strings";
import { useChatThread, useChats, useSendChat, useWhatsappOverview, type ChatSummary } from "@/lib/academy-whatsapp-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ContactEditor, LinkPlayerForm, RelationshipChips } from "./contact-editor";

function initials(name: string | null, fallback: string) {
  const source = (name ?? "").trim();
  if (!source) return fallback.slice(-2);
  return source.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function StatusTick({ status }: { status: string }) {
  if (status === "read") return <CheckCheck className="h-3.5 w-3.5 text-sky-300" aria-hidden="true" />;
  if (status === "delivered") return <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "sent") return <Check className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "failed" || status === "skipped") return <X className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />;
  return <Clock className="h-3.5 w-3.5" aria-hidden="true" />;
}

export function AcademyChatsSection({ academyId, isOwner, initialPhone }: { academyId: number; isOwner: boolean; initialPhone?: string | null }) {
  const copy = usePeopleCopy();
  const chats = useChats(academyId);
  const overview = useWhatsappOverview(academyId);
  const [selected, setSelected] = useState<string | null>(initialPhone ?? null);
  const [filter, setFilter] = useState<"all" | "unread" | "unknown">("all");
  const [query, setQuery] = useState("");

  useEffect(() => { if (initialPhone) setSelected(initialPhone); }, [initialPhone]);

  const list = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (chats.data ?? []).filter((c) => {
      if (filter === "unread" && c.unread === 0) return false;
      if (filter === "unknown" && c.contact && c.contact.players.length > 0 && c.contact.kind !== "unknown") return false;
      if (!q) return true;
      const hay = [c.contact?.name, c.display, c.phone, ...(c.contact?.players.map((p) => p.playerName) ?? []), ...(c.contact?.tags ?? [])].join(" ").toLocaleLowerCase();
      return hay.includes(q);
    });
  }, [chats.data, filter, query]);

  const unknownCount = (chats.data ?? []).filter((c) => !c.contact || c.contact.kind === "unknown" || c.contact.players.length === 0).length;

  return (
    <section className="space-y-4" data-testid="academy-chats" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.chats.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.chats.description}</p>
      </header>
      {overview.data?.sender === "off" && <p className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">{copy.chats.off}</p>}

      <div className="grid h-[calc(100dvh-14rem)] min-h-[520px] overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[340px_1fr]">
        {/* List */}
        <div className={cn("flex min-h-0 flex-col border-line md:border-e", selected ? "hidden md:flex" : "flex")}>
          <div className="space-y-2 border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.chats.search} className="min-h-10 ps-9" data-testid="input-chat-search" />
            </div>
            <div className="flex gap-1.5">
              {(["all", "unread", "unknown"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)}
                  className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", filter === f ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}
                  data-testid={`chat-filter-${f}`}>
                  {copy.chats.filters[f]}{f === "unknown" && unknownCount > 0 ? ` · ${unknownCount}` : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {chats.isLoading ? <div className="space-y-2 p-3">{[0, 1, 2, 3].map((n) => <div key={n} className="h-14 animate-pulse rounded-xl bg-raised" />)}</div>
              : list.length === 0 ? <p className="p-6 text-center text-sm leading-6 text-muted-text">{copy.chats.empty}</p>
                : list.map((c) => <ChatRow key={c.phone} chat={c} active={selected === c.phone} onClick={() => setSelected(c.phone)} />)}
          </div>
        </div>

        {/* Thread */}
        <div className={cn("min-h-0", selected ? "flex" : "hidden md:flex")}>
          {selected ? (
            <Thread academyId={academyId} phone={selected} isOwner={isOwner} onBack={() => setSelected(null)} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-text">
              <MessagesSquare className="h-10 w-10" aria-hidden="true" />
              <p className="text-sm">{copy.chats.pick}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ChatRow({ chat, active, onClick }: { chat: ChatSummary; active: boolean; onClick: () => void }) {
  const copy = usePeopleCopy();
  const name = chat.contact?.name;
  const unknown = !chat.contact || chat.contact.kind === "unknown" || chat.contact.players.length === 0;
  const time = new Date(chat.lastAt);
  const sameDay = time.toDateString() === new Date().toDateString();
  const label = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", sameDay ? { hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" } : { day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(time);
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-start transition-colors", active ? "bg-turf/10" : "hover:bg-raised")} data-testid={`chat-row-${chat.phone}`}>
      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-bold", unknown ? "bg-amber-300/15 text-amber-200" : "bg-turf/15 text-turf")}>
        {unknown && !name ? <HelpCircle className="h-4 w-4" aria-hidden="true" /> : initials(name ?? null, chat.phone)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-text" dir="auto">{name || chat.display}</span>
          <span className="ms-auto shrink-0 text-[11px] text-muted-text">{label}</span>
        </span>
        {chat.contact && chat.contact.players.length > 0 && <RelationshipChips contact={chat.contact} className="mt-0.5" />}
        <span className="mt-0.5 flex items-center gap-1.5">
          {chat.lastDirection === "out" && <span className="text-muted-text"><StatusTick status={chat.lastStatus} /></span>}
          <span className="truncate text-xs text-muted-text" dir="auto">{chat.lastBody}</span>
          {chat.unread > 0 && <span className="ms-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-floodlight px-1.5 text-[10px] font-bold text-void">{chat.unread}</span>}
        </span>
      </span>
    </button>
  );
}

function Thread({ academyId, phone, isOwner, onBack }: { academyId: number; phone: string; isOwner: boolean; onBack: () => void }) {
  const copy = usePeopleCopy();
  const waCopy = useWhatsappCopy();
  const thread = useChatThread(academyId, phone);
  const send = useSendChat(academyId, phone);
  const [draft, setDraft] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const data = thread.data;
  const contact = data?.contact ?? null;
  const unknown = !contact || contact.kind === "unknown" || contact.players.length === 0;
  const count = data?.messages.length ?? 0;

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [count, phone]);
  useEffect(() => { setDraft(""); setError(null); }, [phone]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setError(null);
    send.mutate(body, { onSuccess: () => setDraft(""), onError: (err) => setError((err as Error).message) });
  };

  const BackIcon = copy.locale === "ar" ? ArrowRight : ArrowLeft;
  const fmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Amman" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
        <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label={copy.chats.back}><BackIcon className="h-5 w-5" aria-hidden="true" /></Button>
        <button type="button" onClick={() => setInfoOpen(true)} className="min-w-0 flex-1 text-start" data-testid="chat-header">
          <span className="block truncate font-semibold text-text" dir="auto">{contact?.name || data?.display || phone}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-text">
            <span dir="ltr">{data?.display}</span>
            {contact && contact.kind !== "unknown" && <span>· {copy.contact.kinds[contact.kind]}</span>}
          </span>
          {contact && <RelationshipChips contact={contact} className="mt-1" />}
        </button>
        <Button type="button" variant="outline" size="sm" onClick={() => setInfoOpen(true)} data-testid="button-chat-info"><UserRoundCog className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.contact.editTitle}</Button>
      </div>

      {unknown && contact && (
        <div className="border-b border-amber-300/20 bg-amber-300/5 p-3" data-testid="chat-who-is-this">
          <p className="text-sm font-semibold text-amber-100">{copy.chats.unknownTitle}</p>
          <p className="mb-2 text-xs text-muted-text">{copy.chats.unknownBody}</p>
          <LinkPlayerForm academyId={academyId} contactId={contact.id} />
        </div>
      )}
      {data?.optedOut && <p className="border-b border-line bg-raised px-3 py-2 text-xs text-muted-text">{copy.chats.optedOut}</p>}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(47,216,196,0.04),transparent_60%)] p-4">
        {thread.isLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" aria-hidden="true" /> : data?.messages.map((m) => {
          const mine = m.direction === "out";
          return (
            <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm", mine ? "rounded-ee-md bg-turf/20 text-text" : "rounded-es-md bg-raised text-text")} data-testid={`chat-bubble-${m.id}`}>
                {mine && m.kind !== "chat" && (
                  <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-turf/80">
                    {m.kind === "phone" ? <><Smartphone className="h-3 w-3" aria-hidden="true" />{copy.chats.fromPhone}</> : (waCopy.history.kinds[m.kind] ?? waCopy.automations.items[m.kind]?.title ?? m.kind)}
                  </span>
                )}
                <p dir="auto" className="whitespace-pre-wrap break-words leading-6">{m.body}</p>
                <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted-text">
                  {fmt.format(new Date(m.sentAt ?? m.createdAt))}
                  {mine && <StatusTick status={m.status} />}
                </span>
                {m.status === "failed" && m.error && <p className="mt-1 text-[11px] text-red-400">{m.error}</p>}
                {m.status === "queued" && mine && <p className="mt-1 text-[11px] text-muted-text">{copy.chats.queuedNote}</p>}
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <form onSubmit={submit} className="flex items-end gap-2 border-t border-line p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={copy.chats.typeMessage}
          rows={1}
          dir="auto"
          className="max-h-40 min-h-11 resize-none"
          data-testid="input-chat-message"
        />
        <Button type="submit" disabled={!draft.trim() || send.isPending} className="h-11 w-11 shrink-0 rounded-full bg-floodlight p-0 text-void" aria-label={copy.chats.send} data-testid="button-chat-send">
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />}
        </Button>
      </form>
      {error && <p className="px-3 pb-2 text-xs text-red-400" role="alert">{error}</p>}

      <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
        <SheetContent side={copy.locale === "ar" ? "left" : "right"} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
          <SheetHeader className="px-8 text-start">
            <SheetTitle>{contact?.name || data?.display}</SheetTitle>
            <SheetDescription dir="ltr" className="text-start">{data?.display}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {contact ? <ContactEditor academyId={academyId} contact={contact} isOwner={isOwner} onDeleted={() => setInfoOpen(false)} />
              : <ContactEditor academyId={academyId} contact={null} initialPhone={phone} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

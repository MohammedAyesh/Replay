import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, ArrowRight, BellOff, EyeOff, HelpCircle, Image as ImageIcon, Info, Loader2, LogOut, MessageSquarePlus, MessagesSquare, MoreVertical, Search, Settings2, ShieldOff, UserPlus, UserRoundCog, Users, X } from "lucide-react";
import { useTeamCopy } from "@/i18n/team-strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePeopleCopy } from "@/i18n/people-strings";
import { useWhatsappCopy } from "@/i18n/whatsapp-strings";
import { useAddToGroup, useChatAssignees, useChatState, useChatThread, useChatWho, useChats, useContacts, useGroupMembers, useHiddenChats, useWhatsappOverview, type ChatMessage, type ChatState, type ChatSummary } from "@/lib/academy-whatsapp-api";
import { useChatExtrasCopy } from "@/i18n/chat-extras-strings";
import { MessageBubble, SourceLabel, StatusTick } from "./chat-message";
import { ChatMediaSheet, ChatSearchSheet, GroupInfoSheet } from "./chat-panels";
import { ChatToolsSheet } from "./chat-tools";
import { useChatNativeCopy } from "@/i18n/chat-native-strings";
import { AssigneeBadge, ChatComposer, FollowGroupsSheet, NewChatDialog, NewGroupDialog, WhatsappAssign } from "./chat-native";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ContactEditor, LinkPlayerForm, RelationshipChips } from "./contact-editor";
import { useSocialCopy } from "@/i18n/social-strings";
import { useHiddenSocialThreads, useSocialThreadState, useSocialThreads, type SocialThreadSummary } from "@/lib/academy-social-api";
import { ChannelIcon, SocialChatRow, SocialThreadView } from "./social-chat";
import { ChatNotifyButton } from "./chat-notify";

function initials(name: string | null, fallback: string) {
  const source = (name ?? "").trim();
  if (!source) return fallback.slice(-2);
  return source.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

type ChatFilter = "all" | "unread" | "mine" | "unknown" | "archived";
type ChannelFilter = "all" | "whatsapp" | "instagram" | "messenger";
type Row = { kind: "wa"; key: string; at: number; chat: ChatSummary } | { kind: "social"; key: string; at: number; thread: SocialThreadSummary };

export function AcademyChatsSection({ academyId, isOwner, canManageChats = isOwner, initialPhone, initialSocialThreadId }: { academyId: number; isOwner: boolean; canManageChats?: boolean; initialPhone?: string | null; initialSocialThreadId?: number | null }) {
  const copy = usePeopleCopy();
  const team = useTeamCopy();
  const chats = useChats(academyId);
  const overview = useWhatsappOverview(academyId);
  const social = useSocialThreads(academyId);
  const socialCopy = useSocialCopy();
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [selected, setSelected] = useState<string | null>(initialSocialThreadId ? `s:${initialSocialThreadId}` : initialPhone ?? null);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [query, setQuery] = useState("");
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [creating, setCreating] = useState<null | "chat" | "group" | "follow">(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const extras = useChatExtrasCopy();
  const native = useChatNativeCopy();
  const assignees = useChatAssignees(academyId);
  const myId = (assignees.data ?? []).find((m) => m.me)?.id ?? null;
  const open = (phone: string) => { setCreating(null); setFilter("all"); setSelected(phone); };

  useEffect(() => { if (initialPhone) setSelected(initialPhone); }, [initialPhone]);
  useEffect(() => { if (initialSocialThreadId) setSelected(`s:${initialSocialThreadId}`); }, [initialSocialThreadId]);

  // Blocked chats live under "Hidden chats"; archived ones under their own filter.
  const visible = useMemo(() => (chats.data ?? []).filter((c) => !c.blocked), [chats.data]);
  const socialVisible = useMemo(() => (social.data ?? []).filter((t) => !t.blocked), [social.data]);
  const archivedCount = visible.filter((c) => c.archived).length + socialVisible.filter((t) => t.archived).length;
  const list = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const wa: Row[] = channel !== "all" && channel !== "whatsapp" ? [] : visible.filter((c) => {
      if (filter === "archived" ? !c.archived : c.archived) return false;
      if (filter === "unread" && (c.unread === 0 || c.muted)) return false;
      if (filter === "mine" && c.assignedUserId !== myId) return false;
      if (filter === "unknown" && (c.group || (c.contact && c.contact.players.length > 0 && c.contact.kind !== "unknown"))) return false;
      if (!q) return true;
      const hay = [c.contact?.name, c.display, c.phone, ...(c.contact?.players.map((p) => p.playerName) ?? []), ...(c.contact?.tags ?? [])].join(" ").toLocaleLowerCase();
      return hay.includes(q);
    }).map((c) => ({ kind: "wa", key: c.phone, at: new Date(c.lastAt).getTime(), chat: c }));
    const so: Row[] = channel === "whatsapp" ? [] : socialVisible.filter((t) => {
      if (channel !== "all" && t.channel !== channel) return false;
      if (filter === "archived" ? !t.archived : t.archived) return false;
      if (filter === "unread" && (t.unread === 0 || t.muted)) return false;
      if (filter === "mine" && t.assignedUserId !== myId) return false;
      if (filter === "unknown" && t.contact) return false;
      if (!q) return true;
      return [t.name, t.username, t.contact?.display, t.lastBody].join(" ").toLocaleLowerCase().includes(q);
    }).map((t) => ({ kind: "social", key: `s:${t.id}`, at: t.lastAt ? new Date(t.lastAt).getTime() : 0, thread: t }));
    return [...wa, ...so].sort((a, b) => b.at - a.at);
  }, [visible, socialVisible, filter, query, channel, myId]);

  const mineCount = myId === null ? 0 : visible.filter((c) => !c.archived && c.assignedUserId === myId).length + socialVisible.filter((t) => !t.archived && t.assignedUserId === myId).length;
  const unknownCount = visible.filter((c) => !c.archived && !c.group && (!c.contact || c.contact.kind === "unknown" || c.contact.players.length === 0)).length
    + socialVisible.filter((t) => !t.archived && !t.contact).length;
  const hasSocial = (social.data ?? []).length > 0;

  return (
    <section className="space-y-4" data-testid="academy-chats" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.chats.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.chats.description}</p>
        <div className="mt-3"><ChatNotifyButton academyId={academyId} /></div>
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
            <div className="flex flex-wrap gap-1.5">
              {(["all", "unread", "mine", "unknown", "archived"] as const).filter((f) => (f !== "archived" || archivedCount > 0) && (f !== "mine" || mineCount > 0 || filter === "mine")).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)}
                  className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", filter === f ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}
                  data-testid={`chat-filter-${f}`}>
                  {f === "archived" ? team.chat.archived : f === "mine" ? native.mine : copy.chats.filters[f]}
                  {f === "unknown" && unknownCount > 0 ? ` · ${unknownCount}` : ""}{f === "archived" ? ` · ${archivedCount}` : ""}{f === "mine" ? ` · ${mineCount}` : ""}
                </button>
              ))}
            </div>
            {overview.data?.sender !== "off" && (
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setCreating("chat")} data-testid="button-new-chat">
                  <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />{native.newChat}
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setCreating("group")} data-testid="button-new-group">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />{native.newGroup}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 text-xs text-muted-text" onClick={() => setToolsOpen(true)} data-testid="button-chat-tools">
                  <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />{extras.tools}
                </Button>
                {canManageChats && overview.data?.sender === "own" && (
                  <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 text-xs text-muted-text" onClick={() => setCreating("follow")} data-testid="button-follow-groups">
                    {native.followGroups}
                  </Button>
                )}
              </div>
            )}
            {hasSocial && (
              <div className="flex gap-1.5" data-testid="chat-channels">
                {(["all", "whatsapp", "instagram", "messenger"] as const).map((c) => (
                  <button key={c} type="button" onClick={() => setChannel(c)}
                    className={cn("inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold", channel === c ? "bg-floodlight/15 text-floodlight" : "bg-raised text-muted-text")}
                    data-testid={`chat-channel-${c}`}>
                    {c === "instagram" || c === "messenger" ? <ChannelIcon channel={c} className="h-3 w-3" /> : null}
                    {socialCopy.chat[c]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {chats.isLoading ? <div className="space-y-2 p-3">{[0, 1, 2, 3].map((n) => <div key={n} className="h-14 animate-pulse rounded-xl bg-raised" />)}</div>
              : list.length === 0 ? <p className="p-6 text-center text-sm leading-6 text-muted-text">{copy.chats.empty}</p>
                : list.map((r) => r.kind === "wa"
                  ? <ChatRow key={r.key} academyId={academyId} chat={r.chat} active={selected === r.key} onClick={() => setSelected(r.key)} />
                  : <SocialChatRow key={r.key} academyId={academyId} thread={r.thread} active={selected === r.key} onClick={() => setSelected(r.key)} />)}
          </div>
          {canManageChats && (
            <button type="button" onClick={() => setHiddenOpen(true)} className="flex items-center gap-2 border-t border-line px-3 py-2.5 text-xs text-muted-text hover:text-text" data-testid="button-hidden-chats">
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />{team.chat.hidden}
            </button>
          )}
        </div>

        {/* Thread */}
        <div className={cn("min-h-0", selected ? "flex" : "hidden md:flex")}>
          {selected?.startsWith("s:") ? (
            <SocialThreadView academyId={academyId} threadId={Number(selected.slice(2))} canManage={canManageChats} onBack={() => setSelected(null)} onHidden={() => setSelected(null)} />
          ) : selected ? (
            <Thread academyId={academyId} phone={selected} isOwner={isOwner} canManage={canManageChats} onBack={() => setSelected(null)} onHidden={() => setSelected(null)} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-text">
              <MessagesSquare className="h-10 w-10" aria-hidden="true" />
              <p className="text-sm">{copy.chats.pick}</p>
            </div>
          )}
        </div>
      </div>
      {canManageChats && <HiddenChatsSheet academyId={academyId} open={hiddenOpen} onOpenChange={setHiddenOpen} />}
      <ChatToolsSheet academyId={academyId} isOwner={isOwner} open={toolsOpen} onOpenChange={setToolsOpen} />
      <NewChatDialog academyId={academyId} open={creating === "chat"} onOpenChange={(o) => setCreating(o ? "chat" : null)} onOpen={open} />
      <NewGroupDialog academyId={academyId} open={creating === "group"} onOpenChange={(o) => setCreating(o ? "group" : null)} onCreated={open} />
      {canManageChats && <FollowGroupsSheet academyId={academyId} open={creating === "follow"} onOpenChange={(o) => setCreating(o ? "follow" : null)} onOpen={open} />}
    </section>
  );
}

/** Personal and blocked numbers, so the owner can bring them back. */
function HiddenChatsSheet({ academyId, open, onOpenChange }: { academyId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const copy = useTeamCopy();
  const hidden = useHiddenChats(academyId, open);
  const state = useChatState(academyId);
  const socialHidden = useHiddenSocialThreads(academyId, open);
  const socialState = useSocialThreadState(academyId);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={copy.locale === "ar" ? "left" : "right"} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <SheetHeader className="px-8 text-start">
          <SheetTitle>{copy.chat.hidden}</SheetTitle>
          <SheetDescription className="text-start">{copy.chat.personalConfirm}</SheetDescription>
        </SheetHeader>
        <ul className="mt-4 divide-y divide-line px-4">
          {(hidden.data ?? []).length === 0 && (socialHidden.data ?? []).length === 0 && <li className="py-4 text-sm text-muted-text">{copy.chat.noHidden}</li>}
          {(socialHidden.data ?? []).map((h) => (
            <li key={`s${h.id}`} className="flex items-center gap-2 py-3">
              <ChannelIcon channel={h.channel} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold" dir="auto">{h.name || (h.username ? `@${h.username}` : "—")}</span>
              {h.personal && <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-text">{copy.chat.personalTag}</span>}
              {h.blocked && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300">{copy.chat.blockedTag}</span>}
              <Button type="button" size="sm" variant="ghost" disabled={socialState.isPending}
                onClick={() => socialState.mutate({ threadId: h.id, state: { ...(h.personal ? { personal: false } : {}), ...(h.blocked ? { blocked: false } : {}) } }, { onSuccess: () => void socialHidden.refetch() })}>
                {copy.chat.restore}
              </Button>
            </li>
          ))}
          {(hidden.data ?? []).map((h) => (
            <li key={h.phone} className="flex items-center gap-2 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold" dir="auto">{h.name || h.display}</span>
                <span className="text-xs text-muted-text" dir="ltr">{h.display}</span>
              </span>
              {h.personal && <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-text">{copy.chat.personalTag}</span>}
              {h.blocked && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300">{copy.chat.blockedTag}</span>}
              <Button type="button" size="sm" variant="ghost" disabled={state.isPending}
                onClick={() => state.mutate({ phone: h.phone, state: { ...(h.personal ? { personal: false } : {}), ...(h.blocked ? { blocked: false } : {}) } })}>
                {copy.chat.restore}
              </Button>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

function ChatRow({ academyId, chat, active, onClick }: { academyId: number; chat: ChatSummary; active: boolean; onClick: () => void }) {
  const copy = usePeopleCopy();
  const extras = useChatExtrasCopy();
  const name = chat.group ? chat.group.subject : chat.contact?.name;
  const unknown = !chat.group && (!chat.contact || chat.contact.kind === "unknown" || chat.contact.players.length === 0);
  const time = new Date(chat.lastAt);
  const sameDay = time.toDateString() === new Date().toDateString();
  const label = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", sameDay ? { hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" } : { day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(time);
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-start transition-colors", active ? "bg-turf/10" : "hover:bg-raised")} data-testid={`chat-row-${chat.phone}`}>
      {chat.avatarUrl
        ? <img src={chat.avatarUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-full object-cover" />
        : <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-bold", chat.group ? "bg-sky-400/15 text-sky-200" : unknown ? "bg-amber-300/15 text-amber-200" : "bg-turf/15 text-turf")}>
            {chat.group ? <Users className="h-4 w-4" aria-hidden="true" /> : unknown && !name ? <HelpCircle className="h-4 w-4" aria-hidden="true" /> : initials(name ?? null, chat.phone)}
          </span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-text" dir="auto">{name || chat.display}</span>
          <span className="ms-auto shrink-0 text-[11px] text-muted-text">{label}</span>
        </span>
        {chat.contact && chat.contact.players.length > 0 && <RelationshipChips contact={chat.contact} className="mt-0.5" />}
        {chat.assignedUserId && <span className="mt-0.5 flex"><AssigneeBadge academyId={academyId} userId={chat.assignedUserId} /></span>}
        <span className="mt-0.5 flex items-center gap-1.5">
          {chat.lastDirection === "out" && <span className="text-muted-text"><StatusTick status={chat.lastStatus} /></span>}
          {chat.typing
            ? <span className="truncate text-xs font-semibold text-turf">{extras.typing}</span>
            : <span className="truncate text-xs text-muted-text" dir="auto">{chat.lastBody}</span>}
          {chat.muted && <BellOff className="ms-auto h-3.5 w-3.5 shrink-0 text-muted-text" aria-label="muted" />}
          {chat.unread > 0 && <span className={cn("grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[10px] font-bold", chat.muted ? "bg-raised text-muted-text" : "ms-auto bg-floodlight text-void")}>{chat.unread}</span>}
        </span>
      </span>
    </button>
  );
}

function Thread({ academyId, phone, isOwner, canManage, onBack, onHidden }: { academyId: number; phone: string; isOwner: boolean; canManage: boolean; onBack: () => void; onHidden: () => void }) {
  const copy = usePeopleCopy();
  const team = useTeamCopy();
  const native = useChatNativeCopy();
  const chatState = useChatState(academyId);
  const who = useChatWho(academyId);
  const [confirm, setConfirm] = useState<null | "personal" | "block" | "unfollow">(null);
  const [addOpen, setAddOpen] = useState(false);
  const [panel, setPanel] = useState<null | "search" | "media" | "info">(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const extras = useChatExtrasCopy();
  const waCopy = useWhatsappCopy();
  const thread = useChatThread(academyId, phone);
  const [infoOpen, setInfoOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const data = thread.data;
  const group = data?.group ?? null;
  const contact = data?.contact ?? null;
  const unknown = !group && (!contact || contact.kind === "unknown" || contact.players.length === 0);
  const count = data?.messages.length ?? 0;
  const members = useGroupMembers(academyId, group?.groupId ?? null, Boolean(group));
  const names = useMemo(() => new Map((members.data ?? []).filter((m) => m.phone && m.name).map((m) => [m.phone!, m.name!])), [members.data]);
  const mentionable = useMemo(() => (members.data ?? []).filter((m) => m.phone).map((m) => ({ phone: m.phone!, name: m.name || m.display || m.phone! })), [members.data]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [count, phone]);
  useEffect(() => { setReplyTo(null); setEditing(null); setPanel(null); }, [phone]);

  const BackIcon = copy.locale === "ar" ? ArrowRight : ArrowLeft;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label={copy.chats.back}><BackIcon className="h-5 w-5" aria-hidden="true" /></Button>
        {group ? (
          <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="chat-header">
            {data?.avatarUrl
              ? <img src={data.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sky-400/15 text-sky-200"><Users className="h-4 w-4" aria-hidden="true" /></span>}
            <span className="min-w-0">
              <span className="block truncate font-semibold text-text" dir="auto">{group.subject}</span>
              <span className={cn("text-xs", data?.typing ? "font-semibold text-turf" : "text-muted-text")}>{data?.typing ? extras.typing : native.groupTag}</span>
            </span>
          </div>
        ) : (
          <button type="button" onClick={() => setInfoOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 text-start" data-testid="chat-header">
            {data?.avatarUrl && <img src={data.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />}
            <span className="min-w-0">
              <span className="block truncate font-semibold text-text" dir="auto">{contact?.name || data?.display || phone}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-text">
                {data?.typing ? <span className="font-semibold text-turf">{extras.typing}</span> : <span dir="ltr">{data?.display}</span>}
                {!data?.typing && contact && contact.kind !== "unknown" && <span>· {copy.contact.kinds[contact.kind]}</span>}
              </span>
              {contact && <RelationshipChips contact={contact} className="mt-1" />}
            </span>
          </button>
        )}
        <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("search")} aria-label={extras.searchChat} data-testid="button-chat-search"><Search className="h-4 w-4" aria-hidden="true" /></Button>
        <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("media")} aria-label={extras.mediaTab} data-testid="button-chat-media"><ImageIcon className="h-4 w-4" aria-hidden="true" /></Button>
        {group && <Button type="button" variant="ghost" size="icon" onClick={() => setPanel("info")} aria-label={extras.groupInfo} data-testid="button-group-info"><Info className="h-4 w-4" aria-hidden="true" /></Button>}
        {data && <WhatsappAssign academyId={academyId} phone={phone} assignedUserId={data.assignedUserId} />}
        {group
          ? <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)} data-testid="button-group-add"><UserPlus className="me-1.5 h-4 w-4" aria-hidden="true" />{native.addMembers}</Button>
          : <Button type="button" variant="outline" size="sm" onClick={() => setInfoOpen(true)} data-testid="button-chat-info"><UserRoundCog className="me-1.5 h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">{copy.contact.editTitle}</span></Button>}
        {canManage && data && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={team.chat.actions} data-testid="button-chat-actions"><MoreVertical className="h-4 w-4" aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={() => chatState.mutate({ phone, state: { archived: !data.archived } as ChatState }, { onSuccess: () => { if (!data.archived) onHidden(); } })}>
                <Archive className="me-2 h-4 w-4" aria-hidden="true" />{data.archived ? team.chat.unarchive : team.chat.archive}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chatState.mutate({ phone, state: { muted: !data.muted } })}>
                <BellOff className="me-2 h-4 w-4" aria-hidden="true" />{data.muted ? team.chat.unmute : team.chat.mute}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {group ? (
                <DropdownMenuItem onSelect={() => setConfirm("unfollow")} className="text-red-300">
                  <LogOut className="me-2 h-4 w-4" aria-hidden="true" />{native.stopFollowing}
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem onSelect={() => (data.blocked ? chatState.mutate({ phone, state: { blocked: false } }) : setConfirm("block"))} className="text-red-300">
                    <ShieldOff className="me-2 h-4 w-4" aria-hidden="true" />{data.blocked ? team.chat.unblock : team.chat.block}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setConfirm("personal")}>
                    <EyeOff className="me-2 h-4 w-4" aria-hidden="true" />{team.chat.personal}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {confirm && (
        <div className="flex flex-wrap items-center gap-2 border-b border-red-400/30 bg-red-500/5 p-3 text-sm" role="alertdialog" data-testid="chat-confirm">
          <p className="w-full text-text">{confirm === "personal" ? team.chat.personalConfirm : confirm === "unfollow" ? native.stopFollowingConfirm : team.chat.blockConfirm}</p>
          <Button type="button" size="sm" className="bg-red-500 font-bold text-white hover:bg-red-600" disabled={chatState.isPending}
            onClick={() => chatState.mutate({ phone, state: confirm === "block" ? { blocked: true } : { personal: true } }, { onSuccess: () => { setConfirm(null); onHidden(); } })}>
            {team.chat.confirm}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>{team.chat.cancel}</Button>
        </div>
      )}
      {chatState.isError && <p className="border-b border-line px-3 py-2 text-xs text-red-400" role="alert">{(chatState.error as Error).message}</p>}
      {data?.blocked && <p className="border-b border-line bg-red-500/5 px-3 py-2 text-xs text-red-300">{team.chat.blockedNote}</p>}
      {data?.wrongNumber && <p className="border-b border-line bg-amber-300/5 px-3 py-2 text-xs text-amber-100">{native.wrongNumber}</p>}

      {unknown && contact && !data?.linkLater && contact.kind !== "other" && (
        <div className="border-b border-amber-300/20 bg-amber-300/5 p-3" data-testid="chat-who-is-this">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-amber-100">{copy.chats.unknownTitle}</p>
              <p className="mb-2 text-xs text-muted-text">{copy.chats.unknownBody}</p>
            </div>
            <button type="button" className="text-muted-text hover:text-text" aria-label={team.chat.later} onClick={() => who.mutate({ phone, action: "later" })}><X className="h-4 w-4" aria-hidden="true" /></button>
          </div>
          <LinkPlayerForm academyId={academyId} contactId={contact.id} />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" className="border border-line" disabled={who.isPending} onClick={() => who.mutate({ phone, action: "none" })} data-testid="button-who-none">{team.chat.noLink}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={who.isPending} onClick={() => who.mutate({ phone, action: "later" })} data-testid="button-who-later">{team.chat.later}</Button>
          </div>
        </div>
      )}
      {unknown && contact && (data?.linkLater || contact.kind === "other") && contact.players.length === 0 && (
        <button type="button" onClick={() => who.mutate({ phone, action: "ask" })} className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs text-muted-text hover:text-text" data-testid="button-who-again">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />{team.chat.linkAgain}
        </button>
      )}
      {data?.optedOut && <p className="border-b border-line bg-raised px-3 py-2 text-xs text-muted-text">{copy.chats.optedOut}</p>}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(47,216,196,0.04),transparent_60%)] p-4">
        {thread.isLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" aria-hidden="true" /> : data?.messages.map((m) => (
          <MessageBubble key={m.id} academyId={academyId} phone={phone} m={m} isGroup={Boolean(group)} names={names}
            kindLabel={m.direction === "out" && m.kind !== "chat" ? (
              <SourceLabel kind={m.kind} fromPhone={copy.chats.fromPhone}
                label={m.kind === "auto_reply" ? extras.autoReply : (waCopy.history.kinds[m.kind] ?? waCopy.automations.items[m.kind]?.title ?? m.kind)} />
            ) : null}
            onReply={(msg) => { setEditing(null); setReplyTo(msg); }}
            onEdit={(msg) => { setReplyTo(null); setEditing(msg); }}
            onJumpTo={(id) => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })} />
        ))}
        <div ref={bottom} />
      </div>

      <ChatComposer academyId={academyId} phone={phone} placeholder={copy.chats.typeMessage} disabled={data?.blocked || data?.wrongNumber}
        isGroup={Boolean(group)} mentionable={mentionable} replyTo={replyTo} onClearReply={() => setReplyTo(null)} editing={editing} onClearEdit={() => setEditing(null)} />
      <ChatSearchSheet academyId={academyId} phone={phone} open={panel === "search"} onOpenChange={(o) => setPanel(o ? "search" : null)} />
      <ChatMediaSheet academyId={academyId} phone={phone} open={panel === "media"} onOpenChange={(o) => setPanel(o ? "media" : null)} />
      {group && <GroupInfoSheet academyId={academyId} group={group} canManage={canManage} open={panel === "info"} onOpenChange={(o) => setPanel(o ? "info" : null)} />}

      {group && <AddToGroupDialog academyId={academyId} groupId={group.groupId} open={addOpen} onOpenChange={setAddOpen} />}
      {!group && (
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
      )}
    </div>
  );
}

/** Add People to a group the academy runs. */
function AddToGroupDialog({ academyId, groupId, open, onOpenChange }: { academyId: number; groupId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const native = useChatNativeCopy();
  const contacts = useContacts(academyId);
  const add = useAddToGroup(academyId);
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => { if (open) { setPicked([]); setQ(""); add.reset(); } }, [open]);
  const matches = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (contacts.data ?? []).filter((c) => !needle || [c.name, c.display, ...c.players.map((p) => p.playerName)].join(" ").toLocaleLowerCase().includes(needle)).slice(0, 60);
  }, [contacts.data, q]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-line bg-surface text-text" dir={native.locale === "ar" ? "rtl" : "ltr"}>
        <DialogHeader className="text-start"><DialogTitle>{native.addMembers}</DialogTitle></DialogHeader>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={native.searchPeople} />
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {matches.map((c) => (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-2 px-2.5 py-2 hover:bg-raised">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={() => setPicked((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id]))} className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{c.name || c.display}</span>
                <span className="text-xs text-muted-text" dir="ltr">{c.display}</span>
              </label>
            </li>
          ))}
        </ul>
        {add.isError && <p className="text-xs text-red-400" role="alert">{(add.error as Error).message}</p>}
        {add.isSuccess && <p className="text-xs text-turf">{native.added(add.data.added)}</p>}
        <Button type="button" disabled={picked.length === 0 || add.isPending} onClick={() => add.mutate({ groupId, contactIds: picked })} className="bg-floodlight font-bold text-void">
          {add.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{native.addMembers}{picked.length ? ` · ${native.members(picked.length)}` : ""}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useChatExtrasCopy } from "@/i18n/chat-extras-strings";
import {
  uploadChatFile,
  useChatOptions,
  useCreateChannel,
  useCreatePost,
  useDeletePost,
  useDeleteReply,
  useSaveChatOptions,
  useSaveReply,
  useSavedReplies,
  useWhatsappPosts,
  type ChatOptions,
  type MediaRef,
  type SavedReply,
} from "@/lib/academy-whatsapp-api";

type Tab = "replies" | "auto" | "posts";

/** Saved replies, auto-replies and read receipts, and Status & Channel posting. */
export function ChatToolsSheet({ academyId, isOwner, open, onOpenChange }: { academyId: number; isOwner: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const copy = useChatExtrasCopy();
  const [tab, setTab] = useState<Tab>("replies");
  // Auto-reply options and posting live in the WhatsApp section, which only the owner always has.
  const tabs: Array<[Tab, string]> = [["replies", copy.savedReplies], ...(isOwner ? [["auto", copy.autoReplies] as [Tab, string], ["posts", copy.postsTab] as [Tab, string]] : [])];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={copy.locale === "ar" ? "left" : "right"} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-lg" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <SheetHeader className="px-8 text-start"><SheetTitle>{copy.tools}</SheetTitle><SheetDescription className="sr-only">{copy.tools}</SheetDescription></SheetHeader>
        <div className="mt-3 flex flex-wrap gap-1.5 px-4">
          {tabs.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)} data-testid={`tools-tab-${key}`}
              className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", tab === key ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{label}</button>
          ))}
        </div>
        <div className="mt-4 px-4 pb-8">
          {tab === "replies" && <SavedRepliesTab academyId={academyId} />}
          {tab === "auto" && isOwner && <AutoRepliesTab academyId={academyId} />}
          {tab === "posts" && isOwner && <PostsTab academyId={academyId} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SavedRepliesTab({ academyId }: { academyId: number }) {
  const copy = useChatExtrasCopy();
  const list = useSavedReplies(academyId);
  const save = useSaveReply(academyId);
  const del = useDeleteReply(academyId);
  const [editing, setEditing] = useState<Partial<SavedReply> | null>(null);
  const canEdit = list.data?.canEdit ?? false;
  const valid = Boolean(editing?.shortcut?.trim() && editing?.title?.trim() && editing?.body?.trim());
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-text">{copy.savedRepliesHint}</p>
      {list.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-text" aria-hidden="true" />}
      {!list.isLoading && (list.data?.replies ?? []).length === 0 && <p className="text-sm text-muted-text">{copy.noSavedReplies}</p>}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {(list.data?.replies ?? []).map((r) => (
          <li key={r.id} className="flex items-start gap-2 p-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold"><span className="text-turf">/{r.shortcut}</span> · <span dir="auto">{r.title}</span></span>
              <span className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-text" dir="auto">{r.body}</span>
            </span>
            {canEdit && (
              <>
                <Button type="button" variant="ghost" size="icon" aria-label={copy.edit} onClick={() => setEditing(r)}><Pencil className="h-4 w-4" aria-hidden="true" /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label={copy.delete} disabled={del.isPending} onClick={() => del.mutate(r.id)}><Trash2 className="h-4 w-4 text-red-300" aria-hidden="true" /></Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!canEdit && !list.isLoading && <p className="text-xs text-muted-text">{copy.ownerOnlyEdit}</p>}
      {canEdit && !editing && <Button type="button" variant="outline" size="sm" onClick={() => setEditing({ shortcut: "", title: "", body: "" })} data-testid="button-new-saved-reply"><Plus className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.newReply}</Button>}
      {canEdit && editing && (
        <form className="space-y-2 rounded-xl border border-line p-3" onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          save.mutate({ id: editing.id, shortcut: editing.shortcut!.trim(), title: editing.title!.trim(), body: editing.body!.trim() }, { onSuccess: () => setEditing(null) });
        }}>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs font-semibold">{copy.shortcut}<Input value={editing.shortcut ?? ""} onChange={(e) => setEditing({ ...editing, shortcut: e.target.value })} placeholder={copy.shortcutPlaceholder} maxLength={30} dir="auto" data-testid="input-reply-shortcut" /></label>
            <label className="space-y-1 text-xs font-semibold">{copy.replyTitle}<Input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} maxLength={80} dir="auto" /></label>
          </div>
          <label className="block space-y-1 text-xs font-semibold">{copy.replyBody}<Textarea value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={4} maxLength={1500} dir="auto" data-testid="input-reply-body" /></label>
          {save.isError && <p className="text-xs text-red-400" role="alert">{(save.error as Error).message}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!valid || save.isPending} className="bg-floodlight font-bold text-void" data-testid="button-save-reply">{save.isPending && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}{copy.saveReply}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>×</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function AutoRepliesTab({ academyId }: { academyId: number }) {
  const copy = useChatExtrasCopy();
  const query = useChatOptions(academyId);
  const save = useSaveChatOptions(academyId);
  const [form, setForm] = useState<ChatOptions | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (query.data) setForm(query.data); }, [query.data]);
  if (!form) return <Loader2 className="h-4 w-4 animate-spin text-muted-text" aria-hidden="true" />;
  const locked = !form.canEdit;
  const set = (patch: Partial<ChatOptions>) => { setSaved(false); setForm({ ...form, ...patch }); };
  const block = (title: string, help: string, enabled: boolean, onEnabled: (v: boolean) => void, body: ReactNode) => (
    <section className="space-y-2 rounded-xl border border-line p-3">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-muted-text">{help}</span></span>
        <Switch checked={enabled} onCheckedChange={onEnabled} disabled={locked} aria-label={title} />
      </div>
      {enabled && body}
    </section>
  );
  return (
    <div className="space-y-3">
      {locked && <p className="text-xs text-muted-text">{copy.ownerOnlyEdit}</p>}
      <section className="flex items-start gap-3 rounded-xl border border-line p-3">
        <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{copy.readReceipts}</span><span className="block text-xs text-muted-text">{copy.readReceiptsHelp}</span></span>
        <Switch checked={form.readReceipts} onCheckedChange={(v) => set({ readReceipts: v })} disabled={locked} aria-label={copy.readReceipts} data-testid="switch-read-receipts" />
      </section>
      {block(copy.greeting, copy.greetingHelp, form.greeting.enabled, (v) => set({ greeting: { ...form.greeting, enabled: v } }),
        <Textarea value={form.greeting.text} onChange={(e) => set({ greeting: { ...form.greeting, text: e.target.value } })} rows={3} maxLength={1000} dir="auto" disabled={locked} aria-label={copy.messageText} />)}
      {block(copy.away, copy.awayHelp, form.away.enabled, (v) => set({ away: { ...form.away, enabled: v } }),
        <div className="space-y-2">
          <Textarea value={form.away.text} onChange={(e) => set({ away: { ...form.away, text: e.target.value } })} rows={3} maxLength={1000} dir="auto" disabled={locked} aria-label={copy.messageText} />
          <p className="text-xs font-semibold">{copy.openDays}</p>
          <div className="flex flex-wrap gap-1.5">
            {copy.days.map((label, day) => (
              <button key={day} type="button" disabled={locked} onClick={() => set({ away: { ...form.away, days: form.away.days.includes(day) ? form.away.days.filter((d) => d !== day) : [...form.away.days, day].sort() } })}
                className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", form.away.days.includes(day) ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{label}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs font-semibold">{copy.openFrom}<Input type="time" value={form.away.start} onChange={(e) => set({ away: { ...form.away, start: e.target.value } })} disabled={locked} dir="ltr" /></label>
            <label className="space-y-1 text-xs font-semibold">{copy.openTo}<Input type="time" value={form.away.end} onChange={(e) => set({ away: { ...form.away, end: e.target.value } })} disabled={locked} dir="ltr" /></label>
          </div>
        </div>)}
      {block(copy.missedCall, copy.missedCallHelp, form.missedCall.enabled, (v) => set({ missedCall: { ...form.missedCall, enabled: v } }),
        <Textarea value={form.missedCall.text} onChange={(e) => set({ missedCall: { ...form.missedCall, text: e.target.value } })} rows={3} maxLength={1000} dir="auto" disabled={locked} aria-label={copy.messageText} />)}
      {save.isError && <p className="text-xs text-red-400" role="alert">{(save.error as Error).message}</p>}
      {!locked && (
        <Button type="button" disabled={save.isPending} className="bg-floodlight font-bold text-void" data-testid="button-save-options"
          onClick={() => save.mutate({ readReceipts: form.readReceipts, greeting: form.greeting, away: form.away, missedCall: form.missedCall }, { onSuccess: () => setSaved(true) })}>
          {save.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : saved ? <Check className="me-2 h-4 w-4" aria-hidden="true" /> : null}{saved ? copy.saved : copy.save}
        </Button>
      )}
    </div>
  );
}

const STATUS_COLORS = ["#38b42f", "#128c7e", "#075e54", "#1d4ed8", "#7c3aed", "#be185d", "#b91c1c", "#c2410c", "#111827"];

function PostsTab({ academyId }: { academyId: number }) {
  const copy = useChatExtrasCopy();
  const posts = useWhatsappPosts(academyId, true);
  const create = useCreatePost(academyId);
  const del = useDeletePost(academyId);
  const channel = useCreateChannel(academyId);
  const [target, setTarget] = useState<"status" | "channel">("status");
  const [kind, setKind] = useState<"text" | "image" | "video">("text");
  const [text, setText] = useState("");
  const [color, setColor] = useState(STATUS_COLORS[0]);
  const [media, setMedia] = useState<{ ref: MediaRef; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [channelDesc, setChannelDesc] = useState("");
  const input = useRef<HTMLInputElement>(null);

  if (posts.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-text" aria-hidden="true" />;
  if (posts.isError) return <p className="text-sm text-muted-text">{(posts.error as Error).message}</p>;
  const data = posts.data!;
  if (!data.ownNumber) return <p className="rounded-lg bg-amber-300/10 p-3 text-sm text-amber-100">{copy.needOwnNumber}</p>;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const { media: ref } = await uploadChatFile(academyId, file, file.name);
      setMedia({ ref, name: file.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const ready = kind === "text" ? text.trim().length > 0 : Boolean(media);
  const submit = () => {
    setError(null);
    setDone(false);
    create.mutate(
      { target, kind, ...(kind === "text" ? { text: text.trim(), backgroundColor: color } : { media: media!.ref, caption: text.trim() || undefined }) },
      { onSuccess: () => { setText(""); setMedia(null); setDone(true); }, onError: (e) => setError((e as Error).message) },
    );
  };

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <p className="text-sm font-semibold">{copy.statusTitle}</p>
        <p className="text-xs text-muted-text">{copy.statusHelp}</p>
      </section>

      <section className="space-y-2 rounded-xl border border-line p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold">{copy.postTo}</span>
          {(["status", "channel"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTarget(t)} className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", target === t ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{t === "status" ? copy.statusTarget : copy.channelTarget}</button>
          ))}
        </div>
        {target === "channel" && !data.channel ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-text">{copy.channelHelp}</p>
            <Input value={channelName} onChange={(e) => setChannelName(e.target.value)} placeholder={copy.channelName} maxLength={100} dir="auto" />
            <Input value={channelDesc} onChange={(e) => setChannelDesc(e.target.value)} placeholder={copy.channelDescription} maxLength={500} dir="auto" />
            {channel.isError && <p className="text-xs text-red-400" role="alert">{(channel.error as Error).message}</p>}
            <Button type="button" disabled={channelName.trim().length < 2 || channel.isPending} onClick={() => channel.mutate({ name: channelName.trim(), description: channelDesc.trim() })}>
              {channel.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{copy.createChannel}
            </Button>
          </div>
        ) : (
          <>
            {target === "channel" && data.channel?.invite && (
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold">{copy.channelInvite}</span>
                <span className="min-w-0 flex-1 truncate text-muted-text" dir="ltr">{data.channel.invite}</span>
                <Button type="button" size="icon" variant="ghost" aria-label={copy.copyLink} onClick={() => void navigator.clipboard?.writeText(data.channel!.invite!)}><Copy className="h-4 w-4" aria-hidden="true" /></Button>
              </div>
            )}
            <div className="flex gap-1.5">
              {(["text", "image", "video"] as const).map((k) => (
                <button key={k} type="button" onClick={() => { setKind(k); setMedia(null); }} className={cn("min-h-8 rounded-full px-3 text-xs font-semibold", kind === k ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>
                  {k === "text" ? copy.postText : k === "image" ? copy.postPhoto : copy.postVideo}
                </button>
              ))}
            </div>
            {kind !== "text" && (
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => input.current?.click()}>{uploading && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}{copy.chooseFile}</Button>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-text" dir="auto">{media?.name}</span>
                <input ref={input} type="file" accept={kind === "image" ? "image/*" : "video/*"} className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
            )}
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} dir="auto" placeholder={copy.statusPlaceholder}
              style={target === "status" && kind === "text" ? { backgroundColor: color, color: "#fff" } : undefined} data-testid="input-status-text" />
            {target === "status" && kind === "text" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold">{copy.background}</span>
                {STATUS_COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} className={cn("h-6 w-6 rounded-full border-2", color === c ? "border-white" : "border-transparent")} style={{ backgroundColor: c }} />
                ))}
              </div>
            )}
            {target === "channel" && <p className="text-[11px] text-muted-text">{copy.channelBeta}</p>}
            {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
            {done && <p className="text-xs text-turf" role="status">{copy.posted}</p>}
            <Button type="button" disabled={!ready || create.isPending || uploading} onClick={submit} className="bg-floodlight font-bold text-void" data-testid="button-post">
              {create.isPending ? <><Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />{copy.posting}</> : copy.post}
            </Button>
          </>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold">{copy.recentPosts}</p>
        {data.posts.length === 0 && <p className="text-xs text-muted-text">{copy.noPosts}</p>}
        <ul className="divide-y divide-line rounded-xl border border-line">
          {data.posts.map((p) => (
            <li key={p.id} className="flex items-center gap-2 p-2.5">
              {p.mediaUrl && p.kind === "image" && <img src={p.mediaUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" dir="auto">{p.text || (p.kind === "image" ? copy.postPhoto : copy.postVideo)}</span>
                <span className="text-[11px] text-muted-text">{p.target === "status" ? copy.statusTarget : copy.channelTarget} · {new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" }).format(new Date(p.createdAt))}</span>
                {p.error && <span className="block text-[11px] text-red-400">{p.error}</span>}
              </span>
              {p.canDelete && <Button type="button" variant="ghost" size="icon" aria-label={copy.delete} disabled={del.isPending} onClick={() => del.mutate(p.id)}><Trash2 className="h-4 w-4 text-red-300" aria-hidden="true" /></Button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

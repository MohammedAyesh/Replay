import { useEffect, useRef, useState } from "react";
import { Copy, FileText, Loader2, MoreVertical, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useChatExtrasCopy } from "@/i18n/chat-extras-strings";
import {
  uploadChatFile,
  useChatMedia,
  useChatSearch,
  useGroupInvite,
  useGroupMemberAction,
  useGroupMembers,
  useResetGroupInvite,
  useUpdateGroup,
  type ChatGroup,
} from "@/lib/academy-whatsapp-api";
import { ChatContentView } from "./chat-native";

function useSide() {
  const { locale } = useChatExtrasCopy();
  return { side: (locale === "ar" ? "left" : "right") as "left" | "right", dir: (locale === "ar" ? "rtl" : "ltr") as "rtl" | "ltr" };
}

/** Find a message in this chat by its words. Picking one scrolls to it when it is on screen. */
export function ChatSearchSheet({ academyId, phone, open, onOpenChange }: { academyId: number; phone: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const extras = useChatExtrasCopy();
  const { side, dir } = useSide();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (open) setQ(""); }, [open]);
  const hits = useChatSearch(academyId, phone, term);
  const fmt = new Intl.DateTimeFormat(extras.locale === "ar" ? "ar-JO" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Amman" });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={dir}>
        <SheetHeader className="px-8 text-start"><SheetTitle>{extras.searchChat}</SheetTitle><SheetDescription className="sr-only">{extras.searchPlaceholder}</SheetDescription></SheetHeader>
        <div className="mt-4 space-y-3 px-4">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={extras.searchPlaceholder} className="ps-9" autoFocus data-testid="input-chat-search-in" />
          </div>
          {hits.isFetching && <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-text" aria-hidden="true" />}
          {term.length >= 2 && !hits.isFetching && (hits.data ?? []).length === 0 && <p className="text-sm text-muted-text">{extras.noResults}</p>}
          <ul className="divide-y divide-line">
            {(hits.data ?? []).map((h) => (
              <li key={h.id}>
                <button type="button" className="block w-full px-1 py-2.5 text-start hover:bg-raised"
                  onClick={() => { onOpenChange(false); setTimeout(() => document.getElementById(`msg-${h.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 250); }}>
                  <span className="block text-[11px] text-muted-text">{h.direction === "out" ? extras.you : h.author ?? ""} · {fmt.format(new Date(h.createdAt))}</span>
                  <span className="line-clamp-2 text-sm" dir="auto">{h.body}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Every photo, video, file and place shared in this chat. */
export function ChatMediaSheet({ academyId, phone, open, onOpenChange }: { academyId: number; phone: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const extras = useChatExtrasCopy();
  const { side, dir } = useSide();
  const media = useChatMedia(academyId, phone, open);
  const items = media.data ?? [];
  const visual = items.filter((m) => m.content && (m.content.type === "image" || m.content.type === "sticker" || (m.content.type === "video" && m.content.media.url)));
  const others = items.filter((m) => !visual.includes(m));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={dir}>
        <SheetHeader className="px-8 text-start"><SheetTitle>{extras.mediaTab}</SheetTitle><SheetDescription className="sr-only">{extras.mediaTab}</SheetDescription></SheetHeader>
        <div className="mt-4 space-y-4 px-4">
          {media.isLoading && <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-text" aria-hidden="true" />}
          {!media.isLoading && items.length === 0 && <p className="text-sm text-muted-text">{extras.noMedia}</p>}
          {visual.length > 0 && (
            <div className="grid grid-cols-3 gap-1.5">
              {visual.map((m) => {
                const c = m.content!;
                const url = "media" in c ? c.media.url : null;
                if (!url) return null;
                return c.type === "video"
                  ? <a key={m.id} href={url} target="_blank" rel="noreferrer"><video src={url} muted preload="metadata" className="aspect-square w-full rounded-lg object-cover" /></a>
                  : <a key={m.id} href={url} target="_blank" rel="noreferrer"><img src={url} alt="" loading="lazy" className="aspect-square w-full rounded-lg object-cover" /></a>;
              })}
            </div>
          )}
          <ul className="space-y-2">
            {others.map((m) => (
              <li key={m.id} className="rounded-xl bg-raised p-2.5">
                {m.content?.type === "location" ? <ChatContentView content={m.content} body={m.body} />
                  : m.content ? <ChatContentView content={m.content} body={m.body} /> : <span className="flex items-center gap-2 text-sm"><FileText className="h-4 w-4" aria-hidden="true" />{m.body}</span>}
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Rename a group, set it to announcements-only, change its photo, manage admins, and share its invite link. */
export function GroupInfoSheet({ academyId, group, canManage, open, onOpenChange }: { academyId: number; group: ChatGroup; canManage: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const extras = useChatExtrasCopy();
  const { side, dir } = useSide();
  const members = useGroupMembers(academyId, group.groupId, open);
  const update = useUpdateGroup(academyId, group.groupId);
  const act = useGroupMemberAction(academyId, group.groupId);
  const invite = useGroupInvite(academyId, group.groupId, open);
  const resetInvite = useResetGroupInvite(academyId, group.groupId);
  const [subject, setSubject] = useState(group.subject);
  const [description, setDescription] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setSubject(group.subject); setDescription(""); setNote(null); setError(null); setRemoving(null); } }, [open, group.subject]);

  const run = (patch: Parameters<typeof update.mutate>[0]) => {
    setError(null);
    update.mutate(patch, { onSuccess: () => setNote(extras.saved), onError: (e) => setError((e as Error).message) });
  };
  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { media } = await uploadChatFile(academyId, file, file.name);
      run({ picture: media });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={dir}>
        <SheetHeader className="px-8 text-start"><SheetTitle>{extras.groupInfo}</SheetTitle><SheetDescription className="text-start">{group.subject}</SheetDescription></SheetHeader>
        <div className="mt-4 space-y-5 px-4 pb-8">
          {!canManage && <p className="rounded-lg bg-raised p-2.5 text-xs text-muted-text">{extras.needManage}</p>}
          {canManage && (
            <>
              <section className="space-y-2">
                <label className="block text-sm font-semibold">{extras.groupName}</label>
                <div className="flex gap-2">
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={100} dir="auto" data-testid="input-group-subject" />
                  <Button type="button" disabled={!subject.trim() || subject.trim() === group.subject || update.isPending} onClick={() => run({ subject: subject.trim() })}>{extras.save}</Button>
                </div>
                <label className="block text-sm font-semibold">{extras.groupDescription}</label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2048} dir="auto" />
                <Button type="button" size="sm" variant="outline" disabled={update.isPending} onClick={() => run({ description })}>{extras.save}</Button>
              </section>
              <section className="space-y-2">
                <p className="text-sm font-semibold">{extras.groupPhoto}</p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={uploading} onClick={() => photo.current?.click()}>{uploading && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}{extras.changePhoto}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={update.isPending} onClick={() => run({ picture: null })}>{extras.removePhoto}</Button>
                  <input ref={photo} type="file" accept="image/*" className="hidden" onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
                </div>
              </section>
              <section className="space-y-2">
                <ToggleRow label={extras.onlyAdminsPost} help={extras.onlyAdminsPostHelp} disabled={update.isPending} onSet={(v) => run({ adminsOnlyMessages: v })} />
                <ToggleRow label={extras.onlyAdminsInfo} disabled={update.isPending} onSet={(v) => run({ adminsOnlyInfo: v })} />
              </section>
            </>
          )}
          {note && <p className="text-xs text-turf" role="status">{note}</p>}
          {error && <p className="text-xs text-red-400" role="alert">{error}</p>}

          <section className="space-y-2">
            <p className="text-sm font-semibold">{extras.inviteLink}</p>
            {invite.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-text" aria-hidden="true" /> : invite.data?.link ? (
              <div className="flex items-center gap-2">
                <Input readOnly value={invite.data.link} dir="ltr" className="text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" size="icon" variant="outline" aria-label={extras.copyLink} onClick={() => { void navigator.clipboard?.writeText(invite.data!.link!); setNote(extras.copied); }}><Copy className="h-4 w-4" aria-hidden="true" /></Button>
              </div>
            ) : <p className="text-xs text-muted-text">—</p>}
            {canManage && <Button type="button" size="sm" variant="ghost" disabled={resetInvite.isPending} onClick={() => resetInvite.mutate()}>{extras.resetLink}</Button>}
          </section>

          <section className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold"><Users className="h-4 w-4" aria-hidden="true" />{extras.members}{members.data ? ` · ${members.data.length}` : ""}</p>
            {members.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-text" aria-hidden="true" />}
            {members.isError && <p className="text-xs text-muted-text">{(members.error as Error).message}</p>}
            <ul className="divide-y divide-line">
              {(members.data ?? []).map((m, i) => (
                <li key={m.phone ?? i} className="flex items-center gap-2 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold" dir="auto">{m.name || m.display || "—"}</span>
                    {m.name && m.display && <span className="block text-xs text-muted-text" dir="ltr">{m.display}</span>}
                  </span>
                  {m.admin && <span className="inline-flex items-center gap-1 rounded-full bg-turf/10 px-2 py-0.5 text-[11px] font-semibold text-turf"><ShieldCheck className="h-3 w-3" aria-hidden="true" />{extras.admin}</span>}
                  {canManage && m.phone && (
                    removing === m.phone ? (
                      <span className="flex items-center gap-1">
                        <Button type="button" size="sm" className="bg-red-500 text-white hover:bg-red-600" disabled={act.isPending} onClick={() => act.mutate({ action: "remove", phones: [m.phone!] }, { onSuccess: () => setRemoving(null) })}>{extras.removeMember}</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(null)}>×</Button>
                      </span>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={extras.members}><MoreVertical className="h-4 w-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => act.mutate({ action: m.admin ? "demote" : "promote", phones: [m.phone!] })}><ShieldCheck className="me-2 h-4 w-4" aria-hidden="true" />{m.admin ? extras.removeAdmin : extras.makeAdmin}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-red-300" onSelect={() => setRemoving(m.phone)}><Trash2 className="me-2 h-4 w-4" aria-hidden="true" />{extras.removeMember}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  )}
                </li>
              ))}
            </ul>
            {act.isError && <p className="text-xs text-red-400" role="alert">{(act.error as Error).message}</p>}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** We can't read a group's current setting, so offer both directions. */
function ToggleRow({ label, help, disabled, onSet }: { label: string; help?: string; disabled: boolean; onSet: (on: boolean) => void }) {
  const copy = useChatExtrasCopy();
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        {help && <span className="block text-xs text-muted-text">{help}</span>}
      </span>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onSet(true)}>{copy.enabled}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onSet(false)} className={cn("text-muted-text")}>{copy.off}</Button>
    </div>
  );
}


import { useMemo, useState } from "react";
import { MessageCircle, Plus, Search, Send, UserRoundPen } from "lucide-react";
import { usePeopleCopy } from "@/i18n/people-strings";
import {
  LEAD_STAGES,
  useContacts,
  useSendToContacts,
  useUpdateContact,
  type Contact,
  type LeadStage,
} from "@/lib/academy-whatsapp-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useConsoleKind } from "@/lib/console-kind";
import { ContactEditor, RelationshipChips } from "./contact-editor";
import { TrialsCard } from "./trials-card";
import { useMarketingCopy } from "@/i18n/marketing-strings";

type Segment = "all" | "lead" | "parent" | "player" | "coach" | "unknown";
const SEGMENTS: Segment[] = ["all", "lead", "parent", "player", "coach", "unknown"];
/** Field console: customers first, no families. */
const VENUE_SEGMENTS: Segment[] = ["all", "player", "lead", "coach", "unknown"];

const KIND_TONE: Record<string, string> = {
  lead: "bg-floodlight/15 text-floodlight",
  parent: "bg-turf/15 text-turf",
  player: "bg-sky-400/15 text-sky-300",
  coach: "bg-violet-400/15 text-violet-300",
  staff: "bg-violet-400/15 text-violet-300",
  other: "bg-raised text-muted-text",
  unknown: "bg-amber-300/15 text-amber-200",
};

const STAGE_TONE: Record<LeadStage, string> = {
  new: "bg-sky-400/15 text-sky-300",
  contacted: "bg-violet-400/15 text-violet-300",
  trial: "bg-amber-300/15 text-amber-200",
  joined: "bg-turf/15 text-turf",
  lost: "bg-raised text-muted-text",
};

function matchesSegment(contact: Contact, segment: Segment) {
  if (segment === "all") return true;
  if (segment === "parent") return contact.kind === "parent";
  if (segment === "coach") return contact.kind === "coach" || contact.kind === "staff";
  if (segment === "unknown") return contact.kind === "unknown" || contact.kind === "other";
  return contact.kind === segment;
}

export function AcademyPeopleSection({ academyId, isOwner, onOpenChat }: { academyId: number; isOwner: boolean; onOpenChat: (phone: string) => void }) {
  const copy = usePeopleCopy();
  const marketing = useMarketingCopy();
  const contacts = useContacts(academyId);
  const updateContact = useUpdateContact(academyId);
  const [segment, setSegment] = useState<Segment>("all");
  const [stage, setStage] = useState<LeadStage | null>(null);
  const [tag, setTag] = useState<string>("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);

  const kind = useConsoleKind();
  const segments = kind === "venue" ? VENUE_SEGMENTS : SEGMENTS;
  const all = contacts.data ?? [];
  const tags = useMemo(() => [...new Set(all.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b)), [all]);
  const leads = all.filter((c) => c.kind === "lead");
  const stageCounts = Object.fromEntries(LEAD_STAGES.map((s) => [s, leads.filter((c) => (c.stage ?? "new") === s).length])) as Record<LeadStage, number>;

  const list = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return all.filter((c) => {
      if (!matchesSegment(c, segment)) return false;
      if (segment === "lead" && stage && (c.stage ?? "new") !== stage) return false;
      if (tag && !c.tags.includes(tag)) return false;
      if (!q) return true;
      return [c.name, c.display, c.phone, c.notes, ...c.tags, ...c.players.map((p) => p.playerName)].join(" ").toLocaleLowerCase().includes(q);
    });
  }, [all, segment, stage, tag, query]);

  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);
  const referrals = useMemo(() => {
    const n = new Map<number, number>();
    for (const c of all) if (c.referredByContactId) n.set(c.referredByContactId, (n.get(c.referredByContactId) ?? 0) + 1);
    return n;
  }, [all]);
  const editingContact = editing && editing !== "new" ? all.find((c) => c.id === editing.id) ?? editing : null;
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allVisibleSelected = list.length > 0 && list.every((c) => selected.includes(c.id));

  return (
    <section className="space-y-5" data-testid="academy-people" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.people.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.people.description}</p>
        </div>
        <Button type="button" onClick={() => setEditing("new")} className="min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void" data-testid="button-add-person"><Plus className="me-2 h-4 w-4" aria-hidden="true" />{copy.people.add}</Button>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {segments.map((s) => {
          const n = all.filter((c) => matchesSegment(c, s)).length;
          return (
            <button key={s} type="button" onClick={() => { setSegment(s); setStage(null); }}
              className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", segment === s ? "bg-turf/15 text-turf" : "bg-raised text-muted-text hover:text-text")}
              data-testid={`people-segment-${s}`}>
              {copy.people.segments[s]} <span className="tabular-nums opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {segment === "lead" && (
        <div className="grid grid-cols-5 gap-2" data-testid="people-pipeline">
          {LEAD_STAGES.map((s) => (
            <button key={s} type="button" onClick={() => setStage(stage === s ? null : s)}
              className={cn("rounded-2xl border p-3 text-start transition-colors", stage === s ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text")}>
              <span className="block text-[11px] font-bold uppercase tracking-wide text-muted-text">{copy.contact.stages[s]}</span>
              <span className="mt-1 block font-display text-2xl font-bold tabular-nums text-text">{stageCounts[s]}</span>
            </button>
          ))}
        </div>
      )}

      {kind !== "venue" && (segment === "lead" || segment === "all") && <TrialsCard academyId={academyId} hideWhenEmpty={segment === "all"} />}

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.people.search} className="min-h-10 ps-9" data-testid="input-people-search" />
        </div>
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)} className="min-h-10 rounded-lg border border-input bg-raised px-3 text-sm text-text sm:w-48">
            <option value="">{copy.people.allTags}</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {selected.length > 0 && (
        <div className="sticky top-2 z-10 flex items-center gap-2 rounded-xl border border-turf/40 bg-surface/95 p-2.5 shadow-lg backdrop-blur" data-testid="people-selection">
          <span className="text-sm font-semibold text-text">{copy.people.selected(selected.length)}</span>
          <Button type="button" size="sm" onClick={() => setMessageOpen(true)} className="ms-auto bg-floodlight font-bold text-void" data-testid="button-message-selected"><Send className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.people.message}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>{copy.people.clear}</Button>
        </div>
      )}

      {contacts.isLoading ? <div className="space-y-2">{[0, 1, 2, 3].map((n) => <div key={n} className="h-16 animate-pulse rounded-xl bg-raised" />)}</div>
        : contacts.isError ? <p className="text-sm text-red-400" role="alert">{copy.contact.error}</p>
          : list.length === 0 ? <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted-text">{copy.people.noResults}</p>
            : (
              <div className="overflow-hidden rounded-2xl border border-line bg-surface">
                <label className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-muted-text">
                  <input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? selected.filter((id) => !list.some((c) => c.id === id)) : [...new Set([...selected, ...list.map((c) => c.id)])])} className="h-4 w-4 accent-[#2FD8C4]" />
                  {list.length}
                </label>
                <ul className="divide-y divide-line">
                  {list.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 px-4 py-3" data-testid={`person-${c.id}`}>
                      <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} className="mt-1.5 h-4 w-4 shrink-0 accent-[#2FD8C4]" aria-label={c.name ?? c.display} />
                      <button type="button" onClick={() => setEditing(c)} className="min-w-0 flex-1 text-start">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-text" dir="auto">{c.name || c.display}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", KIND_TONE[c.kind])}>{copy.contact.kinds[c.kind]}</span>
                          {c.kind === "lead" && <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", STAGE_TONE[(c.stage ?? "new") as LeadStage])}>{copy.contact.stages[c.stage ?? "new"]}</span>}
                          {c.tags.map((t) => <span key={t} className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[11px] text-violet-200" dir="auto">{t}</span>)}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-text" dir="ltr">{c.display}</span>
                        <RelationshipChips contact={c} className="mt-1" />
                        {(c.referredByContactId || referrals.get(c.id)) ? (
                          <span className="mt-1 flex flex-wrap gap-1.5 text-[11px]" data-testid={`referral-${c.id}`}>
                            {c.referredByContactId && byId.get(c.referredByContactId) && <span className="rounded-full bg-turf/10 px-2 py-0.5 text-turf" dir="auto">{marketing.referral.chip(byId.get(c.referredByContactId)!.name || byId.get(c.referredByContactId)!.display)}{c.referralNote ? ` · ${c.referralNote}` : ""}</span>}
                            {referrals.get(c.id) ? <span className="rounded-full bg-raised px-2 py-0.5 text-muted-text">{marketing.referral.count(referrals.get(c.id)!)}</span> : null}
                          </span>
                        ) : null}
                        {c.notes && <span className="mt-1 line-clamp-1 block text-xs text-muted-text" dir="auto">{c.notes}</span>}
                      </button>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {c.kind === "lead" && (
                          <select value={c.stage ?? "new"} onChange={(e) => updateContact.mutate({ id: c.id, stage: e.target.value as LeadStage })}
                            className="h-8 rounded-lg border border-input bg-raised px-2 text-xs text-text" aria-label={copy.contact.stage} data-testid={`select-stage-${c.id}`}>
                            {LEAD_STAGES.map((s) => <option key={s} value={s}>{copy.contact.stages[s]}</option>)}
                          </select>
                        )}
                        <div className="flex gap-1">
                          <Button type="button" size="sm" variant="ghost" className="h-8 px-2" onClick={() => onOpenChat(c.phone)} aria-label={copy.people.openChat}><MessageCircle className="h-4 w-4" aria-hidden="true" /></Button>
                          <Button type="button" size="sm" variant="ghost" className="h-8 px-2" onClick={() => setEditing(c)} aria-label={copy.contact.editTitle}><UserRoundPen className="h-4 w-4" aria-hidden="true" /></Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <SheetContent side={copy.locale === "ar" ? "left" : "right"} className="w-full overflow-y-auto border-line bg-surface text-text sm:max-w-md" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
          <SheetHeader className="px-8 text-start">
            <SheetTitle>{editing === "new" ? copy.contact.addTitle : (editingContact?.name || editingContact?.display)}</SheetTitle>
            <SheetDescription dir="ltr" className="text-start">{editing === "new" ? "" : editingContact?.display}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {editing === "new"
              ? <ContactEditor academyId={academyId} contact={null} onDone={(created) => setEditing(created)} />
              : editingContact && <ContactEditor academyId={academyId} contact={editingContact} isOwner={isOwner} onDeleted={() => setEditing(null)} />}
          </div>
        </SheetContent>
      </Sheet>

      <MessageSelectedDialog academyId={academyId} contactIds={selected} open={messageOpen} onOpenChange={setMessageOpen} onSent={() => setSelected([])} />
    </section>
  );
}

function MessageSelectedDialog({ academyId, contactIds, open, onOpenChange, onSent }: {
  academyId: number; contactIds: number[]; open: boolean; onOpenChange: (open: boolean) => void; onSent: () => void;
}) {
  const copy = usePeopleCopy();
  const send = useSendToContacts(academyId);
  const [body, setBody] = useState("");
  const [note, setNote] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setNote(null); }}>
      <DialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{copy.people.messageTitle(contactIds.length)}</DialogTitle>
          <DialogDescription className="text-start text-muted-text">{copy.people.messageHint}</DialogDescription>
        </DialogHeader>
        <Textarea dir="auto" rows={6} value={body} onChange={(e) => setBody(e.target.value)} className="resize-y" data-testid="input-people-message" />
        {note && <p className="text-sm text-turf" role="status">{note}</p>}
        {send.isError && <p className="text-sm text-red-400" role="alert">{(send.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{copy.contact.cancel}</Button>
          <Button type="button" disabled={!body.trim() || send.isPending || contactIds.length === 0} className="bg-floodlight font-bold text-void" data-testid="button-send-people-message"
            onClick={() => send.mutate({ body: body.trim(), contactIds }, { onSuccess: (r) => { setNote(copy.people.sendQueued(r.queued)); setBody(""); onSent(); } })}>
            <Send className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.people.message}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

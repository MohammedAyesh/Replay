import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link2, Loader2, Trash2, UserRound, X } from "lucide-react";
import { usePeopleCopy } from "@/i18n/people-strings";
import {
  CONTACT_KINDS,
  LEAD_STAGES,
  RELATIONSHIPS,
  useCreateContact,
  useDeleteContact,
  useLinkContact,
  useUnlinkContact,
  useUpdateContact,
  useWhatsappOverview,
  type Contact,
  type ContactKind,
  type LeadStage,
  type Relationship,
} from "@/lib/academy-whatsapp-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const selectClass = "min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text";

/** A person's chips: "Father — Ali", "Ali himself". */
export function RelationshipChips({ contact, className }: { contact: Pick<Contact, "players">; className?: string }) {
  const copy = usePeopleCopy();
  if (contact.players.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {contact.players.map((p) => (
        <span key={p.playerId} className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", p.isActive ? "bg-turf/10 text-turf" : "bg-raised text-muted-text line-through")} dir="auto">
          {p.relationship === "self" ? copy.contact.self(p.playerName) : copy.contact.relationTo(copy.contact.relationships[p.relationship], p.playerName)}
        </span>
      ))}
    </span>
  );
}

/** Link a number to a player with its relationship. Used inline in Chats and in the person editor. */
export function LinkPlayerForm({
  academyId,
  contactId,
  onLinked,
  autoFocus,
}: {
  academyId: number;
  contactId: number;
  onLinked?: () => void;
  autoFocus?: boolean;
}) {
  const copy = usePeopleCopy();
  const overview = useWhatsappOverview(academyId);
  const link = useLinkContact(academyId);
  const [playerId, setPlayerId] = useState("");
  const [relationship, setRelationship] = useState<Relationship>("father");
  const squads = new Map((overview.data?.squads ?? []).map((s) => [s.id, s.name]));
  const players = overview.data?.players ?? [];

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1 space-y-1">
        <Label className="text-xs">{copy.contact.pickPlayer}</Label>
        <select autoFocus={autoFocus} value={playerId} onChange={(e) => setPlayerId(e.target.value)} className={selectClass} data-testid="select-link-player">
          <option value="">—</option>
          {players.map((p) => <option key={p.id} value={p.id}>{p.name}{p.squadId && squads.get(p.squadId) ? ` · ${squads.get(p.squadId)}` : ""}</option>)}
        </select>
      </div>
      <div className="space-y-1 sm:w-40">
        <Label className="text-xs">{copy.contact.relationship}</Label>
        <select value={relationship} onChange={(e) => setRelationship(e.target.value as Relationship)} className={selectClass} data-testid="select-link-relationship">
          {RELATIONSHIPS.map((r) => <option key={r} value={r}>{copy.contact.relationships[r]}</option>)}
        </select>
      </div>
      <Button
        type="button"
        disabled={!playerId || link.isPending}
        onClick={() => link.mutate({ contactId, playerId: Number(playerId), relationship }, { onSuccess: () => { setPlayerId(""); onLinked?.(); } })}
        className="min-h-10 bg-floodlight font-bold text-void"
        data-testid="button-link-player"
      >
        {link.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <><Link2 className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.contact.link}</>}
      </Button>
    </div>
  );
}

function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const copy = usePeopleCopy();
  const [draft, setDraft] = useState("");
  const add = () => {
    const tag = draft.trim();
    if (tag && !value.includes(tag) && value.length < 20) onChange([...value, tag]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="space-y-1">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-raised px-2 py-1.5">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-violet-400/15 px-2 py-0.5 text-xs font-semibold text-violet-200" dir="auto">
            {tag}
            <button type="button" onClick={() => onChange(value.filter((t) => t !== tag))} aria-label={`× ${tag}`}><X className="h-3 w-3" aria-hidden="true" /></button>
          </span>
        ))}
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} className="min-w-[8rem] flex-1 bg-transparent text-sm text-text outline-none" dir="auto" data-testid="input-contact-tag" />
      </div>
      <p className="text-[11px] text-muted-text">{copy.contact.tagsHint}</p>
    </div>
  );
}

/**
 * Edit a person (or add one when `contact` is null): name, who they are, pipeline
 * stage for interested people, tags, notes, and the players they are linked to.
 */
export function ContactEditor({
  academyId,
  contact,
  initialPhone,
  onDone,
  onDeleted,
  isOwner,
}: {
  academyId: number;
  contact: Contact | null;
  initialPhone?: string;
  onDone?: (contact: Contact) => void;
  onDeleted?: () => void;
  isOwner?: boolean;
}) {
  const copy = usePeopleCopy();
  const create = useCreateContact(academyId);
  const update = useUpdateContact(academyId);
  const remove = useDeleteContact(academyId);
  const unlink = useUnlinkContact(academyId);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [name, setName] = useState(contact?.name ?? "");
  const [kind, setKind] = useState<ContactKind>(contact?.kind ?? "lead");
  const [stage, setStage] = useState<LeadStage | "">(contact?.stage ?? "");
  const [tags, setTags] = useState<string[]>(contact?.tags ?? []);
  const [notes, setNotes] = useState(contact?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(contact?.name ?? "");
    setKind(contact?.kind ?? "lead");
    setStage(contact?.stage ?? "");
    setTags(contact?.tags ?? []);
    setNotes(contact?.notes ?? "");
    setSaved(false);
  }, [contact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => !contact
    || (contact.name ?? "") !== name
    || contact.kind !== kind
    || (contact.stage ?? "") !== stage
    || JSON.stringify(contact.tags) !== JSON.stringify(tags)
    || (contact.notes ?? "") !== notes, [contact, name, kind, stage, tags, notes]);

  const save = async () => {
    setError(null);
    setSaved(false);
    const body = {
      name: name.trim() || null,
      kind,
      stage: kind === "lead" ? (stage || "new") as LeadStage : (stage || null) as LeadStage | null,
      tags,
      notes: notes.trim() || null,
    };
    try {
      const result = contact
        ? await update.mutateAsync({ id: contact.id, ...body })
        : await create.mutateAsync({ phone, ...body });
      setSaved(true);
      onDone?.(result);
    } catch (e) {
      setError((e as Error).message || copy.contact.error);
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <div className="space-y-4" data-testid="contact-editor">
      {!contact && (
        <div className="space-y-1.5">
          <Label htmlFor="contact-phone">{copy.contact.phone}</Label>
          <Input id="contact-phone" dir="ltr" inputMode="tel" placeholder="07X XXX XXXX" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-h-10" data-testid="input-contact-phone" />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contact-name">{copy.contact.name}</Label>
          <Input id="contact-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} className="min-h-10" data-testid="input-contact-name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-kind">{copy.contact.kind}</Label>
          <select id="contact-kind" value={kind} onChange={(e) => setKind(e.target.value as ContactKind)} className={selectClass} data-testid="select-contact-kind">
            {CONTACT_KINDS.map((k) => <option key={k} value={k}>{copy.contact.kinds[k]}</option>)}
          </select>
        </div>
      </div>
      {kind === "lead" && (
        <div className="space-y-1.5">
          <Label>{copy.contact.stage}</Label>
          <div className="flex flex-wrap gap-1.5">
            {LEAD_STAGES.map((s) => (
              <button key={s} type="button" onClick={() => setStage(s)} aria-pressed={(stage || "new") === s}
                className={cn("min-h-8 rounded-full border px-3 text-xs font-semibold", (stage || "new") === s ? "border-turf bg-turf/15 text-turf" : "border-line bg-raised text-muted-text")}>
                {copy.contact.stages[s]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <Label>{copy.contact.tags}</Label>
        <TagInput value={tags} onChange={setTags} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="contact-notes">{copy.contact.notes}</Label>
        <Textarea id="contact-notes" dir="auto" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="resize-y" />
      </div>

      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={busy || !dirty || (!contact && !phone.trim())} onClick={() => void save()} className="min-h-10 bg-floodlight font-bold text-void" data-testid="button-save-contact">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : copy.contact.save}
        </Button>
        {saved && !dirty && <span className="text-xs text-turf">{copy.contact.saved}</span>}
        {contact && isOwner && (
          <Button type="button" variant="ghost" className="ms-auto text-red-400" disabled={remove.isPending} onClick={() => {
            if (window.confirm(copy.contact.deleteConfirm)) remove.mutate(contact.id, { onSuccess: () => onDeleted?.() });
          }}><Trash2 className="me-1.5 h-4 w-4" aria-hidden="true" />{copy.contact.delete}</Button>
        )}
      </div>

      {contact && (
        <div className="space-y-3 border-t border-line pt-4">
          <Label>{copy.contact.players}</Label>
          {contact.players.length === 0 ? <p className="text-sm text-muted-text">{copy.contact.noPlayers}</p> : (
            <ul className="space-y-1.5">
              {contact.players.map((p) => (
                <li key={p.playerId} className="flex items-center gap-3 rounded-lg bg-raised px-3 py-2 text-sm">
                  <UserRound className="h-4 w-4 shrink-0 text-turf" aria-hidden="true" />
                  <span className="min-w-0 flex-1" dir="auto">
                    <span className="font-semibold text-text">{p.playerName}</span>
                    {p.squadName && <span className="text-muted-text"> · {p.squadName}</span>}
                    <span className="block text-xs text-muted-text">{copy.contact.relationships[p.relationship]}</span>
                  </span>
                  <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-muted-text" disabled={unlink.isPending}
                    onClick={() => unlink.mutate({ contactId: contact.id, playerId: p.playerId })} aria-label={copy.contact.unlink}>
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="rounded-xl border border-dashed border-line p-3">
            <p className="mb-2 text-xs font-semibold text-muted-text">{copy.contact.linkPlayer}</p>
            <LinkPlayerForm academyId={academyId} contactId={contact.id} />
          </div>
        </div>
      )}
    </div>
  );
}

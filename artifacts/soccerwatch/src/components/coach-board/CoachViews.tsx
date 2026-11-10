import { useMemo } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import { useCoachCopy } from "@/i18n/coach-strings";
import {
  coachTracksLoader,
  familyTracksLoader,
  useCoachMatch,
  useDeleteCoachNote,
  useFamilyCoachNote,
  useFamilyCoachNotes,
  useSaveCoachNote,
  type CoachSession,
} from "@/lib/academy-coach-api";
import { CoachPlayer } from "./CoachPlayer";

function matchTitle(s: CoachSession, locale: "ar" | "en"): { title: string; subtitle: string } {
  const vs = locale === "ar" ? "ضد" : "vs";
  const kind = s.type === "match" ? (locale === "ar" ? "مباراة" : "Match") : locale === "ar" ? "تدريب" : "Training";
  const score = s.ownScore !== null && s.ownScore !== undefined && s.opponentScore !== null && s.opponentScore !== undefined ? ` · ${s.ownScore}–${s.opponentScore}` : "";
  const date = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" }).format(new Date(s.startsAt));
  return {
    title: `${kind}${s.opponent ? ` ${vs} ${s.opponent}` : ""}${score}`,
    subtitle: [s.squadName, date].filter(Boolean).join(" · "),
  };
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[80] grid place-items-center bg-void p-6 text-center text-sm text-muted-text">{children}</div>;
}

/** Academy console → Matches → Coach view (owner, managers and coaches). */
export function CoachMatchView({ academyId, sessionId, onClose }: { academyId: number; sessionId: number; onClose: () => void }) {
  const copy = useCoachCopy();
  const match = useCoachMatch(academyId, sessionId);
  const save = useSaveCoachNote(academyId, sessionId);
  const remove = useDeleteCoachNote(academyId, sessionId);
  const loadTracks = useMemo(() => coachTracksLoader(academyId, sessionId), [academyId, sessionId]);

  if (match.isLoading) return <Shell><Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" aria-hidden />{copy.loading}</Shell>;
  if (match.isError || !match.data) {
    return <Shell><p role="alert">{copy.notFound}</p><button type="button" className="mt-3 rounded-xl bg-raised px-4 py-2 font-semibold text-text" onClick={onClose}>{copy.close}</button></Shell>;
  }
  const data = match.data;
  if (!data.video) {
    return <Shell><p>{copy.noVideo}</p><button type="button" className="mt-3 rounded-xl bg-raised px-4 py-2 font-semibold text-text" onClick={onClose}>{copy.close}</button></Shell>;
  }
  const { title, subtitle } = matchTitle(data.session, copy.locale);
  return (
    <CoachPlayer
      title={title}
      subtitle={subtitle}
      video={data.video}
      players={data.players}
      analysed={data.analysed}
      loadTracks={loadTracks}
      onClose={onClose}
      notes={data.notes}
      lineup={data.lineup}
      onSaveNote={(input, id) => save.mutateAsync({ id, input })}
      onDeleteNote={async (id) => { await remove.mutateAsync(id); }}
      canEdit={(n) => n.mine || data.role === "owner"}
    />
  );
}

/** The button that opens it, for a match card. */
export function CoachViewButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const copy = useCoachCopy();
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={copy.openHint}
      className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-floodlight px-4 text-sm font-bold text-void disabled:opacity-50" data-testid="button-coach-view">
      <Clapperboard className="h-4 w-4" aria-hidden />{copy.open}
    </button>
  );
}

/** A family's view of one shared note: the moment, the coach's drawings and comment, only the tagged players spotlighted. */
export function FamilyCoachNoteView({ noteId, onClose }: { noteId: number; onClose: () => void }) {
  const copy = useCoachCopy();
  const detail = useFamilyCoachNote(noteId);
  const loadTracks = useMemo(() => familyTracksLoader(noteId), [noteId]);
  if (detail.isLoading) return <Shell><Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" aria-hidden />{copy.loading}</Shell>;
  if (detail.isError || !detail.data?.video) {
    return <Shell><p role="alert">{copy.notFound}</p><button type="button" className="mt-3 rounded-xl bg-raised px-4 py-2 font-semibold text-text" onClick={onClose}>{copy.close}</button></Shell>;
  }
  const d = detail.data;
  const { title, subtitle } = matchTitle(d.session, copy.locale);
  return (
    <CoachPlayer
      title={d.note.title || title}
      subtitle={d.note.title ? `${title} · ${subtitle}` : subtitle}
      video={d.video!}
      players={d.players}
      analysed={d.note.board.spotlights.length > 0}
      loadTracks={loadTracks}
      onClose={onClose}
      readOnly
      initialNote={d.note}
    />
  );
}

/** Family page card: shared moments from the coach about the viewer's children. */
export function FamilyCoachNotesCard({ onOpen }: { onOpen: (noteId: number) => void }) {
  const copy = useCoachCopy();
  const notes = useFamilyCoachNotes();
  if (!notes.data?.length) return null;
  const fmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" });
  return (
    <section className="rounded-2xl border border-floodlight/30 bg-floodlight/5 p-5" data-testid="family-coach-notes">
      <h2 className="font-display text-xl font-bold text-text">{copy.family.title}</h2>
      <ul className="mt-3 space-y-2">
        {notes.data.slice(0, 20).map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onOpen(n.id)} className="flex w-full items-center gap-3 rounded-xl bg-surface p-3 text-start hover:bg-raised" data-testid={`family-coach-note-${n.id}`}>
              <Clapperboard className="h-5 w-5 shrink-0 text-floodlight" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-text" dir="auto">{n.title || copy.family.about(n.players.map((p) => p.name.split(/\s+/)[0]).join(copy.locale === "ar" ? " و" : " & "))}</span>
                <span className="block truncate text-xs text-muted-text" dir="auto">
                  {fmt.format(new Date(n.session.startsAt))}{n.session.opponent ? ` · ${n.session.opponent}` : ""}{n.body ? ` · ${n.body}` : ""}
                </span>
              </span>
              <span className="shrink-0 rounded-lg bg-floodlight px-3 py-1.5 text-xs font-bold text-void">{copy.family.watch}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

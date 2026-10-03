import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListAcademyConsoleAnnouncementsQueryKey,
  getListAcademyConsoleSquadsQueryKey,
  useCreateAcademyConsoleAnnouncement,
  useDeleteAcademyConsoleAnnouncement,
  useListAcademyConsoleAnnouncements,
  useListAcademyConsoleSquads,
  useUpdateAcademyConsoleAnnouncement,
  type AcademyAnnouncementSummary,
} from "@workspace/api-client-react";
import { Megaphone, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type AnnouncementForm = { title: string; body: string; squadId: string };
const emptyForm: AnnouncementForm = { title: "", body: "", squadId: "" };

export function AcademyAnnouncementsSection({ academyId }: { academyId: number }) {
  const { t, locale } = useTranslation();
  const copy = t.academyConsole.announcementsPanel;
  const qc = useQueryClient();
  const announcementsQuery = useListAcademyConsoleAnnouncements(academyId, { query: { queryKey: getListAcademyConsoleAnnouncementsQueryKey(academyId), staleTime: 20_000 } });
  const squadsQuery = useListAcademyConsoleSquads(academyId, { query: { queryKey: getListAcademyConsoleSquadsQueryKey(academyId), staleTime: 20_000 } });
  const createAnnouncement = useCreateAcademyConsoleAnnouncement();
  const updateAnnouncement = useUpdateAcademyConsoleAnnouncement();
  const deleteAnnouncement = useDeleteAcademyConsoleAnnouncement();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AcademyAnnouncementSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AcademyAnnouncementSummary | null>(null);
  const [form, setForm] = useState<AnnouncementForm>(emptyForm);
  const [saveError, setSaveError] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const announcements = useMemo(() => [...(announcementsQuery.data ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [announcementsQuery.data]);
  const dateFormat = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Amman" });
  const refresh = () => qc.invalidateQueries({ queryKey: getListAcademyConsoleAnnouncementsQueryKey(academyId) });
  const openCreate = () => { setEditing(null); setForm({ ...emptyForm }); setSaveError(false); setFormOpen(true); };
  const openEdit = (item: AcademyAnnouncementSummary) => { setEditing(item); setForm({ title: item.title, body: item.body, squadId: item.squadId === null ? "" : String(item.squadId) }); setSaveError(false); setFormOpen(true); };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = form.title.trim();
    const body = form.body.trim();
    if (!title || !body) { setSaveError(true); return; }
    setSaveError(false);
    const data = { title, body, squadId: form.squadId ? Number(form.squadId) : null };
    try {
      if (editing) await updateAnnouncement.mutateAsync({ academyId, announcementId: editing.id, data });
      else await createAnnouncement.mutateAsync({ academyId, data });
      await refresh();
      setFormOpen(false);
    } catch { setSaveError(true); }
  };
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(false);
    try {
      await deleteAnnouncement.mutateAsync({ academyId, announcementId: pendingDelete.id });
      await refresh();
      setPendingDelete(null);
    } catch { setDeleteError(true); }
  };
  const shareUrl = (item: AcademyAnnouncementSummary) => {
    const params = new URLSearchParams({ text: `${item.title}\n${item.body}` });
    return `https://wa.me/?${params.toString()}`;
  };
  const isSaving = createAnnouncement.isPending || updateAnnouncement.isPending;

  return (
    <section className="space-y-6" data-testid="academy-announcements">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{t.academyConsole.workspace}</p><h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{t.academyConsole.announcements}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p></div>
        <Button type="button" onClick={openCreate} className="min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void hover:bg-floodlight/90" data-testid="button-create-announcement"><Plus className="me-2 h-4 w-4" aria-hidden="true" />{copy.create}</Button>
      </header>
      {announcementsQuery.isLoading || squadsQuery.isLoading ? <div className="space-y-3" data-testid="academy-announcements-loading">{[0, 1].map((n) => <div key={n} className="h-32 animate-pulse rounded-2xl border border-line bg-surface" />)}</div> :
        announcementsQuery.isError || squadsQuery.isError ? <div className="rounded-2xl border border-line bg-surface p-5" data-testid="academy-announcements-error"><p className="text-sm text-muted-text" role="alert">{copy.loadError}</p><Button type="button" variant="outline" className="mt-3 min-h-10" onClick={() => void Promise.all([announcementsQuery.refetch(), squadsQuery.refetch()])} data-testid="button-retry-announcements">{t.academyConsole.retry}</Button></div> :
        announcements.length === 0 ? <div className="rounded-2xl border border-dashed border-line bg-surface p-9 text-center" data-testid="academy-announcements-empty"><span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-turf/10 text-turf"><Megaphone className="h-5 w-5" aria-hidden="true" /></span><h2 className="mt-4 font-display text-xl font-bold text-text">{copy.emptyTitle}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-text">{copy.emptyDescription}</p><Button type="button" onClick={openCreate} className="mt-5 min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void" data-testid="button-create-first-announcement"><Plus className="me-2 h-4 w-4" aria-hidden="true" />{copy.create}</Button></div> :
        <div className="space-y-3" data-testid="academy-announcements-list">{announcements.map((item) => <article key={item.id} className="rounded-2xl border border-line bg-surface p-5 sm:p-6" data-testid={`academy-announcement-${item.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 dir="auto" className="break-words font-display text-xl font-bold text-text">{item.title}</h2><span className="rounded-full bg-turf/10 px-2.5 py-1 text-[11px] font-bold text-turf" data-testid={`announcement-scope-${item.id}`}>{item.squadName ?? copy.academyWide}</span></div><p dir="auto" className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted-text">{item.body}</p></div>
            <div className="flex shrink-0 items-center gap-1">
              <a href={shareUrl(item)} target="_blank" rel="noopener noreferrer" aria-label={`${copy.share}: ${item.title}`} className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-muted-text hover:bg-raised hover:text-text" data-testid={`link-share-announcement-${item.id}`}><Share2 className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">{copy.share}</span></a>
              <Button type="button" variant="ghost" size="icon" onClick={() => openEdit(item)} aria-label={`${copy.edit}: ${item.title}`} data-testid={`button-edit-announcement-${item.id}`}><Pencil className="h-4 w-4" aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon" onClick={() => { setDeleteError(false); setPendingDelete(item); }} aria-label={`${copy.delete}: ${item.title}`} className="text-muted-text hover:text-destructive" data-testid={`button-delete-announcement-${item.id}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-xs text-muted-text"><span className="font-semibold text-text">{item.authorName}</span><span aria-hidden="true">·</span><time dateTime={item.createdAt} data-testid={`announcement-created-${item.id}`}>{dateFormat.format(new Date(item.createdAt))}</time></div>
        </article>)}</div>}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-xl"><DialogHeader className="text-start"><DialogTitle>{editing ? copy.edit : copy.create}</DialogTitle><DialogDescription className="text-start text-muted-text">{copy.formDescription}</DialogDescription></DialogHeader>
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            <div className="space-y-2"><Label htmlFor="announcement-title">{copy.title}</Label><Input id="announcement-title" required maxLength={200} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} className="min-h-11 text-start" data-testid="input-announcement-title" /></div>
            <div className="space-y-2"><Label htmlFor="announcement-squad">{copy.audience}</Label><select id="announcement-squad" value={form.squadId} onChange={(e) => setForm((f) => ({ ...f, squadId: e.target.value }))} className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text" data-testid="select-announcement-squad"><option value="">{copy.academyWide}</option>{(squadsQuery.data ?? []).map((squad) => <option key={squad.id} value={String(squad.id)}>{squad.name}</option>)}</select></div>
            <div className="space-y-2"><Label htmlFor="announcement-body">{copy.message}</Label><Textarea id="announcement-body" required maxLength={10000} rows={6} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} className="resize-y text-start" data-testid="input-announcement-body" /></div>
            {saveError && <p className="text-sm text-destructive" role="alert" data-testid="announcement-save-error">{copy.saveError}</p>}
            <DialogFooter className="gap-2"><Button type="button" variant="outline" disabled={isSaving} onClick={() => setFormOpen(false)} className="min-h-11">{t.academyConsole.cancel}</Button><Button type="submit" disabled={isSaving} className="min-h-11 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="button-save-announcement">{isSaving ? copy.saving : copy.save}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !deleteAnnouncement.isPending) { setPendingDelete(null); setDeleteError(false); } }}>
        <AlertDialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text"><AlertDialogHeader className="text-start"><AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle><AlertDialogDescription className="text-start text-muted-text">{copy.deleteDescription}</AlertDialogDescription></AlertDialogHeader>{deleteError && <p className="text-sm text-destructive" role="alert" data-testid="announcement-delete-error">{copy.deleteError}</p>}<AlertDialogFooter className="gap-2"><AlertDialogCancel disabled={deleteAnnouncement.isPending} className="min-h-11">{t.academyConsole.cancel}</AlertDialogCancel><Button type="button" disabled={deleteAnnouncement.isPending} onClick={() => void confirmDelete()} className="min-h-11 bg-destructive font-bold text-destructive-foreground" data-testid="button-confirm-delete-announcement">{deleteAnnouncement.isPending ? copy.deleting : copy.delete}</Button></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
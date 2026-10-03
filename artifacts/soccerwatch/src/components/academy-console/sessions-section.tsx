import { useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAcademyConsoleDashboardQueryKey,
  getListAcademyConsoleSessionsQueryKey,
  getListAcademyConsoleSquadsQueryKey,
  useCreateAcademyConsoleSession,
  useDeleteAcademyConsoleSession,
  useListAcademyConsoleSessions,
  useListAcademyConsoleSquads,
  useUpdateAcademyConsoleSession,
  type AcademySessionInput,
  type AcademySessionSummary,
  type AcademySessionUpdate,
} from "@workspace/api-client-react";
import { CalendarDays, Clock3, MapPin, Pencil, Plus, ShieldAlert, Swords, Trash2 } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  ammanInputToUtcIso,
  formatAmmanDateTime,
  utcIsoToAmmanInput,
} from "@/lib/academy-session-time";

type SessionType = "training" | "match";
type SessionForm = {
  type: SessionType;
  startsAt: string;
  endsAt: string;
  squadId: string;
  location: string;
  opponent: string;
  ownScore: string;
  opponentScore: string;
  notes: string;
};
type FormField = keyof SessionForm;

const blankForm: SessionForm = {
  type: "training",
  startsAt: "",
  endsAt: "",
  squadId: "",
  location: "",
  opponent: "",
  ownScore: "",
  opponentScore: "",
  notes: "",
};

function sessionFormFor(session?: AcademySessionSummary): SessionForm {
  if (!session) return { ...blankForm };
  return {
    type: session.type,
    startsAt: utcIsoToAmmanInput(session.startsAt),
    endsAt: utcIsoToAmmanInput(session.endsAt),
    squadId: session.squadId === null ? "" : String(session.squadId),
    location: session.location,
    opponent: session.opponent ?? "",
    ownScore: session.ownScore === null ? "" : String(session.ownScore),
    opponentScore: session.opponentScore === null ? "" : String(session.opponentScore),
    notes: session.notes ?? "",
  };
}

export function AcademySessionsSection({ academyId }: { academyId: number }) {
  const [, setLocation] = useLocation();
  const { t, locale } = useTranslation();
  const labels = t.academyConsole;
  const copy = labels.schedule;
  const queryClient = useQueryClient();
  const sessionsQuery = useListAcademyConsoleSessions(academyId, {
    query: { queryKey: getListAcademyConsoleSessionsQueryKey(academyId), staleTime: 20_000 },
  });
  const squadsQuery = useListAcademyConsoleSquads(academyId, {
    query: { queryKey: getListAcademyConsoleSquadsQueryKey(academyId), staleTime: 20_000 },
  });
  const createSession = useCreateAcademyConsoleSession();
  const updateSession = useUpdateAcademyConsoleSession();
  const deleteSession = useDeleteAcademyConsoleSession();
  const [typeFilter, setTypeFilter] = useState<"all" | SessionType>("all");
  const [squadFilter, setSquadFilter] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<AcademySessionSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AcademySessionSummary | null>(null);
  const [form, setForm] = useState<SessionForm>({ ...blankForm });
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const [mutationError, setMutationError] = useState(false);
  const sessions = sessionsQuery.data ?? [];
  const squads = squadsQuery.data ?? [];
  const isSaving = createSession.isPending || updateSession.isPending;
  const now = Date.now();
  const filteredSessions = useMemo(() => sessions.filter((session) => (
    (typeFilter === "all" || session.type === typeFilter)
    && (squadFilter === "all" || (squadFilter === "unassigned" ? session.squadId === null : String(session.squadId) === squadFilter))
  )), [sessions, squadFilter, typeFilter]);
  const upcoming = useMemo(
    () => filteredSessions.filter((session) => Date.parse(session.startsAt) >= now).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [filteredSessions, now],
  );
  const past = useMemo(
    () => filteredSessions.filter((session) => Date.parse(session.startsAt) < now).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)),
    [filteredSessions, now],
  );

  const refreshSessions = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListAcademyConsoleSessionsQueryKey(academyId) }),
      queryClient.invalidateQueries({ queryKey: getGetAcademyConsoleDashboardQueryKey(academyId) }),
    ]);
  };

  const openCreate = () => {
    setEditingSession(null);
    setForm({ ...blankForm });
    setFormError(null);
    setMutationError(false);
    setFormOpen(true);
  };
  const openEdit = (session: AcademySessionSummary) => {
    setEditingSession(session);
    setForm(sessionFormFor(session));
    setFormError(null);
    setMutationError(false);
    setFormOpen(true);
  };
  const closeForm = (open: boolean) => {
    if (isSaving) return;
    setFormOpen(open);
    if (!open) {
      setEditingSession(null);
      setFormError(null);
    }
  };
  const updateField = (field: FormField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
    setMutationError(false);
  };

  const saveSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const startsAt = ammanInputToUtcIso(form.startsAt);
    const endsAt = form.endsAt ? ammanInputToUtcIso(form.endsAt) : null;
    if (!startsAt) {
      setFormError(copy.badDate);
      return;
    }
    if (form.endsAt && !endsAt) {
      setFormError(copy.badDate);
      return;
    }
    if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      setFormError(copy.endBeforeStart);
      return;
    }
    if (!form.location.trim()) {
      setFormError(copy.required);
      return;
    }
    let ownScore: number | null = null;
    let opponentScore: number | null = null;
    if (editingSession && form.type === "match") {
      const hasOwn = form.ownScore.trim() !== "";
      const hasOpponent = form.opponentScore.trim() !== "";
      if (hasOwn !== hasOpponent) {
        setFormError(copy.pairedScores);
        return;
      }
      if (hasOwn && hasOpponent) {
        ownScore = Number(form.ownScore);
        opponentScore = Number(form.opponentScore);
        if (![ownScore, opponentScore].every((score) => Number.isSafeInteger(score) && score >= 0 && score <= 2_147_483_647)) {
          setFormError(copy.invalidScore);
          return;
        }
      }
    }

    const common = {
      type: form.type,
      startsAt,
      endsAt,
      squadId: form.squadId ? Number(form.squadId) : null,
      location: form.location.trim(),
      opponent: form.type === "match" ? form.opponent.trim() || null : null,
      notes: form.notes.trim() || null,
    };
    setFormError(null);
    setMutationError(false);
    try {
      if (editingSession) {
        const data: AcademySessionUpdate = {
          ...common,
          ...(form.type === "match"
            ? { ownScore, opponentScore }
            : { ownScore: null, opponentScore: null }),
        };
        await updateSession.mutateAsync({
          academyId,
          sessionId: editingSession.id,
          data,
        });
      } else {
        const data: AcademySessionInput = common;
        await createSession.mutateAsync({ academyId, data });
      }
      await refreshSessions();
      setFormOpen(false);
      setEditingSession(null);
    } catch {
      setMutationError(true);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(false);
    try {
      await deleteSession.mutateAsync({ academyId, sessionId: pendingDelete.id });
      await refreshSessions();
      setPendingDelete(null);
    } catch {
      setDeleteError(true);
    }
  };

  const kindLabel = (type: SessionType) => type === "training" ? copy.training : copy.match;
  const renderSession = (session: AcademySessionSummary) => {
    const formatted = formatAmmanDateTime(session.startsAt, locale);
    const end = session.endsAt ? formatAmmanDateTime(session.endsAt, locale) : null;
    const endLabel = end
      ? `${copy.end} ${end.dateKey !== formatted.dateKey ? `${end.date} ` : ""}${end.time}`
      : "";
    const Icon = session.type === "match" ? Swords : CalendarDays;
    const scoreExists = session.ownScore !== null && session.opponentScore !== null;
    return (
      <article
        key={session.id}
        className="group rounded-2xl border border-line bg-surface transition-colors hover:border-turf/35"
        data-testid={`academy-session-${session.id}`}
      >
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-5 sm:px-5">
          <div className="flex items-center gap-3 sm:w-[11.5rem] sm:shrink-0">
            <div className={cn(
              "grid h-12 w-12 shrink-0 place-items-center rounded-xl",
              session.type === "match" ? "bg-violet/10 text-violet" : "bg-turf/10 text-turf",
            )}>
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-text" data-testid={`text-session-date-${session.id}`}>{formatted.date}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs tabular-nums text-muted-text" data-testid={`text-session-time-${session.id}`}>
                <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                 <span dir="auto">{formatted.time}{endLabel ? ` ${endLabel}` : ""}</span>
              </p>
            </div>
          </div>
          <div className="min-w-0 flex-1 border-t border-line pt-3 sm:border-s sm:border-t-0 sm:ps-5 sm:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-bold",
                session.type === "match" ? "bg-violet/10 text-violet" : "bg-turf/10 text-turf",
              )}>{kindLabel(session.type)}</span>
              <span dir="auto" className="rounded-full bg-raised px-2.5 py-1 text-[11px] font-semibold text-muted-text">
                {session.squadName || copy.unassigned}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span dir="auto" className="inline-flex items-center gap-1.5 font-semibold text-text" data-testid={`text-session-location-${session.id}`}>
                <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-text" aria-hidden="true" />{session.location}
              </span>
              {session.type === "match" && session.opponent && (
                <span dir="auto" className="text-muted-text">{session.opponent}</span>
              )}
              {scoreExists && (
                <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1 font-display text-base font-bold tabular-nums text-text" data-testid={`text-session-result-${session.id}`}>
                  <span>{session.ownScore}</span><span className="text-muted-text">–</span><span>{session.opponentScore}</span>
                </span>
              )}
            </div>
            {Object.values(session.attendanceCounts ?? {}).some((count) => count > 0) && (
              <button
                type="button"
                onClick={() => setLocation(`/academy/attendance?sessionId=${session.id}`)}
                className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 text-xs font-semibold text-turf underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf"
                data-testid={`link-session-attendance-${session.id}`}
              >
                {copy.viewAttendance}
              </button>
            )}
          </div>
          <div className="flex items-center justify-end gap-1 border-t border-line pt-2 sm:border-0 sm:pt-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${copy.edit}: ${kindLabel(session.type)}`}
              onClick={() => openEdit(session)}
              className="text-muted-text hover:text-turf"
              data-testid={`button-edit-session-${session.id}`}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${copy.delete}: ${kindLabel(session.type)}`}
              onClick={() => {
                setDeleteError(false);
                setPendingDelete(session);
              }}
              className="text-muted-text hover:text-destructive"
              data-testid={`button-delete-session-${session.id}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </article>
    );
  };

  const renderGroup = (title: string, items: AcademySessionSummary[], emptyText: string, testId: string) => (
    <section className="space-y-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-text">{title}</h2>
        <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-bold tabular-nums text-muted-text" data-testid={`${testId}-count`}>
          {items.length}
        </span>
      </div>
      {items.length > 0 ? <div className="space-y-2.5">{items.map(renderSession)}</div> : (
        <div className="rounded-2xl border border-dashed border-line bg-surface/70 px-5 py-6 text-sm text-muted-text" data-testid={`${testId}-empty`}>
          {emptyText}
        </div>
      )}
    </section>
  );

  return (
    <section className="space-y-6" data-testid="academy-sessions">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{labels.workspace}</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{labels.scheduleResults}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
        </div>
        <Button
          type="button"
          onClick={openCreate}
          className="min-h-11 shrink-0 rounded-xl bg-floodlight px-4 font-bold text-void hover:bg-floodlight/90"
          data-testid="button-create-session"
        >
          <Plus className="me-2 h-4 w-4" aria-hidden="true" />{copy.add}
        </Button>
      </header>

      <div className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="session-type-filter" className="text-xs text-muted-text">{copy.type}</Label>
          <select
            id="session-type-filter"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as "all" | SessionType)}
            className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text outline-none focus:border-turf"
            data-testid="select-session-type-filter"
          >
            <option value="all">{copy.allTypes}</option>
            <option value="training">{copy.training}</option>
            <option value="match">{copy.match}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-squad-filter" className="text-xs text-muted-text">{copy.squad}</Label>
          <select
            id="session-squad-filter"
            value={squadFilter}
            onChange={(event) => setSquadFilter(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text outline-none focus:border-turf"
            data-testid="select-session-squad-filter"
          >
            <option value="all">{labels.allSquads}</option>
            <option value="unassigned">{copy.unassigned}</option>
            {squads.map((squad) => <option key={squad.id} value={String(squad.id)}>{squad.name}</option>)}
          </select>
        </div>
        <p className="hidden pb-3 text-xs text-muted-text sm:block">{copy.filterHint}</p>
      </div>
      {squadsQuery.isError && <p className="rounded-xl border border-line bg-surface p-3 text-sm text-muted-text" role="alert" data-testid="session-squads-error">{labels.squadsLoadError}</p>}
      {mutationError && <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert" data-testid="session-mutation-error">{copy.saveError}</p>}

      {sessionsQuery.isLoading ? (
        <div className="space-y-3" data-testid="academy-sessions-loading" aria-label={copy.loading}>
          {[0, 1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-2xl border border-line bg-surface" />)}
        </div>
      ) : sessionsQuery.isError ? (
        <div className="rounded-2xl border border-line bg-surface p-6" data-testid="academy-sessions-error">
          <p className="text-sm text-muted-text" role="alert">{copy.loadError}</p>
          <Button type="button" variant="outline" className="mt-4 min-h-10" onClick={() => void sessionsQuery.refetch()} data-testid="button-retry-sessions">{copy.retry}</Button>
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center" data-testid="academy-sessions-empty">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-turf/10 text-turf"><CalendarDays className="h-5 w-5" aria-hidden="true" /></span>
          <h2 className="mt-4 font-display text-xl font-bold text-text">{copy.noSessions}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-text">{copy.noSessionsHint}</p>
          <Button type="button" onClick={openCreate} className="mt-5 min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void" data-testid="button-create-first-session">
            <Plus className="me-2 h-4 w-4" aria-hidden="true" />{copy.add}
          </Button>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-7 text-center text-sm text-muted-text" data-testid="academy-sessions-no-matches">
          {copy.noFiltered}
        </div>
      ) : (
        <div className="space-y-8">
          {renderGroup(copy.upcoming, upcoming, copy.upcomingEmpty, "academy-sessions-upcoming")}
          {renderGroup(copy.past, past, copy.pastEmpty, "academy-sessions-past")}
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={closeForm}>
        <DialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-xl">
          <DialogHeader className="text-start">
            <DialogTitle>{editingSession ? copy.editTitle : copy.createTitle}</DialogTitle>
            <DialogDescription className="text-start text-muted-text">{copy.formHint} · {copy.ammanTime}</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveSession} noValidate className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="session-type">{copy.type}</Label>
                <select id="session-type" value={form.type} onChange={(event) => updateField("type", event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text" data-testid="select-session-type">
                  <option value="training">{copy.training}</option>
                  <option value="match">{copy.match}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="session-squad">{copy.squad}</Label>
                <select id="session-squad" value={form.squadId} onChange={(event) => updateField("squadId", event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text" data-testid="select-session-squad">
                  <option value="">{copy.unassigned}</option>
                  {squads.map((squad) => <option key={squad.id} value={String(squad.id)}>{squad.name}</option>)}
                </select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="session-start">{copy.date}</Label>
                <Input id="session-start" type="datetime-local" required value={form.startsAt} onChange={(event) => updateField("startsAt", event.target.value)} className="min-h-11 text-start" data-testid="input-session-start" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="session-end">{copy.endTime}</Label>
                <Input id="session-end" type="datetime-local" value={form.endsAt} onChange={(event) => updateField("endsAt", event.target.value)} className="min-h-11 text-start" data-testid="input-session-end" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="session-location">{copy.location}</Label>
              <Input id="session-location" required maxLength={200} value={form.location} onChange={(event) => updateField("location", event.target.value)} className="min-h-11 text-start" data-testid="input-session-location" />
            </div>
            {form.type === "match" && (
              <div className="space-y-2">
                <Label htmlFor="session-opponent">{copy.opponent}</Label>
                 <Input id="session-opponent" maxLength={160} value={form.opponent} onChange={(event) => updateField("opponent", event.target.value)} className="min-h-11 text-start" data-testid="input-session-opponent" />
              </div>
            )}
            {editingSession && form.type === "match" && (
              <fieldset className="space-y-3 rounded-xl border border-line bg-raised p-4" data-testid="session-score-fields">
                <legend className="px-1 text-sm font-semibold text-text">{copy.result}</legend>
                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="session-own-score" className="text-xs text-muted-text">{copy.ownScore}</Label>
                    <Input id="session-own-score" type="number" min={0} max={2_147_483_647} step={1} inputMode="numeric" value={form.ownScore} onChange={(event) => updateField("ownScore", event.target.value)} className="min-h-11 text-center font-display text-lg font-bold tabular-nums" data-testid="input-session-own-score" />
                  </div>
                  <span className="pb-3 font-display text-lg font-bold text-muted-text">–</span>
                  <div className="space-y-2">
                    <Label htmlFor="session-opponent-score" className="text-xs text-muted-text">{copy.opponentScore}</Label>
                    <Input id="session-opponent-score" type="number" min={0} max={2_147_483_647} step={1} inputMode="numeric" value={form.opponentScore} onChange={(event) => updateField("opponentScore", event.target.value)} className="min-h-11 text-center font-display text-lg font-bold tabular-nums" data-testid="input-session-opponent-score" />
                  </div>
                </div>
              </fieldset>
            )}
            <div className="space-y-2">
              <Label htmlFor="session-notes">{copy.notes}</Label>
              <Textarea id="session-notes" maxLength={2000} rows={3} value={form.notes} onChange={(event) => updateField("notes", event.target.value)} className="resize-y text-start" data-testid="input-session-notes" />
            </div>
            {formError && <p className="text-sm text-destructive" role="alert" data-testid="session-form-error">{formError}</p>}
            {mutationError && <p className="text-sm text-destructive" role="alert" data-testid="session-save-error">{copy.saveError}</p>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={isSaving} onClick={() => closeForm(false)} className="min-h-11" data-testid="button-cancel-session">{copy.cancel}</Button>
              <Button type="submit" disabled={isSaving} className="min-h-11 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="button-save-session">{isSaving ? copy.saving : copy.save}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleteSession.isPending) {
            setPendingDelete(null);
            setDeleteError(false);
          }
        }}
      >
        <AlertDialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-muted-text">{copy.deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-muted-text">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <span>{copy.attendanceWarning}</span>
          </div>
          {deleteError && <p className="text-sm text-destructive" role="alert" data-testid="session-delete-error">{copy.deleteError}</p>}
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={deleteSession.isPending} className="min-h-11" data-testid="button-cancel-delete-session">{copy.cancel}</AlertDialogCancel>
            <Button type="button" disabled={deleteSession.isPending} onClick={() => void confirmDelete()} className="min-h-11 bg-destructive font-bold text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete-session">
              {deleteSession.isPending ? copy.deleting : copy.delete}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
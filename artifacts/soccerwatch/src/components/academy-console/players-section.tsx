import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAcademyConsoleDashboardQueryKey,
  getListAcademyConsolePlayersQueryKey,
  getListAcademyConsoleSquadsQueryKey,
  useCreateAcademyConsolePlayer,
  useListAcademyConsolePlayers,
  useListAcademyConsoleSquads,
  useUpdateAcademyConsolePlayer,
  type AcademyPlayerInput,
  type AcademyPlayerSummary,
  type AcademyPlayerUpdate,
} from "@workspace/api-client-react";
import { Link2, Pencil, Plus, Search, ShieldCheck, UserRound, Users } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type PlayerForm = {
  name: string;
  jerseyNumber: string;
  position: string;
  dateOfBirth: string;
  guardianPhone: string;
  squadId: string;
  linkedUserEmail: string;
};

type PlayerFormField = keyof PlayerForm;
type PlayerStatusFilter = "all" | "active" | "inactive";

const emptyForm: PlayerForm = {
  name: "",
  jerseyNumber: "",
  position: "",
  dateOfBirth: "",
  guardianPhone: "",
  squadId: "",
  linkedUserEmail: "",
};

function hasHttpStatus(error: unknown, status: number): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && (error as { status?: unknown }).status === status;
}

function formForPlayer(player: AcademyPlayerSummary): PlayerForm {
  return {
    name: player.name,
    jerseyNumber: player.jerseyNumber === null ? "" : String(player.jerseyNumber),
    position: player.position ?? "",
    dateOfBirth: player.dateOfBirth ?? "",
    guardianPhone: player.guardianPhone ?? "",
    squadId: player.squadId === null ? "" : String(player.squadId),
    linkedUserEmail: player.linkedUserEmail ?? "",
  };
}

export function AcademyPlayersSection({ academyId }: { academyId: number }) {
  const { t, locale } = useTranslation();
  const labels = t.academyConsole;
  const queryClient = useQueryClient();
  const playersQuery = useListAcademyConsolePlayers(academyId, {
    query: {
      queryKey: getListAcademyConsolePlayersQueryKey(academyId),
      staleTime: 20_000,
    },
  });
  const squadsQuery = useListAcademyConsoleSquads(academyId, {
    query: {
      queryKey: getListAcademyConsoleSquadsQueryKey(academyId),
      staleTime: 20_000,
    },
  });
  const createPlayer = useCreateAcademyConsolePlayer();
  const updatePlayer = useUpdateAcademyConsolePlayer();
  const [formOpen, setFormOpen] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<AcademyPlayerSummary | null>(null);
  const [form, setForm] = useState<PlayerForm>(emptyForm);
  const [formErrors, setFormErrors] = useState<Partial<Record<PlayerFormField, string>>>({});
  const [saveError, setSaveError] = useState<"generic" | "linked-account" | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [search, setSearch] = useState("");
  const [squadFilter, setSquadFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<PlayerStatusFilter>("all");

  const players = playersQuery.data ?? [];
  const squads = squadsQuery.data ?? [];
  const isSaving = createPlayer.isPending || updatePlayer.isPending;
  const numberFormat = new Intl.NumberFormat(locale);

  const visiblePlayers = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase(locale);
    return players.filter((player) => {
      if (statusFilter === "active" && !player.isActive) return false;
      if (statusFilter === "inactive" && player.isActive) return false;
      if (squadFilter === "unassigned" && player.squadId !== null) return false;
      if (squadFilter !== "all" && squadFilter !== "unassigned" && String(player.squadId) !== squadFilter) {
        return false;
      }
      if (normalizedSearch && !player.name.toLocaleLowerCase(locale).includes(normalizedSearch)) return false;
      return true;
    });
  }, [locale, players, search, squadFilter, statusFilter]);

  const refreshPlayerCounts = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListAcademyConsolePlayersQueryKey(academyId) }),
      queryClient.invalidateQueries({ queryKey: getListAcademyConsoleSquadsQueryKey(academyId) }),
      queryClient.invalidateQueries({ queryKey: getGetAcademyConsoleDashboardQueryKey(academyId) }),
    ]);
  };

  const openCreateForm = () => {
    setEditingPlayer(null);
    setForm({ ...emptyForm });
    setFormErrors({});
    setSaveError(null);
    setFormOpen(true);
  };

  const openEditForm = (player: AcademyPlayerSummary) => {
    setEditingPlayer(player);
    setForm(formForPlayer(player));
    setFormErrors({});
    setSaveError(null);
    setFormOpen(true);
  };

  const closeForm = (open: boolean) => {
    setFormOpen(open);
    if (!open) {
      setEditingPlayer(null);
      setFormErrors({});
      setSaveError(null);
    }
  };

  const updateField = (field: PlayerFormField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormErrors((current) => ({ ...current, [field]: undefined }));
    setSaveError(null);
  };

  const savePlayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Partial<Record<PlayerFormField, string>> = {};
    const name = form.name.trim();
    const jerseyNumber = form.jerseyNumber.trim() ? Number(form.jerseyNumber) : null;
    const email = form.linkedUserEmail.trim();

    if (!name) nextErrors.name = labels.playerNameRequired;
    else if (form.name.length > 120) nextErrors.name = labels.playerNameTooLong;
    if (jerseyNumber !== null && (!Number.isInteger(jerseyNumber) || jerseyNumber < 0)) {
      nextErrors.jerseyNumber = labels.jerseyNumberInvalid;
    }
    if (form.position.length > 80) nextErrors.position = labels.positionTooLong;
    if (form.guardianPhone.length > 80) nextErrors.guardianPhone = labels.guardianPhoneTooLong;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextErrors.linkedUserEmail = labels.linkedEmailInvalid;
    }

    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const sharedFields = {
      name,
      jerseyNumber,
      position: form.position.trim() || null,
      dateOfBirth: form.dateOfBirth || null,
      guardianPhone: form.guardianPhone.trim() || null,
      squadId: form.squadId ? Number(form.squadId) : null,
    };
    setSaveError(null);
    try {
      if (editingPlayer) {
        const data: AcademyPlayerUpdate = { ...sharedFields };
        const originalEmail = editingPlayer.linkedUserEmail?.trim().toLowerCase() ?? null;
        const requestedEmail = email ? email.toLowerCase() : null;
        if (originalEmail !== requestedEmail) data.linkedUserEmail = requestedEmail;
        await updatePlayer.mutateAsync({
          academyId,
          playerId: editingPlayer.id,
          data,
        });
      } else {
        const data: AcademyPlayerInput = sharedFields;
        await createPlayer.mutateAsync({ academyId, data });
      }
      await refreshPlayerCounts();
      setFormOpen(false);
      setEditingPlayer(null);
    } catch (error) {
      const originalEmail = editingPlayer?.linkedUserEmail?.trim().toLowerCase() ?? null;
      const requestedEmail = email ? email.toLowerCase() : null;
      setSaveError(
        editingPlayer && requestedEmail !== null && requestedEmail !== originalEmail && hasHttpStatus(error, 404)
          ? "linked-account"
          : "generic",
      );
    }
  };

  const togglePlayerStatus = async (player: AcademyPlayerSummary) => {
    setStatusError(false);
    try {
      await updatePlayer.mutateAsync({
        academyId,
        playerId: player.id,
        data: { isActive: !player.isActive },
      });
      await refreshPlayerCounts();
    } catch {
      setStatusError(true);
    }
  };

  const renderStatus = (player: AcademyPlayerSummary) => (
    <span className={cn(
      "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold",
      player.isActive ? "bg-turf/10 text-turf" : "bg-raised text-muted-text",
    )}>
      {player.isActive ? labels.active : labels.inactive}
    </span>
  );

  const renderActions = (player: AcademyPlayerSummary) => (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={updatePlayer.isPending}
        onClick={() => void togglePlayerStatus(player)}
        data-testid={`button-toggle-player-${player.id}`}
      >
        {player.isActive ? labels.deactivatePlayer : labels.activatePlayer}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => openEditForm(player)}
        aria-label={`${labels.editPlayer}: ${player.name}`}
        data-testid={`button-edit-player-${player.id}`}
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );

  return (
    <section className="space-y-6" data-testid="academy-players">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{labels.workspace}</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{labels.players}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{labels.playersDescription}</p>
        </div>
        <Button
          type="button"
          onClick={openCreateForm}
          className="min-h-11 shrink-0 rounded-xl bg-floodlight px-4 font-bold text-void hover:bg-floodlight/90"
          data-testid="button-create-player"
        >
          <Plus className="me-2 h-4 w-4" aria-hidden="true" />
          {labels.addPlayer}
        </Button>
      </div>

      {statusError && <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert" data-testid="player-status-error">{labels.playerStatusError}</p>}
      {squadsQuery.isError && <p className="rounded-xl border border-line bg-surface p-3 text-sm text-muted-text" role="alert">{labels.squadsLoadError}</p>}

      <div className="grid gap-3 rounded-2xl border border-line bg-surface p-4 md:grid-cols-[minmax(14rem,1fr)_minmax(10rem,0.55fr)_minmax(10rem,0.55fr)]">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={labels.searchPlayers}
            aria-label={labels.searchPlayers}
            className="min-h-11 ps-9 text-start"
            data-testid="input-search-players"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="academy-player-squad-filter" className="text-xs text-muted-text">{labels.filterBySquad}</Label>
          <select
            id="academy-player-squad-filter"
            value={squadFilter}
            onChange={(event) => setSquadFilter(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-input bg-surface px-3 text-start text-sm text-text"
            data-testid="select-player-squad-filter"
          >
            <option value="all">{labels.allSquads}</option>
            <option value="unassigned">{labels.unassigned}</option>
            {squads.map((squad) => <option key={squad.id} value={String(squad.id)}>{squad.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="academy-player-status-filter" className="text-xs text-muted-text">{labels.filterByStatus}</Label>
          <select
            id="academy-player-status-filter"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as PlayerStatusFilter)}
            className="min-h-11 w-full rounded-lg border border-input bg-surface px-3 text-start text-sm text-text"
            data-testid="select-player-status-filter"
          >
            <option value="all">{labels.allStatuses}</option>
            <option value="active">{labels.active}</option>
            <option value="inactive">{labels.inactive}</option>
          </select>
        </div>
      </div>

      {playersQuery.isLoading ? (
        <div className="space-y-3" data-testid="academy-players-loading" aria-label={labels.loading}>
          {[0, 1, 2].map((item) => <div key={item} className="h-20 animate-pulse rounded-2xl border border-line bg-surface" />)}
        </div>
      ) : playersQuery.isError ? (
        <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted-text" data-testid="academy-players-error">
          <p role="alert">{labels.playersLoadError}</p>
          <Button type="button" variant="outline" className="mt-4 min-h-10" onClick={() => void playersQuery.refetch()}>
            {labels.retry}
          </Button>
        </div>
      ) : players.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center" data-testid="academy-players-empty">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-turf/10 text-turf">
            <Users className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 font-display text-xl font-bold text-text">{labels.playersEmptyTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-text">{labels.playersEmptyDescription}</p>
          <Button type="button" onClick={openCreateForm} className="mt-5 min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void">
            <Plus className="me-2 h-4 w-4" aria-hidden="true" />
            {labels.addPlayer}
          </Button>
        </div>
      ) : visiblePlayers.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center text-sm text-muted-text" data-testid="academy-players-no-matches">
          {labels.noPlayersMatch}
        </div>
      ) : (
        <>
          <p className="text-xs font-semibold text-muted-text" data-testid="academy-player-result-count">
            {numberFormat.format(visiblePlayers.length)} / {numberFormat.format(players.length)} {labels.players.toLocaleLowerCase(locale)}
          </p>

          <div className="hidden overflow-hidden rounded-2xl border border-line bg-surface md:block" data-testid="academy-player-table">
            <Table className="min-w-[920px]">
              <TableHeader className="bg-raised">
                <TableRow className="border-line hover:bg-transparent">
                  <TableHead className="text-start text-muted-text">{labels.playerName}</TableHead>
                  <TableHead className="text-start text-muted-text">{labels.jerseyNumber}</TableHead>
                  <TableHead className="text-start text-muted-text">{labels.position}</TableHead>
                  <TableHead className="text-start text-muted-text">{labels.filterBySquad}</TableHead>
                  <TableHead className="text-start text-muted-text">{labels.filterByStatus}</TableHead>
                  <TableHead className="text-start text-muted-text">{labels.linkedReplayAccount}</TableHead>
                  <TableHead className="text-end text-muted-text">{labels.editPlayer}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visiblePlayers.map((player) => (
                  <TableRow key={player.id} className="border-line" data-testid={`academy-player-row-${player.id}`}>
                    <TableCell dir="auto" className="font-semibold text-text">{player.name}</TableCell>
                    <TableCell className="tabular-nums text-muted-text">{player.jerseyNumber ?? "—"}</TableCell>
                    <TableCell dir="auto" className="text-muted-text">{player.position || "—"}</TableCell>
                    <TableCell dir="auto" className="text-muted-text">{player.squadName || labels.unassigned}</TableCell>
                    <TableCell>{renderStatus(player)}</TableCell>
                    <TableCell>
                      {player.userId ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-turf" title={player.linkedUserEmail ?? undefined}>
                          <ShieldCheck className="h-4 w-4" aria-hidden="true" />{labels.linkedReplayAccount}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-text">
                          <Link2 className="h-4 w-4" aria-hidden="true" />{labels.notLinked}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end">{renderActions(player)}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-3 md:hidden" data-testid="academy-player-cards">
            {visiblePlayers.map((player) => (
              <article key={player.id} className="rounded-2xl border border-line bg-surface p-4" data-testid={`academy-player-card-${player.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-raised text-turf">
                      <UserRound className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h2 dir="auto" className="break-words font-display text-lg font-bold text-text">{player.name}</h2>
                      <p dir="auto" className="mt-1 text-sm text-muted-text">{player.position || "—"}</p>
                    </div>
                  </div>
                  {renderStatus(player)}
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-sm">
                  <div><dt className="text-xs text-muted-text">{labels.jerseyNumber}</dt><dd className="mt-1 font-semibold tabular-nums text-text">{player.jerseyNumber ?? "—"}</dd></div>
                  <div><dt className="text-xs text-muted-text">{labels.filterBySquad}</dt><dd dir="auto" className="mt-1 font-semibold text-text">{player.squadName || labels.unassigned}</dd></div>
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-text">{labels.linkedReplayAccount}</dt>
                    <dd className="mt-1 flex items-center gap-1.5 text-sm text-text">
                      {player.userId ? <><ShieldCheck className="h-4 w-4 text-turf" aria-hidden="true" />{player.linkedUserEmail}</> : <><Link2 className="h-4 w-4 text-muted-text" aria-hidden="true" />{labels.notLinked}</>}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-3">{renderActions(player)}</div>
              </article>
            ))}
          </div>
        </>
      )}

      <Dialog open={formOpen} onOpenChange={closeForm}>
        <DialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="max-h-[90dvh] overflow-y-auto border-line bg-surface text-text">
          <DialogHeader className="text-start">
            <DialogTitle>{editingPlayer ? labels.editPlayer : labels.addPlayer}</DialogTitle>
            <DialogDescription className="text-start text-muted-text">{labels.playerFormDescription}</DialogDescription>
          </DialogHeader>
          <form onSubmit={savePlayer} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="academy-player-name">{labels.playerName}</Label>
              <Input
                id="academy-player-name"
                autoFocus
                required
                maxLength={120}
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                aria-invalid={Boolean(formErrors.name)}
                aria-describedby={formErrors.name ? "academy-player-name-error" : undefined}
                className="min-h-11 text-start"
                data-testid="input-player-name"
              />
              {formErrors.name && <p id="academy-player-name-error" className="text-sm text-destructive" role="alert">{formErrors.name}</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="academy-player-jersey">{labels.jerseyNumber}</Label>
                <Input
                  id="academy-player-jersey"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={form.jerseyNumber}
                  onChange={(event) => updateField("jerseyNumber", event.target.value)}
                  aria-invalid={Boolean(formErrors.jerseyNumber)}
                  aria-describedby={formErrors.jerseyNumber ? "academy-player-jersey-error" : undefined}
                  className="min-h-11 text-start"
                  data-testid="input-player-jersey-number"
                />
                {formErrors.jerseyNumber && <p id="academy-player-jersey-error" className="text-sm text-destructive" role="alert">{formErrors.jerseyNumber}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="academy-player-position">{labels.position}</Label>
                <Input
                  id="academy-player-position"
                  maxLength={80}
                  value={form.position}
                  onChange={(event) => updateField("position", event.target.value)}
                  aria-invalid={Boolean(formErrors.position)}
                  aria-describedby={formErrors.position ? "academy-player-position-error" : undefined}
                  className="min-h-11 text-start"
                  data-testid="input-player-position"
                />
                {formErrors.position && <p id="academy-player-position-error" className="text-sm text-destructive" role="alert">{formErrors.position}</p>}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="academy-player-date-of-birth">{labels.dateOfBirth}</Label>
                <Input
                  id="academy-player-date-of-birth"
                  type="date"
                  value={form.dateOfBirth}
                  onChange={(event) => updateField("dateOfBirth", event.target.value)}
                  className="min-h-11 text-start"
                  data-testid="input-player-date-of-birth"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="academy-player-guardian-phone">{labels.guardianPhone}</Label>
                <Input
                  id="academy-player-guardian-phone"
                  type="tel"
                  maxLength={80}
                  value={form.guardianPhone}
                  onChange={(event) => updateField("guardianPhone", event.target.value)}
                  aria-invalid={Boolean(formErrors.guardianPhone)}
                  aria-describedby={formErrors.guardianPhone ? "academy-player-guardian-phone-error" : undefined}
                  className="min-h-11 text-start"
                  data-testid="input-player-guardian-phone"
                />
                {formErrors.guardianPhone && <p id="academy-player-guardian-phone-error" className="text-sm text-destructive" role="alert">{formErrors.guardianPhone}</p>}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="academy-player-squad">{labels.filterBySquad}</Label>
              <select
                id="academy-player-squad"
                value={form.squadId}
                onChange={(event) => updateField("squadId", event.target.value)}
                className="min-h-11 w-full rounded-lg border border-input bg-surface px-3 text-start text-sm text-text"
                data-testid="select-player-squad"
              >
                <option value="">{labels.unassigned}</option>
                {squads.map((squad) => <option key={squad.id} value={String(squad.id)}>{squad.name}</option>)}
              </select>
            </div>
            {editingPlayer && (
              <div className="space-y-2 rounded-xl border border-line bg-raised p-4">
                <Label htmlFor="academy-player-linked-email">{labels.linkAccount}</Label>
                <Input
                  id="academy-player-linked-email"
                  type="email"
                  value={form.linkedUserEmail}
                  onChange={(event) => updateField("linkedUserEmail", event.target.value)}
                  aria-invalid={Boolean(formErrors.linkedUserEmail)}
                  aria-describedby={formErrors.linkedUserEmail ? "academy-player-linked-email-error" : "academy-player-linked-email-hint"}
                  className="min-h-11 text-start"
                  autoComplete="email"
                  data-testid="input-player-linked-email"
                />
                <p id="academy-player-linked-email-hint" className="text-xs leading-5 text-muted-text">{labels.linkedAccountHint}</p>
                {formErrors.linkedUserEmail && <p id="academy-player-linked-email-error" className="text-sm text-destructive" role="alert">{formErrors.linkedUserEmail}</p>}
              </div>
            )}
            {saveError && (
              <p className="text-sm text-destructive" role="alert" data-testid="player-save-error">
                {saveError === "linked-account" ? labels.unknownReplayAccount : labels.playerSaveError}
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={isSaving} onClick={() => closeForm(false)} className="min-h-11">
                {labels.cancel}
              </Button>
              <Button type="submit" disabled={isSaving} className="min-h-11 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="button-save-player">
                {isSaving ? labels.savingPlayer : labels.savePlayer}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
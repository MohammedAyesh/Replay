import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  Menu,
  Megaphone,
  PanelLeft,
  Pencil,
  Plus,
  ReceiptText,
  Trash2,
  Users,
  UserRound,
  Video,
  X,
} from "lucide-react";
import {
  getGetAcademyQueryKey,
  getGetAcademyConsoleDashboardQueryKey,
  getGetAcademyConsoleMembershipsQueryKey,
  getListAcademyConsoleSquadsQueryKey,
  useCreateAcademyConsoleSquad,
  useDeleteAcademyConsoleSquad,
  useGetAcademy,
  useGetAcademyConsoleDashboard,
  useGetAcademyConsoleMemberships,
  useListAcademyConsoleSquads,
  useUpdateAcademyConsoleSquad,
  type AcademyConsoleDashboard,
  type AcademyConsoleMembership,
  type AcademySquadSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AcademyPlayersSection } from "@/components/academy-console/players-section";
import { AcademySessionsSection } from "@/components/academy-console/sessions-section";
import { AcademyAttendanceSection } from "@/components/academy-console/attendance-section";
import { AcademyRecordingsSection } from "@/components/academy-console/recordings-section";
import { AcademyAnnouncementsSection } from "@/components/academy-console/announcements-section";
import { AcademyFeesPaymentsSection } from "@/components/academy-console/fees-payments-section";

const SESSION_ACADEMY_KEY = "soccerwatch_academy_console_academy";

type ConsoleSection = "dashboard" | "squads" | "players" | "attendance" | "schedule" | "recordings" | "fees" | "announcements";

function readSelectedAcademyId(): number | null {
  try {
    const value = sessionStorage.getItem(SESSION_ACADEMY_KEY);
    return value ? Number(value) || null : null;
  } catch {
    return null;
  }
}

function hasHttpStatus(error: unknown, status: number): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && (error as { status?: unknown }).status === status;
}

function writeSelectedAcademyId(academyId: number) {
  try {
    sessionStorage.setItem(SESSION_ACADEMY_KEY, String(academyId));
  } catch {
    // Session storage is an enhancement; the current page remains usable without it.
  }
}

function AcademyWordmark() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3" data-testid="academy-console-brand">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-floodlight text-void shadow-[0_8px_24px_rgba(212,255,79,0.12)]">
        <GraduationCap className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block font-display text-sm font-bold tracking-[0.12em] text-text">SOCCERWATCH</span>
        <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-text">{t.academyConsole.title}</span>
      </span>
    </div>
  );
}

function AcademyLogo({ academyName, logoUrl }: { academyName: string; logoUrl: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = Array.from(academyName.trim())[0]?.toLocaleUpperCase() || "A";

  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-raised text-sm font-bold text-turf">
      {logoUrl && !imageFailed ? (
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-contain p-0.5"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="grid h-7 w-7 place-items-center rounded-full bg-turf/10 text-sm font-bold text-turf" aria-hidden="true">
          {initial}
        </span>
      )}
    </span>
  );
}

function AcademySidebarBrand({
  academyName,
  academyLogoUrl,
}: {
  academyName: string;
  academyLogoUrl: string | null;
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-testid="academy-console-brand">
      <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
        <AcademyLogo
          key={`${academyName}:${academyLogoUrl ?? ""}`}
          academyName={academyName}
          logoUrl={academyLogoUrl}
        />
        <span className="h-6 w-px bg-line" />
        <img src="/replay-mark.svg" alt="" className="h-7 w-7 object-contain" />
      </div>
      <span className="min-w-0 flex-1" dir={locale === "ar" ? "rtl" : "ltr"}>
        <span
          className="block truncate font-display text-sm font-bold leading-5 text-text"
          title={academyName}
        >
          {academyName}
        </span>
        <span className="block whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-text">
          {t.academyConsole.title}
        </span>
      </span>
    </div>
  );
}

function AcademyConsoleSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5" data-testid="academy-console-loading" aria-label={t.academyConsole.loading}>
      <div className="h-7 w-44 animate-pulse rounded-lg bg-raised" />
      <div className="h-16 w-full animate-pulse rounded-2xl bg-raised" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((item) => <div key={item} className="h-32 animate-pulse rounded-2xl bg-raised" />)}
      </div>
      <div className="h-44 animate-pulse rounded-2xl bg-raised" />
    </div>
  );
}

function AcademyConsoleSidebar({
  section,
  onNavigate,
  memberships,
  selectedAcademyId,
  academyLogoUrl,
  onSelectAcademy,
  isOwner,
  mobile = false,
}: {
  section: ConsoleSection;
  onNavigate: (section: ConsoleSection) => void;
  memberships: AcademyConsoleMembership[];
  selectedAcademyId: number | null;
  academyLogoUrl: string | null;
  onSelectAcademy: (academyId: number) => void;
  isOwner: boolean;
  mobile?: boolean;
}) {
  const { t, locale, setLocale } = useTranslation();
  const labels = t.academyConsole;
  const selectedMembership = memberships.find((membership) => membership.academyId === selectedAcademyId) ?? memberships[0];
  const items: Array<{ id: ConsoleSection; label: string; icon: typeof LayoutDashboard; ownerOnly?: boolean }> = [
    { id: "dashboard", label: labels.dashboard, icon: LayoutDashboard },
    { id: "squads", label: labels.squads, icon: Users },
    { id: "players", label: labels.players, icon: UserRound },
    { id: "attendance", label: labels.attendance, icon: ClipboardList },
    { id: "schedule", label: labels.scheduleResults, icon: CalendarDays },
    { id: "recordings", label: labels.recordings, icon: Video },
    { id: "fees", label: labels.feesPayments, icon: ReceiptText, ownerOnly: true },
    { id: "announcements", label: labels.announcements, icon: Megaphone },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid={mobile ? "academy-console-mobile-sidebar" : "academy-console-sidebar"}>
      <div className="flex items-center justify-between border-b border-line px-5 py-5">
        <AcademySidebarBrand
          academyName={selectedMembership?.academyName ?? ""}
          academyLogoUrl={academyLogoUrl}
        />
        {mobile && (
          <Button type="button" variant="ghost" size="icon" className="text-muted-text" onClick={() => onNavigate(section)} data-testid="button-close-academy-menu">
            <X className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">{labels.closeMenu}</span>
          </Button>
        )}
      </div>

      <div className="border-b border-line p-4">
        <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-muted-text" htmlFor="academy-switcher">
          {labels.academy}
        </label>
        <div className="relative">
          <select
            id="academy-switcher"
            value={selectedAcademyId ?? ""}
            onChange={(event) => onSelectAcademy(Number(event.target.value))}
            className="min-h-11 w-full appearance-none rounded-xl border border-line bg-raised px-3 pe-9 text-start text-sm font-semibold text-text outline-none focus:border-turf"
            data-testid="select-academy"
          >
            {memberships.map((membership) => (
              <option key={membership.academyId} value={membership.academyId}>{membership.academyName}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" aria-hidden="true" />
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-3" aria-label={labels.navigation}>
        <p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-text">{labels.workspace}</p>
        <div className="space-y-1">
          {items.filter((item) => !item.ownerOnly || isOwner).map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm font-semibold transition-colors",
                  section === item.id ? "bg-turf/10 text-turf" : "text-muted-text hover:bg-raised hover:text-text",
                )}
                data-testid={`nav-academy-${item.id}`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-line p-4">
        <button
          type="button"
          onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
          className="flex min-h-11 w-full items-center justify-between rounded-xl border border-line bg-raised px-3 text-sm font-semibold text-text transition-colors hover:border-turf"
          data-testid="button-academy-language"
        >
          <span>{labels.language}</span>
          <span className="font-display text-xs tracking-[0.14em] text-turf">{locale.toUpperCase()}</span>
        </button>
      </div>
    </div>
  );
}

function SignedOutAcademyState() {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const labels = t.academyConsole;
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-void px-5 py-10" data-testid="academy-console-signed-out">
      <div className="w-full max-w-md rounded-[28px] border border-line bg-surface p-7 text-center shadow-2xl shadow-black/10">
        <AcademyWordmark />
        <div className="mx-auto mt-10 grid h-16 w-16 place-items-center rounded-2xl bg-turf/10 text-turf">
          <PanelLeft className="h-7 w-7" aria-hidden="true" />
        </div>
        <h1 className="mt-6 font-display text-3xl font-bold tracking-tight text-text">{labels.signInTitle}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-text">{labels.signInDescription}</p>
        <Button type="button" className="mt-7 min-h-12 w-full rounded-xl bg-floodlight font-bold text-void" onClick={() => setLocation("/sign-in?redirect_url=%2Facademy")} data-testid="button-academy-sign-in">
          {labels.signIn}
        </Button>
      </div>
    </div>
  );
}

function AcademyNoAccessState() {
  const { t } = useTranslation();
  const labels = t.academyConsole;
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-void px-5 py-10" data-testid="academy-console-no-access">
      <div className="w-full max-w-lg rounded-[28px] border border-line bg-surface p-8 text-center">
        <AcademyWordmark />
        <div className="mx-auto mt-12 grid h-16 w-16 place-items-center rounded-2xl bg-floodlight/10 text-floodlight">
          <GraduationCap className="h-8 w-8" aria-hidden="true" />
        </div>
        <h1 className="mt-6 font-display text-3xl font-bold text-text">{labels.noAccessTitle}</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-text">{labels.noAccessDescription}</p>
      </div>
    </div>
  );
}

function Dashboard({ dashboard, isOwner }: { dashboard: AcademyConsoleDashboard; isOwner: boolean }) {
  const { t, locale } = useTranslation();
  const labels = t.academyConsole;
  const [, setLocation] = useLocation();
  const roleLabels = dashboard.roles.map((role) => role === "owner" ? labels.owner : labels.coach);
  const counts = [
    { label: labels.squadsCount, value: dashboard.squadCount, icon: Users, testId: "stat-squads" },
    { label: labels.activePlayersCount, value: dashboard.activePlayerCount, icon: UserRound, testId: "stat-active-players" },
    { label: labels.upcomingSessionsCount, value: dashboard.upcomingSessionCount, icon: CalendarDays, testId: "stat-upcoming-sessions" },
  ];
  const links: Array<{ section: ConsoleSection; label: string; description: string; icon: typeof Users }> = [
    { section: "squads", label: labels.gettingStartedSquads, description: labels.gettingStartedSquadsDescription, icon: Users },
    { section: "players", label: labels.gettingStartedPlayers, description: labels.gettingStartedPlayersDescription, icon: UserRound },
    { section: "schedule", label: labels.gettingStartedSchedule, description: labels.gettingStartedScheduleDescription, icon: CalendarDays },
  ];

  return (
    <div className="space-y-7" data-testid="academy-console-dashboard">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{labels.overview}</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text" data-testid="text-academy-name">{dashboard.academyName}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-text">{labels.dashboardDescription}</p>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="academy-console-roles">
          {roleLabels.map((role) => <span key={role} className="rounded-full border border-turf/30 bg-turf/10 px-3 py-1.5 text-xs font-bold text-turf">{role}</span>)}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {counts.map(({ label, value, icon: Icon, testId }) => (
          <div key={testId} className="rounded-2xl border border-line bg-surface p-5" data-testid={testId}>
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-semibold text-muted-text">{label}</span>
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-raised text-turf"><Icon className="h-4 w-4" aria-hidden="true" /></span>
            </div>
            <p className="mt-6 font-display text-4xl font-bold tabular-nums text-text">{value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6" data-testid="academy-getting-started">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-text">{labels.nextUp}</p>
            <h2 className="mt-2 font-display text-2xl font-bold text-text">{labels.gettingStarted}</h2>
          </div>
          <span className="hidden text-xs text-muted-text sm:block">{isOwner ? labels.ownerAccess : labels.coachAccess}</span>
        </div>
        <div className="mt-5 divide-y divide-line">
          {links.map(({ section, label, description, icon: Icon }) => (
            <button key={section} type="button" onClick={() => setLocation(`/academy/${section}`)} className="flex w-full items-center gap-4 py-4 text-start transition-colors hover:text-turf" data-testid={`link-getting-started-${section}`}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-raised text-turf"><Icon className="h-4 w-4" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-text">{label}</span><span className="mt-1 block text-xs leading-5 text-muted-text">{description}</span></span>
              {localeDirectionArrow(locale === "ar" ? "rtl" : "ltr")}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function localeDirectionArrow(direction: "ltr" | "rtl") {
  const Arrow = direction === "rtl" ? ArrowLeft : ArrowRight;
  return <Arrow className="h-4 w-4 shrink-0 text-muted-text" aria-hidden="true" />;
}

type SquadFormValue = {
  name: string;
  ageGroup: string;
  description: string;
};

function SquadsSection({ academyId }: { academyId: number }) {
  const { t, locale } = useTranslation();
  const labels = t.academyConsole;
  const queryClient = useQueryClient();
  const squadsQuery = useListAcademyConsoleSquads(academyId, {
    query: {
      queryKey: getListAcademyConsoleSquadsQueryKey(academyId),
      staleTime: 20_000,
    },
  });
  const createSquad = useCreateAcademyConsoleSquad();
  const updateSquad = useUpdateAcademyConsoleSquad();
  const deleteSquad = useDeleteAcademyConsoleSquad();
  const [formOpen, setFormOpen] = useState(false);
  const [editingSquad, setEditingSquad] = useState<AcademySquadSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AcademySquadSummary | null>(null);
  const [form, setForm] = useState<SquadFormValue>({ name: "", ageGroup: "", description: "" });
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof SquadFormValue, string>>>({});
  const [saveError, setSaveError] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const numberFormat = new Intl.NumberFormat(locale);
  const squads = squadsQuery.data ?? [];
  const isSaving = createSquad.isPending || updateSquad.isPending;

  const refreshAcademyCounts = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListAcademyConsoleSquadsQueryKey(academyId) }),
      queryClient.invalidateQueries({ queryKey: getGetAcademyConsoleDashboardQueryKey(academyId) }),
    ]);
  };

  const openCreateForm = () => {
    setEditingSquad(null);
    setForm({ name: "", ageGroup: "", description: "" });
    setFormErrors({});
    setSaveError(false);
    setFormOpen(true);
  };

  const openEditForm = (squad: AcademySquadSummary) => {
    setEditingSquad(squad);
    setForm({
      name: squad.name,
      ageGroup: squad.ageGroup ?? "",
      description: squad.description ?? "",
    });
    setFormErrors({});
    setSaveError(false);
    setFormOpen(true);
  };

  const closeForm = (open: boolean) => {
    setFormOpen(open);
    if (!open) {
      setEditingSquad(null);
      setFormErrors({});
      setSaveError(false);
    }
  };

  const saveSquad = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = form.name.trim();
    const nextErrors: Partial<Record<keyof SquadFormValue, string>> = {};
    if (!name) nextErrors.name = labels.squadNameRequired;
    else if (name.length > 120) nextErrors.name = labels.squadNameTooLong;
    if (form.ageGroup.trim().length > 80) nextErrors.ageGroup = labels.ageGroupTooLong;
    if (form.description.trim().length > 1000) nextErrors.description = labels.descriptionTooLong;
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const data = {
      name,
      ageGroup: form.ageGroup.trim() || null,
      description: form.description.trim() || null,
    };
    setSaveError(false);
    try {
      if (editingSquad) {
        await updateSquad.mutateAsync({
          academyId,
          squadId: editingSquad.id,
          data,
        });
      } else {
        await createSquad.mutateAsync({ academyId, data });
      }
      await refreshAcademyCounts();
      setFormOpen(false);
      setEditingSquad(null);
    } catch {
      setSaveError(true);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(false);
    try {
      await deleteSquad.mutateAsync({ academyId, squadId: pendingDelete.id });
      await refreshAcademyCounts();
      setPendingDelete(null);
    } catch {
      setDeleteError(true);
    }
  };

  const updateField = (field: keyof SquadFormValue, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormErrors((current) => ({ ...current, [field]: undefined }));
  };

  return (
    <section className="space-y-6" data-testid="academy-squads">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{labels.workspace}</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{labels.squads}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{labels.squadsDescription}</p>
        </div>
        <Button
          type="button"
          onClick={openCreateForm}
          className="min-h-11 shrink-0 rounded-xl bg-floodlight px-4 font-bold text-void hover:bg-floodlight/90"
          data-testid="button-create-squad"
        >
          <Plus className="me-2 h-4 w-4" aria-hidden="true" />
          {labels.addSquad}
        </Button>
      </div>

      {squadsQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2" data-testid="academy-squads-loading" aria-label={labels.loading}>
          {[0, 1].map((item) => <div key={item} className="h-44 animate-pulse rounded-2xl border border-line bg-surface" />)}
        </div>
      ) : squadsQuery.isError ? (
        <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted-text" data-testid="academy-squads-error">
          <p role="alert">{labels.squadsLoadError}</p>
          <Button type="button" variant="outline" className="mt-4 min-h-10" onClick={() => void squadsQuery.refetch()}>
            {labels.retry}
          </Button>
        </div>
      ) : squads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center" data-testid="academy-squads-empty">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-turf/10 text-turf">
            <Users className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 font-display text-xl font-bold text-text">{labels.squadsEmptyTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-text">{labels.squadsEmptyDescription}</p>
          <Button type="button" onClick={openCreateForm} className="mt-5 min-h-11 rounded-xl bg-floodlight px-4 font-bold text-void">
            <Plus className="me-2 h-4 w-4" aria-hidden="true" />
            {labels.addSquad}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2" data-testid="academy-squad-list">
          {squads.map((squad) => (
            <article key={squad.id} className="rounded-2xl border border-line bg-surface p-5 sm:p-6" data-testid={`academy-squad-${squad.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 dir="auto" className="break-words font-display text-xl font-bold text-text">{squad.name}</h2>
                  {squad.ageGroup && <p dir="auto" className="mt-1 text-sm font-semibold text-turf">{squad.ageGroup}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => openEditForm(squad)}
                    aria-label={`${labels.editSquad}: ${squad.name}`}
                    className="text-muted-text hover:text-text"
                    data-testid={`button-edit-squad-${squad.id}`}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setDeleteError(false);
                      setPendingDelete(squad);
                    }}
                    aria-label={`${labels.deleteSquad}: ${squad.name}`}
                    className="text-muted-text hover:text-destructive"
                    data-testid={`button-delete-squad-${squad.id}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
              {squad.description && (
                <p dir="auto" className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-muted-text">{squad.description}</p>
              )}
              <div className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-sm text-muted-text">
                <Users className="h-4 w-4 shrink-0 text-turf" aria-hidden="true" />
                <span className="font-bold tabular-nums text-text">{numberFormat.format(squad.activePlayerCount)}</span>
                <span>{labels.activePlayersInSquad}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={closeForm}>
        <DialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="max-h-[90dvh] overflow-y-auto border-line bg-surface text-text">
          <DialogHeader className="text-start">
            <DialogTitle>{editingSquad ? labels.editSquad : labels.addSquad}</DialogTitle>
            <DialogDescription className="text-start text-muted-text">{labels.squadFormDescription}</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveSquad} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="academy-squad-name">{labels.squadName}</Label>
              <Input
                id="academy-squad-name"
                autoFocus
                required
                maxLength={120}
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                aria-invalid={Boolean(formErrors.name)}
                aria-describedby={formErrors.name ? "academy-squad-name-error" : undefined}
                className="min-h-11 text-start"
                data-testid="input-squad-name"
              />
              {formErrors.name && <p id="academy-squad-name-error" className="text-sm text-destructive" role="alert">{formErrors.name}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="academy-squad-age-group">{labels.ageGroup}</Label>
              <Input
                id="academy-squad-age-group"
                maxLength={80}
                value={form.ageGroup}
                onChange={(event) => updateField("ageGroup", event.target.value)}
                aria-invalid={Boolean(formErrors.ageGroup)}
                aria-describedby={formErrors.ageGroup ? "academy-squad-age-group-error" : undefined}
                className="min-h-11 text-start"
                data-testid="input-squad-age-group"
              />
              {formErrors.ageGroup && <p id="academy-squad-age-group-error" className="text-sm text-destructive" role="alert">{formErrors.ageGroup}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="academy-squad-description">{labels.description}</Label>
              <Textarea
                id="academy-squad-description"
                maxLength={1000}
                rows={4}
                value={form.description}
                onChange={(event) => updateField("description", event.target.value)}
                aria-invalid={Boolean(formErrors.description)}
                aria-describedby={formErrors.description ? "academy-squad-description-error" : undefined}
                className="resize-y text-start"
                data-testid="input-squad-description"
              />
              {formErrors.description && <p id="academy-squad-description-error" className="text-sm text-destructive" role="alert">{formErrors.description}</p>}
            </div>
            {saveError && <p className="text-sm text-destructive" role="alert" data-testid="squad-save-error">{labels.squadSaveError}</p>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={isSaving} onClick={() => closeForm(false)} className="min-h-11">
                {labels.cancel}
              </Button>
              <Button type="submit" disabled={isSaving} className="min-h-11 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid="button-save-squad">
                {isSaving ? labels.savingSquad : labels.saveSquad}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleteSquad.isPending) {
            setPendingDelete(null);
            setDeleteError(false);
          }
        }}
      >
        <AlertDialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{labels.deleteSquadTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-muted-text">
              {labels.deleteSquadDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-sm text-destructive" role="alert" data-testid="squad-delete-error">{labels.squadDeleteError}</p>}
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={deleteSquad.isPending} className="min-h-11">
              {labels.cancel}
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={deleteSquad.isPending}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              className="min-h-11 bg-destructive font-bold text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-squad"
            >
              {deleteSquad.isPending ? labels.deletingSquad : labels.deleteSquad}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export default function AcademyConsole() {
  const { isSignedIn, isLoading, isGuest } = useAuth();
  const { t, locale } = useTranslation();
  const [location, setLocation] = useLocation();
  const [section, setSection] = useState<ConsoleSection>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [selectedAcademyId, setSelectedAcademyId] = useState<number | null>(readSelectedAcademyId);
  const membershipsQuery = useGetAcademyConsoleMemberships({
    query: {
      enabled: isSignedIn && !isGuest,
      queryKey: getGetAcademyConsoleMembershipsQueryKey(),
    },
  });
  const memberships = membershipsQuery.data ?? [];
  const activeMembership = useMemo(
    () => memberships.find((membership) => membership.academyId === selectedAcademyId) ?? memberships[0],
    [memberships, selectedAcademyId],
  );
  const activeAcademyId = activeMembership?.academyId ?? null;
  const dashboardQuery = useGetAcademyConsoleDashboard(activeAcademyId ?? 0, {
    query: {
      enabled: activeAcademyId !== null,
      queryKey: getGetAcademyConsoleDashboardQueryKey(activeAcademyId ?? 0),
    },
  });
  const academyQuery = useGetAcademy(activeAcademyId ?? 0, {
    query: {
      enabled: activeAcademyId !== null,
      queryKey: getGetAcademyQueryKey(activeAcademyId ?? 0),
      staleTime: 5 * 60 * 1000,
    },
  });
  const isOwner = activeMembership?.roles.includes("owner") ?? false;

  useEffect(() => {
    if (!activeMembership) return;
    if (activeMembership.academyId !== selectedAcademyId) {
      setSelectedAcademyId(activeMembership.academyId);
      writeSelectedAcademyId(activeMembership.academyId);
    }
  }, [activeMembership, selectedAcademyId]);

  useEffect(() => {
    if (!isOwner && section === "fees") setSection("dashboard");
  }, [isOwner, section]);

  const navigate = (nextSection: ConsoleSection) => {
    setSection(nextSection);
    setMobileOpen(false);
    setLocation(nextSection === "dashboard" ? "/academy" : `/academy/${nextSection}`);
  };

  useEffect(() => {
    const path = location.split(/[?#]/)[0].replace(/\/+$/, "");
    const pathSection = path.split("/")[2] as ConsoleSection | undefined;
    if (pathSection && ["squads", "players", "attendance", "schedule", "recordings", "fees", "announcements"].includes(pathSection)) {
      setSection(pathSection);
    } else {
      setSection("dashboard");
    }
  }, [location]);

  if (isLoading || (isSignedIn && !isGuest && membershipsQuery.isLoading)) {
    return <div className="grid min-h-[100dvh] place-items-center bg-void px-5"><div className="w-full max-w-5xl"><AcademyConsoleSkeleton /></div></div>;
  }
  if (!isSignedIn || isGuest) return <SignedOutAcademyState />;
  if (membershipsQuery.isError && hasHttpStatus(membershipsQuery.error, 403)) return <AcademyNoAccessState />;
  if (membershipsQuery.isError) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-void px-5 py-10" data-testid="academy-console-membership-error">
        <div className="w-full max-w-lg rounded-[28px] border border-line bg-surface p-8 text-center">
          <AcademyWordmark />
          <p className="mt-8 text-sm leading-6 text-muted-text" role="alert">{t.academyConsole.membershipError}</p>
          <Button type="button" className="mt-5 min-h-11 rounded-xl bg-floodlight px-5 font-bold text-void" onClick={() => void membershipsQuery.refetch()}>
            {t.academyConsole.retry}
          </Button>
        </div>
      </div>
    );
  }
  if (memberships.length === 0) return <AcademyNoAccessState />;

  const sidebarProps = {
    section,
    onNavigate: navigate,
    memberships,
    selectedAcademyId: activeAcademyId,
    academyLogoUrl: academyQuery.data?.logoUrl ?? null,
    onSelectAcademy: (academyId: number) => {
      setSelectedAcademyId(academyId);
      writeSelectedAcademyId(academyId);
      setSection("dashboard");
      setLocation("/academy");
    },
    isOwner,
  };

  return (
    <div className="flex min-h-[100dvh] w-full bg-void text-text" dir={locale === "ar" ? "rtl" : "ltr"} data-testid="academy-console">
      <aside className="hidden w-72 shrink-0 border-e border-line md:block"><AcademyConsoleSidebar {...sidebarProps} /></aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side={locale === "ar" ? "right" : "left"} className="w-[min(88vw,20rem)] border-line bg-surface p-0 [&>button]:hidden">
          <SheetHeader className="sr-only"><SheetTitle>{t.academyConsole.navigation}</SheetTitle><SheetDescription>{t.academyConsole.mobileDescription}</SheetDescription></SheetHeader>
          <AcademyConsoleSidebar {...sidebarProps} mobile />
        </SheetContent>
      </Sheet>
      <main className="min-w-0 flex-1 bg-void">
        <header className="sticky top-0 z-20 flex min-h-20 items-center justify-end border-b border-line bg-void/90 px-5 backdrop-blur-md md:px-8" data-testid="academy-console-header">
          <Button type="button" variant="ghost" size="icon" className="absolute start-5 text-muted-text md:hidden" onClick={() => setMobileOpen(true)} data-testid="button-open-academy-menu">
            <Menu className="h-5 w-5" aria-hidden="true" /><span className="sr-only">{t.academyConsole.openMenu}</span>
          </Button>
          <Link href="/account" className="rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-muted-text transition-colors hover:text-text" data-testid="link-academy-account">{t.academyConsole.account}</Link>
        </header>
        <div className="mx-auto max-w-6xl px-5 py-8 pb-14 md:px-8">
          {section === "dashboard" ? (
            dashboardQuery.isLoading ? <AcademyConsoleSkeleton /> :
              dashboardQuery.isError || !dashboardQuery.data ? <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted-text" data-testid="academy-dashboard-error">{t.academyConsole.dashboardError}</div> :
                <Dashboard dashboard={dashboardQuery.data} isOwner={isOwner} />
          ) : section === "squads" ? (
            activeAcademyId === null ? <AcademyConsoleSkeleton /> : <SquadsSection academyId={activeAcademyId} />
          ) : section === "players" ? (
            activeAcademyId === null ? <AcademyConsoleSkeleton /> : <AcademyPlayersSection academyId={activeAcademyId} />
          ) : section === "schedule" ? (
            activeAcademyId === null ? <AcademyConsoleSkeleton /> : <AcademySessionsSection academyId={activeAcademyId} />
          ) : section === "attendance" ? (
            activeAcademyId === null ? <AcademyConsoleSkeleton /> : <AcademyAttendanceSection academyId={activeAcademyId} />
          ) : section === "recordings" ? (
            activeAcademyId === null ? <AcademyConsoleSkeleton /> : <AcademyRecordingsSection academyId={activeAcademyId} academyName={activeMembership?.academyName ?? ""} />
          ) : section === "fees" ? (
            !isOwner || activeAcademyId === null ? <AcademyConsoleSkeleton /> : <AcademyFeesPaymentsSection academyId={activeAcademyId} />
          ) : section === "announcements" ? (
            activeAcademyId === null ? <AcademyConsoleSkeleton /> : <AcademyAnnouncementsSection academyId={activeAcademyId} />
          ) : <AcademyConsoleSkeleton />}
        </div>
      </main>
    </div>
  );
}
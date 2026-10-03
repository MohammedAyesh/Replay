import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  getGetAcademyFinanceDashboardQueryKey,
  getListAcademyFinanceCategoriesQueryKey,
  getListAcademyFinanceOtherPaymentsQueryKey,
  getListAcademyFinanceStaffQueryKey,
  getListAcademyFinanceTeamPlayersQueryKey,
  getListAcademyFinanceTeamsQueryKey,
  getListAcademyFinancePlayerFeesQueryKey,
  useCreateAcademyFinanceCategory,
  useCreateAcademyFinanceOtherPayment,
  useCreateAcademyFinancePlayerFee,
  useCreateAcademyFinancePlayerRenewal,
  useCreateAcademyFinanceStaff,
  useCreateAcademyFinanceTeam,
  useCreateAcademyFinanceTeamPlayer,
  useGetAcademyFinanceDashboard,
  useListAcademyFinanceCategories,
  useListAcademyFinanceOtherPayments,
  useListAcademyFinancePlayerFees,
  useListAcademyFinanceStaff,
  useListAcademyFinanceTeamPlayers,
  useListAcademyFinanceTeams,
  useMarkAcademyFinanceFeePaid,
  useMarkAcademyFinanceOtherPaymentPaid,
  useRecordAcademyFinanceSalaryPayment,
  useRepeatAcademyFinanceOtherPayment,
  useUpdateAcademyFinancePlayerBilling,
  useUpdateAcademyFinanceTeam,
  useUpdateAcademyFinanceStaff,
  type AcademyFinanceFeeInput,
  type AcademyFinanceCategoryList,
  type AcademyFinanceDashboard,
  type AcademyFinanceOtherPaymentList,
  type AcademyFinancePlayer,
  type AcademyFinancePlayerBillingUpdate,
  type AcademyFinancePlayerInput,
  type AcademyFinanceStaff,
  type AcademyFinanceStaffInput,
  type AcademyFinanceStaffUpdate,
  type AcademyFinanceTeamInput,
  type AcademyFinanceTeam,
  type AcademyFinanceOtherPaymentInput,
} from "@workspace/api-client-react";
import {
  Activity,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDollarSign,
  Clock3,
  Coins,
  CreditCard,
  FilePlus2,
  Plus,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Users,
  Wallet,
} from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type SectionKey = "dashboard" | "players" | "salaries" | "other";
type FinanceCopy = ReturnType<typeof useTranslation>["t"]["academyConsole"]["feesPaymentsPanel"];
type FinanceQuery<T> = Pick<UseQueryResult<T, Error>, "data" | "isLoading" | "isError" | "refetch">;

const TIME_ZONE = "Asia/Amman";

function ammanToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDate(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(normalizedMonth + 1).padStart(2, "0")}-${String(Math.min(day, maxDay)).padStart(2, "0")}`;
}

function formatMoney(fils: number, locale: string): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    style: "currency",
    currency: "JOD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(fils / 1000);
}

function MoneyAmount({ amountFils, locale }: { amountFils: number; locale: string }) {
  return <bdi dir={locale === "ar" ? "rtl" : "ltr"}>{formatMoney(amountFils, locale)}</bdi>;
}

function localizeCategory(name: string, copy: FinanceCopy): string {
  const categories: Record<string, string> = {
    rent: copy.categoryRent,
    transport: copy.categoryTransport,
    replay: copy.categoryReplay,
    equipment: copy.categoryEquipment,
    other: copy.categoryOther,
    salary: copy.categorySalary,
  };
  return categories[name.trim().toLocaleLowerCase()] ?? name;
}

function formatDate(date: string | null | undefined, locale: string): string {
  if (!date) return "—";
  const parsed = new Date(`${date}T12:00:00+03:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    dateStyle: "medium",
    timeZone: TIME_ZONE,
  }).format(parsed);
}

function formatMonth(month: string, locale: string): string {
  const date = new Date(`${month}-01T12:00:00+03:00`);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" aria-label={t.academyConsole.feesPaymentsPanel.loading}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-16 animate-pulse rounded-xl border border-border/70 bg-card/70" />
      ))}
    </div>
  );
}

function QueryError({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3 text-sm">
        <CircleAlert className="size-5 shrink-0 text-destructive-foreground" aria-hidden="true" />
        <span>{message}</span>
      </div>
      <Button variant="outline" size="sm" onClick={retry}>{t.academyConsole.retry}</Button>
    </div>
  );
}

function EmptyState({ icon: Icon, title, description, action }: {
  icon: typeof Wallet;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-card/35 px-5 py-9 text-center">
      <span className="mb-3 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function ModalShell({ open, onOpenChange, title, description, children, className }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[90dvh] overflow-y-auto sm:max-w-lg", className)}>
        <DialogHeader className="text-start">
          <DialogTitle className="font-display text-xl">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, children, hint }: { id: string; label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AmountInput({ id, label, value, onChange, required = true, min = "0.001" }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  min?: string;
}) {
  const { t } = useTranslation();
  const copy = t.academyConsole.feesPaymentsPanel;
  return (
    <Field id={id} label={label} hint={copy.amountHint}>
      <Input id={id} type="number" inputMode="decimal" min={min} step="0.001" value={value}
        onChange={(event) => onChange(event.target.value)} required={required} />
    </Field>
  );
}

function amountToFils(value: string): number {
  return Math.round(Number(value) * 1000);
}

export function AcademyFeesPaymentsSection({ academyId }: { academyId: number }) {
  const { t, locale } = useTranslation();
  const copy = t.academyConsole.feesPaymentsPanel;
  const queryClient = useQueryClient();
  const [section, setSection] = useState<SectionKey>("dashboard");
  const [activeTeamId, setActiveTeamId] = useState<number | null>(null);
  const [pendingRenewPlayerId, setPendingRenewPlayerId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<"saved" | "paid" | "repeated" | "categorySaved" | "error" | null>(null);
  const dashboardQuery = useGetAcademyFinanceDashboard(academyId, {
    query: { queryKey: getGetAcademyFinanceDashboardQueryKey(academyId) },
  });
  const teamsQuery = useListAcademyFinanceTeams(academyId, {
    query: { queryKey: getListAcademyFinanceTeamsQueryKey(academyId) },
  });
  const staffQuery = useListAcademyFinanceStaff(academyId, {
    query: { queryKey: getListAcademyFinanceStaffQueryKey(academyId) },
  });
  const paymentsQuery = useListAcademyFinanceOtherPayments(academyId, {
    query: { queryKey: getListAcademyFinanceOtherPaymentsQueryKey(academyId) },
  });
  const categoriesQuery = useListAcademyFinanceCategories(academyId, {
    query: { queryKey: getListAcademyFinanceCategoriesQueryKey(academyId) },
  });
  const createTeam = useCreateAcademyFinanceTeam();
  const updateTeam = useUpdateAcademyFinanceTeam();
  const createPlayer = useCreateAcademyFinanceTeamPlayer();
  const updateBilling = useUpdateAcademyFinancePlayerBilling();
  const createRenewal = useCreateAcademyFinancePlayerRenewal();
  const createFee = useCreateAcademyFinancePlayerFee();
  const markFeePaid = useMarkAcademyFinanceFeePaid();
  const createStaff = useCreateAcademyFinanceStaff();
  const updateStaff = useUpdateAcademyFinanceStaff();
  const recordSalary = useRecordAcademyFinanceSalaryPayment();
  const createPayment = useCreateAcademyFinanceOtherPayment();
  const markPaymentPaid = useMarkAcademyFinanceOtherPaymentPaid();
  const repeatPayment = useRepeatAcademyFinanceOtherPayment();
  const createCategory = useCreateAcademyFinanceCategory();

  const refreshDashboard = () => queryClient.invalidateQueries({ queryKey: getGetAcademyFinanceDashboardQueryKey(academyId) });
  const refreshTeams = () => queryClient.invalidateQueries({ queryKey: getListAcademyFinanceTeamsQueryKey(academyId) });
  const refreshPlayers = (teamId: number) => queryClient.invalidateQueries({ queryKey: getListAcademyFinanceTeamPlayersQueryKey(academyId, teamId) });
  const refreshFees = (playerId: number) => queryClient.invalidateQueries({ queryKey: getListAcademyFinancePlayerFeesQueryKey(academyId, playerId) });
  const refreshStaff = () => queryClient.invalidateQueries({ queryKey: getListAcademyFinanceStaffQueryKey(academyId) });
  const refreshOther = () => queryClient.invalidateQueries({ queryKey: getListAcademyFinanceOtherPaymentsQueryKey(academyId) });
  const refreshCategories = () => queryClient.invalidateQueries({ queryKey: getListAcademyFinanceCategoriesQueryKey(academyId) });
  const playerWriteDone = async (teamId: number, playerId?: number) => {
    await Promise.all([
      refreshDashboard(),
      refreshTeams(),
      refreshPlayers(teamId),
      ...(playerId ? [refreshFees(playerId)] : []),
    ]);
  };
  const finishWrite = async (message: "saved" | "paid" | "repeated" | "categorySaved") => {
    setFeedback(message);
    setTimeout(() => setFeedback(null), 3600);
    return message;
  };

  const onCreateTeam = async (data: AcademyFinanceTeamInput) => {
    setFeedback(null);
    try {
      await createTeam.mutateAsync({ academyId, data });
      await Promise.all([refreshTeams(), refreshDashboard()]);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onUpdateTeamFee = async (teamId: number, monthlyFeeFils: number) => {
    setFeedback(null);
    try {
      await updateTeam.mutateAsync({ academyId, squadId: teamId, data: { monthlyFeeFils } });
      await playerWriteDone(teamId);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onCreatePlayer = async (teamId: number, data: AcademyFinancePlayerInput) => {
    setFeedback(null);
    try {
      await createPlayer.mutateAsync({ academyId, squadId: teamId, data });
      await playerWriteDone(teamId);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onUpdateBilling = async (teamId: number, playerId: number, data: AcademyFinancePlayerBillingUpdate) => {
    setFeedback(null);
    try {
      await updateBilling.mutateAsync({ academyId, playerId, data });
      await playerWriteDone(teamId, playerId);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onRenew = async (teamId: number, playerId: number, months: number) => {
    setFeedback(null);
    try {
      let remaining = months;
      while (remaining > 0) {
        const part = Math.min(12, remaining);
        await createRenewal.mutateAsync({ academyId, playerId, data: { months: part } });
        remaining -= part;
      }
      await playerWriteDone(teamId, playerId);
      await finishWrite("paid");
    } catch (error) {
      setFeedback("error");
      await playerWriteDone(teamId, playerId);
      throw error;
    }
  };
  const onCreateFee = async (teamId: number, playerId: number, data: AcademyFinanceFeeInput) => {
    setFeedback(null);
    try {
      await createFee.mutateAsync({ academyId, playerId, data });
      await playerWriteDone(teamId, playerId);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onMarkFeePaid = async (teamId: number, playerId: number, feeId: number) => {
    setFeedback(null);
    try {
      await markFeePaid.mutateAsync({ academyId, feeId, data: { status: "paid" } });
      await playerWriteDone(teamId, playerId);
      await finishWrite("paid");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onSaveStaff = async (staffId: number | null, data: AcademyFinanceStaffInput | AcademyFinanceStaffUpdate) => {
    setFeedback(null);
    try {
      if (staffId === null) await createStaff.mutateAsync({ academyId, data: data as AcademyFinanceStaffInput });
      else await updateStaff.mutateAsync({ academyId, staffId, data: data as AcademyFinanceStaffUpdate });
      await Promise.all([refreshStaff(), refreshDashboard()]);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onPaySalary = async (staffId: number) => {
    setFeedback(null);
    try {
      await recordSalary.mutateAsync({ academyId, staffId });
      await Promise.all([refreshStaff(), refreshOther(), refreshDashboard()]);
      await finishWrite("paid");
    } catch {
      setFeedback("error");
      throw new Error(copy.actionFailed);
    }
  };
  const onCreatePayment = async (data: AcademyFinanceOtherPaymentInput) => {
    setFeedback(null);
    try {
      await createPayment.mutateAsync({ academyId, data });
      await Promise.all([refreshOther(), refreshDashboard()]);
      await finishWrite("saved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onMarkPaymentPaid = async (paymentId: number) => {
    setFeedback(null);
    try {
      await markPaymentPaid.mutateAsync({ academyId, paymentId, data: { status: "paid" } });
      await Promise.all([refreshOther(), refreshDashboard()]);
      await finishWrite("paid");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onRepeatPayment = async (paymentId: number) => {
    setFeedback(null);
    try {
      await repeatPayment.mutateAsync({ academyId, paymentId });
      await Promise.all([refreshOther(), refreshDashboard()]);
      await finishWrite("repeated");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };
  const onCreateCategory = async (name: string) => {
    setFeedback(null);
    try {
      await createCategory.mutateAsync({ academyId, data: { name } });
      await refreshCategories();
      await finishWrite("categorySaved");
    } catch (error) {
      setFeedback("error");
      throw error;
    }
  };

  const sectionTabs: { key: SectionKey; label: string; icon: typeof Activity }[] = [
    { key: "dashboard", label: copy.dashboard, icon: Activity },
    { key: "players", label: copy.playerPayments, icon: Users },
    { key: "salaries", label: copy.salaries, icon: Wallet },
    { key: "other", label: copy.otherPayments, icon: CreditCard },
  ];
  const feedbackText = feedback === "error" ? copy.actionFailed : feedback ? copy.successMessages[feedback] : null;

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5 pb-8" aria-label={copy.title}>
      <header className="relative overflow-hidden rounded-2xl border border-border/80 bg-card px-5 py-5 sm:px-7 sm:py-6">
        <div className="pointer-events-none absolute inset-y-0 end-0 w-1/3 bg-gradient-to-l from-primary/10 to-transparent" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
              <span className="size-1.5 rounded-full bg-accent" />
              {copy.eyebrow}
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{copy.title}</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{copy.description}</p>
          </div>
          <div className="flex items-center gap-2 self-start rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-sm sm:self-auto">
            <CalendarDays className="size-4 text-accent" aria-hidden="true" />
            <span className="font-medium">{dashboardQuery.data ? formatMonth(dashboardQuery.data.month, locale) : formatMonth(ammanToday().slice(0, 7), locale)}</span>
            <span className="text-xs text-muted-foreground">{copy.currentMonth}</span>
          </div>
        </div>
      </header>

      <nav className="flex w-full gap-2 overflow-x-auto rounded-xl border border-border/70 bg-card/55 p-1.5 no-scrollbar" role="tablist" aria-label={copy.sections}>
        {sectionTabs.map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" role="tab" aria-selected={section === key}
            onClick={() => { setSection(key); if (key !== "players") setActiveTeamId(null); }}
            className={cn(
              "relative flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors sm:px-4",
              section === key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}>
            <Icon className="size-4" aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {feedbackText && (
        <div role={feedback === "error" ? "alert" : "status"}
          className={cn("flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
            feedback === "error" ? "border-destructive/40 bg-destructive/10 text-foreground" : "border-accent/35 bg-accent/10 text-foreground")}>
          {feedback === "error" ? <CircleAlert className="size-4 text-destructive-foreground" /> : <CircleCheck className="size-4 text-accent" />}
          {feedbackText}
        </div>
      )}

      {section === "dashboard" && (
        <DashboardPanel dashboardQuery={dashboardQuery}
          locale={locale} copy={copy} onNavigate={(teamId, playerId) => {
            setSection("players"); setActiveTeamId(teamId); setPendingRenewPlayerId(playerId);
          }} />
      )}
      {section === "players" && (
        <PlayerPaymentsPanel academyId={academyId} teamsQuery={teamsQuery} activeTeamId={activeTeamId}
          onSelectTeam={setActiveTeamId} locale={locale} copy={copy}
          onCreateTeam={onCreateTeam} isCreatingTeam={createTeam.isPending}
          onUpdateTeamFee={onUpdateTeamFee} isUpdatingTeamFee={updateTeam.isPending}
          onCreatePlayer={onCreatePlayer} onUpdateBilling={onUpdateBilling} onRenew={onRenew}
          onCreateFee={onCreateFee} onMarkFeePaid={onMarkFeePaid}
          onRefreshPlayerWrites={playerWriteDone}
          pendingRenewPlayerId={pendingRenewPlayerId}
          onPendingRenewHandled={() => setPendingRenewPlayerId(null)}
          isRenewing={createRenewal.isPending} />
      )}
      {section === "salaries" && (
        <SalariesPanel staffQuery={staffQuery} locale={locale} copy={copy}
          onSave={onSaveStaff} onPay={onPaySalary}
          isSaving={createStaff.isPending || updateStaff.isPending} isPaying={recordSalary.isPending} />
      )}
      {section === "other" && (
        <OtherPaymentsPanel paymentsQuery={paymentsQuery} categoriesQuery={categoriesQuery} locale={locale} copy={copy}
          onCreatePayment={onCreatePayment} onMarkPaid={onMarkPaymentPaid} onRepeat={onRepeatPayment}
          onCreateCategory={onCreateCategory} isSaving={createPayment.isPending}
          isMarkingPaid={markPaymentPaid.isPending} isRepeating={repeatPayment.isPending}
          isSavingCategory={createCategory.isPending} />
      )}
    </section>
  );
}

function DashboardPanel({ dashboardQuery, locale, copy, onNavigate }: {
  dashboardQuery: FinanceQuery<AcademyFinanceDashboard>;
  locale: string;
  copy: FinanceCopy;
  onNavigate: (teamId: number, playerId: number) => void;
}) {
  const data = dashboardQuery.data;
  if (dashboardQuery.isLoading) return <PanelSkeleton rows={5} />;
  if (dashboardQuery.isError || !data) return <QueryError message={copy.loadError} retry={() => void dashboardQuery.refetch()} />;
  const attentionPlayers = [...data.expiredPlayers, ...data.expiringPlayers];
  const unpaidPayments = data.unpaidPayments ?? [];
  const cards = [
    { label: copy.collectedThisMonth, value: data.collectedFils, icon: ArrowDownRight, tone: "text-emerald-300", tint: "bg-emerald-400/10" },
    { label: copy.spentThisMonth, value: data.spentFils, icon: ArrowUpRight, tone: "text-rose-300", tint: "bg-rose-400/10" },
    { label: copy.net, value: data.netFils, icon: Activity, tone: data.netFils < 0 ? "text-rose-300" : "text-primary", tint: data.netFils < 0 ? "bg-rose-400/10" : "bg-primary/10" },
    { label: copy.unpaidBills, value: data.unpaidBillsCount, icon: Clock3, tone: "text-amber-300", tint: "bg-amber-400/10", count: true },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, tone, tint, count }) => (
          <article key={label} className="relative overflow-hidden rounded-xl border border-border/75 bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span className={cn("grid size-9 place-items-center rounded-lg", tint, tone)}>
                <Icon className="size-[18px]" aria-hidden="true" />
              </span>
            </div>
            <p className={cn("mt-5 font-display text-2xl font-bold tabular-nums sm:text-[1.8rem]", tone)}>
              {count
                ? new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-GB").format(value)
                : <MoneyAmount amountFils={value} locale={locale} />}
            </p>
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/45 to-transparent" />
          </article>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <section className="rounded-xl border border-border/75 bg-card p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.13em] text-accent">{copy.attentionKicker}</p>
              <h2 className="mt-1 font-display text-lg font-semibold">{copy.needsAttention}</h2>
            </div>
            <Badge variant="outline">{attentionPlayers.length}</Badge>
          </div>
          {attentionPlayers.length === 0 ? (
            <EmptyState icon={ShieldAlert} title={copy.nothingNeedsAttention} description={copy.everyoneCovered} />
          ) : (
            <div className="divide-y divide-border/70">
              {attentionPlayers.map((player) => (
                <div key={`${player.id}-${player.expiresOn}`} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{player.name}</span>
                      <Badge className={player.monthsOwed > 0 ? "border-amber-300/20 bg-amber-400/10 text-amber-200" : "border-accent/20 bg-accent/10 text-accent"}>
                        {player.monthsOwed > 0 ? copy.monthsOwedCount(player.monthsOwed) : copy.expiresSoon}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{player.squadName} <span className="px-1">·</span> {formatDate(player.expiresOn, locale)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <span className="font-display text-sm font-semibold tabular-nums"><MoneyAmount amountFils={player.outstandingFils} locale={locale} /></span>
                    <Button size="sm" onClick={() => onNavigate(player.squadId, player.id)}>
                      <RefreshCw className="size-3.5" aria-hidden="true" />{copy.renew}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border/75 bg-card p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.13em] text-accent">{copy.unpaidKicker}</p>
              <h2 className="mt-1 font-display text-lg font-semibold">{copy.unpaidPayments}</h2>
            </div>
            <span className="grid size-9 place-items-center rounded-lg bg-amber-400/10 text-amber-200"><FilePlus2 className="size-4" /></span>
          </div>
          {unpaidPayments.length === 0 ? (
            <EmptyState icon={CircleCheck} title={copy.noUnpaidPayments} description={copy.noUnpaidPaymentsDescription} />
          ) : (
            <div className="divide-y divide-border/70">
              {unpaidPayments.map((payment) => (
                <div key={payment.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{payment.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{localizeCategory(payment.category, copy)} <span className="px-1">·</span> {formatDate(payment.occurredOn, locale)}</p>
                  </div>
                  <span className="shrink-0 font-display text-sm font-semibold tabular-nums"><MoneyAmount amountFils={payment.amountFils} locale={locale} /></span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="flex items-start gap-3 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-muted-foreground">
        <Coins className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>{copy.dashboardAccountingNote}</p>
      </div>
    </div>
  );
}

function PlayerPaymentsPanel({ academyId, teamsQuery, activeTeamId, onSelectTeam, locale, copy,
  onCreateTeam, isCreatingTeam, onCreatePlayer, onUpdateBilling, onRenew, onCreateFee, onMarkFeePaid,
  onRefreshPlayerWrites, onUpdateTeamFee, isUpdatingTeamFee, pendingRenewPlayerId, onPendingRenewHandled, isRenewing,
}: {
  academyId: number;
  teamsQuery: FinanceQuery<AcademyFinanceTeam[]>;
  activeTeamId: number | null;
  onSelectTeam: (teamId: number | null) => void;
  locale: string;
  copy: FinanceCopy;
  onCreateTeam: (data: AcademyFinanceTeamInput) => Promise<void>;
  isCreatingTeam: boolean;
  onUpdateTeamFee: (teamId: number, monthlyFeeFils: number) => Promise<void>;
  isUpdatingTeamFee: boolean;
  onCreatePlayer: (teamId: number, data: AcademyFinancePlayerInput) => Promise<void>;
  onUpdateBilling: (teamId: number, playerId: number, data: AcademyFinancePlayerBillingUpdate) => Promise<void>;
  onRenew: (teamId: number, playerId: number, months: number) => Promise<void>;
  onCreateFee: (teamId: number, playerId: number, data: AcademyFinanceFeeInput) => Promise<void>;
  onMarkFeePaid: (teamId: number, playerId: number, feeId: number) => Promise<void>;
  onRefreshPlayerWrites: (teamId: number, playerId?: number) => Promise<void>;
  pendingRenewPlayerId: number | null;
  onPendingRenewHandled: () => void;
  isRenewing: boolean;
}) {
  const { locale: activeLocale } = useTranslation();
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  if (activeTeamId !== null) {
    const selectedTeam = (teamsQuery.data ?? []).find((team) => team.id === activeTeamId);
    if (!selectedTeam) {
      if (teamsQuery.isLoading) return <PanelSkeleton />;
      return <QueryError message={copy.loadError} retry={() => void teamsQuery.refetch()} />;
    }
    return (
      <TeamDetail academyId={academyId} team={selectedTeam} locale={locale} copy={copy}
        onBack={() => onSelectTeam(null)} onCreatePlayer={onCreatePlayer} onUpdateBilling={onUpdateBilling}
        onUpdateTeamFee={onUpdateTeamFee} isUpdatingTeamFee={isUpdatingTeamFee}
        onRenew={onRenew} onCreateFee={onCreateFee} onMarkFeePaid={onMarkFeePaid}
        onRefreshPlayerWrites={onRefreshPlayerWrites} pendingRenewPlayerId={pendingRenewPlayerId}
        onPendingRenewHandled={onPendingRenewHandled} isRenewing={isRenewing} />
    );
  }
  if (teamsQuery.isLoading) return <PanelSkeleton rows={4} />;
  if (teamsQuery.isError) return <QueryError message={copy.loadError} retry={() => void teamsQuery.refetch()} />;
  const teams = teamsQuery.data ?? [];
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.playerPayments}</p>
          <h2 className="mt-1 font-display text-2xl font-bold">{copy.teamsTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.teamsDescription}</p>
        </div>
        <Button onClick={() => setTeamDialogOpen(true)}><Plus className="size-4" />{copy.addTeam}</Button>
      </div>
      {teams.length === 0 ? (
        <EmptyState icon={Users} title={copy.noTeams} description={copy.noTeamsDescription}
          action={<Button onClick={() => setTeamDialogOpen(true)}><Plus className="size-4" />{copy.addTeam}</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => (
            <button key={team.id} type="button" onClick={() => onSelectTeam(team.id)}
              className="group relative overflow-hidden rounded-xl border border-border/80 bg-card p-4 text-start transition-colors hover:border-accent/50 hover:bg-card/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
              <div className="absolute inset-y-0 start-0 w-1 bg-primary/70 transition-colors group-hover:bg-accent" />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="mt-1 truncate font-display text-xl font-semibold">{team.name}</h3>
                </div>
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180" aria-hidden="true" />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/70 pt-3">
                <div>
                  <p className="text-xs text-muted-foreground">{copy.monthlyTeamFee}</p>
                  <p className="mt-1 font-display text-base font-semibold tabular-nums"><MoneyAmount amountFils={team.monthlyFeeFils} locale={locale} /></p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{copy.playersCount}</p>
                  <p className="mt-1 font-display text-base font-semibold tabular-nums">{new Intl.NumberFormat(activeLocale === "ar" ? "ar-JO" : "en-GB").format(team.playerCount)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{copy.behind}</p>
                  <p className={cn("mt-1 font-display text-base font-semibold tabular-nums", team.behindCount > 0 ? "text-amber-200" : "text-accent")}>{new Intl.NumberFormat(activeLocale === "ar" ? "ar-JO" : "en-GB").format(team.behindCount)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{copy.outstanding}</p>
                  <p className="mt-1 font-display text-base font-semibold tabular-nums"><MoneyAmount amountFils={team.outstandingFils} locale={locale} /></p>
                </div>
              </div>
              <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-accent">{copy.openTeam}<ArrowRight className="size-3.5 rtl:rotate-180" /></span>
            </button>
          ))}
        </div>
      )}
      <p className="rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{copy.outstandingExplanation}</p>
      <TeamCreateDialog open={teamDialogOpen} onOpenChange={setTeamDialogOpen} copy={copy} onSave={onCreateTeam} isSaving={isCreatingTeam} />
    </>
  );
}

function TeamCreateDialog({ open, onOpenChange, copy, onSave, isSaving }: {
  open: boolean; onOpenChange: (open: boolean) => void; copy: FinanceCopy;
  onSave: (data: AcademyFinanceTeamInput) => Promise<void>; isSaving: boolean;
}) {
  const [name, setName] = useState("");
  const [fee, setFee] = useState("");
  const [error, setError] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(false);
    const monthlyFeeFils = amountToFils(fee);
    if (!name.trim() || !Number.isFinite(monthlyFeeFils) || monthlyFeeFils < 0) { setError(true); return; }
    try {
      await onSave({ name: name.trim(), monthlyFeeFils });
      setName(""); setFee(""); onOpenChange(false);
    } catch { setError(true); }
  };
  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title={copy.addTeam} description={copy.teamDialogDescription}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="finance-team-name" label={copy.teamName}>
          <Input id="finance-team-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </Field>
        <AmountInput id="finance-team-fee" label={copy.monthlyFee} value={fee} onChange={setFee} min="0" />
        {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button type="submit" disabled={isSaving}>{isSaving ? copy.saving : copy.addTeam}</Button>
        </DialogFooter>
      </form>
    </ModalShell>
  );
}

function TeamFeeEditDialog({ open, onOpenChange, team, copy, onSave, isSaving }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: { id: number; name: string; monthlyFeeFils: number };
  copy: FinanceCopy;
  onSave: (monthlyFeeFils: number) => Promise<void>;
  isSaving: boolean;
}) {
  const [fee, setFee] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    setFee((team.monthlyFeeFils / 1000).toFixed(3));
    setError(false);
  }, [open, team.id, team.monthlyFeeFils]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(false);
    const monthlyFeeFils = amountToFils(fee);
    if (!Number.isFinite(monthlyFeeFils) || monthlyFeeFils < 0) {
      setError(true);
      return;
    }
    try {
      await onSave(monthlyFeeFils);
      onOpenChange(false);
    } catch {
      setError(true);
    }
  };
  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title={`${copy.editTeamFee} · ${team.name}`}
      description={copy.teamFeeEditDescription}>
      <form onSubmit={submit} className="space-y-4">
        <AmountInput id="finance-edit-team-fee" label={copy.monthlyFee} value={fee} onChange={setFee} min="0" />
        {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button type="submit" data-testid="button-save-team-fee" disabled={isSaving}>
            {isSaving ? copy.saving : copy.saveTeamFee}
          </Button>
        </DialogFooter>
      </form>
    </ModalShell>
  );
}

function TeamDetail({ academyId, team, locale, copy, onBack, onCreatePlayer, onUpdateBilling, onRenew,
  onUpdateTeamFee, isUpdatingTeamFee, onCreateFee, onMarkFeePaid, onRefreshPlayerWrites,
  pendingRenewPlayerId, onPendingRenewHandled, isRenewing,
}: {
  academyId: number;
  team: { id: number; name: string; monthlyFeeFils: number };
  locale: string;
  copy: FinanceCopy;
  onBack: () => void;
  onCreatePlayer: (teamId: number, data: AcademyFinancePlayerInput) => Promise<void>;
  onUpdateBilling: (teamId: number, playerId: number, data: AcademyFinancePlayerBillingUpdate) => Promise<void>;
  onUpdateTeamFee: (teamId: number, monthlyFeeFils: number) => Promise<void>;
  isUpdatingTeamFee: boolean;
  onRenew: (teamId: number, playerId: number, months: number) => Promise<void>;
  onCreateFee: (teamId: number, playerId: number, data: AcademyFinanceFeeInput) => Promise<void>;
  onMarkFeePaid: (teamId: number, playerId: number, feeId: number) => Promise<void>;
  onRefreshPlayerWrites: (teamId: number, playerId?: number) => Promise<void>;
  pendingRenewPlayerId: number | null;
  onPendingRenewHandled: () => void;
  isRenewing: boolean;
}) {
  const playersQuery = useListAcademyFinanceTeamPlayers(academyId, team.id, {
    query: { queryKey: getListAcademyFinanceTeamPlayersQueryKey(academyId, team.id) },
  });
  const [createPlayerOpen, setCreatePlayerOpen] = useState(false);
  const [teamFeeDialogOpen, setTeamFeeDialogOpen] = useState(false);
  const [renewingPlayer, setRenewingPlayer] = useState<AcademyFinancePlayer | null>(null);
  const [billingPlayer, setBillingPlayer] = useState<AcademyFinancePlayer | null>(null);
  const [feesPlayer, setFeesPlayer] = useState<AcademyFinancePlayer | null>(null);
  const players = playersQuery.data ?? [];
  const visiblePlayers = useMemo(
    () => players.filter((player) => player.isActive || player.outstandingFils > 0),
    [players],
  );
  const handledRef = useRef(onPendingRenewHandled);
  handledRef.current = onPendingRenewHandled;
  useEffect(() => {
    if (!pendingRenewPlayerId || playersQuery.isLoading || !playersQuery.data) return;
    const player = playersQuery.data.find((item) => item.id === pendingRenewPlayerId);
    if (player) setRenewingPlayer(player);
    handledRef.current();
  }, [pendingRenewPlayerId, playersQuery.data, playersQuery.isLoading]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="mb-2 -ms-2 text-accent">
            <ArrowLeft className="size-4 rtl:rotate-180" />{copy.allTeams}
          </Button>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.playerPayments}</p>
          <h2 className="mt-1 font-display text-2xl font-bold">{team.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{copy.monthlyTeamFee}: <strong className="text-foreground"><MoneyAmount amountFils={team.monthlyFeeFils} locale={locale} /></strong></span>
            <Button type="button" variant="ghost" size="sm" data-testid="button-edit-team-fee"
              className="h-7 px-2 text-accent" onClick={() => setTeamFeeDialogOpen(true)}>
              <Pencil className="size-3.5" aria-hidden="true" />{copy.editTeamFee}
            </Button>
          </div>
        </div>
        <Button onClick={() => setCreatePlayerOpen(true)}><Plus className="size-4" />{copy.addPlayer}</Button>
      </div>
      {playersQuery.isLoading ? <PanelSkeleton rows={4} />
        : playersQuery.isError ? <QueryError message={copy.loadError} retry={() => void playersQuery.refetch()} />
          : visiblePlayers.length === 0 ? (
            <EmptyState icon={Users} title={copy.noPlayers} description={copy.noPlayersDescription}
              action={<Button onClick={() => setCreatePlayerOpen(true)}><Plus className="size-4" />{copy.addPlayer}</Button>} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/75 bg-card">
              <div className="grid grid-cols-1 gap-px bg-border/60 md:grid-cols-2">
                {visiblePlayers.map((player) => (
                  <PlayerCard key={player.id} player={player} locale={locale} copy={copy}
                    onRenew={() => setRenewingPlayer(player)}
                    onEdit={() => setBillingPlayer(player)}
                    onFees={() => setFeesPlayer(player)} />
                ))}
              </div>
            </div>
          )}
      <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/50 p-4 text-sm text-muted-foreground">
        <CircleDollarSign className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>{copy.outstandingExplanation}</p>
      </div>
      <PlayerCreateDialog open={createPlayerOpen} onOpenChange={setCreatePlayerOpen} team={team} locale={locale} copy={copy}
        onSave={(data) => onCreatePlayer(team.id, data)} />
      <PlayerBillingDialog player={billingPlayer} team={team} locale={locale} copy={copy}
        onClose={() => setBillingPlayer(null)} onSave={(playerId, data) => onUpdateBilling(team.id, playerId, data)} />
      <TeamFeeEditDialog open={teamFeeDialogOpen} onOpenChange={setTeamFeeDialogOpen} team={team}
        copy={copy} onSave={(monthlyFeeFils) => onUpdateTeamFee(team.id, monthlyFeeFils)}
        isSaving={isUpdatingTeamFee} />
      <RenewalDialog player={renewingPlayer} team={team} locale={locale} copy={copy}
        onClose={() => setRenewingPlayer(null)} onEditTeamFee={() => {
          setRenewingPlayer(null);
          setTeamFeeDialogOpen(true);
        }}
        onConfirm={(playerId, months) => onRenew(team.id, playerId, months)}
        isSaving={isRenewing} />
      {feesPlayer && (
        <PlayerFeesDialog academyId={academyId} player={feesPlayer} locale={locale} copy={copy}
          onClose={() => setFeesPlayer(null)}
          onCreateFee={(playerId, data) => onCreateFee(team.id, playerId, data)}
          onMarkPaid={(playerId, feeId) => onMarkFeePaid(team.id, playerId, feeId)}
          onRefresh={() => onRefreshPlayerWrites(team.id, feesPlayer.id)} />
      )}
    </div>
  );
}

function PlayerCard({ player, locale, copy, onRenew, onEdit, onFees }: {
  player: AcademyFinancePlayer; locale: string; copy: FinanceCopy;
  onRenew: () => void; onEdit: () => void; onFees: () => void;
}) {
  const expiringSoon = player.subscriptionStatus === "expiring";
  const expired = player.subscriptionStatus === "expired";
  const statusText = player.subscriptionStatus === "no_subscription" ? copy.noSubscription
    : expired ? copy.expired : expiringSoon ? copy.expiring : copy.covered;
  return (
    <article className="flex min-w-0 flex-col justify-between gap-4 bg-card p-4 sm:p-5">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-semibold">{player.name}</h3>
              {!player.isActive && <Badge variant="outline" className="border-border/80 text-muted-foreground">{copy.inactive}</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground"><MoneyAmount amountFils={player.effectiveMonthlyFeeFils} locale={locale} />{copy.perMonth}{player.monthlyDiscountFils > 0 && <span> <span className="px-1">·</span>{copy.discountApplied}</span>}</p>
          </div>
          <Badge className={cn(
            "shrink-0 border",
            expired ? "border-rose-300/20 bg-rose-400/10 text-rose-200"
              : expiringSoon ? "border-amber-300/20 bg-amber-400/10 text-amber-200"
                : "border-accent/20 bg-accent/10 text-accent",
          )}>{statusText}</Badge>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/70 pt-3 text-xs">
          <span className="text-muted-foreground">{copy.expiresOn} <span className="font-medium text-foreground">{formatDate(player.subscriptionExpiresOn, locale)}</span></span>
          {player.monthsOwed > 0 && <span className="text-amber-200">{copy.monthsOwedCount(player.monthsOwed)}</span>}
        </div>
        <div className="mt-3 flex items-end justify-between gap-3">
          <span className="text-xs text-muted-foreground">{copy.outstanding}</span>
          <span className={cn("font-display text-lg font-semibold tabular-nums", player.outstandingFils > 0 ? "text-rose-300" : "text-muted-foreground")}>
            {player.outstandingFils > 0
              ? <MoneyAmount amountFils={player.outstandingFils} locale={locale} />
              : copy.settled}
          </span>
        </div>
        {player.unpaidFeesFils > 0 && (
          <p className="mt-1 text-end text-xs text-muted-foreground">{copy.unpaidExtraFees}: <MoneyAmount amountFils={player.unpaidFeesFils} locale={locale} /></p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRenew}><RefreshCw className="size-3.5" />{copy.renew}</Button>
        <Button size="sm" variant="outline" onClick={onFees}><FilePlus2 className="size-3.5" />{copy.otherFees}</Button>
        <Button size="sm" variant="ghost" className="ms-auto" onClick={onEdit}>{copy.billing}</Button>
      </div>
    </article>
  );
}

function PlayerCreateDialog({ open, onOpenChange, team, locale, copy, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  team: { monthlyFeeFils: number };
  locale: string;
  copy: FinanceCopy;
  onSave: (data: AcademyFinancePlayerInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [discount, setDiscount] = useState("0");
  const [expiry, setExpiry] = useState(shiftDate(ammanToday(), 1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const effectiveFils = Math.max(0, team.monthlyFeeFils - (amountToFils(discount) || 0));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(false);
    const monthlyDiscountFils = amountToFils(discount);
    if (!name.trim() || !expiry || !Number.isFinite(monthlyDiscountFils) || monthlyDiscountFils < 0) { setError(true); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), monthlyDiscountFils, subscriptionExpiresOn: expiry });
      setName(""); setDiscount("0"); setExpiry(shiftDate(ammanToday(), 1)); onOpenChange(false);
    } catch { setError(true); } finally { setSaving(false); }
  };
  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title={copy.addPlayer} description={copy.addPlayerDescription}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="finance-player-name" label={copy.playerName}><Input id="finance-player-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></Field>
        <AmountInput id="finance-player-discount" label={copy.monthlyDiscount} value={discount} onChange={setDiscount} min="0" />
        <Field id="finance-player-expiry" label={copy.subscriptionExpiry} hint={copy.defaultExpiryHint}>
          <Input id="finance-player-expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} required />
        </Field>
        <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm">
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">{copy.teamFee}</span><MoneyAmount amountFils={team.monthlyFeeFils} locale={locale} /></div>
          <div className="mt-1 flex justify-between gap-3"><span className="text-muted-foreground">{copy.effectiveMonthlyFee}</span><span className="font-semibold"><MoneyAmount amountFils={effectiveFils} locale={locale} /></span></div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button type="submit" disabled={saving}>{saving ? copy.saving : copy.addPlayer}</Button>
        </DialogFooter>
      </form>
    </ModalShell>
  );
}

function PlayerBillingDialog({ player, team, locale, copy, onClose, onSave }: {
  player: AcademyFinancePlayer | null; team: { monthlyFeeFils: number }; locale: string; copy: FinanceCopy;
  onClose: () => void;
  onSave: (playerId: number, data: AcademyFinancePlayerBillingUpdate) => Promise<void>;
}) {
  const [discount, setDiscount] = useState("");
  const [expiry, setExpiry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!player) return;
    setDiscount((player.monthlyDiscountFils / 1000).toFixed(3));
    setExpiry(player.subscriptionExpiresOn ?? "");
    setError(false);
  }, [player?.id, player?.monthlyDiscountFils, player?.subscriptionExpiresOn]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!player) return;
    const monthlyDiscountFils = amountToFils(discount);
    if (!Number.isFinite(monthlyDiscountFils) || monthlyDiscountFils < 0) { setError(true); return; }
    setSaving(true); setError(false);
    try {
      await onSave(player.id, { monthlyDiscountFils, subscriptionExpiresOn: expiry || null });
      onClose();
    } catch { setError(true); } finally { setSaving(false); }
  };
  return (
    <ModalShell open={!!player} onOpenChange={(open) => { if (!open) onClose(); }}
      title={player ? `${copy.billing} · ${player.name}` : copy.billing} description={copy.billingDescription}>
      {player && (
        <form onSubmit={submit} className="space-y-4">
          <p className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-sm text-muted-foreground">{copy.teamFee}: <strong className="text-foreground"><MoneyAmount amountFils={team.monthlyFeeFils} locale={locale} /></strong>. {copy.discountExplanation}</p>
          <AmountInput id="finance-billing-discount" label={copy.monthlyDiscount} value={discount} onChange={setDiscount} min="0" />
          <Field id="finance-billing-expiry" label={copy.subscriptionExpiry} hint={copy.billingExpiryHint}>
            <Input id="finance-billing-expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          </Field>
          <div className="flex justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{copy.effectiveMonthlyFee}</span>
            <strong><MoneyAmount amountFils={Math.max(0, team.monthlyFeeFils - amountToFils(discount))} locale={locale} /></strong>
          </div>
          {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" disabled={saving}>{saving ? copy.saving : copy.saveBilling}</Button>
          </DialogFooter>
        </form>
      )}
    </ModalShell>
  );
}

function RenewalDialog({ player, team, locale, copy, onClose, onEditTeamFee, onConfirm, isSaving }: {
  player: AcademyFinancePlayer | null; team: { monthlyFeeFils: number }; locale: string; copy: FinanceCopy;
  onClose: () => void;
  onEditTeamFee: () => void;
  onConfirm: (playerId: number, months: number) => Promise<void>;
  isSaving: boolean;
}) {
  const [months, setMonths] = useState(1);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (player) {
      setMonths(Math.max(1, player.monthsOwed));
      setError(false);
    }
  }, [player?.id, player?.monthsOwed]);
  const effectiveMonthlyFee = player ? Math.max(0, team.monthlyFeeFils - player.monthlyDiscountFils) : 0;
  const total = effectiveMonthlyFee * months;
  const currentExpiry = player?.subscriptionExpiresOn ?? ammanToday();
  const projectedExpiry = shiftDate(currentExpiry, months);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!player || effectiveMonthlyFee <= 0 || months < 1 || !Number.isInteger(months)) { setError(true); return; }
    setError(false);
    try { await onConfirm(player.id, months); onClose(); }
    catch { setError(true); }
  };
  return (
    <ModalShell open={!!player} onOpenChange={(open) => { if (!open) onClose(); }}
      title={player ? `${copy.renewSubscription} · ${player.name}` : copy.renewSubscription}
      description={copy.renewDescription}>
      {player && (
        <form onSubmit={submit} className="space-y-4">
          {!player.subscriptionExpiresOn && effectiveMonthlyFee > 0 && (
            <div role="status" className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-sm text-muted-foreground">
              {copy.startingSubscription(formatDate(projectedExpiry, locale))}
            </div>
          )}
          {player.monthsOwed > 0 && (
            <div className="flex gap-3 rounded-lg border border-amber-300/20 bg-amber-400/10 p-3 text-sm text-amber-100">
              <Clock3 className="mt-0.5 size-4 shrink-0" />
              <p>{copy.renewalOwedHint(player.monthsOwed, formatDate(player.subscriptionExpiresOn, locale))}</p>
            </div>
          )}
          {effectiveMonthlyFee <= 0 ? (
            <div role="alert" className="space-y-3 rounded-lg border border-amber-300/20 bg-amber-400/10 p-3 text-sm text-amber-100">
              <p>{team.monthlyFeeFils <= 0 ? copy.teamFeeUnsetRenewal : copy.zeroEffectiveFeeRenewal}</p>
              <Button type="button" variant="outline" onClick={onEditTeamFee} disabled={isSaving}>
                <Pencil className="size-3.5" aria-hidden="true" />{copy.editTeamFee}
              </Button>
            </div>
          ) : (
            <>
              <Field id="finance-renew-months" label={copy.monthsToPurchase}>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="icon" aria-label={copy.decreaseMonths} disabled={months <= 1 || isSaving} onClick={() => setMonths((value) => Math.max(1, value - 1))}>−</Button>
                  <Input id="finance-renew-months" type="number" min="1" step="1" value={months} onChange={(event) => setMonths(Math.max(1, Number(event.target.value) || 1))} className="max-w-28 text-center tabular-nums" />
                  <Button type="button" variant="outline" size="icon" aria-label={copy.increaseMonths} disabled={isSaving} onClick={() => setMonths((value) => value + 1)}>+</Button>
                  <span className="text-sm text-muted-foreground">{copy.monthUnit}</span>
                </div>
              </Field>
              <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">{copy.monthsToPurchase}</span>
                  <span><bdi dir={locale === "ar" ? "rtl" : "ltr"}>{new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-GB").format(months)}</bdi> × <MoneyAmount amountFils={effectiveMonthlyFee} locale={locale} /></span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border/60 pt-2 text-sm"><span className="text-muted-foreground">{copy.newExpiry}</span><strong><bdi dir="auto">{formatDate(projectedExpiry, locale)}</bdi></strong></div>
                <div className="flex items-end justify-between gap-3 border-t border-border/60 pt-2">
                  <span className="text-sm text-muted-foreground">{copy.paymentAmount}</span>
                  <strong className="font-display text-xl tabular-nums text-primary"><MoneyAmount amountFils={total} locale={locale} /></strong>
                </div>
              </div>
            </>
          )}
          {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{copy.cancel}</Button>
            {effectiveMonthlyFee > 0 && (
              <Button type="submit" disabled={isSaving}>{isSaving ? copy.recording : copy.recordPayment}</Button>
            )}
          </DialogFooter>
        </form>
      )}
    </ModalShell>
  );
}

function PlayerFeesDialog({ academyId, player, locale, copy, onClose, onCreateFee, onMarkPaid, onRefresh }: {
  academyId: number;
  player: AcademyFinancePlayer;
  locale: string;
  copy: FinanceCopy;
  onClose: () => void;
  onCreateFee: (playerId: number, data: AcademyFinanceFeeInput) => Promise<void>;
  onMarkPaid: (playerId: number, feeId: number) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const feeQuery = useListAcademyFinancePlayerFees(academyId, player.id, {
    query: { queryKey: getListAcademyFinancePlayerFeesQueryKey(academyId, player.id) },
  });
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyFeeId, setBusyFeeId] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const addFee = async (event: FormEvent) => {
    event.preventDefault(); setError(false);
    const amountFils = amountToFils(amount);
    if (!label.trim() || !Number.isFinite(amountFils) || amountFils < 1) { setError(true); return; }
    setSaving(true);
    try {
      await onCreateFee(player.id, { label: label.trim(), amountFils });
      await onRefresh(); setLabel(""); setAmount("");
    } catch { setError(true); } finally { setSaving(false); }
  };
  const markPaid = async (feeId: number) => {
    setBusyFeeId(feeId); setError(false);
    try { await onMarkPaid(player.id, feeId); await onRefresh(); }
    catch { setError(true); } finally { setBusyFeeId(null); }
  };
  const fees = feeQuery.data ?? [];
  return (
    <ModalShell open onOpenChange={(open) => { if (!open) onClose(); }}
      title={`${copy.otherFees} · ${player.name}`} description={copy.feesDescription}>
      {feeQuery.isLoading ? <PanelSkeleton rows={2} />
        : feeQuery.isError ? <QueryError message={copy.loadError} retry={() => void feeQuery.refetch()} />
          : (
            <div className="space-y-4">
              {fees.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">{copy.noFees}</div>
              ) : (
                <div className="max-h-52 divide-y divide-border/70 overflow-y-auto">
                  {fees.map((fee) => (
                    <div key={fee.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{fee.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(fee.dueDate, locale)}{fee.note ? ` · ${fee.note}` : ""}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-display text-sm font-semibold tabular-nums"><MoneyAmount amountFils={fee.amountFils} locale={locale} /></span>
                        {fee.status === "paid" ? <Badge className="border-accent/20 bg-accent/10 text-accent"><Check className="me-1 size-3" />{copy.paid}</Badge>
                          : <Button size="sm" disabled={busyFeeId === fee.id} onClick={() => void markPaid(fee.id)}>{busyFeeId === fee.id ? copy.saving : copy.markPaid}</Button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={addFee} className="space-y-3 border-t border-border/70 pt-4">
                <p className="text-sm font-semibold">{copy.addOneOffFee}</p>
                <Field id="finance-fee-label" label={copy.feeLabel}><Input id="finance-fee-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} required /></Field>
                <AmountInput id="finance-fee-amount" label={copy.amount} value={amount} onChange={setAmount} />
                {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={onClose}>{copy.close}</Button>
                  <Button type="submit" disabled={saving}>{saving ? copy.saving : copy.addFee}</Button>
                </div>
              </form>
            </div>
          )}
    </ModalShell>
  );
}

function SalariesPanel({ staffQuery, locale, copy, onSave, onPay, isSaving, isPaying }: {
  staffQuery: FinanceQuery<AcademyFinanceStaff[]>;
  locale: string; copy: FinanceCopy;
  onSave: (staffId: number | null, data: AcademyFinanceStaffInput | AcademyFinanceStaffUpdate) => Promise<void>;
  onPay: (staffId: number) => Promise<void>;
  isSaving: boolean; isPaying: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AcademyFinanceStaff | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState(false);
  if (staffQuery.isLoading) return <PanelSkeleton rows={4} />;
  if (staffQuery.isError) return <QueryError message={copy.loadError} retry={() => void staffQuery.refetch()} />;
  const staff = staffQuery.data ?? [];
  const openForm = (member?: AcademyFinanceStaff) => { setEditing(member ?? null); setDialogOpen(true); };
  const pay = async (id: number) => {
    setBusyId(id); setActionError(false);
    try { await onPay(id); } catch { setActionError(true); } finally { setBusyId(null); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.staffCosts}</p>
          <h2 className="mt-1 font-display text-2xl font-bold">{copy.salaries}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.salariesDescription}</p>
        </div>
        <Button onClick={() => openForm()}><Plus className="size-4" />{copy.addStaff}</Button>
      </div>
      {actionError && <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm"><CircleAlert className="size-4 text-destructive-foreground" />{copy.actionFailed}</div>}
      {staff.length === 0 ? (
        <EmptyState icon={Wallet} title={copy.noStaff} description={copy.noStaffDescription}
          action={<Button onClick={() => openForm()}><Plus className="size-4" />{copy.addStaff}</Button>} />
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/75 bg-card">
          {staff.map((member) => {
            const isDue = member.nextSalaryDate <= ammanToday();
            const isContractSoon = dateDistanceDays(member.contractEndDate, ammanToday()) <= 30;
            return (
              <article key={member.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Users className="size-5" /></span>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{member.name}</h3>
                    <p className="mt-0.5 text-sm text-muted-foreground">{member.role} <span className="px-1">·</span> <MoneyAmount amountFils={member.monthlySalaryFils} locale={locale} />{copy.perMonth}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className={cn("inline-flex items-center gap-1", isDue ? "text-amber-200" : "text-muted-foreground")}><CalendarDays className="size-3.5" />{copy.nextSalary}: {formatDate(member.nextSalaryDate, locale)}</span>
                      <span className={cn("inline-flex items-center gap-1", isContractSoon ? "text-amber-200" : "text-muted-foreground")}><Clock3 className="size-3.5" />{copy.contractEnds}: {formatDate(member.contractEndDate, locale)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 sm:shrink-0">
                  <Button size="sm" onClick={() => void pay(member.id)} disabled={isPaying || busyId === member.id}>
                    <CircleDollarSign className="size-3.5" />{busyId === member.id ? copy.processing : copy.paySalary}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openForm(member)}>{copy.edit}</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="flex items-start gap-3 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm text-muted-foreground">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <p>{copy.salaryFlowNote}</p>
      </div>
      <StaffDialog open={dialogOpen} onOpenChange={setDialogOpen} member={editing} copy={copy} onSave={onSave} isSaving={isSaving} />
    </div>
  );
}

function dateDistanceDays(date: string, today: string): number {
  return Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

function StaffDialog({ open, onOpenChange, member, copy, onSave, isSaving }: {
  open: boolean; onOpenChange: (open: boolean) => void; member: AcademyFinanceStaff | null; copy: FinanceCopy;
  onSave: (staffId: number | null, data: AcademyFinanceStaffInput | AcademyFinanceStaffUpdate) => Promise<void>;
  isSaving: boolean;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [salary, setSalary] = useState("");
  const [nextSalary, setNextSalary] = useState("");
  const [contractEnd, setContractEnd] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(member?.name ?? "");
    setRole(member?.role ?? "");
    setSalary(member ? (member.monthlySalaryFils / 1000).toFixed(3) : "");
    setNextSalary(member?.nextSalaryDate ?? shiftDate(ammanToday(), 1));
    setContractEnd(member?.contractEndDate ?? shiftDate(ammanToday(), 12));
    setError(false);
  }, [open, member?.id]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const monthlySalaryFils = amountToFils(salary);
    if (!name.trim() || !role.trim() || monthlySalaryFils < 1 || !nextSalary || !contractEnd) { setError(true); return; }
    setError(false);
    const body: AcademyFinanceStaffInput = { name: name.trim(), role: role.trim(), monthlySalaryFils, nextSalaryDate: nextSalary, contractEndDate: contractEnd };
    try { await onSave(member?.id ?? null, body); onOpenChange(false); }
    catch { setError(true); }
  };
  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title={member ? copy.editStaff : copy.addStaff} description={copy.staffDialogDescription}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="finance-staff-name" label={copy.staffName}><Input id="finance-staff-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></Field>
        <Field id="finance-staff-role" label={copy.role}><Input id="finance-staff-role" value={role} onChange={(event) => setRole(event.target.value)} maxLength={120} required /></Field>
        <AmountInput id="finance-staff-salary" label={copy.monthlySalary} value={salary} onChange={setSalary} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="finance-next-salary" label={copy.nextSalary}><Input id="finance-next-salary" type="date" value={nextSalary} onChange={(event) => setNextSalary(event.target.value)} required /></Field>
          <Field id="finance-contract-end" label={copy.contractEnd}><Input id="finance-contract-end" type="date" value={contractEnd} onChange={(event) => setContractEnd(event.target.value)} required /></Field>
        </div>
        {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button type="submit" disabled={isSaving}>{isSaving ? copy.saving : copy.saveStaff}</Button>
        </DialogFooter>
      </form>
    </ModalShell>
  );
}

function OtherPaymentsPanel({ paymentsQuery, categoriesQuery, locale, copy, onCreatePayment, onMarkPaid, onRepeat,
  onCreateCategory, isSaving, isMarkingPaid, isRepeating, isSavingCategory,
}: {
  paymentsQuery: FinanceQuery<AcademyFinanceOtherPaymentList>;
  categoriesQuery: FinanceQuery<AcademyFinanceCategoryList>;
  locale: string; copy: FinanceCopy;
  onCreatePayment: (data: AcademyFinanceOtherPaymentInput) => Promise<void>;
  onMarkPaid: (paymentId: number) => Promise<void>;
  onRepeat: (paymentId: number) => Promise<void>;
  onCreateCategory: (name: string) => Promise<void>;
  isSaving: boolean; isMarkingPaid: boolean; isRepeating: boolean; isSavingCategory: boolean;
}) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<"paid" | "unpaid">("paid");
  const [newCategory, setNewCategory] = useState("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [categorySaving, setCategorySaving] = useState(false);
  const [busyPaymentId, setBusyPaymentId] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const categories = categoriesQuery.data;
  const categoryChoices = categories ? [...categories.builtIn, ...categories.custom.map((item) => item.name)] : [];
  const selectedCategory = category || categoryChoices[0] || "";
  useEffect(() => {
    if (!category && categoryChoices.length) setCategory(categoryChoices[0]);
  }, [categoryChoices.join("|"), category]);

  const submitPayment = async (event: FormEvent) => {
    event.preventDefault(); setError(false);
    const amountFils = amountToFils(amount);
    if (!label.trim() || !selectedCategory || !Number.isFinite(amountFils) || amountFils < 1) { setError(true); return; }
    setSaving(true);
    try {
      await onCreatePayment({ category: selectedCategory, label: label.trim(), amountFils, status });
      setLabel(""); setAmount("");
    } catch { setError(true); } finally { setSaving(false); }
  };
  const addCategory = async () => {
    const value = newCategory.trim();
    if (!value || categoryChoices.some((item) => item.toLocaleLowerCase(locale) === value.toLocaleLowerCase(locale))) { setError(true); return; }
    setCategorySaving(true); setError(false);
    try {
      await onCreateCategory(value);
      setCategory(value); setNewCategory(""); setShowCategoryInput(false);
    } catch { setError(true); } finally { setCategorySaving(false); }
  };
  const markPaid = async (paymentId: number) => {
    setBusyPaymentId(paymentId); setActionError(false);
    try { await onMarkPaid(paymentId); } catch { setActionError(true); } finally { setBusyPaymentId(null); }
  };
  const repeat = async (paymentId: number) => {
    setBusyPaymentId(paymentId); setActionError(false);
    try { await onRepeat(paymentId); } catch { setActionError(true); } finally { setBusyPaymentId(null); }
  };
  const builtInName = (name: string) => localizeCategory(name, copy);
  if (paymentsQuery.isLoading || categoriesQuery.isLoading) return <PanelSkeleton rows={4} />;
  if (paymentsQuery.isError || categoriesQuery.isError) {
    return <QueryError message={copy.loadError} retry={() => { void paymentsQuery.refetch(); void categoriesQuery.refetch(); }} />;
  }
  const payments = paymentsQuery.data?.payments ?? [];
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="rounded-xl border border-border/75 bg-card p-4 sm:p-5">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.cashOut}</p>
            <h2 className="mt-1 font-display text-xl font-bold">{copy.addPayment}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{copy.addPaymentDescription}</p>
          </div>
          <form onSubmit={submitPayment} className="space-y-4">
            <div className="space-y-2">
              <Label>{copy.category}</Label>
              {categoriesQuery.data?.builtIn.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {categoriesQuery.data.builtIn.map((item) => (
                    <button key={item} type="button" onClick={() => setCategory(item)}
                      className={cn("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                        selectedCategory === item ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:border-accent/50 hover:text-foreground")}>
                      {builtInName(item)}
                    </button>
                  ))}
                  {categoriesQuery.data.custom.map((item) => (
                    <button key={item.id} type="button" onClick={() => setCategory(item.name)}
                      className={cn("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                        selectedCategory === item.name ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:border-accent/50 hover:text-foreground")}>
                      {item.name}
                    </button>
                  ))}
                </div>
              ) : <p className="text-sm text-muted-foreground">{copy.noCategories}</p>}
              {!showCategoryInput ? (
                <Button type="button" size="sm" variant="ghost" className="px-2 text-accent" onClick={() => setShowCategoryInput(true)}>
                  <Plus className="size-3.5" />{copy.addCategory}
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Input aria-label={copy.categoryName} value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder={copy.categoryName} maxLength={120} required />
                  <Button type="button" size="sm" disabled={categorySaving || isSavingCategory} onClick={() => void addCategory()}>{categorySaving || isSavingCategory ? copy.saving : copy.saveCategory}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setShowCategoryInput(false); setNewCategory(""); setError(false); }}>{copy.cancel}</Button>
                </div>
              )}
            </div>
            <Field id="finance-payment-label" label={copy.paymentDescription}><Input id="finance-payment-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={240} required placeholder={copy.paymentLabelPlaceholder} /></Field>
            <AmountInput id="finance-payment-amount" label={copy.amount} value={amount} onChange={setAmount} />
            <div className="space-y-1.5">
              <Label>{copy.status}</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as "paid" | "unpaid")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">{copy.paid}</SelectItem>
                  <SelectItem value="unpaid">{copy.unpaid}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error && <p role="alert" className="text-sm text-destructive-foreground">{copy.formError}</p>}
            <Button type="submit" className="w-full" disabled={saving || isSaving}>{saving || isSaving ? copy.saving : copy.savePayment}</Button>
          </form>
        </section>

        <section className="overflow-hidden rounded-xl border border-border/75 bg-card">
          <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{copy.monthlyLedger}</p>
              <h2 className="mt-1 font-display text-xl font-bold">{formatMonth(paymentsQuery.data?.month ?? ammanToday().slice(0, 7), locale)}</h2>
            </div>
            <div className="flex gap-4 text-xs">
              <div><p className="text-muted-foreground">{copy.paidTotal}</p><p className="mt-1 font-display text-sm font-semibold text-accent"><MoneyAmount amountFils={paymentsQuery.data?.paidTotalFils ?? 0} locale={locale} /></p></div>
              <div><p className="text-muted-foreground">{copy.unpaidTotal}</p><p className="mt-1 font-display text-sm font-semibold text-amber-200"><MoneyAmount amountFils={paymentsQuery.data?.unpaidTotalFils ?? 0} locale={locale} /></p></div>
            </div>
          </div>
          {actionError && <div role="alert" className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm"><CircleAlert className="size-4 text-destructive-foreground" />{copy.actionFailed}</div>}
          {payments.length === 0 ? (
            <div className="p-4 sm:p-5"><EmptyState icon={CreditCard} title={copy.noPayments} description={copy.noPaymentsDescription} /></div>
          ) : (
            <div className="divide-y divide-border/70">
              {payments.map((payment) => (
                <article key={payment.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="max-w-full truncate font-medium">{payment.label}</h3>
                      <Badge className={payment.status === "paid" ? "border-accent/20 bg-accent/10 text-accent" : "border-amber-300/20 bg-amber-400/10 text-amber-200"}>
                        {payment.status === "paid" ? copy.paid : copy.unpaid}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{builtInName(payment.category)} <span className="px-1">·</span> {formatDate(payment.occurredOn, locale)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:shrink-0 sm:justify-end">
                    <span className="font-display text-base font-semibold tabular-nums"><MoneyAmount amountFils={payment.amountFils} locale={locale} /></span>
                    <div className="flex gap-2">
                      {payment.status === "unpaid" && (
                        <Button size="sm" disabled={isMarkingPaid || busyPaymentId === payment.id} onClick={() => void markPaid(payment.id)}>
                          <Check className="size-3.5" />{copy.markPaid}
                        </Button>
                      )}
                      <Button size="icon" variant="outline" className="size-8" aria-label={copy.repeatPayment} title={copy.repeatPayment}
                        disabled={isRepeating || busyPaymentId === payment.id} onClick={() => void repeat(payment.id)}>
                        <RefreshCw className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      <p className="rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{copy.repeatPaymentHint}</p>
    </div>
  );
}
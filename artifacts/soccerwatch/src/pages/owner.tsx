import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetOwnerFieldAvailabilityQueryKey,
  getGetOwnerFieldLedgerQueryKey,
  getListOwnerFieldRequestsQueryKey,
  getListOwnerFieldsQueryKey,
  useCancelOwnerRequest,
  useCreateOwnerFieldRequest,
  useCreateOwnerRequestLink,
  useGetOwnerFieldAvailability,
  useGetOwnerFieldLedger,
  useListOwnerFieldRequests,
  useListOwnerFields,
  useRevokeOwnerRequestLink,
  type OwnerAvailability,
  type OwnerField,
  type OwnerLedger,
  type OwnerRequest,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  Film,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
} from "lucide-react";
import { useLocation } from "wouter";
import { HlsPlayer } from "@/components/HlsPlayer";
import { VarPlayer } from "@/components/var-player/VarPlayer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "@/i18n";
import type { Strings } from "@/i18n/strings";
import { useToast } from "@/hooks/use-toast";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type OwnerCopy = {
  title: string;
  subtitle: string;
  request: string;
  myFootage: string;
  billing: string;
  field: string;
  noFields: string;
  chooseField: string;
  pastFootage: string;
  bookMatch: string;
  date: string;
  today: string;
  from: string;
  to: string;
  recordedHours: string;
  availabilityLoading: string;
  noRecordedHours: string;
  noAvailability: string;
  futureBookingNote: string;
  duration: string;
  cost: string;
  currency: string;
  hours: string;
  minutes: string;
  requestFootage: string;
  submitting: string;
  required: string;
  tooShort: string;
  tooLong: string;
  invalidWindow: string;
  pastDateOnly: string;
  bookingDateRange: string;
  unavailableTime: string;
  requestCreated: string;
  requestCreatedDesc: string;
  requestFailed: string;
  loading: string;
  retry: string;
  emptyFootage: string;
  emptyFootageDesc: string;
  refresh: string;
  preview: string;
  hidePreview: string;
  copyLink: string;
  copied: string;
  whatsapp: string;
  revoke: string;
  newLink: string;
  cancel: string;
  confirmCancel: string;
  keepRequest: string;
  cancelPrompt: string;
  status: Record<string, string>;
  statusMessage: Record<string, string>;
  unknownStatus: string;
  active: string;
  progress: string;
  readyAt: string;
  linkExpires: string;
  playerLabel: string;
  charged: string;
  whatsappMessage: string;
  billingNote: string;
  footageLabel: string;
  paymentLabel: string;
  billingTitle: string;
  totalCharged: string;
  paid: string;
  due: string;
  charges: string;
  payments: string;
  noCharges: string;
  noPayments: string;
  paymentMethod: string;
  amount: string;
  secureLink: string;
  linkRevoked: string;
  linkCreated: string;
  actionFailed: string;
  requestCancelled: string;
  chargeDisclaimer: string;
};

const ownerCopy = (t: Strings): OwnerCopy =>
  (t as unknown as { owner: OwnerCopy }).owner;

const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
});

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function ammanDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const candidate = error as {
      data?: { error?: unknown };
      message?: unknown;
    };
    if (typeof candidate.data?.error === "string") return candidate.data.error;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return fallback;
}

function formatJod(fils: number): string {
  return (fils / 1000).toFixed(3).replace(/\.?0+$/, "");
}

function formatDuration(seconds: number, copy: OwnerCopy): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}${copy.minutes}`;
  return remainder ? `${hours}${copy.hours} ${remainder}${copy.minutes}` : `${hours}${copy.hours}`;
}

function statusKey(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "preparing") return "preparing";
  if (normalized === "running") return "running";
  return normalized;
}

function isActiveStatus(status: string): boolean {
  return ["scheduled", "recording", "queued", "running", "preparing"].includes(
    statusKey(status),
  );
}

function availabilityHours(availability: OwnerAvailability | undefined): Set<number> {
  const values = availability?.hours;
  if (!Array.isArray(values)) return new Set();
  return new Set(
    values.flatMap((entry) => {
      if (typeof entry === "number") return [entry];
      if (typeof entry === "string") {
        const value = Number.parseInt(entry.slice(0, 2), 10);
        return Number.isFinite(value) ? [value] : [];
      }
      if (entry && typeof entry === "object") {
        const value = (entry as { hour?: unknown; available?: unknown }).hour;
        const hour =
          typeof value === "number"
            ? value
            : Number.parseInt(String(value ?? "").slice(0, 2), 10);
        const available = (entry as { available?: unknown }).available;
        return Number.isFinite(hour) && available !== false ? [hour] : [];
      }
      return [];
    }),
  );
}

function friendlyLocalDate(value: string, locale: string): string {
  const parsed = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function isScheduledSoon(request: OwnerRequest): boolean {
  if (statusKey(request.status) !== "scheduled") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(request.startLocal);
  if (!match) return false;
  const start = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 3,
    Number(match[5]),
  );
  return start - Date.now() < 2 * 60 * 60 * 1000;
}

function requestSort(a: OwnerRequest, b: OwnerRequest): number {
  return b.startLocal.localeCompare(a.startLocal);
}

export default function Owner() {
  const { t, locale } = useTranslation();
  const copy = ownerCopy(t);
  const { isGuest, isLoading: authLoading, isSignedIn } = useAuth();
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"request" | "footage" | "billing">("request");
  const [requestMode, setRequestMode] = useState<"past" | "book">("past");
  const [selectedFieldId, setSelectedFieldId] = useState<number | null>(null);
  const [date, setDate] = useState(ammanDate);
  const [from, setFrom] = useState("18:00");
  const [to, setTo] = useState("19:00");
  const [formError, setFormError] = useState("");
  const [serverError, setServerError] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);

  useEffect(() => {
    if (!authLoading && !isSignedIn) setLocation("/sign-in");
  }, [authLoading, isSignedIn, setLocation]);

  const fieldsQuery = useListOwnerFields({
    query: {
      enabled: isSignedIn && !isGuest,
      queryKey: getListOwnerFieldsQueryKey(),
    },
  });
  const fields = fieldsQuery.data ?? [];
  const fieldId = selectedFieldId ?? fields[0]?.id ?? 0;
  const selectedField = fields.find((field) => field.id === fieldId) ?? fields[0];

  useEffect(() => {
    if (fields.length && !fields.some((field) => field.id === selectedFieldId)) {
      setSelectedFieldId(fields[0].id);
    }
  }, [fields, selectedFieldId]);

  const availabilityQuery = useGetOwnerFieldAvailability(fieldId, date, {
    query: {
      enabled: isSignedIn && !isGuest && requestMode === "past" && fieldId > 0 && Boolean(date),
      queryKey: getGetOwnerFieldAvailabilityQueryKey(fieldId, date),
    },
  });
  const hours = useMemo(
    () => availabilityHours(availabilityQuery.data),
    [availabilityQuery.data],
  );

  const requestsQuery = useListOwnerFieldRequests(fieldId, {
    query: {
      enabled: isSignedIn && !isGuest && fieldId > 0,
      queryKey: getListOwnerFieldRequestsQueryKey(fieldId),
      refetchInterval: (query) => {
        const requestData = query.state.data as OwnerRequest[] | undefined;
        const fast = requestData?.some(
          (request) =>
            isActiveStatus(request.status) && (statusKey(request.status) !== "scheduled" || isScheduledSoon(request)),
        );
        return fast ? 5_000 : 60_000;
      },
    },
  });
  const requests = useMemo(
    () => [...(requestsQuery.data ?? [])].sort(requestSort),
    [requestsQuery.data],
  );

  const ledgerQuery = useGetOwnerFieldLedger(fieldId, {
    query: {
      enabled: isSignedIn && !isGuest && fieldId > 0 && tab === "billing",
      queryKey: getGetOwnerFieldLedgerQueryKey(fieldId),
      refetchInterval: 60_000,
    },
  });

  const createRequest = useCreateOwnerFieldRequest();
  const cancelRequest = useCancelOwnerRequest();
  const revokeLink = useRevokeOwnerRequestLink();
  const createLink = useCreateOwnerRequestLink();

  const durationMinutes = Math.max(0, timeToMinutes(to) - timeToMinutes(from));
  const billableHours = Math.ceil(durationMinutes / 60);
  const amountFils = billableHours * 1000;
  const today = ammanDate();
  const maxBookDate = addDays(today, 14);
  const recordingCount = requests.filter((request) =>
    ["recording", "queued", "running", "preparing"].includes(statusKey(request.status)),
  ).length;
  const readyCount = requests.filter((request) =>
    ["ready", "partial"].includes(statusKey(request.status)),
  ).length;

  const selectField = (value: string) => {
    const next = Number(value);
    setSelectedFieldId(Number.isFinite(next) ? next : null);
    setPreviewId(null);
  };

  const selectHour = (hour: number) => {
    const nextFrom = `${hour.toString().padStart(2, "0")}:00`;
    const nextTo = `${Math.min(hour + 1, 24).toString().padStart(2, "0")}:00`;
    setFrom(nextFrom);
    setTo(nextTo === "24:00" ? "23:45" : nextTo);
    setFormError("");
  };

  const submitRequest = () => {
    setFormError("");
    setServerError("");
    if (!fieldId) {
      setFormError(copy.chooseField);
      return;
    }
    if (!date || !from || !to) {
      setFormError(copy.required);
      return;
    }
    if (from >= to) {
      setFormError(copy.invalidWindow);
      return;
    }
    if (durationMinutes < 15) {
      setFormError(copy.tooShort);
      return;
    }
    if (durationMinutes > 4 * 60) {
      setFormError(copy.tooLong);
      return;
    }
    if (requestMode === "past" && date > today) {
      setFormError(copy.pastDateOnly);
      return;
    }
    if (requestMode === "book" && (date < today || date > maxBookDate)) {
      setFormError(copy.bookingDateRange);
      return;
    }
    if (requestMode === "past" && date === today) {
      const now = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Amman",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (timeToMinutes(to) > timeToMinutes(now) - 10) {
        setFormError(copy.unavailableTime);
        return;
      }
    }
    if (requestMode === "past" && hours.size > 0) {
      const firstHour = Math.floor(timeToMinutes(from) / 60);
      const lastHour = Math.ceil(timeToMinutes(to) / 60);
      for (let hour = firstHour; hour < lastHour; hour += 1) {
        if (!hours.has(hour)) {
          setFormError(copy.unavailableTime);
          return;
        }
      }
    }
    const startLocal = `${date} ${from}`;
    const endLocal = `${date} ${to}`;
    createRequest.mutate(
      { fieldId, data: { startLocal, endLocal } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListOwnerFieldRequestsQueryKey(fieldId),
          });
          setTab("footage");
          setServerError("");
          toast({
            title: copy.requestCreated,
            description: copy.requestCreatedDesc,
          });
        },
        onError: (error) => {
          setServerError(getErrorMessage(error, copy.requestFailed));
        },
      },
    );
  };

  const runCancel = (id: number) => {
    cancelRequest.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmingCancel(null);
          queryClient.invalidateQueries({
            queryKey: getListOwnerFieldRequestsQueryKey(fieldId),
          });
          toast({ title: copy.requestCancelled });
        },
        onError: (error) =>
          toast({
            title: copy.actionFailed,
            description: getErrorMessage(error, copy.requestFailed),
            variant: "destructive",
          }),
      },
    );
  };

  const runLinkAction = (request: OwnerRequest, action: "revoke" | "new") => {
    const mutation = action === "revoke" ? revokeLink : createLink;
    mutation.mutate(
      { id: request.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListOwnerFieldRequestsQueryKey(fieldId),
          });
          toast({ title: action === "revoke" ? copy.linkRevoked : copy.linkCreated });
        },
        onError: (error) =>
          toast({
            title: copy.actionFailed,
            description: getErrorMessage(error, copy.requestFailed),
            variant: "destructive",
          }),
      },
    );
  };

  const copyShareLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: copy.copied });
    } catch {
      toast({ title: copy.actionFailed, variant: "destructive" });
    }
  };

  const retryRequest = (request: OwnerRequest) => {
    createRequest.mutate(
      {
        fieldId,
        data: { startLocal: request.startLocal, endLocal: request.endLocal },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListOwnerFieldRequestsQueryKey(fieldId),
          });
          toast({ title: copy.requestCreated });
        },
        onError: (error) =>
          toast({
            title: copy.actionFailed,
            description: getErrorMessage(error, copy.requestFailed),
            variant: "destructive",
          }),
      },
    );
  };

  if (authLoading) {
    return (
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-28 pt-3" data-testid="page-owner-loading">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-white/[0.08]" data-testid="skeleton-owner-title" />
        <div className="h-28 animate-pulse rounded-2xl bg-white/[0.06]" data-testid="skeleton-owner-summary" />
        <div className="h-72 animate-pulse rounded-2xl bg-white/[0.06]" data-testid="skeleton-owner-content" />
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center px-6 pb-24 text-center" data-testid="page-owner-sign-in">
        <LoaderCircle className="h-6 w-6 animate-spin text-primary" aria-label={copy.loading} />
      </main>
    );
  }

  if (!fieldsQuery.isLoading && !fields.length) {
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 pb-24 text-center" data-testid="page-owner-empty">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <MapPin className="h-6 w-6" aria-hidden="true" />
        </div>
        <p className="max-w-xs text-sm leading-6 text-foreground" data-testid="text-owner-empty-desc">{copy.noFields}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-28 pt-2 sm:px-5" data-testid="page-owner" data-route={location}>
      <section className="rounded-[26px] border border-white/[0.08] bg-[linear-gradient(145deg,rgba(212,255,79,.13),rgba(20,27,43,.45)_52%,rgba(123,92,255,.10))] p-4 sm:p-5" data-testid="owner-header">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary" data-testid="text-owner-eyebrow">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_0_4px_rgba(212,255,79,.12)]" />
              {copy.active}
            </p>
            <h1 className="font-display text-[clamp(27px,8vw,40px)] font-semibold leading-[0.95] tracking-[-0.05em] text-foreground" data-testid="text-owner-title">{copy.title}</h1>
            <p className="mt-2 max-w-[29rem] text-xs leading-5 text-muted-foreground" data-testid="text-owner-subtitle">{copy.subtitle}</p>
          </div>
          <div className="hidden shrink-0 rounded-2xl border border-primary/20 bg-background/30 p-3 sm:block" data-testid="owner-trust-mark">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
        </div>
        <label className="mt-4 block" htmlFor="owner-field-select">
          <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{copy.field}</span>
          <span className="relative block">
            <select
              id="owner-field-select"
              value={fieldId || ""}
              onChange={(event) => selectField(event.target.value)}
              data-testid="select-owner-field"
              aria-label={copy.field}
              className="h-11 w-full appearance-none rounded-xl border border-white/[0.12] bg-background/50 px-3 pe-10 text-sm font-medium text-foreground outline-none focus:border-primary"
            >
              <option value="" disabled>{copy.chooseField}</option>
              {fields.map((field: OwnerField) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          </span>
        </label>
        <div className="mt-3 grid grid-cols-3 gap-2" data-testid="owner-live-summary">
          <OwnerMetric icon={<span className="h-1.5 w-1.5 rounded-full bg-orange-300" />} label={copy.status.recording ?? copy.active} value={recordingCount} testId="recording" />
          <OwnerMetric icon={<Check className="h-3.5 w-3.5" />} label={copy.status.ready ?? copy.myFootage} value={readyCount} testId="ready" />
          <OwnerMetric icon={<Banknote className="h-3.5 w-3.5" />} label={copy.due} value={formatJod(selectedField?.balanceFils ?? 0)} testId="due" />
        </div>
      </section>

      <nav className="mt-4 grid grid-cols-3 gap-1 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-1" aria-label={copy.title} data-testid="owner-tabs">
        {([
          ["request", copy.request, Plus],
          ["footage", copy.myFootage, Film],
          ["billing", copy.billing, WalletCards],
        ] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            aria-selected={tab === value}
            data-testid={`tab-owner-${value}`}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition-colors ${tab === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"}`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>

      {tab === "request" && (
        <RequestPanel
          copy={copy}
          locale={locale}
          mode={requestMode}
          setMode={setRequestMode}
          date={date}
          setDate={setDate}
          from={from}
          setFrom={setFrom}
          to={to}
          setTo={setTo}
          today={today}
          maxBookDate={maxBookDate}
          hours={hours}
          availabilityLoading={availabilityQuery.isLoading}
          availabilityError={availabilityQuery.error}
           onRetryAvailability={() => void availabilityQuery.refetch()}
          onHourClick={selectHour}
          durationMinutes={durationMinutes}
          billableHours={billableHours}
          amountFils={amountFils}
          formError={formError}
          serverError={serverError}
          isSubmitting={createRequest.isPending}
          onSubmit={submitRequest}
        />
      )}
      {tab === "footage" && (
        <FootagePanel
          copy={copy}
          locale={locale}
          requests={requests}
          isLoading={requestsQuery.isLoading}
          isError={requestsQuery.isError}
          fieldName={selectedField?.name ?? ""}
          previewId={previewId}
          setPreviewId={setPreviewId}
          confirmingCancel={confirmingCancel}
          setConfirmingCancel={setConfirmingCancel}
          onCancel={runCancel}
          onRetry={retryRequest}
          onCopy={copyShareLink}
          onRevoke={(request) => runLinkAction(request, "revoke")}
          onNewLink={(request) => runLinkAction(request, "new")}
          isCancelling={cancelRequest.isPending}
          isLinkActionPending={revokeLink.isPending || createLink.isPending}
          onRefresh={() => requestsQuery.refetch()}
        />
      )}
      {tab === "billing" && (
        <BillingPanel copy={copy} locale={locale} ledger={ledgerQuery.data} isLoading={ledgerQuery.isLoading} isError={ledgerQuery.isError} />
      )}

      <div className="mt-4 flex items-center justify-center gap-2 text-[10px] text-muted-foreground/70" data-testid="owner-secure-note">
        <LockKeyhole className="h-3 w-3" aria-hidden="true" />
        {copy.secureLink}
      </div>
    </main>
  );
}

function OwnerMetric({ icon, label, value, testId }: { icon: ReactNode; label: string; value: string | number; testId: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.08] bg-background/25 px-2.5 py-2" data-testid={`metric-owner-${testId}`}>
      <div className="flex items-center gap-1.5 text-[9px] font-medium text-muted-foreground">{icon}<span className="truncate">{label}</span></div>
      <p className="mt-1 truncate font-mono text-sm font-semibold text-foreground" data-testid={`value-owner-${testId}`}>{value}</p>
    </div>
  );
}

function RequestPanel({
  copy,
  locale,
  mode,
  setMode,
  date,
  setDate,
  from,
  setFrom,
  to,
  setTo,
  today,
  maxBookDate,
  hours,
  availabilityLoading,
  availabilityError,
  onRetryAvailability,
  onHourClick,
  durationMinutes,
  billableHours,
  amountFils,
  formError,
  serverError,
  isSubmitting,
  onSubmit,
}: {
  copy: OwnerCopy;
  locale: string;
  mode: "past" | "book";
  setMode: (mode: "past" | "book") => void;
  date: string;
  setDate: (value: string) => void;
  from: string;
  setFrom: (value: string) => void;
  to: string;
  setTo: (value: string) => void;
  today: string;
  maxBookDate: string;
  hours: Set<number>;
  availabilityLoading: boolean;
  availabilityError: unknown;
  onRetryAvailability: () => void;
  onHourClick: (hour: number) => void;
  durationMinutes: number;
  billableHours: number;
  amountFils: number;
  formError: string;
  serverError: string;
  isSubmitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <section className="mt-4 space-y-3" data-testid="owner-request-panel">
      <div className="grid grid-cols-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-1" data-testid="owner-request-switch">
        <button type="button" onClick={() => setMode("past")} aria-pressed={mode === "past"} data-testid="button-request-past" className={`min-h-11 rounded-xl px-3 text-xs font-semibold ${mode === "past" ? "bg-white/[0.10] text-foreground" : "text-muted-foreground"}`}>{copy.pastFootage}</button>
        <button type="button" onClick={() => setMode("book")} aria-pressed={mode === "book"} data-testid="button-request-book" className={`min-h-11 rounded-xl px-3 text-xs font-semibold ${mode === "book" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{copy.bookMatch}</button>
      </div>

      <div className="rounded-[24px] border border-white/[0.08] bg-card/80 p-4" data-testid="owner-request-form">
          <div className="flex items-center gap-2 border-b border-white/[0.07] pb-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary"><CalendarDays className="h-4 w-4" aria-hidden="true" /></div>
          <div>
            <p className="text-sm font-semibold text-foreground">{mode === "past" ? copy.pastFootage : copy.bookMatch}</p>
            <p className="text-[11px] text-muted-foreground" data-testid="text-owner-selected-date">{friendlyLocalDate(date, locale)}</p>
          </div>
        </div>

        <label className="mt-4 block" htmlFor="owner-request-date">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{copy.date}</span>
          {mode === "past" && (
            <div className="mb-2 grid grid-cols-3 gap-2" data-testid="owner-date-chips">
              {[0, 1, 2].map((offset) => {
                const chipDate = addDays(today, -offset);
                return (
                  <button
                    key={chipDate}
                    type="button"
                    onClick={() => setDate(chipDate)}
                    aria-pressed={date === chipDate}
                    data-testid={`button-owner-date-${offset}`}
                    className={`min-h-11 rounded-xl border px-2 text-xs font-semibold transition-colors ${date === chipDate ? "border-primary/40 bg-primary/15 text-primary" : "border-white/[0.10] bg-background/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    {offset === 0 ? copy.today : friendlyLocalDate(chipDate, locale)}
                  </button>
                );
              })}
            </div>
          )}
          <Input
            id="owner-request-date"
            type="date"
            value={date}
            min={mode === "book" ? today : undefined}
            max={mode === "past" ? today : maxBookDate}
            onChange={(event) => setDate(event.target.value)}
            data-testid="input-request-date"
            aria-label={copy.date}
            className="h-11 border-white/[0.12] bg-background/50 [color-scheme:dark]"
          />
        </label>

        {mode === "past" ? (
          <div className="mt-4" data-testid="owner-availability">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground">{copy.recordedHours}</p>
              {availabilityLoading && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" aria-label={copy.availabilityLoading} />}
            </div>
            {availabilityError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs leading-5 text-destructive" role="alert" data-testid="error-owner-availability">
                <p>{getErrorMessage(availabilityError, copy.noAvailability)}</p>
                <Button type="button" variant="outline" onClick={onRetryAvailability} data-testid="button-retry-owner-availability" className="mt-3 min-h-11 rounded-xl border-destructive/30 px-3 text-xs text-destructive">{copy.retry}</Button>
              </div>
            ) : (
              <div className="grid grid-cols-6 gap-1.5" data-testid="grid-owner-availability">
                {HOURS.map((hour) => {
                  const available = hours.has(hour);
                  const label = `${hour.toString().padStart(2, "0")}:00`;
                  return (
                    <button
                      key={hour}
                      type="button"
                      disabled={!available}
                      onClick={() => onHourClick(hour)}
                      data-testid={`button-availability-hour-${hour}`}
                      aria-label={label}
                      className={`min-h-10 rounded-lg border text-[10px] font-mono transition-colors ${available ? "border-primary/30 bg-primary/[0.09] text-primary hover:bg-primary/20" : "cursor-not-allowed border-white/[0.05] bg-white/[0.025] text-muted-foreground/30"}`}
                    >
                      {hour.toString().padStart(2, "0")}
                    </button>
                  );
                })}
              </div>
            )}
            {!availabilityLoading && !availabilityError && hours.size === 0 && <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-owner-no-hours">{copy.noRecordedHours}</p>}
          </div>
        ) : (
          <p className="mt-4 rounded-xl border border-primary/15 bg-primary/[0.05] p-3 text-xs leading-5 text-muted-foreground" data-testid="text-owner-booking-note">{copy.futureBookingNote}</p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <TimeSelect id="owner-request-from" label={copy.from} value={from} onChange={setFrom} testId="select-request-from" />
          <TimeSelect id="owner-request-to" label={copy.to} value={to} onChange={setTo} testId="select-request-to" />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2" data-testid="owner-request-estimate">
          <div className="rounded-xl border border-white/[0.07] bg-background/40 p-3">
            <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{copy.duration}</p>
            <p className="mt-1 font-mono text-lg font-semibold text-foreground" data-testid="text-request-duration">{durationMinutes > 0 ? `${Math.floor(durationMinutes / 60)}${copy.hours} ${durationMinutes % 60}${copy.minutes}` : "—"}</p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-3">
            <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{copy.cost}</p>
            <p className="mt-1 font-mono text-lg font-semibold text-primary" data-testid="text-request-cost">{formatJod(amountFils)} <span className="text-xs">{copy.currency}</span></p>
          </div>
        </div>
        <p className="mt-3 rounded-xl border border-primary/15 bg-primary/[0.05] p-3 text-[11px] leading-5 text-muted-foreground" data-testid="text-owner-charge-disclaimer">{copy.chargeDisclaimer}</p>

        {(formError || serverError) && (
          <p className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs leading-5 text-destructive" role="alert" data-testid="error-owner-request">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {formError || serverError}
          </p>
        )}

        <Button type="button" onClick={onSubmit} disabled={isSubmitting} data-testid="button-submit-owner-request" className="mt-4 min-h-12 w-full rounded-xl font-semibold">
          {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
          {isSubmitting ? copy.submitting : mode === "book" ? copy.bookMatch : copy.requestFootage}
        </Button>
      </div>
    </section>
  );
}

function TimeSelect({ id, label, value, onChange, testId }: { id: string; label: string; value: string; onChange: (value: string) => void; testId: string }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} data-testid={testId} aria-label={label} className="h-11 w-full rounded-xl border border-white/[0.12] bg-background/50 px-3 text-sm font-mono text-foreground outline-none focus:border-primary">
        {TIME_OPTIONS.map((time) => <option key={time} value={time}>{time}</option>)}
      </select>
    </label>
  );
}

function FootagePanel({
  copy,
  locale,
  requests,
  isLoading,
  isError,
  fieldName,
  previewId,
  setPreviewId,
  confirmingCancel,
  setConfirmingCancel,
  onCancel,
  onRetry,
  onCopy,
  onRevoke,
  onNewLink,
  isCancelling,
  isLinkActionPending,
  onRefresh,
}: {
  copy: OwnerCopy;
  locale: string;
  requests: OwnerRequest[];
  isLoading: boolean;
  isError: boolean;
  fieldName: string;
  previewId: number | null;
  setPreviewId: (id: number | null) => void;
  confirmingCancel: number | null;
  setConfirmingCancel: (id: number | null) => void;
  onCancel: (id: number) => void;
  onRetry: (request: OwnerRequest) => void;
  onCopy: (url: string) => void;
  onRevoke: (request: OwnerRequest) => void;
  onNewLink: (request: OwnerRequest) => void;
  isCancelling: boolean;
  isLinkActionPending: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="mt-4 space-y-3" data-testid="owner-footage-panel">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{fieldName}</p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-[-0.04em] text-foreground" data-testid="text-owner-footage-title">{copy.myFootage}</h2>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onRefresh} data-testid="button-refresh-owner-requests" aria-label={copy.refresh} className="h-11 w-11 rounded-xl text-muted-foreground"><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
      </div>
      {isLoading ? (
        <div className="space-y-3" data-testid="owner-footage-loading">
          {[1, 2].map((item) => <div key={item} className="h-36 animate-pulse rounded-2xl bg-white/[0.06]" data-testid={`skeleton-owner-request-${item}`} />)}
        </div>
      ) : isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert" data-testid="error-owner-requests">{copy.requestFailed}</div>
      ) : requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/[0.14] bg-white/[0.025] px-5 py-10 text-center" data-testid="owner-footage-empty">
          <Film className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-semibold text-foreground" data-testid="text-owner-empty-footage">{copy.emptyFootage}</h3>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{copy.emptyFootageDesc}</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="owner-request-list">
          {requests.map((request) => (
            <RequestCard
              key={request.id}
              copy={copy}
              locale={locale}
              request={request}
              previewId={previewId}
              setPreviewId={setPreviewId}
              confirmingCancel={confirmingCancel}
              setConfirmingCancel={setConfirmingCancel}
              onCancel={onCancel}
              onRetry={onRetry}
              onCopy={onCopy}
              onRevoke={onRevoke}
              onNewLink={onNewLink}
              isCancelling={isCancelling}
              isLinkActionPending={isLinkActionPending}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RequestCard({
  copy,
  locale,
  request,
  previewId,
  setPreviewId,
  confirmingCancel,
  setConfirmingCancel,
  onCancel,
  onRetry,
  onCopy,
  onRevoke,
  onNewLink,
  isCancelling,
  isLinkActionPending,
}: {
  copy: OwnerCopy;
  locale: string;
  request: OwnerRequest;
  previewId: number | null;
  setPreviewId: (id: number | null) => void;
  confirmingCancel: number | null;
  setConfirmingCancel: (id: number | null) => void;
  onCancel: (id: number) => void;
  onRetry: (request: OwnerRequest) => void;
  onCopy: (url: string) => void;
  onRevoke: (request: OwnerRequest) => void;
  onNewLink: (request: OwnerRequest) => void;
  isCancelling: boolean;
  isLinkActionPending: boolean;
}) {
  const key = statusKey(request.status);
  const label = copy.status[key] ?? copy.unknownStatus;
  const message = copy.statusMessage[key] ?? copy.unknownStatus;
  const isReady = key === "ready" || key === "partial";
  const isFailed = key === "failed";
  const isScheduled = key === "scheduled";
  const showPreview = previewId === request.id;
  const progress = Math.max(0, Math.min(100, Math.round(request.progress)));
  const isProgressing = key === "recording" || key === "running" || key === "preparing";
  const statusMessage = message;
  const requestedDuration = formatDuration(request.requestedSeconds, copy);

  return (
    <article className={`overflow-hidden rounded-[22px] border border-white/[0.08] bg-card/85 ${key === "expired" ? "opacity-65" : ""}`} data-testid={`card-owner-request-${request.id}`}>
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${isReady ? "bg-primary/15 text-primary" : key === "failed" ? "bg-destructive/15 text-destructive" : isProgressing ? "bg-accent/15 text-accent" : "bg-white/[0.08] text-muted-foreground"}`} data-testid={`status-owner-request-${request.id}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {label}
            </span>
            {isProgressing && <span className="font-mono text-[10px] text-accent">{progress}%</span>}
          </div>
          <p className="mt-2 font-mono text-xs font-medium text-foreground" data-testid={`text-owner-request-window-${request.id}`}>
            {friendlyLocalDate(request.startLocal.slice(0, 10), locale)} · {request.startLocal.slice(11)}–{request.endLocal.slice(11)}
          </p>
        </div>
        <div className="shrink-0 text-end">
           <p className="font-mono text-sm font-semibold text-foreground" data-testid={`text-owner-request-amount-${request.id}`}>{formatJod(request.amountFils)} <span className="text-[10px] font-normal text-muted-foreground">{copy.currency}</span></p>
          <p className="mt-1 text-[10px] text-muted-foreground">{request.billableHours} {copy.hours}</p>
        </div>
      </div>

      <div className="border-t border-white/[0.07] px-4 py-3">
        {isProgressing && <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" aria-label={copy.progress} data-testid={`progress-owner-request-${request.id}`}><span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress}%` }} /></div>}
        <p className="text-xs leading-5 text-muted-foreground" data-testid={`message-owner-request-${request.id}`}>
          {isScheduled ? `${message} ${request.startLocal.slice(11)}` : statusMessage}
        </p>
        {isReady && (
          <p className="mt-2 text-[11px] font-medium text-foreground" data-testid={`summary-owner-request-${request.id}`}>
            {copy.playerLabel} · {requestedDuration} · {copy.charged} {formatJod(request.amountFils)} {copy.currency}
          </p>
        )}
        {request.readyAt && isReady && <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid={`ready-at-owner-request-${request.id}`}><Check className="h-3 w-3 text-primary" aria-hidden="true" />{copy.readyAt} {new Date(request.readyAt).toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")}</p>}
      </div>

      {request.varActive && (
        <div className="border-t border-white/[0.07] p-3" data-testid={`var-owner-request-${request.id}`}>
          <VarPlayer
            src={`${basePath}/api/owner/requests/${request.id}/var/hls/playlist.m3u8`}
            title={`${copy.playerLabel} · VAR`}
            minStartUtcMs={request.varOpensAt ? Date.parse(request.varOpensAt) : undefined}
          />
        </div>
      )}

      {isReady && request.playbackManifestUrl && showPreview && (
        <div className="border-t border-white/[0.07] p-3" data-testid={`preview-owner-request-${request.id}`}>
          <HlsPlayer url={request.playbackManifestUrl} label={copy.playerLabel} />
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-white/[0.07] p-3">
        {isReady && request.playbackManifestUrl && (
          <Button type="button" variant="secondary" onClick={() => setPreviewId(showPreview ? null : request.id)} data-testid={`button-preview-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs">
            <Play className="h-3.5 w-3.5" aria-hidden="true" />{showPreview ? copy.hidePreview : copy.preview}
          </Button>
        )}
        {isReady && request.shareUrl && (
          <>
            <Button type="button" variant="outline" onClick={() => onCopy(request.shareUrl as string)} data-testid={`button-copy-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs"><Copy className="h-3.5 w-3.5" aria-hidden="true" />{copy.copyLink}</Button>
            <Button type="button" variant="outline" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`${copy.whatsappMessage} ${request.shareUrl as string}`)}`, "_blank", "noopener,noreferrer")} data-testid={`button-whatsapp-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs"><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{copy.whatsapp}</Button>
            <Button type="button" variant="ghost" onClick={() => onRevoke(request)} disabled={isLinkActionPending} data-testid={`button-revoke-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs text-muted-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" />{copy.revoke}</Button>
            <Button type="button" variant="ghost" onClick={() => onNewLink(request)} disabled={isLinkActionPending} data-testid={`button-new-link-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{copy.newLink}</Button>
          </>
        )}
        {isReady && !request.shareUrl && (
          <Button type="button" variant="secondary" onClick={() => onNewLink(request)} disabled={isLinkActionPending} data-testid={`button-new-link-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{copy.newLink}</Button>
        )}
        {isFailed && <Button type="button" variant="secondary" onClick={() => onRetry(request)} data-testid={`button-retry-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs"><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />{copy.retry}</Button>}
        {isScheduled && confirmingCancel !== request.id && <Button type="button" variant="ghost" onClick={() => setConfirmingCancel(request.id)} data-testid={`button-cancel-owner-request-${request.id}`} className="min-h-11 rounded-xl px-3 text-xs text-muted-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" />{copy.cancel}</Button>}
      </div>

      {isScheduled && confirmingCancel === request.id && (
        <div className="grid gap-3 border-t border-destructive/20 bg-destructive/[0.06] p-3" data-testid={`confirm-cancel-owner-request-${request.id}`}>
          <p className="text-xs leading-5 text-foreground">{copy.cancelPrompt}</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" onClick={() => onCancel(request.id)} disabled={isCancelling} data-testid={`button-confirm-cancel-owner-request-${request.id}`} className="min-h-11 flex-1 rounded-xl text-xs">{isCancelling ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{copy.confirmCancel}</Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmingCancel(null)} data-testid={`button-keep-owner-request-${request.id}`} className="min-h-11 rounded-xl text-xs">{copy.keepRequest}</Button>
          </div>
        </div>
      )}

      {isReady && request.shareExpiresAt && <p className="px-4 pb-3 text-[10px] text-muted-foreground" data-testid={`link-expires-owner-request-${request.id}`}>{copy.linkExpires} {new Date(request.shareExpiresAt).toLocaleDateString(locale === "ar" ? "ar-JO" : "en-JO")}</p>}
    </article>
  );
}

function BillingPanel({ copy, locale, ledger, isLoading, isError }: { copy: OwnerCopy; locale: string; ledger: OwnerLedger | undefined; isLoading: boolean; isError: boolean }) {
  if (isLoading) {
    return <section className="mt-4 space-y-3" data-testid="owner-billing-loading"><div className="h-32 animate-pulse rounded-2xl bg-white/[0.06]" /><div className="h-56 animate-pulse rounded-2xl bg-white/[0.06]" /></section>;
  }
  if (isError || !ledger) {
    return <section className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert" data-testid="error-owner-ledger">{copy.requestFailed}</section>;
  }
  return (
    <section className="mt-4 space-y-3" data-testid="owner-billing-panel">
      <div className="flex items-end justify-between gap-3">
        <div><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{copy.billing}</p><h2 className="mt-1 font-display text-2xl font-semibold tracking-[-0.04em] text-foreground" data-testid="text-owner-billing-title">{copy.billingTitle}</h2></div>
        <Banknote className="h-6 w-6 text-primary" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-3 gap-2" data-testid="owner-ledger-totals">
        <LedgerTotal label={copy.totalCharged} value={ledger.totalChargedFils} testId="total-charged" />
        <LedgerTotal label={copy.paid} value={ledger.paidFils} testId="total-paid" />
        <LedgerTotal label={copy.due} value={ledger.balanceFils} testId="total-due" emphasis />
      </div>
      <p className="rounded-2xl border border-secondary/20 bg-secondary/[0.06] p-3 text-xs leading-5 text-muted-foreground" data-testid="text-owner-billing-note">{copy.billingNote}</p>
      <LedgerList
        copy={copy}
        locale={locale}
        empty={ledger.charges.length || ledger.payments.length ? "" : copy.noCharges}
        items={[
          ...ledger.charges.map((charge) => ({
            id: `charge-${charge.id}`,
            kind: "charge" as const,
            sortKey: charge.startLocal,
            title: `${copy.footageLabel} · ${friendlyLocalDate(charge.startLocal.slice(0, 10), locale)} ${charge.startLocal.slice(11)}–${charge.endLocal.slice(11)}`,
            meta: `${charge.billableHours} ${copy.hours} × 1 ${copy.currency}`,
            amount: charge.amountFils,
          })),
          ...ledger.payments.map((payment) => ({
            id: `payment-${payment.id}`,
            kind: "payment" as const,
            sortKey: payment.createdAt,
            title: `${copy.paymentLabel} · ${payment.method || copy.paymentMethod} — ${new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", { day: "numeric", month: "short" }).format(new Date(payment.createdAt))}`,
            meta: payment.note || copy.paymentMethod,
            amount: payment.amountFils,
          })),
        ].sort((a, b) => b.sortKey.localeCompare(a.sortKey))}
      />
    </section>
  );
}

function LedgerTotal({ label, value, testId, emphasis = false }: { label: string; value: number; testId: string; emphasis?: boolean }) {
  return <div className={`rounded-2xl border p-3 ${emphasis ? "border-primary/25 bg-primary/[0.08]" : "border-white/[0.07] bg-card/80"}`}><p className="min-h-7 text-[10px] leading-4 text-muted-foreground">{label}</p><p className={`mt-1 font-mono text-sm font-semibold ${emphasis ? "text-primary" : "text-foreground"}`} data-testid={`text-ledger-${testId}`}>{formatJod(value)}</p></div>;
}

function LedgerList({ locale, empty, items, copy }: {
  locale: string;
  empty: string;
  items: Array<{ id: string; kind: "charge" | "payment"; sortKey: string; title: string; meta: string; amount: number }>;
  copy: OwnerCopy;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-card/80 p-4" data-testid="owner-ledger">
      <div className="flex items-center gap-2 border-b border-white/[0.07] pb-3 text-sm font-semibold text-foreground">
        <Clock3 className="h-4 w-4" aria-hidden="true" />
        {copy.billing}
      </div>
      {items.length === 0 ? (
        <p className="py-5 text-center text-xs text-muted-foreground" data-testid="text-owner-empty-ledger">{empty}</p>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 py-3" data-testid={`row-owner-ledger-${item.id}`}>
              <div className="min-w-0">
                <p className="truncate text-xs text-foreground" data-testid={`title-owner-ledger-${item.id}`}>{item.title}</p>
                <p className="mt-1 truncate text-[10px] text-muted-foreground" data-testid={`meta-owner-ledger-${item.id}`}>{item.meta}</p>
              </div>
              <p className={`shrink-0 font-mono text-xs font-semibold ${item.kind === "charge" ? "text-primary" : "text-secondary"}`} data-testid={`amount-owner-ledger-${item.id}`}>
                {item.kind === "charge" ? "+" : "−"}{formatJod(item.amount)} <span className="text-[9px] font-normal text-muted-foreground">{copy.currency}</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
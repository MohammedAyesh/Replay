import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAcademyConsoleDashboardQueryKey,
  getGetAcademyConsoleJoinLinkQueryKey,
  getListAcademyConsolePlayersQueryKey,
  getListAcademyConsoleRegistrationsQueryKey,
  getListAcademyConsoleSquadsQueryKey,
  useApproveAcademyConsoleRegistration,
  useGetAcademyConsoleJoinLink,
  useListAcademyConsoleRegistrations,
  useListAcademyConsoleSquads,
  useRegenerateAcademyConsoleJoinLink,
  useRejectAcademyConsoleRegistration,
  type AcademyRegistrationSummary,
} from "@workspace/api-client-react";
import { Check, Clipboard, Clock3, Copy, ExternalLink, Link2, LoaderCircle, RefreshCw, ShieldCheck, UserRound, X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ReviewFilter = "pending" | "approved" | "rejected";

export function AcademyRegistrationsSection({ academyId, isOwner }: { academyId: number; isOwner: boolean }) {
  const { t, locale } = useTranslation();
  const copy = t.academyConsole.registrations;
  const rootLabels = t.academyConsole;
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ReviewFilter>("pending");
  const [active, setActive] = useState<number | null>(null);
  const [squadId, setSquadId] = useState("");
  const [jersey, setJersey] = useState("");
  const [position, setPosition] = useState("");
  const [formError, setFormError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [copied, setCopied] = useState(false);
  const params = useMemo(() => ({ status: filter }), [filter]);
  const listQuery = useListAcademyConsoleRegistrations(academyId, params, {
    query: { queryKey: getListAcademyConsoleRegistrationsQueryKey(academyId, params), staleTime: 15_000 },
  });
  const squadsQuery = useListAcademyConsoleSquads(academyId, {
    query: { queryKey: getListAcademyConsoleSquadsQueryKey(academyId), staleTime: 60_000 },
  });
  const linkQuery = useGetAcademyConsoleJoinLink(academyId, {
    query: { queryKey: getGetAcademyConsoleJoinLinkQueryKey(academyId), enabled: isOwner },
  });
  const regenerate = useRegenerateAcademyConsoleJoinLink();
  const approve = useApproveAcademyConsoleRegistration();
  const reject = useRejectAcademyConsoleRegistration();
  const records = listQuery.data ?? [];
  const squads = squadsQuery.data ?? [];
  const localeTag = locale === "ar" ? "ar-JO" : "en-GB";
  const refresh = async () => Promise.all([
    qc.invalidateQueries({ queryKey: getListAcademyConsoleRegistrationsQueryKey(academyId) }),
    qc.invalidateQueries({ queryKey: getGetAcademyConsoleDashboardQueryKey(academyId) }),
    qc.invalidateQueries({ queryKey: getListAcademyConsolePlayersQueryKey(academyId) }),
    qc.invalidateQueries({ queryKey: getListAcademyConsoleSquadsQueryKey(academyId) }),
  ]);
  const openApproval = (record: AcademyRegistrationSummary) => {
    setActive(record.id);
    setSquadId(record.preferredSquadId ? String(record.preferredSquadId) : "");
    setJersey("");
    setPosition("");
    setFormError(false);
    setActionError(false);
  };
  const approveRecord = async (record: AcademyRegistrationSummary) => {
    const number = jersey.trim() ? Number(jersey) : null;
    if (number !== null && (!Number.isSafeInteger(number) || number < 0)) {
      setFormError(true);
      return;
    }
    setFormError(false);
    setActionError(false);
    try {
      await approve.mutateAsync({
        academyId, registrationId: record.id,
        data: { squadId: squadId ? Number(squadId) : null, jerseyNumber: number, position: position.trim() || null },
      });
      await refresh();
      setActive(null);
    } catch { setActionError(true); }
  };
  const rejectRecord = async (record: AcademyRegistrationSummary) => {
    if (!window.confirm(copy.confirmReject)) return;
    setActionError(false);
    try {
      await reject.mutateAsync({ academyId, registrationId: record.id });
      await refresh();
      setActive(null);
    } catch { setActionError(true); }
  };
  const joinUrl = linkQuery.data?.joinUrl ?? "";
  const copyLink = async () => {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setCopied(false); }
  };
  const displayDate = (date: string) => new Intl.DateTimeFormat(localeTag, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));

  return (
    <section className="space-y-6" data-testid="academy-registrations" dir={locale === "ar" ? "rtl" : "ltr"}>
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-turf">{rootLabels.workspace}</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text">{copy.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.description}</p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs font-bold text-amber-200">
          <Clock3 size={14} />{copy.pendingCount(records.length, filter === "pending")}
        </span>
      </header>

      {isOwner && <section className="join-link-panel" data-testid="academy-join-link-management">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-turf/10 text-turf"><Link2 size={19} /></span>
          <div className="min-w-0 flex-1">
            <h2>{copy.inviteTitle}</h2><p>{copy.inviteDescription}</p>
            {linkQuery.isLoading ? <div className="mt-3 h-10 animate-pulse rounded-lg bg-raised" /> : linkQuery.isError ? (
              <div className="mt-3 flex items-center gap-2 text-sm text-muted-text" role="alert">{copy.linkLoadError}<Button type="button" variant="outline" size="sm" onClick={() => void linkQuery.refetch()}>{rootLabels.retry}</Button></div>
            ) : joinUrl ? (
              <div className="join-url-row"><code dir="ltr">{joinUrl}</code><Button type="button" variant="outline" onClick={() => void copyLink()} className="shrink-0" data-testid="button-copy-academy-join-link">{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? copy.copied : copy.copy}</Button><a href={joinUrl} target="_blank" rel="noreferrer" aria-label={copy.openLink} className="join-open-link"><ExternalLink size={16} /></a></div>
            ) : <p className="mt-3 text-sm text-muted-text">{copy.noLink}</p>}
          </div>
        </div>
        <Button type="button" disabled={regenerate.isPending} onClick={async () => {
          if (linkQuery.data?.joinUrl && !window.confirm(copy.confirmRegenerate)) return;
          try { await regenerate.mutateAsync({ academyId }); await qc.invalidateQueries({ queryKey: getGetAcademyConsoleJoinLinkQueryKey(academyId) }); } catch { setActionError(true); }
        }} className="min-h-10 shrink-0 bg-floodlight text-void hover:bg-floodlight/90" data-testid="button-regenerate-join-link">
          {regenerate.isPending ? <LoaderCircle className="me-2 h-4 w-4 animate-spin" /> : <RefreshCw className="me-2 h-4 w-4" />}
          {linkQuery.data?.joinUrl ? copy.regenerate : copy.createLink}
        </Button>
      </section>}
      {actionError && <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{copy.actionError}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="registration-tabs" role="tablist" aria-label={copy.filterLabel}>
          {(["pending", "approved", "rejected"] as const).map((status) => (
            <button key={status} type="button" role="tab" aria-selected={filter === status} onClick={() => { setFilter(status); setActive(null); }} data-testid={`tab-registrations-${status}`}>
              {copy[status]}
            </button>
          ))}
        </div>
        <span className="text-xs font-semibold text-muted-text">{copy.historyHint}</span>
      </div>
      {listQuery.isLoading ? <div className="space-y-3" aria-label={rootLabels.loading}>{[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl border border-line bg-surface" />)}</div>
        : listQuery.isError ? <div className="rounded-2xl border border-line bg-surface p-6" role="alert"><p className="text-sm text-muted-text">{copy.loadError}</p><Button type="button" variant="outline" className="mt-3" onClick={() => void listQuery.refetch()}>{rootLabels.retry}</Button></div>
          : records.length === 0 ? <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-12 text-center" data-testid={`registrations-empty-${filter}`}>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-turf/10 text-turf"><Clipboard size={20} /></span>
            <h2 className="mt-4 font-display text-xl font-bold text-text">{filter === "pending" ? copy.emptyPendingTitle : copy.emptyHistoryTitle}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-text">{filter === "pending" ? copy.emptyPendingDescription : copy.emptyHistoryDescription}</p>
          </div> : <div className="space-y-3">
            {records.map((record) => <article key={record.id} className={`registration-card ${active === record.id ? "is-open" : ""}`} data-testid={`registration-card-${record.id}`}>
              <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:px-5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-raised text-turf"><UserRound size={19} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="break-words font-display text-xl font-bold text-text" dir="auto">{record.playerName}</h2>
                    <span className={`registration-status status-${record.status}`}>{copy[record.status]}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-text">
                    <span>{copy.submitted}: {displayDate(record.createdAt)}</span>
                    {record.dateOfBirth && <span>{copy.dateOfBirth}: {record.dateOfBirth}</span>}
                    {record.preferredSquadName && <span dir="auto">{copy.preferredSquad}: {record.preferredSquadName}</span>}
                  </div>
                  <div className="mt-3 grid gap-x-5 gap-y-1 text-sm sm:grid-cols-2">
                    {record.guardianName && <p className="text-muted-text"><span className="text-text">{copy.guardianName}: </span>{record.guardianName}</p>}
                    <a dir="ltr" href={`tel:${record.guardianPhone}`} className="w-fit font-semibold text-turf underline-offset-4 hover:underline" data-testid={`link-guardian-phone-${record.id}`}>{record.guardianPhone}</a>
                    {record.notes && <p className="whitespace-pre-wrap text-muted-text sm:col-span-2"><span className="text-text">{copy.notes}: </span>{record.notes}</p>}
                  </div>
                  {record.createdPlayerId !== null && <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-turf"><ShieldCheck size={14} />{copy.playerCreated}</p>}
                </div>
                {record.status === "pending" && <div className="flex shrink-0 gap-2 sm:pt-1">
                  {active === record.id ? <Button type="button" variant="outline" onClick={() => setActive(null)} className="min-h-10">{copy.close}</Button> : <Button type="button" onClick={() => openApproval(record)} className="min-h-10 bg-floodlight font-bold text-void hover:bg-floodlight/90" data-testid={`button-review-registration-${record.id}`}>{copy.review}</Button>}
                  <Button type="button" variant="outline" disabled={reject.isPending} onClick={() => void rejectRecord(record)} className="min-h-10 text-muted-text hover:border-destructive/40 hover:text-destructive" aria-label={`${copy.reject}: ${record.playerName}`} data-testid={`button-reject-registration-${record.id}`}><X size={16} /><span className="sr-only sm:not-sr-only sm:ms-1">{copy.reject}</span></Button>
                </div>}
              </div>
              {active === record.id && record.status === "pending" && <div className="registration-approval">
                <div className="flex items-start gap-2 text-xs leading-5 text-muted-text"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-turf" />{copy.approvalHint}</div>
                {squadsQuery.isError && <p role="alert" className="text-sm text-destructive">{copy.squadsError}</p>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5"><Label htmlFor={`approval-squad-${record.id}`}>{copy.assignSquad}</Label><select id={`approval-squad-${record.id}`} value={squadId} onChange={(e) => setSquadId(e.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-raised px-3 text-start text-sm text-text" data-testid={`select-approval-squad-${record.id}`}><option value="">{rootLabels.unassigned}</option>{squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}</select></div>
                  <div className="space-y-1.5"><Label htmlFor={`approval-jersey-${record.id}`}>{copy.jersey}</Label><Input id={`approval-jersey-${record.id}`} type="number" min={0} step={1} inputMode="numeric" value={jersey} onChange={(e) => setJersey(e.target.value)} className="min-h-11 text-start" data-testid={`input-approval-jersey-${record.id}`} /></div>
                  <div className="space-y-1.5"><Label htmlFor={`approval-position-${record.id}`}>{copy.position}</Label><Input id={`approval-position-${record.id}`} maxLength={80} value={position} onChange={(e) => setPosition(e.target.value)} className="min-h-11 text-start" data-testid={`input-approval-position-${record.id}`} /></div>
                </div>
                {formError && <p className="text-sm text-destructive" role="alert">{copy.jerseyInvalid}</p>}
                {actionError && <p className="text-sm text-destructive" role="alert">{copy.actionError}</p>}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" disabled={approve.isPending} onClick={() => setActive(null)}>{rootLabels.cancel}</Button>
                  <Button type="button" disabled={approve.isPending} onClick={() => void approveRecord(record)} className="bg-turf font-bold text-void hover:bg-turf/90" data-testid={`button-approve-registration-${record.id}`}>{approve.isPending ? copy.approving : <><Check size={15} className="me-2" />{copy.approve}</>}</Button>
                </div>
              </div>}
            </article>)}
          </div>}
    </section>
  );
}
import { useState } from "react";
import { Eye, EyeOff, ExternalLink, Loader2, ShieldBan, Trash2, X } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useAdminReports, useResolveReport, type AdminReport, type ResolveAction } from "@/lib/safety-api";
import { safetyStrings, hiddenClipNoticeText } from "@/i18n/safety-strings";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const reportLabels = safetyStrings.en.reasons;
const actionText: Record<ResolveAction, string> = {
  dismiss: "Dismiss",
  hide_clip: "Hide clip",
  unhide_clip: "Unhide clip",
  remove_from_clip: "Remove from clip",
  disable_user: "Disable user",
};

export function ReportsTab() {
  const [status, setStatus] = useState<"open" | "history">("open");
  const reports = useAdminReports(status);
  const resolve = useResolveReport();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<{ row: AdminReport; action: ResolveAction } | null>(null);

  const run = async (row: AdminReport, action: ResolveAction) => {
    try {
      await resolve.mutateAsync({ id: row.id, action });
      toast({ title: `${actionText[action]} complete` });
      setConfirm(null);
      await reports.refetch();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "Action failed", variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col gap-4" dir="ltr">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-text">Reports</h2>
          <p className="text-xs text-muted-text">Review player reports and keep Replay a respectful place.</p>
        </div>
        <div className="flex min-h-11 rounded-xl border border-line bg-surface p-1">
          {(["open", "history"] as const).map((value) => (
            <button type="button" key={value} data-testid={`button-reports-${value}`} onClick={() => setStatus(value)} className={`min-h-11 rounded-lg px-4 text-xs font-semibold transition-colors ${status === value ? "bg-floodlight text-void" : "text-muted-text hover:bg-raised hover:text-text"}`}>
              {value === "open" ? "Open" : "History"}
            </button>
          ))}
        </div>
      </div>
      {reports.isLoading ? (
        <div className="grid gap-3">
          {[1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl border border-line bg-surface" />)}
        </div>
      ) : reports.isError ? (
        <div className="rounded-2xl border border-line bg-surface p-5 text-sm text-muted-text">
          <p>Couldn&apos;t load reports.</p>
          <button type="button" data-testid="button-retry-reports" onClick={() => void reports.refetch()} className="mt-3 min-h-11 rounded-xl border border-line px-4 font-semibold text-text">Try again</button>
        </div>
      ) : (reports.data ?? []).length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center">
          <ShieldBan className="mx-auto h-8 w-8 text-muted-text" aria-hidden="true" />
          <p className="mt-3 font-semibold text-text">{status === "open" ? "Nothing needs review." : "No report history yet."}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {(reports.data ?? []).map((row) => <ReportCard key={row.id} row={row} pending={resolve.isPending} onAction={(action) => action === "dismiss" || action === "disable_user" ? setConfirm({ row, action }) : void run(row, action)} />)}
        </div>
      )}
      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent className="border-line bg-surface text-text">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm {confirm ? actionText[confirm.action].toLowerCase() : "action"}?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-text">This changes the moderation state for everyone who can see this content.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row gap-2">
            <AlertDialogCancel className="mt-0 min-h-11 flex-1 border-line text-text">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={resolve.isPending || !confirm} onClick={(event) => { event.preventDefault(); if (confirm) void run(confirm.row, confirm.action); }} className="min-h-11 flex-1 bg-floodlight text-void">
              {resolve.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ReportsTab;

function ReportCard({ row, pending, onAction }: { row: AdminReport; pending: boolean; onAction: (action: ResolveAction) => void }) {
  const clip = row.clip;
  const hidden = clip?.isHidden === true;
  const hiddenNotice = clip?.isHidden ? hiddenClipNoticeText(clip.hiddenReason, "en") : null;
  return (
    <article data-testid={`card-report-${row.id}`} className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex flex-col gap-4 p-4 sm:flex-row">
        {clip?.posterUrl ? <img src={clip.posterUrl} alt="" data-testid={`img-report-poster-${row.id}`} className="h-24 w-full rounded-xl object-cover sm:w-36" /> : <div className="hidden h-24 w-36 shrink-0 items-center justify-center rounded-xl bg-raised text-xs text-muted-text sm:flex">No preview</div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-text">
            <span className="rounded-full bg-raised px-2 py-1">{row.targetType === "user_clip" ? "Clip" : "Player"}</span>
            <span>{new Date(row.createdAt).toLocaleString("en-GB")}</span>
            {row.targetUser?.isDisabled && <span className="rounded-full bg-red-500/15 px-2 py-1 text-red-200">Disabled</span>}
          </div>
          <h3 className="mt-2 truncate font-semibold text-text">{clip?.title || row.targetUser?.name || `Target #${row.targetId}`}</h3>
          <p className="mt-1 text-sm text-text">{reportLabels[row.reason]}</p>
          {row.note && <p className="mt-2 rounded-xl bg-raised p-2 text-xs leading-5 text-muted-text">{row.note}</p>}
          <p className="mt-2 text-xs text-muted-text">
            Reporter: {row.reporter?.name || "Unavailable"} · Target: {row.targetUser?.name || "Unavailable"} · {row.openReportsForTarget} open report{row.openReportsForTarget === 1 ? "" : "s"}
          </p>
          {clip && <p className="mt-1 text-xs text-muted-text">Visibility: {clip.visibility} · {hidden ? hiddenNotice || "Hidden" : "Visible"} {clip.matchCode && <>· <Link href={`/m/${clip.matchCode}`} className="inline-flex min-h-11 items-center gap-1 text-turf hover:underline">Match {clip.matchCode}<ExternalLink className="h-3 w-3" /></Link></>}</p>}
        </div>
      </div>
      {row.status === "open" && (
        <div className="flex flex-wrap gap-2 border-t border-line bg-raised/40 p-3">
          <ActionButton disabled={pending} icon={<X />} label="Dismiss" onClick={() => onAction("dismiss")} />
          {clip && <ActionButton disabled={pending} icon={hidden ? <Eye /> : <EyeOff />} label={hidden ? "Unhide clip" : "Hide clip"} onClick={() => onAction(hidden ? "unhide_clip" : "hide_clip")} />}
          {clip && <ActionButton disabled={pending} icon={<Trash2 />} label="Remove from clip" onClick={() => onAction("remove_from_clip")} />}
          {row.targetUser && <ActionButton disabled={pending || row.targetUser.isDisabled} icon={<ShieldBan />} label="Disable user" onClick={() => onAction("disable_user")} />}
        </div>
      )}
    </article>
  );
}

function ActionButton({ icon, label, disabled, onClick }: { icon: React.ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} data-testid={`button-report-action-${label.toLowerCase().replaceAll(" ", "-")}`} onClick={onClick} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line px-3 text-xs font-semibold text-text transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50">{icon}{label}</button>;
}

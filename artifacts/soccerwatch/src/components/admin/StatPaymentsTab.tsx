import { Check, Loader2, X } from "lucide-react";
import { formatJod, useAdminStatUnlocks, useReviewStatUnlock } from "@/lib/match-api";
import { useToast } from "@/hooks/use-toast";

/**
 * Stats unlocks paid by CliQ. Players send the amount with the reference in the
 * note; match the incoming transfer here and confirm it.
 */
export default function StatPaymentsTab() {
  const list = useAdminStatUnlocks(true);
  const review = useReviewStatUnlock();
  const { toast } = useToast();
  const rows = list.data ?? [];

  const act = (id: number, action: "confirm" | "reject") =>
    review.mutateAsync({ id, action })
      .then(() => toast({ title: action === "confirm" ? "Confirmed" : "Rejected" }))
      .catch((e) => toast({ title: e instanceof Error ? e.message : "Failed", variant: "destructive" }));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-xl font-bold">Payments</h2>
        <p className="text-xs text-muted-text">
          Payments waiting to be checked. CliQ: confirm only once the transfer carrying this reference has arrived.
          Confirming a CliQ booking starts the recording; rejecting it cancels the booking and frees the slot.
          Cash at the field: the recording is already locked in, so confirm means the cash was handed over and
          reject means it wasn&apos;t. Prices are set in Settings → Pricing.
        </p>
      </div>
      {list.isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-text" />
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted-text">Nothing waiting.</p>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm font-bold">{row.reference}</p>
              <p className="truncate text-xs text-muted-text">
                {row.user.name ?? "—"} · {row.user.phone ?? row.user.email ?? ""} · {row.kind === "booking" ? (row.method === "field" ? "Recording booking · cash at the field" : "Recording booking · CliQ") : `Stats (${row.kind}) · CliQ`}
                {row.matchCode ? ` · #${row.matchCode}` : ""}
              </p>
              <p className="text-[11px] text-muted-text">{new Date(row.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Amman" })}</p>
            </div>
            <span className="font-mono text-lg font-bold">{formatJod(row.amountFils)} JOD</span>
            <div className="flex gap-2">
              <button type="button" disabled={review.isPending} onClick={() => void act(row.id, "confirm")} className="flex min-h-10 items-center gap-1 rounded-full bg-floodlight px-3 text-xs font-bold text-void">
                <Check className="h-3.5 w-3.5" />{row.method === "field" ? "Cash received" : "Confirm"}
              </button>
              <button type="button" disabled={review.isPending} onClick={() => void act(row.id, "reject")} className="flex min-h-10 items-center gap-1 rounded-full border border-line px-3 text-xs font-semibold text-muted-text">
                <X className="h-3.5 w-3.5" />{row.method === "field" ? "Didn't pay" : "Reject"}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

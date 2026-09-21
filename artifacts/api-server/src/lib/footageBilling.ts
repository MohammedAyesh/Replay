export type FootageBillingStatus = "done" | "partial" | "failed";

/**
 * Charges whole started hours for a completed request. Partial pulls get a
 * one-minute grace period and are capped at the charge for the requested
 * duration.
 */
export function computeBillableHours(
  status: FootageBillingStatus,
  requestedSeconds: number,
  deliveredSeconds: number | null | undefined = null,
): number {
  if (status === "failed") return 0;

  const requested = Math.max(0, requestedSeconds);
  const doneHours = Math.ceil(requested / 3600);
  if (status === "done") return doneHours;

  const delivered = Math.max(0, Math.min(deliveredSeconds ?? 0, requested));
  return Math.min(doneHours, Math.max(1, Math.ceil((delivered - 60) / 3600)));
}

export function computeAmountFils(billableHours: number, rateFils: number): number {
  return Math.max(0, billableHours) * Math.max(0, rateFils);
}
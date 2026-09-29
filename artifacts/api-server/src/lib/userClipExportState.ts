/**
 * Internal export states stored in the existing text export_status column.
 * They stay "pending" at API boundaries; the extra detail lets other
 * autoscale instances distinguish a vps1 handoff from a local fallback.
 */
export const PENDING_VPS1_OVERFLOW = "pending_vps1_overflow";
export const PENDING_LOCAL_FALLBACK = "pending_local_fallback";
export const PENDING_VPS1_AFTER_PRIMARY = "pending_vps1_after_primary";

const INTERNAL_PENDING_STATES = new Set([
  PENDING_VPS1_OVERFLOW,
  PENDING_LOCAL_FALLBACK,
  PENDING_VPS1_AFTER_PRIMARY,
]);

export function isVps1PendingStatus(status: string | null | undefined): boolean {
  return status === PENDING_VPS1_OVERFLOW || status === PENDING_VPS1_AFTER_PRIMARY;
}

export function isLocalFallbackPendingStatus(status: string | null | undefined): boolean {
  return status === PENDING_LOCAL_FALLBACK;
}

export function isInternalPendingStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && INTERNAL_PENDING_STATES.has(status);
}

export function publicExportStatus(status: string | null | undefined): string | null {
  return status == null ? null : isInternalPendingStatus(status) ? "pending" : status;
}
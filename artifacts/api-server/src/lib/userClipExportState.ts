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

/**
 * Every status that means "a render of this clip has been asked for and has not
 * settled". A row in one of these may still carry the exportedUrl of an older
 * render (an admin re-clip keeps it published until the replacement uploads),
 * so finding that old object reachable is never a reason to mark the row done:
 * the new render's own `done` write only matches these statuses and would then
 * update nothing.
 */
export const RENDER_PENDING_STATUSES: string[] = [
  "pending",
  PENDING_VPS1_OVERFLOW,
  PENDING_LOCAL_FALLBACK,
  PENDING_VPS1_AFTER_PRIMARY,
];

export function isRenderPendingStatus(status: string | null | undefined): boolean {
  return status === "pending" || isInternalPendingStatus(status);
}

export function publicExportStatus(status: string | null | undefined): string | null {
  return status == null ? null : isInternalPendingStatus(status) ? "pending" : status;
}
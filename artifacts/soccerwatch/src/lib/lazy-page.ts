/**
 * Pages load their own code when first opened, so the match page does not
 * download the admin, academy and field consoles first (2026-11-04: the app was
 * one 5.1 MB file, served without compression).
 *
 * After a publish the old chunk files are gone, and the static host answers a
 * missing /assets/*.js with index.html, so an open tab moving to a page it has
 * not loaded yet fails to import it. That tab reloads once to get the new build.
 * It never reloads twice in a minute, so a chunk that really fails cannot loop.
 */
import { lazy, type ComponentType } from "react";

const KEY = "replay.reloadedForChunk";
const MIN_GAP_MS = 60_000;

/** Whether a reload for a missing chunk may happen now; records it when it may. */
export function mayReloadForChunk(now: number, storage: Pick<Storage, "getItem" | "setItem"> | null): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(KEY) ?? 0);
    if (Number.isFinite(last) && now - last < MIN_GAP_MS) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reload the page for a chunk that no longer exists; false when that already happened a moment ago. */
export function reloadForMissingChunk(): boolean {
  if (typeof window === "undefined" || !mayReloadForChunk(Date.now(), sessionStore())) return false;
  window.location.reload();
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().catch((error: unknown) => {
    // Keep the fallback on screen while the page reloads.
    if (reloadForMissingChunk()) return new Promise<{ default: T }>(() => {});
    throw error;
  }));
}

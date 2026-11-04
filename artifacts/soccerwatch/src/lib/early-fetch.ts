/**
 * The match page's first API calls start from index.html, while the app's code
 * is still downloading, instead of after it has run (2026-11-04: /api/m/<code>
 * went out ~1.7 s after the page on a fast link, and /replay, /stats and /clips
 * only after that answered). The inline script there keeps each response here
 * under its URL; the first request the app makes for that URL takes it.
 *
 * Same URL, same cookies and the same moment as the app's own first call (the
 * app also asks before sign-in has loaded), so the answer is the one it would
 * have got. Each response is used at most once, and not after MAX_AGE_MS.
 */

export type EarlyEntry = { at: number; response: Promise<Response> };
export type EarlyStore = Record<string, EarlyEntry>;

declare global {
  interface Window {
    __replayEarly?: EarlyStore;
  }
}

export const EARLY_MAX_AGE_MS = 20_000;

/** The response index.html already asked for, once; null when there is none or it is too old. */
export function takeEarly(url: string, now = Date.now(), store: EarlyStore | undefined = typeof window === "undefined" ? undefined : window.__replayEarly): Promise<Response> | null {
  const hit = store?.[url];
  if (!hit || !store) return null;
  delete store[url];
  if (now - hit.at > EARLY_MAX_AGE_MS) return null;
  return hit.response;
}

/** fetch(url, init), answered by the early request for the same URL when there is one. */
export function fetchEarly(url: string, init: RequestInit = {}): Promise<Response> {
  const isRead = (!init.method || init.method.toUpperCase() === "GET") && init.body == null;
  const early = isRead ? takeEarly(url) : null;
  if (!early) return fetch(url, init);
  // A failed early request is just retried the normal way.
  return early.catch(() => fetch(url, init));
}

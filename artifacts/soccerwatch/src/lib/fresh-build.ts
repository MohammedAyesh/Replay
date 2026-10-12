/**
 * After a publish, browsers keep showing the old app for a while.
 *
 * The published HTML is served as static files with a Last-Modified header and
 * no Cache-Control, so a browser is allowed to reuse its copy without asking
 * ("heuristic freshness"). The old HTML then loads the old JavaScript, and the
 * player sees last week's app until something forces a revalidation. Measured
 * 2026-10-03 on replayjo.com: a normal navigation came straight from the
 * browser cache (transferSize 0) and loaded index-jyup5QbF.js while the server
 * was already serving index-D0NsbHlf.js.
 *
 * So the app checks the live HTML for a newer build once the page has loaded,
 * and again when it comes back to the foreground after a while, and reloads.
 * A reload revalidates the page, so one is enough. It reloads at most once per
 * build, so a server that keeps answering differently can never loop.
 */

const BUNDLE = /\/assets\/index-[\w-]+\.js/;
const KEY = "replay.reloadedForBuild";
const RECHECK_AFTER_MS = 5 * 60 * 1000;

/** The entry bundle a page of HTML loads, e.g. "/assets/index-D0NsbHlf.js". */
export function bundleIn(html: string): string | null {
  return BUNDLE.exec(html)?.[0] ?? null;
}

/** The entry bundle this page is running. */
export function runningBundle(doc: Document = document): string | null {
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const found = bundleIn(new URL(script.src, doc.baseURI).pathname);
    if (found) return found;
  }
  return null;
}

/** Reload only for a different, known build, and never twice for the same one. */
export function shouldReload(running: string | null, live: string | null, alreadyReloadedFor: string | null): boolean {
  return Boolean(running && live && running !== live && alreadyReloadedFor !== live);
}

function readKey(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeKey(value: string): void {
  try {
    window.sessionStorage.setItem(KEY, value);
  } catch {
    // Without storage the guard is the in-memory flag below.
  }
}

let reloading = false;
let lastCheckedAt = 0;
let flushFindBeforeReload: (() => Promise<boolean>) | null = null;

export function mayCheckForBuild(lastChecked: number, now: number): boolean {
  return now - lastChecked >= RECHECK_AFTER_MS;
}

export function isFindPath(pathname: string, base = import.meta.env.BASE_URL || "/"): boolean {
  const prefix = base.replace(/\/+$/, "");
  const path = prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "/" : pathname;
  return /^\/find(?:\/|$)/.test(path);
}

export function registerFindReloadGuard(flush: () => Promise<boolean>): () => void {
  flushFindBeforeReload = flush;
  return () => {
    if (flushFindBeforeReload === flush) flushFindBeforeReload = null;
  };
}

export async function checkForNewBuild(base = import.meta.env.BASE_URL || "/"): Promise<void> {
  if (!import.meta.env.PROD || typeof window === "undefined" || reloading) return;
  const now = Date.now();
  if (!mayCheckForBuild(lastCheckedAt, now)) return;
  lastCheckedAt = now;
  const running = runningBundle();
  if (!running) return;
  try {
    const response = await fetch(base, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return;
    const live = bundleIn(await response.text());
    if (!shouldReload(running, live, readKey())) return;
    if (isFindPath(window.location.pathname)) {
      if (!flushFindBeforeReload || !(await flushFindBeforeReload())) return;
    }
    reloading = true;
    writeKey(live!);
    window.location.reload();
  } catch {
    // Offline or blocked: keep the app that is running.
  }
}

/** Check on startup and when visible again, no more than once every five minutes. */
export function watchForNewBuilds(): void {
  if (!import.meta.env.PROD || typeof window === "undefined") return;
  void checkForNewBuild();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkForNewBuild();
    }
  });
}

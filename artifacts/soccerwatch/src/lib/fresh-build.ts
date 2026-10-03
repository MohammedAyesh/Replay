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
const RECHECK_AFTER_MS = 10 * 60 * 1000;

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

export async function checkForNewBuild(base = import.meta.env.BASE_URL || "/"): Promise<void> {
  if (reloading) return;
  const running = runningBundle();
  if (!running) return;
  try {
    const response = await fetch(base, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return;
    const live = bundleIn(await response.text());
    if (!shouldReload(running, live, readKey())) return;
    reloading = true;
    writeKey(live!);
    window.location.reload();
  } catch {
    // Offline or blocked: keep the app that is running.
  }
}

/** Check now, and again whenever the app returns after ten minutes or more in the background. */
export function watchForNewBuilds(): void {
  if (!import.meta.env.PROD || typeof window === "undefined") return;
  void checkForNewBuild();
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt >= RECHECK_AFTER_MS) {
      void checkForNewBuild();
    }
  });
}

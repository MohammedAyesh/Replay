import { withRedirectPath } from "./auth-redirect";

/**
 * Where "Find yourself" (/find/:id) links in from, and where it leads out to.
 *
 * Every way in passes the match (?match=<code>) when it is known, so the page
 * can pre-select that match, send the finished player to its report, and give
 * the back button somewhere sensible to go when there is no in-app history.
 */

/** /find/<recordingId>, with ?match=<code> when the match is known. */
export function findPath(recordingId: number | string, matchCode?: string | null): string {
  const base = `/find/${recordingId}`;
  return matchCode ? `${base}?match=${encodeURIComponent(matchCode)}` : base;
}

/** The match report, or the player's matches when no match is known. */
export function matchReportPath(matchCode: string | null | undefined): string {
  return matchCode ? `/m/${encodeURIComponent(matchCode)}` : "/matches";
}

/** /sign-in or /sign-up that comes back to `returnTo` (path + query). */
export function authPathWithReturn(kind: "sign-in" | "sign-up", returnTo: string): string {
  return withRedirectPath(`/${kind}`, returnTo);
}

const AUTH_PAGES = ["/sign-in", "/sign-up", "/onboarding", "/consent"];
const OTHER_CLAIM_PAGES = ["/find/", "/find-quick/", "/claim/"];

function isPlaceToGoBackTo(path: string): boolean {
  if (!path.startsWith("/") || path === "/") return false;
  if (AUTH_PAGES.some((page) => path === page || path.startsWith(`${page}/`))) return false;
  return !OTHER_CLAIM_PAGES.some((prefix) => path.startsWith(prefix));
}

export type FindBackTarget = { kind: "history" } | { kind: "path"; path: string };

/**
 * Back/close from /find.
 *
 * History back only when the player got here from another page of the app
 * (not from sign-in or onboarding, which would bounce them straight back, and
 * not from another /find page, which the "Keep going" hand-off leaves
 * behind). Otherwise the match report when the match is known, else their
 * matches.
 */
export function findBackTarget(previousPath: string | null | undefined, matchCode: string | null | undefined): FindBackTarget {
  const previous = previousPath?.split("?")[0] ?? "";
  return isPlaceToGoBackTo(previous) ? { kind: "history" } : { kind: "path", path: matchReportPath(matchCode) };
}

/**
 * The match this /find visit is about: the one asked for in the link, else the
 * single match the saved claim chose, else the recording's only match.
 */
export function resolveFindMatchCode({ requested, choices, matches }: {
  requested: string | null | undefined;
  choices?: string[] | null;
  matches?: Array<{ code: string }> | null;
}): string | null {
  if (requested) return requested;
  if (choices?.length === 1) return choices[0];
  if (matches?.length === 1) return matches[0].code;
  return null;
}

/* ------------------------------------------------------------- nav trail */

let currentPath: string | null = null;
let previousPath: string | null = null;

/** Called by the layout on every in-app navigation. */
export function recordInAppLocation(path: string): void {
  if (path === currentPath) return;
  previousPath = currentPath;
  currentPath = path;
}

/** The in-app page before this one, or null when the app was opened here. */
export function previousInAppLocation(): string | null {
  return previousPath;
}

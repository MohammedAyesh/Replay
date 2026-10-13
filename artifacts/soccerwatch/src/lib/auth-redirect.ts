export function getSafeRedirectPath(value: string | null | undefined, fallback = "/home"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;

  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function getRedirectPathFromSearch(fallback = "/home"): string {
  return getSafeRedirectPath(new URLSearchParams(window.location.search).get("redirect_url"), fallback);
}

export function isParentOnboardingRedirect(path: string): boolean {
  const pathname = path.split(/[?#]/)[0];
  return pathname === "/academy/me" || pathname.startsWith("/p/");
}

export function getPostAuthLanding(explicitRedirect: string | null | undefined, isGuardianOnly: boolean): string {
  if (explicitRedirect) return getSafeRedirectPath(explicitRedirect);
  return isGuardianOnly ? "/academy/me" : "/home";
}

export function rememberExplicitAuthRedirect(): void {
  const params = new URLSearchParams(window.location.search);
  const target = params.get("redirect_url");
  if (!target) return;
  try {
    sessionStorage.setItem("replay-explicit-auth-redirect", getSafeRedirectPath(target));
  } catch {
    // The explicit redirect still goes through Clerk; this marker only guards its default landing.
  }
}

export function consumeExplicitAuthRedirect(target: string): boolean {
  try {
    const explicit = sessionStorage.getItem("replay-explicit-auth-redirect");
    sessionStorage.removeItem("replay-explicit-auth-redirect");
    return explicit === target;
  } catch {
    return false;
  }
}

export function withRedirectPath(path: string, redirectPath: string): string {
  return `${path}?redirect_url=${encodeURIComponent(redirectPath)}`;
}
export function getSafeRedirectPath(value: string | null | undefined, fallback = "/home"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;

  try {
    const origin = typeof window === "undefined" ? "https://replay.local" : window.location.origin;
    const url = new URL(value, origin);
    if (url.origin !== origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function getRedirectPathFromSearch(fallback = "/home"): string {
  return getRedirectPathFromSearchValue(window.location.search, fallback);
}

export function getRedirectPathFromSearchValue(search: string, fallback = "/home"): string {
  return getSafeRedirectPath(new URLSearchParams(search).get("redirect_url"), fallback);
}

export function getLocationWithSearchAndHash(pathname: string, search: string, hash: string): string {
  return `${pathname}${search}${hash}`;
}

export function getIncompleteProfileOnboardingRedirect(pathname: string, search: string, hash: string): string {
  const returnPath = getSafeRedirectPath(getLocationWithSearchAndHash(pathname, search, hash));
  return withRedirectPath("/onboarding", returnPath);
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
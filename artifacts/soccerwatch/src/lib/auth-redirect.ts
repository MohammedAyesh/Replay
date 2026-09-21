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

export function withRedirectPath(path: string, redirectPath: string): string {
  return `${path}?redirect_url=${encodeURIComponent(redirectPath)}`;
}
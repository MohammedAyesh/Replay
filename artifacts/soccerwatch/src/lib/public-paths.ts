const standalonePaths = ["/privacy", "/terms", "/delete-account", "/demo", "/connect/instagram/callback"] as const;

export function isPublicStandalonePath(pathname: string): boolean {
  if (pathname.startsWith("/join/")) return true;
  // A field's public booking website.
  if (pathname.startsWith("/v/")) return true;
  if (pathname.startsWith("/p/")) return true;
  if (pathname.startsWith("/academy/invite/")) return true;
  if (pathname.startsWith("/w/") || pathname.startsWith("/m/") || pathname.startsWith("/f/")) return true;
  return standalonePaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
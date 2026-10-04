const standalonePaths = ["/privacy", "/terms", "/delete-account", "/demo"] as const;

export function isPublicStandalonePath(pathname: string): boolean {
  if (pathname.startsWith("/join/")) return true;
  if (pathname.startsWith("/w/") || pathname.startsWith("/m/") || pathname.startsWith("/f/")) return true;
  return standalonePaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
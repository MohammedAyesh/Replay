/**
 * Hostnames that are Replay itself. Anything else reaching the web app is a field's own
 * domain (see api-server lib/venues/domains.ts) and gets that field's booking website.
 */
const APP_HOSTS = [/(^|\.)replayjo\.com$/, /\.replit\.(app|dev)$/, /\.repl\.co$/, /^localhost$/, /^127\.0\.0\.1$/, /^\[?::1\]?$/, /^\d+\.\d+\.\d+\.\d+$/];

export function isVenueHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const extra = (import.meta.env.VITE_APP_HOSTS as string | undefined)?.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) ?? [];
  if (extra.includes(host)) return false;
  return !APP_HOSTS.some((re) => re.test(host));
}

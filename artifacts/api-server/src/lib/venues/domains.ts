/**
 * A field's own domain for its booking website.
 *
 * The owner points the domain's A record (and www's) at vps1. Caddy on vps1 gets a
 * certificate the first time the domain is visited (on-demand TLS), but only after asking
 * GET /api/venue-site/domain-allowed?domain=…, which says yes for a domain a field has
 * saved. Caddy then proxies everything to replayjo.com, and the web app, seeing a hostname
 * that isn't Replay's, shows that field's website. Set-up script: ops/venue-sites/.
 */
import { promises as dns } from "node:dns";
import { eq } from "drizzle-orm";
import { db, venueSettingsTable } from "@workspace/db";
import { randomBytes } from "node:crypto";
import { normaliseDomain } from "./core";
import { VenueError } from "./store";

export function sitesIp(): string {
  return process.env.VENUE_SITES_IP?.trim() || "169.58.73.17";
}

export async function setDomain(venueId: number, value: string | null): Promise<void> {
  if (!value) {
    await db.update(venueSettingsTable).set({ customDomain: null, domainStatus: "none", domainError: null, domainCheckedAt: null, updatedAt: new Date() })
      .where(eq(venueSettingsTable.academyId, venueId));
    return;
  }
  const domain = normaliseDomain(value);
  if (!domain) throw new VenueError("That doesn't look like a domain. Use something like jordangalaxy.com");
  const bare = domain.replace(/^www\./, "");
  const [taken] = await db.select({ id: venueSettingsTable.academyId, domain: venueSettingsTable.customDomain }).from(venueSettingsTable)
    .where(eq(venueSettingsTable.customDomain, bare));
  if (taken && taken.id !== venueId) throw new VenueError("Another field already uses this domain", 409);
  await db.update(venueSettingsTable).set({
    customDomain: bare,
    domainToken: randomBytes(8).toString("hex"),
    domainStatus: "pending",
    domainError: null,
    domainCheckedAt: null,
    updatedAt: new Date(),
  }).where(eq(venueSettingsTable.academyId, venueId));
}

/** Look the domain up: live when it (and www, if set) points at vps1. */
export async function checkDomain(venueId: number): Promise<{ status: string; error: string | null; found: Record<string, string[]> }> {
  const [row] = await db.select().from(venueSettingsTable).where(eq(venueSettingsTable.academyId, venueId));
  if (!row?.customDomain) return { status: "none", error: null, found: {} };
  const ip = sitesIp();
  const found: Record<string, string[]> = {};
  const look = async (host: string) => {
    try {
      found[host] = await dns.resolve4(host);
    } catch {
      found[host] = [];
    }
  };
  await Promise.all([look(row.customDomain), look(`www.${row.customDomain}`)]);
  const apexOk = found[row.customDomain].includes(ip);
  const wwwOk = found[`www.${row.customDomain}`].includes(ip);
  let status = "pending";
  let error: string | null = null;
  if (apexOk || wwwOk) status = "live";
  else if (found[row.customDomain].length) error = `${row.customDomain} points at ${found[row.customDomain].join(", ")}, not ${ip}`;
  else error = `${row.customDomain} has no A record yet. DNS changes can take up to an hour.`;
  await db.update(venueSettingsTable).set({ domainStatus: status, domainError: error, domainCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(venueSettingsTable.academyId, venueId));
  return { status, error, found };
}

/** Caddy's on-demand TLS question: may we get a certificate for this host? */
export async function domainAllowed(host: string): Promise<boolean> {
  const domain = normaliseDomain(host);
  if (!domain) return false;
  const bare = domain.replace(/^www\./, "");
  const [row] = await db.select({ status: venueSettingsTable.domainStatus, enabled: venueSettingsTable.siteEnabled }).from(venueSettingsTable)
    .where(eq(venueSettingsTable.customDomain, bare));
  return Boolean(row && row.enabled && (row.status === "pending" || row.status === "live"));
}

/**
 * Card / Apple Pay payment links for pitch bookings. Off until a field (or Replay) has a
 * gateway account: Field console → Payments → Card payments.
 *
 * First adapter: PayTabs Hosted Payment Page (Jordan endpoint secure-jordan.paytabs.com).
 *   - POST {endpoint}/payment/request with the server key in `authorization` → redirect_url.
 *   - The callback is never trusted on its own: we ask PayTabs (POST /payment/query by
 *     tran_ref) and mark the booking paid only when it says response_status "A" for the
 *     right cart_id and amount.
 * Not yet run against a live account (none exists as of Nov 2026).
 */
import { eq } from "drizzle-orm";
import { db, venueBookingsTable, type VenueBooking } from "@workspace/db";
import { logger } from "../logger";
import { publicBaseUrl } from "../whatsapp/waha";
import { decryptSecret, encryptSecret, VenueError, type Venue } from "./store";

export type CardConfig = { provider: "paytabs"; profileId: string; serverKey: string; region: string };

const REGIONS: Record<string, string> = {
  jordan: "https://secure-jordan.paytabs.com",
  global: "https://secure-global.paytabs.com",
  uae: "https://secure.paytabs.com",
  ksa: "https://secure.paytabs.sa",
};

export function sealCardConfig(input: { profileId: string; serverKey: string; region?: string }): string {
  const profileId = String(input.profileId ?? "").trim();
  const serverKey = String(input.serverKey ?? "").trim();
  const region = REGIONS[input.region ?? "jordan"] ? (input.region ?? "jordan") : "jordan";
  if (!/^\d{3,12}$/.test(profileId)) throw new VenueError("The PayTabs profile id is a number");
  if (serverKey.length < 10) throw new VenueError("Paste the PayTabs server key");
  return encryptSecret(JSON.stringify({ provider: "paytabs", profileId, serverKey, region }));
}

export function readCardConfig(stored: string | null): CardConfig | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(decryptSecret(stored)) as CardConfig;
    return parsed.provider === "paytabs" ? parsed : null;
  } catch {
    return null;
  }
}

async function paytabs(config: CardConfig, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = REGIONS[config.region] ?? REGIONS.jordan;
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: config.serverKey, "content-type": "application/json" },
    body: JSON.stringify({ profile_id: Number(config.profileId), ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new VenueError(typeof data.message === "string" ? `PayTabs: ${data.message}` : `PayTabs answered ${response.status}`, 502);
  return data;
}

/** A hosted payment page for what is due online on a held booking. */
export async function createCardPayment(venue: Venue, booking: VenueBooking): Promise<{ url: string; ref: string } | null> {
  if (!venue.settings.cardEnabled || venue.settings.cardProvider !== "paytabs") return null;
  const config = readCardConfig(venue.settings.cardConfigEnc);
  if (!config) return null;
  const base = publicBaseUrl();
  const data = await paytabs(config, "/payment/request", {
    tran_type: "sale",
    tran_class: "ecom",
    cart_id: booking.reference,
    cart_currency: "JOD",
    cart_amount: Number((booking.dueOnlineFils / 1000).toFixed(3)),
    cart_description: `${venue.name} — ${booking.startLocal}`,
    hide_shipping: true,
    customer_details: {
      name: booking.customerName || "Player",
      phone: booking.customerPhone ? `+${booking.customerPhone}` : undefined,
      country: "JO",
    },
    callback: `${base}/api/venue-pay/paytabs/callback`,
    return: `${base}/api/venue-pay/paytabs/return?ref=${encodeURIComponent(booking.reference)}`,
  });
  const url = typeof data.redirect_url === "string" ? data.redirect_url : null;
  const ref = typeof data.tran_ref === "string" ? data.tran_ref : null;
  if (!url || !ref) throw new VenueError("PayTabs didn't return a payment page", 502);
  return { url, ref };
}

/** Ask PayTabs what happened to a transaction. Paid only when approved for the right booking and amount. */
export async function verifyCardPayment(venue: Venue, booking: VenueBooking, tranRef: string): Promise<"paid" | "pending" | "failed"> {
  const config = readCardConfig(venue.settings.cardConfigEnc);
  if (!config) return "pending";
  try {
    const data = await paytabs(config, "/payment/query", { tran_ref: tranRef });
    const result = (data.payment_result ?? {}) as { response_status?: string };
    const amount = Math.round(Number(data.cart_amount) * 1000);
    if (data.cart_id !== booking.reference) return "failed";
    if (result.response_status === "A" && amount >= booking.dueOnlineFils) return "paid";
    if (result.response_status && result.response_status !== "H" && result.response_status !== "P") return "failed";
    return "pending";
  } catch (error) {
    logger.warn({ bookingId: booking.id, error: (error as Error).message }, "PayTabs query failed");
    return "pending";
  }
}

export async function bookingByReference(reference: string): Promise<VenueBooking | null> {
  const [row] = await db.select().from(venueBookingsTable).where(eq(venueBookingsTable.reference, reference));
  return row ?? null;
}

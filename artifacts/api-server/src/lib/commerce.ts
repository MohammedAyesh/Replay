import { getAllSettings, type SettingsContext } from "./settings";

/**
 * Every price and commercial switch, resolved for one request.
 *
 * Prices live in the settings registry (Admin → Settings → Pricing / Bookings /
 * Match stats) in JOD, so an admin can change them — or scope them to a field, a
 * user, or an off-peak window with a rule — without a deploy. Everything else in
 * the code works in integer fils, so the conversion happens once, here.
 */
export interface Commerce {
  playerBookingFilsPerHour: number;
  ownerFootageFilsPerHour: number;
  statsMatchFils: number;
  statsTeamPerPlayerFils: number;
  statsMonthlyFils: number;
  cliqAlias: string;
  bookingEnabled: boolean;
  payAtField: boolean;
  bookingMaxDaysAhead: number;
  bookingMaxAwaiting: number;
  bookingMaxMinutes: number;
  statsEnabled: boolean;
  statsPaywall: boolean;
  statsTeamPack: boolean;
  statsMonthly: boolean;
}

export function jodToFils(value: unknown, fallbackFils: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallbackFils;
  return Math.round(n * 1000);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export async function loadCommerce(ctx: SettingsContext = {}): Promise<Commerce> {
  const all = await getAllSettings(ctx);
  const alias = typeof all["payments.cliqAlias"] === "string" ? (all["payments.cliqAlias"] as string).trim() : "";
  return {
    playerBookingFilsPerHour: jodToFils(all["pricing.playerBookingPerHour"], 2000),
    ownerFootageFilsPerHour: jodToFils(all["pricing.ownerFootagePerHour"], 1000),
    statsMatchFils: jodToFils(all["pricing.statsPerMatch"], 500),
    statsTeamPerPlayerFils: jodToFils(all["pricing.statsTeamPerPlayer"], 500),
    statsMonthlyFils: jodToFils(all["pricing.statsMonthly"], 2000),
    cliqAlias: alias || process.env.REPLAY_CLIQ_ALIAS || "REPLAYJO",
    bookingEnabled: bool(all["booking.enabled"], true),
    payAtField: bool(all["booking.payAtFieldEnabled"], true),
    bookingMaxDaysAhead: Math.max(1, int(all["booking.maxDaysAhead"], 14)),
    bookingMaxAwaiting: Math.max(1, int(all["booking.maxAwaitingPayment"], 3)),
    bookingMaxMinutes: Math.max(30, int(all["booking.maxMinutes"], 180)),
    statsEnabled: bool(all["stats.enabled"], false),
    statsPaywall: bool(all["stats.paywallEnabled"], false),
    statsTeamPack: bool(all["stats.teamPackEnabled"], true),
    statsMonthly: bool(all["stats.monthlyEnabled"], true),
  };
}

/** Per started hour; a booking of any length costs at least one hour. */
export function bookingPriceFils(durationSeconds: number, filsPerHour: number): number {
  return Math.max(1, Math.ceil(durationSeconds / 3600)) * filsPerHour;
}

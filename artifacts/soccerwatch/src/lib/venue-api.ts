import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Field console client for routes/venueConsole.ts (and the admin part of venueAdmin.ts). */

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export async function venueCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const body = data as { error?: unknown; code?: unknown } | null;
    throw new ApiError(typeof body?.error === "string" ? body.error : `Request failed (${response.status})`, response.status, typeof body?.code === "string" ? body.code : undefined);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// ─── Types ───────────────────────────────────────────────────────────────────

export type DayHours = { open: string; close: string } | null;
export type OpeningHours = Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours>;
export type PriceRule = { days: number[]; from: string; to: string; pricePerHourFils: number };

export type Membership = { academyId: number; academyName: string; roles: string[] };
export type Memberships = { memberships: Membership[]; ownedFields: Array<{ fieldId: number; name: string }>; canSetUp: boolean };

export type Booking = {
  id: number;
  pitchId: number;
  pitchName: string | null;
  pitchNameAr: string | null;
  startLocal: string;
  endLocal: string;
  minutes: number;
  status: "held" | "confirmed" | "cancelled" | "completed" | "no_show";
  paymentStatus: "unpaid" | "receipt" | "paid" | "refunded" | "waived";
  payWith: "cliq" | "field" | "card" | "none";
  moneyTo: "venue" | "replay";
  amountFils: number;
  dueOnlineFils: number;
  paidFils: number;
  balanceFils: number;
  feeFils: number;
  feeReason: "late_cancel" | "no_show" | "change" | null;
  refundDueFils: number;
  refundedFils: number;
  changeCount: number;
  cancelledBy: "player" | "field" | "system" | null;
  depositReason: "standard" | "new_customer" | "no_show";
  reference: string;
  customerName: string | null;
  customerPhone: string | null;
  contactId: number | null;
  teamName: string | null;
  notes: string | null;
  source: "console" | "whatsapp" | "website" | "app";
  seriesId: string | null;
  holdExpiresAt: string | null;
  footageRequestId: number | null;
  footageNote: string | null;
  receiptUrl: string | null;
  receiptCheck: null | {
    isReceipt: boolean | null; amountFils: number | null; receiver: string | null; referenceFound: boolean | null;
    amountOk: boolean; receiverOk: boolean; referenceOk: boolean; note: string | null; autoConfirmed: boolean;
  };
  cardUrl: string | null;
  cancelReason: string | null;
  igConsent?: "yes" | "no" | null;
  igConsentSource?: string | null;
  under18?: boolean;
  createdAt: string;
  venueName?: string;
  venueId?: number;
};

export type Pitch = {
  id: number;
  name: string;
  nameAr: string | null;
  size: string;
  surface: string | null;
  indoor: boolean;
  fieldId: number | null;
  hasCamera: boolean;
  recordBookings: boolean;
  pricePerHourFils: number;
  priceRules: PriceRule[];
  imageUrl: string | null;
  active: boolean;
  sortOrder: number;
};

export type Rules = {
  bookingEnabled: boolean;
  openingHours: OpeningHours;
  slotStepMinutes: number;
  durations: number[];
  maxDaysAhead: number;
  minNoticeMinutes: number;
  holdMinutes: number;
};

export type Dashboard = {
  venue: { id: number; name: string; nameAr: string | null; logoUrl: string | null };
  settings: { slug: string; agentMode: "off" | "ai" | "menu"; moneyTo: "venue" | "replay"; bookingEnabled: boolean; siteUrl: string; customDomain: string | null; domainStatus: string };
  pitchCount: number;
  today: Booking[];
  month: { bookings: number; revenue: number; collected: number; minutes: number; noShows: number; online: number; occupancy: number };
  attention: { receipts: number; held: number; handovers: number };
  isOwner: boolean;
};

export type Slot = { startLocal: string; endsByLocal: string; available: boolean; options: Array<{ minutes: number; priceFils: number; available: boolean }> };
export type PitchSlots = { pitchId: number; name: string; nameAr: string | null; size: string; slots: Slot[] };

export type Customer = {
  contactId: number | null; phone: string; display: string; name: string | null; kind: string; stage: string | null; tags: string[];
  bookings: number; lastStartLocal: string | null; nextStartLocal: string | null; spentFils: number; noShows: number; cancelled: number; owedFils: number;
  segment: "lead" | "new" | "returning" | "regular" | "lapsed";
};

export type Automations = {
  confirmed: { enabled: boolean }; paid: { enabled: boolean }; cancelled: { enabled: boolean };
  expiring: { enabled: boolean }; reminder: { enabled: boolean; hours: number }; videoReady: { enabled: boolean };
};

export type AgentData = {
  settings: { agentMode: "off" | "ai" | "menu"; agentName: string | null; agentNotes: string | null; agentPauseMinutes: number; automations: Automations };
  aiAvailable: boolean;
  stats: { chats30d: number; handovers: number; bookings30d: number; bookedFils30d: number };
  threads: Array<{ phone: string; display: string; lastInAt: string | null; pausedUntil: string | null; handoverAt: string | null; turns: number }>;
  isOwner: boolean;
};

export type BookingRules = {
  acceptCliq: boolean;
  depositPercent: number;
  newCustomerPolicy: "same" | "deposit" | "full";
  noShowPolicy: "same" | "deposit" | "full" | "block";
  lateCancelMode: "refuse" | "free" | "deposit" | "percent" | "fixed";
  lateCancelValue: number;
  noShowFeeMode: "none" | "deposit" | "percent" | "fixed";
  noShowFeeValue: number;
  allowChanges: boolean;
  changeHours: number;
  changeFeeFils: number;
  maxChanges: number;
};

export type PaymentsData = {
  settings: {
    moneyTo: "venue" | "replay"; cliqAlias: string | null; cliqName: string | null; payAtField: boolean; depositMode: "full" | "deposit" | "none"; depositFils: number;
    cancelHours: number; autoConfirmReceipts: boolean; cardProvider: string; cardEnabled: boolean; cardConfigured: boolean; replayFeeBps: number;
  } & BookingRules;
  preview: { en: string[]; ar: string[] };
  ledger: {
    refundsToSendFils: number; refundsToSendCount: number; feesOwedFils: number; feesOwedCount: number;
    collectedThisMonthFils: number; onlineThisMonthFils: number; unpaidAfterPlayFils: number; viaReplayFils: number; replayFeeFils: number; paidOutFils: number; owedByReplayFils: number;
    payouts: Array<{ id: number; amountFils: number; method: string; note: string | null; createdAt: string }>;
  };
};

export type WebsiteData = {
  settings: {
    slug: string; siteEnabled: boolean; siteTagline: string | null; siteTaglineAr: string | null; siteAbout: string | null; siteAboutAr: string | null;
    heroImageUrl: string | null; accentColor: string | null; siteUrl: string;
    customDomain: string | null; domainStatus: "none" | "pending" | "live" | "error"; domainError: string | null; domainCheckedAt: string | null;
  };
  dns: { type: string; value: string; hosts: string[] };
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

const v = (venueId: number) => `/academy/console/academies/${venueId}/venue`;

export function useVenueMemberships(enabled = true) {
  return useQuery({ queryKey: ["venue-memberships"], queryFn: () => venueCall<Memberships>("/venue/console/memberships"), enabled, retry: false });
}

export function useSetUpVenue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => venueCall<{ academyId: number }>("/venue/console/setup", { method: "POST", ...json({}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["venue-memberships"] }),
  });
}

export function useVenueDashboard(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "dashboard"], queryFn: () => venueCall<Dashboard>(`${v(venueId)}/dashboard`), refetchInterval: 60_000 });
}

export function useBookings(venueId: number, from: string, to: string) {
  return useQuery({
    queryKey: ["venue", venueId, "bookings", from, to],
    queryFn: () => venueCall<{ from: string; to: string; bookings: Booking[]; pitches: Pitch[]; igConsentMode?: "ask" | "owner" | "off" }>(`${v(venueId)}/bookings?from=${from}&to=${to}`),
    refetchInterval: 30_000,
  });
}

export function useAttention(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "bookings", "attention"], queryFn: () => venueCall<{ bookings: Booking[] }>(`${v(venueId)}/bookings/attention`), refetchInterval: 30_000 });
}

export function useAvailability(venueId: number, date: string, enabled = true) {
  return useQuery({ queryKey: ["venue", venueId, "availability", date], queryFn: () => venueCall<{ date: string; pitches: PitchSlots[] }>(`${v(venueId)}/availability?date=${date}`), enabled });
}

function useInvalidate(venueId: number) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["venue", venueId] });
}

export type NewBooking = {
  pitchId: number; startLocal: string; minutes: number; customerName?: string | null; customerPhone?: string | null; teamName?: string | null; notes?: string | null;
  payWith: "none" | "field" | "cliq" | "card"; repeatWeeks?: number; amountFils?: number | null; paid?: boolean; notify?: boolean;
  /** Instagram consent from the front desk; under-18 is never posted. */
  igConsent?: boolean | null; under18?: boolean;
};

export function useCreateBooking(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: (body: NewBooking) => venueCall<{ bookings: Booking[] }>(`${v(venueId)}/bookings`, { method: "POST", ...json(body) }), onSuccess: refresh });
}

export function useEditBooking(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Partial<Omit<NewBooking, "igConsent">> & { igConsent?: "yes" | "no" | null }) => venueCall<{ booking: Booking }>(`${v(venueId)}/bookings/${id}`, { method: "PATCH", ...json(body) }),
    onSuccess: refresh,
  });
}

export type BookingAction = "confirm-payment" | "collect-balance" | "confirm-hold" | "reject-receipt" | "cancel" | "complete" | "no-show" | "reopen" | "resend" | "refund-sent" | "fee-collected" | "waive-fee";

export function useBookingAction(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; action: BookingAction; reason?: string; notify?: boolean; series?: boolean; byPlayer?: boolean }) =>
      venueCall<{ booking: Booking }>(`${v(venueId)}/bookings/${id}/action`, { method: "POST", ...json(body) }),
    onSuccess: refresh,
  });
}

export function useCustomers(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "customers"], queryFn: () => venueCall<{ customers: Customer[] }>(`${v(venueId)}/customers`) });
}

export function usePitches(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "pitches"], queryFn: () => venueCall<{ pitches: Pitch[]; fields: Array<{ id: number; name: string; hasCamera: boolean }>; rules: Rules; isOwner: boolean }>(`${v(venueId)}/pitches`) });
}

export function useSavePitch(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Pitch> & { id?: number }) => id
      ? venueCall<{ pitch: Pitch }>(`${v(venueId)}/pitches/${id}`, { method: "PATCH", ...json(body) })
      : venueCall<{ pitch: Pitch }>(`${v(venueId)}/pitches`, { method: "POST", ...json(body) }),
    onSuccess: refresh,
  });
}

export function useDeletePitch(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: (id: number) => venueCall<{ deleted?: boolean; archived?: boolean }>(`${v(venueId)}/pitches/${id}`, { method: "DELETE" }), onSuccess: refresh });
}

export function useSaveRules(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: (body: Partial<Rules>) => venueCall(`${v(venueId)}/pitches/rules`, { method: "PUT", ...json(body) }), onSuccess: refresh });
}

export function usePayments(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "payments"], queryFn: () => venueCall<PaymentsData>(`${v(venueId)}/payments`) });
}

export function useSavePayments(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: (body: Partial<PaymentsData["settings"]>) => venueCall(`${v(venueId)}/payments`, { method: "PUT", ...json(body) }), onSuccess: refresh });
}

export function useSaveCard(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({
    mutationFn: (body: { provider: "paytabs"; profileId?: string; serverKey?: string; region?: string; enabled: boolean } | null) => body
      ? venueCall(`${v(venueId)}/payments/card`, { method: "PUT", ...json(body) })
      : venueCall(`${v(venueId)}/payments/card`, { method: "DELETE" }),
    onSuccess: refresh,
  });
}

export function useAgent(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "agent"], queryFn: () => venueCall<AgentData>(`${v(venueId)}/agent`), refetchInterval: 60_000 });
}

export function useSaveAgent(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: (body: Partial<AgentData["settings"]>) => venueCall(`${v(venueId)}/agent`, { method: "PUT", ...json(body) }), onSuccess: refresh });
}

export function useThreadAction(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({
    mutationFn: ({ phone, action }: { phone: string; action: "resume" | "pause" }) => venueCall(`${v(venueId)}/agent/threads/${phone}/${action}`, { method: "POST", ...json({}) }),
    onSuccess: refresh,
  });
}

export function useWebsite(venueId: number) {
  return useQuery({ queryKey: ["venue", venueId, "website"], queryFn: () => venueCall<WebsiteData>(`${v(venueId)}/website`) });
}

export function useSaveWebsite(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: (body: Partial<WebsiteData["settings"]>) => venueCall(`${v(venueId)}/website`, { method: "PUT", ...json(body) }), onSuccess: refresh });
}

export function useSaveDomain(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({
    mutationFn: (domain: string | null) => venueCall<{ status: string; error: string | null }>(`${v(venueId)}/website/domain`, { method: "PUT", ...json({ domain }) }),
    onSuccess: refresh,
  });
}

export function useCheckDomain(venueId: number) {
  const refresh = useInvalidate(venueId);
  return useMutation({ mutationFn: () => venueCall<{ status: string; error: string | null }>(`${v(venueId)}/website/domain/check`, { method: "POST", ...json({}) }), onSuccess: refresh });
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export type AdminVenue = {
  id: number; name: string; fieldId: number; slug: string | null; moneyTo: string; agentMode: string; customDomain: string | null; domainStatus: string;
  replayFeeBps: number; owners: Array<{ email: string; name: string | null }>; bookings: number; toConfirm: number; viaReplayFils: number; feeFils: number; paidOutFils: number; owedFils: number;
};

export function useAdminVenues() {
  return useQuery({ queryKey: ["admin-venues"], queryFn: () => venueCall<{ venues: AdminVenue[] }>("/admin/venues") });
}

export function useAdminVenuePayments() {
  return useQuery({ queryKey: ["admin-venues", "payments"], queryFn: () => venueCall<{ bookings: Booking[] }>("/admin/venues/payments"), refetchInterval: 60_000 });
}

export function useAdminVenueMutations() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-venues"] });
  return {
    create: useMutation({ mutationFn: (body: { name: string; fieldIds: number[]; ownerEmail: string }) => venueCall("/admin/venues", { method: "POST", ...json(body) }), onSuccess: refresh }),
    fee: useMutation({ mutationFn: ({ id, replayFeeBps }: { id: number; replayFeeBps: number }) => venueCall(`/admin/venues/${id}`, { method: "PATCH", ...json({ replayFeeBps }) }), onSuccess: refresh }),
    payment: useMutation({ mutationFn: ({ id, action }: { id: number; action: "confirm" | "reject" }) => venueCall(`/admin/venues/bookings/${id}/${action}`, { method: "POST", ...json({}) }), onSuccess: refresh }),
    payout: useMutation({ mutationFn: ({ id, amountFils, note }: { id: number; amountFils: number; note?: string }) => venueCall(`/admin/venues/${id}/payouts`, { method: "POST", ...json({ amountFils, note }) }), onSuccess: refresh }),
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function jod(fils: number, locale: "ar" | "en"): string {
  const n = fils / 1000;
  const text = new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", { maximumFractionDigits: 3, minimumFractionDigits: 0 }).format(n);
  return locale === "ar" ? `${text} د.أ` : `${text} JOD`;
}

export function ammanToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function minutesOf(local: string): number {
  const [h, m] = local.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
}

export function clock(local: string, locale: "ar" | "en"): string {
  const [h, m] = local.slice(11, 16).split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h >= 12 ? (locale === "ar" ? "م" : "pm") : (locale === "ar" ? "ص" : "am")}`;
}

export function dayName(date: string, locale: "ar" | "en", style: "long" | "short" = "short"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", { weekday: style, day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

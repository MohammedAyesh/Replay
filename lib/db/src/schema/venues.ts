import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyContactsTable } from "./academyWhatsapp";
import { fieldsTable } from "./fields";
import { footageRequestsTable } from "./footageRequests";
import { usersTable } from "./users";

/**
 * Field console. A field business (a "venue") is an `academies` row with kind = 'venue', so it
 * gets the academy console's team, chats, people, WhatsApp, ads, social, creative and branding
 * as they are. What only a field has lives here: pitches, pitch bookings, how players pay,
 * the WhatsApp booking agent and the public booking website (on replayjo.com/v/<slug> or the
 * field's own domain).
 */
export const venueSettingsTable = pgTable("venue_settings", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** The website's address on Replay: replayjo.com/v/<slug>. */
  slug: text("slug").notNull(),
  bookingEnabled: boolean("booking_enabled").notNull().default(true),
  /** Weekday (0 = Sunday) → { open: "HH:MM", close: "HH:MM" }; a close at or before open runs past midnight. A missing day is closed. */
  openingHours: jsonb("opening_hours").notNull().default(sql`'{}'::jsonb`),
  /** Kick-off times are on this step (minutes). */
  slotStepMinutes: integer("slot_step_minutes").notNull().default(30),
  /** Lengths a player may book, in minutes. */
  durations: jsonb("durations").notNull().default(sql`'[60, 90, 120]'::jsonb`),
  maxDaysAhead: integer("max_days_ahead").notNull().default(14),
  minNoticeMinutes: integer("min_notice_minutes").notNull().default(30),
  /** An unpaid online booking holds its slot this long, then lapses. */
  holdMinutes: integer("hold_minutes").notNull().default(30),
  /** Who receives the money: the field's own CliQ, or Replay's (Replay then pays the field out). */
  moneyTo: text("money_to").notNull().default("venue"),
  cliqAlias: text("cliq_alias"),
  /** The name a CliQ receipt shows for the receiver; the receipt check compares against it. */
  cliqName: text("cliq_name"),
  payAtField: boolean("pay_at_field").notNull().default(true),
  /** full: the whole price online. deposit: depositFils online, the rest at the field. none: nothing online. */
  depositMode: text("deposit_mode").notNull().default("full"),
  depositFils: integer("deposit_fils").notNull().default(0),
  /** A player may cancel up to this many hours before kick-off. */
  cancelHours: integer("cancel_hours").notNull().default(6),
  /** Mark a booking paid when the receipt check matches amount, receiver and reference. Off: the owner taps Confirm. */
  autoConfirmReceipts: boolean("auto_confirm_receipts").notNull().default(false),
  /** Payments the field takes: CliQ online (cash at the field is payAtField, cards are cardEnabled). */
  acceptCliq: boolean("accept_cliq").notNull().default(true),
  /** Deposit as a share of the price (whole percent); 0 = use depositFils. */
  depositPercent: integer("deposit_percent").notNull().default(0),
  /** Someone who has never played here: same as everyone, a deposit online, or the full price online. */
  newCustomerPolicy: text("new_customer_policy").notNull().default("same"),
  /** Someone with a no-show here: same, deposit, full, or block (can't book online). */
  noShowPolicy: text("no_show_policy").notNull().default("same"),
  /** A player cancelling inside cancelHours: refuse (ask the field), free, keep the deposit, a percent or a fixed fee. */
  lateCancelMode: text("late_cancel_mode").notNull().default("refuse"),
  /** Percent (whole) or fils, by lateCancelMode. */
  lateCancelValue: integer("late_cancel_value").notNull().default(0),
  /** A no-show: no fee, keep the deposit, a percent or a fixed fee. */
  noShowFeeMode: text("no_show_fee_mode").notNull().default("deposit"),
  noShowFeeValue: integer("no_show_fee_value").notNull().default(0),
  /** Players may move their own booking up to changeHours before kick-off, at most maxChanges times, for changeFeeFils each. */
  allowChanges: boolean("allow_changes").notNull().default(true),
  changeHours: integer("change_hours").notNull().default(6),
  changeFeeFils: integer("change_fee_fils").notNull().default(0),
  maxChanges: integer("max_changes").notNull().default(2),
  /** Replay's cut of bookings paid to Replay (basis points). Admin-only. */
  replayFeeBps: integer("replay_fee_bps").notNull().default(0),
  /** Card / Apple Pay payment links. Off until a gateway account exists. */
  cardProvider: text("card_provider").notNull().default("none"),
  cardEnabled: boolean("card_enabled").notNull().default(false),
  /** AES-GCM encrypted JSON of the gateway credentials. Never returned to the browser. */
  cardConfigEnc: text("card_config_enc"),
  /** WhatsApp booking agent: off, ai (free text, Claude) or menu (numbered menus). */
  agentMode: text("agent_mode").notNull().default("off"),
  agentName: text("agent_name"),
  /** What the owner wants the agent to know: rules, FAQ, directions, offers. */
  agentNotes: text("agent_notes"),
  /** After someone from the field replies in a chat, the agent stays quiet this long. */
  agentPauseMinutes: integer("agent_pause_minutes").notNull().default(120),
  /** Booking messages: { confirmed, reminder: { hours }, paid, cancelled, expiring, videoReady } each { enabled }. */
  automations: jsonb("automations").notNull().default(sql`'{}'::jsonb`),
  siteEnabled: boolean("site_enabled").notNull().default(true),
  siteTagline: text("site_tagline"),
  siteTaglineAr: text("site_tagline_ar"),
  siteAbout: text("site_about"),
  siteAboutAr: text("site_about_ar"),
  heroImageUrl: text("hero_image_url"),
  accentColor: text("accent_color"),
  /** The field's own domain ("jordangalaxy.com"), served through vps1's Caddy. */
  customDomain: text("custom_domain"),
  domainToken: text("domain_token"),
  domainStatus: text("domain_status").notNull().default("none"),
  domainCheckedAt: timestamp("domain_checked_at", { withTimezone: true }),
  domainError: text("domain_error"),
  /**
   * Instagram consent (Admin → Field consoles, admin only; the owner sees it):
   * ask   — Replay asks the captain in every booking flow; the answer is on the booking.
   * owner — the field collects consent itself (signage, its own terms, the front desk);
   *         bookings count as consented unless the front desk marks one "no".
   * off   — nothing from this field is posted. The default.
   */
  igConsentMode: text("ig_consent_mode").notNull().default("off"),
  igConsentSince: timestamp("ig_consent_since", { withTimezone: true }),
  igConsentBy: integer("ig_consent_by").references(() => usersTable.id, { onDelete: "set null" }),
  /** Owner mode: the field's own consent wording, pasted by the admin. */
  igConsentWording: text("ig_consent_wording"),
  /** Instagram autopilot on for this field (the owner's switch; posts only within the consent mode). */
  igAutopilot: boolean("ig_autopilot").notNull().default(false),
  /** approve: every post waits for the owner's OK. auto: posts go out at their slot. */
  igPublishMode: text("ig_publish_mode").notNull().default("approve"),
  /** Calendar times: { storyEveryHours, reelTimes: ["HH:MM"], quietFrom, quietTo, … } (lib/venues/igCalendar.ts). */
  igSlots: jsonb("ig_slots").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_settings_slug_unique").on(table.slug),
  check("venue_settings_ig_consent_mode_check", sql`${table.igConsentMode} in ('ask', 'owner', 'off')`),
  check("venue_settings_ig_publish_mode_check", sql`${table.igPublishMode} in ('approve', 'auto')`),
  uniqueIndex("venue_settings_custom_domain_unique").on(table.customDomain).where(sql`${table.customDomain} is not null`),
  check("venue_settings_money_to_check", sql`${table.moneyTo} in ('venue', 'replay')`),
  check("venue_settings_deposit_mode_check", sql`${table.depositMode} in ('full', 'deposit', 'none')`),
  check("venue_settings_card_provider_check", sql`${table.cardProvider} in ('none', 'paytabs')`),
  check("venue_settings_agent_mode_check", sql`${table.agentMode} in ('off', 'ai', 'menu')`),
  check("venue_settings_domain_status_check", sql`${table.domainStatus} in ('none', 'pending', 'live', 'error')`),
]);

/** A bookable pitch. A pitch with a Replay camera points at its `fields` row and records its bookings. */
export const venuePitchesTable = pgTable("venue_pitches", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  nameAr: text("name_ar"),
  /** Players a side: "5", "6", "7", "8", "11". */
  size: text("size").notNull().default("5"),
  surface: text("surface"),
  indoor: boolean("indoor").notNull().default(false),
  fieldId: integer("field_id").references(() => fieldsTable.id, { onDelete: "set null" }),
  /** Book Replay's camera for every booking on this pitch (billed on the owner's footage ledger). */
  recordBookings: boolean("record_bookings").notNull().default(true),
  pricePerHourFils: integer("price_per_hour_fils").notNull().default(20000),
  /** Peak / off-peak prices: [{ days: [0..6], from: "HH:MM", to: "HH:MM", pricePerHourFils }]. The first match wins. */
  priceRules: jsonb("price_rules").notNull().default(sql`'[]'::jsonb`),
  imageUrl: text("image_url"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("venue_pitches_academy_idx").on(table.academyId),
]);

export const venueBookingsTable = pgTable("venue_bookings", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  pitchId: integer("pitch_id").notNull().references(() => venuePitchesTable.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  /** Amman wall time, "YYYY-MM-DD HH:MM", as the camera and the footage ledger use it. */
  startLocal: text("start_local").notNull(),
  endLocal: text("end_local").notNull(),
  /** held: waiting for payment. confirmed: the slot is theirs. */
  status: text("status").notNull().default("held"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  payWith: text("pay_with").notNull().default("cliq"),
  moneyTo: text("money_to").notNull().default("venue"),
  amountFils: integer("amount_fils").notNull().default(0),
  /** What is due online (the whole price or the deposit). */
  dueOnlineFils: integer("due_online_fils").notNull().default(0),
  paidFils: integer("paid_fils").notNull().default(0),
  /** Quoted in the CliQ transfer note so the payment can be matched: "JG-4F7K2Q". */
  reference: text("reference").notNull(),
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  contactId: integer("contact_id").references(() => academyContactsTable.id, { onDelete: "set null" }),
  teamName: text("team_name"),
  notes: text("notes"),
  source: text("source").notNull().default("console"),
  /** Weekly regulars: bookings made together share a series. */
  seriesId: text("series_id"),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  footageRequestId: integer("footage_request_id").references(() => footageRequestsTable.id, { onDelete: "set null" }),
  /** Why the camera wasn't booked for this booking, when it wasn't. */
  footageNote: text("footage_note"),
  /** When the booker was sent the link to the recording. */
  videoSentAt: timestamp("video_sent_at", { withTimezone: true }),
  /** Reminder sent before kick-off. */
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  /** The receipt screenshot (Bunny Storage path) and what the check read off it. */
  receiptPath: text("receipt_path"),
  receiptCheck: jsonb("receipt_check"),
  /** Late-cancel, no-show and change fees charged on this booking. */
  feeFils: integer("fee_fils").notNull().default(0),
  feeReason: text("fee_reason"),
  /** Money paid that has to go back (a free cancellation, a cheaper move), and what went back. */
  refundDueFils: integer("refund_due_fils").notNull().default(0),
  refundedFils: integer("refunded_fils").notNull().default(0),
  changeCount: integer("change_count").notNull().default(0),
  /** The field's rules when this was booked: a later change of rules doesn't touch it. */
  policy: jsonb("policy"),
  /** field, player or system (an unpaid hold that lapsed). */
  cancelledBy: text("cancelled_by"),
  cardRef: text("card_ref"),
  cardUrl: text("card_url"),
  /** Instagram: yes / no as the captain or the front desk answered; null when nobody was asked. */
  igConsent: text("ig_consent"),
  /** captain_web · captain_whatsapp · staff · owner_default · removal (a player asked to take it down) */
  igConsentSource: text("ig_consent_source"),
  igConsentAt: timestamp("ig_consent_at", { withTimezone: true }),
  /** Players under 18 in this booking: never posted, whatever the consent. */
  under18: boolean("under_18").notNull().default(false),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidBy: integer("paid_by").references(() => usersTable.id, { onDelete: "set null" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_bookings_reference_unique").on(table.reference),
  index("venue_bookings_pitch_time_idx").on(table.pitchId, table.startsAt),
  index("venue_bookings_academy_time_idx").on(table.academyId, table.startsAt),
  index("venue_bookings_academy_phone_idx").on(table.academyId, table.customerPhone),
  check("venue_bookings_status_check", sql`${table.status} in ('held', 'confirmed', 'cancelled', 'completed', 'no_show')`),
  check("venue_bookings_payment_status_check", sql`${table.paymentStatus} in ('unpaid', 'receipt', 'paid', 'refunded', 'waived')`),
  check("venue_bookings_pay_with_check", sql`${table.payWith} in ('cliq', 'field', 'card', 'none')`),
  check("venue_bookings_money_to_check", sql`${table.moneyTo} in ('venue', 'replay')`),
  check("venue_bookings_source_check", sql`${table.source} in ('console', 'whatsapp', 'website', 'app')`),
  check("venue_bookings_ig_consent_check", sql`${table.igConsent} is null or ${table.igConsent} in ('yes', 'no')`),
]);

/** The booking agent's memory of one WhatsApp chat: the booking it is putting together, the menu step, and when it last spoke. */
export const venueAgentThreadsTable = pgTable("venue_agent_threads", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  phone: text("phone").notNull(),
  state: jsonb("state").notNull().default(sql`'{}'::jsonb`),
  /** The agent stays quiet until this time (a person from the field took the chat). */
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  /** Asked for a person: shown in Chats until someone replies. */
  handoverAt: timestamp("handover_at", { withTimezone: true }),
  turns: integer("turns").notNull().default(0),
  lastInAt: timestamp("last_in_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_agent_threads_academy_phone_unique").on(table.academyId, table.phone),
]);

/** Money Replay passed on to a field for bookings paid to Replay's CliQ. */
export const venuePayoutsTable = pgTable("venue_payouts", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  amountFils: integer("amount_fils").notNull(),
  method: text("method").notNull().default("cliq"),
  note: text("note"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("venue_payouts_academy_idx").on(table.academyId),
]);

export type VenueSettings = typeof venueSettingsTable.$inferSelect;
export type VenuePitch = typeof venuePitchesTable.$inferSelect;
export type VenueBooking = typeof venueBookingsTable.$inferSelect;
export type VenueAgentThread = typeof venueAgentThreadsTable.$inferSelect;

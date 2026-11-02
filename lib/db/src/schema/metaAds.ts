import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyContactsTable } from "./academyWhatsapp";
import { usersTable } from "./users";

/**
 * Campaigns in Replay's Meta ad account, synced from the Marketing API. An admin
 * assigns each to the academy it advertises; leads from its ads go to that academy.
 */
export const metaAdCampaignsTable = pgTable("meta_ad_campaigns", {
  id: text("id").primaryKey(),
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "set null" }),
  /** Null for Replay's own ad account; the academy's ad account in "own" mode. */
  adAccountId: text("ad_account_id"),
  name: text("name").notNull(),
  status: text("status"),
  objective: text("objective"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  /** Lifetime numbers: { spend, impressions, reach, clicks, conversations, leads, currency }. */
  insights: jsonb("insights"),
  /** The same for the last 30 days. */
  insights30d: jsonb("insights_30d"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  /** Replay's account only: lifetime Meta spend (minor units) already charged to the academy's wallet. */
  chargedSpendCents: integer("charged_spend_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("meta_ad_campaigns_academy_idx").on(table.academyId),
]);

/** Each ad and its campaign, so a click-to-WhatsApp message (which names the ad) finds its academy. */
export const metaAdsTable = pgTable("meta_ads", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => metaAdCampaignsTable.id, { onDelete: "cascade" }),
  name: text("name"),
  status: text("status"),
  /** Lifetime numbers for this ad alone (variants are compared on these). */
  insights: jsonb("insights"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
}, (table) => [
  index("meta_ads_campaign_idx").on(table.campaignId),
]);

/**
 * Someone who came from a Meta ad: an instant-form lead, or a click-to-WhatsApp
 * chat. Kept even before its campaign has an academy; assigning the campaign
 * later files these into that academy's People.
 */
export const metaAdLeadsTable = pgTable("meta_ad_leads", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  /** Meta's leadgen id, or "wa:<message id>" for a click-to-WhatsApp chat. */
  externalId: text("external_id").notNull(),
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "set null" }),
  contactId: integer("contact_id").references(() => academyContactsTable.id, { onDelete: "set null" }),
  campaignId: text("campaign_id"),
  adId: text("ad_id"),
  formId: text("form_id"),
  pageId: text("page_id"),
  phone: text("phone"),
  name: text("name"),
  email: text("email"),
  ctwaClid: text("ctwa_clid"),
  headline: text("headline"),
  answers: jsonb("answers"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("meta_ad_leads_external_unique").on(table.externalId),
  index("meta_ad_leads_academy_idx").on(table.academyId),
  index("meta_ad_leads_campaign_idx").on(table.campaignId),
  check("meta_ad_leads_source_check", sql`${table.source} in ('lead_form', 'whatsapp')`),
]);

export type MetaAdCampaign = typeof metaAdCampaignsTable.$inferSelect;
export type MetaAdLead = typeof metaAdLeadsTable.$inferSelect;

/**
 * How an academy's ads reach Meta:
 *   - "replay": the academy shared its Facebook Page with Replay's business; ads run from
 *     Replay's ad account (Replay pays and bills the academy) and wait for Replay's approval;
 *   - "own": the owner connected his own business with Facebook Login for Business; ads run
 *     from his ad account with his token (stored encrypted) and Meta bills him.
 */
export const academyMetaConnectionsTable = pgTable("academy_meta_connections", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("replay"),
  pageId: text("page_id"),
  pageName: text("page_name"),
  whatsappNumber: text("whatsapp_number"),
  adAccountId: text("ad_account_id"),
  adAccountName: text("ad_account_name"),
  currency: text("currency"),
  clientBusinessId: text("client_business_id"),
  /** Own mode: the business integration system user token, AES-256-GCM. */
  tokenEnc: text("token_enc"),
  leadsSubscribed: boolean("leads_subscribed").notNull().default(false),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_meta_connections_page_idx").on(table.pageId),
  check("academy_meta_connections_mode_check", sql`${table.mode} in ('replay', 'own')`),
  check("academy_meta_connections_status_check", sql`${table.status} in ('pending', 'connected', 'error')`),
]);

/** An ad an academy builds in Replay, and the Meta objects it became. */
export const academyAdRequestsTable = pgTable("academy_ad_requests", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  goal: text("goal").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  dailyBudget: integer("daily_budget").notNull(),
  currency: text("currency").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  latitude: real("latitude"),
  longitude: real("longitude"),
  radiusKm: integer("radius_km").notNull().default(10),
  ageMin: integer("age_min").notNull().default(25),
  ageMax: integer("age_max").notNull().default(55),
  headline: text("headline").notNull(),
  primaryText: text("primary_text").notNull(),
  locale: text("locale").notNull().default("ar"),
  imageData: text("image_data"),
  extraQuestion: text("extra_question"),
  /** Replay's account: the owner's daily budget in fils (what his wallet is charged at most per day). */
  budgetFils: integer("budget_fils"),
  /** [{ mediaId, headline?, description? }]: one is a single image/video ad, 2–10 a carousel. */
  cards: jsonb("cards"),
  /** [{ headline, primaryText }]: 1–3 versions of the text, each its own ad in the same ad set. */
  variants: jsonb("variants"),
  /** Sign-up form questions beyond name and phone: [{ label, options?: string[] }]. */
  questions: jsonb("questions"),
  /** Every Meta ad created for this request, one per variant: [{ adId, variant }]. */
  metaAds: jsonb("meta_ads"),
  templateId: integer("template_id"),
  /** Why Replay paused it ("funds" when the wallet ran low), so a top-up can switch it back on. */
  pausedReason: text("paused_reason"),
  metaCampaignId: text("meta_campaign_id"),
  metaAdsetId: text("meta_adset_id"),
  metaAdId: text("meta_ad_id"),
  metaFormId: text("meta_form_id"),
  error: text("error"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  launchedAt: timestamp("launched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_ad_requests_academy_idx").on(table.academyId),
  index("academy_ad_requests_status_idx").on(table.status),
  check("academy_ad_requests_mode_check", sql`${table.mode} in ('replay', 'own')`),
  check("academy_ad_requests_goal_check", sql`${table.goal} in ('whatsapp', 'lead_form')`),
  check("academy_ad_requests_status_check", sql`${table.status} in ('draft', 'pending_approval', 'launching', 'active', 'paused', 'rejected', 'failed')`),
]);

export type AcademyMetaConnection = typeof academyMetaConnectionsTable.$inferSelect;
export type AcademyAdRequest = typeof academyAdRequestsTable.$inferSelect;

/**
 * An academy's prepaid balance for ads that run on Replay's ad account, as a ledger in fils.
 * Top-ups wait for an admin to confirm the CliQ transfer; spend is debited from Meta's
 * numbers as they sync. The balance is the sum of confirmed rows.
 */
export const academyAdWalletEntriesTable = pgTable("academy_ad_wallet_entries", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  /** Positive adds to the balance, negative takes from it. */
  amountFils: integer("amount_fils").notNull(),
  status: text("status").notNull().default("confirmed"),
  method: text("method"),
  /** What the owner writes in the CliQ transfer note, so an admin can match it. */
  reference: text("reference"),
  campaignId: text("campaign_id"),
  /** Spend rows: Meta's own figure in the ad account's minor units (admin only). */
  metaSpendCents: integer("meta_spend_cents"),
  note: text("note"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  confirmedBy: integer("confirmed_by").references(() => usersTable.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_ad_wallet_academy_idx").on(table.academyId),
  index("academy_ad_wallet_status_idx").on(table.status),
  check("academy_ad_wallet_kind_check", sql`${table.kind} in ('topup', 'spend', 'adjustment')`),
  check("academy_ad_wallet_status_check", sql`${table.status} in ('pending', 'confirmed', 'rejected')`),
]);

/** Photos and videos an academy uploads (or makes in the Studio) to use in its ads. */
export const academyAdMediaTable = pgTable("academy_ad_media", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  name: text("name").notNull().default(""),
  source: text("source").notNull().default("upload"),
  /** Images: a JPEG/PNG data URL, at most ~4 MB. Videos: a still for previews. */
  imageData: text("image_data"),
  /** Videos: the file in Bunny Storage (an authenticated origin; served through the API). */
  storageUrl: text("storage_url"),
  bytes: integer("bytes"),
  width: integer("width"),
  height: integer("height"),
  durationSec: real("duration_sec"),
  /** Videos uploaded to Meta, per ad account: { "act_1": { videoId, status } }. */
  metaVideos: jsonb("meta_videos"),
  userClipId: integer("user_clip_id"),
  status: text("status").notNull().default("ready"),
  error: text("error"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_ad_media_academy_idx").on(table.academyId),
  check("academy_ad_media_kind_check", sql`${table.kind} in ('image', 'video')`),
  check("academy_ad_media_status_check", sql`${table.status} in ('processing', 'ready', 'failed')`),
]);

/** Ready-made campaigns Replay writes; an owner starts an ad from one. */
export const academyAdTemplatesTable = pgTable("academy_ad_templates", {
  id: serial("id").primaryKey(),
  key: text("key"),
  title: text("title").notNull(),
  titleAr: text("title_ar"),
  description: text("description"),
  descriptionAr: text("description_ar"),
  goal: text("goal").notNull().default("whatsapp"),
  /** [{ locale: "ar"|"en", headline, primaryText }]: the text versions, per language. */
  variants: jsonb("variants").notNull(),
  questions: jsonb("questions"),
  dailyBudgetFils: integer("daily_budget_fils").notNull().default(5000),
  days: integer("days").notNull().default(14),
  ageMin: integer("age_min").notNull().default(25),
  ageMax: integer("age_max").notNull().default(55),
  radiusKm: integer("radius_km").notNull().default(10),
  imageData: text("image_data"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_ad_templates_key_unique").on(table.key),
  check("academy_ad_templates_goal_check", sql`${table.goal} in ('whatsapp', 'lead_form')`),
]);

export type AcademyAdWalletEntry = typeof academyAdWalletEntriesTable.$inferSelect;
export type AcademyAdMedia = typeof academyAdMediaTable.$inferSelect;
export type AcademyAdTemplate = typeof academyAdTemplatesTable.$inferSelect;

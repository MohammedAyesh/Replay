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

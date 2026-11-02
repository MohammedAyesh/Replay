import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyContactsTable } from "./academyWhatsapp";

/**
 * Campaigns in Replay's Meta ad account, synced from the Marketing API. An admin
 * assigns each to the academy it advertises; leads from its ads go to that academy.
 */
export const metaAdCampaignsTable = pgTable("meta_ad_campaigns", {
  id: text("id").primaryKey(),
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "set null" }),
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

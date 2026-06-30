import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { clipsTable } from "./clips";
import { fieldsTable } from "./fields";

export const adsTable = pgTable("ads", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  creativeUrl: text("creative_url").notNull(),
  clickUrl: text("click_url").notNull(),
  durationSeconds: integer("duration_seconds").notNull().default(15),
  targetType: text("target_type").notNull().default("all"),
  targetFieldId: integer("target_field_id").references(() => fieldsTable.id),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAdSchema = createInsertSchema(adsTable).omit({ id: true, createdAt: true });
export type InsertAd = z.infer<typeof insertAdSchema>;
export type Ad = typeof adsTable.$inferSelect;

export const adImpressionsTable = pgTable("ad_impressions", {
  id: serial("id").primaryKey(),
  adId: integer("ad_id").notNull().references(() => adsTable.id),
  userId: integer("user_id").references(() => usersTable.id),
  clipId: integer("clip_id").references(() => clipsTable.id),
  shownAt: timestamp("shown_at", { withTimezone: true }).notNull().defaultNow(),
  completed: boolean("completed").notNull().default(false),
  skippedAtSecond: integer("skipped_at_second"),
});

export const insertAdImpressionSchema = createInsertSchema(adImpressionsTable).omit({ id: true, shownAt: true });
export type InsertAdImpression = z.infer<typeof insertAdImpressionSchema>;
export type AdImpression = typeof adImpressionsTable.$inferSelect;

export const adClicksTable = pgTable("ad_clicks", {
  id: serial("id").primaryKey(),
  adId: integer("ad_id").notNull().references(() => adsTable.id),
  userId: integer("user_id").references(() => usersTable.id),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAdClickSchema = createInsertSchema(adClicksTable).omit({ id: true, clickedAt: true });
export type InsertAdClick = z.infer<typeof insertAdClickSchema>;
export type AdClick = typeof adClicksTable.$inferSelect;

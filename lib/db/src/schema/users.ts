import { pgTable, serial, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  isGuest: boolean("is_guest").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  clerkId: text("clerk_id").unique(),
  phone: text("phone"),
  position: text("position"),
  age: integer("age"),
  gender: text("gender"),
  isDisabled: boolean("is_disabled").notNull().default(false),
  profileComplete: boolean("profile_complete").notNull().default(false),
  preferredLocale: text("preferred_locale"),
  academyId: integer("academy_id"),
  recordingConsent: boolean("recording_consent").notNull().default(false),
  recordingConsentAt: timestamp("recording_consent_at", { withTimezone: true }),
  socialMediaConsent: boolean("social_media_consent").notNull().default(false),
  socialMediaConsentAt: timestamp("social_media_consent_at", { withTimezone: true }),
  consentRequired: boolean("consent_required").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

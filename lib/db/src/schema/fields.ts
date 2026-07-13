import { pgTable, serial, text, integer, timestamp, real, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const fieldsTable = pgTable("fields", {
  id: serial("id").primaryKey(),
  bunnyGuid: text("bunny_guid").unique(),
  name: text("name").notNull(),
  location: text("location").notNull().default(""),
  courts: integer("courts").notNull().default(1),
  weight: real("weight").notNull().default(1.0),
  latitude: real("latitude"),
  longitude: real("longitude"),
  thumbnailUrl: text("thumbnail_url"),
  isHidden: boolean("is_hidden").notNull().default(false),
  lastRecordedAt: timestamp("last_recorded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFieldSchema = createInsertSchema(fieldsTable).omit({ id: true, createdAt: true });
export type InsertField = z.infer<typeof insertFieldSchema>;
export type Field = typeof fieldsTable.$inferSelect;

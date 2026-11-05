import { check, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

/**
 * Browsers and phones that asked for notifications (0076). One row per device and person:
 * the console's "Notify me" switch subscribes the browser it is pressed in. New chat messages
 * go to every device of every person who can see that academy's or field's chats.
 */
export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** The push service URL: unique per browser. */
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  /** Pushes the service refused in a row; gone (404/410) deletes the row at once. */
  failures: integer("failures").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("push_subscriptions_user_idx").on(table.userId),
]);

/** The server's VAPID key pair, made once on first use (row id 1). VAPID_* in the environment win. */
export const webPushKeysTable = pgTable("web_push_keys", {
  id: integer("id").primaryKey().default(1),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("web_push_keys_single_row", sql`${table.id} = 1`),
]);

export type PushSubscriptionRow = typeof pushSubscriptionsTable.$inferSelect;

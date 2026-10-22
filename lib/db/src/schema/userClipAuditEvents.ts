import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const userClipAuditEventsTable = pgTable("user_clip_audit_events", {
  id: serial("id").primaryKey(),
  /** Kept as a snapshot ID so the event survives physical clip deletion. */
  clipId: integer("clip_id").notNull(),
  clipOwnerId: integer("clip_owner_id").references(() => usersTable.id, { onDelete: "set null" }),
  actorUserId: integer("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  actorRole: text("actor_role").notNull().$type<"owner" | "admin">(),
  action: text("action").notNull().$type<"deleted" | "restored">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("user_clip_audit_events_clip_created_idx").on(table.clipId, table.createdAt),
  index("user_clip_audit_events_actor_created_idx").on(table.actorUserId, table.createdAt),
]);

export const insertUserClipAuditEventSchema = createInsertSchema(userClipAuditEventsTable)
  .omit({ id: true, createdAt: true });
export type InsertUserClipAuditEvent = z.infer<typeof insertUserClipAuditEventSchema>;
export type UserClipAuditEvent = typeof userClipAuditEventsTable.$inferSelect;

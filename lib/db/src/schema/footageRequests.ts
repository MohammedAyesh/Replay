import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { fieldsTable } from "./fields";

export const footageRequestsTable = pgTable("footage_requests", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull().references(() => fieldsTable.id, { onDelete: "cascade" }),
  cameraId: text("camera_id").notNull(),
  requestedBy: integer("requested_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  startLocal: text("start_local").notNull(),
  endLocal: text("end_local").notNull(),
  requestedSeconds: integer("requested_seconds").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  message: text("message"),
  vpsJobId: text("vps_job_id"),
  videoId: text("video_id"),
  deliveredSeconds: integer("delivered_seconds"),
  rateFils: integer("rate_fils").notNull().default(1000),
  billableHours: integer("billable_hours").notNull().default(0),
  amountFils: integer("amount_fils").notNull().default(0),
  shareToken: text("share_token").unique(),
  shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
  shareRevoked: boolean("share_revoked").notNull().default(false),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FootageRequest = typeof footageRequestsTable.$inferSelect;
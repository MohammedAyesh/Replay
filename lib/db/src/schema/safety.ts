import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export type ContentReportTargetType = "user_clip" | "user";
export type ContentReportReason =
  | "nudity"
  | "violence"
  | "harassment"
  | "hate"
  | "spam"
  | "personal_info"
  | "im_in_this_clip"
  | "other";
export type ContentReportStatus = "open" | "actioned" | "dismissed";

export const contentReportsTable = pgTable(
  "content_reports",
  {
    id: serial("id").primaryKey(),
    reporterUserId: integer("reporter_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type").notNull().$type<ContentReportTargetType>(),
    targetId: integer("target_id").notNull(),
    targetUserId: integer("target_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull().$type<ContentReportReason>(),
    note: text("note"),
    status: text("status").notNull().default("open").$type<ContentReportStatus>(),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    actionTaken: text("action_taken"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("content_reports_reporter_target_unique").on(
      table.reporterUserId,
      table.targetType,
      table.targetId,
    ),
    index("content_reports_status_created_at_idx").on(table.status, table.createdAt),
    index("content_reports_target_type_id_idx").on(table.targetType, table.targetId),
  ],
);

export const userBlocksTable = pgTable(
  "user_blocks",
  {
    blockerId: integer("blocker_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    blockedId: integer("blocked_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index("user_blocks_blocked_id_idx").on(table.blockedId),
  ],
);

export type ContentReport = typeof contentReportsTable.$inferSelect;
export type UserBlock = typeof userBlocksTable.$inferSelect;
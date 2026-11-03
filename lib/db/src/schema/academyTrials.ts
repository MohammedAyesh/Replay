import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, real, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academySessionsTable } from "./academySessions";
import { academyContactsTable } from "./academyWhatsapp";
import { recordingsTable } from "./recordings";
import { userClipsTable } from "./userClips";
import { usersTable } from "./users";

/**
 * A trial child's clip (0069): a moment from the session he came to try,
 * sent to the family within a day, then one follow-up message a few days
 * later unless People already shows them as joined or lost. `token` opens the
 * clip without an account (/kc/<token>, the same page as a player's clip).
 */
export const TRIAL_CLIP_STATUSES = ["prepared", "sent", "failed"] as const;
export const TRIAL_FOLLOW_UP_STATUSES = ["pending", "sent", "skipped"] as const;

export const academyTrialClipsTable = pgTable("academy_trial_clips", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => academyContactsTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => academySessionsTable.id, { onDelete: "set null" }),
  recordingId: integer("recording_id").references(() => recordingsTable.id, { onDelete: "set null" }),
  userClipId: integer("user_clip_id").references(() => userClipsTable.id, { onDelete: "set null" }),
  token: text("token").notNull(),
  childName: text("child_name"),
  /** Where in the recording the moment is (seconds from the start of the video). */
  momentSeconds: real("moment_seconds").notNull(),
  status: text("status").notNull().default("prepared"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  followUpStatus: text("follow_up_status"),
  followUpAt: timestamp("follow_up_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_trial_clips_token_unique").on(table.token),
  index("academy_trial_clips_academy_idx").on(table.academyId, table.createdAt),
  index("academy_trial_clips_follow_up_idx").on(table.followUpStatus, table.followUpAt),
  check("academy_trial_clips_token_check", sql`${table.token} ~ '^[0-9a-f]{32}$'`),
  check("academy_trial_clips_status_check", sql`${table.status} in ('prepared', 'sent', 'failed')`),
  check("academy_trial_clips_follow_up_check", sql`${table.followUpStatus} is null or ${table.followUpStatus} in ('pending', 'sent', 'skipped')`),
]);

export type AcademyTrialClip = typeof academyTrialClipsTable.$inferSelect;

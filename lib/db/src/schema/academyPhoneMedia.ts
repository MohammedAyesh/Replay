import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";
import { academySessionsTable } from "./academySessions";
import { academyAdMediaTable } from "./metaAds";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

/**
 * Phone videos and photos coaches and parents add to the academy library
 * (0067), sorted by when they were filmed against the academy's sessions:
 * before, during (with the offset into the panoramic recording), after, or
 * not linked (the coach is asked). The file itself is an academy_ad_media
 * row, stored with every metadata tag removed (GPS included): the capture
 * time is kept here, the coordinates are never kept anywhere.
 */
export const PHONE_MEDIA_PHASES = ["before", "during", "after", "unlinked"] as const;

export const academyPhoneMediaTable = pgTable("academy_phone_media", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  mediaId: integer("media_id").notNull().references(() => academyAdMediaTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  fileName: text("file_name").notNull().default(""),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  /** owner, manager, coach (console) or parent (family page). */
  uploaderRole: text("uploader_role").notNull(),
  /** A parent's upload is about his child. */
  playerId: integer("player_id").references(() => academyPlayersTable.id, { onDelete: "set null" }),
  capturedStart: timestamp("captured_start", { withTimezone: true }),
  capturedEnd: timestamp("captured_end", { withTimezone: true }),
  /** "YYYY-MM-DD" when only the day is known (a WhatsApp forward). */
  captureDate: text("capture_date"),
  captureSource: text("capture_source").notNull().default("none"),
  captureConfidence: text("capture_confidence").notNull().default("low"),
  captureNotes: jsonb("capture_notes").notNull().default(sql`'[]'::jsonb`),
  /** at_venue / elsewhere / unknown, from GPS that is then thrown away. */
  venue: text("venue").notNull().default("unknown"),
  sessionId: integer("session_id").references(() => academySessionsTable.id, { onDelete: "set null" }),
  phase: text("phase").notNull().default("unlinked"),
  /** Seconds into the panoramic recording where the phone clip starts ("during"). */
  offsetSec: real("offset_sec"),
  recordingId: integer("recording_id").references(() => recordingsTable.id, { onDelete: "set null" }),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewReason: text("review_reason"),
  /** auto: sorted by time; coach: a person chose the session. */
  linkedBy: text("linked_by").notNull().default("auto"),
  /** Players tagged in it (each tag logs a private appearance). */
  playerIds: jsonb("player_ids").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_phone_media_academy_idx").on(table.academyId, table.createdAt),
  index("academy_phone_media_session_idx").on(table.sessionId),
  check("academy_phone_media_kind_check", sql`${table.kind} in ('image', 'video')`),
  check("academy_phone_media_phase_check", sql`${table.phase} in ('before', 'during', 'after', 'unlinked')`),
  check("academy_phone_media_role_check", sql`${table.uploaderRole} in ('owner', 'manager', 'coach', 'parent')`),
  check("academy_phone_media_venue_check", sql`${table.venue} in ('at_venue', 'elsewhere', 'unknown')`),
  check("academy_phone_media_linked_by_check", sql`${table.linkedBy} in ('auto', 'coach')`),
]);

export type AcademyPhoneMedia = typeof academyPhoneMediaTable.$inferSelect;

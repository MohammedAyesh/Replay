import { index, integer, jsonb, pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academySessionsTable } from "./academySessions";
import { recordingsTable } from "./recordings";
import { usersTable } from "./users";

/**
 * A coach's saved moment of a match (0080): where in the video it is, what was
 * drawn over it (arrows, circles, zones, text), which players were spotlighted
 * (match analysis roster ids, followed by tracking), and a comment. Staff see
 * every note of their academy; `shared` notes are also shown to the families
 * of the tagged players (`player_ids`, academy_players ids) on their match page.
 *
 * `board` is lib/api-zod coachBoard.ts's CoachBoard, validated on every write.
 * Times are milliseconds into the recording's video (the player's clock).
 */
export const academyCoachNotesTable = pgTable("academy_coach_notes", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").notNull().references(() => academySessionsTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").references(() => recordingsTable.id, { onDelete: "set null" }),
  title: text("title").notNull().default(""),
  body: text("body"),
  atMs: integer("at_ms").notNull(),
  endMs: integer("end_ms"),
  board: jsonb("board").notNull(),
  playerIds: jsonb("player_ids").$type<number[]>().notNull().default([]),
  shared: boolean("shared").notNull().default(false),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_coach_notes_session_idx").on(table.sessionId, table.atMs),
  index("academy_coach_notes_academy_idx").on(table.academyId, table.createdAt),
]);

export type AcademyCoachNote = typeof academyCoachNotesTable.$inferSelect;

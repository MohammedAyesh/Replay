import { check, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academyPlayersTable } from "./academyPlayers";
import { academySessionsTable } from "./academySessions";

export const academyAttendanceTable = pgTable("academy_attendance", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => academySessionsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["present", "absent", "late", "excused"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_attendance_session_id_player_id_unique").on(table.sessionId, table.playerId),
  check("academy_attendance_status_check", sql`${table.status} in ('present', 'absent', 'late', 'excused')`),
]);

export const insertAcademyAttendanceSchema = createInsertSchema(academyAttendanceTable).omit({ id: true, createdAt: true });
export type InsertAcademyAttendance = z.infer<typeof insertAcademyAttendanceSchema>;
export type AcademyAttendance = typeof academyAttendanceTable.$inferSelect;
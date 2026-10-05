import { check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academyPlayersTable } from "./academyPlayers";
import { usersTable } from "./users";

export const academyPlayerGuardiansTable = pgTable("academy_player_guardians", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  addedBy: text("added_by", { enum: ["owner", "link"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_player_guardians_player_id_user_id_unique").on(table.playerId, table.userId),
  index("academy_player_guardians_user_id_idx").on(table.userId),
  check("academy_player_guardians_added_by_check", sql`${table.addedBy} in ('owner', 'link')`),
]);

export const insertAcademyPlayerGuardianSchema = createInsertSchema(academyPlayerGuardiansTable)
  .omit({ id: true, createdAt: true });
export type InsertAcademyPlayerGuardian = z.infer<typeof insertAcademyPlayerGuardianSchema>;
export type AcademyPlayerGuardian = typeof academyPlayerGuardiansTable.$inferSelect;

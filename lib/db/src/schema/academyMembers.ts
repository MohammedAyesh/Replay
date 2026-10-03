import { check, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { usersTable } from "./users";

export const academyMembersTable = pgTable("academy_members", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "coach"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_members_user_id_academy_id_role_unique").on(table.userId, table.academyId, table.role),
  check("academy_members_role_check", sql`${table.role} in ('owner', 'coach')`),
]);

export const insertAcademyMemberSchema = createInsertSchema(academyMembersTable).omit({ id: true, createdAt: true });
export type InsertAcademyMember = z.infer<typeof insertAcademyMemberSchema>;
export type AcademyMember = typeof academyMembersTable.$inferSelect;
import { check, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { academiesTable } from "./academies";
import { usersTable } from "./users";

export const academyMembersTable = pgTable("academy_members", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** owner: everything. manager: everything the owner hasn't hidden, except the team and permissions. coach: coaching sections. */
  role: text("role", { enum: ["owner", "manager", "coach"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_members_user_id_academy_id_role_unique").on(table.userId, table.academyId, table.role),
  check("academy_members_role_check", sql`${table.role} in ('owner', 'manager', 'coach')`),
]);

/**
 * What each role may see and do in an academy, set by the owner (Academy console → Team).
 *   sections: role → visible console sections (manager, coach) or family-page screens (parent, player);
 *             a missing role means the defaults.
 *   permissions: role → delegated actions, e.g. "chats.manage" (archive, block, mute, mark personal).
 */
export const academyAccessSettingsTable = pgTable("academy_access_settings", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  sections: jsonb("sections").notNull().default(sql`'{}'::jsonb`),
  permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A link the owner sends to add a manager or a coach; whoever signs in and accepts it joins. */
export const academyStaffInvitesTable = pgTable("academy_staff_invites", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  token: text("token").notNull(),
  label: text("label"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedBy: integer("accepted_by").references(() => usersTable.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_staff_invites_token_unique").on(table.token),
  index("academy_staff_invites_academy_idx").on(table.academyId),
  check("academy_staff_invites_role_check", sql`${table.role} in ('manager', 'coach')`),
]);

export type AcademyAccessSettings = typeof academyAccessSettingsTable.$inferSelect;
export type AcademyStaffInvite = typeof academyStaffInvitesTable.$inferSelect;

export const insertAcademyMemberSchema = createInsertSchema(academyMembersTable).omit({ id: true, createdAt: true });
export type InsertAcademyMember = z.infer<typeof insertAcademyMemberSchema>;
export type AcademyMember = typeof academyMembersTable.$inferSelect;
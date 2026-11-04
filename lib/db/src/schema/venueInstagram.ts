import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyCreativeProjectsTable } from "./academyCreative";
import { academySocialPostsTable } from "./academySocial";
import { recordingsTable } from "./recordings";
import { userClipsTable } from "./userClips";
import { usersTable } from "./users";
import { venueBookingsTable } from "./venues";

/**
 * Field console → Instagram autopilot (2026-11-03).
 *
 * A field posts a clip from every booking and weekly awards on its own Instagram, from a
 * rolling calendar. Nothing posts without consent: the field's consent mode (venue_settings.
 * ig_consent_mode, set by a Replay admin only) and, per booking, the captain's or front desk's
 * answer (venue_bookings.ig_consent). Every post keeps the consent it relied on, so any post
 * can be traced back; every change of mode and every removal is logged.
 */

/** Admin changes of a field's Instagram consent mode: who, when, from what to what. */
export const venueIgConsentEventsTable = pgTable("venue_ig_consent_events", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  changedBy: integer("changed_by").references(() => usersTable.id, { onDelete: "set null" }),
  oldMode: text("old_mode"),
  newMode: text("new_mode").notNull(),
  /** The owner's own consent wording (owner mode), as the admin pasted it. */
  wording: text("wording"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("venue_ig_consent_events_academy_idx").on(table.academyId, table.createdAt),
  check("venue_ig_consent_events_mode_check", sql`${table.newMode} in ('ask', 'owner', 'off') and (${table.oldMode} is null or ${table.oldMode} in ('ask', 'owner', 'off'))`),
]);

/** Weekly awards: one row per field, week and category. */
export const venueIgAwardsTable = pgTable("venue_ig_awards", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** The Sunday the award's week starts on (Amman calendar), "YYYY-MM-DD". Nominees come from that week's games. */
  weekStart: text("week_start").notNull(),
  category: text("category").notNull(),
  /** nominating → voting → (owner_pick) → decided → posted, or skipped (nothing to nominate / the owner skipped it). */
  status: text("status").notNull().default("nominating"),
  /** [{ key, recordingId, bookingId, atSeconds, fromSec, toSec, source, label, value?, clipId?, nominatedBy? }] */
  nominees: jsonb("nominees").notNull().default(sql`'[]'::jsonb`),
  votingEndsAt: timestamp("voting_ends_at", { withTimezone: true }),
  winnerKey: text("winner_key"),
  /** votes | owner */
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByUser: integer("decided_by_user").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_ig_awards_week_unique").on(table.academyId, table.weekStart, table.category),
  check("venue_ig_awards_category_check", sql`${table.category} in ('goal', 'dribble', 'shot', 'save', 'fastest')`),
  check("venue_ig_awards_status_check", sql`${table.status} in ('nominating', 'voting', 'owner_pick', 'decided', 'posted', 'skipped')`),
]);

/** One vote per person per award, in the Replay app. */
export const venueIgAwardVotesTable = pgTable("venue_ig_award_votes", {
  id: serial("id").primaryKey(),
  awardId: integer("award_id").notNull().references(() => venueIgAwardsTable.id, { onDelete: "cascade" }),
  nomineeKey: text("nominee_key").notNull(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_ig_award_votes_user_unique").on(table.awardId, table.userId),
]);

/**
 * Save of the week: there is no keeper-save detection, so saves are nominated. A player
 * nominates a moment from the match page; a shot that wasn't a goal is offered to the owner as
 * a candidate. Only the owner's approval puts either on the nominee list.
 */
export const venueIgNominationsTable = pgTable("venue_ig_nominations", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  category: text("category").notNull().default("save"),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  bookingId: integer("booking_id").references(() => venueBookingsTable.id, { onDelete: "cascade" }),
  /** Tracking seconds of the moment. */
  atSeconds: integer("at_seconds").notNull(),
  /** player (from the match page) or shot (a shot that wasn't a goal, offered by Replay). */
  source: text("source").notNull(),
  nominatedBy: integer("nominated_by").references(() => usersTable.id, { onDelete: "set null" }),
  note: text("note"),
  /** pending → approved | rejected (by the owner). */
  status: text("status").notNull().default("pending"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_ig_nominations_moment_unique").on(table.academyId, table.category, table.recordingId, table.atSeconds),
  index("venue_ig_nominations_academy_idx").on(table.academyId, table.status),
  check("venue_ig_nominations_category_check", sql`${table.category} in ('save')`),
  check("venue_ig_nominations_source_check", sql`${table.source} in ('player', 'shot')`),
  check("venue_ig_nominations_status_check", sql`${table.status} in ('pending', 'approved', 'rejected')`),
]);

/**
 * The calendar: one row per thing the autopilot will post (a booking's clip, an award's nominees
 * or its winner), with its slot, its state, the design it renders from, the social post it hands
 * off to, and the consent it relied on.
 */
export const venueIgItemsTable = pgTable("venue_ig_items", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /**
   * booking:<id> · nominees:<awardId> · winner:<awardId> · versus:<week> · top5:<week> · thanks:<week> ·
   * match:<week> · potw:<week> · board:<YYYY-MM> · slots:<date> · milestone:<n>. Unique per field: an item is never made twice.
   */
  originKey: text("origin_key").notNull(),
  kind: text("kind").notNull(),
  /** story | reel | carousel (award nominees: a cover and one slide per nominee, voted on in the comments) */
  placement: text("placement").notNull().default("story"),
  bookingId: integer("booking_id").references(() => venueBookingsTable.id, { onDelete: "set null" }),
  awardId: integer("award_id").references(() => venueIgAwardsTable.id, { onDelete: "set null" }),
  recordingId: integer("recording_id").references(() => recordingsTable.id, { onDelete: "set null" }),
  clipId: integer("clip_id").references(() => userClipsTable.id, { onDelete: "set null" }),
  /** saved_clip · confirmed_goal · shot · dribble · award */
  source: text("source").notNull(),
  /** The footage: { recordingId, fromMs, toMs } in the recording's video time, or a clip. */
  moment: jsonb("moment"),
  /** How good it is, for promoting the best of the day to a Reel (confirmed goals first). */
  score: integer("score").notNull().default(0),
  slotAt: timestamp("slot_at", { withTimezone: true }),
  /** planned → approved → rendering → ready → publishing → published; skipped, failed, removed, removal_flagged. */
  status: text("status").notNull().default("planned"),
  /** The owner moved it by hand: the planner leaves its slot alone. */
  pinned: boolean("pinned").notNull().default(false),
  projectId: integer("project_id").references(() => academyCreativeProjectsTable.id, { onDelete: "set null" }),
  postId: integer("post_id").references(() => academySocialPostsTable.id, { onDelete: "set null" }),
  igMediaId: text("ig_media_id"),
  igPermalink: text("ig_permalink"),
  /** The field's consent mode when it went out (ask | owner), and the booking consent it relied on. */
  consentMode: text("consent_mode"),
  consentRef: jsonb("consent_ref"),
  /** { views, reach, plays, … } read back from Instagram while the API gives them. */
  insights: jsonb("insights"),
  insightsAt: timestamp("insights_at", { withTimezone: true }),
  error: text("error"),
  approvedBy: integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("venue_ig_items_origin_unique").on(table.academyId, table.originKey),
  index("venue_ig_items_slot_idx").on(table.academyId, table.slotAt),
  index("venue_ig_items_status_idx").on(table.status, table.slotAt),
  check("venue_ig_items_kind_check", sql`${table.kind} in ('booking_clip', 'award_nominees', 'award_winner', 'versus', 'top5', 'thanks', 'match_week', 'player_week', 'milestone', 'open_slots', 'leaderboard')`),
  check("venue_ig_items_placement_check", sql`${table.placement} in ('story', 'reel', 'carousel')`),
  check("venue_ig_items_status_check", sql`${table.status} in ('planned', 'approved', 'rendering', 'ready', 'publishing', 'published', 'skipped', 'failed', 'removed', 'removal_flagged')`),
]);

/** "Remove from Instagram" requests from the match page, and what came of each. */
export const venueIgRemovalsTable = pgTable("venue_ig_removals", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => venueIgItemsTable.id, { onDelete: "set null" }),
  bookingId: integer("booking_id").references(() => venueBookingsTable.id, { onDelete: "set null" }),
  requestedBy: integer("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  /** deleted (through the API) · flagged (the owner has to delete it) · withdrawn (it hadn't gone out yet) */
  outcome: text("outcome").notNull(),
  error: text("error"),
  /** The owner confirmed he deleted a flagged one by hand. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: integer("resolved_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("venue_ig_removals_academy_idx").on(table.academyId, table.createdAt),
  check("venue_ig_removals_outcome_check", sql`${table.outcome} in ('deleted', 'flagged', 'withdrawn')`),
]);

export type VenueIgConsentEvent = typeof venueIgConsentEventsTable.$inferSelect;
export type VenueIgAward = typeof venueIgAwardsTable.$inferSelect;
export type VenueIgAwardVote = typeof venueIgAwardVotesTable.$inferSelect;
export type VenueIgNomination = typeof venueIgNominationsTable.$inferSelect;
export type VenueIgItem = typeof venueIgItemsTable.$inferSelect;
export type VenueIgRemoval = typeof venueIgRemovalsTable.$inferSelect;

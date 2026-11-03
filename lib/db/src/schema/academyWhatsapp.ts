import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyPlayersTable } from "./academyPlayers";
import { academySquadsTable } from "./academySquads";
import { usersTable } from "./users";

/**
 * One row per academy that has opened its WhatsApp settings.
 *
 * `sender` picks whose WhatsApp the academy's messages leave from:
 *   - "own":    the academy's own number, linked from the console (WAHA session `academy-<id>`)
 *   - "replay": Replay's shared number (WAHA session `replay`), with the academy name on top
 *   - "off":    nothing is sent; automations do not queue
 */
export const academyWhatsappSettingsTable = pgTable("academy_whatsapp_settings", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  sender: text("sender").notNull().default("off"),
  locale: text("locale").notNull().default("ar"),
  dailyLimit: integer("daily_limit").notNull().default(300),
  /** Per-automation config, keyed by automation key. Missing keys use the defaults in code. */
  automations: jsonb("automations").notNull().default(sql`'{}'::jsonb`),
  /**
   * Chat behaviour: { readReceipts, greeting, away, missedCall, channel }.
   * Missing keys use the defaults in code (lib/whatsapp/chatOptions.ts).
   */
  chatOptions: jsonb("chat_options").notNull().default(sql`'{}'::jsonb`),
  /** Last status WAHA reported for the academy's own session (webhook or poll). */
  sessionStatus: text("session_status"),
  connectedPhone: text("connected_phone"),
  connectedName: text("connected_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_whatsapp_settings_sender_check", sql`${table.sender} in ('own', 'replay', 'off')`),
  check("academy_whatsapp_settings_locale_check", sql`${table.locale} in ('ar', 'en')`),
  check("academy_whatsapp_settings_daily_limit_check", sql`${table.dailyLimit} between 1 and 5000`),
]);

/** A message the owner or a coach composed and sent to an audience. */
export const academyWhatsappBroadcastsTable = pgTable("academy_whatsapp_broadcasts", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  audience: jsonb("audience").notNull(),
  recipientCount: integer("recipient_count").notNull().default(0),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_whatsapp_broadcasts_academy_idx").on(table.academyId, table.createdAt),
]);

/**
 * Every outbound message (queued → sending → sent → delivered → read, or failed / skipped)
 * and every inbound reply (direction "in", status "received").
 */
export const academyWhatsappMessagesTable = pgTable("academy_whatsapp_messages", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  direction: text("direction").notNull().default("out"),
  /** "broadcast", "announcement", "test", "reply", or an automation key. */
  kind: text("kind").notNull(),
  broadcastId: integer("broadcast_id").references(() => academyWhatsappBroadcastsTable.id, { onDelete: "set null" }),
  /** WAHA session the message left from (set when claimed for sending). */
  senderSession: text("sender_session"),
  phone: text("phone").notNull(),
  recipientName: text("recipient_name"),
  recipientRole: text("recipient_role"),
  playerId: integer("player_id").references(() => academyPlayersTable.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  status: text("status").notNull().default("queued"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  waMessageId: text("wa_message_id"),
  /** Idempotency for automations: the same reminder is never queued twice. */
  dedupeKey: text("dedupe_key"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
  /** When a dispatcher claimed it; a claim older than 10 minutes is failed, never resent. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  /**
   * What the message is when it isn't plain text: a photo, video, GIF, voice note, document,
   * sticker, location or poll (see WhatsappContent in the API). `body` still carries the
   * caption or a one-line summary, so lists and older readers keep working.
   */
  content: jsonb("content"),
  /** In a group: who wrote it. */
  authorPhone: text("author_phone"),
  authorName: text("author_name"),
  /** The WhatsApp id (bare) of the message this one answers. */
  replyToWaId: text("reply_to_wa_id"),
  /** Emoji reactions: { "<phone or 'me'>": { emoji, name } }. */
  reactions: jsonb("reactions"),
  /** Phones @mentioned in a group message. */
  mentions: jsonb("mentions"),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  /** Deleted for everyone (by us or by the sender); the content is cleared. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_whatsapp_messages_direction_check", sql`${table.direction} in ('out', 'in')`),
  check(
    "academy_whatsapp_messages_status_check",
    sql`${table.status} in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'received')`,
  ),
  uniqueIndex("academy_whatsapp_messages_dedupe_unique").on(table.dedupeKey).where(sql`${table.dedupeKey} is not null`),
  index("academy_whatsapp_messages_queue_idx").on(table.status, table.scheduledFor),
  index("academy_whatsapp_messages_academy_idx").on(table.academyId, table.createdAt),
  index("academy_whatsapp_messages_wa_id_idx").on(table.waMessageId),
  index("academy_whatsapp_messages_broadcast_idx").on(table.broadcastId),
]);

/** Numbers that replied STOP to an academy. Nothing more is sent to them for that academy. */
export const academyWhatsappOptOutsTable = pgTable("academy_whatsapp_opt_outs", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  phone: text("phone").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_whatsapp_opt_outs_academy_phone_unique").on(table.academyId, table.phone),
]);

export type AcademyWhatsappSettings = typeof academyWhatsappSettingsTable.$inferSelect;
export type AcademyWhatsappMessage = typeof academyWhatsappMessagesTable.$inferSelect;
export type AcademyWhatsappBroadcast = typeof academyWhatsappBroadcastsTable.$inferSelect;

// ─── People (the start of the academy CRM) ───────────────────────────────────

export const CONTACT_KINDS = ["unknown", "lead", "parent", "player", "coach", "staff", "other"] as const;
export const LEAD_STAGES = ["new", "contacted", "trial", "joined", "lost"] as const;
export const CONTACT_RELATIONSHIPS = ["father", "mother", "guardian", "sibling", "relative", "self", "other"] as const;

/**
 * One row per phone number an academy knows: a parent, a player, a coach, someone
 * interested, or a number that messaged in and isn't sorted yet.
 */
export const academyContactsTable = pgTable("academy_contacts", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  phone: text("phone").notNull(),
  name: text("name"),
  kind: text("kind").notNull().default("unknown"),
  /** Pipeline position for people who are interested (kind "lead"). */
  stage: text("stage"),
  source: text("source").notNull().default("manual"),
  tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
  notes: text("notes"),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  /** Chat moved out of the main list (still receives). */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Messages still arrive but don't count as unread. */
  muted: boolean("muted").notNull().default(false),
  /** Nothing is stored from this number and nothing is sent to it. */
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  /** A personal chat on the academy's phone: its messages are deleted and no longer stored. */
  personalAt: timestamp("personal_at", { withTimezone: true }),
  /** "Who is this?" put off for later. */
  linkDismissedAt: timestamp("link_dismissed_at", { withTimezone: true }),
  /** The manager or coach this chat is handed to. */
  assignedUserId: integer("assigned_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** WhatsApp profile photo, copied to Bunny Storage (WhatsApp's own links expire). */
  avatarPath: text("avatar_path"),
  avatarCheckedAt: timestamp("avatar_checked_at", { withTimezone: true }),
  /** They are typing (or recording) until this time. */
  typingUntil: timestamp("typing_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_contacts_academy_phone_unique").on(table.academyId, table.phone),
  check("academy_contacts_kind_check", sql`${table.kind} in ('unknown', 'lead', 'parent', 'player', 'coach', 'staff', 'other')`),
  check("academy_contacts_stage_check", sql`${table.stage} is null or ${table.stage} in ('new', 'contacted', 'trial', 'joined', 'lost')`),
]);

/** Which players a number belongs to, and how: "Abu Ali is Ali's father". */
export const academyContactPlayersTable = pgTable("academy_contact_players", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => academyContactsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => academyPlayersTable.id, { onDelete: "cascade" }),
  relationship: text("relationship").notNull().default("guardian"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_contact_players_contact_player_unique").on(table.contactId, table.playerId),
  index("academy_contact_players_player_idx").on(table.playerId),
  check(
    "academy_contact_players_relationship_check",
    sql`${table.relationship} in ('father', 'mother', 'guardian', 'sibling', 'relative', 'self', 'other')`,
  ),
]);

export type AcademyContact = typeof academyContactsTable.$inferSelect;

/**
 * WhatsApp groups an academy follows in Chats: ones it created from Replay, or ones the owner
 * added from the groups his own number is already in. Messages of any other group are never
 * stored, so a family group on the academy's phone stays private. Messages use phone "g:<groupId>".
 */
export const academyWhatsappGroupsTable = pgTable("academy_whatsapp_groups", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** The group id without "@g.us". */
  groupId: text("group_id").notNull(),
  /** WAHA session the group lives on (the academy's own number, or Replay's). */
  session: text("session").notNull(),
  subject: text("subject").notNull(),
  /** "replay" when created from the console, "existing" when added from the phone's groups. */
  origin: text("origin").notNull().default("replay"),
  squadId: integer("squad_id").references(() => academySquadsTable.id, { onDelete: "set null" }),
  assignedUserId: integer("assigned_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  muted: boolean("muted").notNull().default(false),
  avatarPath: text("avatar_path"),
  avatarCheckedAt: timestamp("avatar_checked_at", { withTimezone: true }),
  typingUntil: timestamp("typing_until", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_whatsapp_groups_academy_group_unique").on(table.academyId, table.groupId),
  index("academy_whatsapp_groups_group_idx").on(table.groupId),
  check("academy_whatsapp_groups_origin_check", sql`${table.origin} in ('replay', 'existing')`),
]);

/** One row per person per poll: their current choice (a changed vote replaces it). */
export const academyWhatsappPollVotesTable = pgTable("academy_whatsapp_poll_votes", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull().references(() => academyWhatsappMessagesTable.id, { onDelete: "cascade" }),
  voterPhone: text("voter_phone").notNull(),
  voterName: text("voter_name"),
  options: jsonb("options").notNull().default(sql`'[]'::jsonb`),
  votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_whatsapp_poll_votes_message_voter_unique").on(table.messageId, table.voterPhone),
]);

/** Ready answers a coach inserts into a chat ("/prices"). */
export const academyWhatsappSavedRepliesTable = pgTable("academy_whatsapp_saved_replies", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** Short word typed after "/" to find it. */
  shortcut: text("shortcut").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("academy_whatsapp_saved_replies_academy_shortcut_unique").on(table.academyId, table.shortcut),
]);

/** What the academy posted to its WhatsApp Status or its WhatsApp Channel. */
export const academyWhatsappPostsTable = pgTable("academy_whatsapp_posts", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** "status" or "channel". */
  target: text("target").notNull(),
  kind: text("kind").notNull(),
  text: text("text"),
  media: jsonb("media"),
  backgroundColor: text("background_color"),
  waMessageId: text("wa_message_id"),
  error: text("error"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("academy_whatsapp_posts_academy_idx").on(table.academyId, table.createdAt),
  check("academy_whatsapp_posts_target_check", sql`${table.target} in ('status', 'channel')`),
  check("academy_whatsapp_posts_kind_check", sql`${table.kind} in ('text', 'image', 'video')`),
]);

export type AcademyWhatsappGroup = typeof academyWhatsappGroupsTable.$inferSelect;

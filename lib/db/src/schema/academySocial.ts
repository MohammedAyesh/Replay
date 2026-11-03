import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { academiesTable } from "./academies";
import { academyContactsTable } from "./academyWhatsapp";
import { usersTable } from "./users";

/**
 * An academy's Facebook Page and the Instagram professional account linked to it,
 * connected with Facebook Login for Business. Both tokens are stored encrypted
 * (see lib/meta/crypto.ts); the Page token is what reads and answers messages and comments.
 */
export const academySocialAccountsTable = pgTable("academy_social_accounts", {
  academyId: integer("academy_id").primaryKey().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** Business integration system user token from Login for Business (never expires). */
  tokenEnc: text("token_enc"),
  pageId: text("page_id"),
  pageName: text("page_name"),
  pageTokenEnc: text("page_token_enc"),
  igUserId: text("ig_user_id"),
  igUsername: text("ig_username"),
  igPicture: text("ig_picture"),
  /** The Page is subscribed to our app for messages, echoes and feed (comments). */
  subscribed: boolean("subscribed").notNull().default(false),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  /** Account numbers: followers, reach and views over 28 days, per channel. */
  insights: jsonb("insights"),
  insightsAt: timestamp("insights_at", { withTimezone: true }),
  postsSyncedAt: timestamp("posts_synced_at", { withTimezone: true }),
  connectedBy: integer("connected_by").references(() => usersTable.id, { onDelete: "set null" }),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_social_accounts_status_check", sql`${table.status} in ('pending', 'connected', 'error')`),
  uniqueIndex("academy_social_accounts_page_unique").on(table.pageId).where(sql`${table.pageId} is not null`),
  uniqueIndex("academy_social_accounts_ig_unique").on(table.igUserId).where(sql`${table.igUserId} is not null`),
]);

/**
 * One conversation with one person on Instagram Direct or Messenger. The person is known
 * by Meta's scoped id; linking a phone number files them into People.
 */
export const academySocialThreadsTable = pgTable("academy_social_threads", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  /** IGSID or PSID. */
  externalUserId: text("external_user_id").notNull(),
  name: text("name"),
  username: text("username"),
  picture: text("picture"),
  contactId: integer("contact_id").references(() => academyContactsTable.id, { onDelete: "set null" }),
  /** Lead stage until the thread is linked to someone in People (then the contact's stage counts). */
  stage: text("stage"),
  /** Their last message: the 24-hour reply window runs from here. */
  lastInAt: timestamp("last_in_at", { withTimezone: true }),
  lastAt: timestamp("last_at", { withTimezone: true }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  muted: boolean("muted").notNull().default(false),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  personalAt: timestamp("personal_at", { withTimezone: true }),
  /** The manager or coach this chat is handed to. */
  assignedUserId: integer("assigned_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_social_threads_channel_check", sql`${table.channel} in ('instagram', 'messenger')`),
  check("academy_social_threads_stage_check", sql`${table.stage} is null or ${table.stage} in ('new', 'contacted', 'trial', 'joined', 'lost')`),
  uniqueIndex("academy_social_threads_person_unique").on(table.academyId, table.channel, table.externalUserId),
  index("academy_social_threads_academy_idx").on(table.academyId, table.lastAt),
]);

/** Messages in a thread, both ways. Replies sent from the Instagram or Facebook apps arrive as echoes. */
export const academySocialMessagesTable = pgTable("academy_social_messages", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").notNull().references(() => academySocialThreadsTable.id, { onDelete: "cascade" }),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  /** "dm", "private_reply", "story_reply", "story_mention", "ad", "app" (sent from Meta's own apps). */
  kind: text("kind").notNull().default("dm"),
  body: text("body").notNull().default(""),
  /** [{ type, url }] */
  attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
  /** Meta's message id (mid). */
  externalId: text("external_id"),
  status: text("status").notNull().default("received"),
  error: text("error"),
  sentBy: integer("sent_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_social_messages_direction_check", sql`${table.direction} in ('in', 'out')`),
  check("academy_social_messages_status_check", sql`${table.status} in ('received', 'sent', 'failed')`),
  uniqueIndex("academy_social_messages_external_unique").on(table.externalId).where(sql`${table.externalId} is not null`),
  index("academy_social_messages_thread_idx").on(table.threadId, table.createdAt),
]);

/** Comments on the academy's posts and reels, with what the academy did about each. */
export const academySocialCommentsTable = pgTable("academy_social_comments", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  commentId: text("comment_id").notNull(),
  parentId: text("parent_id"),
  postId: text("post_id"),
  postPermalink: text("post_permalink"),
  postCaption: text("post_caption"),
  fromId: text("from_id"),
  fromName: text("from_name"),
  body: text("body").notNull().default(""),
  hidden: boolean("hidden").notNull().default(false),
  replyBody: text("reply_body"),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  repliedBy: integer("replied_by").references(() => usersTable.id, { onDelete: "set null" }),
  privateRepliedAt: timestamp("private_replied_at", { withTimezone: true }),
  threadId: integer("thread_id").references(() => academySocialThreadsTable.id, { onDelete: "set null" }),
  readAt: timestamp("read_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_social_comments_channel_check", sql`${table.channel} in ('instagram', 'facebook')`),
  uniqueIndex("academy_social_comments_comment_unique").on(table.channel, table.commentId),
  index("academy_social_comments_academy_idx").on(table.academyId, table.createdAt),
]);

/**
 * A post: one the academy published or scheduled from Replay, or one found on its
 * accounts when syncing. Engagement numbers per channel live in `insights`.
 */
export const academySocialPostsTable = pgTable("academy_social_posts", {
  id: serial("id").primaryKey(),
  academyId: integer("academy_id").notNull().references(() => academiesTable.id, { onDelete: "cascade" }),
  /** "replay" (made here) or "synced" (found on the account). */
  source: text("source").notNull().default("replay"),
  /** ["instagram", "facebook"] */
  targets: jsonb("targets").notNull().default(sql`'[]'::jsonb`),
  /** "image", "carousel", "video", "reel", "story" */
  format: text("format").notNull().default("image"),
  caption: text("caption").notNull().default(""),
  /** [{ type: "image" | "video", url, mediaId? }] — public URLs Meta can fetch. */
  media: jsonb("media").notNull().default(sql`'[]'::jsonb`),
  status: text("status").notNull().default("draft"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  igMediaId: text("ig_media_id"),
  igPermalink: text("ig_permalink"),
  fbPostId: text("fb_post_id"),
  fbPermalink: text("fb_permalink"),
  thumbnail: text("thumbnail"),
  error: text("error"),
  /** { instagram: { views, reach, likes, comments, saves, shares, total }, facebook: {...} } */
  insights: jsonb("insights"),
  insightsAt: timestamp("insights_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("academy_social_posts_source_check", sql`${table.source} in ('replay', 'synced')`),
  check("academy_social_posts_format_check", sql`${table.format} in ('image', 'carousel', 'video', 'reel', 'story')`),
  check("academy_social_posts_status_check", sql`${table.status} in ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed')`),
  uniqueIndex("academy_social_posts_ig_unique").on(table.igMediaId).where(sql`${table.igMediaId} is not null`),
  uniqueIndex("academy_social_posts_fb_unique").on(table.fbPostId).where(sql`${table.fbPostId} is not null`),
  index("academy_social_posts_academy_idx").on(table.academyId, table.publishedAt),
  index("academy_social_posts_due_idx").on(table.status, table.scheduledFor),
]);

export type AcademySocialAccount = typeof academySocialAccountsTable.$inferSelect;
export type AcademySocialThread = typeof academySocialThreadsTable.$inferSelect;
export type AcademySocialMessage = typeof academySocialMessagesTable.$inferSelect;
export type AcademySocialComment = typeof academySocialCommentsTable.$inferSelect;
export type AcademySocialPost = typeof academySocialPostsTable.$inferSelect;

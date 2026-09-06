import { pgTable, serial, integer, text, doublePrecision, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { recordingsTable } from "./recordings";

/**
 * Every human identity decision, with the geometry that produced it.
 *
 * This is the training set, and it is written for one reason: an override is
 * ground truth. A player watching their own match knows their own kit, build
 * and gait, so "that is not me from here" is as good a label as this project
 * will ever get — better than the proxies every linker decision currently
 * rests on, and it is the 30-minute hand label that
 * claude/linker-is-the-bottleneck-2026-08-30.md names as the thing standing
 * between "these numbers moved" and "the tracker is better".
 *
 * The shape deliberately mirrors the `corrections` table already sitting in
 * /opt/replay/labels/labels.db on vps1 — same three kinds — so the offline
 * labelling sessions and the in-product ones can be merged into one set later.
 * That table has been there since the labelling tool was built and has never
 * had a row written to it.
 *
 * WHY THE GEOMETRY IS STORED RATHER THAN DERIVED
 *
 * The same labels.db holds 48 real human picks whose `geom` column is NULL on
 * every single row. Those labels can only train a geometric model if the
 * source clip and its detections still exist to re-derive from. Tracking
 * bundles here are replaced and Bunny objects are pruned at fourteen days, so
 * a label without its features has a two-week shelf life. Freezing the
 * geometry at decision time is the difference between a growing corpus and a
 * rolling window.
 *
 * WHAT IS AND IS NOT A CLEAN LABEL
 *
 *   switch   the human said the chain was following the wrong player. Gold.
 *   lost     the human said we lost them here, with no replacement named. Gold.
 *   confirm  the human was asked and said yes, still me. Gold.
 *
 * Silence is none of these and is deliberately not recorded as one. Playing
 * through a crossing without objecting means "I did not notice", not "nothing
 * happened", and the swaps a viewer will not notice — a similar-looking player
 * moving the same way — are exactly the cases a model most needs. Treating
 * silence as a negative would train a model to be most confident where it is
 * most wrong.
 */
export type ClaimChainLabelKind = "switch" | "lost" | "confirm";

export const claimChainLabelsTable = pgTable("claim_chain_labels", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  recordingId: integer("recording_id").notNull().references(() => recordingsTable.id, { onDelete: "cascade" }),
  /**
   * Which tracking bundle this decision was made against. Track ids are
   * bundle-relative, so a label from a replaced bundle refers to tracks that
   * no longer exist — it stays for audit but must never be trained on as
   * though it described the current one.
   */
  bundleFingerprint: text("bundle_fingerprint").notNull(),
  kind: text("kind").$type<ClaimChainLabelKind>().notNull(),
  atFrame: integer("at_frame").notNull(),
  /** The track that was wrong. Null for a confirm. */
  wrongTrackId: text("wrong_track_id"),
  /** The track the human named instead. Null for a lost, and for a confirm. */
  rightTrackId: text("right_track_id"),
  /**
   * How long the human took, in milliseconds. Free difficulty weighting: the
   * picks already on vps1 range from 966 ms to 13,619 ms, and the slow ones
   * are the hard cases. Also the only honest measure of whether the tool is
   * getting faster to use.
   */
  decisionMs: integer("decision_ms"),
  /** DecisionGeometry from claimChain.ts — chosen, rejected, alternatives. */
  geom: jsonb("geom").$type<Record<string, unknown>>(),
  /** What the detector believed at this instant, so it can be scored later. */
  detectorSwapEvidence: doublePrecision("detector_swap_evidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Reads are "everything for this recording" (export a training set) and
  // "everything by this user" (audit one claimant's decisions).
  index("claim_chain_labels_recording_idx").on(table.recordingId, table.atFrame),
  index("claim_chain_labels_user_idx").on(table.userId, table.createdAt),
  // Scoring a detector means selecting one bundle's labels and no others.
  index("claim_chain_labels_bundle_idx").on(table.bundleFingerprint),
]);

export type ClaimChainLabelRow = typeof claimChainLabelsTable.$inferSelect;

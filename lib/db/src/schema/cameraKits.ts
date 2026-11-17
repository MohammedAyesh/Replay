import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";

import { academiesTable } from "./academies";
import type { TrackingPitchModel } from "./claimMatch";
import { fieldsTable } from "./fields";
import { footageRequestsTable } from "./footageRequests";
import { usersTable } from "./users";
import { venuePitchesTable } from "./venues";

/**
 * Portable cameras (0081).
 *
 * A kit is a camera, a mast, a MiFi and a battery that travels from pitch to
 * pitch. Every recording still needs a `fields` row, so each kit owns one hidden
 * field (`field_id`) whose `camera_id` is the kit's camera: the footage pipeline,
 * the recordings list and the analysis queue work unchanged.
 *
 * What changes from pitch to pitch is the calibration, so it lives on the set-up
 * (one kit at one pitch, from mounting to stop), never on the camera. A recording
 * made inside a set-up's window reads that set-up's pitch model
 * (lib/cameraPitchModel.ts); moving the kit cannot change older stats.
 */
export const cameraKitsTable = pgTable("camera_kits", {
  id: serial("id").primaryKey(),
  /** The field or academy that owns the kit; null for Replay's own kits. */
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  /** The camera name the control server knows, the same as fields.camera_id ("camera3"). */
  cameraId: text("camera_id").notNull(),
  /** The kit's hidden field; recordings from the kit are filed under it. */
  fieldId: integer("field_id").references(() => fieldsTable.id, { onDelete: "set null" }),
  /** The network saved on the camera. Rename a phone hotspot to this and the camera joins it. */
  wifiSsid: text("wifi_ssid"),
  wifiPassword: text("wifi_password"),
  /** The relay on the kit's MiFi for full-quality playback at the pitch, e.g. https://kit1.lan.replayjo.com. */
  localUrl: text("local_url"),
  /** Printed on the QR sticker: /kit?k=<token>. */
  token: text("token").notNull().unique(),
  archived: boolean("archived").notNull().default(false),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("camera_kits_academy_idx").on(table.academyId),
  index("camera_kits_camera_idx").on(table.cameraId),
]);

export const KIT_SETUP_KINDS = ["match", "training", "session"] as const;
export type KitSetupKind = (typeof KIT_SETUP_KINDS)[number];

/**
 * setting_up → recording → measuring → measured | needs_look → approved
 * (or failed / cancelled). `measured` is approved automatically: the size agreed
 * with the saved pitch, or nothing was saved to disagree with.
 */
export const KIT_SETUP_STATUSES = ["setting_up", "recording", "measuring", "measured", "needs_look", "approved", "failed", "cancelled"] as const;
export type KitSetupStatus = (typeof KIT_SETUP_STATUSES)[number];

export type KitCalibration = {
  lengthM?: number | null;
  widthM?: number | null;
  mastHeightM?: number | null;
  tiltDeg?: number | null;
  rollDeg?: number | null;
  linesPx?: number | null;
  circleAspectPct?: number | null;
  statureM?: number | null;
  warnings?: string[];
  overlayUrl?: string | null;
  source?: string | null;
};

export const cameraSetupsTable = pgTable("camera_setups", {
  id: serial("id").primaryKey(),
  kitId: integer("kit_id").notNull().references(() => cameraKitsTable.id, { onDelete: "cascade" }),
  academyId: integer("academy_id").references(() => academiesTable.id, { onDelete: "set null" }),
  /** A pitch the owner already has; null for "somewhere else". */
  pitchId: integer("pitch_id").references(() => venuePitchesTable.id, { onDelete: "set null" }),
  placeName: text("place_name"),
  /** Players a side, as venue_pitches.size. */
  placeSize: text("place_size"),
  knownLengthM: real("known_length_m"),
  knownWidthM: real("known_width_m"),
  /** Ground to lens, typed by whoever put the mast up. Nothing assumes a height. */
  mastHeightM: real("mast_height_m").notNull(),
  kind: text("kind").notNull().default("match"),
  title: text("title"),
  status: text("status").notNull().default("setting_up"),
  viewConfirmedAt: timestamp("view_confirmed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  /** Amman wall time, "YYYY-MM-DD HH:MM", as the footage ledger keeps it. */
  startLocal: text("start_local"),
  endLocal: text("end_local"),
  footageRequestId: integer("footage_request_id").references(() => footageRequestsTable.id, { onDelete: "set null" }),
  calibration: jsonb("calibration").$type<KitCalibration>(),
  pitchModel: jsonb("pitch_model").$type<TrackingPitchModel>(),
  measuredLengthM: real("measured_length_m"),
  measuredWidthM: real("measured_width_m"),
  reviewNote: text("review_note"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("camera_setups_kit_idx").on(table.kitId, table.createdAt),
  index("camera_setups_academy_idx").on(table.academyId, table.createdAt),
  index("camera_setups_status_idx").on(table.status),
  check("camera_setups_kind_check", sql`${table.kind} in ('match', 'training', 'session')`),
  check("camera_setups_status_check", sql`${table.status} in ('setting_up', 'recording', 'measuring', 'measured', 'needs_look', 'approved', 'failed', 'cancelled')`),
  check("camera_setups_mast_check", sql`${table.mastHeightM} between 1 and 20`),
]);

export type CameraKit = typeof cameraKitsTable.$inferSelect;
export type CameraSetup = typeof cameraSetupsTable.$inferSelect;

import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

import type { TrackingPitchModel } from "./claimMatch";

/**
 * A physical camera, and the calibration that belongs to it.
 *
 * The pitch model used to live inside every recording's tracking manifest,
 * which meant re-uploading the same grid for every night's footage and no way
 * to fix a bad calibration except recording by recording. A camera bolted to a
 * mast sees the same pitch the same way every night, so the calibration is a
 * property of the camera, not of anything it filmed.
 *
 * The id is the same free-text camera name `fields.camera_id` already carries
 * ("camera1", "camera2"), so a recording resolves to a camera through its
 * field. That column has no foreign key and is nullable, so "this field has no
 * camera" is a real state every read has to handle -- alongside "this camera
 * has no model" and "this camera's model does not match this bundle's crop".
 */
export const camerasTable = pgTable("cameras", {
  /** The camera name used throughout the system, e.g. "camera1". */
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  /**
   * Image-to-pitch calibration. Null until someone uploads one; a camera
   * without a model produces heatmaps in camera space and no distance or
   * speed at all.
   */
  pitchModel: jsonb("pitch_model").$type<TrackingPitchModel>(),
  pitchModelUpdatedAt: timestamp("pitch_model_updated_at", { withTimezone: true }),
  pitchModelUpdatedBy: integer("pitch_model_updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CameraRow = typeof camerasTable.$inferSelect;

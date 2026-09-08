/**
 * Resolving a camera's calibration onto a recording.
 *
 * The pitch model belongs to the camera (lib/db/src/schema/cameras.ts), but
 * every metric downstream reads `manifest.pitchModel` and is a pure function
 * of the manifest. Rather than thread an async lookup through that whole tree,
 * the model is attached to the manifest at load time and the pure core is left
 * alone.
 *
 * A model is attached only if it is valid for that bundle's crop. A grid
 * fitted for 4096x1152 applied to a differently-cropped bundle still produces
 * numbers -- they are just not where the player was -- so a mismatch drops the
 * model rather than silently reporting fiction. Distance and speed come back
 * null and the heatmap falls back to camera space, which is visibly a
 * degradation rather than an invisible lie.
 *
 * Three distinct "no metres" states, all normal, none an error: the field
 * names no camera, the camera has no model, the model does not fit this crop.
 */
import { eq, inArray } from "drizzle-orm";
import {
  camerasTable,
  db,
  fieldsTable,
  recordingsTable,
  type TrackingManifest,
  type TrackingPitchModel,
} from "@workspace/db";

import { parsePitchModel, pitchModelFramingError } from "./pitchModel";

export type PitchModelFit =
  | { attached: true; model: TrackingPitchModel; cameraId: string }
  | { attached: false; cameraId: string | null; reason: string | null };

/**
 * Whether this camera's model can speak for this bundle.
 *
 * Kept pure and separate from the query so the admin surface can explain a
 * refusal ("fitted for a different crop") instead of just showing no numbers.
 */
export function fitPitchModel(
  model: TrackingPitchModel | null | undefined,
  cameraId: string | null,
  width: number,
  height: number,
): PitchModelFit {
  if (!cameraId) return { attached: false, cameraId: null, reason: null };
  if (!model) return { attached: false, cameraId, reason: null };
  const parsed = parsePitchModel(model);
  if (parsed.error || !parsed.model) {
    return { attached: false, cameraId, reason: parsed.error ?? "Invalid pitch model" };
  }
  const framing = pitchModelFramingError(parsed.model, width, height);
  if (framing) return { attached: false, cameraId, reason: framing };
  return { attached: true, model: parsed.model, cameraId };
}

/** The manifest as the metrics should see it, with the camera's model on it. */
export function manifestWithPitchModel(
  manifest: TrackingManifest,
  model: TrackingPitchModel | null | undefined,
  cameraId: string | null,
): TrackingManifest {
  const fit = fitPitchModel(model, cameraId, manifest.width, manifest.height);
  if (!fit.attached) {
    if (!manifest.pitchModel) return manifest;
    const stripped = { ...manifest };
    delete stripped.pitchModel;
    return stripped;
  }
  return { ...manifest, pitchModel: fit.model };
}

/** The camera a recording was shot on, via its field. Null is a normal answer. */
export async function cameraForRecording(recordingId: number): Promise<{
  cameraId: string | null;
  pitchModel: TrackingPitchModel | null;
}> {
  const [row] = await db
    .select({
      cameraId: fieldsTable.cameraId,
      pitchModel: camerasTable.pitchModel,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .leftJoin(camerasTable, eq(camerasTable.id, fieldsTable.cameraId))
    .where(eq(recordingsTable.id, recordingId));
  return { cameraId: row?.cameraId ?? null, pitchModel: row?.pitchModel ?? null };
}

/** Same, for many recordings at once, so a list page is one query not N. */
export async function camerasForRecordings(recordingIds: number[]): Promise<
  Map<number, { cameraId: string | null; pitchModel: TrackingPitchModel | null }>
> {
  const out = new Map<number, { cameraId: string | null; pitchModel: TrackingPitchModel | null }>();
  if (!recordingIds.length) return out;
  const rows = await db
    .select({
      recordingId: recordingsTable.id,
      cameraId: fieldsTable.cameraId,
      pitchModel: camerasTable.pitchModel,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .leftJoin(camerasTable, eq(camerasTable.id, fieldsTable.cameraId))
    .where(inArray(recordingsTable.id, recordingIds));
  for (const row of rows) {
    out.set(row.recordingId, {
      cameraId: row.cameraId ?? null,
      pitchModel: row.pitchModel ?? null,
    });
  }
  return out;
}

/**
 * The calibration identity that a cached statistic depends on.
 *
 * Stats caches key off the bundle fingerprint. Editing a camera's calibration
 * changes no bundle, so without this in the key every cached distance and
 * heatmap would keep serving numbers from the calibration it replaced.
 */
export function pitchModelCacheKey(model: TrackingPitchModel | null | undefined): string {
  if (!model) return "no-pitch-model";
  return `${model.calibrationId}@${model.fittedAt}`;
}

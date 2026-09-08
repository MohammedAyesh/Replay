/**
 * The pitch model: the only thing that turns pixels into metres.
 *
 * It is not a homography. It is a rectangular grid of pitch positions in
 * metres, sampled over the image in row-major order, bilinearly interpolated
 * between the four surrounding points. A camera bolted to a mast sees the
 * same pitch the same way every night, so this belongs to the camera, not to
 * any one recording -- see lib/cameraPitchModel.ts for the resolution, which
 * injects the camera's model into a manifest at load time so everything below
 * stays a pure function of the manifest.
 *
 * Without a usable model there are no metres: distance and speed come back
 * null and heatmaps fall back to image coordinates, which cannot be compared
 * between two recordings, let alone added up.
 */
import type { TrackingManifest, TrackingPitchModel } from "@workspace/db";

import { asRecord, firstNumber, firstString } from "./jsonCoerce";

/**
 * A model fitted for one crop is wrong for another, and wrong quietly: the
 * numbers still come out, they are just not where the player was. One percent
 * is tighter than any real re-crop and looser than float noise.
 */
export const PITCH_ASPECT_RATIO_TOLERANCE = 0.01;

export function parsePitchModel(input: unknown): { model?: TrackingPitchModel; error?: string } {
  if (input === undefined || input === null) return {};
  const source = asRecord(input);
  const calibrationId = firstString(source.calibrationId, source.calibrationIdentifier, source.calibration_id);
  const fittedAt = firstString(
    source.fittedAt,
    source.fitDate,
    source.fittedDate,
    source.fitted_at,
    source.fit_date,
    source.calibratedAt,
    source.calibrated_at,
  );
  const calibratedAspectRatio = firstNumber(
    source.calibratedAspectRatio,
    source.calibrationAspectRatio,
    source.aspectRatio,
    source.sourceAspectRatio,
    source.calibrated_aspect_ratio,
    source.aspect_ratio,
  );
  const pitchWidthMetres = firstNumber(source.pitchWidthMetres);
  const pitchHeightMetres = firstNumber(source.pitchHeightMetres);
  const rawGrid = source.grid;
  if (!calibrationId) return { error: "Pitch model calibrationId is required" };
  if (!fittedAt || Number.isNaN(Date.parse(fittedAt))) {
    return { error: "Pitch model fittedAt must be a valid date-time" };
  }
  if (calibratedAspectRatio === undefined || calibratedAspectRatio <= 0) {
    return { error: "Pitch model calibratedAspectRatio must be a positive number" };
  }
  if (
    pitchWidthMetres === undefined
    || pitchHeightMetres === undefined
    || pitchWidthMetres <= 0
    || pitchHeightMetres <= 0
  ) {
    return { error: "Pitch model dimensions must be positive numbers" };
  }
  if (!Array.isArray(rawGrid) || rawGrid.length < 2) {
    return { error: "Pitch model grid must contain at least two rows" };
  }
  const grid: TrackingPitchModel["grid"] = [];
  let columnCount: number | null = null;
  for (const rawRow of rawGrid) {
    if (!Array.isArray(rawRow) || rawRow.length < 2) {
      return { error: "Every pitch model grid row must contain at least two points" };
    }
    if (columnCount === null) columnCount = rawRow.length;
    if (rawRow.length !== columnCount) {
      return { error: "Pitch model grid rows must all have the same number of points" };
    }
    const row: Array<{ x: number; y: number }> = [];
    for (const rawPoint of rawRow) {
      const point = asRecord(rawPoint);
      const x = firstNumber(point.x);
      const y = firstNumber(point.y);
      if (
        x === undefined
        || y === undefined
        || x < 0
        || x > pitchWidthMetres
        || y < 0
        || y > pitchHeightMetres
      ) {
        return {
          error: "Pitch model points must be finite and inside the declared pitch dimensions",
        };
      }
      row.push({ x, y });
    }
    grid.push(row);
  }
  return {
    model: {
      calibrationId,
      fittedAt: new Date(fittedAt).toISOString(),
      calibratedAspectRatio,
      pitchWidthMetres,
      pitchHeightMetres,
      grid,
    },
  };
}

export function pitchModelSummary(model: TrackingPitchModel | undefined) {
  const stored = model as (TrackingPitchModel & {
    calibrationId?: string;
    fittedAt?: string;
    calibratedAspectRatio?: number;
  }) | undefined;
  return stored
    ? {
        calibrationId: stored.calibrationId ?? null,
        fittedAt: stored.fittedAt ?? null,
        calibratedAspectRatio: stored.calibratedAspectRatio ?? null,
        gridRows: stored.grid.length,
        gridColumns: stored.grid[0]?.length ?? 0,
        pitchWidthMetres: stored.pitchWidthMetres,
        pitchHeightMetres: stored.pitchHeightMetres,
      }
    : null;
}

export function pitchModelFramingError(
  model: TrackingPitchModel,
  width: number,
  height: number,
): string | undefined {
  const bundleAspectRatio = width / height;
  const relativeDifference = Math.abs(bundleAspectRatio - model.calibratedAspectRatio)
    / model.calibratedAspectRatio;
  if (relativeDifference <= PITCH_ASPECT_RATIO_TOLERANCE) return undefined;
  return `Pitch model aspect ratio ${model.calibratedAspectRatio.toFixed(4)} does not match bundle aspect ratio ${bundleAspectRatio.toFixed(4)}; the model was fitted for a different crop`;
}

export function validatePitchModelForManifest(
  model: TrackingPitchModel | undefined,
  width: number,
  height: number,
): string | undefined {
  if (!model) return undefined;
  const parsed = parsePitchModel(model);
  if (parsed.error || !parsed.model) return parsed.error ?? "Invalid pitch model";
  return pitchModelFramingError(parsed.model, width, height);
}

export function manifestForClient(manifest: TrackingManifest): TrackingManifest {
  if (!manifest.pitchModel || !validatePitchModelForManifest(manifest.pitchModel, manifest.width, manifest.height)) {
    return manifest;
  }
  const safeManifest = { ...manifest };
  delete safeManifest.pitchModel;
  return safeManifest;
}

export function interpolatePitchPosition(
  x: number,
  y: number,
  manifest: TrackingManifest,
): { x: number; y: number } | null {
  const model = manifest.pitchModel;
  if (!model || model.grid.length < 2 || model.grid[0].length < 2) return null;
  const columns = model.grid[0].length;
  if (model.grid.some((row) => row.length !== columns || row.length < 2)) return null;
  const u = Math.max(0, Math.min(1, x / Math.max(manifest.width, 1)));
  const v = Math.max(0, Math.min(1, y / Math.max(manifest.height, 1)));
  const column = u * (columns - 1);
  const row = v * (model.grid.length - 1);
  const left = Math.floor(column);
  const top = Math.floor(row);
  const right = Math.min(columns - 1, left + 1);
  const bottom = Math.min(model.grid.length - 1, top + 1);
  const tx = column - left;
  const ty = row - top;
  const topLeft = model.grid[top][left];
  const topRight = model.grid[top][right];
  const bottomLeft = model.grid[bottom][left];
  const bottomRight = model.grid[bottom][right];
  return {
    x: (topLeft.x * (1 - tx) + topRight.x * tx) * (1 - ty)
      + (bottomLeft.x * (1 - tx) + bottomRight.x * tx) * ty,
    y: (topLeft.y * (1 - tx) + topRight.y * tx) * (1 - ty)
      + (bottomLeft.y * (1 - tx) + bottomRight.y * tx) * ty,
  };
}

export function hasUsablePitchModel(manifest: TrackingManifest): boolean {
  const model = manifest.pitchModel;
  if (!model || model.grid.length < 2 || model.grid[0].length < 2) return false;
  const columns = model.grid[0].length;
  if (!model.grid.every((row) => row.length === columns && row.length >= 2)) return false;
  return !validatePitchModelForManifest(model, manifest.width, manifest.height);
}

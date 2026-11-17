/**
 * Which calibration a portable kit's recording reads (kept apart from lib/cameraKits.ts so
 * lib/cameraPitchModel.ts doesn't pull in the footage booking code).
 */
import { and, eq, inArray } from "drizzle-orm";
import { cameraKitsTable, cameraSetupsTable, db, type TrackingPitchModel } from "@workspace/db";

import { wallMinutes } from "./venues/core";

// ─── Recordings read the set-up's calibration ────────────────────────────────

export const TRUSTED = ["measured", "approved"] as const;

/**
 * The set-up whose window a recording on this camera falls in, if its pitch is
 * trusted. Recordings from a kit are filed under the kit's field and carry the
 * set-up's footage request window; matching on the window keeps a recording
 * made before or after the set-up on the camera's own calibration.
 */
export async function setupModelsForRecordings(
  rows: Array<{ recordingId: number; cameraId: string | null; fieldId: number | null; date: string | null; timeSlot: string | null }>,
): Promise<Map<number, TrackingPitchModel>> {
  const out = new Map<number, TrackingPitchModel>();
  const fieldIds = [...new Set(rows.map((r) => r.fieldId).filter((x): x is number => x != null))];
  if (!fieldIds.length) return out;
  let kits: Array<{ id: number; fieldId: number | null }>;
  try {
    kits = await db.select({ id: cameraKitsTable.id, fieldId: cameraKitsTable.fieldId }).from(cameraKitsTable).where(inArray(cameraKitsTable.fieldId, fieldIds));
  } catch {
    return out; // a database without 0081 has no kits
  }
  if (!kits.length) return out;
  const setups = await db.select().from(cameraSetupsTable).where(and(
    inArray(cameraSetupsTable.kitId, kits.map((k) => k.id)),
    inArray(cameraSetupsTable.status, [...TRUSTED]),
  ));
  const kitByField = new Map(kits.map((k) => [k.fieldId, k.id]));
  for (const r of rows) {
    const kitId = r.fieldId != null ? kitByField.get(r.fieldId) : undefined;
    if (!kitId || !r.date) continue;
    const start = /^(\d{2}):(\d{2})/.exec(r.timeSlot ?? "");
    const at = start ? wallMinutes(`${r.date} ${start[1]}:${start[2]}`) : Number.NaN;
    const match = setups.find((s) => s.kitId === kitId && s.pitchModel && s.startLocal && s.endLocal
      && Number.isFinite(at) && at >= wallMinutes(s.startLocal) - 5 && at <= wallMinutes(s.endLocal));
    if (match?.pitchModel) out.set(r.recordingId, match.pitchModel);
  }
  return out;
}


/** A portable kit's hidden field. Its recordings are always analysed: the pitch can't be measured without the player boxes. */
export async function isKitField(fieldId: number): Promise<boolean> {
  try {
    const [kit] = await db.select({ id: cameraKitsTable.id }).from(cameraKitsTable).where(eq(cameraKitsTable.fieldId, fieldId)).limit(1);
    return Boolean(kit);
  } catch {
    return false;
  }
}

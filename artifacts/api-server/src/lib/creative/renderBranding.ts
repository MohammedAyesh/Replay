/**
 * The venue's branding on a Creative hub video (scene.branding): its mark over
 * the footage, and its sign-off card after it — the same drawings a branded
 * clip download gets (lib/clipBranding), at the design's own size.
 *
 * The look is the academy's or field's branding profile (Admin → Branding),
 * else its own name and logo. Anything that can't be drawn is left out; a
 * design is never refused for its branding.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { academiesTable, db, venueSettingsTable } from "@workspace/db";
import type { Scene } from "@workspace/api-zod";
import { ensureBrandingFonts, loadLocalImage, replayMarkPath } from "../clipBranding/assets";
import { renderOverlayPng } from "../clipBranding/overlay";
import { lookFor, publicBase } from "../clipBranding/plan";
import type { EndScreenJob } from "../clipBranding/endScreenVideo";
import { logger } from "../logger";

export type CreativeBranding = { overlayPath: string | null; endScreen: EndScreenJob | null };

/** How long the sign-off card lasts, its blur over the held last frame and its darkening. */
export const END_CARD = { seconds: 2.5, blur: 14, dim: 0.45 };

export async function creativeBranding(academyId: number, scene: Scene, dims: { w: number; h: number }, temps: string[]): Promise<CreativeBranding> {
  const out: CreativeBranding = { overlayPath: null, endScreen: null };
  const wants = scene.branding;
  if (!wants || (!wants.overlay && !wants.endCard)) return out;
  try {
    const [academy] = await db.select({ fieldId: academiesTable.fieldId, kind: academiesTable.kind }).from(academiesTable).where(eq(academiesTable.id, academyId));
    const look = await lookFor({ academyId, fieldId: academy?.fieldId ?? null }, temps);
    if (!look) return out;
    ensureBrandingFonts();
    if (wants.overlay) {
      const mark = await loadLocalImage(replayMarkPath());
      const png = renderOverlayPng({ style: "cornerCrest", look, dims, mark });
      const file = path.join(os.tmpdir(), `creative-overlay-${randomUUID()}.png`);
      await fs.promises.writeFile(file, png);
      temps.push(file);
      out.overlayPath = file;
    }
    if (wants.endCard) {
      // The card's QR opens the field's booking page, else Replay.
      let link = publicBase();
      if (academy?.kind === "venue") {
        const [settings] = await db.select({ slug: venueSettingsTable.slug }).from(venueSettingsTable).where(eq(venueSettingsTable.academyId, academyId));
        if (settings?.slug) link = `${publicBase()}/v/${settings.slug}`;
      }
      out.endScreen = { spec: { kind: "signOff", look, dateLabel: null, link }, ...END_CARD };
    }
  } catch (error) {
    logger.warn({ academyId, error: (error as Error).message }, "Creative render: branding left out");
  }
  return out;
}

import fs from "fs";
import { eq } from "drizzle-orm";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  db,
  academiesTable,
  brandingProfilesTable,
  fieldsTable,
  type BrandingScopeType,
} from "@workspace/db";
import { isBunnyStorageConfigured, uploadBufferToBunnyStorage } from "../bunny";
import { logger } from "../logger";
import { lookFor, presetFileFromUrl } from "./plan";
import { PREVIEW_DIMS, renderPreviewMp4, renderPreviewPng } from "./preview";
import { END_SCREEN_KINDS, OVERLAY_STYLES, type EndScreenKind } from "./types";

/**
 * The branding profile's storage and validation, shared by Admin → Branding
 * (routes/branding.ts) and the academy console's own Branding section
 * (routes/academyBranding.ts). One copy, so an academy owner can never save a
 * look the admin console would have refused, or the other way round.
 */

export type ProfileScope = { scopeType: BrandingScopeType; scopeId: number };
export type ProfileRow = typeof brandingProfilesTable.$inferSelect;

export const HEX = /^#[0-9a-fA-F]{6}$/;
export const MAX_CREST_BYTES = 8 * 1024 * 1024;

export const PROFILE_SCHEMA_MISSING =
  "The branding_profiles table has not been created in this database yet. " +
  "In development run: pnpm --filter @workspace/db run push. In production it is created by the next Publish from the Replit website.";

export function isMissingBrandingSchema(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  if (code === "42P01") return true;
  return /relation .* does not exist/i.test(String((err as Error)?.message ?? ""));
}

/** PNG dimensions, straight out of the IHDR chunk. */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  // 8-byte signature, then a length+type header, then IHDR's width and height.
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export function profileJson(row: ProfileRow) {
  return {
    ...row,
    crestPreset: presetFileFromUrl(row.crestUrl) ? row.crestUrl!.slice("preset:".length) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

export async function scopeName(scopeType: BrandingScopeType, scopeId: number): Promise<string> {
  if (scopeType === "global") return "Replay";
  const table = scopeType === "academy" ? academiesTable : fieldsTable;
  const [row] = await db.select({ name: table.name }).from(table).where(eq(table.id, scopeId));
  return row?.name ?? "";
}

export async function upsertProfile(
  scope: ProfileScope,
  values: Partial<typeof brandingProfilesTable.$inferInsert>,
  userId: number,
): Promise<ProfileRow> {
  const nameEn = values.nameEn ?? (await scopeName(scope.scopeType, scope.scopeId));
  const [saved] = await db
    .insert(brandingProfilesTable)
    .values({ ...values, nameEn, scopeType: scope.scopeType, scopeId: scope.scopeId, updatedBy: userId })
    .onConflictDoUpdate({
      target: [brandingProfilesTable.scopeType, brandingProfilesTable.scopeId],
      set: { ...values, updatedBy: userId, updatedAt: new Date() },
    })
    .returning();
  return saved;
}

export type ProfileFields = {
  nameEn: string;
  nameAr: string | null;
  taglineAr: string | null;
  primaryColor: string;
  accentColor: string | null;
  bookingPhone: string | null;
  instagram: string | null;
  showPlayerNames: boolean;
};

/** The look's editable fields, validated exactly as Admin → Branding validates them. */
export function validateProfileFields(body: Record<string, unknown>):
  | { ok: true; values: ProfileFields }
  | { ok: false; error: string; field: string } {
  const nameEn = cleanText(body.nameEn, 40);
  if (!nameEn) return { ok: false, error: "The English name is required.", field: "nameEn" };
  const primaryColor = typeof body.primaryColor === "string" && HEX.test(body.primaryColor) ? body.primaryColor.toUpperCase() : null;
  if (!primaryColor) return { ok: false, error: "The main colour must look like #F4CF1F.", field: "primaryColor" };
  const accentRaw = body.accentColor;
  if (accentRaw && !(typeof accentRaw === "string" && HEX.test(accentRaw))) {
    return { ok: false, error: "The second colour must look like #3DB54A, or be empty.", field: "accentColor" };
  }
  return {
    ok: true,
    values: {
      nameEn,
      nameAr: cleanText(body.nameAr, 60),
      taglineAr: cleanText(body.taglineAr, 60),
      primaryColor,
      accentColor: accentRaw ? String(accentRaw).toUpperCase() : null,
      bookingPhone: cleanText(body.bookingPhone, 30),
      instagram: cleanText(body.instagram, 40)?.replace(/^@/, "") ?? null,
      showPlayerNames: body.showPlayerNames === true,
    },
  };
}

export type StoreResult =
  | { ok: true; profile: ProfileRow }
  | { ok: false; status: number; error: string };

/**
 * Store a crest PNG in Bunny Storage and point the scope's profile at it. The
 * timestamp in the path busts the CDN cache, as for every branding upload.
 */
export async function storeCrest(scope: ProfileScope, buffer: Buffer, userId: number): Promise<StoreResult> {
  if (buffer.length > MAX_CREST_BYTES) return { ok: false, status: 400, error: "A crest must be under 8 MB." };
  const size = readPngSize(buffer);
  if (!size) return { ok: false, status: 400, error: "A crest must be a PNG with a transparent background." };
  if (!isBunnyStorageConfigured()) {
    return { ok: false, status: 503, error: "Bunny Storage is not configured, so a crest cannot be stored." };
  }
  const scopeKey = scope.scopeType === "global" ? "global" : `${scope.scopeType}-${scope.scopeId}`;
  try {
    const crestUrl = await uploadBufferToBunnyStorage(buffer, `branding/${scopeKey}/crest-${Date.now()}.png`, "image/png");
    const saved = await upsertProfile(scope, { crestUrl, crestWidth: size.width, crestHeight: size.height }, userId);
    return { ok: true, profile: saved };
  } catch (err) {
    if (isMissingBrandingSchema(err)) return { ok: false, status: 503, error: PROFILE_SCHEMA_MISSING };
    logger.error({ err, scope }, "Could not store the crest");
    return { ok: false, status: 502, error: "Could not store the crest." };
  }
}

/**
 * Any image an owner has (a JPEG logo, a WebP, a data: URL) as a PNG crest,
 * at most `maxSide` px on its longer side. Transparency is kept where the
 * source has it. Null when the bytes are not an image.
 */
export async function imageToCrestPng(input: Buffer, maxSide = 800): Promise<Buffer | null> {
  try {
    const img = await loadImage(input);
    if (!img.width || !img.height) return null;
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const canvas = createCanvas(w, h);
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

/** "data:image/png;base64,…" → bytes and type, or null. */
export function decodeDataUrl(value: string | null | undefined): { mime: string; buffer: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value ?? "");
  if (!m) return null;
  const buffer = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  return buffer.length ? { mime: m[1].toLowerCase().replace("jpg", "jpeg"), buffer } : null;
}

export type PreviewQuery = Record<string, unknown>;
export type PreviewResult =
  | { kind: "png"; body: Buffer }
  | { kind: "mp4"; file: string }
  | { kind: "error"; status: number; error: string };

/**
 * The scope's real look over real footage, with sample numbers: the code path
 * behind GET /admin/branding/preview, for any caller already authorised for
 * the scope.
 */
export async function previewForScope(scope: ProfileScope, query: PreviewQuery): Promise<PreviewResult> {
  const what = String(query.what ?? "signOff");
  const isKind = (END_SCREEN_KINDS as readonly string[]).includes(what);
  const isOverlay = (OVERLAY_STYLES as readonly string[]).includes(what) && what !== "uploaded";
  if (!isKind && !isOverlay) return { kind: "error", status: 400, error: "Unknown preview." };
  const dims = PREVIEW_DIMS[query.aspect === "16:9" ? "16:9" : "9:16"];
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const seconds = num(query.seconds, 2, 6, 3);
  const blur = num(query.blur, 0, 40, 22);
  const dim = num(query.dim, 0, 90, 50) / 100;

  const temps: string[] = [];
  try {
    // An academy's clips fall back on the look of the field it plays at, as
    // exports do, so its preview has to as well.
    let fieldId: number | null = scope.scopeType === "field" ? scope.scopeId : null;
    if (scope.scopeType === "academy") {
      const [a] = await db.select({ fieldId: academiesTable.fieldId }).from(academiesTable)
        .where(eq(academiesTable.id, scope.scopeId));
      fieldId = a?.fieldId ?? null;
    }
    const look = await lookFor({
      academyId: scope.scopeType === "academy" ? scope.scopeId : null,
      fieldId,
    }, temps);
    if (!look) return { kind: "error", status: 404, error: "Nothing to preview yet: give this venue a name first." };
    if (query.format === "mp4" && isKind) {
      // The console bumps `v` whenever the look is saved, so a new crest of the
      // same size is not served from the cache.
      const lookKey = JSON.stringify({
        ...look,
        crest: look.crest ? `${look.crest.width}x${look.crest.height}` : null,
        scope,
        v: String(query.v ?? ""),
      });
      const file = await renderPreviewMp4({ look, lookKey, kind: what as EndScreenKind, dims, seconds, blur, dim });
      return { kind: "mp4", file };
    }
    const png = await renderPreviewPng({ look, what: what as never, dims, blur, dim });
    return { kind: "png", body: png };
  } catch (err) {
    logger.error({ err, scope, what }, "Branding preview failed");
    return { kind: "error", status: 500, error: "Could not render the preview." };
  } finally {
    for (const t of temps) fs.unlink(t, () => {});
  }
}

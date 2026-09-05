import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import {
  db,
  brandingAssetsTable,
  usersTable,
  academiesTable,
  fieldsTable,
  type BrandingKind,
  type BrandingScopeType,
} from "@workspace/db";
import { getLocalUserId, unauthenticatedResponse } from "../lib/clerkUserBridge";
import { logger } from "../lib/logger";
import { isBunnyStorageConfigured, uploadBufferToBunnyStorage } from "../lib/bunny";
import { getOutputDims } from "../lib/ffmpegExport";
import { overlayFits } from "../lib/brandingAssets";

/**
 * Uploading and listing the branding burned into exported clips.
 *
 * Assets live in object storage, not on disk. The previous design read them
 * from BRANDING_ROOT, defaulting to /opt/replay/branding — a path on the VPS,
 * while the export runs on Replit, whose filesystem is rebuilt on every deploy.
 * Nothing ever called that lookup, which is the only reason it never showed up
 * as a bug.
 */

const router: IRouter = Router();

const SCOPE_TYPES: BrandingScopeType[] = ["academy", "field", "global"];
const KINDS: BrandingKind[] = ["overlay", "endCard"];

/**
 * An overlay is a PNG a few hundred kilobytes at most; an end card is a short
 * video. The end card shares the intro's ceiling because it is the same kind of
 * thing — branding, not content.
 */
const MAX_OVERLAY_BYTES = 8 * 1024 * 1024;
const MAX_END_CARD_BYTES = 250 * 1024 * 1024;

const uploadAsset = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_END_CARD_BYTES },
});

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isAdmin ? userId : null;
}

export function isMissingBrandingSchema(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ((err as { cause?: { code?: string } })?.cause)?.code;
  if (code === "42P01") return true;
  return /relation .* does not exist/i.test(String((err as Error)?.message ?? ""));
}

const SCHEMA_MISSING =
  "The branding table has not been created in this database yet. " +
  "Open a Shell tab and run: pnpm --filter @workspace/db run push";

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

function parseScope(raw: unknown): { scopeType: BrandingScopeType; scopeId: number } | null {
  const value = String(Array.isArray(raw) ? raw[0] : raw ?? "");
  // 0, not null — see the schema comment: a NULL here would make every
  // global upload a new row instead of a replacement.
  if (value === "global") return { scopeType: "global", scopeId: 0 };
  const [type, id] = value.split(":");
  if (!SCOPE_TYPES.includes(type as BrandingScopeType) || type === "global") return null;
  const scopeId = Number.parseInt(id ?? "", 10);
  if (!Number.isInteger(scopeId) || scopeId <= 0) return null;
  return { scopeType: type as BrandingScopeType, scopeId };
}

/** Does the scope this asset is being attached to actually exist? */
async function scopeExists(scopeType: BrandingScopeType, scopeId: number): Promise<boolean> {
  if (scopeType === "global") return true;
  const table = scopeType === "academy" ? academiesTable : fieldsTable;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, scopeId));
  return !!row;
}

const scopeWhere = (scopeType: BrandingScopeType, scopeId: number, kind: BrandingKind) =>
  and(
    eq(brandingAssetsTable.scopeType, scopeType),
    eq(brandingAssetsTable.scopeId, scopeId),
    eq(brandingAssetsTable.kind, kind),
  );

/**
 * GET /admin/branding
 *
 * Everything uploaded, with the output geometry an overlay has to match. The
 * console needs the second part: an overlay is composited at 0,0 with no
 * scaling, so one authored at the wrong size does not fail — it sits in a
 * corner, and nobody finds out until a clip is shared.
 */
router.get("/admin/branding", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }
  const landscape = getOutputDims(false);
  const portrait = getOutputDims(true);
  try {
    const rows = await db.select().from(brandingAssetsTable);
    res.json({
      schemaReady: true,
      storageReady: isBunnyStorageConfigured(),
      outputSizes: { landscape, portrait },
      assets: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        fitsLandscape: row.kind === "overlay" ? overlayFits(row, landscape) : null,
        fitsPortrait: row.kind === "overlay" ? overlayFits(row, portrait) : null,
      })),
    });
  } catch (err) {
    if (!isMissingBrandingSchema(err)) throw err;
    res.json({
      schemaReady: false,
      message: SCHEMA_MISSING,
      storageReady: isBunnyStorageConfigured(),
      outputSizes: { landscape, portrait },
      assets: [],
    });
  }
});

/**
 * PUT /admin/branding/:kind
 * multipart: `asset`, plus `scope` as "global", "academy:<id>" or "field:<id>".
 */
router.put("/admin/branding/:kind", uploadAsset.single("asset"), async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }

  const kind = String(Array.isArray(req.params.kind) ? req.params.kind[0] : req.params.kind) as BrandingKind;
  if (!KINDS.includes(kind)) { res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` }); return; }

  const scope = parseScope((req.body as Record<string, unknown>)?.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }
  if (!(await scopeExists(scope.scopeType, scope.scopeId))) {
    res.status(404).json({ error: `No such ${scope.scopeType}: ${scope.scopeId}` });
    return;
  }

  const file = req.file;
  if (!file?.buffer?.length) { res.status(400).json({ error: "Attach the file as the 'asset' field." }); return; }
  if (!isBunnyStorageConfigured()) {
    res.status(503).json({ error: "Bunny Storage is not configured, so branding cannot be stored." });
    return;
  }

  let width: number | null = null;
  let height: number | null = null;
  if (kind === "overlay") {
    if (file.size > MAX_OVERLAY_BYTES) {
      res.status(400).json({ error: `An overlay must be under ${MAX_OVERLAY_BYTES / (1024 * 1024)} MB` });
      return;
    }
    const size = readPngSize(file.buffer);
    if (!size) {
      // Not a format preference: the overlay is composited with an alpha
      // channel, and a JPEG has none — it would paint a solid rectangle over
      // the whole frame.
      res.status(400).json({ error: "An overlay must be a PNG with transparency." });
      return;
    }
    width = size.width;
    height = size.height;
  }

  const extension = kind === "overlay" ? "png" : "mp4";
  const scopeKey = scope.scopeType === "global" ? "global" : `${scope.scopeType}-${scope.scopeId}`;
  // The timestamp is what busts the CDN cache. Overwriting a fixed path leaves
  // the previous asset being served from the edge for as long as it is cached,
  // which looks exactly like the upload not having worked.
  const remotePath = `branding/${scopeKey}/${kind}-${Date.now()}.${extension}`;

  try {
    const assetUrl = await uploadBufferToBunnyStorage(
      file.buffer,
      remotePath,
      kind === "overlay" ? "image/png" : "video/mp4",
    );
    const [saved] = await db
      .insert(brandingAssetsTable)
      .values({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        kind,
        assetUrl,
        width,
        height,
        bytes: file.size,
        contentType: file.mimetype,
        uploadedBy: adminId,
      })
      .onConflictDoUpdate({
        target: [brandingAssetsTable.scopeType, brandingAssetsTable.scopeId, brandingAssetsTable.kind],
        set: {
          assetUrl,
          width,
          height,
          bytes: file.size,
          contentType: file.mimetype,
          uploadedBy: adminId,
          updatedAt: new Date(),
        },
      })
      .returning();
    logger.info({ kind, scope, adminId, bytes: file.size }, "Branding asset uploaded");
    const landscape = getOutputDims(false);
    res.json({
      ...saved,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
      fitsLandscape: kind === "overlay" ? overlayFits(saved, landscape) : null,
    });
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: SCHEMA_MISSING }); return; }
    logger.error({ err, kind, scope }, "Could not store the branding asset");
    res.status(502).json({ error: "Could not store the branding asset." });
  }
});

/** DELETE /admin/branding/:kind?scope=... — stop using this asset. */
router.delete("/admin/branding/:kind", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const kind = String(Array.isArray(req.params.kind) ? req.params.kind[0] : req.params.kind) as BrandingKind;
  if (!KINDS.includes(kind)) { res.status(400).json({ error: `kind must be one of: ${KINDS.join(", ")}` }); return; }
  const scope = parseScope(req.query.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }

  try {
    await db.delete(brandingAssetsTable).where(scopeWhere(scope.scopeType, scope.scopeId, kind));
    logger.info({ kind, scope, adminId }, "Branding asset removed");
    // The stored object is deliberately left in place. It costs almost nothing,
    // and a clip exported an hour ago may still be referenced somewhere that
    // fetches it; deleting the bytes to tidy a row is how a share card loses
    // its picture.
    res.json({ ok: true });
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: SCHEMA_MISSING }); return; }
    throw err;
  }
});

export default router;

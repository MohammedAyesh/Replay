import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import {
  db,
  brandingAssetsTable,
  brandingProfilesTable,
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
import { BRANDING_PRESETS, presetCrestPath } from "../lib/clipBranding/assets";
import { presetFileFromUrl } from "../lib/clipBranding/plan";
import {
  PROFILE_SCHEMA_MISSING,
  isMissingBrandingSchema,
  previewForScope,
  profileJson,
  readPngSize,
  storeCrest,
  upsertProfile,
  validateProfileFields,
} from "../lib/clipBranding/profileStore";

// Kept importable from here: they were exported by this module before the
// profile helpers moved to lib/clipBranding/profileStore.ts.
export { isMissingBrandingSchema, readPngSize };

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

const SCHEMA_MISSING =
  "The branding table has not been created in this database yet. " +
  "Open a Shell tab and run: pnpm --filter @workspace/db run push";

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
    // A missing profiles table (the code is deployed, the publish that creates
    // it is not) must not take the uploaded branding down with it.
    let profiles: Array<typeof brandingProfilesTable.$inferSelect> = [];
    let profilesReady = true;
    try {
      profiles = await db.select().from(brandingProfilesTable);
    } catch (err) {
      if (!isMissingBrandingSchema(err)) throw err;
      profilesReady = false;
    }
    res.json({
      schemaReady: true,
      profilesReady,
      profiles: profiles.map(profileJson),
      presets: BRANDING_PRESETS.map((p) => ({ key: p.key, label: p.label, source: p.source })),
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
      profilesReady: false,
      profiles: [],
      presets: BRANDING_PRESETS.map((p) => ({ key: p.key, label: p.label, source: p.source })),
      message: SCHEMA_MISSING,
      storageReady: isBunnyStorageConfigured(),
      outputSizes: { landscape, portrait },
      assets: [],
    });
  }
});

// Registered before the /:kind routes below, which would otherwise take
// /profile, /crest, /preset and /preview as a branding kind.
// ── Branding profiles: the look the export draws itself ─────────────────────

/** PUT /admin/branding/profile — JSON: scope plus the profile fields. */
router.put("/admin/branding/profile", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scope = parseScope(body.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }
  if (!(await scopeExists(scope.scopeType, scope.scopeId))) {
    res.status(404).json({ error: `No such ${scope.scopeType}: ${scope.scopeId}` });
    return;
  }
  const fields = validateProfileFields(body);
  if (!fields.ok) { res.status(400).json({ error: fields.error }); return; }
  try {
    const saved = await upsertProfile(scope, fields.values, adminId);
    logger.info({ scope, adminId }, "Branding profile saved");
    res.json(profileJson(saved));
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: PROFILE_SCHEMA_MISSING }); return; }
    throw err;
  }
});

/** DELETE /admin/branding/profile?scope=… */
router.delete("/admin/branding/profile", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const scope = parseScope(req.query.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }
  try {
    await db.delete(brandingProfilesTable).where(and(
      eq(brandingProfilesTable.scopeType, scope.scopeType),
      eq(brandingProfilesTable.scopeId, scope.scopeId),
    ));
    logger.info({ scope, adminId }, "Branding profile removed");
    res.json({ ok: true });
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: PROFILE_SCHEMA_MISSING }); return; }
    throw err;
  }
});

/** PUT /admin/branding/crest — multipart `asset` (transparent PNG) + `scope`. */
router.put("/admin/branding/crest", uploadAsset.single("asset"), async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const scope = parseScope((req.body as Record<string, unknown>)?.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }
  if (!(await scopeExists(scope.scopeType, scope.scopeId))) {
    res.status(404).json({ error: `No such ${scope.scopeType}: ${scope.scopeId}` });
    return;
  }
  const file = req.file;
  if (!file?.buffer?.length) { res.status(400).json({ error: "Attach the crest as the 'asset' field." }); return; }
  const stored = await storeCrest(scope, file.buffer, adminId);
  if (!stored.ok) { res.status(stored.status).json({ error: stored.error }); return; }
  res.json(profileJson(stored.profile));
});

/**
 * POST /admin/branding/preset — JSON { scope, preset }. Fills the profile from
 * a real venue's public branding, bundled with the server (no upload needed).
 */
router.post("/admin/branding/preset", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { unauthenticatedResponse(res, req); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scope = parseScope(body.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }
  if (!(await scopeExists(scope.scopeType, scope.scopeId))) {
    res.status(404).json({ error: `No such ${scope.scopeType}: ${scope.scopeId}` });
    return;
  }
  const preset = BRANDING_PRESETS.find((p) => p.key === body.preset);
  if (!preset) { res.status(400).json({ error: "Unknown preset." }); return; }
  try {
    const crest = readPngSize(await fs.promises.readFile(presetCrestPath(preset)));
    const saved = await upsertProfile(scope, {
      nameEn: preset.nameEn,
      nameAr: preset.nameAr,
      taglineAr: preset.taglineAr,
      primaryColor: preset.primaryColor,
      accentColor: preset.accentColor,
      bookingPhone: preset.bookingPhone,
      instagram: preset.instagram,
      // Never showPlayerNames: whether a children's academy prints names is
      // that academy's own decision, not something a preset can switch on.
      crestUrl: `preset:${preset.crestFile}`,
      crestWidth: crest?.width ?? null,
      crestHeight: crest?.height ?? null,
    }, adminId);
    logger.info({ scope, adminId, preset: preset.key }, "Branding preset applied");
    res.json(profileJson(saved));
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: PROFILE_SCHEMA_MISSING }); return; }
    throw err;
  }
});

/** GET /admin/branding/preset-crest/:file — a bundled crest, for the console. */
router.get("/admin/branding/preset-crest/:file", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }
  const file = presetFileFromUrl(`preset:${String(req.params.file)}`);
  if (!file) { res.status(404).end(); return; }
  res.type("png").sendFile(file);
});

/**
 * GET /admin/branding/preview?scope=…&what=player|match|academy|signOff|cornerCrest|broadcastBar|academyFrame
 *     &aspect=9:16|16:9&format=png|mp4&seconds=3&blur=22&dim=50
 *
 * The scope's real look over real footage, with sample numbers.
 */
router.get("/admin/branding/preview", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req))) { unauthenticatedResponse(res, req); return; }
  const scope = parseScope(req.query.scope);
  if (!scope) { res.status(400).json({ error: 'scope must be "global", "academy:<id>" or "field:<id>"' }); return; }
  const result = await previewForScope(scope, req.query as Record<string, unknown>);
  if (result.kind === "error") { res.status(result.status).json({ error: result.error }); return; }
  if (result.kind === "mp4") { res.type("mp4").sendFile(result.file); return; }
  res.setHeader("Cache-Control", "no-store");
  res.type("png").send(result.body);
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

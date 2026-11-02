import fs from "fs";
import { and, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import { brandingProfilesTable, db, settingsRulesTable, type SettingsRuleRow } from "@workspace/db";
import { requireAcademyOwner, displayPhone, instagramHandle, type AcademyOwnerAccess } from "../lib/academyOwner";
import { isBunnyStorageConfigured } from "../lib/bunny";
import { fetchBrandingAsset } from "../lib/brandingFetch";
import { getOutputDims } from "../lib/ffmpegExport";
import { logger } from "../lib/logger";
import { loadBrandingProfile, presetFileFromUrl } from "../lib/clipBranding/plan";
import {
  PROFILE_SCHEMA_MISSING,
  decodeDataUrl,
  imageToCrestPng,
  isMissingBrandingSchema,
  previewForScope,
  profileJson,
  readPngSize,
  storeCrest,
  upsertProfile,
  validateProfileFields,
  type ProfileRow,
  type ProfileScope,
} from "../lib/clipBranding/profileStore";
import { explainSetting, invalidateSettingsCache, isMissingRelationError } from "../lib/settings";
import { getSetting, validateSettingValue } from "../lib/settingsRegistry";

/**
 * Academy console → Branding. The owner sets the academy's own look (the same
 * branding profile Admin → Branding edits for academy:<id>) and the switches
 * that decide what its clips get. A switch is an ordinary settings rule scoped
 * to this academy at priority 10 — exactly what Admin → Branding writes — so the
 * Settings tab still lists everything and there is one source of truth.
 *
 * Owner only; coaches and everyone else get 403.
 */
const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The keys an academy owner may set for the academy's own clips, in display order. */
export const ACADEMY_BRANDING_KEYS = [
  "branding.overlayEnabled",
  "branding.overlayStyle",
  "branding.endScreenEnabled",
  "branding.endScreen.academy",
  "branding.endScreen.player",
  "branding.endScreen.match",
  "branding.endScreen.signOff",
  "branding.endScreen.seconds",
  "branding.endScreen.blur",
  "branding.endScreen.dim",
  "branding.endCardEnabled",
] as const;
const KEY_SET = new Set<string>(ACADEMY_BRANDING_KEYS);

/** Above the default 0, so the academy's own choice beats a broad rule. Same as Admin → Branding. */
export const ACADEMY_RULE_PRIORITY = 10;

const base = "/academy/console/academies/:academyId/branding";
const owner = (req: Parameters<typeof requireAcademyOwner>[0], res: Response) => requireAcademyOwner(req, res, "Branding");
const scopeOf = (academyId: number): ProfileScope => ({ scopeType: "academy", scopeId: academyId });

async function ownProfile(academyId: number): Promise<ProfileRow | null> {
  const [row] = await db.select().from(brandingProfilesTable).where(and(
    eq(brandingProfilesTable.scopeType, "academy"),
    eq(brandingProfilesTable.scopeId, academyId),
  ));
  return row ?? null;
}

/**
 * The rules this section owns for a key: scoped to exactly this academy, with
 * no time window or exclusions. Read from the table, not from what currently
 * matches, so a rule someone switched off in Settings is reused rather than a
 * second one created beside it.
 */
function isOwnRule(r: SettingsRuleRow, academyId: number): boolean {
  return r.scopeType === "academy" && r.scopeId === academyId &&
    !(r.daysOfWeek as number[] | null)?.length && r.startMinute == null && r.endMinute == null &&
    !r.effectiveFrom && !r.effectiveUntil && !((r.excludes as unknown[] | null)?.length);
}

async function ownRules(academyId: number, keys: readonly string[]): Promise<SettingsRuleRow[]> {
  const rows = await db.select().from(settingsRulesTable).where(and(
    eq(settingsRulesTable.scopeType, "academy"),
    eq(settingsRulesTable.scopeId, academyId),
    inArray(settingsRulesTable.key, [...keys]),
  ));
  return rows.filter((r) => isOwnRule(r, academyId));
}

async function settingsView(access: AcademyOwnerAccess) {
  const ctx = { academyId: access.academyId, fieldId: access.academy.fieldId };
  let own: SettingsRuleRow[] = [];
  let ready = true;
  try {
    own = await ownRules(access.academyId, ACADEMY_BRANDING_KEYS);
  } catch (err) {
    if (!isMissingRelationError(err)) throw err;
    ready = false;
  }
  const settings = await Promise.all(ACADEMY_BRANDING_KEYS.map(async (key) => {
    const def = getSetting(key)!;
    const resolution = await explainSetting(key, ctx);
    const mine = own.filter((r) => r.key === key);
    const winning = mine.some((r) => r.id === resolution.rule?.id);
    return {
      key,
      value: resolution.value,
      /** "academy": the owner's own choice is what clips get; "replay": Replay's default or a rule Replay set. */
      source: winning ? "academy" as const : "replay" as const,
      /** The academy has its own value, but a stronger rule Replay set wins for now. */
      overridden: mine.length > 0 && !winning,
      hasOwn: mine.length > 0,
      type: def.type,
      min: def.min ?? null,
      max: def.max ?? null,
      options: def.options ?? null,
      unit: def.unit ?? null,
    };
  }));
  return { settings, settingsReady: ready };
}

async function brandingView(access: AcademyOwnerAccess) {
  const { academy, academyId } = access;
  let profile: ProfileRow | null = null;
  let profilesReady = true;
  try {
    profile = await ownProfile(academyId);
  } catch (err) {
    if (!isMissingBrandingSchema(err)) throw err;
    profilesReady = false;
  }
  // What the clips use while the academy has no look of its own: the field's
  // or Replay's profile for colour, the academy's own name and logo.
  const inherited = profile ? null : await loadBrandingProfile({ academyId: null, fieldId: academy.fieldId });
  const defaults = {
    nameEn: academy.name.slice(0, 40),
    nameAr: academy.nameAr?.slice(0, 60) ?? null,
    taglineAr: null as string | null,
    primaryColor: inherited?.primaryColor ?? "#2FD8C4",
    accentColor: null as string | null,
    bookingPhone: displayPhone(academy.whatsappPhone) ?? academy.contactPhone ?? null,
    instagram: instagramHandle(academy.instagramUrl),
    showPlayerNames: false,
  };
  const look = profile
    ? {
      nameEn: profile.nameEn, nameAr: profile.nameAr, taglineAr: profile.taglineAr, primaryColor: profile.primaryColor,
      accentColor: profile.accentColor, bookingPhone: profile.bookingPhone, instagram: profile.instagram,
      showPlayerNames: profile.showPlayerNames,
    }
    : defaults;
  const v = encodeURIComponent(profile?.updatedAt.toISOString() ?? "0");
  const crest = profile?.crestUrl
    ? { source: "own" as const, src: `/api/academy/console/academies/${academyId}/branding/crest?v=${v}` }
    : !profile && academy.logoUrl
      ? { source: "logo" as const, src: academy.logoUrl }
      : { source: "none" as const, src: null };
  return {
    academyId,
    hasOwnLook: !!profile,
    look,
    defaults,
    crest,
    logoUrl: academy.logoUrl ?? null,
    profile: profile ? profileJson(profile) : null,
    profilesReady,
    storageReady: isBunnyStorageConfigured(),
    outputSizes: { landscape: getOutputDims(false), portrait: getOutputDims(true) },
    ...(await settingsView(access)),
  };
}

router.get(base, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  res.json(await brandingView(access));
});

/** PUT …/branding/profile — the look, validated as Admin → Branding validates it. */
router.put(`${base}/profile`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const fields = validateProfileFields((req.body ?? {}) as Record<string, unknown>);
  if (!fields.ok) { res.status(400).json({ error: fields.error, field: fields.field }); return; }
  try {
    await upsertProfile(scopeOf(access.academyId), fields.values, access.user.id);
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: PROFILE_SCHEMA_MISSING }); return; }
    throw err;
  }
  logger.info({ academyId: access.academyId, userId: access.user.id }, "Academy owner saved the branding look");
  res.json(await brandingView(access));
});

/**
 * The first crest saved for an academy with no look yet also saves the look
 * the owner was shown (the defaults), so the crest does not arrive on a
 * profile named after nothing.
 */
async function ensureProfile(access: AcademyOwnerAccess): Promise<void> {
  if (await ownProfile(access.academyId)) return;
  const view = await brandingView(access);
  await upsertProfile(scopeOf(access.academyId), view.defaults, access.user.id);
}

async function saveCrest(access: AcademyOwnerAccess, png: Buffer, res: Response): Promise<void> {
  try {
    await ensureProfile(access);
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: PROFILE_SCHEMA_MISSING }); return; }
    throw err;
  }
  const stored = await storeCrest(scopeOf(access.academyId), png, access.user.id);
  if (!stored.ok) { res.status(stored.status).json({ error: stored.error }); return; }
  logger.info({ academyId: access.academyId, userId: access.user.id }, "Academy owner saved a crest");
  res.json(await brandingView(access));
}

/** PUT …/branding/crest — multipart `crest`: PNG (transparent is best), JPEG or WebP. */
router.put(`${base}/crest`, upload.single("crest"), async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const file = req.file;
  if (!file?.buffer?.length) { res.status(400).json({ error: "Attach the crest image." }); return; }
  if (!IMAGE_TYPES.has(file.mimetype)) { res.status(400).json({ error: "Use a PNG, JPEG or WebP image." }); return; }
  const png = readPngSize(file.buffer) ? file.buffer : await imageToCrestPng(file.buffer);
  if (!png) { res.status(400).json({ error: "That file isn't an image we can read." }); return; }
  await saveCrest(access, png, res);
});

/** POST …/branding/crest/from-logo — use the logo from the academy's Profile as the crest. */
router.post(`${base}/crest/from-logo`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const logoUrl = access.academy.logoUrl;
  if (!logoUrl) { res.status(404).json({ error: "Your academy has no logo yet. Add one in Profile." }); return; }
  let bytes: Buffer | null = decodeDataUrl(logoUrl)?.buffer ?? null;
  if (!bytes && /^https?:\/\//i.test(logoUrl)) {
    const local = await fetchBrandingAsset(logoUrl, "academy logo");
    if (local) {
      bytes = await fs.promises.readFile(local).catch(() => null);
      if (local !== logoUrl) fs.unlink(local, () => {});
    }
  }
  const png = bytes ? await imageToCrestPng(bytes) : null;
  if (!png) { res.status(422).json({ error: "Couldn't read your logo. Upload the crest instead." }); return; }
  await saveCrest(access, png, res);
});

/** DELETE …/branding/crest — back to the initials badge. */
router.delete(`${base}/crest`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  try {
    await db.update(brandingProfilesTable)
      .set({ crestUrl: null, crestWidth: null, crestHeight: null, updatedBy: access.user.id, updatedAt: new Date() })
      .where(and(eq(brandingProfilesTable.scopeType, "academy"), eq(brandingProfilesTable.scopeId, access.academyId)));
  } catch (err) {
    if (isMissingBrandingSchema(err)) { res.status(503).json({ error: PROFILE_SCHEMA_MISSING }); return; }
    throw err;
  }
  res.json(await brandingView(access));
});

/** GET …/branding/crest — the stored crest, for the console (storage is an authenticated origin). */
router.get(`${base}/crest`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const profile = await ownProfile(access.academyId).catch(() => null);
  const url = profile?.crestUrl;
  if (!url) { res.status(404).json({ error: "No crest" }); return; }
  const preset = presetFileFromUrl(url);
  if (preset) { res.type("png").sendFile(preset); return; }
  const inline = decodeDataUrl(url);
  if (inline) { res.type(inline.mime).send(inline.buffer); return; }
  const local = await fetchBrandingAsset(url, "crest");
  if (!local) { res.status(404).json({ error: "The crest could not be loaded." }); return; }
  res.setHeader("Cache-Control", "private, max-age=300");
  res.type("png").sendFile(local, () => { if (local !== url) fs.unlink(local, () => {}); });
});

/** PUT …/branding/settings — JSON { key, value }: the academy's own value for one whitelisted key. */
router.put(`${base}/settings`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const key = typeof req.body?.key === "string" ? req.body.key : "";
  if (!KEY_SET.has(key)) { res.status(400).json({ error: "That setting can't be changed here." }); return; }
  const checked = validateSettingValue(key, req.body?.value);
  if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
  try {
    const mine = await ownRules(access.academyId, [key]);
    if (mine.length) {
      await db.update(settingsRulesTable)
        .set({ value: checked.value, enabled: true, updatedAt: new Date() })
        .where(inArray(settingsRulesTable.id, mine.map((r) => r.id)));
    } else {
      await db.insert(settingsRulesTable).values({
        key,
        value: checked.value,
        priority: ACADEMY_RULE_PRIORITY,
        scopeType: "academy",
        scopeId: access.academyId,
        excludes: [],
        enabled: true,
        note: `Set by ${access.academy.name}'s owner in the academy console → Branding`,
        createdBy: access.user.id,
      });
    }
  } catch (err) {
    if (isMissingRelationError(err)) { res.status(503).json({ error: "Settings are not set up in this database yet." }); return; }
    throw err;
  }
  invalidateSettingsCache();
  logger.info({ academyId: access.academyId, userId: access.user.id, key, value: checked.value }, "Academy owner set a branding setting");
  res.json(await brandingView(access));
});

/** DELETE …/branding/settings/:key — back to Replay's default: removes the academy's own rule. */
router.delete(`${base}/settings/:key`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const key = String(req.params.key ?? "");
  if (!KEY_SET.has(key)) { res.status(400).json({ error: "That setting can't be changed here." }); return; }
  try {
    const mine = await ownRules(access.academyId, [key]);
    if (mine.length) await db.delete(settingsRulesTable).where(inArray(settingsRulesTable.id, mine.map((r) => r.id)));
  } catch (err) {
    if (isMissingRelationError(err)) { res.status(503).json({ error: "Settings are not set up in this database yet." }); return; }
    throw err;
  }
  invalidateSettingsCache();
  logger.info({ academyId: access.academyId, userId: access.user.id, key }, "Academy owner reset a branding setting");
  res.json(await brandingView(access));
});

/**
 * GET …/branding/preview?what=…&aspect=9:16|16:9&format=png|mp4&seconds=&blur=&dim=&v=
 * The admin preview's code path, for this academy only.
 */
router.get(`${base}/preview`, async (req, res): Promise<void> => {
  const access = await owner(req, res);
  if (!access) return;
  const result = await previewForScope(scopeOf(access.academyId), req.query as Record<string, unknown>);
  if (result.kind === "error") { res.status(result.status).json({ error: result.error }); return; }
  if (result.kind === "mp4") { res.type("mp4").sendFile(result.file); return; }
  res.setHeader("Cache-Control", "no-store");
  res.type("png").send(result.body);
});

export default router;

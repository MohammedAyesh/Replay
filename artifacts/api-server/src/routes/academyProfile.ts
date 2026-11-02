import { eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { academiesTable, db, fieldsTable, type Academy } from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership } from "../lib/academyAccess";
import { coordsFromMapLink } from "../lib/mapLink";
import { normalizePhone } from "../lib/whatsapp/phone";
import { logger } from "../lib/logger";

/**
 * Academy console → Profile. Every member can read it; only owners change it.
 * The map location overrides the field's for ads and directions.
 */
const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function access(req: Request, res: Response, ownerOnly: boolean): Promise<{ academyId: number; isOwner: boolean } | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) { res.status(400).json({ error: "Invalid academy id" }); return null; }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  const isOwner = roles.includes("owner");
  if (ownerOnly && !isOwner) { res.status(403).json({ error: "Only the academy owner can change the profile" }); return null; }
  return { academyId, isOwner };
}

async function profileView(academy: Academy, isOwner: boolean) {
  const [field] = await db.select({ name: fieldsTable.name, location: fieldsTable.location, latitude: fieldsTable.latitude, longitude: fieldsTable.longitude })
    .from(fieldsTable).where(eq(fieldsTable.id, academy.fieldId));
  return {
    id: academy.id,
    name: academy.name,
    nameAr: academy.nameAr ?? null,
    description: academy.description ?? null,
    logoUrl: academy.logoUrl ?? null,
    contactPhone: academy.contactPhone ?? null,
    whatsappPhone: academy.whatsappPhone ?? null,
    email: academy.email ?? null,
    address: academy.address ?? null,
    latitude: academy.latitude ?? null,
    longitude: academy.longitude ?? null,
    instagramUrl: academy.instagramUrl ?? null,
    facebookUrl: academy.facebookUrl ?? null,
    websiteUrl: academy.websiteUrl ?? null,
    field: field ? { name: field.name, location: field.location ?? null, latitude: field.latitude ?? null, longitude: field.longitude ?? null } : null,
    canEdit: isOwner,
  };
}

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

/** "instagram.com/x", "@x" or a full link → an https link, or null. */
function socialUrl(value: string | null, host: "instagram.com" | "facebook.com" | null): string | null {
  if (!value) return null;
  let v = value.trim();
  if (host && /^@?[\w.]{1,60}$/.test(v) && !v.includes("..")) v = `https://${host}/${v.replace(/^@/, "")}`;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const url = new URL(v);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

const ProfileBody = z.object({
  name: z.string().trim().min(2).max(80),
  nameAr: optionalText(80),
  description: optionalText(1000),
  contactPhone: optionalText(30),
  whatsappPhone: optionalText(30),
  email: optionalText(120),
  address: optionalText(200),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  instagramUrl: optionalText(200),
  facebookUrl: optionalText(200),
  websiteUrl: optionalText(200),
});

router.get("/academy/console/academies/:academyId/profile", async (req, res): Promise<void> => {
  const allowed = await access(req, res, false);
  if (!allowed) return;
  const [academy] = await db.select().from(academiesTable).where(eq(academiesTable.id, allowed.academyId));
  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }
  res.json(await profileView(academy, allowed.isOwner));
});

router.put("/academy/console/academies/:academyId/profile", async (req, res): Promise<void> => {
  const allowed = await access(req, res, true);
  if (!allowed) return;
  const body = ProfileBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Check the name (2–80 characters) and the other fields' lengths." }); return; }
  const data = body.data;

  const errors: Record<string, string> = {};
  if (data.contactPhone && !normalizePhone(data.contactPhone)) errors.contactPhone = "invalid_phone";
  const whatsapp = data.whatsappPhone ? normalizePhone(data.whatsappPhone) : null;
  if (data.whatsappPhone && !whatsapp) errors.whatsappPhone = "invalid_phone";
  if (data.email && !z.string().email().safeParse(data.email).success) errors.email = "invalid_email";
  const instagram = socialUrl(data.instagramUrl, "instagram.com");
  const facebook = socialUrl(data.facebookUrl, "facebook.com");
  const website = socialUrl(data.websiteUrl, null);
  if (data.instagramUrl && !instagram) errors.instagramUrl = "invalid_link";
  if (data.facebookUrl && !facebook) errors.facebookUrl = "invalid_link";
  if (data.websiteUrl && !website) errors.websiteUrl = "invalid_link";
  const hasLat = data.latitude !== null && data.latitude !== undefined;
  const hasLng = data.longitude !== null && data.longitude !== undefined;
  if (hasLat !== hasLng) errors.location = "incomplete_location";
  if (Object.keys(errors).length > 0) { res.status(400).json({ error: "Some fields need fixing.", fields: errors }); return; }

  const [academy] = await db.update(academiesTable).set({
    name: data.name,
    nameAr: data.nameAr,
    description: data.description,
    contactPhone: data.contactPhone,
    whatsappPhone: whatsapp,
    email: data.email ? data.email.toLowerCase() : null,
    address: data.address,
    latitude: hasLat ? data.latitude! : null,
    longitude: hasLng ? data.longitude! : null,
    instagramUrl: instagram,
    facebookUrl: facebook,
    websiteUrl: website,
  }).where(eq(academiesTable.id, allowed.academyId)).returning();
  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }
  res.json(await profileView(academy, true));
});

router.post("/academy/console/academies/:academyId/profile/logo", upload.single("logo"), async (req, res): Promise<void> => {
  const allowed = await access(req, res, true);
  if (!allowed) return;
  const file = req.file;
  if (!file) { res.status(400).json({ error: "No image uploaded" }); return; }
  if (!LOGO_TYPES.has(file.mimetype)) { res.status(400).json({ error: "Use a PNG, JPEG or WebP image" }); return; }
  const logoUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
  await db.update(academiesTable).set({ logoUrl }).where(eq(academiesTable.id, allowed.academyId));
  res.json({ logoUrl });
});

router.delete("/academy/console/academies/:academyId/profile/logo", async (req, res): Promise<void> => {
  const allowed = await access(req, res, true);
  if (!allowed) return;
  await db.update(academiesTable).set({ logoUrl: null }).where(eq(academiesTable.id, allowed.academyId));
  res.json({ logoUrl: null });
});

/** Turns a pasted map link (including maps.app.goo.gl short links) into coordinates. */
router.post("/academy/console/academies/:academyId/profile/locate", async (req, res): Promise<void> => {
  const allowed = await access(req, res, true);
  if (!allowed) return;
  const link = typeof req.body?.link === "string" ? req.body.link.trim().slice(0, 2000) : "";
  if (!link) { res.status(400).json({ error: "Paste a map link" }); return; }
  try {
    const found = await coordsFromMapLink(link);
    if (!found) { res.status(422).json({ error: "That link has no pin in it. In Google Maps, drop a pin on the academy, press Share and paste that link." }); return; }
    res.json(found);
  } catch (error) {
    logger.warn({ error: (error as Error)?.message }, "academy profile: map link failed");
    res.status(422).json({ error: "Couldn't open that link. Try the share link from Google Maps." });
  }
});

export default router;

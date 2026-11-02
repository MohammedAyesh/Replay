import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { academiesTable, academyAdRequestsTable, db, fieldsTable, type AcademyAdRequest, type AcademyMetaConnection } from "@workspace/db";
import { requireAcademyConsoleUser, requireAcademyMembership, type AcademyConsoleUser } from "../lib/academyAccess";
import { logger } from "../lib/logger";
import { metaAdsConfigured, metaConfig } from "../lib/meta/config";
import {
  checkSharedPage,
  connectOwnBusiness,
  connectionToken,
  disconnect,
  getConnection,
  listOwnAssets,
  selectOwnAssets,
} from "../lib/meta/connections";
import { graphGet, MetaGraphError } from "../lib/meta/graph";
import { currencyOffset, launchAdRequest, launchContext, setAdRunning } from "../lib/meta/launch";

/**
 * Academy owners connect Meta and build ads from Replay (Academy console → Ads).
 * Ads in Replay's ad account wait for an admin's approval (Replay pays); ads in the owner's
 * own account go live as soon as he submits (Meta bills him).
 */
const router: IRouter = Router();

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof MetaGraphError) {
    res.status(error.status >= 400 && error.status < 600 ? (error.status === 500 ? 502 : error.status) : 502).json({ error: error.message });
    return;
  }
  const cause = (error as { cause?: { code?: string } })?.cause;
  if (cause?.code === "42P01") {
    res.status(500).json({ error: "The ads tables are missing from this database. Run the schema push and publish with the database review." });
    return;
  }
  logger.error({ error: (error as Error)?.message }, what);
  res.status(500).json({ error: (error as Error)?.message?.slice(0, 300) ?? "Failed" });
}

async function ownerAccess(req: Request, res: Response): Promise<{ user: AcademyConsoleUser; academyId: number } | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) {
    res.status(400).json({ error: "Invalid academy id" });
    return null;
  }
  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return null;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return null;
  }
  return { user, academyId };
}

function connectionView(connection: AcademyMetaConnection | null) {
  if (!connection) return null;
  return {
    mode: connection.mode,
    status: connection.status,
    pageId: connection.pageId,
    pageName: connection.pageName,
    whatsappNumber: connection.whatsappNumber,
    adAccountId: connection.adAccountId,
    adAccountName: connection.adAccountName,
    currency: connection.currency,
    leadsSubscribed: connection.leadsSubscribed,
    error: connection.error,
    connectedAt: connection.connectedAt,
  };
}

const base = "/academy/console/academies/:academyId/ads";

router.get(`${base}/connection`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    const config = metaConfig();
    const connection = await getConnection(access.academyId);
    res.json({
      connection: connectionView(connection),
      replay: { available: metaAdsConfigured(config), businessId: config.businessId },
      own: { appId: config.appId, loginConfigId: config.loginConfigId, graphVersion: config.graphVersion },
    });
  } catch (error) {
    fail(res, error, "Reading the academy's Meta connection failed");
  }
});

router.post(`${base}/connection/share`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const page = typeof req.body?.page === "string" ? req.body.page : "";
  try {
    res.json(await checkSharedPage(access.academyId, page));
  } catch (error) {
    fail(res, error, "Checking a shared Page failed");
  }
});

router.post(`${base}/connection/own`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!code) {
    res.status(400).json({ error: "Missing the sign-in code" });
    return;
  }
  try {
    const assets = await connectOwnBusiness(access.academyId, code);
    res.json({ assets, connection: connectionView(await getConnection(access.academyId)) });
  } catch (error) {
    fail(res, error, "Connecting an academy's own Meta business failed");
  }
});

router.get(`${base}/connection/own/assets`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    res.json(await listOwnAssets(access.academyId));
  } catch (error) {
    fail(res, error, "Listing an academy's Meta assets failed");
  }
});

router.put(`${base}/connection/own`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const adAccountId = String(req.body?.adAccountId ?? "");
  const pageId = String(req.body?.pageId ?? "");
  if (!/^act_\d+$/.test(adAccountId) || !/^\d+$/.test(pageId)) {
    res.status(400).json({ error: "Pick an ad account and a Page" });
    return;
  }
  try {
    res.json({ connection: connectionView(await selectOwnAssets(access.academyId, adAccountId, pageId)) });
  } catch (error) {
    fail(res, error, "Choosing an academy's Meta assets failed");
  }
});

router.delete(`${base}/connection`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    await disconnect(access.academyId);
    res.status(204).send();
  } catch (error) {
    fail(res, error, "Disconnecting Meta failed");
  }
});

// ─── Ad requests ─────────────────────────────────────────────────────────────

const AdBody = z.object({
  goal: z.enum(["whatsapp", "lead_form"]),
  name: z.string().trim().min(1).max(80),
  dailyBudget: z.number().positive().max(1000),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  radiusKm: z.number().int().min(1).max(80),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  headline: z.string().trim().min(1).max(40),
  primaryText: z.string().trim().min(1).max(600),
  locale: z.enum(["ar", "en"]),
  imageData: z.string().max(4_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/).nullable().optional(),
  extraQuestion: z.string().trim().max(80).nullable().optional(),
});

let replayCurrency: { value: string; at: number } | null = null;
async function currencyFor(mode: "replay" | "own", connection: AcademyMetaConnection | null): Promise<string> {
  if (mode === "own") return connection?.currency ?? "USD";
  if (replayCurrency && Date.now() - replayCurrency.at < 3600_000) return replayCurrency.value;
  const config = metaConfig();
  const account = await graphGet<{ currency?: string }>(config.adAccountId!, { fields: "currency" });
  replayCurrency = { value: account.currency ?? "USD", at: Date.now() };
  return replayCurrency.value;
}

async function academyLocation(academyId: number): Promise<{ name: string; latitude: number | null; longitude: number | null }> {
  const [row] = await db.select({ name: academiesTable.name, latitude: fieldsTable.latitude, longitude: fieldsTable.longitude })
    .from(academiesTable).leftJoin(fieldsTable, eq(fieldsTable.id, academiesTable.fieldId)).where(eq(academiesTable.id, academyId));
  return { name: row?.name ?? "", latitude: row?.latitude ?? null, longitude: row?.longitude ?? null };
}

function requestView(row: AcademyAdRequest, withImage = false) {
  const offset = currencyOffset(row.currency);
  return {
    id: row.id,
    mode: row.mode,
    goal: row.goal,
    name: row.name,
    status: row.status,
    dailyBudget: row.dailyBudget / offset,
    currency: row.currency,
    startAt: row.startAt,
    endAt: row.endAt,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusKm: row.radiusKm,
    ageMin: row.ageMin,
    ageMax: row.ageMax,
    headline: row.headline,
    primaryText: row.primaryText,
    locale: row.locale,
    extraQuestion: row.extraQuestion,
    hasImage: Boolean(row.imageData),
    imageData: withImage ? row.imageData : undefined,
    metaCampaignId: row.metaCampaignId,
    error: row.error,
    submittedAt: row.submittedAt,
    launchedAt: row.launchedAt,
    createdAt: row.createdAt,
  };
}

async function loadRequest(academyId: number, id: number | null) {
  if (!id) return null;
  const [row] = await db.select().from(academyAdRequestsTable).where(and(eq(academyAdRequestsTable.id, id), eq(academyAdRequestsTable.academyId, academyId)));
  return row ?? null;
}

const EDITABLE = ["draft", "rejected", "failed"];

router.get(`${base}/requests`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    const rows = await db.select().from(academyAdRequestsTable).where(eq(academyAdRequestsTable.academyId, access.academyId))
      .orderBy(desc(academyAdRequestsTable.createdAt)).limit(100);
    const location = await academyLocation(access.academyId);
    res.json({ requests: rows.map((r) => requestView(r)), defaults: { latitude: location.latitude, longitude: location.longitude, academyName: location.name } });
  } catch (error) {
    fail(res, error, "Listing ad requests failed");
  }
});

router.get(`${base}/requests/:id`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const row = await loadRequest(access.academyId, intParam(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Ad not found" });
    return;
  }
  res.json(requestView(row, true));
});

async function saveRequest(req: Request, res: Response, existing: AcademyAdRequest | null, access: { user: AcademyConsoleUser; academyId: number }) {
  const body = AdBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return;
  }
  if (body.data.ageMin > body.data.ageMax) {
    res.status(400).json({ error: "The youngest age is above the oldest" });
    return;
  }
  const connection = await getConnection(access.academyId);
  const mode = connection?.mode === "own" && connection.status === "connected" ? "own" : "replay";
  const currency = existing?.mode === mode ? existing.currency : await currencyFor(mode, connection);
  const location = await academyLocation(access.academyId);
  const values = {
    mode,
    goal: body.data.goal,
    name: body.data.name,
    dailyBudget: Math.round(body.data.dailyBudget * currencyOffset(currency)),
    currency,
    startAt: body.data.startAt ? new Date(body.data.startAt) : null,
    endAt: body.data.endAt ? new Date(body.data.endAt) : null,
    latitude: body.data.latitude ?? location.latitude,
    longitude: body.data.longitude ?? location.longitude,
    radiusKm: body.data.radiusKm,
    ageMin: body.data.ageMin,
    ageMax: body.data.ageMax,
    headline: body.data.headline,
    primaryText: body.data.primaryText,
    locale: body.data.locale,
    ...(body.data.imageData !== undefined ? { imageData: body.data.imageData } : {}),
    extraQuestion: body.data.extraQuestion ?? null,
    updatedAt: new Date(),
  };
  if (existing) {
    const [row] = await db.update(academyAdRequestsTable).set({ ...values, status: "draft", error: null })
      .where(eq(academyAdRequestsTable.id, existing.id)).returning();
    res.json(requestView(row));
  } else {
    const [row] = await db.insert(academyAdRequestsTable).values({ ...values, academyId: access.academyId, createdBy: access.user.id }).returning();
    res.status(201).json(requestView(row));
  }
}

router.post(`${base}/requests`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    await saveRequest(req, res, null, access);
  } catch (error) {
    fail(res, error, "Saving an ad request failed");
  }
});

router.put(`${base}/requests/:id`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    const existing = await loadRequest(access.academyId, intParam(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Ad not found" });
      return;
    }
    if (!EDITABLE.includes(existing.status)) {
      res.status(409).json({ error: "This ad is already with Meta; pause it instead" });
      return;
    }
    await saveRequest(req, res, existing, access);
  } catch (error) {
    fail(res, error, "Saving an ad request failed");
  }
});

router.delete(`${base}/requests/:id`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const existing = await loadRequest(access.academyId, intParam(req.params.id));
  if (!existing || !EDITABLE.includes(existing.status) && existing.status !== "pending_approval") {
    res.status(existing ? 409 : 404).json({ error: existing ? "Pause a running ad instead" : "Ad not found" });
    return;
  }
  await db.delete(academyAdRequestsTable).where(eq(academyAdRequestsTable.id, existing.id));
  res.status(204).send();
});

/** Replay's account: wait for Replay. Own account: launch now. */
router.post(`${base}/requests/:id/submit`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    const existing = await loadRequest(access.academyId, intParam(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Ad not found" });
      return;
    }
    if (!EDITABLE.includes(existing.status)) {
      res.status(409).json({ error: "This ad was already submitted" });
      return;
    }
    if (!existing.imageData) {
      res.status(400).json({ error: "Add an image first" });
      return;
    }
    const connection = await getConnection(access.academyId);
    if (connection?.status !== "connected" || !connection.pageId) {
      res.status(409).json({ error: "Connect your Facebook Page first" });
      return;
    }
    if (existing.mode === "own") {
      const location = await academyLocation(access.academyId);
      const ctx = launchContext(existing, connection, location.name);
      const row = await launchAdRequest({ ...existing, status: "launching" }, ctx);
      res.json(requestView(row));
      return;
    }
    const [row] = await db.update(academyAdRequestsTable).set({ status: "pending_approval", submittedAt: new Date(), error: null, updatedAt: new Date() })
      .where(eq(academyAdRequestsTable.id, existing.id)).returning();
    res.json(requestView(row));
  } catch (error) {
    fail(res, error, "Submitting an ad failed");
  }
});

for (const [action, running] of [["pause", false], ["resume", true]] as const) {
  router.post(`${base}/requests/:id/${action}`, async (req, res): Promise<void> => {
    const access = await ownerAccess(req, res);
    if (!access) return;
    try {
      const existing = await loadRequest(access.academyId, intParam(req.params.id));
      if (!existing || !["active", "paused"].includes(existing.status)) {
        res.status(existing ? 409 : 404).json({ error: existing ? "This ad isn't running" : "Ad not found" });
        return;
      }
      const connection = await getConnection(access.academyId);
      const token = existing.mode === "own" ? connectionToken(connection) : undefined;
      res.json(requestView(await setAdRunning(existing, { token }, running)));
    } catch (error) {
      fail(res, error, "Pausing or resuming an ad failed");
    }
  });
}

// ─── Admin: approve ads that run on Replay's account ─────────────────────────

async function requireAdmin(req: Request, res: Response): Promise<AcademyConsoleUser | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return user;
}

router.get("/admin/meta-ads/requests", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const rows = await db.select({ request: academyAdRequestsTable, academyName: academiesTable.name })
      .from(academyAdRequestsTable)
      .innerJoin(academiesTable, eq(academiesTable.id, academyAdRequestsTable.academyId))
      .where(inArray(academyAdRequestsTable.status, ["pending_approval", "launching", "active", "paused", "failed", "rejected"]))
      .orderBy(desc(academyAdRequestsTable.updatedAt))
      .limit(100);
    res.json(rows.map((r) => ({ ...requestView(r.request, r.request.status === "pending_approval"), academyId: r.request.academyId, academyName: r.academyName })));
  } catch (error) {
    fail(res, error, "Listing ad requests failed");
  }
});

router.post("/admin/meta-ads/requests/:id/approve", async (req, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const id = intParam(req.params.id);
    const [existing] = id ? await db.select().from(academyAdRequestsTable).where(eq(academyAdRequestsTable.id, id)) : [];
    if (!existing || existing.status !== "pending_approval") {
      res.status(existing ? 409 : 404).json({ error: existing ? "This ad isn't waiting for approval" : "Ad not found" });
      return;
    }
    await db.update(academyAdRequestsTable).set({ reviewedBy: admin.id }).where(eq(academyAdRequestsTable.id, existing.id));
    const connection = await getConnection(existing.academyId);
    const location = await academyLocation(existing.academyId);
    const row = await launchAdRequest(existing, launchContext(existing, connection, location.name));
    res.json(requestView(row));
  } catch (error) {
    fail(res, error, "Approving an ad failed");
  }
});

router.post("/admin/meta-ads/requests/:id/reject", async (req, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const id = intParam(req.params.id);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
  const [row] = id ? await db.update(academyAdRequestsTable)
    .set({ status: "rejected", error: reason || "Not approved", reviewedBy: admin.id, updatedAt: new Date() })
    .where(and(eq(academyAdRequestsTable.id, id), eq(academyAdRequestsTable.status, "pending_approval"))).returning() : [];
  if (!row) {
    res.status(404).json({ error: "No ad waiting for approval with that id" });
    return;
  }
  res.json(requestView(row));
});

export default router;

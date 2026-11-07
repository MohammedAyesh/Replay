import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { academiesTable, academyAdMediaTable, academyAdRequestsTable, db, fieldsTable, type AcademyAdRequest, type AcademyMetaConnection } from "@workspace/db";
import { type AcademyConsoleUser } from "../lib/academyAccess";
import { adminAccess, intParam, ownerAccess, sendFailure } from "../lib/meta/routeAccess";
import { MIN_DAILY_FILS, budgetFilsFromMeta, committedDailyFils, fundsToStart, metaBudgetFor, walletBalanceFils } from "../lib/meta/wallet";
import { metaAdsConfigured, metaConfig } from "../lib/meta/config";
import {
  checkSharedPage,
  connectOwnBusiness,
  connectionToken,
  disconnect,
  getConnection,
  listOwnAssets,
  OwnBusinessConnectError,
  selectOwnAssets,
} from "../lib/meta/connections";
import { graphGet } from "../lib/meta/graph";
import { currencyOffset, launchAdRequest, launchContext, requestQuestions, requestVariants, setAdRunning } from "../lib/meta/launch";

/**
 * Academy owners connect Meta and build ads from Replay (Academy console → Ads).
 * Ads in Replay's ad account wait for an admin's approval (Replay pays); ads in the owner's
 * own account go live as soon as he submits (Meta bills him).
 */
const router: IRouter = Router();
const fail = sendFailure;

function ownConnectionFailure(req: Request, res: Response, step: string, error: unknown): void {
  const referenceCode = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  req.log.error({
    referenceCode,
    step,
    failureKind: error instanceof Error ? error.name : "UnknownError",
  }, "Connecting an academy's own Meta business failed");
  res.status(500).json({
    error: "facebook_connection_failed",
    code: "facebook_connection_failed",
    referenceCode,
  });
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
    if (error instanceof OwnBusinessConnectError) {
      res.status(error.status).json({
        error: "facebook_connection_failed",
        code: "facebook_connection_failed",
        referenceCode: error.referenceCode,
      });
      return;
    }
    ownConnectionFailure(req, res, "save_connection", error);
  }
});

router.get(`${base}/connection/own/assets`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    res.json(await listOwnAssets(access.academyId));
  } catch (error) {
    ownConnectionFailure(req, res, "load_pending_assets", error);
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
    ownConnectionFailure(req, res, "select_assets", error);
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

const Variant = z.object({ headline: z.string().trim().min(1).max(40), primaryText: z.string().trim().min(1).max(600) });
const AdBody = z.object({
  goal: z.enum(["whatsapp", "lead_form"]),
  name: z.string().trim().min(1).max(80),
  /** Replay's account: JOD a day (what the wallet is charged at most). Own account: its currency. */
  dailyBudget: z.number().positive().max(1000),
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  radiusKm: z.number().int().min(1).max(80),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  headline: z.string().trim().max(40).optional(),
  primaryText: z.string().trim().max(600).optional(),
  /** 1–3 versions of the text; each runs as its own ad. */
  variants: z.array(Variant).min(1).max(3).optional(),
  locale: z.enum(["ar", "en"]),
  imageData: z.string().max(4_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/).nullable().optional(),
  /** Photos/videos from the academy's media: 1 is a single ad, 2–10 a carousel. */
  cards: z.array(z.object({
    mediaId: z.number().int().positive(),
    headline: z.string().trim().max(40).nullable().optional(),
    description: z.string().trim().max(20).nullable().optional(),
  })).max(10).optional(),
  questions: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    options: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  })).max(5).optional(),
  extraQuestion: z.string().trim().max(80).nullable().optional(),
  templateId: z.number().int().positive().nullable().optional(),
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
  // The academy's own pin (Academy console → Profile) wins over its field's.
  const [row] = await db.select({
    name: academiesTable.name,
    latitude: academiesTable.latitude,
    longitude: academiesTable.longitude,
    fieldLatitude: fieldsTable.latitude,
    fieldLongitude: fieldsTable.longitude,
  }).from(academiesTable).leftJoin(fieldsTable, eq(fieldsTable.id, academiesTable.fieldId)).where(eq(academiesTable.id, academyId));
  const own = row?.latitude != null && row?.longitude != null;
  return {
    name: row?.name ?? "",
    latitude: own ? row!.latitude : row?.fieldLatitude ?? null,
    longitude: own ? row!.longitude : row?.fieldLongitude ?? null,
  };
}

function requestView(row: AcademyAdRequest, opts: { withImage?: boolean; admin?: boolean } = {}) {
  const offset = currencyOffset(row.currency);
  // Replay's account: the owner sees his JOD budget, never Meta's.
  const replayBudget = row.mode === "replay" && row.budgetFils != null;
  return {
    id: row.id,
    mode: row.mode,
    goal: row.goal,
    name: row.name,
    status: row.status,
    pausedReason: row.pausedReason,
    dailyBudget: replayBudget ? row.budgetFils! / 1000 : row.dailyBudget / offset,
    currency: replayBudget ? "JOD" : row.currency,
    ...(opts.admin ? { metaDailyBudget: row.dailyBudget / offset, metaCurrency: row.currency } : {}),
    startAt: row.startAt,
    endAt: row.endAt,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusKm: row.radiusKm,
    ageMin: row.ageMin,
    ageMax: row.ageMax,
    headline: row.headline,
    primaryText: row.primaryText,
    variants: requestVariants(row),
    locale: row.locale,
    extraQuestion: row.extraQuestion,
    questions: requestQuestions(row),
    cards: Array.isArray(row.cards) ? row.cards : [],
    templateId: row.templateId,
    metaAds: Array.isArray(row.metaAds) ? row.metaAds : [],
    hasImage: Boolean(row.imageData) || (Array.isArray(row.cards) && row.cards.length > 0),
    imageData: opts.withImage ? row.imageData : undefined,
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
  res.json(requestView(row, { withImage: true }));
});

async function saveRequest(req: Request, res: Response, existing: AcademyAdRequest | null, access: { user: AcademyConsoleUser; academyId: number }) {
  const body = AdBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return;
  }
  const data = body.data;
  if (data.ageMin > data.ageMax) {
    res.status(400).json({ error: "The youngest age is above the oldest" });
    return;
  }
  const variants = data.variants ?? (data.headline && data.primaryText ? [{ headline: data.headline, primaryText: data.primaryText }] : []);
  if (!variants.length) {
    res.status(400).json({ error: "Write a headline and the ad's text" });
    return;
  }
  const cards = data.cards ?? [];
  if (cards.length) {
    const ids = [...new Set(cards.map((c) => c.mediaId))];
    const media = await db.select({ id: academyAdMediaTable.id, status: academyAdMediaTable.status }).from(academyAdMediaTable)
      .where(and(eq(academyAdMediaTable.academyId, access.academyId), inArray(academyAdMediaTable.id, ids)));
    if (media.length !== ids.length) {
      res.status(400).json({ error: "One of the photos or videos isn't in this academy's media" });
      return;
    }
    if (media.some((m) => m.status === "failed")) {
      res.status(400).json({ error: "One of the videos couldn't be processed. Remove it and upload it again." });
      return;
    }
  }
  const connection = await getConnection(access.academyId);
  const mode = connection?.mode === "own" && connection.status === "connected" ? "own" : "replay";
  const currency = existing?.mode === mode ? existing.currency : await currencyFor(mode, connection);
  let budgetFils: number | null = null;
  let metaBudget: number;
  if (mode === "replay") {
    budgetFils = Math.round(data.dailyBudget * 1000);
    if (budgetFils < MIN_DAILY_FILS) {
      res.status(400).json({ error: `The daily budget must be at least ${MIN_DAILY_FILS / 1000} JOD` });
      return;
    }
    metaBudget = metaBudgetFor(budgetFils, currency);
  } else {
    metaBudget = Math.round(data.dailyBudget * currencyOffset(currency));
  }
  const location = await academyLocation(access.academyId);
  const values = {
    mode,
    goal: data.goal,
    name: data.name,
    dailyBudget: metaBudget,
    budgetFils,
    currency,
    startAt: data.startAt ? new Date(data.startAt) : null,
    endAt: data.endAt ? new Date(data.endAt) : null,
    latitude: data.latitude ?? location.latitude,
    longitude: data.longitude ?? location.longitude,
    radiusKm: data.radiusKm,
    ageMin: data.ageMin,
    ageMax: data.ageMax,
    headline: variants[0].headline,
    primaryText: variants[0].primaryText,
    variants,
    locale: data.locale,
    ...(data.imageData !== undefined ? { imageData: data.imageData } : {}),
    cards,
    questions: data.goal === "lead_form" ? (data.questions ?? (data.extraQuestion ? [{ label: data.extraQuestion }] : [])) : [],
    extraQuestion: data.extraQuestion ?? null,
    templateId: data.templateId ?? existing?.templateId ?? null,
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

/**
 * Replay's account: is there enough in the wallet for this ad on top of a day of each of the
 * academy's other running or waiting ads?
 */
async function fundsCheck(request: AcademyAdRequest, own: number): Promise<{ ok: true } | { ok: false; balance: number; need: number }> {
  if (request.mode !== "replay") return { ok: true };
  const [balance, others] = await Promise.all([walletBalanceFils(request.academyId), committedDailyFils(request.academyId, request.id)]);
  const need = own + others;
  return balance >= need ? { ok: true } : { ok: false, balance: balance / 1000, need: need / 1000 };
}

/** A Replay-account draft saved before the wallet existed has no JOD budget yet: give it one. */
async function withWalletBudget(request: AcademyAdRequest): Promise<AcademyAdRequest> {
  if (request.mode !== "replay" || request.budgetFils != null) return request;
  const [row] = await db.update(academyAdRequestsTable).set({ budgetFils: budgetFilsFromMeta(request.dailyBudget, request.currency) })
    .where(eq(academyAdRequestsTable.id, request.id)).returning();
  return row;
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
    if (!existing.imageData && !(Array.isArray(existing.cards) && existing.cards.length)) {
      res.status(400).json({ error: "Add a photo or a video first" });
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
    const funded = await withWalletBudget(existing);
    const funds = await fundsCheck(funded, fundsToStart(funded));
    if (!funds.ok) {
      res.status(402).json({ error: "Top up your ads wallet first", code: "wallet_low", balance: funds.balance, need: funds.need });
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
      if (running && existing.pausedReason === "ended") {
        res.status(409).json({ error: "This ad has ended. Make a new one, or copy this one with new dates." });
        return;
      }
      if (running) {
        const funds = await fundsCheck(existing, existing.budgetFils ?? 0);
        if (!funds.ok) {
          res.status(402).json({ error: "Top up your ads wallet to switch this ad back on", code: "wallet_low", balance: funds.balance, need: funds.need });
          return;
        }
      }
      const connection = await getConnection(access.academyId);
      const token = existing.mode === "own" ? connectionToken(connection) : undefined;
      const row = await setAdRunning(existing, { token }, running);
      if (running && row.pausedReason) {
        const [cleared] = await db.update(academyAdRequestsTable).set({ pausedReason: null }).where(eq(academyAdRequestsTable.id, row.id)).returning();
        res.json(requestView(cleared));
        return;
      }
      res.json(requestView(row));
    } catch (error) {
      fail(res, error, "Pausing or resuming an ad failed");
    }
  });
}

// ─── Admin: approve ads that run on Replay's account ─────────────────────────

const requireAdmin = adminAccess;

router.get("/admin/meta-ads/requests", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const rows = await db.select({ request: academyAdRequestsTable, academyName: academiesTable.name })
      .from(academyAdRequestsTable)
      .innerJoin(academiesTable, eq(academiesTable.id, academyAdRequestsTable.academyId))
      .where(inArray(academyAdRequestsTable.status, ["pending_approval", "launching", "active", "paused", "failed", "rejected"]))
      .orderBy(desc(academyAdRequestsTable.updatedAt))
      .limit(100);
    const balances = new Map<number, number>();
    for (const id of new Set(rows.map((r) => r.request.academyId))) balances.set(id, await walletBalanceFils(id));
    res.json(rows.map((r) => ({
      ...requestView(r.request, { withImage: r.request.status === "pending_approval", admin: true }),
      academyId: r.request.academyId,
      academyName: r.academyName,
      walletBalance: (balances.get(r.request.academyId) ?? 0) / 1000,
      fundsToStart: r.request.mode === "replay" ? fundsToStart(r.request) / 1000 : null,
    })));
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
    const funded = await withWalletBudget(existing);
    const funds = await fundsCheck(funded, fundsToStart(funded));
    if (!funds.ok) {
      res.status(402).json({ error: `The academy's wallet has ${funds.balance} JOD; with its other ads this one needs ${funds.need} JOD to start` });
      return;
    }
    await db.update(academyAdRequestsTable).set({ reviewedBy: admin.id }).where(eq(academyAdRequestsTable.id, existing.id));
    const connection = await getConnection(existing.academyId);
    const location = await academyLocation(existing.academyId);
    const row = await launchAdRequest(funded, launchContext(funded, connection, location.name));
    res.json(requestView(row, { admin: true }));
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

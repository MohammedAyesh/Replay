import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  academiesTable,
  academyAdRequestsTable,
  academyAdWalletEntriesTable,
  db,
  metaAdCampaignsTable,
  type AcademyAdWalletEntry,
} from "@workspace/db";
import { loadCommerce } from "../lib/commerce";
import { logger } from "../lib/logger";
import { setAdRunning } from "../lib/meta/launch";
import { adminAccess, intParam, ownerAccess, sendFailure } from "../lib/meta/routeAccess";
import {
  AD_MARGIN,
  DAYS_TO_START,
  MIN_DAILY_FILS,
  MIN_TOPUP_FILS,
  jodPerUnit,
  newTopupReference,
  resumeFundedAds,
  walletBalanceFils,
} from "../lib/meta/wallet";

/**
 * Academy console → Ads → Wallet: prepaid balance for ads on Replay's account. Owners ask to
 * top up and pay by CliQ with a reference; an admin confirms the transfer. The owner only ever
 * sees JOD amounts charged to him.
 */
const router: IRouter = Router();
const jod = (fils: number) => Math.round(fils) / 1000;

async function resumeAfterFunds(academyId: number): Promise<number[]> {
  return resumeFundedAds(academyId, async (request) => {
    await setAdRunning(request, { token: undefined }, true);
  });
}

function entryView(e: AcademyAdWalletEntry, campaignName: string | null) {
  return {
    id: e.id,
    kind: e.kind,
    amount: jod(e.amountFils),
    status: e.status,
    method: e.method,
    reference: e.reference,
    campaignName,
    note: e.kind === "adjustment" ? e.note : null,
    createdAt: e.createdAt,
    confirmedAt: e.confirmedAt,
  };
}

const base = "/academy/console/academies/:academyId/ads/wallet";

router.get(base, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  try {
    const { academyId } = access;
    const [balance, commerce, entries, spendByDay, running] = await Promise.all([
      walletBalanceFils(academyId),
      loadCommerce(),
      db.select().from(academyAdWalletEntriesTable)
        .where(and(eq(academyAdWalletEntriesTable.academyId, academyId), sql`${academyAdWalletEntriesTable.kind} <> 'spend'`))
        .orderBy(desc(academyAdWalletEntriesTable.createdAt)).limit(50),
      // Spend is charged every few minutes; owners see it per day and ad.
      db.select({
        day: sql<string>`to_char(${academyAdWalletEntriesTable.createdAt} at time zone 'Asia/Amman', 'YYYY-MM-DD')`,
        campaignId: academyAdWalletEntriesTable.campaignId,
        campaignName: metaAdCampaignsTable.name,
        fils: sql<number>`(-sum(${academyAdWalletEntriesTable.amountFils}))::int`,
      }).from(academyAdWalletEntriesTable)
        .leftJoin(metaAdCampaignsTable, eq(metaAdCampaignsTable.id, academyAdWalletEntriesTable.campaignId))
        .where(and(eq(academyAdWalletEntriesTable.academyId, academyId), eq(academyAdWalletEntriesTable.kind, "spend")))
        .groupBy(sql`1`, academyAdWalletEntriesTable.campaignId, metaAdCampaignsTable.name)
        .orderBy(desc(sql`1`)).limit(60),
      db.select({ budgetFils: academyAdRequestsTable.budgetFils }).from(academyAdRequestsTable).where(and(
        eq(academyAdRequestsTable.academyId, academyId),
        eq(academyAdRequestsTable.mode, "replay"),
        eq(academyAdRequestsTable.status, "active"),
      )),
    ]);
    const dailyFils = running.reduce((sum, r) => sum + (r.budgetFils ?? 0), 0);
    res.json({
      balance: jod(balance),
      currency: "JOD",
      dailySpend: jod(dailyFils),
      daysLeft: dailyFils > 0 ? Math.max(0, Math.floor(balance / dailyFils)) : null,
      cliqAlias: commerce.cliqAlias,
      minTopup: jod(MIN_TOPUP_FILS),
      minDaily: jod(MIN_DAILY_FILS),
      daysToStart: DAYS_TO_START,
      pending: entries.filter((e) => e.status === "pending").map((e) => entryView(e, null)),
      history: [
        ...entries.filter((e) => e.status !== "pending").map((e) => ({ ...entryView(e, null), date: null as string | null })),
        ...spendByDay.map((s) => ({
          id: null, kind: "spend", amount: -jod(s.fils), status: "confirmed", method: null, reference: null,
          campaignName: s.campaignName, note: null, createdAt: null, confirmedAt: null, date: s.day,
        })),
      ].sort((a, b) => String(b.date ?? b.createdAt?.toISOString() ?? "").localeCompare(String(a.date ?? a.createdAt?.toISOString() ?? ""))),
    });
  } catch (error) {
    sendFailure(res, error, "Reading an academy's ad wallet failed");
  }
});

router.post(`${base}/topups`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const body = z.object({ amount: z.number().positive().max(10_000) }).safeParse(req.body ?? {});
  if (!body.success || Math.round(body.data.amount * 1000) < MIN_TOPUP_FILS) {
    res.status(400).json({ error: `Top up at least ${jod(MIN_TOPUP_FILS)} JOD` });
    return;
  }
  try {
    const pending = await db.select({ id: academyAdWalletEntriesTable.id }).from(academyAdWalletEntriesTable).where(and(
      eq(academyAdWalletEntriesTable.academyId, access.academyId),
      eq(academyAdWalletEntriesTable.status, "pending"),
    ));
    if (pending.length >= 3) {
      res.status(409).json({ error: "You already have 3 top-ups waiting. Replay confirms them once the CliQ transfer arrives." });
      return;
    }
    const commerce = await loadCommerce();
    const [row] = await db.insert(academyAdWalletEntriesTable).values({
      academyId: access.academyId,
      kind: "topup",
      amountFils: Math.round(body.data.amount * 1000),
      status: "pending",
      method: "cliq",
      reference: newTopupReference(access.academyId),
      createdBy: access.user.id,
    }).returning();
    res.status(201).json({ ...entryView(row, null), cliqAlias: commerce.cliqAlias });
  } catch (error) {
    sendFailure(res, error, "Requesting a wallet top-up failed");
  }
});

router.delete(`${base}/topups/:id`, async (req, res): Promise<void> => {
  const access = await ownerAccess(req, res);
  if (!access) return;
  const id = intParam(req.params.id);
  const [row] = id ? await db.delete(academyAdWalletEntriesTable).where(and(
    eq(academyAdWalletEntriesTable.id, id),
    eq(academyAdWalletEntriesTable.academyId, access.academyId),
    eq(academyAdWalletEntriesTable.kind, "topup"),
    eq(academyAdWalletEntriesTable.status, "pending"),
  )).returning() : [];
  if (!row) {
    res.status(404).json({ error: "No waiting top-up with that id" });
    return;
  }
  res.status(204).send();
});

// ─── Admin ───────────────────────────────────────────────────────────────────

router.get("/admin/meta-ads/wallets", async (req, res): Promise<void> => {
  if (!(await adminAccess(req, res))) return;
  try {
    const [totals, pending, spendByCurrency] = await Promise.all([
      db.select({
        academyId: academyAdWalletEntriesTable.academyId,
        academyName: academiesTable.name,
        balanceFils: sql<number>`coalesce(sum(${academyAdWalletEntriesTable.amountFils}) filter (where ${academyAdWalletEntriesTable.status} = 'confirmed'), 0)::int`,
        toppedUpFils: sql<number>`coalesce(sum(${academyAdWalletEntriesTable.amountFils}) filter (where ${academyAdWalletEntriesTable.status} = 'confirmed' and ${academyAdWalletEntriesTable.kind} = 'topup'), 0)::int`,
        chargedFils: sql<number>`coalesce(-sum(${academyAdWalletEntriesTable.amountFils}) filter (where ${academyAdWalletEntriesTable.kind} = 'spend'), 0)::int`,
      }).from(academyAdWalletEntriesTable)
        .innerJoin(academiesTable, eq(academiesTable.id, academyAdWalletEntriesTable.academyId))
        .groupBy(academyAdWalletEntriesTable.academyId, academiesTable.name)
        .orderBy(academiesTable.name),
      db.select({ entry: academyAdWalletEntriesTable, academyName: academiesTable.name }).from(academyAdWalletEntriesTable)
        .innerJoin(academiesTable, eq(academiesTable.id, academyAdWalletEntriesTable.academyId))
        .where(eq(academyAdWalletEntriesTable.status, "pending"))
        .orderBy(academyAdWalletEntriesTable.createdAt),
      // Spend rows carry their Meta figure's currency in the note.
      db.select({
        academyId: academyAdWalletEntriesTable.academyId,
        currency: academyAdWalletEntriesTable.note,
        cents: sql<number>`coalesce(sum(${academyAdWalletEntriesTable.metaSpendCents}), 0)::int`,
      }).from(academyAdWalletEntriesTable)
        .where(eq(academyAdWalletEntriesTable.kind, "spend"))
        .groupBy(academyAdWalletEntriesTable.academyId, academyAdWalletEntriesTable.note),
    ]);
    res.json({
      margin: AD_MARGIN,
      jodPerUsd: jodPerUnit("USD"),
      wallets: totals.map((t) => {
        // What Meta's spend cost Replay in JOD, per currency the spend was reported in.
        const costFils = spendByCurrency.filter((r) => r.academyId === t.academyId)
          .reduce((sum, r) => sum + Math.round((r.cents / 100) * jodPerUnit(r.currency ?? "USD") * 1000), 0);
        return {
          academyId: t.academyId,
          academyName: t.academyName,
          balance: jod(t.balanceFils),
          toppedUp: jod(t.toppedUpFils),
          charged: jod(t.chargedFils),
          metaCost: jod(costFils),
          earned: jod(t.chargedFils - costFils),
        };
      }),
      pending: pending.map((p) => ({ ...entryView(p.entry, null), academyId: p.entry.academyId, academyName: p.academyName })),
    });
  } catch (error) {
    sendFailure(res, error, "Listing ad wallets failed");
  }
});

router.post("/admin/meta-ads/wallets/topups/:id/confirm", async (req, res): Promise<void> => {
  const admin = await adminAccess(req, res);
  if (!admin) return;
  const id = intParam(req.params.id);
  const amount = req.body?.amount === undefined ? null : Number(req.body.amount);
  if (amount !== null && !(Number.isFinite(amount) && amount > 0)) {
    res.status(400).json({ error: "The amount received must be a positive number of JOD" });
    return;
  }
  try {
    const [row] = id ? await db.update(academyAdWalletEntriesTable).set({
      status: "confirmed",
      confirmedBy: admin.id,
      confirmedAt: new Date(),
      ...(amount !== null ? { amountFils: Math.round(amount * 1000) } : {}),
    }).where(and(
      eq(academyAdWalletEntriesTable.id, id),
      eq(academyAdWalletEntriesTable.kind, "topup"),
      eq(academyAdWalletEntriesTable.status, "pending"),
    )).returning() : [];
    if (!row) {
      res.status(404).json({ error: "No waiting top-up with that id" });
      return;
    }
    logger.info({ adminId: admin.id, academyId: row.academyId, fils: row.amountFils }, "Ad wallet top-up confirmed");
    const resumed = await resumeAfterFunds(row.academyId);
    res.json({ ...entryView(row, null), resumed, balance: jod(await walletBalanceFils(row.academyId)) });
  } catch (error) {
    sendFailure(res, error, "Confirming a top-up failed");
  }
});

router.post("/admin/meta-ads/wallets/topups/:id/reject", async (req, res): Promise<void> => {
  const admin = await adminAccess(req, res);
  if (!admin) return;
  const id = intParam(req.params.id);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "";
  const [row] = id ? await db.update(academyAdWalletEntriesTable)
    .set({ status: "rejected", confirmedBy: admin.id, confirmedAt: new Date(), note: reason || null })
    .where(and(eq(academyAdWalletEntriesTable.id, id), eq(academyAdWalletEntriesTable.status, "pending"))).returning() : [];
  if (!row) {
    res.status(404).json({ error: "No waiting top-up with that id" });
    return;
  }
  res.json(entryView(row, null));
});

/** A manual credit (cash, a refund, a free trial) or debit. */
router.post("/admin/meta-ads/wallets/:academyId/adjust", async (req, res): Promise<void> => {
  const admin = await adminAccess(req, res);
  if (!admin) return;
  const academyId = intParam(req.params.academyId);
  const body = z.object({ amount: z.number().refine((n) => n !== 0), note: z.string().trim().min(1).max(200) }).safeParse(req.body ?? {});
  if (!academyId || !body.success) {
    res.status(400).json({ error: "Give a non-zero amount in JOD (negative takes money out) and a note" });
    return;
  }
  try {
    const [academy] = await db.select({ id: academiesTable.id }).from(academiesTable).where(eq(academiesTable.id, academyId));
    if (!academy) {
      res.status(404).json({ error: "Academy not found" });
      return;
    }
    const [row] = await db.insert(academyAdWalletEntriesTable).values({
      academyId,
      kind: "adjustment",
      amountFils: Math.round(body.data.amount * 1000),
      status: "confirmed",
      method: "admin",
      note: body.data.note,
      createdBy: admin.id,
      confirmedBy: admin.id,
      confirmedAt: new Date(),
    }).returning();
    const resumed = body.data.amount > 0 ? await resumeAfterFunds(academyId) : [];
    res.status(201).json({ ...entryView(row, null), resumed, balance: jod(await walletBalanceFils(academyId)) });
  } catch (error) {
    sendFailure(res, error, "Adjusting an ad wallet failed");
  }
});

export default router;

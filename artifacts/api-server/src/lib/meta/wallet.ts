import { randomInt } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  academyAdRequestsTable,
  academyAdWalletEntriesTable,
  db,
  metaAdCampaignsTable,
  type AcademyAdRequest,
} from "@workspace/db";
import { logger } from "../logger";
import type { CampaignNumbers } from "./sync";

/**
 * Ads on Replay's ad account are prepaid: an academy tops up a wallet (CliQ, confirmed by an
 * admin) and spend is taken from it as Meta reports it. The academy is charged in JOD at
 * Replay's ad rate: Meta's spend converted to JOD, plus Replay's margin. The margin is
 * internal: academy-facing numbers are only ever the charged amount, never Meta's figure.
 */

/** Replay's margin on ad spend. Admin-only; never sent to an academy. */
export const AD_MARGIN = Number.isFinite(Number(process.env.META_AD_MARGIN)) && process.env.META_AD_MARGIN
  ? Number(process.env.META_AD_MARGIN)
  : 0.07;

/** JOD per unit of the ad account's currency. The dinar is pegged to the dollar. */
const TO_JOD: Record<string, number> = { USD: 0.709, JOD: 1, EUR: 0.77, AED: 0.193, SAR: 0.189 };

export function jodPerUnit(currency: string | null | undefined): number {
  return TO_JOD[(currency ?? "USD").toUpperCase()] ?? TO_JOD.USD;
}

/** What an academy pays, in fils, for Meta spend given in the account currency's minor units. */
export function chargeFils(spendMinor: number, currency: string | null | undefined): number {
  return Math.round((spendMinor / 100) * jodPerUnit(currency) * (1 + AD_MARGIN) * 1000);
}

/** The Meta daily budget (minor units) that costs the academy at most `budgetFils` a day. */
export function metaBudgetFor(budgetFils: number, currency: string | null | undefined): number {
  return Math.floor(((budgetFils / 1000) / (jodPerUnit(currency) * (1 + AD_MARGIN))) * 100);
}

/** An owner-facing copy of Meta's numbers for a Replay-account campaign: spend is what he pays. */
export function chargedNumbers(n: CampaignNumbers | null): CampaignNumbers | null {
  if (!n) return null;
  return { ...n, spend: Math.round((chargeFils(Math.round(n.spend * 100), n.currency) / 1000) * 100) / 100, currency: "JOD" };
}

export const MIN_DAILY_FILS = 2000;
export const MIN_TOPUP_FILS = 10_000;
/** A Replay-account ad needs this many days of its budget in the wallet to start. */
export const DAYS_TO_START = 3;

export async function walletBalanceFils(academyId: number): Promise<number> {
  const [row] = await db.select({ total: sql<number>`coalesce(sum(${academyAdWalletEntriesTable.amountFils}), 0)::int` })
    .from(academyAdWalletEntriesTable)
    .where(and(eq(academyAdWalletEntriesTable.academyId, academyId), eq(academyAdWalletEntriesTable.status, "confirmed")));
  return row?.total ?? 0;
}

/** Fils needed in the wallet before this ad can go on Meta. */
export function fundsToStart(request: Pick<AcademyAdRequest, "budgetFils" | "startAt" | "endAt">, now = new Date()): number {
  const daily = request.budgetFils ?? 0;
  let days = DAYS_TO_START;
  if (request.endAt) {
    const from = request.startAt && request.startAt > now ? request.startAt : now;
    days = Math.min(days, Math.max(1, Math.ceil((request.endAt.getTime() - from.getTime()) / 86_400_000)));
  }
  return daily * days;
}

export function newTopupReference(academyId: number): string {
  return `AD${academyId}-${randomInt(1000, 9999)}`;
}

/** Daily budgets of the academy's Replay-account ads that are running. */
/** Not past its end date. An ad without an end runs until it's paused. */
export function stillRunning(r: Pick<AcademyAdRequest, "endAt">, now = new Date()): boolean {
  return !r.endAt || r.endAt.getTime() > now.getTime();
}

/** Daily budgets of the academy's wallet-funded ads that are running (ended ones don't count). */
async function runningDailyFils(academyId: number): Promise<{ total: number; rows: AcademyAdRequest[] }> {
  const rows = (await db.select().from(academyAdRequestsTable).where(and(
    eq(academyAdRequestsTable.academyId, academyId),
    eq(academyAdRequestsTable.mode, "replay"),
    eq(academyAdRequestsTable.status, "active"),
    isNotNull(academyAdRequestsTable.budgetFils),
  ))).filter((r) => stillRunning(r));
  return { total: rows.reduce((sum, r) => sum + (r.budgetFils ?? 0), 0), rows };
}

/**
 * What the academy's other wallet-funded ads already need from the balance: a day of each one
 * that is running or on its way (waiting for approval, publishing).
 */
export async function committedDailyFils(academyId: number, exceptId: number | null): Promise<number> {
  const rows = await db.select({ id: academyAdRequestsTable.id, budgetFils: academyAdRequestsTable.budgetFils, endAt: academyAdRequestsTable.endAt })
    .from(academyAdRequestsTable).where(and(
      eq(academyAdRequestsTable.academyId, academyId),
      eq(academyAdRequestsTable.mode, "replay"),
      inArray(academyAdRequestsTable.status, ["active", "pending_approval", "launching"]),
    ));
  return rows.filter((r) => r.id !== exceptId && stillRunning(r)).reduce((sum, r) => sum + (r.budgetFils ?? 0), 0);
}

export type SettleResult = { charged: number; paused: number[] };

/**
 * Charge each Replay-account campaign's new spend to its academy's wallet, then pause the
 * academy's ads when what's left can't cover a quarter of a day. Idempotent: a campaign's
 * charged spend only moves forward, in the same transaction as its ledger row.
 */
export async function settleWallets(
  /** Pause one ad for funds; returns false if it was no longer running (the owner got there first). */
  pause: (request: AcademyAdRequest) => Promise<boolean>,
): Promise<SettleResult> {
  // Only ads built with a wallet budget are charged; ads from before the wallet existed are not.
  const campaigns = await db.select({
    id: metaAdCampaignsTable.id,
    insights: metaAdCampaignsTable.insights,
    chargedSpendCents: metaAdCampaignsTable.chargedSpendCents,
    academyId: academyAdRequestsTable.academyId,
  }).from(metaAdCampaignsTable)
    .innerJoin(academyAdRequestsTable, eq(academyAdRequestsTable.metaCampaignId, metaAdCampaignsTable.id))
    .where(and(
      eq(academyAdRequestsTable.mode, "replay"),
      isNotNull(academyAdRequestsTable.budgetFils),
      isNotNull(metaAdCampaignsTable.insights),
    ));

  let charged = 0;
  const academies = new Set<number>();
  for (const c of campaigns) {
    const numbers = c.insights as CampaignNumbers | null;
    const spendCents = Math.round((numbers?.spend ?? 0) * 100);
    const delta = spendCents - c.chargedSpendCents;
    if (delta <= 0) continue;
    const fils = chargeFils(delta, numbers?.currency);
    await db.transaction(async (tx) => {
      const [moved] = await tx.update(metaAdCampaignsTable)
        .set({ chargedSpendCents: spendCents })
        .where(and(eq(metaAdCampaignsTable.id, c.id), eq(metaAdCampaignsTable.chargedSpendCents, c.chargedSpendCents)))
        .returning({ id: metaAdCampaignsTable.id });
      if (!moved) return; // another settle got there first
      await tx.insert(academyAdWalletEntriesTable).values({
        academyId: c.academyId,
        kind: "spend",
        amountFils: -fils,
        status: "confirmed",
        campaignId: c.id,
        metaSpendCents: delta,
        // The Meta figure's currency, so the admin's cost/earned maths can convert it.
        note: (numbers?.currency ?? "USD").toUpperCase(),
        confirmedAt: new Date(),
      });
      charged += fils;
      academies.add(c.academyId);
    });
  }

  // Every academy with a running Replay-account ad, not only those charged just now.
  const running = await db.selectDistinct({ academyId: academyAdRequestsTable.academyId }).from(academyAdRequestsTable)
    .where(and(eq(academyAdRequestsTable.mode, "replay"), eq(academyAdRequestsTable.status, "active"), isNotNull(academyAdRequestsTable.budgetFils)));
  for (const r of running) academies.add(r.academyId);

  const paused: number[] = [];
  for (const academyId of academies) {
    const { total, rows } = await runningDailyFils(academyId);
    if (!rows.length) continue;
    const balance = await walletBalanceFils(academyId);
    if (balance >= Math.ceil(total / 4)) continue;
    for (const request of rows) {
      try {
        if (await pause(request)) paused.push(request.id);
      } catch (error) {
        logger.error({ requestId: request.id, error: (error as Error).message }, "Pausing an ad for an empty wallet failed");
      }
    }
    logger.info({ academyId, balance, dailyFils: total, paused }, "Ads paused: wallet ran low");
  }
  return { charged, paused };
}

/** After a top-up: switch back on the ads that were paused for funds, while the balance covers them. */
export async function resumeFundedAds(
  academyId: number,
  resume: (request: AcademyAdRequest) => Promise<void>,
): Promise<number[]> {
  const waiting = (await db.select().from(academyAdRequestsTable).where(and(
    eq(academyAdRequestsTable.academyId, academyId),
    eq(academyAdRequestsTable.mode, "replay"),
    eq(academyAdRequestsTable.status, "paused"),
    eq(academyAdRequestsTable.pausedReason, "funds"),
  ))).filter((r) => stillRunning(r));
  if (!waiting.length) return [];
  const balance = await walletBalanceFils(academyId);
  const { total: alreadyRunning } = await runningDailyFils(academyId);
  let committed = alreadyRunning;
  const resumed: number[] = [];
  for (const request of waiting) {
    const daily = request.budgetFils ?? 0;
    if (balance < committed + daily) break;
    try {
      await resume(request);
      await db.update(academyAdRequestsTable).set({ pausedReason: null }).where(eq(academyAdRequestsTable.id, request.id));
      committed += daily;
      resumed.push(request.id);
    } catch (error) {
      logger.error({ requestId: request.id, error: (error as Error).message }, "Resuming an ad after a top-up failed");
    }
  }
  return resumed;
}

/** Owner-facing cost per campaign: what was charged to the wallet. */
export async function chargedByCampaign(academyId: number): Promise<Map<string, number>> {
  const rows = await db.select({
    campaignId: academyAdWalletEntriesTable.campaignId,
    fils: sql<number>`coalesce(-sum(${academyAdWalletEntriesTable.amountFils}), 0)::int`,
  }).from(academyAdWalletEntriesTable)
    .where(and(eq(academyAdWalletEntriesTable.academyId, academyId), eq(academyAdWalletEntriesTable.kind, "spend")))
    .groupBy(academyAdWalletEntriesTable.campaignId);
  return new Map(rows.filter((r) => r.campaignId).map((r) => [r.campaignId!, r.fils]));
}

export async function hasRunningWalletAds(): Promise<boolean> {
  const rows = await db.select({ endAt: academyAdRequestsTable.endAt }).from(academyAdRequestsTable)
    .where(and(eq(academyAdRequestsTable.mode, "replay"), isNotNull(academyAdRequestsTable.budgetFils), inArray(academyAdRequestsTable.status, ["active", "launching"])));
  return rows.some((r) => stillRunning(r));
}

/** Ads past their end date stop counting as running: paused with reason "ended". */
export async function closeEndedAds(now = new Date()): Promise<number> {
  const rows = await db.update(academyAdRequestsTable)
    .set({ status: "paused", pausedReason: "ended", updatedAt: now })
    .where(and(eq(academyAdRequestsTable.status, "active"), isNotNull(academyAdRequestsTable.endAt), sql`${academyAdRequestsTable.endAt} < ${now}`))
    .returning({ id: academyAdRequestsTable.id });
  return rows.length;
}

/** A budget saved before the wallet existed was Meta's minor units; give it its JOD figure. */
export function budgetFilsFromMeta(metaMinor: number, currency: string): number {
  return chargeFils(metaMinor, currency);
}

/**
 * Owner-facing numbers for a Replay-account campaign from what the wallet actually paid:
 * spend is the ledger's total for it (null when nothing was charged), and per-ad or 30-day
 * figures take the same share of it as Meta's own figures do.
 */
export function ledgerNumbers(n: CampaignNumbers | null, chargedFils: number | undefined, lifetimeMetaSpend: number | null): CampaignNumbers | null {
  if (!n) return null;
  if (chargedFils === undefined || !lifetimeMetaSpend) return { ...n, spend: null as unknown as number, currency: "JOD" };
  const share = Math.min(1, Math.max(0, n.spend / lifetimeMetaSpend));
  return { ...n, spend: Math.round((chargedFils * share) / 10) / 100, currency: "JOD" };
}

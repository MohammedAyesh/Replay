import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateAcademyFinanceCategoryBody,
  CreateAcademyFinanceCategoryParams,
  CreateAcademyFinanceCategoryResponse,
  CreateAcademyFinanceOtherPaymentBody,
  CreateAcademyFinanceOtherPaymentParams,
  CreateAcademyFinancePlayerFeeBody,
  CreateAcademyFinancePlayerFeeParams,
  CreateAcademyFinancePlayerRenewalBody,
  CreateAcademyFinancePlayerRenewalParams,
  DeleteAcademyFinanceFeeParams,
  DeleteAcademyFinanceOtherPaymentParams,
  DeleteAcademyFinancePlayerRenewalParams,
  CreateAcademyFinanceStaffBody,
  CreateAcademyFinanceStaffParams,
  CreateAcademyFinanceTeamBody,
  CreateAcademyFinanceTeamParams,
  CreateAcademyFinanceTeamPlayerBody,
  CreateAcademyFinanceTeamPlayerParams,
  CreateAcademyFinanceTeamPlayerResponse,
  CreateAcademyFinanceTeamResponse as AcademyFinanceTeamResponse,
  CreateAcademyFinanceStaffResponse as AcademyFinanceStaffResponse,
  CreateAcademyFinanceOtherPaymentResponse as AcademyFinanceOtherPaymentResponse,
  CreateAcademyFinancePlayerFeeResponse as AcademyFinanceFeeResponse,
  CreateAcademyFinancePlayerRenewalResponse as AcademyFinanceRenewalResponse,
  GetAcademyFinanceDashboardParams,
  GetAcademyFinanceDashboardResponse,
  ListAcademyFinanceCategoriesParams,
  ListAcademyFinanceCategoriesResponse,
  ListAcademyFinanceOtherPaymentsParams,
  ListAcademyFinanceOtherPaymentsResponse,
  ListAcademyFinancePlayerFeesParams,
  ListAcademyFinancePlayerFeesResponse,
  ListAcademyFinanceUnassignedPlayersParams,
  ListAcademyFinanceUnassignedPlayersResponse,
  ListAcademyFinanceStaffParams,
  ListAcademyFinanceStaffResponse,
  ListAcademyFinanceTeamPlayersParams,
  ListAcademyFinanceTeamPlayersResponse,
  ListAcademyFinanceTeamsParams,
  ListAcademyFinanceTeamsResponse,
  MarkAcademyFinanceFeePaidBody,
  MarkAcademyFinanceFeePaidParams,
  MarkAcademyFinanceFeePaidResponse,
  MarkAcademyFinanceOtherPaymentPaidBody,
  MarkAcademyFinanceOtherPaymentPaidParams,
  MarkAcademyFinanceOtherPaymentPaidResponse,
  RecordAcademyFinanceSalaryPaymentParams,
  RecordAcademyFinanceSalaryPaymentResponse,
  RepeatAcademyFinanceOtherPaymentParams,
  RepeatAcademyFinanceOtherPaymentResponse,
  UpdateAcademyFinancePlayerBillingBody,
  UpdateAcademyFinancePlayerBillingParams,
  UpdateAcademyFinancePlayerBillingResponse,
  UpdateAcademyFinanceTeamBody,
  UpdateAcademyFinanceTeamParams,
  UpdateAcademyFinanceTeamResponse,
  UpdateAcademyFinanceStaffBody,
  UpdateAcademyFinanceStaffParams,
  UpdateAcademyFinanceStaffResponse,
} from "@workspace/api-zod";
import {
  academyFeesTable,
  academyFinanceStaffTable,
  academyOtherPaymentsTable,
  academyPaymentCategoriesTable,
  academyPlayerRenewalsTable,
  academyPlayersTable,
  academySquadsTable,
  academiesTable,
  db,
} from "@workspace/db";
import {
  addMonthsToDate,
  getAmmanDate,
  getAmmanMonthRange,
  isValidDateOnly,
  monthsOwedSince,
  subscriptionStatus,
} from "../lib/academyFinanceMath";
import {
  requireAcademyConsoleUser,
  requireAcademyMembership,
} from "../lib/academyAccess";

const router: IRouter = Router();
const BUILT_IN_CATEGORIES = ["Rent", "Transport", "Replay", "Equipment", "Other"] as const;

function rawParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: message });
}

async function authorizeOwner(
  req: Request,
  res: Response,
  academyId: number,
): Promise<boolean> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return false;

  const roles = await requireAcademyMembership(user.id, academyId, res);
  if (!roles) return false;
  if (!roles.includes("owner")) {
    res.status(403).json({ error: "Academy owner role required" });
    return false;
  }

  const [academy] = await db
    .select({ id: academiesTable.id })
    .from(academiesTable)
    .where(eq(academiesTable.id, academyId));
  if (!academy) {
    notFound(res, "Academy not found");
    return false;
  }

  return true;
}

function dateIsValidOrRespond(
  res: Response,
  value: string,
  fieldName: string,
): boolean {
  if (isValidDateOnly(value)) return true;
  badRequest(res, `${fieldName} must be a valid calendar date`);
  return false;
}

type SquadRow = typeof academySquadsTable.$inferSelect;

export async function financePlayersForSquad(
  academyId: number,
  squad: SquadRow,
  today = getAmmanDate(),
) {
  const playerRows = await db
    .select({
      id: academyPlayersTable.id,
      squadId: academyPlayersTable.squadId,
      name: academyPlayersTable.name,
      isActive: academyPlayersTable.isActive,
      monthlyDiscountFils: academyPlayersTable.monthlyDiscountFils,
      subscriptionExpiresOn: academyPlayersTable.subscriptionExpiresOn,
    })
    .from(academyPlayersTable)
    .where(and(
      eq(academyPlayersTable.academyId, academyId),
      eq(academyPlayersTable.squadId, squad.id),
    ))
    .orderBy(asc(academyPlayersTable.name), asc(academyPlayersTable.id));

  if (playerRows.length === 0) return [];
  const playerIds = playerRows.map(({ id }) => id);
  const [feeRows, renewalRows] = await Promise.all([
    db
    .select({
      playerId: academyFeesTable.playerId,
      amountFils: academyFeesTable.amountFils,
      status: academyFeesTable.status,
    })
    .from(academyFeesTable)
    .where(and(
      eq(academyFeesTable.academyId, academyId),
      inArray(academyFeesTable.playerId, playerIds),
    )),
    db.select({
      id: academyPlayerRenewalsTable.id,
      playerId: academyPlayerRenewalsTable.playerId,
      amountFils: academyPlayerRenewalsTable.amountFils,
      paidAt: academyPlayerRenewalsTable.paidAt,
    })
      .from(academyPlayerRenewalsTable)
      .where(and(
        eq(academyPlayerRenewalsTable.academyId, academyId),
        inArray(academyPlayerRenewalsTable.playerId, playerIds),
      ))
      .orderBy(desc(academyPlayerRenewalsTable.id)),
  ]);

  const unpaidFeesByPlayer = new Map<number, number>();
  const latestRenewalByPlayer = new Map<number, (typeof renewalRows)[number]>();
  for (const fee of feeRows) {
    if (fee.status === "due") {
      unpaidFeesByPlayer.set(
        fee.playerId,
        (unpaidFeesByPlayer.get(fee.playerId) ?? 0) + fee.amountFils,
      );
    }
  }
  for (const renewal of renewalRows) {
    if (!latestRenewalByPlayer.has(renewal.playerId)) {
      latestRenewalByPlayer.set(renewal.playerId, renewal);
    }
  }

  const summaries = playerRows.map((player) => {
    const monthlyFeeFils = squad.monthlyFeeFils;
    const monthlyDiscountFils = player.monthlyDiscountFils;
    const effectiveMonthlyFeeFils = Math.max(0, monthlyFeeFils - monthlyDiscountFils);
    const monthsOwed = player.subscriptionExpiresOn
      ? monthsOwedSince(player.subscriptionExpiresOn, today)
      : 0;
    const subscriptionDebtFils = monthsOwed * effectiveMonthlyFeeFils;
    const unpaidFeesFils = unpaidFeesByPlayer.get(player.id) ?? 0;
    const latestRenewal = latestRenewalByPlayer.get(player.id);
    return {
      id: player.id,
      squadId: squad.id,
      name: player.name,
      isActive: player.isActive,
      monthlyFeeFils,
      monthlyDiscountFils,
      effectiveMonthlyFeeFils,
      subscriptionExpiresOn: player.subscriptionExpiresOn,
      subscriptionStatus: subscriptionStatus(player.subscriptionExpiresOn, today),
      monthsOwed,
      subscriptionDebtFils,
      unpaidFeesFils,
      outstandingFils: subscriptionDebtFils + unpaidFeesFils,
      latestRenewalId: latestRenewal?.id ?? null,
      latestRenewalAmountFils: latestRenewal?.amountFils ?? null,
      latestRenewalPaidAt: latestRenewal?.paidAt ?? null,
    };
  });

  // Inactive roster entries remain visible only while there is debt to collect.
  return summaries.filter((player) => player.isActive || player.outstandingFils > 0);
}

async function financeTeamSummary(squad: SquadRow, today = getAmmanDate()) {
  const players = await financePlayersForSquad(squad.academyId, squad, today);
  return {
    id: squad.id,
    name: squad.name,
    monthlyFeeFils: squad.monthlyFeeFils,
    playerCount: players.filter((player) => player.isActive).length,
    behindCount: players.filter((player) => player.outstandingFils > 0).length,
    outstandingFils: players.reduce((total, player) => total + player.outstandingFils, 0),
  };
}

async function getPlayerAndSquad(academyId: number, playerId: number) {
  const rows = await db
    .select({
      id: academyPlayersTable.id,
      academyId: academyPlayersTable.academyId,
      squadId: academyPlayersTable.squadId,
      name: academyPlayersTable.name,
      isActive: academyPlayersTable.isActive,
      monthlyDiscountFils: academyPlayersTable.monthlyDiscountFils,
      subscriptionExpiresOn: academyPlayersTable.subscriptionExpiresOn,
      monthlyFeeFils: academySquadsTable.monthlyFeeFils,
    })
    .from(academyPlayersTable)
    .innerJoin(
      academySquadsTable,
      and(
        eq(academySquadsTable.id, academyPlayersTable.squadId),
        eq(academySquadsTable.academyId, academyId),
      ),
    )
    .where(and(
      eq(academyPlayersTable.id, playerId),
      eq(academyPlayersTable.academyId, academyId),
    ));
  return rows[0] ?? null;
}

async function getPlayerFinanceSummary(academyId: number, playerId: number) {
  const player = await getPlayerAndSquad(academyId, playerId);
  if (!player || player.squadId === null) return null;
  const [squad] = await db
    .select()
    .from(academySquadsTable)
    .where(and(
      eq(academySquadsTable.id, player.squadId),
      eq(academySquadsTable.academyId, academyId),
    ));
  if (!squad) return null;
  const players = await financePlayersForSquad(academyId, squad);
  return players.find(({ id }) => id === playerId) ?? null;
}

async function getFeeSummary(academyId: number, feeId?: number) {
  return db
    .select({
      id: academyFeesTable.id,
      playerId: academyFeesTable.playerId,
      label: academyFeesTable.label,
      amountFils: academyFeesTable.amountFils,
      dueDate: academyFeesTable.dueDate,
      status: academyFeesTable.status,
      paidAt: academyFeesTable.paidAt,
      note: academyFeesTable.note,
    })
    .from(academyFeesTable)
    .where(and(
      eq(academyFeesTable.academyId, academyId),
      ...(feeId === undefined ? [] : [eq(academyFeesTable.id, feeId)]),
    ))
    .orderBy(asc(academyFeesTable.dueDate), asc(academyFeesTable.id));
}

async function getPaymentById(academyId: number, paymentId: number) {
  const [payment] = await db
    .select({
      id: academyOtherPaymentsTable.id,
      staffId: academyOtherPaymentsTable.staffId,
      category: academyOtherPaymentsTable.category,
      label: academyOtherPaymentsTable.label,
      amountFils: academyOtherPaymentsTable.amountFils,
      occurredOn: academyOtherPaymentsTable.occurredOn,
      status: academyOtherPaymentsTable.status,
      paidAt: academyOtherPaymentsTable.paidAt,
    })
    .from(academyOtherPaymentsTable)
    .where(and(
      eq(academyOtherPaymentsTable.id, paymentId),
      eq(academyOtherPaymentsTable.academyId, academyId),
    ));
  return payment ?? null;
}

async function validPaymentCategory(academyId: number, category: string): Promise<boolean> {
  const builtIn = BUILT_IN_CATEGORIES.some((value) => value.toLowerCase() === category.toLowerCase());
  if (builtIn || category.toLowerCase() === "salary") return true;
  const [custom] = await db
    .select({ id: academyPaymentCategoriesTable.id })
    .from(academyPaymentCategoriesTable)
    .where(and(
      eq(academyPaymentCategoriesTable.academyId, academyId),
      sql`lower(${academyPaymentCategoriesTable.name}) = ${category.toLowerCase()}`,
    ));
  return Boolean(custom);
}

router.get("/academy/console/academies/:academyId/finance/dashboard", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const params = GetAcademyFinanceDashboardParams.safeParse({ academyId: rawParam(req.params.academyId) });
  if (!params.success) {
    badRequest(res, params.error.message);
    return;
  }
  const { academyId } = params.data;
  if (!(await authorizeOwner(req, res, academyId))) return;

  const range = getAmmanMonthRange();
  const [paidFees, paidRenewals, paidPayments, unpaidPayments, squads] = await Promise.all([
    db.select({ amountFils: academyFeesTable.amountFils })
      .from(academyFeesTable)
      .where(and(
        eq(academyFeesTable.academyId, academyId),
        eq(academyFeesTable.status, "paid"),
        gte(academyFeesTable.paidAt, range.startAt),
        lt(academyFeesTable.paidAt, range.endAt),
      )),
    db.select({ amountFils: academyPlayerRenewalsTable.amountFils })
      .from(academyPlayerRenewalsTable)
      .where(and(
        eq(academyPlayerRenewalsTable.academyId, academyId),
        gte(academyPlayerRenewalsTable.paidAt, range.startAt),
        lt(academyPlayerRenewalsTable.paidAt, range.endAt),
      )),
    db.select({ amountFils: academyOtherPaymentsTable.amountFils })
      .from(academyOtherPaymentsTable)
      .where(and(
        eq(academyOtherPaymentsTable.academyId, academyId),
        eq(academyOtherPaymentsTable.status, "paid"),
        gte(academyOtherPaymentsTable.paidAt, range.startAt),
        lt(academyOtherPaymentsTable.paidAt, range.endAt),
      )),
    db.select({
      id: academyOtherPaymentsTable.id,
      category: academyOtherPaymentsTable.category,
      label: academyOtherPaymentsTable.label,
      amountFils: academyOtherPaymentsTable.amountFils,
      occurredOn: academyOtherPaymentsTable.occurredOn,
    })
      .from(academyOtherPaymentsTable)
      .where(and(
        eq(academyOtherPaymentsTable.academyId, academyId),
        eq(academyOtherPaymentsTable.status, "unpaid"),
      ))
      .orderBy(desc(academyOtherPaymentsTable.occurredOn), desc(academyOtherPaymentsTable.id)),
    db.select()
      .from(academySquadsTable)
      .where(eq(academySquadsTable.academyId, academyId))
      .orderBy(asc(academySquadsTable.name), asc(academySquadsTable.id)),
  ]);

  const squadPlayers = await Promise.all(squads.map(async (squad) => ({
    squad,
    players: await financePlayersForSquad(academyId, squad),
  })));
  const attentionPlayers = squadPlayers.flatMap(({ squad, players }) =>
    players.map((player) => ({ squad, player })),
  );
  const expiredPlayers = attentionPlayers
    .filter(({ player }) => player.subscriptionStatus === "expired")
    .map(({ squad, player }) => ({
      id: player.id,
      name: player.name,
      squadId: squad.id,
      squadName: squad.name,
      expiresOn: player.subscriptionExpiresOn!,
      monthsOwed: player.monthsOwed,
      outstandingFils: player.outstandingFils,
    }));
  const expiringPlayers = attentionPlayers
    .filter(({ player }) => player.subscriptionStatus === "expiring")
    .map(({ squad, player }) => ({
      id: player.id,
      name: player.name,
      squadId: squad.id,
      squadName: squad.name,
      expiresOn: player.subscriptionExpiresOn!,
      monthsOwed: player.monthsOwed,
      outstandingFils: player.outstandingFils,
    }));
  const collectedFils = paidFees.reduce((sum, row) => sum + row.amountFils, 0)
    + paidRenewals.reduce((sum, row) => sum + row.amountFils, 0);
  const spentFils = paidPayments.reduce((sum, row) => sum + row.amountFils, 0);

  res.json(GetAcademyFinanceDashboardResponse.parse({
    month: range.month,
    collectedFils,
    spentFils,
    netFils: collectedFils - spentFils,
    unpaidBillsCount: unpaidPayments.length,
    expiredPlayers,
    expiringPlayers,
    unpaidPayments,
  }));
});

router.get("/academy/console/academies/:academyId/finance/teams", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const params = ListAcademyFinanceTeamsParams.safeParse({ academyId: rawParam(req.params.academyId) });
  if (!params.success) {
    badRequest(res, params.error.message);
    return;
  }
  const { academyId } = params.data;
  if (!(await authorizeOwner(req, res, academyId))) return;

  const squads = await db.select()
    .from(academySquadsTable)
    .where(eq(academySquadsTable.academyId, academyId))
    .orderBy(asc(academySquadsTable.name), asc(academySquadsTable.id));
  res.json(ListAcademyFinanceTeamsResponse.parse(
    await Promise.all(squads.map((squad) => financeTeamSummary(squad))),
  ));
});

router.get(
  "/academy/console/academies/:academyId/finance/unassigned-players",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = ListAcademyFinanceUnassignedPlayersParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const players = await db.select({
      id: academyPlayersTable.id,
      name: academyPlayersTable.name,
    }).from(academyPlayersTable).where(and(
      eq(academyPlayersTable.academyId, academyId),
      isNull(academyPlayersTable.squadId),
      eq(academyPlayersTable.isActive, true),
    )).orderBy(asc(academyPlayersTable.name), asc(academyPlayersTable.id));
    const playerIds = players.map((player) => player.id);
    const fees = playerIds.length === 0 ? [] : await db.select({
      playerId: academyFeesTable.playerId,
      amountFils: academyFeesTable.amountFils,
    }).from(academyFeesTable).where(and(
      eq(academyFeesTable.academyId, academyId),
      inArray(academyFeesTable.playerId, playerIds),
      eq(academyFeesTable.status, "due"),
    ));
    const feesByPlayer = new Map<number, number>();
    for (const fee of fees) {
      feesByPlayer.set(fee.playerId, (feesByPlayer.get(fee.playerId) ?? 0) + fee.amountFils);
    }
    res.json(ListAcademyFinanceUnassignedPlayersResponse.parse(players.map((player) => {
      const unpaidFeesFils = feesByPlayer.get(player.id) ?? 0;
      return { ...player, unpaidFeesFils, outstandingFils: unpaidFeesFils };
    })));
  },
);

router.post("/academy/console/academies/:academyId/finance/teams", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const params = CreateAcademyFinanceTeamParams.safeParse({ academyId: rawParam(req.params.academyId) });
  if (!params.success) {
    badRequest(res, params.error.message);
    return;
  }
  const { academyId } = params.data;
  if (!(await authorizeOwner(req, res, academyId))) return;
  const body = CreateAcademyFinanceTeamBody.safeParse(req.body);
  if (!body.success) {
    badRequest(res, body.error.message);
    return;
  }
  const name = body.data.name.trim();
  if (!name) {
    badRequest(res, "Team name cannot be empty");
    return;
  }
  const [squad] = await db.insert(academySquadsTable).values({
    academyId,
    name,
    monthlyFeeFils: body.data.monthlyFeeFils,
    ageGroup: body.data.ageGroup?.trim() || null,
    description: body.data.description?.trim() || null,
  }).returning();
  res.status(201).json(AcademyFinanceTeamResponse.parse(await financeTeamSummary(squad)));
});

router.patch(
  "/academy/console/academies/:academyId/finance/teams/:squadId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = UpdateAcademyFinanceTeamParams.safeParse({
      academyId: rawParam(req.params.academyId),
      squadId: rawParam(req.params.squadId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, squadId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = UpdateAcademyFinanceTeamBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    const [squad] = await db.update(academySquadsTable)
      .set({ monthlyFeeFils: body.data.monthlyFeeFils })
      .where(and(
        eq(academySquadsTable.id, squadId),
        eq(academySquadsTable.academyId, academyId),
      ))
      .returning();
    if (!squad) {
      notFound(res, "Team not found in this academy");
      return;
    }
    res.json(UpdateAcademyFinanceTeamResponse.parse(await financeTeamSummary(squad)));
  },
);

router.get(
  "/academy/console/academies/:academyId/finance/teams/:squadId/players",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = ListAcademyFinanceTeamPlayersParams.safeParse({
      academyId: rawParam(req.params.academyId),
      squadId: rawParam(req.params.squadId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, squadId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const [squad] = await db.select()
      .from(academySquadsTable)
      .where(and(
        eq(academySquadsTable.id, squadId),
        eq(academySquadsTable.academyId, academyId),
      ));
    if (!squad) {
      notFound(res, "Team not found in this academy");
      return;
    }
    res.json(ListAcademyFinanceTeamPlayersResponse.parse(
      await financePlayersForSquad(academyId, squad),
    ));
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/teams/:squadId/players",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = CreateAcademyFinanceTeamPlayerParams.safeParse({
      academyId: rawParam(req.params.academyId),
      squadId: rawParam(req.params.squadId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, squadId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = CreateAcademyFinanceTeamPlayerBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    if (!body.data.name.trim()) {
      badRequest(res, "Player name cannot be empty");
      return;
    }
    if (!dateIsValidOrRespond(res, body.data.subscriptionExpiresOn, "Subscription expiry")) return;
    const [squad] = await db.select({ id: academySquadsTable.id })
      .from(academySquadsTable)
      .where(and(
        eq(academySquadsTable.id, squadId),
        eq(academySquadsTable.academyId, academyId),
      ));
    if (!squad) {
      notFound(res, "Team not found in this academy");
      return;
    }

    const [player] = await db.insert(academyPlayersTable).values({
      academyId,
      squadId,
      name: body.data.name.trim(),
      monthlyDiscountFils: body.data.monthlyDiscountFils,
      subscriptionExpiresOn: body.data.subscriptionExpiresOn,
      isActive: true,
    }).returning({ id: academyPlayersTable.id });
    const summary = await getPlayerFinanceSummary(academyId, player.id);
    if (!summary) {
      notFound(res, "Player not found in this academy");
      return;
    }
    res.status(201).json(CreateAcademyFinanceTeamPlayerResponse.parse(summary));
  },
);

router.patch(
  "/academy/console/academies/:academyId/finance/players/:playerId/billing",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = UpdateAcademyFinancePlayerBillingParams.safeParse({
      academyId: rawParam(req.params.academyId),
      playerId: rawParam(req.params.playerId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, playerId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = UpdateAcademyFinancePlayerBillingBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    if (Object.keys(body.data).length === 0) {
      badRequest(res, "At least one billing field is required");
      return;
    }
    if (body.data.subscriptionExpiresOn != null
      && !dateIsValidOrRespond(res, body.data.subscriptionExpiresOn, "Subscription expiry")) return;
    const player = await getPlayerAndSquad(academyId, playerId);
    if (!player) {
      notFound(res, "Player not found in this academy");
      return;
    }
    const updates: Partial<typeof academyPlayersTable.$inferInsert> = {};
    if (body.data.monthlyDiscountFils !== undefined) {
      updates.monthlyDiscountFils = body.data.monthlyDiscountFils;
    }
    if ("subscriptionExpiresOn" in body.data) {
      updates.subscriptionExpiresOn = body.data.subscriptionExpiresOn ?? null;
    }
    await db.update(academyPlayersTable).set(updates)
      .where(and(
        eq(academyPlayersTable.id, playerId),
        eq(academyPlayersTable.academyId, academyId),
      ));
    const summary = await getPlayerFinanceSummary(academyId, playerId);
    if (!summary) {
      notFound(res, "Player not found in this academy");
      return;
    }
    res.json(UpdateAcademyFinancePlayerBillingResponse.parse(summary));
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/players/:playerId/renewals",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = CreateAcademyFinancePlayerRenewalParams.safeParse({
      academyId: rawParam(req.params.academyId),
      playerId: rawParam(req.params.playerId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, playerId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = CreateAcademyFinancePlayerRenewalBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }

    const paidAt = new Date();
    const renewal = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: academyPlayersTable.id,
          squadId: academyPlayersTable.squadId,
          monthlyDiscountFils: academyPlayersTable.monthlyDiscountFils,
          subscriptionExpiresOn: academyPlayersTable.subscriptionExpiresOn,
          monthlyFeeFils: academySquadsTable.monthlyFeeFils,
        })
        .from(academyPlayersTable)
        .innerJoin(
          academySquadsTable,
          and(
            eq(academySquadsTable.id, academyPlayersTable.squadId),
            eq(academySquadsTable.academyId, academyId),
          ),
        )
        .where(and(
          eq(academyPlayersTable.id, playerId),
          eq(academyPlayersTable.academyId, academyId),
        ))
        .for("update");
      const player = rows[0];
      if (!player || player.squadId === null) return { kind: "missing" as const };
      const effectiveMonthlyFeeFils = Math.max(
        0,
        player.monthlyFeeFils - player.monthlyDiscountFils,
      );
      if (effectiveMonthlyFeeFils === 0) return { kind: "zero-fee" as const };
      const previousExpiresOn = player.subscriptionExpiresOn ?? getAmmanDate(paidAt);
      const newExpiresOn = addMonthsToDate(previousExpiresOn, body.data.months);
      const amountFils = effectiveMonthlyFeeFils * body.data.months;
      const [updated] = await tx.update(academyPlayersTable)
        .set({ subscriptionExpiresOn: newExpiresOn })
        .where(and(
          eq(academyPlayersTable.id, playerId),
          eq(academyPlayersTable.academyId, academyId),
        ))
        .returning({ id: academyPlayersTable.id });
      if (!updated) return { kind: "missing" as const };
      const [created] = await tx.insert(academyPlayerRenewalsTable).values({
        academyId,
        playerId,
        monthsPurchased: body.data.months,
        amountFils,
        effectiveMonthlyFeeFils,
        previousExpiresOn,
        newExpiresOn,
        paidAt,
      }).returning({
        id: academyPlayerRenewalsTable.id,
        playerId: academyPlayerRenewalsTable.playerId,
        monthsPurchased: academyPlayerRenewalsTable.monthsPurchased,
        amountFils: academyPlayerRenewalsTable.amountFils,
        effectiveMonthlyFeeFils: academyPlayerRenewalsTable.effectiveMonthlyFeeFils,
        previousExpiresOn: academyPlayerRenewalsTable.previousExpiresOn,
        newExpiresOn: academyPlayerRenewalsTable.newExpiresOn,
        paidAt: academyPlayerRenewalsTable.paidAt,
      });
      return { kind: "created" as const, renewal: created };
    });

    if (renewal.kind === "missing") {
      notFound(res, "Player not found in this academy");
      return;
    }
    if (renewal.kind === "zero-fee") {
      badRequest(res, "A positive effective monthly fee is required before recording a renewal");
      return;
    }
    res.status(201).json(AcademyFinanceRenewalResponse.parse({
      id: renewal.renewal.id,
      playerId: renewal.renewal.playerId,
      months: renewal.renewal.monthsPurchased,
      amountFils: renewal.renewal.amountFils,
      effectiveMonthlyFeeFils: renewal.renewal.effectiveMonthlyFeeFils,
      previousExpiresOn: renewal.renewal.previousExpiresOn,
      newExpiresOn: renewal.renewal.newExpiresOn,
      paidAt: renewal.renewal.paidAt,
    }));
  },
);

router.delete(
  "/academy/console/academies/:academyId/finance/players/:playerId/renewals/:renewalId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = DeleteAcademyFinancePlayerRenewalParams.safeParse({
      academyId: rawParam(req.params.academyId),
      playerId: rawParam(req.params.playerId),
      renewalId: rawParam(req.params.renewalId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, playerId, renewalId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;

    const result = await db.transaction(async (tx) => {
      const [player] = await tx.select({
        id: academyPlayersTable.id,
        subscriptionExpiresOn: academyPlayersTable.subscriptionExpiresOn,
      }).from(academyPlayersTable).where(and(
        eq(academyPlayersTable.id, playerId),
        eq(academyPlayersTable.academyId, academyId),
      )).for("update");
      if (!player) return "missing" as const;

      const [target] = await tx.select({
        id: academyPlayerRenewalsTable.id,
      }).from(academyPlayerRenewalsTable).where(and(
        eq(academyPlayerRenewalsTable.id, renewalId),
        eq(academyPlayerRenewalsTable.academyId, academyId),
        eq(academyPlayerRenewalsTable.playerId, playerId),
      )).for("update");
      if (!target) return "missing" as const;

      const [latest] = await tx.select({
        id: academyPlayerRenewalsTable.id,
        previousExpiresOn: academyPlayerRenewalsTable.previousExpiresOn,
        newExpiresOn: academyPlayerRenewalsTable.newExpiresOn,
      }).from(academyPlayerRenewalsTable).where(and(
        eq(academyPlayerRenewalsTable.academyId, academyId),
        eq(academyPlayerRenewalsTable.playerId, playerId),
      )).orderBy(desc(academyPlayerRenewalsTable.id)).limit(1).for("update");
      if (!latest || latest.id !== renewalId) return "not-latest" as const;
      if (player.subscriptionExpiresOn !== latest.newExpiresOn) return "not-latest" as const;

      const [deleted] = await tx.delete(academyPlayerRenewalsTable).where(and(
        eq(academyPlayerRenewalsTable.id, renewalId),
        eq(academyPlayerRenewalsTable.academyId, academyId),
        eq(academyPlayerRenewalsTable.playerId, playerId),
      )).returning({ id: academyPlayerRenewalsTable.id });
      if (!deleted) return "missing" as const;
      await tx.update(academyPlayersTable).set({
        subscriptionExpiresOn: latest.previousExpiresOn,
      }).where(and(
        eq(academyPlayersTable.id, playerId),
        eq(academyPlayersTable.academyId, academyId),
      ));
      return "deleted" as const;
    });
    if (result === "missing") {
      notFound(res, "Renewal not found in this academy");
      return;
    }
    if (result === "not-latest") {
      res.status(409).json({ error: "Only the latest renewal can be undone" });
      return;
    }
    res.status(204).send();
  },
);

router.get(
  "/academy/console/academies/:academyId/finance/players/:playerId/fees",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = ListAcademyFinancePlayerFeesParams.safeParse({
      academyId: rawParam(req.params.academyId),
      playerId: rawParam(req.params.playerId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, playerId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const [player] = await db.select({ id: academyPlayersTable.id })
      .from(academyPlayersTable)
      .where(and(
        eq(academyPlayersTable.id, playerId),
        eq(academyPlayersTable.academyId, academyId),
      ));
    if (!player) {
      notFound(res, "Player not found in this academy");
      return;
    }
    const fees = await db.select({
      id: academyFeesTable.id,
      playerId: academyFeesTable.playerId,
      label: academyFeesTable.label,
      amountFils: academyFeesTable.amountFils,
      dueDate: academyFeesTable.dueDate,
      status: academyFeesTable.status,
      paidAt: academyFeesTable.paidAt,
      note: academyFeesTable.note,
    }).from(academyFeesTable).where(and(
      eq(academyFeesTable.academyId, academyId),
      eq(academyFeesTable.playerId, playerId),
    )).orderBy(asc(academyFeesTable.dueDate), asc(academyFeesTable.id));
    res.json(ListAcademyFinancePlayerFeesResponse.parse(fees));
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/players/:playerId/fees",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = CreateAcademyFinancePlayerFeeParams.safeParse({
      academyId: rawParam(req.params.academyId),
      playerId: rawParam(req.params.playerId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, playerId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = CreateAcademyFinancePlayerFeeBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    const label = body.data.label.trim();
    if (!label) {
      badRequest(res, "Fee label cannot be empty");
      return;
    }
    const [player] = await db.select({ id: academyPlayersTable.id })
      .from(academyPlayersTable)
      .where(and(
        eq(academyPlayersTable.id, playerId),
        eq(academyPlayersTable.academyId, academyId),
      ));
    if (!player) {
      notFound(res, "Player not found in this academy");
      return;
    }
    if (body.data.dueDate != null
      && !dateIsValidOrRespond(res, body.data.dueDate, "Due date")) return;
    const [created] = await db.insert(academyFeesTable).values({
      academyId,
      playerId,
      label,
      amountFils: body.data.amountFils,
      dueDate: body.data.dueDate ?? getAmmanDate(),
      status: "due",
      paidAt: null,
      note: body.data.note?.trim() || null,
    }).returning({ id: academyFeesTable.id });
    const [fee] = await getFeeSummary(academyId, created.id);
    res.status(201).json(AcademyFinanceFeeResponse.parse(fee));
  },
);

router.patch(
  "/academy/console/academies/:academyId/finance/fees/:feeId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = MarkAcademyFinanceFeePaidParams.safeParse({
      academyId: rawParam(req.params.academyId),
      feeId: rawParam(req.params.feeId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, feeId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = MarkAcademyFinanceFeePaidBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select()
        .from(academyFeesTable)
        .where(and(
          eq(academyFeesTable.id, feeId),
          eq(academyFeesTable.academyId, academyId),
        ))
        .for("update");
      if (!existing) return { kind: "missing" as const };
      if (existing.status === "paid") return { kind: "fee" as const, fee: existing };
      if (existing.status === "waived") return { kind: "waived" as const };
      const [updated] = await tx.update(academyFeesTable)
        .set({ status: body.data.status, paidAt: new Date() })
        .where(and(
          eq(academyFeesTable.id, feeId),
          eq(academyFeesTable.academyId, academyId),
        ))
        .returning();
      return updated ? { kind: "fee" as const, fee: updated } : { kind: "missing" as const };
    });
    if (result.kind === "missing") {
      notFound(res, "Fee not found in this academy");
      return;
    }
    if (result.kind === "waived") {
      res.status(409).json({ error: "A waived fee cannot be marked as paid" });
      return;
    }
    res.json(MarkAcademyFinanceFeePaidResponse.parse({
      id: result.fee.id,
      playerId: result.fee.playerId,
      label: result.fee.label,
      amountFils: result.fee.amountFils,
      dueDate: result.fee.dueDate,
      status: result.fee.status,
      paidAt: result.fee.paidAt,
      note: result.fee.note,
    }));
  },
);

router.delete(
  "/academy/console/academies/:academyId/finance/fees/:feeId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = DeleteAcademyFinanceFeeParams.safeParse({
      academyId: rawParam(req.params.academyId),
      feeId: rawParam(req.params.feeId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, feeId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const [deleted] = await db.delete(academyFeesTable).where(and(
      eq(academyFeesTable.id, feeId),
      eq(academyFeesTable.academyId, academyId),
    )).returning({ id: academyFeesTable.id });
    if (!deleted) {
      notFound(res, "Fee not found in this academy");
      return;
    }
    res.status(204).send();
  },
);

router.get("/academy/console/academies/:academyId/finance/staff", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const params = ListAcademyFinanceStaffParams.safeParse({ academyId: rawParam(req.params.academyId) });
  if (!params.success) {
    badRequest(res, params.error.message);
    return;
  }
  const { academyId } = params.data;
  if (!(await authorizeOwner(req, res, academyId))) return;
  const staff = await db.select({
    id: academyFinanceStaffTable.id,
    name: academyFinanceStaffTable.name,
    role: academyFinanceStaffTable.role,
    monthlySalaryFils: academyFinanceStaffTable.monthlySalaryFils,
    nextSalaryDate: academyFinanceStaffTable.nextSalaryDate,
    contractEndDate: academyFinanceStaffTable.contractEndDate,
  }).from(academyFinanceStaffTable)
    .where(eq(academyFinanceStaffTable.academyId, academyId))
    .orderBy(asc(academyFinanceStaffTable.nextSalaryDate), asc(academyFinanceStaffTable.name));
  res.json(ListAcademyFinanceStaffResponse.parse(staff));
});

router.post("/academy/console/academies/:academyId/finance/staff", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const params = CreateAcademyFinanceStaffParams.safeParse({ academyId: rawParam(req.params.academyId) });
  if (!params.success) {
    badRequest(res, params.error.message);
    return;
  }
  const { academyId } = params.data;
  if (!(await authorizeOwner(req, res, academyId))) return;
  const body = CreateAcademyFinanceStaffBody.safeParse(req.body);
  if (!body.success) {
    badRequest(res, body.error.message);
    return;
  }
  if (!body.data.name.trim() || !body.data.role.trim()) {
    badRequest(res, "Staff name and role cannot be empty");
    return;
  }
  if (!dateIsValidOrRespond(res, body.data.nextSalaryDate, "Next salary date")) return;
  if (!dateIsValidOrRespond(res, body.data.contractEndDate, "Contract end date")) return;
  const [created] = await db.insert(academyFinanceStaffTable).values({
    academyId,
    name: body.data.name.trim(),
    role: body.data.role.trim(),
    monthlySalaryFils: body.data.monthlySalaryFils,
    nextSalaryDate: body.data.nextSalaryDate,
    contractEndDate: body.data.contractEndDate,
  }).returning({
    id: academyFinanceStaffTable.id,
    name: academyFinanceStaffTable.name,
    role: academyFinanceStaffTable.role,
    monthlySalaryFils: academyFinanceStaffTable.monthlySalaryFils,
    nextSalaryDate: academyFinanceStaffTable.nextSalaryDate,
    contractEndDate: academyFinanceStaffTable.contractEndDate,
  });
  res.status(201).json(AcademyFinanceStaffResponse.parse(created));
});

router.patch(
  "/academy/console/academies/:academyId/finance/staff/:staffId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = UpdateAcademyFinanceStaffParams.safeParse({
      academyId: rawParam(req.params.academyId),
      staffId: rawParam(req.params.staffId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, staffId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = UpdateAcademyFinanceStaffBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    if (Object.keys(body.data).length === 0) {
      badRequest(res, "At least one staff field is required");
      return;
    }
    for (const [field, value] of Object.entries({
      name: body.data.name,
      role: body.data.role,
    })) {
      if (value !== undefined && !value.trim()) {
        badRequest(res, `Staff ${field} cannot be empty`);
        return;
      }
    }
    if (body.data.nextSalaryDate
      && !dateIsValidOrRespond(res, body.data.nextSalaryDate, "Next salary date")) return;
    if (body.data.contractEndDate
      && !dateIsValidOrRespond(res, body.data.contractEndDate, "Contract end date")) return;

    const updates: Partial<typeof academyFinanceStaffTable.$inferInsert> = {};
    if (body.data.name !== undefined) updates.name = body.data.name.trim();
    if (body.data.role !== undefined) updates.role = body.data.role.trim();
    if (body.data.monthlySalaryFils !== undefined) {
      updates.monthlySalaryFils = body.data.monthlySalaryFils;
    }
    if (body.data.nextSalaryDate !== undefined) updates.nextSalaryDate = body.data.nextSalaryDate;
    if (body.data.contractEndDate !== undefined) updates.contractEndDate = body.data.contractEndDate;
    const [updated] = await db.update(academyFinanceStaffTable)
      .set(updates)
      .where(and(
        eq(academyFinanceStaffTable.id, staffId),
        eq(academyFinanceStaffTable.academyId, academyId),
      ))
      .returning({
        id: academyFinanceStaffTable.id,
        name: academyFinanceStaffTable.name,
        role: academyFinanceStaffTable.role,
        monthlySalaryFils: academyFinanceStaffTable.monthlySalaryFils,
        nextSalaryDate: academyFinanceStaffTable.nextSalaryDate,
        contractEndDate: academyFinanceStaffTable.contractEndDate,
      });
    if (!updated) {
      notFound(res, "Staff member not found in this academy");
      return;
    }
    res.json(UpdateAcademyFinanceStaffResponse.parse(updated));
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/staff/:staffId/salary-payment",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = RecordAcademyFinanceSalaryPaymentParams.safeParse({
      academyId: rawParam(req.params.academyId),
      staffId: rawParam(req.params.staffId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, staffId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const paidAt = new Date();
    const occurredOn = getAmmanDate(paidAt);
    const result = await db.transaction(async (tx) => {
      const [staff] = await tx.select()
        .from(academyFinanceStaffTable)
        .where(and(
          eq(academyFinanceStaffTable.id, staffId),
          eq(academyFinanceStaffTable.academyId, academyId),
        ))
        .for("update");
      if (!staff) return null;
      if (staff.monthlySalaryFils <= 0) return { kind: "zero-salary" as const };
      const [payment] = await tx.insert(academyOtherPaymentsTable).values({
        academyId,
        staffId,
        category: "Salary",
        label: `${staff.name} salary`,
        amountFils: staff.monthlySalaryFils,
        occurredOn,
        status: "paid",
        paidAt,
      }).returning({
        id: academyOtherPaymentsTable.id,
        staffId: academyOtherPaymentsTable.staffId,
        category: academyOtherPaymentsTable.category,
        label: academyOtherPaymentsTable.label,
        amountFils: academyOtherPaymentsTable.amountFils,
        occurredOn: academyOtherPaymentsTable.occurredOn,
        status: academyOtherPaymentsTable.status,
        paidAt: academyOtherPaymentsTable.paidAt,
      });
      const [updatedStaff] = await tx.update(academyFinanceStaffTable)
        .set({ nextSalaryDate: addMonthsToDate(staff.nextSalaryDate, 1) })
        .where(and(
          eq(academyFinanceStaffTable.id, staffId),
          eq(academyFinanceStaffTable.academyId, academyId),
        ))
        .returning({
          id: academyFinanceStaffTable.id,
          name: academyFinanceStaffTable.name,
          role: academyFinanceStaffTable.role,
          monthlySalaryFils: academyFinanceStaffTable.monthlySalaryFils,
          nextSalaryDate: academyFinanceStaffTable.nextSalaryDate,
          contractEndDate: academyFinanceStaffTable.contractEndDate,
        });
      return { kind: "created" as const, staff: updatedStaff, payment };
    });
    if (!result) {
      notFound(res, "Staff member not found in this academy");
      return;
    }
    if (result.kind === "zero-salary") {
      badRequest(res, "A salary must be greater than zero to record a payment");
      return;
    }
    res.status(201).json(RecordAcademyFinanceSalaryPaymentResponse.parse(result));
  },
);

router.get(
  "/academy/console/academies/:academyId/finance/other-payments",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = ListAcademyFinanceOtherPaymentsParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const range = getAmmanMonthRange();
    const payments = await db.select({
      id: academyOtherPaymentsTable.id,
      staffId: academyOtherPaymentsTable.staffId,
      category: academyOtherPaymentsTable.category,
      label: academyOtherPaymentsTable.label,
      amountFils: academyOtherPaymentsTable.amountFils,
      occurredOn: academyOtherPaymentsTable.occurredOn,
      status: academyOtherPaymentsTable.status,
      paidAt: academyOtherPaymentsTable.paidAt,
    }).from(academyOtherPaymentsTable)
      .where(and(
        eq(academyOtherPaymentsTable.academyId, academyId),
        sql`(${academyOtherPaymentsTable.status} = 'unpaid' OR (
          ${academyOtherPaymentsTable.occurredOn} >= ${range.startDate}
          AND ${academyOtherPaymentsTable.occurredOn} < ${range.endDate}
        ))`,
      ))
      .orderBy(desc(academyOtherPaymentsTable.occurredOn), desc(academyOtherPaymentsTable.id));
    res.json(ListAcademyFinanceOtherPaymentsResponse.parse({
      month: range.month,
      paidTotalFils: payments
        .filter((payment) => payment.status === "paid")
        .reduce((sum, payment) => sum + payment.amountFils, 0),
      unpaidTotalFils: payments
        .filter((payment) => payment.status === "unpaid")
        .reduce((sum, payment) => sum + payment.amountFils, 0),
      payments,
    }));
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/other-payments",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = CreateAcademyFinanceOtherPaymentParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = CreateAcademyFinanceOtherPaymentBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    const category = body.data.category.trim();
    const label = body.data.label.trim();
    if (!category || !label) {
      badRequest(res, "Payment category and label cannot be empty");
      return;
    }
    if (!(await validPaymentCategory(academyId, category))) {
      badRequest(res, "Save this payment category before using it");
      return;
    }
    const paidAt = body.data.status === "paid" ? new Date() : null;
    const [created] = await db.insert(academyOtherPaymentsTable).values({
      academyId,
      category,
      label,
      amountFils: body.data.amountFils,
      occurredOn: getAmmanDate(),
      status: body.data.status,
      paidAt,
    }).returning({
      id: academyOtherPaymentsTable.id,
      staffId: academyOtherPaymentsTable.staffId,
      category: academyOtherPaymentsTable.category,
      label: academyOtherPaymentsTable.label,
      amountFils: academyOtherPaymentsTable.amountFils,
      occurredOn: academyOtherPaymentsTable.occurredOn,
      status: academyOtherPaymentsTable.status,
      paidAt: academyOtherPaymentsTable.paidAt,
    });
    res.status(201).json(AcademyFinanceOtherPaymentResponse.parse(created));
  },
);

router.patch(
  "/academy/console/academies/:academyId/finance/other-payments/:paymentId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = MarkAcademyFinanceOtherPaymentPaidParams.safeParse({
      academyId: rawParam(req.params.academyId),
      paymentId: rawParam(req.params.paymentId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, paymentId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = MarkAcademyFinanceOtherPaymentPaidBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    const payment = await db.transaction(async (tx) => {
      const [existing] = await tx.select()
        .from(academyOtherPaymentsTable)
        .where(and(
          eq(academyOtherPaymentsTable.id, paymentId),
          eq(academyOtherPaymentsTable.academyId, academyId),
        ))
        .for("update");
      if (!existing) return null;
      if (existing.status === "paid") return existing;
      const [updated] = await tx.update(academyOtherPaymentsTable)
        .set({ status: body.data.status, paidAt: new Date() })
        .where(and(
          eq(academyOtherPaymentsTable.id, paymentId),
          eq(academyOtherPaymentsTable.academyId, academyId),
        ))
        .returning();
      return updated ?? null;
    });
    if (!payment) {
      notFound(res, "Payment not found in this academy");
      return;
    }
    res.json(MarkAcademyFinanceOtherPaymentPaidResponse.parse({
      id: payment.id,
      staffId: payment.staffId,
      category: payment.category,
      label: payment.label,
      amountFils: payment.amountFils,
      occurredOn: payment.occurredOn,
      status: payment.status,
      paidAt: payment.paidAt,
    }));
  },
);

router.delete(
  "/academy/console/academies/:academyId/finance/other-payments/:paymentId",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = DeleteAcademyFinanceOtherPaymentParams.safeParse({
      academyId: rawParam(req.params.academyId),
      paymentId: rawParam(req.params.paymentId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, paymentId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const [deleted] = await db.delete(academyOtherPaymentsTable).where(and(
      eq(academyOtherPaymentsTable.id, paymentId),
      eq(academyOtherPaymentsTable.academyId, academyId),
    )).returning({ id: academyOtherPaymentsTable.id });
    if (!deleted) {
      notFound(res, "Payment not found in this academy");
      return;
    }
    res.status(204).send();
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/other-payments/:paymentId/repeat",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = RepeatAcademyFinanceOtherPaymentParams.safeParse({
      academyId: rawParam(req.params.academyId),
      paymentId: rawParam(req.params.paymentId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId, paymentId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const original = await getPaymentById(academyId, paymentId);
    if (!original) {
      notFound(res, "Payment not found in this academy");
      return;
    }
    const [created] = await db.insert(academyOtherPaymentsTable).values({
      academyId,
      staffId: original.staffId,
      category: original.category,
      label: original.label,
      amountFils: original.amountFils,
      occurredOn: getAmmanDate(),
      status: "unpaid",
      paidAt: null,
    }).returning({
      id: academyOtherPaymentsTable.id,
      staffId: academyOtherPaymentsTable.staffId,
      category: academyOtherPaymentsTable.category,
      label: academyOtherPaymentsTable.label,
      amountFils: academyOtherPaymentsTable.amountFils,
      occurredOn: academyOtherPaymentsTable.occurredOn,
      status: academyOtherPaymentsTable.status,
      paidAt: academyOtherPaymentsTable.paidAt,
    });
    res.status(201).json(RepeatAcademyFinanceOtherPaymentResponse.parse(created));
  },
);

router.get(
  "/academy/console/academies/:academyId/finance/categories",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = ListAcademyFinanceCategoriesParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const custom = await db.select({
      id: academyPaymentCategoriesTable.id,
      name: academyPaymentCategoriesTable.name,
    }).from(academyPaymentCategoriesTable)
      .where(eq(academyPaymentCategoriesTable.academyId, academyId))
      .orderBy(asc(academyPaymentCategoriesTable.name));
    res.json(ListAcademyFinanceCategoriesResponse.parse({
      builtIn: BUILT_IN_CATEGORIES,
      custom,
    }));
  },
);

router.post(
  "/academy/console/academies/:academyId/finance/categories",
  async (req, res): Promise<void> => {
    const user = await requireAcademyConsoleUser(req, res);
    if (!user) return;
    const params = CreateAcademyFinanceCategoryParams.safeParse({
      academyId: rawParam(req.params.academyId),
    });
    if (!params.success) {
      badRequest(res, params.error.message);
      return;
    }
    const { academyId } = params.data;
    if (!(await authorizeOwner(req, res, academyId))) return;
    const body = CreateAcademyFinanceCategoryBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.message);
      return;
    }
    const name = body.data.name.trim();
    if (!name) {
      badRequest(res, "Category name cannot be empty");
      return;
    }
    if (BUILT_IN_CATEGORIES.some((category) => category.toLowerCase() === name.toLowerCase())
      || name.toLowerCase() === "salary") {
      badRequest(res, "That category already exists");
      return;
    }
    const [existing] = await db.select({ id: academyPaymentCategoriesTable.id })
      .from(academyPaymentCategoriesTable)
      .where(and(
        eq(academyPaymentCategoriesTable.academyId, academyId),
        sql`lower(${academyPaymentCategoriesTable.name}) = ${name.toLowerCase()}`,
      ));
    if (existing) {
      res.status(409).json({ error: "That category already exists" });
      return;
    }
    try {
      const [created] = await db.insert(academyPaymentCategoriesTable).values({
        academyId,
        name,
      }).returning({
        id: academyPaymentCategoriesTable.id,
        name: academyPaymentCategoriesTable.name,
      });
      res.status(201).json(CreateAcademyFinanceCategoryResponse.parse(created));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "23505") {
        res.status(409).json({ error: "That category already exists" });
        return;
      }
      throw error;
    }
  },
);

export default router;
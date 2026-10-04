import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  academyFeesTable,
  academyFinanceStaffTable,
  academyMembersTable,
  academyOtherPaymentsTable,
  academyPaymentCategoriesTable,
  academyPlayerRenewalsTable,
  academyPlayersTable,
  academySquadsTable,
  academiesTable,
  db,
  fieldsTable,
  usersTable,
} from "@workspace/db";
import {
  addMonthsToDate,
  getAmmanDate,
  getAmmanMonthRange,
  monthsOwedSince,
} from "../lib/academyFinanceMath";

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserRecord: vi.fn(async (req: { headers: Record<string, string | undefined> }) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return null;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(raw)));
    return user && !user.isGuest && !user.isDisabled ? user : null;
  }),
  unauthenticatedResponse: vi.fn((res: {
    status: (code: number) => { json: (body: unknown) => void };
  }) => {
    res.status(401).json({ error: "Unauthenticated" });
  }),
}));

import academyFinanceRouter from "./academyFinance";

const tag = `academy_finance_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const userIds: number[] = [];
const academyIds: number[] = [];
const fieldIds: number[] = [];
let app: Express;
let ownerId: number;
let coachId: number;
let nonMemberId: number;
let adminId: number;
let academyAId: number;
let academyBId: number;
let squadAId: number;
let squadBId: number;
let playerAId: number;
let renewalPlayerId: number;
let playerBId: number;
let foreignStaffId: number;

const as = (id: number) => ({ "x-test-user": String(id) });
const dateOffset = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const financeUrl = (academyId: number) => `/api/academy/console/academies/${academyId}/finance`;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use("/api", academyFinanceRouter);

  const createdUsers = await db.insert(usersTable).values([
    { name: `finance owner ${tag}`, email: `finance_owner_${tag}@academy-test.local` },
    { name: `finance coach ${tag}`, email: `finance_coach_${tag}@academy-test.local` },
    { name: `finance non-member ${tag}`, email: `finance_nonmember_${tag}@academy-test.local` },
    { name: `finance admin ${tag}`, email: `finance_admin_${tag}@academy-test.local`, isAdmin: true },
  ]).returning({ id: usersTable.id });
  userIds.push(...createdUsers.map(({ id }) => id));
  [ownerId, coachId, nonMemberId, adminId] = createdUsers.map(({ id }) => id);

  const fields = await db.insert(fieldsTable).values([
    { name: `Finance academy field A ${tag}` },
    { name: `Finance academy field B ${tag}` },
  ]).returning({ id: fieldsTable.id });
  fieldIds.push(...fields.map(({ id }) => id));
  const academies = await db.insert(academiesTable).values([
    { name: `Finance academy A ${tag}`, fieldId: fields[0].id },
    { name: `Finance academy B ${tag}`, fieldId: fields[1].id },
  ]).returning({ id: academiesTable.id });
  [academyAId, academyBId] = academies.map(({ id }) => id);
  academyIds.push(academyAId, academyBId);

  await db.insert(academyMembersTable).values([
    { userId: ownerId, academyId: academyAId, role: "owner" },
    { userId: ownerId, academyId: academyAId, role: "coach" },
    { userId: ownerId, academyId: academyBId, role: "owner" },
    { userId: coachId, academyId: academyAId, role: "coach" },
  ]);

  const today = getAmmanDate();
  const squads = await db.insert(academySquadsTable).values([
    { academyId: academyAId, name: `Finance squad A ${tag}`, monthlyFeeFils: 30000 },
    { academyId: academyBId, name: `Finance squad B ${tag}`, monthlyFeeFils: 90000 },
  ]).returning({ id: academySquadsTable.id });
  [squadAId, squadBId] = squads.map(({ id }) => id);

  const players = await db.insert(academyPlayersTable).values([
    {
      academyId: academyAId,
      squadId: squadAId,
      name: `Multi-month player ${tag}`,
      monthlyDiscountFils: 5000,
      subscriptionExpiresOn: addMonthsToDate(today, -4),
      isActive: true,
    },
    {
      academyId: academyAId,
      squadId: squadAId,
      name: `Renewal player ${tag}`,
      monthlyDiscountFils: 5000,
      subscriptionExpiresOn: dateOffset(today, 10),
      isActive: true,
    },
    {
      academyId: academyBId,
      squadId: squadBId,
      name: `Foreign player ${tag}`,
      subscriptionExpiresOn: dateOffset(today, 20),
      isActive: true,
    },
  ]).returning({ id: academyPlayersTable.id });
  [playerAId, renewalPlayerId, playerBId] = players.map(({ id }) => id);

  await db.insert(academyFeesTable).values({
    academyId: academyBId,
    playerId: playerBId,
    label: `Foreign paid fee ${tag}`,
    amountFils: 8000,
    dueDate: today,
    status: "paid",
    paidAt: new Date(),
  });
  await db.insert(academyPlayerRenewalsTable).values({
    academyId: academyBId,
    playerId: playerBId,
    monthsPurchased: 1,
    amountFils: 50000,
    effectiveMonthlyFeeFils: 50000,
    previousExpiresOn: today,
    newExpiresOn: dateOffset(today, 20),
    paidAt: new Date(),
  });
  await db.insert(academyPaymentCategoriesTable).values({
    academyId: academyBId,
    name: `Foreign category ${tag}`,
  });
  await db.insert(academyOtherPaymentsTable).values([
    {
      academyId: academyBId,
      category: "Rent",
      label: `Foreign paid payment ${tag}`,
      amountFils: 12000,
      occurredOn: today,
      status: "paid",
      paidAt: new Date(),
    },
    {
      academyId: academyBId,
      category: "Rent",
      label: `Foreign unpaid payment ${tag}`,
      amountFils: 6000,
      occurredOn: today,
      status: "unpaid",
    },
  ]);
  const [foreignStaff] = await db.insert(academyFinanceStaffTable).values({
    academyId: academyBId,
    name: `Foreign staff ${tag}`,
    role: "Coach",
    monthlySalaryFils: 100000,
    nextSalaryDate: today,
    contractEndDate: dateOffset(today, 120),
  }).returning({ id: academyFinanceStaffTable.id });
  foreignStaffId = foreignStaff.id;
});

afterAll(async () => {
  if (academyIds.length > 0) {
    await db.delete(academiesTable).where(inArray(academiesTable.id, academyIds));
  }
  if (fieldIds.length > 0) {
    await db.delete(fieldsTable).where(inArray(fieldsTable.id, fieldIds));
  }
  if (userIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
});

describe("Academy Finance owner access and accounting", () => {
  it("uses Asia/Amman month boundaries for finance reporting", () => {
    const beforeAmmanMidnight = new Date("2026-09-30T20:59:59.999Z");
    const atAmmanMidnight = new Date("2026-09-30T21:00:00.000Z");
    expect(getAmmanMonthRange(beforeAmmanMidnight).month).toBe("2026-09");
    const october = getAmmanMonthRange(atAmmanMidnight);
    expect(october.month).toBe("2026-10");
    expect(atAmmanMidnight >= october.startAt && atAmmanMidnight < october.endAt).toBe(true);
  });

  it("requires sign-in and an owner membership; admin and coach flags do not grant access", async () => {
    const url = `${financeUrl(academyAId)}/categories`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set(as(nonMemberId))).status).toBe(403);
    expect((await request(app).get(url).set(as(coachId))).status).toBe(403);
    expect((await request(app).get(url).set(as(adminId))).status).toBe(403);
    const ownerResponse = await request(app).get(url).set(as(ownerId));
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body.builtIn).toEqual(["Rent", "Transport", "Replay", "Equipment", "Other"]);
    expect((await request(app).get(`${financeUrl(999999)}/categories`).set(as(nonMemberId))).status).toBe(403);
  });

  it("scopes dashboard collections, spending, and unpaid bills to the selected academy", async () => {
    const academyAResponse = await request(app)
      .get(`${financeUrl(academyAId)}/dashboard`).set(as(ownerId));
    const academyBResponse = await request(app)
      .get(`${financeUrl(academyBId)}/dashboard`).set(as(ownerId));

    expect(academyAResponse.status).toBe(200);
    expect(academyAResponse.body).toMatchObject({
      collectedFils: 0,
      spentFils: 0,
      netFils: 0,
      unpaidBillsCount: 0,
      unpaidPayments: [],
    });
    expect(academyBResponse.status).toBe(200);
    expect(academyBResponse.body).toMatchObject({
      collectedFils: 58000,
      spentFils: 12000,
      netFils: 46000,
      unpaidBillsCount: 1,
    });
    expect(academyBResponse.body.unpaidPayments[0].label).toBe(`Foreign unpaid payment ${tag}`);
    const teamList = await request(app).get(`${financeUrl(academyAId)}/teams`).set(as(ownerId));
    expect(teamList.body).toHaveLength(1);
    expect(teamList.body[0].name).toBe(`Finance squad A ${tag}`);
  });

  it("calculates multi-month debt from the discounted fee and applies manual expiry edits", async () => {
    const url = `${financeUrl(academyAId)}/teams/${squadAId}/players`;
    const before = await request(app).get(url).set(as(ownerId));
    expect(before.status).toBe(200);
    const player = before.body.find((entry: { id: number }) => entry.id === playerAId);
    const owedMonths = monthsOwedSince(addMonthsToDate(getAmmanDate(), -4), getAmmanDate());
    expect(player).toMatchObject({
      monthlyFeeFils: 30000,
      monthlyDiscountFils: 5000,
      effectiveMonthlyFeeFils: 25000,
      monthsOwed: owedMonths,
      subscriptionDebtFils: owedMonths * 25000,
      subscriptionStatus: "expired",
    });

    const correctedExpiry = dateOffset(getAmmanDate(), 20);
    const edited = await request(app).patch(
      `${financeUrl(academyAId)}/players/${playerAId}/billing`,
    ).set(as(ownerId)).send({
      monthlyDiscountFils: 10000,
      subscriptionExpiresOn: correctedExpiry,
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      monthlyDiscountFils: 10000,
      effectiveMonthlyFeeFils: 20000,
      subscriptionExpiresOn: correctedExpiry,
      subscriptionStatus: "paid",
      monthsOwed: 0,
      subscriptionDebtFils: 0,
    });
  });

  it("renews from the existing expiry and snapshots the discounted payment amount", async () => {
    const previousExpiry = dateOffset(getAmmanDate(), 10);
    const updated = await db.update(academyPlayersTable)
      .set({ subscriptionExpiresOn: previousExpiry })
      .where(eq(academyPlayersTable.id, renewalPlayerId))
      .returning({ id: academyPlayersTable.id });
    expect(updated).toHaveLength(1);

    const response = await request(app)
      .post(`${financeUrl(academyAId)}/players/${renewalPlayerId}/renewals`)
      .set(as(ownerId)).send({ months: 2 });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId: renewalPlayerId,
      months: 2,
      amountFils: 50000,
      effectiveMonthlyFeeFils: 25000,
      previousExpiresOn: previousExpiry,
      newExpiresOn: addMonthsToDate(previousExpiry, 2),
    });
    expect(response.body.paidAt).toBeTruthy();
    const [snapshot] = await db.select().from(academyPlayerRenewalsTable)
      .where(eq(academyPlayerRenewalsTable.id, response.body.id));
    expect(snapshot).toMatchObject({
      academyId: academyAId,
      playerId: renewalPlayerId,
      amountFils: 50000,
      effectiveMonthlyFeeFils: 25000,
      previousExpiresOn: previousExpiry,
      newExpiresOn: addMonthsToDate(previousExpiry, 2),
    });
  });

  it("updates a team's fee for future renewals without rewriting recorded renewal amounts", async () => {
    const today = getAmmanDate();
    const team = await request(app).post(`${financeUrl(academyAId)}/teams`)
      .set(as(ownerId)).send({ name: `Fee history team ${tag}`, monthlyFeeFils: 30000 });
    expect(team.status).toBe(201);
    const teamFeeUrl = `${financeUrl(academyAId)}/teams/${team.body.id}`;
    expect((await request(app).patch(teamFeeUrl).send({ monthlyFeeFils: 40000 })).status).toBe(401);
    expect((await request(app).patch(teamFeeUrl).set(as(coachId)).send({ monthlyFeeFils: 40000 })).status).toBe(403);
    const player = await request(app).post(
      `${financeUrl(academyAId)}/teams/${team.body.id}/players`,
    ).set(as(ownerId)).send({
      name: `Fee history player ${tag}`,
      monthlyDiscountFils: 5000,
      subscriptionExpiresOn: dateOffset(today, -65),
    });
    expect(player.status).toBe(201);

    const recordedBeforeEdit = await request(app)
      .post(`${financeUrl(academyAId)}/players/${player.body.id}/renewals`)
      .set(as(ownerId)).send({ months: 1 });
    expect(recordedBeforeEdit.status).toBe(201);
    expect(recordedBeforeEdit.body).toMatchObject({
      amountFils: 25000,
      effectiveMonthlyFeeFils: 25000,
    });

    const updated = await request(app).patch(teamFeeUrl)
      .set(as(ownerId)).send({ monthlyFeeFils: 40000 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ monthlyFeeFils: 40000 });

    const [storedRenewal] = await db.select().from(academyPlayerRenewalsTable)
      .where(eq(academyPlayerRenewalsTable.id, recordedBeforeEdit.body.id));
    expect(storedRenewal).toMatchObject({
      amountFils: 25000,
      effectiveMonthlyFeeFils: 25000,
    });

    const playerRows = await request(app).get(
      `${financeUrl(academyAId)}/teams/${team.body.id}/players`,
    ).set(as(ownerId));
    const updatedPlayer = playerRows.body[0];
    const newlyAccruedMonths = monthsOwedSince(recordedBeforeEdit.body.newExpiresOn, today);
    expect(updatedPlayer).toMatchObject({
      monthlyFeeFils: 40000,
      monthlyDiscountFils: 5000,
      effectiveMonthlyFeeFils: 35000,
      monthsOwed: newlyAccruedMonths,
      subscriptionDebtFils: newlyAccruedMonths * 35000,
    });

    const recordedAfterEdit = await request(app)
      .post(`${financeUrl(academyAId)}/players/${player.body.id}/renewals`)
      .set(as(ownerId)).send({ months: 1 });
    expect(recordedAfterEdit.status).toBe(201);
    expect(recordedAfterEdit.body).toMatchObject({
      amountFils: 35000,
      effectiveMonthlyFeeFils: 35000,
    });
  });

  it("starts a player's first subscription from today and charges the current effective team fee", async () => {
    const today = getAmmanDate();
    const [player] = await db.insert(academyPlayersTable).values({
      academyId: academyAId,
      squadId: squadAId,
      name: `Never started player ${tag}`,
      monthlyDiscountFils: 5000,
      subscriptionExpiresOn: null,
      isActive: true,
    }).returning({ id: academyPlayersTable.id });

    const response = await request(app)
      .post(`${financeUrl(academyAId)}/players/${player.id}/renewals`)
      .set(as(ownerId)).send({ months: 2 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId: player.id,
      months: 2,
      amountFils: 50000,
      effectiveMonthlyFeeFils: 25000,
      previousExpiresOn: today,
      newExpiresOn: addMonthsToDate(today, 2),
    });
    const [storedPlayer] = await db.select({
      subscriptionExpiresOn: academyPlayersTable.subscriptionExpiresOn,
    }).from(academyPlayersTable).where(eq(academyPlayersTable.id, player.id));
    expect(storedPlayer.subscriptionExpiresOn).toBe(addMonthsToDate(today, 2));
  });

  it("supports zero-fee teams and creates/collects one-off fees without overwriting other records", async () => {
    const team = await request(app).post(`${financeUrl(academyAId)}/teams`)
      .set(as(ownerId)).send({ name: `No-fee team ${tag}`, monthlyFeeFils: 0 });
    expect(team.status).toBe(201);
    expect(team.body.monthlyFeeFils).toBe(0);

    const player = await request(app).post(
      `${financeUrl(academyAId)}/teams/${team.body.id}/players`,
    ).set(as(ownerId)).send({
      name: `No-fee player ${tag}`,
      monthlyDiscountFils: 0,
      subscriptionExpiresOn: getAmmanDate(),
    });
    expect(player.status).toBe(201);
    expect(player.body.effectiveMonthlyFeeFils).toBe(0);
    const blockedRenewal = await request(app)
      .post(`${financeUrl(academyAId)}/players/${player.body.id}/renewals`)
      .set(as(ownerId)).send({ months: 1 });
    expect(blockedRenewal.status).toBe(400);
    expect(await db.select().from(academyPlayerRenewalsTable)
      .where(eq(academyPlayerRenewalsTable.playerId, player.body.id))).toHaveLength(0);

    const feeUrl = `${financeUrl(academyAId)}/players/${playerAId}/fees`;
    const blankLabel = await request(app).post(feeUrl).set(as(ownerId)).send({
      label: "   ",
      amountFils: 1000,
      dueDate: getAmmanDate(),
    });
    expect(blankLabel.status).toBe(400);

    const created = await request(app).post(feeUrl).set(as(ownerId)).send({
      label: `Tournament entry ${tag}`,
      amountFils: 12500,
      dueDate: getAmmanDate(),
      note: "One-off payment",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      playerId: playerAId,
      amountFils: 12500,
      status: "due",
      paidAt: null,
    });
    const before = await request(app).get(`${financeUrl(academyAId)}/dashboard`).set(as(ownerId));
    const paid = await request(app).patch(
      `${financeUrl(academyAId)}/fees/${created.body.id}`,
    ).set(as(ownerId)).send({ status: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ id: created.body.id, status: "paid", amountFils: 12500 });
    expect(paid.body.paidAt).toBeTruthy();
    const after = await request(app).get(`${financeUrl(academyAId)}/dashboard`).set(as(ownerId));
    expect(after.body.collectedFils - before.body.collectedFils).toBe(12500);
    const feeList = await request(app).get(feeUrl).set(as(ownerId));
    expect(feeList.body.find((entry: { id: number }) => entry.id === created.body.id).status).toBe("paid");
  });

  it("persists custom categories, marks payments paid, and repeats them as unpaid copies dated today", async () => {
    const category = await request(app).post(`${financeUrl(academyAId)}/categories`)
      .set(as(ownerId)).send({ name: `Referees ${tag}` });
    expect(category.status).toBe(201);
    const categories = await request(app).get(`${financeUrl(academyAId)}/categories`).set(as(ownerId));
    expect(categories.body.custom).toContainEqual({ id: category.body.id, name: `Referees ${tag}` });

    const payment = await request(app).post(`${financeUrl(academyAId)}/other-payments`)
      .set(as(ownerId)).send({
        category: `Referees ${tag}`,
        label: `Match officials ${tag}`,
        amountFils: 45000,
        status: "unpaid",
      });
    expect(payment.status).toBe(201);
    expect(payment.body).toMatchObject({ status: "unpaid", occurredOn: getAmmanDate() });

    const marked = await request(app).patch(
      `${financeUrl(academyAId)}/other-payments/${payment.body.id}`,
    ).set(as(ownerId)).send({ status: "paid" });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ status: "paid", amountFils: 45000 });
    expect(marked.body.paidAt).toBeTruthy();

    const repeated = await request(app).post(
      `${financeUrl(academyAId)}/other-payments/${payment.body.id}/repeat`,
    ).set(as(ownerId));
    expect(repeated.status).toBe(201);
    expect(repeated.body).toMatchObject({
      category: `Referees ${tag}`,
      label: `Match officials ${tag}`,
      amountFils: 45000,
      status: "unpaid",
      occurredOn: getAmmanDate(),
      paidAt: null,
    });
    const ledger = await request(app).get(`${financeUrl(academyAId)}/other-payments`).set(as(ownerId));
    expect(ledger.status).toBe(200);
    expect(ledger.body.payments.map((row: { id: number }) => row.id)).toContain(repeated.body.id);
    expect(ledger.body.unpaidTotalFils).toBe(45000);
  });

  it("records a salary expense and advances the next salary date by one month", async () => {
    const today = getAmmanDate();
    const nextDate = dateOffset(today, 2);
    const created = await request(app).post(`${financeUrl(academyAId)}/staff`)
      .set(as(ownerId)).send({
        name: `Coach ${tag}`,
        role: "Coach",
        monthlySalaryFils: 180000,
        nextSalaryDate: nextDate,
        contractEndDate: dateOffset(today, 180),
      });
    expect(created.status).toBe(201);
    const payment = await request(app).post(
      `${financeUrl(academyAId)}/staff/${created.body.id}/salary-payment`,
    ).set(as(ownerId));
    expect(payment.status).toBe(201);
    expect(payment.body.payment).toMatchObject({
      staffId: created.body.id,
      category: "Salary",
      amountFils: 180000,
      occurredOn: today,
      status: "paid",
    });
    expect(payment.body.payment.paidAt).toBeTruthy();
    expect(payment.body.staff.nextSalaryDate).toBe(addMonthsToDate(nextDate, 1));
  });

  it("undoes next salary date only when deleting the latest salary payment", async () => {
    expect(addMonthsToDate("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsToDate("2024-03-31", -1)).toBe("2024-02-29");

    const today = getAmmanDate();
    const nextDate = `${addMonthsToDate(today, 1).slice(0, 7)}-10`;
    const created = await request(app).post(`${financeUrl(academyAId)}/staff`)
      .set(as(ownerId)).send({
        name: `Salary rollback coach ${tag}`,
        role: "Coach",
        monthlySalaryFils: 180000,
        nextSalaryDate: nextDate,
        contractEndDate: dateOffset(today, 180),
      });
    expect(created.status).toBe(201);
    const staffId = created.body.id as number;
    const salaryUrl = `${financeUrl(academyAId)}/staff/${staffId}/salary-payment`;
    const paymentsUrl = `${financeUrl(academyAId)}/other-payments`;

    const firstPayment = await request(app).post(salaryUrl).set(as(ownerId));
    expect(firstPayment.status).toBe(201);
    expect(firstPayment.body.staff.nextSalaryDate).toBe(addMonthsToDate(nextDate, 1));

    await db.update(academyOtherPaymentsTable)
      .set({ category: "salary" })
      .where(eq(academyOtherPaymentsTable.id, firstPayment.body.payment.id));
    const deletedLatest = await request(app)
      .delete(`${paymentsUrl}/${firstPayment.body.payment.id}`)
      .set(as(ownerId));
    expect(deletedLatest.status).toBe(204);
    const [restoredStaff] = await db.select({
      nextSalaryDate: academyFinanceStaffTable.nextSalaryDate,
    }).from(academyFinanceStaffTable).where(eq(academyFinanceStaffTable.id, staffId));
    expect(restoredStaff.nextSalaryDate).toBe(nextDate);

    const earlierPayment = await request(app).post(salaryUrl).set(as(ownerId));
    expect(earlierPayment.status).toBe(201);
    const latestPayment = await request(app).post(salaryUrl).set(as(ownerId));
    expect(latestPayment.status).toBe(201);
    const dateAfterTwoPayments = addMonthsToDate(nextDate, 2);
    expect(latestPayment.body.staff.nextSalaryDate).toBe(dateAfterTwoPayments);

    const deletedEarlier = await request(app)
      .delete(`${paymentsUrl}/${earlierPayment.body.payment.id}`)
      .set(as(ownerId));
    expect(deletedEarlier.status).toBe(204);
    const [unchangedStaff] = await db.select({
      nextSalaryDate: academyFinanceStaffTable.nextSalaryDate,
    }).from(academyFinanceStaffTable).where(eq(academyFinanceStaffTable.id, staffId));
    expect(unchangedStaff.nextSalaryDate).toBe(dateAfterTwoPayments);
  });

  it("rejects foreign academy players, squads, and staff references at the write boundary", async () => {
    const wrongSquad = await request(app).post(
      `${financeUrl(academyAId)}/teams/${squadBId}/players`,
    ).set(as(ownerId)).send({
      name: `Wrong team player ${tag}`,
      monthlyDiscountFils: 0,
      subscriptionExpiresOn: getAmmanDate(),
    });
    expect(wrongSquad.status).toBe(404);

    const wrongPlayerFee = await request(app).post(
      `${financeUrl(academyAId)}/players/${playerBId}/fees`,
    ).set(as(ownerId)).send({
      label: "Foreign fee",
      amountFils: 1000,
    });
    expect(wrongPlayerFee.status).toBe(404);

    const wrongPlayerRenewal = await request(app).post(
      `${financeUrl(academyAId)}/players/${playerBId}/renewals`,
    ).set(as(ownerId)).send({ months: 1 });
    expect(wrongPlayerRenewal.status).toBe(404);

    const wrongTeamFeeUpdate = await request(app).patch(
      `${financeUrl(academyAId)}/teams/${squadBId}`,
    ).set(as(ownerId)).send({ monthlyFeeFils: 50000 });
    expect(wrongTeamFeeUpdate.status).toBe(404);

    const wrongSalary = await request(app).post(
      `${financeUrl(academyAId)}/staff/${foreignStaffId}/salary-payment`,
    ).set(as(ownerId));
    expect(wrongSalary.status).toBe(404);

    const wrongCategory = await request(app).post(`${financeUrl(academyAId)}/other-payments`)
      .set(as(ownerId)).send({
        category: `Foreign category ${tag}`,
        label: `Wrong academy category ${tag}`,
        amountFils: 1000,
        status: "unpaid",
      });
    expect(wrongCategory.status).toBe(400);
  });

  it("carries unpaid payments forward and keeps active squadless players visible", async () => {
    const range = getAmmanMonthRange();
    const priorDate = dateOffset(range.startDate, -1);
    const [carryover] = await db.insert(academyOtherPaymentsTable).values({
      academyId: academyAId,
      category: "Other",
      label: `Prior-month unpaid payment ${tag}`,
      amountFils: 19000,
      occurredOn: priorDate,
      status: "unpaid",
    }).returning({ id: academyOtherPaymentsTable.id });

    const payments = await request(app).get(`${financeUrl(academyAId)}/other-payments`).set(as(ownerId));
    expect(payments.status).toBe(200);
    expect(payments.body.payments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: carryover.id, status: "unpaid", occurredOn: priorDate }),
    ]));
    expect(payments.body.unpaidTotalFils).toBeGreaterThanOrEqual(19000);
    const dashboard = await request(app).get(`${financeUrl(academyAId)}/dashboard`).set(as(ownerId));
    expect(dashboard.body.unpaidPayments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: carryover.id, occurredOn: priorDate }),
    ]));

    const [unassigned] = await db.insert(academyPlayersTable).values({
      academyId: academyAId,
      squadId: null,
      name: `Active squadless player ${tag}`,
      isActive: true,
    }).returning({ id: academyPlayersTable.id });
    const [inactive] = await db.insert(academyPlayersTable).values({
      academyId: academyAId,
      squadId: null,
      name: `Inactive squadless player ${tag}`,
      isActive: false,
    }).returning({ id: academyPlayersTable.id });
    const fee = await request(app).post(`${financeUrl(academyAId)}/players/${unassigned.id}/fees`)
      .set(as(ownerId)).send({ label: `Squadless fee ${tag}`, amountFils: 7000 });
    expect(fee.status).toBe(201);
    const squadless = await request(app).get(`${financeUrl(academyAId)}/unassigned-players`).set(as(ownerId));
    expect(squadless.status).toBe(200);
    expect(squadless.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unassigned.id, unpaidFeesFils: 7000, outstandingFils: 7000 }),
    ]));
    expect(squadless.body.map((player: { id: number }) => player.id)).not.toContain(inactive.id);
  });

  it("allows owners to delete fees and other payments only within their academy", async () => {
    const fee = await request(app).post(`${financeUrl(academyAId)}/players/${playerAId}/fees`)
      .set(as(ownerId)).send({ label: `Delete fee ${tag}`, amountFils: 9000 });
    expect(fee.status).toBe(201);
    const feeUrl = `${financeUrl(academyAId)}/fees/${fee.body.id}`;
    expect((await request(app).delete(feeUrl).set(as(coachId))).status).toBe(403);
    expect((await request(app).delete(`${financeUrl(academyBId)}/fees/${fee.body.id}`).set(as(ownerId))).status).toBe(404);
    expect((await request(app).delete(feeUrl).set(as(ownerId))).status).toBe(204);
    expect((await request(app).delete(feeUrl).set(as(ownerId))).status).toBe(404);

    const payment = await db.insert(academyOtherPaymentsTable).values({
      academyId: academyAId,
      category: "Other",
      label: `Delete payment ${tag}`,
      amountFils: 11000,
      occurredOn: getAmmanDate(),
      status: "unpaid",
    }).returning({ id: academyOtherPaymentsTable.id });
    const paymentUrl = `${financeUrl(academyAId)}/other-payments/${payment[0].id}`;
    expect((await request(app).delete(paymentUrl).set(as(coachId))).status).toBe(403);
    expect((await request(app).delete(`${financeUrl(academyBId)}/other-payments/${payment[0].id}`).set(as(ownerId))).status).toBe(404);
    expect((await request(app).delete(paymentUrl).set(as(ownerId))).status).toBe(204);
    expect((await request(app).delete(paymentUrl).set(as(ownerId))).status).toBe(404);
  });

  it("only undoes the latest renewal and restores its previous expiry", async () => {
    const team = await request(app).post(`${financeUrl(academyAId)}/teams`)
      .set(as(ownerId)).send({ name: `Undo renewal team ${tag}`, monthlyFeeFils: 30000 });
    expect(team.status).toBe(201);
    const player = await request(app).post(`${financeUrl(academyAId)}/teams/${team.body.id}/players`)
      .set(as(ownerId)).send({
        name: `Undo renewal player ${tag}`,
        monthlyDiscountFils: 5000,
        subscriptionExpiresOn: getAmmanDate(),
      });
    expect(player.status).toBe(201);
    const renewalUrl = `${financeUrl(academyAId)}/players/${player.body.id}/renewals`;
    const first = await request(app).post(renewalUrl).set(as(ownerId)).send({ months: 1 });
    const latest = await request(app).post(renewalUrl).set(as(ownerId)).send({ months: 2 });
    expect(first.status).toBe(201);
    expect(latest.status).toBe(201);
    expect((await request(app).post(renewalUrl).set(as(ownerId)).send({ months: 13 })).status).toBe(400);

    const latestUrl = `${renewalUrl}/${latest.body.id}`;
    expect((await request(app).delete(latestUrl).set(as(coachId))).status).toBe(403);
    const earlierUndo = await request(app).delete(`${renewalUrl}/${first.body.id}`).set(as(ownerId));
    expect(earlierUndo.status).toBe(409);
    expect(earlierUndo.body.error).toBe("Only the latest renewal can be undone");
    expect((await request(app).delete(`${financeUrl(academyBId)}/players/${player.body.id}/renewals/${latest.body.id}`).set(as(ownerId))).status).toBe(404);
    expect((await request(app).delete(latestUrl).set(as(ownerId))).status).toBe(204);
    const teamPlayers = await request(app).get(`${financeUrl(academyAId)}/teams/${team.body.id}/players`).set(as(ownerId));
    expect(teamPlayers.body[0]).toMatchObject({
      id: player.body.id,
      subscriptionExpiresOn: first.body.newExpiresOn,
      latestRenewalId: first.body.id,
      latestRenewalAmountFils: first.body.amountFils,
    });
    expect(teamPlayers.body[0].latestRenewalPaidAt).toBeTruthy();
    expect((await request(app).delete(latestUrl).set(as(ownerId))).status).toBe(404);
  });
});
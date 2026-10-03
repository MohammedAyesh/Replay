import { and, asc, count, eq, gte, inArray, like, lt, or } from "drizzle-orm";
import {
  academyAnnouncementsTable,
  academyAttendanceTable,
  academyFeesTable,
  academyFinanceStaffTable,
  academyMembersTable,
  academyOtherPaymentsTable,
  academyPaymentCategoriesTable,
  academyPlayerRenewalsTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  db,
  pool,
} from "@workspace/db";
import { addMonthsToDate, getAmmanDate, getAmmanMonthRange } from "../lib/academyFinanceMath";

const PREFIX = "Demo ";

type IdByName = Map<string, number>;

function academyIdFromArgs(): number {
  const value = process.argv[2];
  const id = Number(value);
  if (!value || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Usage: pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/scripts/seed-academy-demo.ts <academyId>");
  }
  return id;
}

function offsetHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

function dateOffset(from: string, days: number): string {
  const [year, month, day] = from.split("-").map(Number);
  return new Date(Date.UTC(
    year,
    month - 1,
    day + days,
  )).toISOString().slice(0, 10);
}

function ammanTime(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Amman",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatJod(fils: number): string {
  return `${(fils / 1000).toFixed(3).replace(/\.?0+$/, "")} JOD`;
}

function mappedId(map: IdByName, name: string, kind: string): number {
  const id = map.get(name);
  if (id === undefined) throw new Error(`Missing inserted ${kind}: ${name}`);
  return id;
}

async function seed(academyId: number) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const today = getAmmanDate(now);

    // Announcements require an existing Replay user. Use an already assigned
    // academy member; this script never creates or changes users or membership.
    const [creator] = await tx
      .select({ userId: academyMembersTable.userId })
      .from(academyMembersTable)
      .where(eq(academyMembersTable.academyId, academyId))
      .orderBy(asc(academyMembersTable.createdAt), asc(academyMembersTable.id))
      .limit(1);
    if (!creator) {
      throw new Error(`Academy ${academyId} has no academy member to use as an announcement creator.`);
    }

    // Demo rows are recognized only by their Demo-prefixed fields and the
    // supplied academy id. Refuse to delete a demo parent if non-demo rows
    // reference it, since PostgreSQL could cascade or null out those records.
    const [oldSquads, oldPlayers, oldSessions, oldFees, oldAnnouncements, oldRenewals, oldStaff, oldPayments, oldCategories] = await Promise.all([
      tx.select({ id: academySquadsTable.id })
        .from(academySquadsTable)
        .where(and(eq(academySquadsTable.academyId, academyId), like(academySquadsTable.name, "Demo %"))),
      tx.select({ id: academyPlayersTable.id })
        .from(academyPlayersTable)
        .where(and(eq(academyPlayersTable.academyId, academyId), like(academyPlayersTable.name, "Demo %"))),
      tx.select({ id: academySessionsTable.id })
        .from(academySessionsTable)
        .where(and(eq(academySessionsTable.academyId, academyId), like(academySessionsTable.notes, "Demo %"))),
      tx.select({ id: academyFeesTable.id })
        .from(academyFeesTable)
        .where(and(eq(academyFeesTable.academyId, academyId), like(academyFeesTable.label, "Demo %"))),
      tx.select({ id: academyAnnouncementsTable.id })
        .from(academyAnnouncementsTable)
        .where(and(eq(academyAnnouncementsTable.academyId, academyId), like(academyAnnouncementsTable.title, "Demo %"))),
      tx.select({ id: academyPlayerRenewalsTable.id })
        .from(academyPlayerRenewalsTable)
        .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyPlayerRenewalsTable.playerId))
        .where(and(
          eq(academyPlayerRenewalsTable.academyId, academyId),
          eq(academyPlayersTable.academyId, academyId),
          like(academyPlayersTable.name, "Demo %"),
        )),
      tx.select({ id: academyFinanceStaffTable.id })
        .from(academyFinanceStaffTable)
        .where(and(
          eq(academyFinanceStaffTable.academyId, academyId),
          like(academyFinanceStaffTable.name, "Demo %"),
        )),
      tx.select({ id: academyOtherPaymentsTable.id })
        .from(academyOtherPaymentsTable)
        .where(and(
          eq(academyOtherPaymentsTable.academyId, academyId),
          like(academyOtherPaymentsTable.label, "Demo %"),
        )),
      tx.select({
        id: academyPaymentCategoriesTable.id,
        name: academyPaymentCategoriesTable.name,
      })
        .from(academyPaymentCategoriesTable)
        .where(and(
          eq(academyPaymentCategoriesTable.academyId, academyId),
          like(academyPaymentCategoriesTable.name, "Demo %"),
        )),
    ]);
    const squadIds = oldSquads.map((row) => row.id);
    const playerIds = oldPlayers.map((row) => row.id);
    const sessionIds = oldSessions.map((row) => row.id);
    const feeIds = oldFees.map((row) => row.id);
    const announcementIds = oldAnnouncements.map((row) => row.id);
    const renewalIds = oldRenewals.map((row) => row.id);
    const staffIds = oldStaff.map((row) => row.id);
    const paymentIds = oldPayments.map((row) => row.id);
    const squadIdSet = new Set(squadIds);
    const playerIdSet = new Set(playerIds);
    const sessionIdSet = new Set(sessionIds);
    const feeIdSet = new Set(feeIds);
    const announcementIdSet = new Set(announcementIds);
    const paymentIdSet = new Set(paymentIds);

    if (staffIds.length > 0) {
      const referencedPayments = await tx.select({ id: academyOtherPaymentsTable.id })
        .from(academyOtherPaymentsTable)
        .where(and(
          eq(academyOtherPaymentsTable.academyId, academyId),
          inArray(academyOtherPaymentsTable.staffId, staffIds),
        ));
      if (referencedPayments.some((row) => !paymentIdSet.has(row.id))) {
        throw new Error("Refusing to delete a Demo staff member referenced by a non-demo payment.");
      }
    }
    if (oldCategories.length > 0) {
      const paymentsUsingDemoCategories = await tx.select({
        id: academyOtherPaymentsTable.id,
      }).from(academyOtherPaymentsTable).where(and(
        eq(academyOtherPaymentsTable.academyId, academyId),
        inArray(academyOtherPaymentsTable.category, oldCategories.map((row) => row.name)),
      ));
      if (paymentsUsingDemoCategories.some((row) => !paymentIdSet.has(row.id))) {
        throw new Error("Refusing to delete a Demo category used by a non-demo payment.");
      }
    }

    if (squadIds.length > 0) {
      const [players, sessions, announcements] = await Promise.all([
        tx.select({ id: academyPlayersTable.id }).from(academyPlayersTable)
          .where(inArray(academyPlayersTable.squadId, squadIds)),
        tx.select({ id: academySessionsTable.id }).from(academySessionsTable)
          .where(inArray(academySessionsTable.squadId, squadIds)),
        tx.select({ id: academyAnnouncementsTable.id }).from(academyAnnouncementsTable)
          .where(inArray(academyAnnouncementsTable.squadId, squadIds)),
      ]);
      if (players.some((row) => !playerIdSet.has(row.id))) {
        throw new Error("Refusing to delete a Demo squad referenced by a non-demo player.");
      }
      if (sessions.some((row) => !sessionIdSet.has(row.id))) {
        throw new Error("Refusing to delete a Demo squad referenced by a non-demo session.");
      }
      if (announcements.some((row) => !announcementIdSet.has(row.id))) {
        throw new Error("Refusing to delete a Demo squad referenced by a non-demo announcement.");
      }
    }

    if (playerIds.length > 0) {
      const fees = await tx.select({ id: academyFeesTable.id }).from(academyFeesTable)
        .where(inArray(academyFeesTable.playerId, playerIds));
      if (fees.some((row) => !feeIdSet.has(row.id))) {
        throw new Error("Refusing to delete a Demo player referenced by a non-demo fee.");
      }
    }

    const attendanceConditions = [];
    if (sessionIds.length > 0) attendanceConditions.push(inArray(academyAttendanceTable.sessionId, sessionIds));
    if (playerIds.length > 0) attendanceConditions.push(inArray(academyAttendanceTable.playerId, playerIds));
    let oldAttendanceCount = 0;
    if (attendanceConditions.length > 0) {
      const attendance = await tx.select({
        sessionId: academyAttendanceTable.sessionId,
        playerId: academyAttendanceTable.playerId,
      }).from(academyAttendanceTable).where(or(...attendanceConditions));
      oldAttendanceCount = attendance.length;
      if (attendance.some((row) =>
        !sessionIdSet.has(row.sessionId) || !playerIdSet.has(row.playerId))) {
        throw new Error("Refusing to refresh Demo rows with attendance linked to a non-demo session or player.");
      }
    }

    if (sessionIds.length > 0 && playerIds.length > 0) {
      await tx.delete(academyAttendanceTable).where(and(
        inArray(academyAttendanceTable.sessionId, sessionIds),
        inArray(academyAttendanceTable.playerId, playerIds),
      ));
    }
    if (feeIds.length > 0) await tx.delete(academyFeesTable).where(inArray(academyFeesTable.id, feeIds));
    if (announcementIds.length > 0) {
      await tx.delete(academyAnnouncementsTable).where(inArray(academyAnnouncementsTable.id, announcementIds));
    }
    if (paymentIds.length > 0) {
      await tx.delete(academyOtherPaymentsTable).where(inArray(academyOtherPaymentsTable.id, paymentIds));
    }
    if (renewalIds.length > 0) {
      await tx.delete(academyPlayerRenewalsTable).where(inArray(academyPlayerRenewalsTable.id, renewalIds));
    }
    if (oldCategories.length > 0) {
      await tx.delete(academyPaymentCategoriesTable)
        .where(inArray(academyPaymentCategoriesTable.id, oldCategories.map((row) => row.id)));
    }
    if (staffIds.length > 0) {
      await tx.delete(academyFinanceStaffTable).where(inArray(academyFinanceStaffTable.id, staffIds));
    }
    if (sessionIds.length > 0) await tx.delete(academySessionsTable).where(inArray(academySessionsTable.id, sessionIds));
    if (playerIds.length > 0) await tx.delete(academyPlayersTable).where(inArray(academyPlayersTable.id, playerIds));
    if (squadIds.length > 0) await tx.delete(academySquadsTable).where(inArray(academySquadsTable.id, squadIds));

    const squadRows: Array<typeof academySquadsTable.$inferInsert> = [
      { academyId, name: "Demo U12", description: "Demo under-12 development squad.", ageGroup: "U12", monthlyFeeFils: 25000 },
      { academyId, name: "Demo U15", description: "Demo under-15 development squad.", ageGroup: "U15", monthlyFeeFils: 30000 },
      { academyId, name: "Demo First Team", description: "Demo senior training squad.", ageGroup: "First Team", monthlyFeeFils: 40000 },
    ];
    const squads = await tx.insert(academySquadsTable).values(squadRows)
      .returning({ id: academySquadsTable.id, name: academySquadsTable.name });
    const squadIdsByName: IdByName = new Map(squads.map((row) => [row.name, row.id]));

    const playerRows: Array<typeof academyPlayersTable.$inferInsert> = [
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), name: "Demo Zayd Al-Khatib", jerseyNumber: 1, position: "Goalkeeper", dateOfBirth: "2014-03-12", guardianPhone: "+962 79 555 0101", subscriptionExpiresOn: dateOffset(today, 45), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), name: "Demo Lina Al-Hassan", jerseyNumber: 7, position: "Midfielder", dateOfBirth: "2014-08-24", guardianPhone: "+962 79 555 0102", monthlyDiscountFils: 5000, subscriptionExpiresOn: dateOffset(today, 3), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), name: "Demo Omar Al-Majali", jerseyNumber: 11, position: "Forward", subscriptionExpiresOn: dateOffset(today, -65), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), name: "Demo يزن الخطيب", jerseyNumber: 4, position: "Defender", guardianPhone: "+962 79 555 0103", subscriptionExpiresOn: dateOffset(today, 9), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), name: "Demo ليان الحسن", position: "Midfielder", subscriptionExpiresOn: dateOffset(today, 3), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), name: "Demo Adam Haddad", jerseyNumber: 1, position: "Goalkeeper", dateOfBirth: "2011-01-18", subscriptionExpiresOn: dateOffset(today, 45), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), name: "Demo Tala Nasser", jerseyNumber: 3, position: "Defender", guardianPhone: "+962 79 555 0104", subscriptionExpiresOn: dateOffset(today, -10), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), name: "Demo مالك العبدالله", jerseyNumber: 8, position: "Midfielder", subscriptionExpiresOn: dateOffset(today, 10), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), name: "Demo نور أبو زيد", jerseyNumber: 10, position: "Forward", guardianPhone: "+962 79 555 0105", subscriptionExpiresOn: dateOffset(today, 70), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), name: "Demo Kareem Saleh", position: "Midfielder", subscriptionExpiresOn: dateOffset(today, 60), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo First Team", "squad"), name: "Demo Ali Mahfouz", jerseyNumber: 1, position: "Goalkeeper", monthlyDiscountFils: 10000, subscriptionExpiresOn: dateOffset(today, 30), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo First Team", "squad"), name: "Demo Rami Qasem", jerseyNumber: 5, position: "Defender", guardianPhone: "+962 79 555 0106", subscriptionExpiresOn: dateOffset(today, 27), isActive: true },
      { academyId, squadId: mappedId(squadIdsByName, "Demo First Team", "squad"), name: "Demo هبة خليل", jerseyNumber: 6, position: "Midfielder", subscriptionExpiresOn: dateOffset(today, -20), isActive: false },
      { academyId, squadId: mappedId(squadIdsByName, "Demo First Team", "squad"), name: "Demo جود الرواشدة", jerseyNumber: 9, position: "Forward", isActive: false },
      { academyId, name: "Demo فارس الشامي", position: "Defender", guardianPhone: "+962 79 555 0107", isActive: true },
      { academyId, name: "Demo Mariam Daher", position: "Midfielder", isActive: true },
    ];
    const players = await tx.insert(academyPlayersTable).values(playerRows)
      .returning({ id: academyPlayersTable.id, name: academyPlayersTable.name });
    const playerIdsByName: IdByName = new Map(players.map((row) => [row.name, row.id]));

    const pastMatchNotes = "Demo seed: past match with manual 2-1 result";
    const pastTrainingNotes = "Demo seed: past training attendance sample";
    const twoHourTrainingNotes = "Demo seed: upcoming training in about two hours";
    const threeDayMatchNotes = "Demo seed: upcoming match in three days";
    const sixDayTrainingNotes = "Demo seed: upcoming training in six days";
    const eightDayMatchNotes = "Demo seed: match exactly eight days out";
    const sessionRows: Array<typeof academySessionsTable.$inferInsert> = [
      { academyId, squadId: mappedId(squadIdsByName, "Demo First Team", "squad"), type: "match", startsAt: offsetHours(now, -72), endsAt: offsetHours(now, -70.5), location: "Demo Main Pitch", opponent: "Demo Al-Wehdat Juniors", ownScore: 2, opponentScore: 1, notes: pastMatchNotes },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), type: "training", startsAt: offsetHours(now, -24), endsAt: offsetHours(now, -22.5), location: "Demo Academy Training Ground", notes: pastTrainingNotes },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U12", "squad"), type: "training", startsAt: offsetHours(now, 2), endsAt: offsetHours(now, 3.5), location: "Demo Academy Training Ground", notes: twoHourTrainingNotes },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), type: "match", startsAt: offsetHours(now, 72), endsAt: offsetHours(now, 73.5), location: "Demo Main Pitch", opponent: "Demo Al-Faisaly Academy", notes: threeDayMatchNotes },
      { academyId, squadId: mappedId(squadIdsByName, "Demo First Team", "squad"), type: "training", startsAt: offsetHours(now, 144), endsAt: offsetHours(now, 145.5), location: "Demo Academy Training Ground", notes: sixDayTrainingNotes },
      { academyId, squadId: mappedId(squadIdsByName, "Demo U15", "squad"), type: "match", startsAt: offsetHours(now, 8 * 24), endsAt: offsetHours(now, 8 * 24 + 1.5), location: "Demo Main Pitch", opponent: "Demo Amman United", notes: eightDayMatchNotes },
    ];
    const sessions = await tx.insert(academySessionsTable).values(sessionRows).returning({
      id: academySessionsTable.id,
      notes: academySessionsTable.notes,
      startsAt: academySessionsTable.startsAt,
    });
    const sessionIdsByNotes: IdByName = new Map(sessions.map((row) => [row.notes ?? "", row.id]));

    const attendance: Array<typeof academyAttendanceTable.$inferInsert> = [
      { sessionId: mappedId(sessionIdsByNotes, pastTrainingNotes, "session"), playerId: mappedId(playerIdsByName, "Demo Zayd Al-Khatib", "player"), status: "present" },
      { sessionId: mappedId(sessionIdsByNotes, pastTrainingNotes, "session"), playerId: mappedId(playerIdsByName, "Demo Lina Al-Hassan", "player"), status: "absent" },
      { sessionId: mappedId(sessionIdsByNotes, pastTrainingNotes, "session"), playerId: mappedId(playerIdsByName, "Demo Omar Al-Majali", "player"), status: "late" },
      { sessionId: mappedId(sessionIdsByNotes, pastTrainingNotes, "session"), playerId: mappedId(playerIdsByName, "Demo يزن الخطيب", "player"), status: "excused" },
    ];
    await tx.insert(academyAttendanceTable).values(attendance);

    const renewalExpiresOn = dateOffset(today, 30);
    const [renewal] = await tx.insert(academyPlayerRenewalsTable).values({
      academyId,
      playerId: mappedId(playerIdsByName, "Demo Ali Mahfouz", "player"),
      monthsPurchased: 1,
      amountFils: 30000,
      effectiveMonthlyFeeFils: 30000,
      previousExpiresOn: addMonthsToDate(renewalExpiresOn, -1),
      newExpiresOn: renewalExpiresOn,
      paidAt: now,
    }).returning({
      id: academyPlayerRenewalsTable.id,
      amountFils: academyPlayerRenewalsTable.amountFils,
    });

    const feeRows: Array<typeof academyFeesTable.$inferInsert> = [
      { academyId, playerId: mappedId(playerIdsByName, "Demo Zayd Al-Khatib", "player"), label: "Demo U12 monthly fee", amountFils: 25000, dueDate: dateOffset(today, 10), status: "due", note: "Demo payment awaiting collection." },
      { academyId, playerId: mappedId(playerIdsByName, "Demo Lina Al-Hassan", "player"), label: "Demo training kit fee", amountFils: 15000, dueDate: dateOffset(today, 17), status: "due", note: "Demo kit payment outstanding." },
      { academyId, playerId: mappedId(playerIdsByName, "Demo Omar Al-Majali", "player"), label: "Demo U12 training kit fee", amountFils: 5000, dueDate: dateOffset(today, -5), status: "due", note: "Demo one-off kit fee awaiting collection." },
      { academyId, playerId: mappedId(playerIdsByName, "Demo Adam Haddad", "player"), label: "Demo U15 monthly fee", amountFils: 30000, dueDate: dateOffset(today, -5), status: "paid", paidAt: now, note: "Demo fee paid at the academy office." },
      { academyId, playerId: mappedId(playerIdsByName, "Demo Ali Mahfouz", "player"), label: "Demo first-team registration", amountFils: 20000, dueDate: dateOffset(today, 5), status: "waived", note: "Demo fee waived for this sample." },
    ];
    await tx.insert(academyFeesTable).values(feeRows);

    const staffRows: Array<typeof academyFinanceStaffTable.$inferInsert> = [
      {
        academyId,
        name: "Demo Hamza",
        role: "Coach",
        monthlySalaryFils: 200000,
        nextSalaryDate: today,
        contractEndDate: dateOffset(today, 240),
      },
      {
        academyId,
        name: "Demo Sara Haddad",
        role: "Admin",
        monthlySalaryFils: 150000,
        nextSalaryDate: dateOffset(today, 17),
        contractEndDate: dateOffset(today, 20),
      },
    ];
    const staff = await tx.insert(academyFinanceStaffTable).values(staffRows)
      .returning({ id: academyFinanceStaffTable.id, name: academyFinanceStaffTable.name });
    const staffIdsByName: IdByName = new Map(staff.map((row) => [row.name, row.id]));
    const [demoCategory] = await tx.insert(academyPaymentCategoriesTable).values({
      academyId,
      name: "Demo Match Officials",
    }).returning({ id: academyPaymentCategoriesTable.id, name: academyPaymentCategoriesTable.name });

    const otherPaymentRows: Array<typeof academyOtherPaymentsTable.$inferInsert> = [
      {
        academyId,
        category: "Rent",
        label: "Demo Field rent — October",
        amountFils: 120000,
        occurredOn: today,
        status: "paid",
        paidAt: now,
      },
      {
        academyId,
        category: demoCategory.name,
        label: "Demo Match official fees",
        amountFils: 60000,
        occurredOn: today,
        status: "unpaid",
      },
    ];
    const otherPayments = await tx.insert(academyOtherPaymentsTable).values(otherPaymentRows)
      .returning({ id: academyOtherPaymentsTable.id, label: academyOtherPaymentsTable.label });

    const announcements: Array<typeof academyAnnouncementsTable.$inferInsert> = [
      {
        academyId,
        squadId: null,
        title: "Demo Academy Update",
        body: "Demo reminder: the academy office opens at 16:00. تذكير تجريبي: يفتح مكتب الأكاديمية الساعة الرابعة مساءً.",
        createdBy: creator.userId,
      },
      {
        academyId,
        squadId: mappedId(squadIdsByName, "Demo U15", "squad"),
        title: "Demo تنبيه فريق تحت 15 سنة",
        body: "Demo U15 squad: bring your blue training kit. فريق تحت 15 سنة: يرجى إحضار زي التدريب الأزرق.",
        createdBy: creator.userId,
      },
    ];
    await tx.insert(academyAnnouncementsTable).values(announcements);

    return {
      seededAt: now,
      replaced: {
        squads: oldSquads.length,
        players: oldPlayers.length,
        sessions: oldSessions.length,
        attendance: oldAttendanceCount,
        fees: oldFees.length,
        announcements: oldAnnouncements.length,
        renewals: oldRenewals.length,
        staff: oldStaff.length,
        otherPayments: oldPayments.length,
        categories: oldCategories.length,
      },
      squads,
      players,
      sessions,
      attendance,
      renewal,
      fees: feeRows,
      staff,
      otherPayments,
      categories: [demoCategory],
      announcements,
    };
  });
}

async function main(): Promise<void> {
  try {
    const academyId = academyIdFromArgs();
    const inserted = await seed(academyId);
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const financeMonth = getAmmanMonthRange(inserted.seededAt);
    const [squads, activePlayers, upcomingSessions, paidFees, paidRenewals, paidPayments, unpaidPayments] = await Promise.all([
      db.select({ value: count() }).from(academySquadsTable)
        .where(eq(academySquadsTable.academyId, academyId)),
      db.select({ value: count() }).from(academyPlayersTable)
        .where(and(eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.isActive, true))),
      db.select({ value: count() }).from(academySessionsTable)
        .where(and(
          eq(academySessionsTable.academyId, academyId),
          gte(academySessionsTable.startsAt, windowStart),
          lt(academySessionsTable.startsAt, windowEnd),
        )),
      db.select({ amountFils: academyFeesTable.amountFils }).from(academyFeesTable)
        .where(and(
          eq(academyFeesTable.academyId, academyId),
          eq(academyFeesTable.status, "paid"),
          gte(academyFeesTable.paidAt, financeMonth.startAt),
          lt(academyFeesTable.paidAt, financeMonth.endAt),
        )),
      db.select({ amountFils: academyPlayerRenewalsTable.amountFils }).from(academyPlayerRenewalsTable)
        .where(and(
          eq(academyPlayerRenewalsTable.academyId, academyId),
          gte(academyPlayerRenewalsTable.paidAt, financeMonth.startAt),
          lt(academyPlayerRenewalsTable.paidAt, financeMonth.endAt),
        )),
      db.select({ amountFils: academyOtherPaymentsTable.amountFils }).from(academyOtherPaymentsTable)
        .where(and(
          eq(academyOtherPaymentsTable.academyId, academyId),
          eq(academyOtherPaymentsTable.status, "paid"),
          gte(academyOtherPaymentsTable.paidAt, financeMonth.startAt),
          lt(academyOtherPaymentsTable.paidAt, financeMonth.endAt),
        )),
      db.select({ id: academyOtherPaymentsTable.id }).from(academyOtherPaymentsTable)
        .where(and(
          eq(academyOtherPaymentsTable.academyId, academyId),
          eq(academyOtherPaymentsTable.status, "unpaid"),
          gte(academyOtherPaymentsTable.occurredOn, financeMonth.startDate),
          lt(academyOtherPaymentsTable.occurredOn, financeMonth.endDate),
        )),
    ]);
    const collectedFils = paidFees.reduce((total, row) => total + row.amountFils, 0)
      + paidRenewals.reduce((total, row) => total + row.amountFils, 0);
    const spentFils = paidPayments.reduce((total, row) => total + row.amountFils, 0);

    console.log(`Refreshed Academy Console demo data for academy ${academyId}.`);
    console.log("Deleted only previously marked Demo rows:", JSON.stringify(inserted.replaced));
    console.log("\nInserted squads:");
    for (const squad of inserted.squads) console.log(`- ${squad.name}`);
    console.log(`\nInserted players (${inserted.players.length}; 14 active, 2 inactive; 2 without squads):`);
    for (const player of inserted.players) console.log(`- ${player.name}`);
    console.log(`\nInserted sessions (${inserted.sessions.length}; UTC instants, shown in UTC and Amman time):`);
    for (const session of inserted.sessions) {
      const startsAt = new Date(session.startsAt);
      console.log(`- ${session.notes}: ${startsAt.toISOString()} UTC (${ammanTime(startsAt)} Asia/Amman)`);
    }
    console.log(`\nInserted attendance: ${inserted.attendance.length} records (1 present, 1 absent, 1 late, 1 excused).`);
    console.log(`Inserted subscription renewal: ${inserted.renewal.id} (${inserted.renewal.amountFils.toLocaleString("en-US")} fils).`);
    console.log("\nInserted fees (amounts in fils / JOD):");
    for (const fee of inserted.fees) {
      console.log(`- ${fee.label}: ${fee.amountFils.toLocaleString("en-US")} fils (${(fee.amountFils / 1000).toFixed(3)} JOD), ${fee.status}`);
    }
    console.log("\nInserted finance staff:");
    for (const person of inserted.staff) console.log(`- ${person.name}`);
    console.log(`Inserted custom payment category: ${inserted.categories[0]?.name}`);
    console.log("\nInserted other payments:");
    for (const payment of inserted.otherPayments) console.log(`- ${payment.label}`);
    console.log("\nInserted announcements:");
    for (const announcement of inserted.announcements) {
      console.log(`- ${announcement.title}: ${announcement.squadId === null ? "academy-wide" : "squad-scoped"}`);
    }
    console.log("\nExpected /academy dashboard totals for all data in this academy:");
    console.log(`- Squads: ${Number(squads[0]?.value ?? 0)}`);
    console.log(`- Active players: ${Number(activePlayers[0]?.value ?? 0)}`);
    console.log(`- Upcoming sessions within 7 days: ${Number(upcomingSessions[0]?.value ?? 0)}`);
    console.log(`- Window: ${windowStart.toISOString()} inclusive through ${windowEnd.toISOString()} exclusive.`);
    console.log("Demo-only contribution: 3 squads, 14 active players, and 3 upcoming sessions.");
    console.log(`\nExpected Fees & Payments dashboard tiles after seed (${financeMonth.month}, Asia/Amman; includes preserved academy data):`);
    console.log(`- Collected this month: ${formatJod(collectedFils)}`);
    console.log(`- Spent this month: ${formatJod(spentFils)}`);
    console.log(`- Net: ${formatJod(collectedFils - spentFils)}`);
    console.log(`- Unpaid bills: ${unpaidPayments.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Could not seed Academy Console demo data:", error);
  process.exitCode = 1;
});
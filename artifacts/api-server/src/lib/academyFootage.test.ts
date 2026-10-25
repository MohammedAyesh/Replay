import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  academySessionsTable, academiesTable, db, fieldsTable, footageRequestsTable, usersTable,
} from "@workspace/db";

const { controlFetchMock } = vi.hoisted(() => ({ controlFetchMock: vi.fn() }));
vi.mock("../routes/contabo", () => ({ controlFetch: controlFetchMock }));

import {
  ACADEMY_FOOTAGE_CONFLICT_STATUSES,
  academyBookingFitsSession,
  academyFootageWindow,
  academySessionIsAtField,
  academySessionPullWindow,
  bookAcademySessionFootage,
  cancelScheduledAcademyFootageForSession,
} from "./academyFootage";

describe("academyFootageWindow", () => {
  it("converts UTC session times to Amman and rounds outward to five minutes", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T13:37:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 15:00",
      endLocal: "2026-10-08 16:40",
      requestedSeconds: 100 * 60,
      note: null,
    });
  });

  it("enforces the 15-minute minimum after rounding", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T12:04:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 15:00",
      endLocal: "2026-10-08 15:15",
      requestedSeconds: 15 * 60,
      note: null,
    });
  });

  it("caps sessions longer than four hours and reports the cap", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T18:03:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 15:00",
      endLocal: "2026-10-08 19:00",
      requestedSeconds: 4 * 60 * 60,
      note: "Recording limited to the first 4 hours.",
    });
  });

  it("rounds across midnight in Amman local time", () => {
    expect(academyFootageWindow(
      new Date("2026-10-08T20:58:00.000Z"),
      new Date("2026-10-08T21:06:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 23:55",
      endLocal: "2026-10-09 00:10",
      requestedSeconds: 15 * 60,
      note: null,
    });
  });
});

describe("academy session footage rules", () => {
  it("treats awaiting-payment requests as camera conflicts", () => {
    expect(ACADEMY_FOOTAGE_CONFLICT_STATUSES).toContain("awaiting_payment");
  });

  it("bounds pulls to the session with exactly 15 minutes of padding", () => {
    expect(academySessionPullWindow(
      new Date("2026-10-08T12:03:00.000Z"),
      new Date("2026-10-08T13:37:00.000Z"),
    )).toEqual({
      startLocal: "2026-10-08 14:48",
      endLocal: "2026-10-08 16:52",
      requestedSeconds: 7440,
      note: null,
    });
  });

  it("allows camera pulls only when the scheduled location is the academy field", () => {
    expect(academySessionIsAtField("  Home Ground ", "home ground")).toBe(true);
    expect(academySessionIsAtField("Away Stadium", "Home Ground")).toBe(false);
  });

  it("accepts only booking windows contained within the session padding", () => {
    const startsAt = new Date("2026-10-08T12:00:00.000Z");
    const endsAt = new Date("2026-10-08T13:00:00.000Z");
    expect(academyBookingFitsSession("2026-10-08 14:45", "2026-10-08 16:15", startsAt, endsAt)).toBe(true);
    expect(academyBookingFitsSession("2026-10-08 14:44", "2026-10-08 16:15", startsAt, endsAt)).toBe(false);
  });

  it("cancels the VPS job linked to a deleted session", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const [user] = await db.insert(usersTable).values({
      name: `Footage test ${suffix}`,
      email: `footage_${suffix}@test.local`,
    }).returning({ id: usersTable.id });
    const [field] = await db.insert(fieldsTable).values({
      name: `Footage field ${suffix}`,
      cameraId: "camera1",
    }).returning({ id: fieldsTable.id, name: fieldsTable.name });
    const [academy] = await db.insert(academiesTable).values({
      name: `Footage academy ${suffix}`,
      fieldId: field.id,
    }).returning({ id: academiesTable.id });
    const [session] = await db.insert(academySessionsTable).values({
      academyId: academy.id,
      type: "training",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 60 * 60_000),
      location: field.name,
    }).returning({ id: academySessionsTable.id });
    const [footage] = await db.insert(footageRequestsTable).values({
      fieldId: field.id,
      academyId: academy.id,
      cameraId: "camera1",
      requestedBy: user.id,
      startLocal: "2026-10-25 20:00",
      endLocal: "2026-10-25 21:00",
      requestedSeconds: 3600,
      rateFils: 0,
      status: "scheduled",
      vpsJobId: "academy-session-job",
    }).returning({ id: footageRequestsTable.id });
    await db.update(academySessionsTable)
      .set({ footageRequestId: footage.id })
      .where(eq(academySessionsTable.id, session.id));
    controlFetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    try {
      await cancelScheduledAcademyFootageForSession(academy.id, session.id);
      expect(controlFetchMock).toHaveBeenCalledWith(
        "/record-hq/camera1/academy-session-job",
        { method: "DELETE" },
        30_000,
      );
      const [cancelled] = await db.select({ status: footageRequestsTable.status })
        .from(footageRequestsTable).where(eq(footageRequestsTable.id, footage.id));
      expect(cancelled.status).toBe("cancelled");
    } finally {
      await db.delete(academySessionsTable).where(eq(academySessionsTable.id, session.id));
      await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, footage.id));
      await db.delete(academiesTable).where(eq(academiesTable.id, academy.id));
      await db.delete(fieldsTable).where(eq(fieldsTable.id, field.id));
      await db.delete(usersTable).where(eq(usersTable.id, user.id));
    }
  });

  it("refuses a free session pull when it overlaps an awaiting-payment booking", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const [user] = await db.insert(usersTable).values({
      name: `Conflict test ${suffix}`,
      email: `conflict_${suffix}@test.local`,
    }).returning({ id: usersTable.id });
    const [field] = await db.insert(fieldsTable).values({
      name: `Conflict field ${suffix}`,
      cameraId: "camera1",
    }).returning({ id: fieldsTable.id, name: fieldsTable.name });
    const [academy] = await db.insert(academiesTable).values({
      name: `Conflict academy ${suffix}`,
      fieldId: field.id,
    }).returning({ id: academiesTable.id });
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const endsAt = new Date(Date.now() + 2 * 60 * 60_000);
    const [session] = await db.insert(academySessionsTable).values({
      academyId: academy.id,
      type: "training",
      startsAt,
      endsAt,
      location: field.name,
    }).returning({ id: academySessionsTable.id });
    const local = (date: Date) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Amman",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date).map(({ type, value }) => [type, value]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    };
    const [booking] = await db.insert(footageRequestsTable).values({
      fieldId: field.id,
      cameraId: "camera1",
      requestedBy: user.id,
      startLocal: local(new Date(startsAt.getTime() + 5 * 60_000)),
      endLocal: local(new Date(startsAt.getTime() + 20 * 60_000)),
      requestedSeconds: 15 * 60,
      status: "awaiting_payment",
    }).returning({ id: footageRequestsTable.id });
    try {
      await bookAcademySessionFootage(academy.id, session.id, user.id);
      const [result] = await db.select({
        footageRequestId: academySessionsTable.footageRequestId,
        footageNote: academySessionsTable.footageNote,
      }).from(academySessionsTable).where(eq(academySessionsTable.id, session.id));
      expect(result.footageRequestId).toBeNull();
      expect(result.footageNote).toBe("This camera window is already booked.");
    } finally {
      await db.delete(academySessionsTable).where(eq(academySessionsTable.id, session.id));
      await db.delete(footageRequestsTable).where(eq(footageRequestsTable.id, booking.id));
      await db.delete(academiesTable).where(eq(academiesTable.id, academy.id));
      await db.delete(fieldsTable).where(eq(fieldsTable.id, field.id));
      await db.delete(usersTable).where(eq(usersTable.id, user.id));
    }
  });
});

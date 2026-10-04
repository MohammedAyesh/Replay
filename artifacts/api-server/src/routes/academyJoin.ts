import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  academyRegistrationsTable,
  academiesTable,
  academySquadsTable,
  db,
} from "@workspace/db";
import {
  GetPublicAcademyJoinParams,
  GetPublicAcademyJoinResponse,
  SubmitPublicAcademyRegistrationBody,
  SubmitPublicAcademyRegistrationParams,
  SubmitPublicAcademyRegistrationResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();
const JOIN_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

function allow(req: Request): boolean {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  const key = forwarded || req.ip || "unknown";
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(key, hits);
    return false;
  }
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) {
    for (const [address, entries] of recent) {
      if (!entries.some((at) => now - at < WINDOW_MS)) recent.delete(address);
    }
  }
  return true;
}

export function resetAcademyJoinState(): void {
  recent.clear();
}

function asciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function ammanToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function codeFromRequest(req: Request): string {
  const raw = Array.isArray(req.params.code) ? req.params.code[0] ?? "" : req.params.code ?? "";
  return raw.toUpperCase();
}

function setNoStore(res: { setHeader(name: string, value: string): unknown }): void {
  res.setHeader("Cache-Control", "no-store");
}

router.get("/join/:code", async (req, res): Promise<void> => {
  setNoStore(res);
  const params = GetPublicAcademyJoinParams.safeParse({ code: codeFromRequest(req) });
  if (!params.success) {
    res.status(404).json({ error: "Registration link not found" });
    return;
  }

  const [academy] = await db
    .select({
      id: academiesTable.id,
      name: academiesTable.name,
      logoUrl: academiesTable.logoUrl,
    })
    .from(academiesTable)
    .where(sql`upper(${academiesTable.joinCode}) = ${params.data.code}`);
  if (!academy) {
    res.status(404).json({ error: "Registration link not found" });
    return;
  }

  const squads = await db
    .select({
      id: academySquadsTable.id,
      name: academySquadsTable.name,
      ageGroup: academySquadsTable.ageGroup,
    })
    .from(academySquadsTable)
    .where(eq(academySquadsTable.academyId, academy.id))
    .orderBy(academySquadsTable.name, academySquadsTable.id);

  res.json(GetPublicAcademyJoinResponse.parse({
    academyName: academy.name,
    logoUrl: academy.logoUrl,
    squads,
  }));
});

router.post("/join/:code", async (req, res): Promise<void> => {
  setNoStore(res);
  const params = SubmitPublicAcademyRegistrationParams.safeParse({ code: codeFromRequest(req) });
  if (!params.success || !JOIN_CODE_PATTERN.test(params.data?.code ?? "")) {
    res.status(404).json({ error: "Registration link not found" });
    return;
  }

  const input = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? { ...req.body, guardianPhone: typeof req.body.guardianPhone === "string"
      ? asciiDigits(req.body.guardianPhone)
      : req.body.guardianPhone }
    : req.body;
  const parsed = SubmitPublicAcademyRegistrationBody.safeParse(input ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  if (body.dateOfBirth !== undefined && body.dateOfBirth !== null) {
    if (!isCalendarDate(body.dateOfBirth) || body.dateOfBirth > ammanToday()) {
      res.status(400).json({ error: "Date of birth must be a valid date that is not in the future" });
      return;
    }
  }
  if (!allow(req)) {
    res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // Locking the academy row serializes same-academy submissions while checking
    // for duplicates, without adding a database constraint beyond the spec.
    const [academy] = await tx
      .select({ id: academiesTable.id })
      .from(academiesTable)
      .where(sql`upper(${academiesTable.joinCode}) = ${params.data.code}`)
      .for("update");
    if (!academy) return { kind: "missing" as const };

    if (body.preferredSquadId != null) {
      const [squad] = await tx
        .select({ id: academySquadsTable.id })
        .from(academySquadsTable)
        .where(and(
          eq(academySquadsTable.id, body.preferredSquadId),
          eq(academySquadsTable.academyId, academy.id),
        ));
      if (!squad) return { kind: "foreign-squad" as const };
    }

    const pendingRows = await tx
      .select({
        playerName: academyRegistrationsTable.playerName,
        guardianPhone: academyRegistrationsTable.guardianPhone,
      })
      .from(academyRegistrationsTable)
      .where(and(
        eq(academyRegistrationsTable.academyId, academy.id),
        eq(academyRegistrationsTable.status, "pending"),
      ));
    const normalizedName = body.playerName.trim().toLocaleLowerCase();
    const normalizedPhone = digitsOnly(body.guardianPhone);
    if (pendingRows.some((row) =>
      row.playerName.trim().toLocaleLowerCase() === normalizedName
      && digitsOnly(row.guardianPhone) === normalizedPhone)) {
      return { kind: "duplicate" as const };
    }

    await tx.insert(academyRegistrationsTable).values({
      academyId: academy.id,
      playerName: body.playerName.trim(),
      dateOfBirth: body.dateOfBirth ?? null,
      guardianName: body.guardianName?.trim() || null,
      guardianPhone: body.guardianPhone.trim(),
      preferredSquadId: body.preferredSquadId ?? null,
      notes: body.notes?.trim() || null,
      locale: body.locale,
    });
    return { kind: "created" as const };
  });

  if (result.kind === "missing") {
    res.status(404).json({ error: "Registration link not found" });
    return;
  }
  if (result.kind === "foreign-squad") {
    res.status(400).json({ error: "Preferred squad is not part of this academy" });
    return;
  }
  if (result.kind === "duplicate") {
    res.status(200).json(SubmitPublicAcademyRegistrationResponse.parse({ ok: true, duplicate: true }));
    return;
  }
  res.status(201).json(SubmitPublicAcademyRegistrationResponse.parse({ ok: true }));
});

export default router;
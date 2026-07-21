import { Router, type IRouter } from "express";
import { eq, and, count } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db, academiesTable, academyRecordingsTable, fieldsTable, recordingsTable, usersTable } from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router: IRouter = Router();

async function requireAdmin(req: Parameters<typeof getLocalUserId>[0]): Promise<number | null> {
  const userId = await getLocalUserId(req);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.isAdmin) return null;
  return userId;
}

function parseDays(raw: string): string[] {
  return raw ? raw.split(",").map((d) => d.trim()).filter(Boolean) : [];
}

async function buildSummary(academy: typeof academiesTable.$inferSelect) {
  const [field] = await db.select().from(fieldsTable).where(eq(fieldsTable.id, academy.fieldId));
  const [recCount] = await db
    .select({ value: count() })
    .from(academyRecordingsTable)
    .where(eq(academyRecordingsTable.academyId, academy.id));
  return {
    id: academy.id,
    name: academy.name,
    fieldId: academy.fieldId,
    fieldName: field?.name ?? "",
    fieldLocation: field?.location ?? "",
    daysOfWeek: parseDays(academy.daysOfWeek),
    description: academy.description ?? null,
    logoUrl: academy.logoUrl ?? null,
    recordingCount: Number(recCount?.value ?? 0),
  };
}

// ── Public routes ────────────────────────────────────────────────────────────

router.get("/academies", async (_req, res): Promise<void> => {
  const academies = await db.select().from(academiesTable).orderBy(academiesTable.name);
  const summaries = await Promise.all(academies.map(buildSummary));
  res.json(summaries);
});

router.get("/academies/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [academy] = await db.select().from(academiesTable).where(eq(academiesTable.id, id));
  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }

  res.json(await buildSummary(academy));
});

router.get("/academies/:id/recordings", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const rows = await db
    .select({ recording: recordingsTable, field: fieldsTable })
    .from(academyRecordingsTable)
    .innerJoin(recordingsTable, eq(academyRecordingsTable.recordingId, recordingsTable.id))
    .innerJoin(fieldsTable, eq(recordingsTable.fieldId, fieldsTable.id))
    .where(eq(academyRecordingsTable.academyId, id))
    .orderBy(recordingsTable.date);

  res.json(rows.map(({ recording: r, field: f }) => ({
    id: r.id,
    fieldId: r.fieldId,
    court: r.court,
    date: r.date,
    timeSlot: r.timeSlot,
    duration: r.duration,
    score: r.score ?? null,
    videoUrl: r.videoUrl,
    highlightMoment: r.highlightMoment ?? null,
    fieldName: f?.name ?? null,
  })));
});

// ── Admin routes ─────────────────────────────────────────────────────────────

const CreateAcademyBody = z.object({
  name: z.string().min(1),
  fieldId: z.number().int(),
  daysOfWeek: z.array(z.string()).default([]),
  description: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
});

const UpdateAcademyBody = z.object({
  name: z.string().min(1).optional(),
  fieldId: z.number().int().optional(),
  daysOfWeek: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
});

const AddRecordingBody = z.object({
  recordingId: z.number().int(),
});

router.get("/admin/academies", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const academies = await db.select().from(academiesTable).orderBy(academiesTable.name);
  const summaries = await Promise.all(academies.map(buildSummary));
  res.json(summaries);
});

router.post("/admin/academies", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const body = CreateAcademyBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [academy] = await db
    .insert(academiesTable)
    .values({
      name: body.data.name,
      fieldId: body.data.fieldId,
      daysOfWeek: body.data.daysOfWeek.join(","),
      description: body.data.description ?? null,
      logoUrl: body.data.logoUrl ?? null,
    })
    .returning();

  res.status(201).json(await buildSummary(academy));
});

router.patch("/admin/academies/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = UpdateAcademyBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const updates: Partial<typeof academiesTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.fieldId !== undefined) updates.fieldId = body.data.fieldId;
  if (body.data.daysOfWeek !== undefined) updates.daysOfWeek = body.data.daysOfWeek.join(",");
  if (body.data.description !== undefined) updates.description = body.data.description;
  if (body.data.logoUrl !== undefined) updates.logoUrl = body.data.logoUrl;

  const [academy] = await db
    .update(academiesTable)
    .set(updates)
    .where(eq(academiesTable.id, id))
    .returning();

  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }

  res.json(await buildSummary(academy));
});

router.delete("/admin/academies/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(academiesTable).where(eq(academiesTable.id, id));
  res.status(204).send();
});

router.post("/admin/academies/:id/logo", upload.single("logo"), async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const file = req.file;
  if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }

  const base64 = file.buffer.toString("base64");
  const dataUrl = `data:${file.mimetype};base64,${base64}`;

  const [academy] = await db
    .update(academiesTable)
    .set({ logoUrl: dataUrl })
    .where(eq(academiesTable.id, id))
    .returning();

  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }

  res.json({ logoUrl: dataUrl });
});

router.post("/admin/academies/:id/recordings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = AddRecordingBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  await db
    .insert(academyRecordingsTable)
    .values({ academyId: id, recordingId: body.data.recordingId })
    .onConflictDoNothing();

  res.status(204).send();
});

router.delete("/admin/academies/:id/recordings/:recordingId", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  const recordingId = parseInt(req.params.recordingId as string, 10);
  if (isNaN(id) || isNaN(recordingId)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db
    .delete(academyRecordingsTable)
    .where(
      and(
        eq(academyRecordingsTable.academyId, id),
        eq(academyRecordingsTable.recordingId, recordingId)
      )
    );

  res.status(204).send();
});

export default router;

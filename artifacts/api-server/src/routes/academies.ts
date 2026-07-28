import { Router, type IRouter } from "express";
import { eq, and, count } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db, academiesTable, academyRecordingsTable, fieldsTable, recordingsTable, usersTable } from "@workspace/db";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { isBunnyStorageConfigured, uploadBufferToBunnyStorage, BUNNY_STORAGE_HOSTNAME, BUNNY_STORAGE_ZONE, BUNNY_STORAGE_API_KEY } from "../lib/bunny";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// Intro videos are much bigger than a logo image. Buffering the whole file in
// memory (like the rest of this app's uploads) is fine at the size this admin
// panel is meant for — a short branding clip, not a full recording — but this
// bound exists to stop an oversized upload from taking down the process.
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

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

function parseCameras(raw: string): string[] {
  return raw ? raw.split(",").map((c) => c.trim()).filter(Boolean) : [];
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
    introVideoUrl: academy.introVideoUrl ?? null,
    liveAccess: academy.liveAccess,
    cameraIds: parseCameras(academy.cameraIds),
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

const VALID_CAMERAS = ["camera1", "camera2"] as const;

const CreateAcademyBody = z.object({
  name: z.string().min(1),
  fieldId: z.number().int(),
  daysOfWeek: z.array(z.string()).default([]),
  description: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  cameraIds: z.array(z.enum(VALID_CAMERAS)).default([]),
});

const UpdateAcademyBody = z.object({
  name: z.string().min(1).optional(),
  fieldId: z.number().int().optional(),
  daysOfWeek: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  liveAccess: z.boolean().optional(),
  cameraIds: z.array(z.enum(VALID_CAMERAS)).optional(),
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
      cameraIds: body.data.cameraIds.join(","),
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
  if (body.data.liveAccess !== undefined) updates.liveAccess = body.data.liveAccess;
  if (body.data.cameraIds !== undefined) updates.cameraIds = body.data.cameraIds.join(",");

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

router.post("/admin/academies/:id/intro", uploadVideo.single("intro"), async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const file = req.file;
  if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }
  if (!file.mimetype.startsWith("video/")) {
    res.status(400).json({ error: "File must be a video" });
    return;
  }
  if (!isBunnyStorageConfigured()) {
    res.status(503).json({ error: "Export storage not configured" });
    return;
  }

  const ext = file.mimetype === "video/quicktime" ? "mov"
    : file.mimetype === "video/webm" ? "webm"
    : "mp4";
  const remotePath = `academy-intros/${id}/intro.${ext}`;

  let introVideoUrl: string;
  try {
    introVideoUrl = await uploadBufferToBunnyStorage(file.buffer, remotePath, file.mimetype);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Upload failed" });
    return;
  }

  const [academy] = await db
    .update(academiesTable)
    .set({ introVideoUrl })
    .where(eq(academiesTable.id, id))
    .returning();

  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }

  res.json({ introVideoUrl });
});

router.delete("/admin/academies/:id/intro", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) { res.status(403).json({ error: "Forbidden" }); return; }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [academy] = await db
    .update(academiesTable)
    .set({ introVideoUrl: null })
    .where(eq(academiesTable.id, id))
    .returning();

  if (!academy) { res.status(404).json({ error: "Academy not found" }); return; }

  // Best-effort: clear the stored file too. Not fatal if this fails — an
  // orphaned object in storage is harmless since introVideoUrl is already
  // cleared and nothing references it anymore.
  if (isBunnyStorageConfigured()) {
    for (const ext of ["mp4", "mov", "webm"]) {
      fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/academy-intros/${id}/intro.${ext}`, {
        method: "DELETE",
        headers: { AccessKey: BUNNY_STORAGE_API_KEY },
      }).catch(() => {});
    }
  }

  res.json({ ok: true });
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

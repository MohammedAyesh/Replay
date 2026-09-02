import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, savedClipsTable, likesTable, recordingsTable, clipsTable, usersTable, fieldsTable, claimMatchIdentityBindingsTable } from "@workspace/db";
import { GetAccountStatsResponse, UpdateProfileResponse, UpdateProfileBody, UpdateLocaleBody, UpdateLocaleResponse, UpdateConsentsBody, UpdateConsentsResponse } from "@workspace/api-zod";
import { getLocalUserId, getLocalUserRecord, unauthenticatedResponse } from "../lib/clerkUserBridge";

const router: IRouter = Router();

router.get("/account/claimed-matches", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    unauthenticatedResponse(res, req);
    return;
  }
  const rows = await db
    .select({
      binding: claimMatchIdentityBindingsTable,
      recording: recordingsTable,
      fieldName: fieldsTable.name,
    })
    .from(claimMatchIdentityBindingsTable)
    .innerJoin(recordingsTable, eq(recordingsTable.id, claimMatchIdentityBindingsTable.recordingId))
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(eq(claimMatchIdentityBindingsTable.userId, userId))
    .orderBy(desc(claimMatchIdentityBindingsTable.updatedAt));
  res.json(rows.map(({ binding, recording, fieldName }) => ({
    recordingId: recording.id,
    recordingLabel: `${fieldName ?? "Match"} · ${recording.court}`,
    fieldName: fieldName ?? "Match",
    date: recording.date,
    state: binding.state,
    personId: binding.personId,
    resolutionMethod: binding.resolutionMethod,
    supportPercent: binding.supportPercent,
    claimedAt: binding.resolvedAt?.toISOString() ?? binding.createdAt.toISOString(),
  })));
});

router.patch("/account/consents", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    unauthenticatedResponse(res, req);
    return;
  }

  let body;
  try {
    body = UpdateConsentsBody.parse(req.body);
  } catch {
    res.status(400).json({ error: "Recording consent is required" });
    return;
  }

  if (!body.recordingConsent) {
    res.status(400).json({ error: "Recording consent is required" });
    return;
  }

  const [current] = await db
    .select({
      recordingConsent: usersTable.recordingConsent,
      recordingConsentAt: usersTable.recordingConsentAt,
      socialMediaConsent: usersTable.socialMediaConsent,
      socialMediaConsentAt: usersTable.socialMediaConsentAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!current) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const now = new Date();
  const [updated] = await db
    .update(usersTable)
    .set({
      recordingConsent: true,
      recordingConsentAt: current.recordingConsentAt ?? now,
      socialMediaConsent: body.socialMediaConsent,
      socialMediaConsentAt: body.socialMediaConsent
        ? current.socialMediaConsentAt ?? now
        : null,
      consentRequired: false,
    })
    .where(eq(usersTable.id, userId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateConsentsResponse.parse({
    id: updated.id,
    name: updated.name,
    email: updated.email,
    isGuest: updated.isGuest,
    isAdmin: updated.isAdmin,
    phone: updated.phone ?? null,
    position: updated.position ?? null,
    age: updated.age ?? null,
    gender: updated.gender ?? null,
    profileComplete: updated.profileComplete,
    preferredLocale: updated.preferredLocale ?? null,
    recordingConsent: updated.recordingConsent,
    recordingConsentAt: updated.recordingConsentAt?.toISOString() ?? null,
    socialMediaConsent: updated.socialMediaConsent,
    socialMediaConsentAt: updated.socialMediaConsentAt?.toISOString() ?? null,
    consentRequired: updated.consentRequired,
  }));
});

router.patch("/account/profile", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    unauthenticatedResponse(res, req);
    return;
  }

  let body;
  try {
    body = UpdateProfileBody.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: "Invalid profile data" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ name: body.name, phone: body.phone, position: body.position, age: body.age, gender: body.gender, profileComplete: true })
    .where(eq(usersTable.id, userId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateProfileResponse.parse({
    id: updated.id,
    name: updated.name,
    email: updated.email,
    isGuest: updated.isGuest,
    phone: updated.phone ?? null,
    position: updated.position ?? null,
    age: updated.age ?? null,
    gender: updated.gender ?? null,
    profileComplete: updated.profileComplete,
    recordingConsent: updated.recordingConsent,
    recordingConsentAt: updated.recordingConsentAt?.toISOString() ?? null,
    socialMediaConsent: updated.socialMediaConsent,
    socialMediaConsentAt: updated.socialMediaConsentAt?.toISOString() ?? null,
    consentRequired: updated.consentRequired,
  }));
});

router.patch("/account/locale", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    unauthenticatedResponse(res, req);
    return;
  }

  let body;
  try {
    body = UpdateLocaleBody.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: "Invalid locale data" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ preferredLocale: body.locale })
    .where(eq(usersTable.id, userId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateLocaleResponse.parse({
    id: updated.id,
    name: updated.name,
    email: updated.email,
    isGuest: updated.isGuest,
    phone: updated.phone ?? null,
    position: updated.position ?? null,
    age: updated.age ?? null,
    gender: updated.gender ?? null,
    profileComplete: updated.profileComplete,
    preferredLocale: updated.preferredLocale ?? null,
    recordingConsent: updated.recordingConsent,
    recordingConsentAt: updated.recordingConsentAt?.toISOString() ?? null,
    socialMediaConsent: updated.socialMediaConsent,
    socialMediaConsentAt: updated.socialMediaConsentAt?.toISOString() ?? null,
    consentRequired: updated.consentRequired,
  }));
});

router.get("/account/stats", async (req, res): Promise<void> => {
  const userId = await getLocalUserId(req);
  if (!userId) {
    res.json(GetAccountStatsResponse.parse({ savedClips: 0, likesGiven: 0, fieldsVisited: 0 }));
    return;
  }

  const [savedResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(savedClipsTable)
    .where(eq(savedClipsTable.userId, userId));

  const [likesResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(likesTable)
    .where(eq(likesTable.userId, userId));

  // Fields visited = distinct fields from saved clips
  const savedClips = await db.select().from(savedClipsTable).where(eq(savedClipsTable.userId, userId));
  const fieldIds = new Set<number>();
  for (const sc of savedClips) {
    const [clip] = await db.select().from(clipsTable).where(eq(clipsTable.id, sc.clipId));
    if (clip) {
      const [rec] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, clip.recordingId));
      if (rec) fieldIds.add(rec.fieldId);
    }
  }

  res.json(
    GetAccountStatsResponse.parse({
      savedClips: Number(savedResult?.count ?? 0),
      likesGiven: Number(likesResult?.count ?? 0),
      fieldsVisited: fieldIds.size,
    })
  );
});

export default router;

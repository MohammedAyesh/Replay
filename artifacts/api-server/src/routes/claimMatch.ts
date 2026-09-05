]) acceptedTrackIds.add(part.trackId);
    if (!identity) acceptedTrackIds.add(row.chosenTrackId);
  }
  const trackedSegments = segments.filter((segment) =>
    segment.tracks.some((track) => acceptedTrackIds.has(track.id)),
  ).length;
  const matchedEvents = segments
    .flatMap((segment) => segment.events)
    .filter((event) => attributedIntervals.some((interval) =>
      event.time >= interval.startSeconds && event.time <= interval.endSeconds,
    ))
    .length;
  const playerMetrics = buildPlayerMetrics(
    manifest,
    fullSegments,
    acceptedForPerson,
    coveredSeconds,
    coveragePercent,
    anchorAnswers.length,
    acceptedAnchorCount,
    trackedSegments,
    segments.length,
    matchedEvents,
    humanVouchedSeconds,
    inferredSeconds,
    offPitchSpans,
  );
  const { adminPlayerStats, ...playerStats } = playerMetrics;
  return {
    coverageSeconds: Math.round(coveredSeconds * 100) / 100,
    coveragePercent,
    offPitchSeconds,
    humanVouchedSeconds,
    inferredSeconds,
    vouchedFragments: canonicalVouchedFragments(vouchedFragments),
    answeredAnchorCount: anchorAnswers.length,
    acceptedAnchorCount,
    unresolvedMoments: Array.from(new Set(unresolvedMoments)).slice(0, 50),
    conflictMoments,
    identityResolution,
    clipsUnlocked: earnedClips.length,
    correctionCount: active.length,
    completed,
    completionReason: identityResolution === null && accepted.length > 0
        ? "identity-unresolved"
        : conflictMoments.length > 0
          ? "identity-conflicts"
        : completed ? "coverage-threshold" : "keep-confirming",
    earnedClips,
    playerStats,
    adminPlayerStats,
  };
}

function progressWithDerived(
  row: typeof claimMatchProgressTable.$inferSelect | null,
  recordingId: number,
  derived: DerivedClaimState,
  binding: ClaimIdentityBindingRow | null,
  takenFragments: Array<ClaimVouchedFragment & { ownedByCurrentUser: boolean }> = [],
) {
  const completed = shouldKeepClaimCompleted(
    Boolean(row?.completed),
    derived.conflictMoments.length === 0 && derived.completed,
    binding?.state ?? null,
  );
  const storedClipsById = new Map((row?.earnedClips ?? []).map((clip) => [clip.id, clip]));
  const earnedClips = derived.earnedClips.map((clip) => ({
    ...clip,
    ...(storedClipsById.get(clip.id)?.userClipId
      ? { userClipId: storedClipsById.get(clip.id)?.userClipId }
      : {}),
  }));
  return {
    ...toProgress(row, recordingId),
    claimedPercent: derived.coveragePercent,
    coverageSeconds: derived.coverageSeconds,
    coveragePercent: derived.coveragePercent,
    offPitchSeconds: derived.offPitchSeconds,
    humanVouchedSeconds: derived.humanVouchedSeconds,
    inferredSeconds: derived.inferredSeconds,
    vouchedFragments: derived.vouchedFragments,
    takenFragments,
    answeredAnchorCount: derived.answeredAnchorCount,
    acceptedAnchorCount: derived.acceptedAnchorCount,
    unresolvedMoments: derived.unresolvedMoments,
    conflictMoments: derived.conflictMoments,
    identityBinding: toIdentityBinding(binding),
    clipsUnlocked: earnedClips.length,
    correctionCount: derived.correctionCount,
    completed,
    earnedClips,
    completionReason: derived.identityResolution === null
      ? derived.completionReason
      : derived.conflictMoments.length > 0
        ? "identity-conflicts"
        : completed ? "coverage-threshold" : derived.completionReason,
    playerStats: derived.playerStats,
  };
}

async function getClaimCorrections(userId: number, recordingId: number) {
  return db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, recordingId),
    ))
    .orderBy(desc(claimMatchCorrectionsTable.createdAt));
}

async function getClaimOffPitchSpans(userId: number, recordingId: number) {
  return db
    .select()
    .from(claimMatchOffPitchSpansTable)
    .where(and(
      eq(claimMatchOffPitchSpansTable.userId, userId),
      eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
    ))
    .orderBy(asc(claimMatchOffPitchSpansTable.fromSeconds), asc(claimMatchOffPitchSpansTable.createdAt));
}

function toOffPitchSpan(row: typeof claimMatchOffPitchSpansTable.$inferSelect) {
  return {
    id: row.id,
    clientId: row.clientId,
    fromSeconds: row.fromSeconds,
    toSeconds: row.toSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getTakenClaimFragments(recordingId: number, userId: number) {
  const bindings = await db
    .select({
      userId: claimMatchIdentityBindingsTable.userId,
      state: claimMatchIdentityBindingsTable.state,
      vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  return bindings
    .filter((binding) =>
      ["pending", "confirmed", "disputed", "needs_resolution"].includes(binding.state)
      && (binding.vouchedFragments?.length ?? 0) > 0)
    .flatMap((binding) => canonicalVouchedFragments(binding.vouchedFragments).map((fragment) => ({
      ...fragment,
      ownedByCurrentUser: binding.userId === userId,
    })));
}

function isBindingUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "23505";
}

function fragmentIdentityId(basePersonId: string, fragments: ClaimVouchedFragment[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalVouchedFragments(fragments)))
    .digest("hex")
    .slice(0, 16);
  return `claim:${basePersonId}:${digest}`;
}

function subtractVouchedFragments(
  parts: TrackingIdentity["parts"],
  claimed: ClaimVouchedFragment[],
): TrackingIdentity["parts"] {
  const result: TrackingIdentity["parts"] = [];
  for (const part of parts) {
    let ranges: Array<{ fromFrame: number; toFrame: number }> = [{
      fromFrame: part.fromFrame,
      toFrame: part.toFrame,
    }];
    for (const fragment of claimed.filter((item) => item.trackId === part.trackId)) {
      const next: typeof ranges = [];
      for (const range of ranges) {
        if (fragment.toFrame < range.fromFrame || fragment.fromFrame > range.toFrame) {
          next.push(range);
          continue;
        }
        if (range.fromFrame < fragment.fromFrame) {
          next.push({ fromFrame: range.fromFrame, toFrame: fragment.fromFrame - 1 });
        }
        if (fragment.toFrame < range.toFrame) {
          next.push({ fromFrame: fragment.toFrame + 1, toFrame: range.toFrame });
        }
      }
      ranges = next;
    }
    result.push(...ranges.map((range) => ({ trackId: part.trackId, ...range })));
  }
  return result;
}

async function splitDisjointClaimantIdentity(
  bundle: typeof recordingTrackingBundlesTable.$inferSelect,
  owner: ClaimIdentityBindingRow,
  claimantFragments: ClaimVouchedFragment[],
): Promise<{ ownerPersonId: string; claimantPersonId: string }> {
  const ownerFragments = canonicalVouchedFragments(owner.vouchedFragments);
  const currentFragments = canonicalVouchedFragments(claimantFragments);
  const basePersonId = owner.personId;
  const ownerPersonId = fragmentIdentityId(basePersonId, ownerFragments);
  const claimantPersonId = fragmentIdentityId(basePersonId, currentFragments);
  const identities = usableIdentityMap(bundle.manifest);
  const baseIdentity = identities.find((identity) => identity.id === basePersonId);
  const allClaimed = [...ownerFragments, ...currentFragments];
  const inferredParts = subtractVouchedFragments(baseIdentity?.parts ?? [], allClaimed);
  const nextIdentities = identities.filter((identity) => identity.id !== basePersonId);
  nextIdentities.push(
    {
      id: ownerPersonId,
      name: baseIdentity?.name ?? "Claimed fragment",
      parts: ownerFragments.map((fragment) => ({
        trackId: fragment.trackId,
        fromFrame: fragment.fromFrame,
        toFrame: fragment.toFrame,
      })),
    },
    {
      id: claimantPersonId,
      name: baseIdentity?.name ?? "Claimed fragment",
      parts: currentFragments.map((fragment) => ({
        trackId: fragment.trackId,
        fromFrame: fragment.fromFrame,
        toFrame: fragment.toFrame,
      })),
    },
  );
  if (inferredParts.length > 0) {
    nextIdentities.push({
      id: `${basePersonId}:inferred`,
      name: baseIdentity?.name ?? "Inferred remainder",
      parts: inferredParts,
    });
  }
  await db
    .update(recordingTrackingBundlesTable)
    .set({
      manifest: {
        ...bundle.manifest,
        identities: nextIdentities,
      },
    })
    .where(eq(recordingTrackingBundlesTable.id, bundle.id));
  await db
    .update(claimMatchIdentityBindingsTable)
    .set({ personId: ownerPersonId, updatedAt: new Date() })
    .where(eq(claimMatchIdentityBindingsTable.id, owner.id));
  return { ownerPersonId, claimantPersonId };
}

async function identityBindingsTableExists(): Promise<boolean> {
  try {
    const result = await db.execute(sql`select to_regclass('public.claim_match_identity_bindings') as name`);
    return Boolean((result.rows[0] as { name?: string | null } | undefined)?.name);
  } catch {
    return false;
  }
}

export function completionAllowed(
  derived: DerivedClaimState,
  binding: ClaimIdentityBindingRow | null,
): boolean {
  return derived.completed
    && derived.conflictMoments.length === 0
    && binding?.state === "confirmed";
}

export function shouldKeepClaimCompleted(
  existingCompleted: boolean,
  derivedCompleted: boolean,
  bindingState: string | null,
): boolean {
  if (existingCompleted) {
    return bindingState === "confirmed" || bindingState === "pending";
  }
  return derivedCompleted && bindingState === "confirmed";
}

/**
 * Turn the current answer set into the user's one recording binding. This is
 * intentionally called on reads as well as writes: an admin transfer and a
 * bundle replacement must be reflected without waiting for another answer.
 */
export async function syncIdentityBinding(
  userId: number,
  recordingId: number,
  bundle: typeof recordingTrackingBundlesTable.$inferSelect,
  derived: DerivedClaimState,
  allowNeedsResolutionRecovery = false,
): Promise<ClaimIdentityBindingRow | null> {
  const [existing] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.userId, userId),
      eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
    ));
  if (existing?.state === "needs_resolution" && !allowNeedsResolutionRecovery) {
    return existing;
  }
  const resolution = derived.identityResolution;
  if (!resolution) {
    if (!existing || existing.state === "needs_resolution") return existing ?? null;
    const [released] = await db
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "released", updatedAt: new Date() })
      .where(eq(claimMatchIdentityBindingsTable.id, existing.id))
      .returning();
    return released ?? existing;
  }

  const vouchedFragments = canonicalVouchedFragments(
    derived.vouchedFragments.length > 0 ? derived.vouchedFragments : existing?.vouchedFragments,
  );

  const [owner] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
      eq(claimMatchIdentityBindingsTable.personId, resolution.personId),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
    ));
  let resolvedPersonId = resolution.personId;
  if (
    owner
    && owner.userId !== userId
    && vouchedFragments.length > 0
    && owner.vouchedFragments.length > 0
    && !vouchedFragmentsOverlap(owner.vouchedFragments, vouchedFragments)
  ) {
    // The database keeps one confirmed binding per (recording, person). When
    // two people vouch for disjoint pieces of an inferred row, split that row
    // into fragment identities first. The unvouched remainder is left as a
    // normal inferred row and remains regroupable.
    const split = await splitDisjointClaimantIdentity(bundle, owner, vouchedFragments);
    resolvedPersonId = split.claimantPersonId;
  }
  const state: ClaimIdentityBindingState = resolution.conflictMoments.length > 0
    ? "pending"
    : owner && owner.userId !== userId && resolvedPersonId === resolution.personId
      ? "disputed"
      : "confirmed";
  const values = {
    userId,
    recordingId,
    personId: resolvedPersonId,
    trackingBundleId: bundle.id,
    bundleFingerprint: typeof bundle.manifest.provenance?.bundleFingerprint === "string"
      ? bundle.manifest.provenance.bundleFingerprint
      : "legacy",
    // Kept only for backwards-compatible reads of old rows. It is not used
    // for protection; vouchedFragments is the lock unit.
    personParts: personPartsForResolution(bundle.manifest, resolution.personId),
    vouchedFragments,
    resolutionMethod: resolution.resolutionMethod,
    supportCount: resolution.supportCount,
    acceptedAnswerCount: resolution.acceptedAnswerCount,
    supportPercent: resolution.supportPercent,
    state,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  };
  try {
    const [saved] = await db
      .insert(claimMatchIdentityBindingsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [claimMatchIdentityBindingsTable.userId, claimMatchIdentityBindingsTable.recordingId],
        set: values,
      })
      .returning();
    return saved ?? existing ?? null;
  } catch (error) {
    // Two claimants can resolve the same person at the same time. The
    // confirmed-person partial index makes only one winner possible; the
    // loser is retained as a visible dispute instead of getting a 500.
    if (!isBindingUniqueViolation(error) || state !== "confirmed") throw error;
    const [saved] = await db
      .insert(claimMatchIdentityBindingsTable)
      .values({ ...values, state: "disputed" })
      .onConflictDoUpdate({
        target: [claimMatchIdentityBindingsTable.userId, claimMatchIdentityBindingsTable.recordingId],
        set: { ...values, state: "disputed" },
      })
      .returning();
    return saved ?? existing ?? null;
  }
}

async function markBindingsNeedsResolution(recordingId: number): Promise<void> {
  try {
    await db
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "needs_resolution", updatedAt: new Date() })
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  } catch (error) {
    // Keep bundle replacement usable while an older development database is
    // waiting for migration 0018. New claim reads still fail explicitly if
    // they require the missing binding table.
    if ((error as { code?: string })?.code !== "42P01") throw error;
    logger.warn({ recordingId }, "Claim identity binding table is not migrated yet");
  }
}

router.get("/admin/recordings/:id/player-metrics", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const row = await getRecordingBundle(recordingId);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const [corrections, fullSegments, offPitchRows] = await Promise.all([
    db
      .select()
      .from(claimMatchCorrectionsTable)
      .where(eq(claimMatchCorrectionsTable.recordingId, recordingId))
      .orderBy(desc(claimMatchCorrectionsTable.createdAt)),
    readBundleSegments(row.bundle.id),
    db
      .select()
      .from(claimMatchOffPitchSpansTable)
      .where(eq(claimMatchOffPitchSpansTable.recordingId, recordingId)),
  ]);
  const correctionsByUser = new Map<number, typeof corrections>();
  for (const correction of corrections) {
    const existing = correctionsByUser.get(correction.userId) ?? [];
    existing.push(correction);
    correctionsByUser.set(correction.userId, existing);
  }
  const userIds = [...correctionsByUser.keys()];
  const users = userIds.length
    ? await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds))
    : [];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const manifest = await manifestWithBundleFingerprint(row.bundle);
  const segments = await getClaimStateSegments(row.bundle);
  const offPitchByUser = new Map<number, OffPitchSpan[]>();
  for (const row of offPitchRows) {
    const existing = offPitchByUser.get(row.userId) ?? [];
    existing.push(row);
    offPitchByUser.set(row.userId, existing);
  }
  const players = [...correctionsByUser.entries()]
    .map(([userId, userCorrections]) => {
      const derived = deriveClaimState(
        manifest,
        segments,
        userCorrections,
        fullSegments,
        normaliseOffPitchSpans(offPitchByUser.get(userId) ?? [], manifest.duration),
      );
      const user = usersById.get(userId);
      return {
        userId,
        displayName: user?.name ?? `User ${userId}`,
        email: user?.email ?? "unknown",
        playerStats: derived.playerStats,
        ...derived.adminPlayerStats,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  res.json(GetAdminRecordingPlayerMetricsResponse.parse({
    recordingId,
    pitchModel: pitchModelSummary(manifest.pitchModel),
    players,
  }));
});

function formatMoment(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

async function disputeResponse(binding: ClaimIdentityBindingRow) {
  const [recordingRow] = await db
    .select({
      recording: recordingsTable,
      fieldName: fieldsTable.name,
    })
    .from(recordingsTable)
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(eq(recordingsTable.id, binding.recordingId));
  const [claimant] = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, binding.userId));
  const [owner] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(claimMatchIdentityBindingsTable)
    .innerJoin(usersTable, eq(usersTable.id, claimMatchIdentityBindingsTable.userId))
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, binding.recordingId),
      eq(claimMatchIdentityBindingsTable.personId, binding.personId),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
    ));
  return {
    id: binding.id,
    recordingId: binding.recordingId,
    recordingLabel: `${recordingRow?.fieldName ?? "Match"} · ${recordingRow?.recording.court ?? ""}`.trim(),
    claimantUserId: binding.userId,
    claimantName: claimant?.name ?? `User ${binding.userId}`,
    claimantEmail: claimant?.email ?? "",
    personId: binding.personId,
    resolutionMethod: binding.resolutionMethod,
    supportCount: binding.supportCount,
    acceptedAnswerCount: binding.acceptedAnswerCount,
    supportPercent: binding.supportPercent,
    state: binding.state,
    currentOwnerUserId: owner?.id ?? null,
    currentOwnerName: owner?.name ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

router.get("/admin/claim-match/disputes", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rows = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(inArray(claimMatchIdentityBindingsTable.state, ["disputed", "pending"]))
    .orderBy(desc(claimMatchIdentityBindingsTable.createdAt));
  res.json(await Promise.all(rows.map(disputeResponse)));
});

router.patch("/admin/claim-match/disputes/:id", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const disputeId = parseId(req.params.id);
  const parsed = z.object({ winnerUserId: z.number().int().positive() }).safeParse(req.body);
  if (!disputeId || !parsed.success) {
    res.status(400).json({ error: "A valid winnerUserId is required" });
    return;
  }
  const [dispute] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.id, disputeId));
  if (!dispute || dispute.state !== "disputed") {
    res.status(404).json({ error: "Dispute not found" });
    return;
  }
  const [owner] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, dispute.recordingId),
      eq(claimMatchIdentityBindingsTable.personId, dispute.personId),
      eq(claimMatchIdentityBindingsTable.state, "confirmed"),
    ));
  if (parsed.data.winnerUserId !== dispute.userId && parsed.data.winnerUserId !== owner?.userId) {
    res.status(400).json({ error: "Winner must be the claimant or current owner" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "rejected", updatedAt: new Date() })
      .where(and(
        eq(claimMatchIdentityBindingsTable.recordingId, dispute.recordingId),
        eq(claimMatchIdentityBindingsTable.personId, dispute.personId),
        eq(claimMatchIdentityBindingsTable.state, "disputed"),
      ));
    if (owner && owner.userId !== parsed.data.winnerUserId) {
      await tx
        .update(claimMatchIdentityBindingsTable)
        .set({ state: "released", updatedAt: new Date() })
        .where(eq(claimMatchIdentityBindingsTable.id, owner.id));
    }
    await tx
      .update(claimMatchIdentityBindingsTable)
      .set({ state: "confirmed", updatedAt: new Date() })
      .where(eq(claimMatchIdentityBindingsTable.id, parsed.data.winnerUserId === dispute.userId ? dispute.id : owner!.id));
  });
  const [updated] = await db
    .select()
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.id, parsed.data.winnerUserId === dispute.userId ? dispute.id : owner!.id));
  res.json(await disputeResponse(updated ?? dispute));
});

router.get("/admin/recordings/:id/claim-match/bindings", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const bindings = await db
    .select({
      binding: claimMatchIdentityBindingsTable,
      claimantName: usersTable.name,
    })
    .from(claimMatchIdentityBindingsTable)
    .innerJoin(usersTable, eq(usersTable.id, claimMatchIdentityBindingsTable.userId))
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  res.json(bindings.map(({ binding, claimantName }) => ({
    ...toIdentityBinding(binding),
    claimantName: claimantName ?? `User ${binding.userId}`,
    claimedAt: binding.createdAt.toISOString(),
  })));
});

/**
 * Explicit escape hatch for an administrator. Releasing a binding clears its
 * fragment locks, allowing the next identity-map save to regroup those source
 * frames normally. It does not delete the claimant's answers or audit row.
 */
router.post("/admin/claim-match/bindings/:id/release", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const bindingId = parseId(req.params.id);
  if (!bindingId) {
    res.status(400).json({ error: "Invalid binding id" });
    return;
  }
  const [released] = await db
    .update(claimMatchIdentityBindingsTable)
    .set({
      state: "released",
      vouchedFragments: [],
      updatedAt: new Date(),
    })
    .where(eq(claimMatchIdentityBindingsTable.id, bindingId))
    .returning();
  if (!released) {
    res.status(404).json({ error: "Identity binding not found" });
    return;
  }
  res.json(toIdentityBinding(released));
});

router.get("/recordings/:id/claim-match", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const access = await getClaimMatchBundleForRequest(req, params.data.id);
  if (access.error) {
    res.status(404).json({ error: access.error ?? "Recording not found", code: access.code ?? "recording_not_found" });
    return;
  }
  const row = access.row;
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "No tracking bundle has been uploaded for this recording", code: "tracking_bundle_missing" });
    return;
  }
  const bundle = row.bundle;
  const [progress] = await db
    .select()
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const corrections = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, params.data.id),
    ))
    .orderBy(desc(claimMatchCorrectionsTable.createdAt));
  const storedOffPitchSpans = await getClaimOffPitchSpans(userId, params.data.id);
  const manifest = await manifestWithBundleFingerprint(bundle);
  const segments = await getClaimStateSegments(bundle);
  const offPitchSpans = normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration);
  let derived = deriveClaimState(manifest, segments, corrections, undefined, offPitchSpans);
  if (corrections.some(isAcceptedClaimAnswer) || progress?.completed || derived.completed) {
    // Vouched fragments are exact detection runs, so a claim read must use
    // full boxes whenever the user has accepted an identity answer.
    derived = deriveClaimState(
      manifest,
      segments,
      corrections,
      await readBundleSegments(bundle.id),
      offPitchSpans,
    );
  }
  const binding = await syncIdentityBinding(userId, params.data.id, bundle, derived);
  const takenFragments = await getTakenClaimFragments(params.data.id, userId);
  const canAward = completionAllowed(derived, binding);
  const earnedClips = canAward
    ? await materializeClaimMoments(userId, row.recording, manifest, derived.earnedClips)
    : [];
  if (canAward && earnedClips.length !== derived.earnedClips.length) {
    derived = { ...derived, earnedClips };
  } else if (!canAward) {
    derived = { ...derived, earnedClips: [] };
  }

  res.json(GetClaimMatchResponse.parse({
    recording: toRecording(row.recording, row.fieldName ?? null),
    // Bundles uploaded before videoStartSeconds existed have no value for it.
    // Default to 0 rather than failing the response, but that default is a
    // guess and it is almost always wrong on a recording longer than the
    // tracked window.
    manifest: { ...manifestForClient(manifest), videoStartSeconds: manifest.videoStartSeconds ?? 0 },
    progress: progressWithDerived(progress ?? null, params.data.id, derived, binding, takenFragments),
    corrections: corrections.map(toCorrection),
    offPitchSpans: storedOffPitchSpans.map(toOffPitchSpan),
    offPitchSeconds: derived.offPitchSeconds,
  }));
});

router.get("/recordings/:id/claim-match/segments/:segmentIndex", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchSegmentParams.safeParse({
    id: recordingIdFromRequest(req.params.id),
    segmentIndex: Number.parseInt(Array.isArray(req.params.segmentIndex) ? req.params.segmentIndex[0] : req.params.segmentIndex, 10),
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const access = await getClaimMatchBundleForRequest(req, params.data.id);
  if (access.error) {
    res.status(404).json({ error: access.error ?? "Recording not found", code: access.code ?? "recording_not_found" });
    return;
  }
  const row = access.row;
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "No tracking bundle has been uploaded for this recording", code: "tracking_bundle_missing" });
    return;
  }
  const manifestSegment = row.bundle.manifest.segments.find((segment) => segment.index === params.data.segmentIndex);
  if (!manifestSegment) {
    res.status(404).json({ error: "Tracking segment not found" });
    return;
  }
  try {
    const compressed = await readCompressedClaimSegment(manifestSegment.objectPath);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(compressed.byteLength));
    res.status(200).send(compressed);
  } catch {
    res.status(404).json({ error: "Tracking segment not found" });
  }
});

router.patch("/recordings/:id/claim-match", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  const body = UpdateClaimMatchProgressBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getVisibleRecordingBundle(params.data.id);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const segments = await getClaimStateSegments(row.bundle);
  const corrections = await getClaimCorrections(userId, params.data.id);
  const manifest = await manifestWithBundleFingerprint(row.bundle);
  const storedOffPitchSpans = await getClaimOffPitchSpans(userId, params.data.id);
  const offPitchSpans = normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration);
  let derived = deriveClaimState(manifest, segments, corrections, undefined, offPitchSpans);
  if (corrections.some(isAcceptedClaimAnswer) || derived.completed) {
    derived = deriveClaimState(
      manifest,
      segments,
      corrections,
      await readBundleSegments(row.bundle.id),
      offPitchSpans,
    );
  }
  const binding = await syncIdentityBinding(userId, params.data.id, row.bundle, derived, true);
  const takenFragments = await getTakenClaimFragments(params.data.id, userId);
  const isCompleted = completionAllowed(derived, binding);
  const earnedClips = isCompleted
    ? await materializeClaimMoments(userId, row.recording, manifest, derived.earnedClips)
    : [];
  const nextStage = isCompleted
    ? "done"
    : body.data.stage === "done"
      ? "picker"
      : body.data.stage;
  const responseDerived = {
    ...derived,
    completed: isCompleted,
    completionReason: derived.identityResolution === null
      ? derived.completionReason
      : derived.conflictMoments.length > 0
        ? "identity-conflicts"
        : isCompleted ? "coverage-threshold" : derived.completionReason,
    earnedClips,
  };
  const [existingProgress] = await db
    .select({ completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const stickyCompleted = shouldKeepClaimCompleted(
    existingProgress?.completed ?? false,
    isCompleted,
    binding?.state ?? null,
  );
  const [saved] = await db
    .insert(claimMatchProgressTable)
    .values({
      userId,
      recordingId: params.data.id,
      currentTrackId: body.data.currentTrackId ?? null,
      stage: nextStage,
      confirmedFromSeconds: body.data.confirmedFromSeconds,
      currentPositionSeconds: body.data.currentPositionSeconds,
      claimedPercent: derived.coveragePercent,
      clipsUnlocked: earnedClips.length,
      correctionCount: derived.correctionCount,
      completed: stickyCompleted,
      earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: body.data.currentTrackId ?? null,
        confirmedFromSeconds: body.data.confirmedFromSeconds,
        currentPositionSeconds: body.data.currentPositionSeconds,
        claimedPercent: derived.coveragePercent,
         clipsUnlocked: earnedClips.length,
        correctionCount: derived.correctionCount,
         completed: sql`${claimMatchProgressTable.completed} OR ${stickyCompleted}`,
         stage: sql`CASE WHEN (${claimMatchProgressTable.completed} OR ${stickyCompleted}) THEN 'done' ELSE ${nextStage} END`,
        earnedClips,
        updatedAt: new Date(),
      },
    })
    .returning();
  const responseCompleted = completionSurvivesConcurrentProgress(saved.completed, isCompleted);
  res.json(progressWithDerived(
    saved,
    params.data.id,
    responseCompleted && !responseDerived.completed
      ? { ...responseDerived, completed: true }
      : responseDerived,
    binding,
    takenFragments,
  ));
});

router.post("/recordings/:id/claim-match/corrections", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchParams.safeParse({ id: recordingIdFromRequest(req.params.id) });
  const body = CreateClaimMatchCorrectionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getVisibleRecordingBundle(params.data.id);
  if (!row?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const segments = await getClaimStateSegments(row.bundle);
  const manifest = await manifestWithBundleFingerprint(row.bundle);
  const storedOffPitchSpans = await getClaimOffPitchSpans(userId, params.data.id);
  const offPitchSpans = normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration);
  const trackIds = knownClaimTrackIds(manifest, segments);
  const isAnchorNoAnswer = body.data.answerMethod === "anchor-no" || body.data.answerMethod === "anchor-skip";
  if (
    (isAnchorNoAnswer
      ? body.data.chosenTrackId !== EMPTY_ANCHOR_TRACK
      : !trackIds.has(body.data.chosenTrackId)) ||
    (body.data.rejectedTrackId !== undefined &&
      body.data.rejectedTrackId !== null &&
      !trackIds.has(body.data.rejectedTrackId))
  ) {
    res.status(400).json({ error: "Correction references an unknown track" });
    return;
  }

  const [existing] = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(and(
      eq(claimMatchCorrectionsTable.userId, userId),
      eq(claimMatchCorrectionsTable.recordingId, params.data.id),
      eq(claimMatchCorrectionsTable.clientId, body.data.clientId),
    ));
  if (existing) {
    res.status(200).json(toCorrection(existing));
    return;
  }

  const [created] = await db
    .insert(claimMatchCorrectionsTable)
    .values({
      userId,
      recordingId: params.data.id,
      clientId: body.data.clientId,
      momentSeconds: body.data.momentSeconds,
      rejectedTrackId: body.data.rejectedTrackId,
      chosenTrackId: body.data.chosenTrackId,
      answerMethod: body.data.answerMethod,
      questionCount: body.data.questionCount,
    })
    .returning();
  const allCorrections = await getClaimCorrections(userId, params.data.id);
  const derived = deriveClaimState(
    manifest,
    segments,
    allCorrections,
    await readBundleSegments(row.bundle.id),
    offPitchSpans,
  );
  const binding = await syncIdentityBinding(userId, params.data.id, row.bundle, derived);
  const isCompleted = completionAllowed(derived, binding);
  const [existingProgress] = await db
    .select({ completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.userId, userId),
      eq(claimMatchProgressTable.recordingId, params.data.id),
    ));
  const stickyCompleted = shouldKeepClaimCompleted(
    existingProgress?.completed ?? false,
    isCompleted,
    binding?.state ?? null,
  );
  const earnedClips = isCompleted
    ? await materializeClaimMoments(userId, row.recording, manifest, derived.earnedClips)
    : [];
  const nextStage = stickyCompleted
    ? "done"
    : body.data.answerMethod.startsWith("anchor-")
      ? "picker"
      : "following";
  await db
    .insert(claimMatchProgressTable)
    .values({
      userId,
      recordingId: params.data.id,
      currentTrackId: isAnchorNoAnswer ? null : body.data.chosenTrackId,
      stage: nextStage,
      confirmedFromSeconds: body.data.momentSeconds,
      currentPositionSeconds: body.data.momentSeconds,
      claimedPercent: derived.coveragePercent,
       clipsUnlocked: earnedClips.length,
      correctionCount: derived.correctionCount,
       completed: isCompleted,
      earnedClips,
    })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: {
        currentTrackId: isAnchorNoAnswer ? null : body.data.chosenTrackId,
        confirmedFromSeconds: body.data.momentSeconds,
        currentPositionSeconds: body.data.momentSeconds,
        claimedPercent: derived.coveragePercent,
         clipsUnlocked: earnedClips.length,
        correctionCount: derived.correctionCount,
          completed: sql`${claimMatchProgressTable.completed} OR ${stickyCompleted}`,
          stage: sql`CASE WHEN (${claimMatchProgressTable.completed} OR ${stickyCompleted}) THEN 'done' ELSE ${nextStage} END`,
        earnedClips,
        updatedAt: new Date(),
      },
    });

  res.status(201).json(toCorrection(created));
});

router.delete("/claim-match/corrections/:correctionId", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const correctionId = parseId(req.params.correctionId);
  if (!correctionId) {
    res.status(400).json({ error: "Invalid correction id" });
    return;
  }
  const [correction] = await db
    .select()
    .from(claimMatchCorrectionsTable)
    .where(eq(claimMatchCorrectionsTable.id, correctionId));
  if (!correction) {
    res.status(404).json({ error: "Correction not found" });
    return;
  }
  if (correction.userId !== userId) {
    res.status(403).json({ error: "Correction belongs to another user" });
    return;
  }
  const bundleRow = await getVisibleRecordingBundle(correction.recordingId);
  if (!bundleRow?.bundle) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  if (!correction.undone) {
    await db
      .update(claimMatchCorrectionsTable)
      .set({ undone: true, updatedAt: new Date() })
      .where(eq(claimMatchCorrectionsTable.id, correctionId));
  }
  {
    const [segments, corrections, existingProgress] = await Promise.all([
      getClaimStateSegments(bundleRow.bundle),
      getClaimCorrections(userId, correction.recordingId),
      db
        .select()
        .from(claimMatchProgressTable)
        .where(and(
          eq(claimMatchProgressTable.userId, userId),
          eq(claimMatchProgressTable.recordingId, correction.recordingId),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    const manifest = await manifestWithBundleFingerprint(bundleRow.bundle);
    const storedOffPitchSpans = await getClaimOffPitchSpans(userId, correction.recordingId);
    const derived = deriveClaimState(
      manifest,
      segments,
      corrections,
      await readBundleSegments(bundleRow.bundle.id),
      normaliseOffPitchSpans(storedOffPitchSpans, manifest.duration),
    );
    const binding = await syncIdentityBinding(userId, correction.recordingId, bundleRow.bundle, derived);
    const isCompleted = completionAllowed(derived, binding);
    const stickyCompleted = shouldKeepClaimCompleted(
      existingProgress?.completed ?? false,
      isCompleted,
      binding?.state ?? null,
    );
    const storedClipsById = new Map((existingProgress?.earnedClips ?? []).map((clip) => [clip.id, clip]));
    const earnedClips = isCompleted
      ? await materializeClaimMoments(
        userId,
        bundleRow.recording,
        manifest,
        derived.earnedClips.map((clip) => ({
          ...clip,
          ...(storedClipsById.get(clip.id)?.userClipId
            ? { userClipId: storedClipsById.get(clip.id)?.userClipId }
            : {}),
        })),
      )
      : [];
    await db
      .update(claimMatchProgressTable)
      .set({
        claimedPercent: derived.coveragePercent,
        clipsUnlocked: earnedClips.length,
        correctionCount: derived.correctionCount,
        completed: stickyCompleted,
        earnedClips,
        stage: stickyCompleted ? "done" : "picker",
        updatedAt: new Date(),
      })
      .where(and(
        eq(claimMatchProgressTable.userId, userId),
        eq(claimMatchProgressTable.recordingId, correction.recordingId),
      ));
  }
  res.json(toCorrection({ ...correction, undone: true }));
});

export function validateUploadBundle(upload: UploadBundle): string | null {
  const { manifest, segments } = upload;
  if (manifest.segmentCount !== segments.length || manifest.segments.length !== segments.length) {
    return "Manifest segment count does not match the uploaded files";
  }
  const ranges = [...manifest.segments].sort((a, b) => a.index - b.index);
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const segment = segments[index];
    if (range.index !== index || segment.segmentIndex !== index) return "Segment indexes must be sequential starting at zero";
    if (range.startFrame !== segment.startFrame || range.endFrame !== segment.endFrame) return `Segment ${index + 1} frame range does not match its file`;
    if (index === 0 && range.startFrame !== 0) return "The first segment must start at frame 0";
    if (index > 0 && range.startFrame !== ranges[index - 1].endFrame + 1) return "Segment frame ranges must be continuous with no gaps";
    if (range.endFrame < range.startFrame || range.endSeconds < range.startSeconds) return "Segment ranges must have a positive length";
    const ids = new Set(segment.tracks.map((track) => track.id));
    if (segment.crossings.some((crossing) => !ids.has(crossing.trackId) || !ids.has(crossing.otherTrackId))) {
      return `Segment ${index + 1} contains a crossing for a track that is not in that segment`;
    }
  }
  if (ranges.at(-1)?.endFrame !== manifest.frameCount - 1) return "Segment frame coverage must end at the manifest frame count";
  return null;
}

async function cleanupClaimObjects(paths: Iterable<string>, context: string): Promise<void> {
  const uniquePaths = [...new Set(paths)].filter(Boolean);
  if (uniquePaths.length === 0) return;
  const results = await Promise.allSettled(uniquePaths.map((path) => deleteClaimSegment(path)));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length > 0) {
    logger.warn({ count: failed.length, context }, "Some Claim Match bundle objects could not be cleaned up");
  }
}

export async function storeUploadBundle(recordingId: number, adminId: number, upload: UploadBundle) {
  const validationError = validateUploadBundle(upload);
  if (validationError) throw new Error(validationError);
  const [previousBundle] = await db
    .select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  const previousObjectPaths = previousBundle?.manifest.segments.flatMap((segment) => [
    segment.objectPath,
    ...(segment.spritesPath ? [segment.spritesPath] : []),
  ]) ?? [];
  const storedSegments: Array<{
    segment: TrackingSegmentPayload;
    objectPath: string;
    compressedBytes: number;
  }> = [];
  const spritePaths: Record<number, string> = {};
  try {
    for (const segment of upload.segments) {
      const stored = await writeClaimSegment(`${recordingId}/${randomUUID()}-${segment.segmentIndex}.json.gz`, segment);
      storedSegments.push({ segment, ...stored });
      const strips = upload.sprites?.[segment.segmentIndex];
      if (strips) {
        const storedSprites = await writeClaimSegment(`${recordingId}/${randomUUID()}-${segment.segmentIndex}-sprites.json.gz`, strips);
        spritePaths[segment.segmentIndex] = storedSprites.objectPath;
      }
    }
    const bundleFingerprint = trackingBundleFingerprint(upload.manifest, upload.segments);
    const manifest: TrackingManifest = {
      ...upload.manifest,
       provenance: {
         ...(upload.manifest.provenance ?? {}),
         bundleFingerprint,
         identityMapBundleFingerprint: undefined,
       },
      summary: summarizeTrackingSegments(upload.segments),
      videoStartSeconds: Math.max(0, upload.manifest.videoStartSeconds ?? 0),
      segmentCount: storedSegments.length,
      segments: storedSegments.map(({ segment, objectPath }) => ({
        index: segment.segmentIndex,
        name: segment.name,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        objectPath,
        ...(spritePaths[segment.segmentIndex] ? { spritesPath: spritePaths[segment.segmentIndex] } : {}),
      })),
    };
    const bindingsTableExists = await identityBindingsTableExists();
    const [saved] = await db.transaction(async (tx) => {
      const [bundle] = await tx
        .insert(recordingTrackingBundlesTable)
        .values({ recordingId, manifest, uploadedBy: adminId })
        .onConflictDoUpdate({
          target: recordingTrackingBundlesTable.recordingId,
          set: { manifest, uploadedBy: adminId, updatedAt: new Date() },
        })
        .returning();
      await tx.delete(recordingTrackingSegmentsTable).where(eq(recordingTrackingSegmentsTable.bundleId, bundle.id));
      await tx.insert(recordingTrackingSegmentsTable).values(storedSegments.map(({ segment, objectPath, compressedBytes }) => ({
        bundleId: bundle.id,
        segmentIndex: segment.segmentIndex,
        name: segment.name,
        startFrame: segment.startFrame,
        endFrame: segment.endFrame,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        objectPath,
        compressedBytes,
        trackCount: segment.tracks.length,
        crossingCount: segment.crossings.length,
      })));
      if (bindingsTableExists) {
        await tx
          .update(claimMatchIdentityBindingsTable)
          .set({ state: "needs_resolution", updatedAt: new Date() })
          .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
      } else {
        logger.warn({ recordingId }, "Claim identity binding table is not migrated yet");
      }
      // Track IDs are bundle-relative. A completed progress row from the
      // previous bundle cannot be carried across replacement, otherwise the
      // sticky-completion rule would bypass fresh identity review.
      await tx
        .update(claimMatchProgressTable)
        .set({
          completed: false,
          stage: "picker",
          clipsUnlocked: 0,
          earnedClips: [],
          updatedAt: new Date(),
        })
        .where(eq(claimMatchProgressTable.recordingId, recordingId));
      return [bundle];
    });
    if (previousBundle?.manifest.pitchModel || manifest.pitchModel) {
      const previousModel = previousBundle?.manifest.pitchModel;
      const nextModel = manifest.pitchModel;
      logger.info({
        recordingId,
        adminId,
        previousCalibrationId: previousModel?.calibrationId ?? null,
        nextCalibrationId: nextModel?.calibrationId ?? null,
        previousFittedAt: previousModel?.fittedAt ?? null,
        nextFittedAt: nextModel?.fittedAt ?? null,
        action: previousModel && nextModel ? "replace" : nextModel ? "attach" : "remove",
      }, "Tracking bundle pitch model changed during bundle upload");
    }
    await cleanupClaimObjects(previousObjectPaths, "successful replacement");
    return {
      recordingId,
      label: manifest.label,
      duration: manifest.duration,
      trackCount: storedSegments.reduce((sum, item) => sum + item.segment.tracks.length, 0),
      crossingCount: storedSegments.reduce((sum, item) => sum + item.segment.crossings.length, 0),
      segmentCount: storedSegments.length,
      frameCoverage: `0-${manifest.frameCount - 1} (${manifest.frameCount} frames)`,
      videoStartSeconds: manifest.videoStartSeconds,
      segmentRanges: manifest.segments,
      pitchModel: pitchModelSummary(manifest.pitchModel),
      uploadedAt: saved.updatedAt.toISOString(),
    };
  } catch (error) {
    const newObjectPaths = [
      ...storedSegments.map((segment) => segment.objectPath),
      ...Object.values(spritePaths),
    ];
    await cleanupClaimObjects(newObjectPaths, "failed replacement");
    throw error;
  }
}

router.patch("/admin/recordings/:id/tracking-bundle", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const body = UpdateTrackingBundleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const hasPitchModel = Object.prototype.hasOwnProperty.call(req.body, "pitchModel");
  if (body.data.videoStartSeconds === undefined && !hasPitchModel) {
    res.status(400).json({ error: "Provide videoStartSeconds or pitchModel" });
    return;
  }
  const [existing] = await db
    .select({ id: recordingTrackingBundlesTable.id, manifest: recordingTrackingBundlesTable.manifest })
    .from(recordingTrackingBundlesTable)
    .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  if (!existing) {
    res.status(404).json({ error: "Tracking bundle not found" });
    return;
  }
  let pitchModel = existing.manifest.pitchModel;
  if (hasPitchModel) {
    if (body.data.pitchModel === null) {
      pitchModel = undefined;
    } else {
      const parsedPitchModel = parsePitchModel(body.data.pitchModel);
      if (parsedPitchModel.error || !parsedPitchModel.model) {
        res.status(400).json({ error: parsedPitchModel.error ?? "Invalid pitch model" });
        return;
      }
      const framingError = pitchModelFramingError(
        parsedPitchModel.model,
        existing.manifest.width,
        existing.manifest.height,
      );
      if (framingError) {
        res.status(400).json({ error: framingError });
        return;
      }
      pitchModel = parsedPitchModel.model;
    }
  }
  const manifest: TrackingManifest = {
    ...existing.manifest,
    ...(body.data.videoStartSeconds === undefined
      ? {}
      : { videoStartSeconds: body.data.videoStartSeconds }),
  };
  if (hasPitchModel) {
    if (pitchModel) manifest.pitchModel = pitchModel;
    else delete manifest.pitchModel;
  }
  const [saved] = await db
    .update(recordingTrackingBundlesTable)
    .set({ manifest, updatedAt: new Date(), uploadedBy: adminId })
    .where(eq(recordingTrackingBundlesTable.id, existing.id))
    .returning({ updatedAt: recordingTrackingBundlesTable.updatedAt });
  if (hasPitchModel) {
    logger.info({
      recordingId,
      adminId,
      previousCalibrationId: existing.manifest.pitchModel?.calibrationId ?? null,
      nextCalibrationId: manifest.pitchModel?.calibrationId ?? null,
      action: pitchModel ? "attach" : "remove",
    }, "Admin changed tracking bundle pitch model");
  }
  res.json(UpdateTrackingBundleResponse.parse({
    recordingId,
    videoStartSeconds: manifest.videoStartSeconds ?? 0,
    pitchModel: pitchModelSummary(manifest.pitchModel),
    updatedAt: saved?.updatedAt?.toISOString() ?? new Date().toISOString(),
  }));
});

router.put("/admin/recordings/:id/tracking-bundle", bundleUploadSingle, async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const [recording] = await db
    .select({ id: recordingsTable.id })
    .from(recordingsTable)
    .where(eq(recordingsTable.id, recordingId));
  if (!recording) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  const parsedZip = req.file?.buffer ? parseZipBundleDetailed(req.file.buffer) : null;
  const parsedBody = parsedZip ? null : parseUploadedBundleDetailed(req.body);
  const upload = parsedZip?.upload ?? parsedBody?.upload ?? null;

  // Where the tracked window starts inside the video is a property of THIS
  // pairing of bundle and recording, not of the bundle - the same tracking can
  // be attached to a differently-trimmed video. So an explicit form field wins
  // over whatever the bundle happened to carry. Getting this wrong does not
  // fail loudly: it draws every box against footage from another part of the
  // match, which looks like broken tracking rather than a wrong number.
  const overrideStart = firstNumber(
    (req.body as UnknownRecord | undefined)?.videoStartSeconds,
  );
  if (upload && overrideStart !== undefined) {
    upload.manifest.videoStartSeconds = Math.max(0, overrideStart);
  }
  if (!upload) {
    res.status(400).json({
      error: parsedZip?.error ?? parsedBody?.error ?? "Invalid tracking bundle. Include manifest metadata and segment tracking data.",
    });
    return;
  }
  const validationError = validateUploadBundle(upload);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  try {
    res.json(await storeUploadBundle(recordingId, adminId, upload));
  } catch (error) {
    logger.error({ recordingId, err: error }, "Could not persist Claim Match tracking bundle");
    res.status(500).json({ error: "Could not save the tracking bundle. The previous bundle was kept." });
  }
});

/**
 * GET /recordings/:id/claim-match/sprites/:segmentIndex
 * Crop strips for the identity board, one object per segment. Only present
 * when the bundle zip carried sprites/<segment>.json.
 */
router.get("/recordings/:id/claim-match/sprites/:segmentIndex", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const params = GetClaimMatchSegmentParams.safeParse({
    id: recordingIdFromRequest(req.params.id),
    segmentIndex: Number.parseInt(Array.isArray(req.params.segmentIndex) ? req.params.segmentIndex[0] : req.params.segmentIndex, 10),
  });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const access = await getClaimMatchBundleForRequest(req, params.data.id);
  if (access.error) {
    res.status(404).json({ error: access.error ?? "Recording not found", code: access.code ?? "recording_not_found" });
    return;
  }
  if (!access.row?.bundle?.manifest) {
    res.status(404).json({ error: "No tracking bundle has been uploaded for this recording", code: "tracking_bundle_missing" });
    return;
  }
  const manifestSegment = access.row.bundle.manifest.segments.find((segment) => segment.index === params.data.segmentIndex);
  const spritesPath = (manifestSegment as { spritesPath?: string } | undefined)?.spritesPath;
  if (!spritesPath) {
    res.status(404).json({ error: "No sprites for this segment" });
    return;
  }
  try {
    const compressed = await readCompressedClaimSegment(spritesPath);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Length", String(compressed.byteLength));
    res.status(200).send(compressed);
  } catch {
    res.status(404).json({ error: "Sprites not found" });
  }
});

/**
 * PUT /admin/recordings/:id/identities
 * The identity board's result: which track pieces are one person. Stored on
 * the manifest (jsonb, no migration); the claim page merges tracks from it at
 * load time, so identity survives segment boundaries. A re-save may regroup
 * unvouched pieces, but it cannot move a human-vouched source fragment. An
 * administrator must explicitly release that fragment first.
 */
router.put("/admin/recordings/:id/identities", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const body = IdentityMapBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const row = await getRecordingBundle(recordingId);
  if (!row?.bundle?.manifest) {
    res.status(404).json({ error: "Recording or tracking bundle not found" });
    return;
  }
  const currentFingerprint = row.bundle.manifest.summary?.segments?.length
    ? trackingBundleFingerprint(row.bundle.manifest, row.bundle.manifest.summary.segments)
    : trackingBundleFingerprint(row.bundle.manifest, await readBundleSegments(row.bundle.id));
  if (body.data.bundleFingerprint !== currentFingerprint) {
    res.status(409).json({
      error: "This identity map was built from a different tracking bundle. Reload the identity board before saving.",
      currentBundleFingerprint: currentFingerprint,
    });
    return;
  }
  const storedFingerprint = row.bundle.manifest.provenance?.bundleFingerprint;
  if (typeof storedFingerprint === "string" && storedFingerprint !== currentFingerprint) {
    res.status(409).json({
      error: "The tracking bundle changed while this identity map was open. Reload the identity board before saving.",
      currentBundleFingerprint: currentFingerprint,
    });
    return;
  }
  const existingBindings = await db
    .select({
      id: claimMatchIdentityBindingsTable.id,
      personId: claimMatchIdentityBindingsTable.personId,
      vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
      state: claimMatchIdentityBindingsTable.state,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
  const lockedBindings = existingBindings.filter((binding) =>
    binding.state !== "released"
    && identityMapMovesVouchedFragment(binding, body.data.identities),
  );
  const preview = req.query.preview === "true" || req.query.preview === "1";
  const lockSummary = {
    lockedClaims: lockedBindings.length,
    lockedFragments: lockedBindings.reduce(
      (count, binding) => count + (binding.vouchedFragments?.length ?? 0),
      0,
    ),
    requiresRelease: lockedBindings.length > 0,
  };
  if (preview) {
    res.json({
      recordingId,
      identities: body.data.identities.length,
      bundleFingerprint: currentFingerprint,
      ...lockSummary,
    });
    return;
  }
  if (lockedBindings.length > 0) {
    res.status(409).json({
      error: "This edit moves a human-vouched fragment. Release the affected claim fragment before regrouping it.",
      ...lockSummary,
      lockedBindingIds: lockedBindings.map((binding) => binding.id),
    });
    return;
  }
  const manifest: TrackingManifest = {
    ...row.bundle.manifest,
    identities: body.data.identities,
    provenance: {
      ...(row.bundle.manifest.provenance ?? {}),
      bundleFingerprint: currentFingerprint,
      identityMapBundleFingerprint: currentFingerprint,
    },
  };
  await db.transaction(async (tx) => {
    await tx
      .update(recordingTrackingBundlesTable)
      .set({ manifest, updatedAt: new Date() })
      .where(eq(recordingTrackingBundlesTable.recordingId, recordingId));
  });
  res.json({
    recordingId,
    identities: body.data.identities.length,
    bundleFingerprint: currentFingerprint,
    ...lockSummary,
  });
});

export default router;
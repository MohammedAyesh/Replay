import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  academyFeatureSettingsTable,
  academyMatchLineupsTable,
  academyMatchPagesTable,
  academyMatchPlayerStatsTable,
  academyPlayerClipsTable,
  academyPlayerFeaturesTable,
  academyPlayersTable,
  academySessionsTable,
  academySquadsTable,
  db,
  type AcademyCreativeProject,
  type FeatureItemType,
} from "@workspace/db";
import { sceneFields, sceneSchema } from "@workspace/api-zod";
import {
  DEFAULT_TARGETS,
  footageGaps,
  monthBounds,
  playersInData,
  squadGrid,
  ammanMonth,
  type AnalysedMatch,
  type FeatureTargets,
  type FootageGap,
  type GridPlayer,
  type RosterPlayer,
  type SquadGrid,
} from "./rules";

/**
 * "Every child appears": what the database holds (the feature log, targets,
 * consent) and the squad grid built from it. Rules live in ./rules.ts.
 */

export async function loadTargets(academyId: number): Promise<FeatureTargets> {
  const [row] = await db.select().from(academyFeatureSettingsTable).where(eq(academyFeatureSettingsTable.academyId, academyId));
  return row ? { publicPostsPerMonth: row.publicPostsPerMonth, privateClipPerMatch: row.privateClipPerMatch } : { ...DEFAULT_TARGETS };
}

export async function saveTargets(academyId: number, patch: Partial<FeatureTargets>): Promise<FeatureTargets> {
  const current = await loadTargets(academyId);
  const next = { ...current, ...patch };
  await db.insert(academyFeatureSettingsTable)
    .values({ academyId, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: academyFeatureSettingsTable.academyId, set: { ...next, updatedAt: new Date() } });
  return next;
}

/** Every player of the academy (inactive ones too, so old posts still resolve), with consent. */
export async function academyRoster(academyId: number): Promise<Array<RosterPlayer & { name: string; consent: boolean; squadId: number | null }>> {
  const rows = await db.select({
    id: academyPlayersTable.id,
    name: academyPlayersTable.name,
    number: academyPlayersTable.jerseyNumber,
    isActive: academyPlayersTable.isActive,
    consent: academyPlayersTable.publicPostsConsent,
    squadId: academyPlayersTable.squadId,
  }).from(academyPlayersTable).where(eq(academyPlayersTable.academyId, academyId));
  return rows;
}

export type FeatureEntry = { playerIds: number[]; solo: boolean; itemType: FeatureItemType; itemId: string; visibility: "public" | "private"; at: Date };

/** Log appearances. The same item is logged once per child; a later call only moves it earlier, never twice. */
export async function recordFeatures(academyId: number, entries: FeatureEntry[]): Promise<number> {
  const values = entries.flatMap((e) => e.playerIds.map((playerId) => ({
    academyId, playerId, itemType: e.itemType, itemId: e.itemId, visibility: e.visibility, solo: e.solo, featuredAt: e.at,
  })));
  if (!values.length) return 0;
  const rows = await db.insert(academyPlayerFeaturesTable).values(values)
    .onConflictDoUpdate({
      target: [academyPlayerFeaturesTable.playerId, academyPlayerFeaturesTable.itemType, academyPlayerFeaturesTable.itemId],
      set: {
        // Public wins over private (a design first sent to parents, then posted).
        visibility: sql`case when excluded.visibility = 'public' or ${academyPlayerFeaturesTable.visibility} = 'public' then 'public' else 'private' end`,
        featuredAt: sql`least(${academyPlayerFeaturesTable.featuredAt}, excluded.featured_at)`,
      },
    })
    .returning({ id: academyPlayerFeaturesTable.id });
  return rows.length;
}

export async function removeFeatures(academyId: number, itemType: FeatureItemType, itemId: string): Promise<void> {
  await db.delete(academyPlayerFeaturesTable).where(and(
    eq(academyPlayerFeaturesTable.academyId, academyId),
    eq(academyPlayerFeaturesTable.itemType, itemType),
    eq(academyPlayerFeaturesTable.itemId, itemId),
  ));
}

/** The academy players a creative project shows, and whether it is about one of them alone. */
export async function projectPlayers(row: Pick<AcademyCreativeProject, "academyId" | "data" | "templateKey" | "scene">) {
  const roster = await academyRoster(row.academyId);
  const parsed = sceneSchema.safeParse(row.scene);
  const showsPlayer = parsed.success ? sceneFields(parsed.data).some((f) => f === "player" || f.startsWith("player.")) : true;
  const found = playersInData(row.data as Parameters<typeof playersInData>[0], row.templateKey, roster, showsPlayer);
  const byId = new Map(roster.map((p) => [p.id, p]));
  const withoutConsent = found.playerIds.map((id) => byId.get(id)!).filter((p) => !p.consent);
  return { ...found, withoutConsent: withoutConsent.map((p) => ({ playerId: p.id, number: p.number, name: p.name })) };
}

/** Log a creative project as an appearance of every child it shows. One design counts once per child, whatever the channels. */
export async function logProjectFeature(row: AcademyCreativeProject, visibility: "public" | "private", at: Date): Promise<void> {
  const found = await projectPlayers(row);
  await recordFeatures(row.academyId, [{
    playerIds: found.playerIds, solo: found.solo, itemType: visibility === "public" ? "post" : "whatsapp",
    itemId: String(row.id), visibility, at,
  }]);
}

/** When each child last had a solo public post (null = never), for rotation. */
export async function lastSoloPublic(academyId: number): Promise<Map<number, Date | null>> {
  const rows = await db.select({
    playerId: academyPlayerFeaturesTable.playerId,
    at: sql<Date>`max(${academyPlayerFeaturesTable.featuredAt})`,
  }).from(academyPlayerFeaturesTable)
    .where(and(eq(academyPlayerFeaturesTable.academyId, academyId), eq(academyPlayerFeaturesTable.visibility, "public"), eq(academyPlayerFeaturesTable.solo, true)))
    .groupBy(academyPlayerFeaturesTable.playerId);
  return new Map(rows.map((r) => [r.playerId, r.at ? new Date(r.at) : null]));
}

/** Players who may appear in a public post, by id. */
export async function consentedPlayerIds(academyId: number): Promise<Set<number>> {
  const rows = await db.select({ id: academyPlayersTable.id }).from(academyPlayersTable)
    .where(and(eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.publicPostsConsent, true)));
  return new Set(rows.map((r) => r.id));
}

export async function setConsent(academyId: number, playerId: number, consent: boolean): Promise<boolean> {
  const rows = await db.update(academyPlayersTable)
    .set({ publicPostsConsent: consent, publicPostsConsentAt: consent ? new Date() : null })
    .where(and(eq(academyPlayersTable.id, playerId), eq(academyPlayersTable.academyId, academyId)))
    .returning({ id: academyPlayersTable.id });
  return rows.length > 0;
}

// ── The grid ────────────────────────────────────────────────────────────────

/** How many recent analysed matches the footage check looks back over. */
const GAP_LOOKBACK = 10;

/**
 * Analysed matches (stats computed for the page) with who was in the squad and
 * who the analysis found. A match without a saved line-up has no squad list
 * and is left out of the footage check.
 */
async function analysedMatches(academyId: number, from?: Date, to?: Date, limit = GAP_LOOKBACK): Promise<AnalysedMatch[]> {
  const conditions = [
    eq(academySessionsTable.academyId, academyId),
    eq(academySessionsTable.type, "match"),
    isNotNull(academyMatchPagesTable.statsComputedAt),
  ];
  if (from) conditions.push(gte(academySessionsTable.startsAt, from));
  if (to) conditions.push(lt(academySessionsTable.startsAt, to));
  const sessions = await db.select({ id: academySessionsTable.id, startsAt: academySessionsTable.startsAt })
    .from(academySessionsTable)
    .innerJoin(academyMatchPagesTable, eq(academyMatchPagesTable.sessionId, academySessionsTable.id))
    .where(and(...conditions))
    .orderBy(desc(academySessionsTable.startsAt))
    .limit(limit);
  if (!sessions.length) return [];
  const ids = sessions.map((s) => s.id);
  const [lineups, stats] = await Promise.all([
    db.select({ sessionId: academyMatchLineupsTable.sessionId, playerId: academyMatchLineupsTable.playerId, inSquad: academyMatchLineupsTable.inSquad })
      .from(academyMatchLineupsTable).where(inArray(academyMatchLineupsTable.sessionId, ids)),
    db.select({ sessionId: academyMatchPlayerStatsTable.sessionId, playerId: academyMatchPlayerStatsTable.playerId })
      .from(academyMatchPlayerStatsTable).where(inArray(academyMatchPlayerStatsTable.sessionId, ids)),
  ]);
  return sessions.map((s) => ({
    sessionId: s.id,
    startsAt: s.startsAt,
    inSquad: lineups.filter((l) => l.sessionId === s.id && l.inSquad).map((l) => l.playerId),
    found: stats.filter((x) => x.sessionId === s.id).map((x) => x.playerId),
  }));
}

export type SquadGridView = SquadGrid & {
  gaps: Array<FootageGap & { number: number | null; name: string }>;
  squads: Array<{ id: number; name: string }>;
};

export async function loadSquadGrid(academyId: number, opts: { now?: Date; month?: string; squadId?: number | null } = {}): Promise<SquadGridView> {
  const now = opts.now ?? new Date();
  const month = opts.month ?? ammanMonth(now);
  const { from, to } = monthBounds(month);
  const [targets, roster, squads] = await Promise.all([
    loadTargets(academyId),
    db.select({
      id: academyPlayersTable.id, name: academyPlayersTable.name, number: academyPlayersTable.jerseyNumber,
      consent: academyPlayersTable.publicPostsConsent, squadId: academyPlayersTable.squadId, squadName: academySquadsTable.name,
    }).from(academyPlayersTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
      .where(and(eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.isActive, true)))
      .orderBy(asc(academyPlayersTable.jerseyNumber)),
    db.select({ id: academySquadsTable.id, name: academySquadsTable.name }).from(academySquadsTable)
      .where(eq(academySquadsTable.academyId, academyId)).orderBy(asc(academySquadsTable.name)),
  ]);
  const inScope = opts.squadId ? roster.filter((p) => p.squadId === opts.squadId) : roster;
  const ids = inScope.map((p) => p.id);
  const players: GridPlayer[] = inScope.map((p) => ({ id: p.id, name: p.name, number: p.number, squadName: p.squadName ?? null, consent: p.consent }));
  const [features, monthMatches, recent, clips] = await Promise.all([
    ids.length ? db.select({
      playerId: academyPlayerFeaturesTable.playerId, itemType: academyPlayerFeaturesTable.itemType,
      visibility: academyPlayerFeaturesTable.visibility, solo: academyPlayerFeaturesTable.solo, featuredAt: academyPlayerFeaturesTable.featuredAt,
    }).from(academyPlayerFeaturesTable)
      .where(and(eq(academyPlayerFeaturesTable.academyId, academyId), inArray(academyPlayerFeaturesTable.playerId, ids))) : [],
    analysedMatches(academyId, from, to, 200),
    analysedMatches(academyId, undefined, now),
    db.select({ sessionId: academyPlayerClipsTable.sessionId, playerId: academyPlayerClipsTable.playerId })
      .from(academyPlayerClipsTable)
      .where(and(eq(academyPlayerClipsTable.academyId, academyId), eq(academyPlayerClipsTable.status, "sent"))),
  ]);
  const played = monthMatches.flatMap((m) => m.found.map((playerId) => ({ playerId, sessionId: m.sessionId, startsAt: m.startsAt })));
  const grid = squadGrid({
    players,
    features: features.map((f) => ({ ...f, visibility: f.visibility as "public" | "private" })),
    played,
    clipsReceived: new Set(clips.map((c) => `${c.sessionId}:${c.playerId}`)),
    targets,
    now,
    month,
  });
  const byId = new Map(inScope.map((p) => [p.id, p]));
  const gaps = footageGaps(recent, ids).map((g) => ({ ...g, number: byId.get(g.playerId)?.number ?? null, name: byId.get(g.playerId)?.name ?? "" }));
  return { ...grid, gaps, squads };
}

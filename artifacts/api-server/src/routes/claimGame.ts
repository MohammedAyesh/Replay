/**
 * The whole-game claim (/find/:id), the prototype's flow on Replay's bundle.
 *
 * The page does the claiming; the server keeps what it decides and makes it
 * count everywhere else:
 *
 *   GET    /recordings/:id/claim-match/game   saved state + the whole game's
 *                                             in-play spans (for the intro)
 *   PUT    /recordings/:id/claim-match/game   save state; the claimed pieces
 *                                             become the claimant's identity
 *                                             row, bench time their off-pitch
 *                                             spans, and the binding, coverage,
 *                                             completion and clips follow
 *   DELETE /recordings/:id/claim-match/game   start over
 *   GET    /recordings/:id/claim-match/game/play
 *                                             touches, passes and teams for the
 *                                             stats screen (lib/matchPlay.ts)
 *
 * The identity row is written by the same persistChain / syncChainClaim the
 * claim chain uses, so the board, player stats, earned clips and "claimed
 * matches" all see a game claim exactly as they see a chain claim.
 */
import { Router, type IRouter } from "express";
import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";

import {
  db,
  claimMatchOffPitchSpansTable,
  claimMatchProgressTable,
  matchTeamSpansTable,
  matchRoomsTable,
  matchPlayersTable,
  matchGamesTable,
  footageRequestsTable,
  recordingsTable,
  recordingTrackingBundlesTable,
  fieldsTable,
} from "@workspace/db";
import { normaliseChain, type ChainPart } from "../lib/claimChain";
import {
  detectedGoals,
  detectedShots,
  goalContext,
  pitchSizeOf,
  DRIBBLE,
  kitOfParts,
  parseLab,
  passEvents,
  PASS,
  playerMoments,
  playerPlay,
  seedTeams,
  sideOfKit,
  teamDribbles,
  teamStats,
  type ClaimedPart,
  type Lab,
  type TeamPick,
} from "../lib/matchPlay";
import { loadRecordingPlay } from "../lib/matchPlayLoad";
import { joinMatchesFromClaim } from "../lib/matchFeed";
import {
  isMissingMatchTeamSpansTable,
  readOptionalMatchTeamSpans,
  warnOptionalMatchTeamSpansFailureOnce,
} from "../lib/optionalMatchTeamSpans";
import {
  begin,
  claimIdentityId,
  persistChain,
  recordFindDecisionLabel,
  syncChainClaim,
  type ChainContext,
} from "./claimChain";
import { getClaimMatchWritableBundle, requireAccountUser } from "./claimMatch";
import { ammanLocalInstant } from "../lib/matchRooms";
import { recordingWindow } from "../lib/matchFeed";
import { clipPartsToMatchWindow, clipRangeToMatchWindow, readMatchWindow } from "../lib/matchWindow";

const router: IRouter = Router();

const PartsBody = z.array(z.object({
  trackId: z.string().min(1),
  fromFrame: z.number().int().min(0),
  toFrame: z.number().int().min(0),
})).max(5000);

const SaveBody = z.object({
  state: z.record(z.unknown()),
  parts: PartsBody,
  bench: z.array(z.object({ fromSeconds: z.number().min(0), toSeconds: z.number().min(0) })).max(200),
  /** Only present after the claimant confirms the name dialog. */
  name: z.string().trim().min(1).max(60).optional(),
  /** the claimant reached the done screen */
  done: z.boolean(),
  bundleFingerprint: z.string().min(1).nullish(),
});

const DecisionLabelBody = z.object({
  kind: z.enum(["switch", "lost", "confirm"]),
  frame: z.number().int().min(0),
  wrongTrackId: z.string().min(1).nullish(),
  rightTrackId: z.string().min(1).nullish(),
  decisionMs: z.number().int().min(0).max(600_000).nullish(),
  bundleFingerprint: z.string().min(1),
}).superRefine((decision, issue) => {
  const valid = decision.kind === "switch"
    ? Boolean(decision.wrongTrackId && decision.rightTrackId)
    : decision.kind === "lost"
      ? Boolean(decision.wrongTrackId) && !decision.rightTrackId
      : Boolean(decision.rightTrackId) && !decision.wrongTrackId;
  if (!valid) {
    issue.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The selected label kind does not match its track ids",
    });
  }
});

/** State is the page's own document; keep it bounded rather than trusting its size. */
const MAX_STATE_BYTES = 2_000_000;

const DEAD_BOOKINGS = ["cancelled", "refunded", "failed"];

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The deliberately small public projection used by the find page. */
async function claimMatchChoices(ctx: ChainContext): Promise<{
  matches: unknown[];
  continuation: { recordingId: number; timeLabel: string; matchCode: string } | null;
}> {
  const [source] = await db.select({
    recording: recordingsTable,
    manifest: recordingTrackingBundlesTable.manifest,
    field: fieldsTable,
  }).from(recordingsTable)
    .leftJoin(recordingTrackingBundlesTable, eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id))
    .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
    .where(eq(recordingsTable.id, ctx.recordingId));
  if (!source?.manifest) return { matches: [], continuation: null };
  const rw = recordingWindow(source.recording, source.manifest);
  if (!Number.isFinite(rw.startMs)) return { matches: [], continuation: null };
  const rows = await db.select({ room: matchRoomsTable, request: footageRequestsTable })
    .from(matchRoomsTable)
    .innerJoin(footageRequestsTable, eq(footageRequestsTable.id, matchRoomsTable.footageRequestId))
    .where(and(eq(matchRoomsTable.fieldId, source.recording.fieldId), notInArray(footageRequestsTable.status, DEAD_BOOKINGS)));
  const matches: unknown[] = [];
  let continuation: { recordingId: number; timeLabel: string; matchCode: string } | null = null;
  for (const { room, request } of rows) {
    const start = ammanLocalInstant(request.startLocal);
    const end = ammanLocalInstant(request.endLocal);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= rw.startMs || start >= rw.endMs) continue;
    // The picker offers the booking only where it is the match: clipped to
    // manifest.provenance.matchWindow, and not at all when the booking only
    // covers footage outside it (another group's game running over).
    const share = clipRangeToMatchWindow(
      Math.max(0, (start - rw.startMs) / 1000),
      Math.min(source.manifest.duration, (end - rw.startMs) / 1000),
      source.manifest,
    );
    if (!share) continue;
    const startSeconds = share.fromSeconds;
    const endSeconds = share.toSeconds;
    const recordingOffsetSec = (rw.startMs - start) / 1000;
    const [players, games, spans] = await Promise.all([
      db.select().from(matchPlayersTable).where(eq(matchPlayersTable.matchId, room.id)),
      db.select().from(matchGamesTable).where(eq(matchGamesTable.matchId, room.id)),
      readOptionalMatchTeamSpans("claimMatchChoices", () => db.select().from(matchTeamSpansTable)
        .where(eq(matchTeamSpansTable.matchId, room.id))),
    ]);
    const own = players.find((p) => p.userId === ctx.userId);
    const ownSpans = own ? spans.filter((s) => s.matchPlayerId === own.id) : [];
    matches.push({
      code: room.code,
      title: room.title,
      fieldName: source.field?.name ?? null,
      rostered: Boolean(own),
      teamCount: room.teamCount,
      startSeconds,
      endSeconds,
      recordingOffsetSec,
      games: games.map((g) => ({
        idx: g.idx,
        startSeconds: Math.max(startSeconds, g.startOffsetSec - recordingOffsetSec),
        endSeconds: Math.min(endSeconds, g.endOffsetSec - recordingOffsetSec),
        teamX: g.teamX,
        teamY: g.teamY,
      })).filter((g) => g.endSeconds > g.startSeconds),
      playerTeamSpans: own ? ownSpans.map((s) => ({
        id: s.id,
        fromSeconds: Math.max(startSeconds, s.fromOffsetSec - recordingOffsetSec),
        toSeconds: Math.min(endSeconds, s.toOffsetSec == null ? endSeconds : s.toOffsetSec - recordingOffsetSec),
        team: s.team,
        source: s.source,
        createdAt: s.createdAt.toISOString(),
        changedShirt: s.changedShirt,
      })).filter((s) => s.toSeconds > s.fromSeconds) : [],
      rosterTeam: own ? own.team : null,
    });
    // A window that ends before the footage does says the match ended here,
    // so there is nothing to continue onto in the next recording.
    const windowEnd = readMatchWindow(source.manifest)?.endSeconds ?? source.manifest.duration;
    if (end > rw.endMs && !continuation && windowEnd >= source.manifest.duration) {
      const next = await db.select({ recording: recordingsTable, manifest: recordingTrackingBundlesTable.manifest, field: fieldsTable })
        .from(recordingsTable)
        .innerJoin(recordingTrackingBundlesTable, eq(recordingTrackingBundlesTable.recordingId, recordingsTable.id))
        .leftJoin(fieldsTable, eq(fieldsTable.id, recordingsTable.fieldId))
        .where(eq(recordingsTable.fieldId, source.recording.fieldId));
      const found = next.find((candidate) => {
        const w = recordingWindow(candidate.recording, candidate.manifest);
        return candidate.field?.cameraId === source.field?.cameraId
          && w.startMs >= rw.endMs - 1000 && w.startMs <= rw.endMs + 3700000;
      });
      if (found) continuation = { recordingId: found.recording.id, timeLabel: found.recording.timeSlot, matchCode: room.code };
    }
  }
  return { matches, continuation };
}

function inPlaySpans(ctx: ChainContext): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const segment of ctx.segments) {
    for (const span of segment.inPlaySpans ?? []) {
      if (span.end > span.start) spans.push([span.start, span.end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

function matchWindowForClient(ctx: ChainContext): { startSeconds: number; endSeconds: number } | null {
  const window = readMatchWindow(ctx.manifest);
  return window ? { startSeconds: window.startSeconds, endSeconds: window.endSeconds } : null;
}

router.get("/recordings/:id/claim-match/game", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const [row] = await db
    .select({ gameState: claimMatchProgressTable.gameState, updatedAt: claimMatchProgressTable.updatedAt })
    .from(claimMatchProgressTable)
    .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));
  const state = row?.gameState ?? null;
  let choices: Awaited<ReturnType<typeof claimMatchChoices>>;
  try {
    choices = await claimMatchChoices(ctx);
  } catch (error) {
    warnOptionalMatchTeamSpansFailureOnce("claimMatchChoices", error);
    choices = { matches: [], continuation: null };
  }
  // A state saved against a different bundle names tracks that no longer exist.
  const stale = !!state && typeof state === "object" && (state as { bundle?: unknown }).bundle !== ctx.fingerprint;
  res.json({
    state: stale ? null : state,
    staleState: stale,
    bundleFingerprint: ctx.fingerprint,
    inPlaySpans: inPlaySpans(ctx),
    /**
     * Where the match is on this recording (tracking seconds), or null for
     * the whole recording. The page starts the claim inside it and skips
     * blocks that lie entirely outside it, as it does for a chosen booking.
     */
    matchWindow: matchWindowForClient(ctx),
    matches: choices.matches,
    continuation: choices.continuation,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
});

/**
 * Record one explicit decision from /find. This is intentionally separate
 * from PUT /game: that endpoint autosaves the whole page state after every
 * step, while this endpoint is called only for an identity decision.
 */
router.post("/recordings/:id/claim-match/game/decision", async (req, res): Promise<void> => {
  const parsed = DecisionLabelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision label", issues: parsed.error.issues.slice(0, 5) });
    return;
  }
  const ctx = await begin(req, res);
  if (!ctx) return;
  if (parsed.data.bundleFingerprint !== ctx.fingerprint) {
    res.status(409).json({
      error: "This recording's tracking has been replaced. Reload before continuing your claim.",
      currentBundleFingerprint: ctx.fingerprint,
    });
    return;
  }

  const frameLimit = Math.max(0, Math.ceil(ctx.manifest.duration * ctx.manifest.frameRate) - 1);
  if (parsed.data.frame > frameLimit) {
    res.status(400).json({ error: "Decision frame is outside this recording" });
    return;
  }
  for (const trackId of [parsed.data.wrongTrackId, parsed.data.rightTrackId]) {
    if (trackId && !ctx.tracksById.has(trackId)) {
      res.status(400).json({ error: "Decision references a track outside this recording" });
      return;
    }
  }

  const labelRecorded = await recordFindDecisionLabel(ctx, parsed.data.kind, parsed.data.frame, {
    wrongTrackId: parsed.data.wrongTrackId,
    rightTrackId: parsed.data.rightTrackId,
    decisionMs: parsed.data.decisionMs,
  });
  res.json({ ok: true, labelRecorded });
});

router.put("/recordings/:id/claim-match/game", async (req, res): Promise<void> => {
  const parsed = SaveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid claim", issues: parsed.error.issues.slice(0, 5) });
    return;
  }
  if (JSON.stringify(parsed.data.state).length > MAX_STATE_BYTES) {
    res.status(413).json({ error: "Claim too large" });
    return;
  }
  const ctx = await begin(req, res);
  if (!ctx) return;
  if (parsed.data.bundleFingerprint && parsed.data.bundleFingerprint !== ctx.fingerprint) {
    res.status(409).json({
      error: "This recording's tracking has been replaced. Reload before continuing your claim.",
      currentBundleFingerprint: ctx.fingerprint,
    });
    return;
  }

  // Every claimed piece, clamped to its track and marked answered: the game
  // claim has already asked everything it is going to ask.
  const chain: ChainPart[] = normaliseChain(
    parsed.data.parts.map((part) => ({ ...part, reviewedThrough: part.toFrame + 1 })),
    ctx.tracksById,
  );

  try {
    await persistChain(ctx, chain, { chosen: parsed.data.name ?? null, fallback: null }, { kind: "decision", answeredFrame: null });
  } catch (error) {
    console.error("[claim-game] identity write failed", { recordingId: ctx.recordingId, error });
    res.status(500).json({ error: "Could not save your claim" });
    return;
  }

  // Bench time is this claimant's off-pitch time: replace their spans with it.
  const bench = parsed.data.bench
    .filter((span) => span.toSeconds > span.fromSeconds)
    .map((span, index) => ({ ...span, clientId: `game-bench-${index}` }));
  try {
    await db.transaction(async (tx) => {
      await tx.delete(claimMatchOffPitchSpansTable).where(and(
        eq(claimMatchOffPitchSpansTable.userId, ctx.userId),
        eq(claimMatchOffPitchSpansTable.recordingId, ctx.recordingId),
      ));
      if (bench.length) {
        await tx.insert(claimMatchOffPitchSpansTable).values(bench.map((span) => ({
          userId: ctx.userId,
          recordingId: ctx.recordingId,
          clientId: span.clientId,
          fromSeconds: span.fromSeconds,
          toSeconds: span.toSeconds,
        })));
      }
    });
  } catch (error) {
    console.error("[claim-game] bench write failed", { recordingId: ctx.recordingId, error });
  }

  await syncChainClaim(ctx, chain, !parsed.data.done);

  // A finished claim puts the claimant on the roster of every match booked
  // over this recording, on the team their shirt matches. Best effort: the
  // claim itself is saved either way.
  const rawChoices = Array.isArray((parsed.data.state as { matchChoices?: unknown }).matchChoices)
    ? (parsed.data.state as { matchChoices: unknown[] }).matchChoices.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];
  if (parsed.data.done && chain.length) {
    try {
      // The fourth argument is optional in older matchFeed builds; an empty
      // choice list intentionally preserves their all-overlap behaviour.
      await (joinMatchesFromClaim as unknown as (...args: unknown[]) => Promise<number>)(
        ctx.userId, ctx.recordingId, chain, rawChoices.length ? rawChoices : undefined,
      );
    } catch (error) {
      console.error("[claim-game] match roster join failed", { recordingId: ctx.recordingId, error });
    }
  }

  const state = { ...parsed.data.state, bundle: ctx.fingerprint };
  // Claim switches are imported as spans, never as training labels.  Replace
  // this user's claim spans on each save so autosaves remain idempotent.
  if (parsed.data.done && rawChoices.length) {
    try {
      const selected = new Set(rawChoices);
      const available = await claimMatchChoices(ctx);
      const selectedMatches = (available.matches as Array<{
        code: string; startSeconds: number; endSeconds: number; recordingOffsetSec: number; rostered: boolean;
      }>).filter((m) => selected.has(m.code) && m.rostered);
      const switches = Array.isArray((parsed.data.state as { switches?: unknown }).switches)
        ? (parsed.data.state as { switches: unknown[] }).switches : [];
      for (const match of selectedMatches) {
        const [room] = await db.select({ id: matchRoomsTable.id }).from(matchRoomsTable).where(eq(matchRoomsTable.code, match.code));
        if (!room) continue;
        const [player] = await db.select({ id: matchPlayersTable.id })
          .from(matchPlayersTable)
          .where(and(eq(matchPlayersTable.matchId, room.id), eq(matchPlayersTable.userId, ctx.userId)));
        if (!player) continue;
        const mine = switches.filter((entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object"
          && (!(typeof (entry as Record<string, unknown>).matchCode === "string")
            || (entry as Record<string, unknown>).matchCode === match.code));
        const events = mine
          .filter((entry) => entry.teamChanged === true && ["A", "B", "C"].includes(String(entry.team ?? "")))
          .map((entry) => ({
            at: finiteNumber(entry.atSeconds),
            team: String(entry.team),
            shirtChanged: entry.shirtChanged === true,
          }))
          .filter((entry): entry is { at: number; team: string; shirtChanged: boolean } => entry.at !== null)
          .filter((entry) => entry.at >= match.startSeconds && entry.at < match.endSeconds)
          .sort((a, b) => a.at - b.at);
        // Only claim rows beginning inside this recording's overlap are
        // replaced. A span from another recording (or a manual span) survives.
        const existing = await db.select().from(matchTeamSpansTable).where(and(
          eq(matchTeamSpansTable.matchId, room.id),
          eq(matchTeamSpansTable.matchPlayerId, player.id),
          eq(matchTeamSpansTable.source, "claim"),
        ));
        for (const span of existing) {
          const spanFromRecording = span.fromOffsetSec - match.recordingOffsetSec;
          if (spanFromRecording >= match.startSeconds && spanFromRecording < match.endSeconds) {
            await db.delete(matchTeamSpansTable).where(eq(matchTeamSpansTable.id, span.id));
          }
        }
        const values = events.map((entry, index) => {
          const next = events[index + 1];
          const from = entry.at;
          const to = next?.at ?? match.endSeconds;
          return [{
            matchId: room.id, matchPlayerId: player.id,
            fromOffsetSec: Math.round(from - match.recordingOffsetSec),
            toOffsetSec: Math.round(to - match.recordingOffsetSec),
            team: entry.team, source: "claim",
            changedShirt: entry.shirtChanged,
          }];
        }).flat();
        if (values.length) await db.insert(matchTeamSpansTable).values(values);
      }
    } catch (error) {
      if (isMissingMatchTeamSpansTable(error)) {
        warnOptionalMatchTeamSpansFailureOnce("claimGameTeamSpanWrite", error);
        res.status(503).json({
          error: "Team switches are temporarily unavailable until the database is updated.",
          code: "team_spans_unavailable",
        });
        return;
      }
      req.log?.warn?.({ recordingId: ctx.recordingId, error }, "Could not persist claim team switches");
    }
  }
  await db
    .insert(claimMatchProgressTable)
    .values({ userId: ctx.userId, recordingId: ctx.recordingId, gameState: state, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
      set: { gameState: state, updatedAt: new Date() },
    });

  const [progress] = await db
    .select({ claimedPercent: claimMatchProgressTable.claimedPercent, completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));

  res.json({
    ok: true,
    parts: chain.length,
    claimedPercent: progress?.claimedPercent ?? 0,
    completed: progress?.completed ?? false,
  });
});

router.delete("/recordings/:id/claim-match/game", async (req, res): Promise<void> => {
  const ctx = await begin(req, res, { includeSegments: false });
  if (!ctx) return;
  try {
    await persistChain(ctx, [], { chosen: null, fallback: null }, { kind: "decision", answeredFrame: null });
    await db.delete(claimMatchOffPitchSpansTable).where(and(
      eq(claimMatchOffPitchSpansTable.userId, ctx.userId),
      eq(claimMatchOffPitchSpansTable.recordingId, ctx.recordingId),
    ));
    await syncChainClaim(ctx, [], true);
    await db
      .update(claimMatchProgressTable)
      .set({ gameState: null, updatedAt: new Date() })
      .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));
    res.json({ ok: true });
  } catch (error) {
    console.error("[claim-game] reset failed", { recordingId: ctx.recordingId, error });
    res.status(500).json({ error: "Could not start over" });
  }
});

/**
 * GET /recordings/:id/claim-match/game/play[?a=L,a,b&b=L,a,b]
 *
 * The claimant's touches and passes, and the whole match split into two teams
 * by shirt colour. `a`/`b` override the saved team colours; without them the
 * saved choice is used, and without that the claimant's own kit against the
 * most contrasting kit on camera.
 */
router.get("/recordings/:id/claim-match/game/play", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to see your stats" });
    return;
  }
  const recordingId = Number.parseInt(String(req.params.id), 10);
  if (!Number.isSafeInteger(recordingId) || recordingId <= 0) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const access = await getClaimMatchWritableBundle(req, recordingId);
  if (access.status) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const play = await loadRecordingPlay(recordingId);
  if (!play) {
    res.status(404).json({ error: "No tracking bundle" });
    return;
  }
  const identity = (access.row?.bundle?.manifest.identities ?? []).find((item) => item.id === claimIdentityId(userId, recordingId));
  // Only the match counts: the claimant's parts, and every touch, dribble and
  // detected event the stats screen sums, are cut to the match window.
  const window = readMatchWindow(play.manifest);
  const inWindow = (t: number) => !window || (t >= window.startSeconds && t < window.endSeconds);
  const parts: ClaimedPart[] = clipPartsToMatchWindow(
    (identity?.parts ?? []).map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })),
    play.manifest,
  );
  const touches = window ? play.touches.filter((t) => inWindow(t.t)) : play.touches;
  const playDribbles = window ? play.dribbles.filter((d) => inWindow(d.t0)) : play.dribbles;
  const playEvents = window ? play.events.filter((e) => inWindow(e.t)) : play.events;
  const ownKit = kitOfParts(parts, play.sidecars, play.fps);

  const [row] = await db
    .select({ gameState: claimMatchProgressTable.gameState })
    .from(claimMatchProgressTable)
    .where(and(eq(claimMatchProgressTable.userId, userId), eq(claimMatchProgressTable.recordingId, recordingId)));
  const saved = (row?.gameState as { teams?: { a?: unknown; b?: unknown } } | null)?.teams;
  const savedPick = saved && Array.isArray(saved.a) && Array.isArray(saved.b)
    ? { a: saved.a as Lab, b: saved.b as Lab }
    : null;
  const qa = parseLab(req.query.a);
  const qb = parseLab(req.query.b);
  let pick: TeamPick | null = null;
  let source: "query" | "saved" | "seeded" | null = null;
  if (qa && qb) { pick = { a: qa, b: qb }; source = "query"; }
  else if (savedPick) { pick = savedPick; source = "saved"; }
  else { pick = seedTeams(ownKit, play.kitOptions); source = pick ? "seeded" : null; }
  if (!play.hasKits) { pick = null; source = null; }

  const events = passEvents(touches, pick);
  const mine = playerPlay(touches, events, parts, Boolean(pick));
  const pitch = pitchSizeOf(play.manifest);
  const goals = detectedGoals(playEvents, touches, pitch, goalContext(play));
  const shots = detectedShots(playEvents, touches, pitch);
  const own = playerMoments(parts, playDribbles, goals, shots);
  const perSide = <T extends { kit: Lab | null }>(rows: T[]): [number, number] => {
    const n: [number, number] = [0, 0];
    for (const r of rows) { const side = sideOfKit(r.kit, pick); if (side !== null) n[side]++; }
    return n;
  };
  const dribbleTeams = pick ? teamDribbles(playDribbles, play.kits, pick) : null;
  res.json({
    available: play.hasBall,
    hasPitch: play.hasPitch,
    hasKits: play.hasKits,
    fps: play.fps,
    kits: play.kitOptions,
    ownKit,
    teams: pick ? { a: pick.a, b: pick.b, source } : null,
    team: pick ? {
      ...teamStats(touches, events, pick),
      dribbles: dribbleTeams!.total,
      dribblesWon: dribbleTeams!.won,
      dribblesLost: dribbleTeams!.lost,
      shots: perSide(shots),
      goals: perSide(goals),
    } : null,
    totals: { touches: touches.length, rejected: play.rejected },
    rule: { passMetres: PASS.passMetres, contestMetres: PASS.contestMetres, maxGapSeconds: PASS.maxGapSeconds },
    mine: {
      touches: mine.touches.map((t) => ({ f: t.f, t: t.t, trackId: t.trackId, ball: t.ball, foot: t.foot })),
      passes: mine.passes,
      passesTried: mine.passesTried,
      passesCompleted: mine.passesCompleted,
      passesReceived: mine.passesReceived,
      dribbles: own.dribbles.map((d) => ({ f0: d.f0, f1: d.f1, t0: d.t0, t1: d.t1, from: d.from, to: d.to, metres: d.metres, touches: d.touches, beaten: d.beaten, outcome: d.outcome, trackId: d.trackId })),
      dribblesWon: own.dribblesWon,
      dribblesLost: own.dribblesLost,
      goals: own.goals.map((g) => ({ t: g.t, trackId: g.trackId })),
      shots: own.shots.map((x) => ({ t: x.t, trackId: x.trackId })),
    },
    dribbleRule: { minMetres: DRIBBLE.minMetres, outcomeSeconds: DRIBBLE.outcomeSeconds, total: playDribbles.length },
  });
});

export default router;

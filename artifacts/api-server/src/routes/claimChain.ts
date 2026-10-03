/**
 * The claim chain API.
 *
 * A claim is one ordered chain of track pieces, and the chain IS an identity —
 * the same object the Identity Board edits, stored in the same place. That is
 * not an implementation convenience, it is the requirement: a merge made while
 * watching the video has to be a merge on the board, and the only way to make
 * that true rather than synchronised is to have one map with two editors.
 *
 * Every decision also writes a label. See lib/claimChainLabels — an override is
 * ground truth, and this is the corpus the tracker has never had.
 *
 * THE THING MOST LIKELY TO GO WRONG
 *
 * manifest.identities is a single jsonb blob on one row, and there can be
 * several claimants on a recording plus an admin on the board, all rewriting
 * it. A read-modify-write without a lock loses one of them silently, which is
 * the worst possible failure here: no error, and someone's claim quietly
 * reverts. Every write in this file takes `SELECT ... FOR UPDATE` on the bundle
 * row inside a transaction, and re-reads the manifest inside that lock rather
 * than trusting the copy it was handed.
 */
import { Router, type IRouter } from "express";
import { loadRecordingPlay } from "../lib/matchPlayLoad";
import { invalidateMatchStatsCacheForRecording } from "../lib/matchStatsCache";
import { queueMatchStatsCacheForRecording } from "../lib/matchStatsCacheJobs";
import { mergeMoments, personalMoments, type FollowPoint } from "../lib/personalMoments";
import type { ClaimEarnedClip } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "crypto";
import { z } from "zod";
import { writeFindDecisionLabelOnce, type FindDecisionLabelStore } from "../lib/idempotentFindDecisionLabel";
import {
  loadClaimBundleSegments,
  type CachedTrack,
  type CachedTrackingSegment,
} from "../lib/claimBundleSegments";

import {
  db,
  claimChainLabelsTable,
  claimMatchIdentityBindingsTable,
  claimMatchOffPitchSpansTable,
  claimMatchProgressTable,
  recordingTrackingBundlesTable,
  recordingsTable,
  usersTable,
  type ClaimChainLabelRow,
  type TrackingIdentity,
  type TrackingManifest,
} from "@workspace/db";
import { unauthenticatedResponse } from "../lib/clerkUserBridge";
import {
  getClaimMatchWritableBundle,
  materializeClaimMoments,
  readBundleSegments,
  requireAccountUser,
  syncIdentityBinding,
  trackingBundleFingerprint,
} from "./claimMatch";
import { deriveChainClaimState, isChainComplete, requiredCoverageFor } from "../lib/claimChainState";
import { clipPartsToMatchWindow, matchWindowSeconds, offPitchWithMatchWindow } from "../lib/matchWindow";
import {
  captureDecisionGeometry,
  chainIntervals,
  cutChain,
  dropLastDecision,
  extendChain,
  isStruckOff,
  markAnswered,
  normaliseChain,
  openUncertainties,
  scanFloor,
  totalSeconds,
  withMarks,
  type ChainPart,
} from "../lib/claimChain";

const router: IRouter = Router();

/**
 * How many decisions "undo" can walk back.
 *
 * Each entry is a copy of the chain, stored on the identity row and rewritten
 * with the manifest on every tap, so this is deliberately small. Three is
 * enough to reverse a mis-tap and the two taps made before noticing it.
 */
const HISTORY_DEPTH = 3;

/**
 * Open questions the response carries. The earliest few are what the page
 * needs -- the next one ahead to stop at, the ones behind to list.
 */
const OPEN_QUESTIONS_LIMIT = 25;

const TapBody = z.object({
  trackId: z.string().min(1),
  frame: z.number().int().min(0),
  /** The track we were following and that turned out to be wrong, if any. */
  rejectedTrackId: z.string().min(1).nullish(),
  name: z.string().trim().min(1).max(60).nullish(),
  decisionMs: z.number().int().min(0).nullish(),
  /** Fingerprint the client was working from; a mismatch is a 409, not a merge. */
  bundleFingerprint: z.string().min(1).nullish(),
});

const FrameBody = z.object({
  frame: z.number().int().min(0),
  decisionMs: z.number().int().min(0).nullish(),
  bundleFingerprint: z.string().min(1).nullish(),
});

function boundedDecisionMs(value: number | null | undefined): number | null {
  return value == null ? null : Math.min(600_000, value);
}

/**
 * A claimant's identity id on a recording.
 *
 * Deterministic, so a user has exactly one claimed identity per recording and
 * a repeated tap edits it rather than minting another. Hashed rather than
 * `claim:u<id>` because the manifest is served to every claimant and to the
 * board, and an internal user id has no business travelling in it.
 */
export function claimIdentityId(userId: number, recordingId: number): string {
  const digest = createHash("sha256").update(`${userId}:${recordingId}`).digest("hex");
  return `claim:${digest.slice(0, 12)}`;
}

function crossingsFromSegments(segments: readonly CachedTrackingSegment[]) {
  return segments.flatMap((segment) => segment.crossings);
}

/**
 * The claimant's chain, with every part carrying its answered frontier.
 *
 * Parts stored before the per-part marks existed -- and parts the identity
 * board adds to the row -- have none. They get one from the legacy
 * chain-wide floor, which is exactly how they were scanned before, so an old
 * chain behaves as it did until its next write makes the marks explicit.
 */
function chainOf(manifest: TrackingManifest, identityId: string): ChainPart[] {
  const identity = (manifest.identities ?? []).find((item) => item.id === identityId);
  const parts = (identity?.parts ?? []).map((part) => ({ ...part }));
  return withMarks(parts, scanFloor(parts, null, identity?.reviewedThroughFrame ?? null));
}

/** The last frame tracking covers, for "the recording ended, we did not lose you". */
function trackedEndFrame(manifest: TrackingManifest): number {
  const fromSegments = (manifest.segments ?? []).map((segment) => segment.endFrame);
  if (fromSegments.length) return Math.max(...fromSegments);
  return Math.max(0, Math.round(manifest.duration * manifest.frameRate) - 1);
}

/**
 * Whether an identity row is a player's claim rather than a board row.
 *
 * Every claim made on the chain page or at /find is stored under
 * `claimIdentityId` ("claim:<hash>"), and the old anchor flow's split
 * fragments are "claim:<person>:<hash>" -- so the prefix alone identifies a
 * row a player built. `boundToOthers` adds board rows another player's live
 * binding points at (the anchor flow bound players to board rows directly).
 */
export function isPlayerClaimRow(
  identityId: string,
  boundToOthers: ReadonlySet<string> = new Set(),
): boolean {
  return identityId.startsWith("claim:") || boundToOthers.has(identityId);
}

/**
 * The identity rows other players' live bindings point at.
 *
 * Best effort: a database still waiting for the bindings migration has no
 * other players to protect, and a claim must never fail over it.
 */
async function rowsBoundToOtherPlayers(recordingId: number, userId: number): Promise<Set<string>> {
  try {
    const rows = await db
      .select({
        userId: claimMatchIdentityBindingsTable.userId,
        personId: claimMatchIdentityBindingsTable.personId,
        state: claimMatchIdentityBindingsTable.state,
      })
      .from(claimMatchIdentityBindingsTable)
      .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));
    return new Set(rows
      .filter((row) => row.userId !== userId && row.state !== "released" && row.state !== "rejected")
      .map((row) => row.personId));
  } catch (error) {
    console.error("[claim-chain] binding read failed", { recordingId, error });
    return new Set();
  }
}

export type ChainContext = {
  userId: number;
  recordingId: number;
  bundleId: number;
  manifest: TrackingManifest;
  segments: readonly CachedTrackingSegment[];
  tracksById: ReadonlyMap<string, CachedTrack>;
  fingerprint: string;
  identityId: string;
  /** Frames this claimant has already answered on this bundle. */
  answeredFrames: Set<number>;
  /**
   * The claimant's declared off-pitch spans.
   *
   * Here so `describe` can measure coverage exactly the way
   * `deriveChainClaimState` does. They used two different formulas: the page
   * showed `raw / duration` while completion, clips and the binding were
   * decided on `(raw - offPitch) / (duration - offPitch)`. With any off-pitch
   * declared, the number on screen was not the number that unlocked the match.
   */
  offPitch: Array<{ fromSeconds: number; toSeconds: number }>;
};

/**
 * The frames this claimant has already given an answer at.
 *
 * Read from the labels because they are already written on every decision, so
 * this needs no new state and survives a reload -- and because the alternative,
 * remembering it in the client, forgets the moment anyone refreshes and starts
 * asking the same question again.
 *
 * Tolerant of the table not existing: the label write is deliberately allowed
 * to fail without failing the claim, so the read must be too, or a missing
 * migration would turn a silently empty corpus into a broken claim page.
 */
async function answeredFramesFor(
  recordingId: number,
  userId: number,
  fingerprint: string,
): Promise<Set<number>> {
  try {
    const rows = await db
      .select({ atFrame: claimChainLabelsTable.atFrame })
      .from(claimChainLabelsTable)
      .where(and(
        eq(claimChainLabelsTable.recordingId, recordingId),
        eq(claimChainLabelsTable.userId, userId),
        eq(claimChainLabelsTable.bundleFingerprint, fingerprint),
      ));
    return new Set(rows.map((row) => row.atFrame));
  } catch (error) {
    console.error("[claim-chain] answered-frame read failed", { recordingId, error });
    return new Set();
  }
}

export async function loadContext(
  req: Parameters<typeof requireAccountUser>[0],
  recordingId: number,
  userId: number,
  options: { includeSegments?: boolean } = {},
): Promise<{ ctx?: ChainContext; status?: number; error?: string }> {
  const access = await getClaimMatchWritableBundle(req, recordingId);
  if (access.status) return { status: access.status, error: access.error ?? "Refused" };
  const row = access.row;
  const bundle = row?.bundle;
  if (!bundle?.manifest) return { status: 404, error: "Recording or tracking bundle not found" };

  const manifest = bundle.manifest;
  // Most uploaded bundles have the compact fingerprint summary. Endpoints
  // that only reset a claim can use it without reading the large segment
  // objects; older bundles still load once when the summary is absent because
  // their exact fingerprint must remain compatible with saved claims.
  const includeSegments = options.includeSegments !== false;
  const summarySegments = manifest.summary?.segments;
  const summaryFingerprint = summarySegments?.length
    ? trackingBundleFingerprint(manifest, summarySegments)
    : null;
  const needsCachedSegments = includeSegments || !summaryFingerprint;
  // The summary catches structural tracking changes; updatedAt also catches
  // a replacement of boxes whose track ids and frame ranges stayed the same.
  const bundleSegments = needsCachedSegments
    ? await loadClaimBundleSegments(
      `${bundle.id}:${bundle.updatedAt.toISOString()}:${summaryFingerprint ?? "legacy"}`,
      () => readBundleSegments(bundle.id),
      bundle.id,
    )
    : null;
  const fingerprint = summaryFingerprint
    ?? trackingBundleFingerprint(manifest, bundleSegments!.segments);
  return {
    ctx: {
      userId,
      recordingId,
      bundleId: bundle.id,
      manifest,
      segments: bundleSegments?.segments ?? [],
      tracksById: bundleSegments?.tracksById ?? new Map<string, CachedTrack>(),
      fingerprint,
      identityId: claimIdentityId(userId, recordingId),
      answeredFrames: await answeredFramesFor(recordingId, userId, fingerprint),
      // The time outside the recording's match window counts as off-pitch,
      // so describe() shows the same coverage deriveChainClaimState decides on.
      offPitch: offPitchWithMatchWindow(await db
        .select({
          fromSeconds: claimMatchOffPitchSpansTable.fromSeconds,
          toSeconds: claimMatchOffPitchSpansTable.toSeconds,
        })
        .from(claimMatchOffPitchSpansTable)
        .where(and(
          eq(claimMatchOffPitchSpansTable.recordingId, recordingId),
          eq(claimMatchOffPitchSpansTable.userId, userId),
        )), manifest),
    },
  };
}

function describe(
  ctx: ChainContext,
  chain: ChainPart[],
  name: string | null,
  labelRecorded: boolean | null = null,
  /** The claimant has no chain because an administrator released it. */
  resetByAdmin = false,
) {
  const spans = chainIntervals(chain, ctx.manifest, ctx.offPitch);
  /*
   * Scanned from frame 0, on reads and writes alike. Every answer is written
   * into the part it answers (`reviewedThrough`), so the write that records
   * an answer and the GET that follows it see the same chain and return the
   * same questions. The earlier design passed "the frame just answered" as a
   * floor on writes only, and the write and the refetch disagreed -- which is
   * how a stop ended up sitting on the playhead.
   */
  const open = openUncertainties(
    chain,
    ctx.tracksById,
    crossingsFromSegments(ctx.segments),
    0,
    ctx.manifest.identityDecisions,
    ctx.answeredFrames,
    trackedEndFrame(ctx.manifest),
    ctx.manifest.frameRate,
  );
  const uncertainty = open[0] ?? null;
  const offPitchSeconds = totalSeconds(ctx.offPitch.map((span) => ({
    startSeconds: span.fromSeconds,
    endSeconds: span.toSeconds,
  })));
  // Same numerator and same denominator as deriveChainClaimState, so the
  // number on screen is the number that decides completion and clips.
  const denominator = ctx.manifest.duration - offPitchSeconds;
  const coveragePercent = denominator <= 0
    ? 0
    : Math.min(100, Math.round((totalSeconds(spans) / denominator) * 10000) / 100);
  /*
   * WHY AM I BEING STOPPED SO OFTEN
   *
   * The chain only stops where a part has nothing to continue onto. If the
   * identity map has this person's pieces joined, extendChain takes the whole
   * person and there is no stop at all -- so constant stopping means the map
   * is not joining them, and that is upstream of anything the claim flow can
   * fix.
   *
   * There are exactly two ways it happens and they need different answers, so
   * reporting them separately turns "it keeps stopping" from a guess into a
   * fact: either the map is empty for this recording (nobody has run the
   * identity board), or it exists but its fingerprint does not match this
   * bundle, in which case usableIdentityMap discards ALL of it silently and
   * the map has to be rebuilt against the current tracking.
   */
  const identities = ctx.manifest.identities ?? [];
  const provenance = ctx.manifest.provenance ?? {};
  const mapMatchesBundle = typeof provenance.bundleFingerprint === "string"
    && typeof provenance.identityMapBundleFingerprint === "string"
    && provenance.bundleFingerprint === provenance.identityMapBundleFingerprint;

  return {
    recordingId: ctx.recordingId,
    identityId: ctx.identityId,
    identityMap: {
      people: identities.length,
      /** False means the whole map is being ignored, however full it looks. */
      matchesBundle: mapMatchesBundle,
      /** Source tracks in this bundle, for comparison with `people`. */
      tracks: ctx.tracksById.size,
      segments: ctx.segments.length,
      /**
       * Which linker produced this bundle, when the pipeline stamped it.
       *
       * Null means unstamped, which the identity board has always rendered as
       * "original linker" -- and until the upload parsers stopped discarding
       * provenance, that was every bundle ever uploaded regardless of what
       * made it. Comparing linker branches is impossible without this.
       */
      linker: typeof provenance.linker === "string"
        ? provenance.linker
        : typeof provenance.chain === "string"
          ? provenance.chain
          : null,
    },
    name,
    bundleFingerprint: ctx.fingerprint,
    frameRate: ctx.manifest.frameRate,
    /*
     * `tapFrame` is stripped here on purpose. It is bookkeeping the server
     * needs so an undo can reverse a whole decision rather than one part of a
     * board-merged person; the client draws boxes and never reads it, and the
     * generated contract has no field for it. Persist it, do not publish it.
     */
    chain: chain.map(({ trackId, fromFrame, toFrame }) => ({ trackId, fromFrame, toFrame })),
    coverageSeconds: totalSeconds(spans),
    coveragePercent,
    nextUncertainty: uncertainty,
    /**
     * Every question still open, earliest first.
     *
     * One question was enough while the chain only grew forward: the next
     * one was always ahead. A filled gap puts questions BEHIND the playhead,
     * and the page has to know both the next one ahead (to stop at) and the
     * ones behind (to list, never to fire on).
     */
    openQuestions: open.slice(0, OPEN_QUESTIONS_LIMIT),
    /**
     * Whether this claim now counts as the person's match. Computed here by
     * the same rule that awards clips, because until it was surfaced the page
     * reached the end of the recording and said nothing at all.
     */
    completed: isChainComplete({
      chainLength: chain.length,
      coveragePercent,
      durationSeconds: matchWindowSeconds(ctx.manifest),
      hasOpenQuestion: uncertainty !== null,
    }),
    requiredCoveragePercent: requiredCoverageFor(matchWindowSeconds(ctx.manifest)),
    /**
     * Whether this decision's training label actually landed.
     *
     * A label write is deliberately allowed to fail without failing the claim,
     * which means a missing table or a broken insert produces a corpus that
     * quietly stays empty while everything looks fine -- the same silent shape
     * as identityDecisions being written and read by nobody. Reporting it
     * makes the gap visible to the client and to anyone probing the endpoint.
     * Null on reads, which record nothing.
     */
    labelRecorded,
    resetByAdmin,
  };
}

/**
 * Remove every frame `taken` covers from `parts`, splitting a part in two when
 * the claim lands in its middle.
 *
 * Used so a claim never leaves the same track frames sitting under the claimant
 * AND a board row: claiming yourself in the video moves you on the board.
 * Another PLAYER's claim is the exception and is never passed through this --
 * two players may both pick the same person, and both are counted (see
 * persistChain). Everything downstream reads one player's own row at a time,
 * so two claim rows sharing frames is a supported state, not a duplicate.
 */
export function subtractParts(
  parts: TrackingIdentity["parts"],
  taken: ChainPart[],
): TrackingIdentity["parts"] {
  let out = parts.map((part) => ({ ...part }));
  for (const claim of taken) {
    const next: typeof out = [];
    for (const part of out) {
      if (part.trackId !== claim.trackId
        || part.toFrame < claim.fromFrame
        || part.fromFrame > claim.toFrame) {
        next.push(part);
        continue;
      }
      if (part.fromFrame < claim.fromFrame) {
        next.push({ ...part, toFrame: claim.fromFrame - 1 });
      }
      if (part.toFrame > claim.toFrame) {
        next.push({ ...part, fromFrame: claim.toFrame + 1 });
      }
    }
    out = next;
  }
  return out;
}

/**
 * Write the chain back into manifest.identities, under a row lock.
 *
 * Re-reads the manifest INSIDE the lock. The copy the request was built from
 * may be seconds old, and the board may have saved since; merging into a stale
 * copy is exactly how one editor's work disappears.
 */
export async function persistChain(
  ctx: ChainContext,
  chain: ChainPart[],
  /**
   * `chosen` is a name the person typed on THIS call; `fallback` is their
   * account name, used only when nothing has ever been set.
   *
   * Keeping these apart matters more than it looks. Only the first tap carries
   * a name -- every later tap sends none -- so resolving the account fallback
   * before the write made each subsequent decision quietly rename the person
   * back from what they called themselves to whatever their account says. They
   * name themselves once and it has to stick.
   */
  name: { chosen: string | null; fallback?: string | null },
  /**
   * What kind of write this is.
   *
   * A `decision` stores `chain` and pushes the chain it replaces onto the
   * identity's history; `answeredFrame` also advances the legacy chain-wide
   * mark for builds that still read it. An `undo` ignores `chain` and
   * restores the newest history entry -- inside the lock, from the row as it
   * is now, never from a copy the request was built on.
   */
  write: { kind: "decision"; answeredFrame: number | null } | { kind: "undo" },
): Promise<{ chain: ChainPart[]; name: string | null; reviewedThroughFrame: number }> {
  // Read outside the transaction: a failed query inside it would abort the
  // whole write, and this read is allowed to fail.
  const boundToOthers = await rowsBoundToOtherPlayers(ctx.recordingId, ctx.userId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from ${recordingTrackingBundlesTable} where id = ${ctx.bundleId} for update`,
    );
    const [fresh] = await tx
      .select({ manifest: recordingTrackingBundlesTable.manifest })
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.id, ctx.bundleId));
    const manifest = (fresh?.manifest ?? ctx.manifest) as TrackingManifest;

    const existing = (manifest.identities ?? []).find((item) => item.id === ctx.identityId);
    const nextName = name.chosen ?? existing?.name ?? name.fallback ?? null;
    const priorHistory = existing?.history ?? [];

    let next: ChainPart[];
    let reviewedThroughFrame: number;
    let history: NonNullable<TrackingIdentity["history"]>;
    if (write.kind === "undo") {
      const restored = priorHistory[priorHistory.length - 1];
      if (restored) {
        // A snapshot taken of a chain written before per-part marks existed
        // carries none; give it the same upgrade a load would.
        const parts = restored.parts.map((part) => ({ ...part }));
        next = normaliseChain(
          withMarks(parts, scanFloor(parts, null, restored.reviewedThroughFrame ?? null)),
          ctx.tracksById,
        );
        reviewedThroughFrame = restored.reviewedThroughFrame ?? 0;
        history = priorHistory.slice(0, -1);
      } else {
        // A chain from before the history existed: the old grouping undo,
        // and the old rule for the mark -- back to just past the newest
        // remaining decision so the reversed one is askable again.
        const current = withMarks(
          (existing?.parts ?? []).map((part) => ({ ...part })),
          scanFloor(existing?.parts ?? [], null, existing?.reviewedThroughFrame ?? null),
        );
        next = normaliseChain(dropLastDecision(current), ctx.tracksById);
        const stamps = next
          .map((part) => part.tapFrame)
          .filter((frame): frame is number => typeof frame === "number");
        reviewedThroughFrame = stamps.length ? Math.max(...stamps) + 1 : 0;
        history = [];
      }
    } else {
      next = chain;
      reviewedThroughFrame = Math.max(
        existing?.reviewedThroughFrame ?? 0,
        write.answeredFrame === null ? 0 : write.answeredFrame + 1,
      );
      // The chain before this decision -- an empty one for the first tap, so
      // that too can be undone.
      history = [...priorHistory, {
        parts: (existing?.parts ?? []).map((part) => ({ ...part })),
        ...(existing?.reviewedThroughFrame === undefined
          ? {}
          : { reviewedThroughFrame: existing.reviewedThroughFrame }),
      }].slice(-HISTORY_DEPTH);
    }

    // Anything this claim now holds is taken off the BOARD row that held it
    // -- that is what makes the board and the video one map instead of two
    // views that disagree, and it is the requirement stated directly:
    // claiming yourself in the video moves you on the board.
    //
    // Another player's claim is never taken from. Two people can pick the
    // same person in the video, and the owner's rule (2026-10-03) is that it
    // "shouldn't take away, should be counted for both": both rows keep the
    // shared frames, and each player's coverage, binding, clips and stats are
    // read from their own row. Before this, the second claimant silently
    // stripped the first.
    const others = (manifest.identities ?? [])
      .filter((item) => item.id !== ctx.identityId)
      .map((item) => (isPlayerClaimRow(item.id, boundToOthers)
        ? item
        : { ...item, parts: subtractParts(item.parts, next) }))
      .filter((item) => item.parts.length > 0);

    const identities: TrackingIdentity[] = next.length
      ? [...others, {
        id: ctx.identityId,
        name: nextName,
        parts: next.map((p) => ({ ...p })),
        reviewedThroughFrame,
        ...(history.length ? { history } : {}),
      }]
      : others;

    await tx
      .update(recordingTrackingBundlesTable)
      .set({
        manifest: {
          ...manifest,
          identities,
          provenance: {
            ...(manifest.provenance ?? {}),
            // Both, and both to the CURRENT bundle. usableIdentityMap returns
            // nothing unless these two agree, so leaving a stale
            // bundleFingerprint in place would silently make the claimant's
            // own work invisible to the coverage it was meant to produce --
            // the same shape of failure the read/write asymmetry had.
            // ctx.fingerprint is computed from the bundle being written, so it
            // is current by construction. This matches the identity board's
            // own save exactly.
            bundleFingerprint: ctx.fingerprint,
            identityMapBundleFingerprint: ctx.fingerprint,
          },
        } as TrackingManifest,
      })
      .where(eq(recordingTrackingBundlesTable.id, ctx.bundleId));

    return { chain: next, name: nextName, reviewedThroughFrame };
  });
}

/**
 * Make a chain claim count for everything an anchor claim counted for.
 *
 * Coverage, the identity binding, completion, earned clips and player stats
 * all live in `claim_match_progress` and `claim_match_identity_bindings`, and
 * every one of them was fed exclusively by anchor answers. Until this existed
 * a person could follow themselves through a whole match and finish with a
 * named row on the identity board, a coverage number on screen, and nothing
 * else: no binding, no completion, no clips, no stats.
 *
 * It reuses syncIdentityBinding rather than writing the binding directly, so
 * the split, dispute and vouched-fragment-protection rules stay in one place
 * and keep applying to claimants who arrive by either route.
 *
 * Never allowed to fail the claim, for the same reason the label write is not:
 * the person is mid-flow, and losing their tap because a clip could not be
 * materialised would be a worse trade than a late award.
 */
export async function syncChainClaim(
  ctx: ChainContext,
  chain: ChainPart[],
  hasOpenQuestion: boolean,
): Promise<void> {
  try {
    const offPitchRows = await db
      .select({
        fromSeconds: claimMatchOffPitchSpansTable.fromSeconds,
        toSeconds: claimMatchOffPitchSpansTable.toSeconds,
      })
      .from(claimMatchOffPitchSpansTable)
      .where(and(
        eq(claimMatchOffPitchSpansTable.recordingId, ctx.recordingId),
        eq(claimMatchOffPitchSpansTable.userId, ctx.userId),
      ));

    const state = deriveChainClaimState(
      ctx.manifest,
      ctx.segments.map((segment) => ({ tracks: segment.tracks, events: segment.events })),
      chain,
      { offPitch: offPitchRows, hasOpenQuestion },
    );

    const [bundle] = await db
      .select()
      .from(recordingTrackingBundlesTable)
      .where(eq(recordingTrackingBundlesTable.id, ctx.bundleId));

    let binding: Awaited<ReturnType<typeof syncIdentityBinding>> = null;
    if (bundle) {
      binding = await syncIdentityBinding(ctx.userId, ctx.recordingId, bundle, {
        // The person pointed at themselves. There is no vote to be ambiguous
        // about, so there are no conflict moments and support is total --
        // which is the whole reason this model replaced the other one.
        identityResolution: chain.length
          ? {
            personId: ctx.identityId,
            resolutionMethod: "chain",
            supportCount: chain.length,
            acceptedAnswerCount: ctx.answeredFrames.size,
            supportPercent: 100,
            conflictMoments: [],
          }
          : null,
        vouchedFragments: state.vouchedFragments,
      });
    }

    // Clips only become real user_clips on completion. Materialising earlier
    // would litter My Clips with clips from a claim the person may still
    // truncate with "that is not me".
    //
    // Only a binding that is not confirmed holds the award back. A chain or
    // /find claim binds the player to their OWN row (claimIdentityId), so two
    // players who picked the same person are two confirmed bindings and both
    // get their clips: sharing frames with another claim is never a dispute.
    // What can still hold this back is a binding a bundle replacement marked
    // needs_resolution, or a legacy anchor-flow binding to a shared board row
    // (the bindings table allows one confirmed binding per row).
    const bindingAwards = !binding || binding.state === "confirmed";
    let earnedClips: Array<ClaimEarnedClip & { follow?: FollowPoint[] }> = state.earnedClips.map((clip) => ({ ...clip }));
    if (state.completed && bindingAwards) {
      // With ball data the claim earns the claimant's OWN moments -- their
      // goals, shots, take-ons won and long passes -- each framed on them.
      try {
        const play = await loadRecordingPlay(ctx.recordingId);
        if (play?.hasBall) {
          // Only the match: parts outside the window earn no moments.
          const parts = clipPartsToMatchWindow(
            chain.map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })),
            ctx.manifest,
          );
          earnedClips = mergeMoments(earnedClips, personalMoments(play, parts, ctx.segments, ctx.manifest));
        }
      } catch (error) {
        console.error("[claim-chain] personal moments failed", { recordingId: ctx.recordingId, error });
      }
    }
    if (state.completed && bindingAwards) {
      const [recording] = await db
        .select()
        .from(recordingsTable)
        .where(eq(recordingsTable.id, ctx.recordingId));
      if (recording) {
        earnedClips = await materializeClaimMoments(
          ctx.userId, recording, ctx.manifest, earnedClips,
        );
      }
    }

    const values = {
      userId: ctx.userId,
      recordingId: ctx.recordingId,
      currentTrackId: chain.length ? chain[chain.length - 1].trackId : null,
      stage: state.completed ? "done" : chain.length ? "follow" : "find",
      confirmedFromSeconds: state.attributed[0]?.startSeconds ?? 0,
      currentPositionSeconds: state.attributed[state.attributed.length - 1]?.endSeconds ?? 0,
      claimedPercent: state.coveragePercent,
      clipsUnlocked: state.completed && bindingAwards ? earnedClips.length : 0,
      correctionCount: ctx.answeredFrames.size,
      completed: state.completed,
      earnedClips: earnedClips.map(({ follow: _follow, ...clip }) => clip),
      updatedAt: new Date(),
    };
    await db
      .insert(claimMatchProgressTable)
      .values(values)
      .onConflictDoUpdate({
        target: [claimMatchProgressTable.userId, claimMatchProgressTable.recordingId],
        set: values,
      });
    await invalidateMatchStatsCacheForRecording(ctx.recordingId);
    if (state.completed && bindingAwards) {
      queueMatchStatsCacheForRecording(ctx.recordingId, 700);
    }
  } catch (error) {
    console.error("[claim-chain] claim sync failed", { recordingId: ctx.recordingId, error });
  }
}

/**
 * Re-derive every claim on a recording after something that changes what a
 * claim is worth without changing the claim -- the match window.
 *
 * Coverage, completion and the earned-clip list are stored on the progress
 * row by syncChainClaim, so a window set after the claims were made would
 * leave them describing the old window until each claimant next tapped. This
 * runs the same sync for every claimant with a progress row.
 *
 * It can only take an award away, never grant one: a claim that was complete
 * is re-judged with no open question (it was settled), and one that was not
 * is re-judged as still open, so it completes on the claimant's own next
 * save -- the person finishes their claim, not an admin's edit. Clips already
 * materialised into My Clips are left where they are; only the progress row's
 * list changes. Best effort per claimant, like syncChainClaim itself.
 */
export async function resyncChainClaimsForRecording(
  req: Parameters<typeof requireAccountUser>[0],
  recordingId: number,
): Promise<number> {
  const rows = await db
    .select({ userId: claimMatchProgressTable.userId, completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(eq(claimMatchProgressTable.recordingId, recordingId));
  let synced = 0;
  for (const row of rows) {
    try {
      const loaded = await loadContext(req, recordingId, row.userId);
      if (!loaded.ctx) continue;
      const chain = chainOf(loaded.ctx.manifest, loaded.ctx.identityId);
      if (!chain.length) continue;
      await syncChainClaim(loaded.ctx, chain, !row.completed);
      synced++;
    } catch (error) {
      console.error("[claim-chain] resync failed", { recordingId, userId: row.userId, error });
    }
  }
  return synced;
}

async function recordLabel(
  ctx: ChainContext,
  kind: "switch" | "lost" | "confirm",
  frame: number,
  opts: { wrongTrackId?: string | null; rightTrackId?: string | null; decisionMs?: number | null },
): Promise<boolean> {
  const geom = captureDecisionGeometry(ctx.tracksById, frame, {
    frameRate: ctx.manifest.frameRate,
    chosenTrackId: opts.rightTrackId ?? null,
    rejectedTrackId: opts.wrongTrackId ?? null,
    crossings: crossingsFromSegments(ctx.segments),
    decisions: ctx.manifest.identityDecisions,
  });
  try {
    await db.insert(claimChainLabelsTable).values({
      userId: ctx.userId,
      recordingId: ctx.recordingId,
      bundleFingerprint: ctx.fingerprint,
      kind,
      atFrame: frame,
      wrongTrackId: opts.wrongTrackId ?? null,
      rightTrackId: opts.rightTrackId ?? null,
      decisionMs: opts.decisionMs ?? null,
      geom: geom as unknown as Record<string, unknown>,
      detectorSwapEvidence: geom.detector.swapEvidence,
    });
    return true;
  } catch (error) {
    // A label is valuable, but never at the cost of the claim itself: the
    // person is mid-flow and losing their tap to a logging failure is worse
    // than losing the training row.
    console.error("[claim-chain] label write failed", { recordingId: ctx.recordingId, kind, error });
    return false;
  }
}

/**
 * The whole-game flow sends an explicit request for each decision rather than
 * attaching labels to its autosave. Use the existing row fields as the
 * idempotency key: there is no separate decision id in this label shape.
 *
 * The transaction lock makes concurrent retries of the same decision safe
 * across server processes, while allowing distinct decisions at the same frame
 * to remain distinct rows.
 */
export async function recordFindDecisionLabel(
  ctx: ChainContext,
  kind: "switch" | "lost" | "confirm",
  frame: number,
  opts: { wrongTrackId?: string | null; rightTrackId?: string | null; decisionMs?: number | null },
): Promise<boolean> {
  const geom = captureDecisionGeometry(ctx.tracksById, frame, {
    frameRate: ctx.manifest.frameRate,
    chosenTrackId: opts.rightTrackId ?? null,
    rejectedTrackId: opts.wrongTrackId ?? null,
    crossings: crossingsFromSegments(ctx.segments),
    decisions: ctx.manifest.identityDecisions,
  });
  const row = {
    userId: ctx.userId,
    recordingId: ctx.recordingId,
    bundleFingerprint: ctx.fingerprint,
    kind,
    atFrame: frame,
    wrongTrackId: opts.wrongTrackId ?? null,
    rightTrackId: opts.rightTrackId ?? null,
    decisionMs: opts.decisionMs ?? null,
    geom: geom as unknown as Record<string, unknown>,
    detectorSwapEvidence: geom.detector.swapEvidence,
  };
  try {
    const store: FindDecisionLabelStore<typeof row> = {
      withDecisionLock: (decisionKey, action) => db.transaction(async (tx) => {
        await tx.execute(sql`
          select pg_advisory_xact_lock(
            hashtext(${decisionKey}),
            hashtext('claim_chain_labels')
          )
        `);
        return action({
          exists: async (identity) => {
            const [existing] = await tx
              .select({ id: claimChainLabelsTable.id })
              .from(claimChainLabelsTable)
              .where(and(
                eq(claimChainLabelsTable.userId, identity.userId),
                eq(claimChainLabelsTable.recordingId, identity.recordingId),
                eq(claimChainLabelsTable.bundleFingerprint, identity.bundleFingerprint),
                eq(claimChainLabelsTable.kind, identity.kind),
                eq(claimChainLabelsTable.atFrame, identity.atFrame),
                identity.wrongTrackId === null
                  ? sql`${claimChainLabelsTable.wrongTrackId} is null`
                  : eq(claimChainLabelsTable.wrongTrackId, identity.wrongTrackId),
                identity.rightTrackId === null
                  ? sql`${claimChainLabelsTable.rightTrackId} is null`
                  : eq(claimChainLabelsTable.rightTrackId, identity.rightTrackId),
              ))
              .limit(1);
            return Boolean(existing);
          },
          insert: async (candidate) => {
            await tx.insert(claimChainLabelsTable).values(candidate);
          },
        });
      }),
    };
    return await writeFindDecisionLabelOnce(row, store);
  } catch (error) {
    console.error("[claim-game] label write failed", { recordingId: ctx.recordingId, kind, error });
    return false;
  }
}

function parseId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function begin(
  req: any,
  res: any,
  options: { includeSegments?: boolean } = {},
) {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return null;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return null;
  }
  const loaded = await loadContext(req, recordingId, userId, options);
  if (!loaded.ctx) {
    res.status(loaded.status ?? 500).json({ error: loaded.error ?? "Refused" });
    return null;
  }
  return loaded.ctx;
}

/** A client working from a different bundle must reload, never merge blindly. */
function fingerprintConflict(ctx: ChainContext, sent: string | null | undefined, res: any): boolean {
  if (sent && sent !== ctx.fingerprint) {
    res.status(409).json({
      error: "This recording's tracking has been replaced. Reload before continuing your claim.",
      currentBundleFingerprint: ctx.fingerprint,
    });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */

router.get("/recordings/:id/claim-match/chain", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const identity = (ctx.manifest.identities ?? []).find((item) => item.id === ctx.identityId);
  const chain = chainOf(ctx.manifest, ctx.identityId);
  // No chain, but a binding an admin released: the claim was taken away, not
  // never made. Without saying so the page just looks like a fresh start and
  // the person's coverage has silently gone to zero.
  let resetByAdmin = false;
  if (!chain.length) {
    const [own] = await db
      .select({ state: claimMatchIdentityBindingsTable.state })
      .from(claimMatchIdentityBindingsTable)
      .where(and(
        eq(claimMatchIdentityBindingsTable.recordingId, ctx.recordingId),
        eq(claimMatchIdentityBindingsTable.userId, ctx.userId),
      ));
    resetByAdmin = own?.state === "released";
  }
  res.json(describe(ctx, chain, identity?.name ?? null, null, resetByAdmin));
});

/**
 * "That is me, here." The only way a chain grows.
 *
 * Also the moment a name is set: the claimant names themselves and that name
 * is what the board shows, because a row labelled by the person in it beats
 * one labelled by whoever was doing the linking.
 */
router.post("/recordings/:id/claim-match/chain/tap", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const body = TapBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (fingerprintConflict(ctx, body.data.bundleFingerprint, res)) return;

  const { trackId, frame } = body.data;
  if (!ctx.tracksById.has(trackId)) {
    res.status(400).json({ error: "No such track in this recording" });
    return;
  }
  if (isStruckOff(ctx.manifest.identityDecisions, trackId, frame)) {
    res.status(400).json({ error: "That piece has been removed on the identity board" });
    return;
  }

  const current = chainOf(ctx.manifest, ctx.identityId);
  const next = extendChain(current, ctx.tracksById, trackId, frame, {
    decisions: ctx.manifest.identityDecisions,
    identities: (ctx.manifest.identities ?? [])
      .filter((item) => item.id !== ctx.identityId)
      .map((item) => ({ id: item.id, parts: item.parts })),
  });

  // No refusal for frames another player has claimed or vouched for: picking
  // someone another player already picked counts for both of them, and
  // persistChain leaves the other player's row untouched. (This used to be a
  // 409, "Another player has already vouched for that stretch.")

  // Always fetched, never conditionally: making the read depend on what this
  // request happens to know about the identity would leave the ordering rule
  // inside the lock -- the rule that actually protects the person's chosen
  // name -- unreachable, and therefore untested and free to rot.
  const [account] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, ctx.userId));

  const saved = await persistChain(ctx, next, {
    chosen: body.data.name ?? null,
    fallback: account?.name ?? null,
  }, { kind: "decision", answeredFrame: frame });
  const labelRecorded = await recordLabel(
    ctx,
    body.data.rejectedTrackId ? "switch" : "confirm",
    frame,
    {
      wrongTrackId: body.data.rejectedTrackId ?? null,
      rightTrackId: trackId,
      decisionMs: boundedDecisionMs(body.data.decisionMs),
    },
  );
  // The response has to reflect the answer just given, whether or not the row
  // landed. Otherwise the reply to an answer re-asks the same question, and
  // the person is stuck on it for as long as they keep answering.
  ctx.answeredFrames.add(frame);
  const body_ = describe(ctx, saved.chain, saved.name, labelRecorded);
  await syncChainClaim(ctx, saved.chain, body_.nextUncertainty !== null);
  res.json(body_);
});

/**
 * "That is not me, and has not been since here."
 *
 * Always available. The swap detector is weakest exactly where swaps are most
 * likely — two players moving in parallel, where both readings fit equally —
 * so a detector that were the only way out of a wrong chain would have
 * unrecoverable misses.
 */
router.post("/recordings/:id/claim-match/chain/not-me", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const body = FrameBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (fingerprintConflict(ctx, body.data.bundleFingerprint, res)) return;

  const current = chainOf(ctx.manifest, ctx.identityId);
  const wrong = current.find((part) =>
    body.data.frame >= part.fromFrame && body.data.frame <= part.toFrame);
  // Cuts the decision being followed here, not the whole future: what the
  // person claimed further on by later taps is theirs and stays.
  const next = normaliseChain(cutChain(current, body.data.frame), ctx.tracksById);

  const saved = await persistChain(ctx, next, { chosen: null },
    { kind: "decision", answeredFrame: body.data.frame });
  const labelRecorded = await recordLabel(ctx, "lost", body.data.frame, {
    wrongTrackId: wrong?.trackId ?? null,
    decisionMs: boundedDecisionMs(body.data.decisionMs),
  });
  ctx.answeredFrames.add(body.data.frame);
  const body_ = describe(ctx, saved.chain, saved.name, labelRecorded);
  await syncChainClaim(ctx, saved.chain, body_.nextUncertainty !== null);
  res.json(body_);
});

/**
 * "Yes, still me." Recorded because silence is not a label.
 *
 * Playing through a crossing without objecting means "I did not notice", and
 * the swaps a viewer will not notice are the ones a model most needs. Only an
 * answered question is evidence.
 */
router.post("/recordings/:id/claim-match/chain/confirm", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const body = FrameBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // tap and not-me both refuse a client working from a replaced bundle. This
  // one carried the field, the client sent it, and nothing read it.
  if (fingerprintConflict(ctx, body.data.bundleFingerprint, res)) return;
  const current = chainOf(ctx.manifest, ctx.identityId);
  const part = current.find((p) => body.data.frame >= p.fromFrame && body.data.frame <= p.toFrame);
  const labelRecorded = await recordLabel(ctx, "confirm", body.data.frame, {
    rightTrackId: part?.trackId ?? null,
    decisionMs: boundedDecisionMs(body.data.decisionMs),
  });
  // "Yes, still me" changes nothing about the chain, so without this the
  // reply carries the identical uncertainty and the person is asked the same
  // question the instant playback resumes -- forever.
  ctx.answeredFrames.add(body.data.frame);
  // A confirm used to leave the chain alone and relied on the labels table to
  // be remembered. It is written into the part it answers now, which is what
  // makes it survive a refetch -- and a database without that table.
  const saved = await persistChain(ctx, markAnswered(current, body.data.frame), { chosen: null },
    { kind: "decision", answeredFrame: body.data.frame });
  const body_ = describe(ctx, saved.chain, saved.name, labelRecorded);
  await syncChainClaim(ctx, saved.chain, body_.nextUncertainty !== null);
  res.json(body_);
});

/**
 * Undo the last decision. Deliberately does not write a label — a mis-tap is
 * not evidence.
 *
 * Restores the chain as it was before the newest decision, from the history
 * the identity carries. Not "drop the parts with the newest stamp": once a
 * gap can be filled, the newest stamp is the newest FRAME, and undoing after
 * a fill at 2:00 would have thrown away the tap at 9:00 instead.
 */
router.delete("/recordings/:id/claim-match/chain/last", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const saved = await persistChain(ctx, [], { chosen: null }, { kind: "undo" });
  const body_ = describe(ctx, saved.chain, saved.name, null);
  // An undo has to sync too, or a claim can be walked backwards while its
  // binding and its clips stay where the high-water mark left them.
  await syncChainClaim(ctx, saved.chain, body_.nextUncertainty !== null);
  res.json(body_);
});

/**
 * The training set, for whoever is scoring a linker.
 *
 * Admin-only, and scoped to one bundle fingerprint by default: track ids are
 * bundle-relative, so labels from a replaced bundle describe tracks that no
 * longer exist and must never be mixed into a scoring run.
 */
router.get("/admin/recordings/:id/claim-chain-labels", async (req, res): Promise<void> => {
  const userId = await requireAccountUser(req);
  if (!userId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const [user] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const fingerprint = typeof req.query.bundleFingerprint === "string"
    ? req.query.bundleFingerprint
    : null;
  // Same tolerance as the write and the answered-frame read: a deployment
  // that has not run the labels migration yet has an empty corpus, not a
  // broken endpoint.
  let rows: ClaimChainLabelRow[] = [];
  try {
    rows = await db
      .select()
      .from(claimChainLabelsTable)
      .where(fingerprint
        ? and(
          eq(claimChainLabelsTable.recordingId, recordingId),
          eq(claimChainLabelsTable.bundleFingerprint, fingerprint),
        )
        : eq(claimChainLabelsTable.recordingId, recordingId));
  } catch (error) {
    console.error("[claim-chain] label export read failed", { recordingId, error });
  }
  res.json({
    recordingId,
    bundleFingerprint: fingerprint,
    count: rows.length,
    labels: rows,
  });
});

const ChainForUserBody = z.object({
  userId: z.number().int().positive(),
  parts: z.array(z.object({
    trackId: z.string().min(1),
    fromFrame: z.number().int().min(0),
    toFrame: z.number().int().min(0),
  })).min(1).max(2000),
  name: z.string().trim().min(1).max(60).nullish(),
  /** The bundle the admin built the parts against; a mismatch is a 409. */
  bundleFingerprint: z.string().min(1),
  /** Validate and return the state the chain would have, writing nothing. */
  dryRun: z.boolean().optional(),
});

/**
 * Check admin-supplied parts against the bundle and turn them into a chain.
 *
 * Every part is marked fully reviewed (`reviewedThrough = toFrame + 1`). An
 * administrator who sets a chain has watched it, so it is an answered chain:
 * left unmarked, `openUncertainties` would raise every crossing and track end
 * inside it again, the claim would sit "not completed" behind an open question,
 * and the player would be asked to re-confirm a chain they never built. A
 * later "that is not me" or tap by the player still edits it as usual.
 *
 * Exported for the tests.
 */
export function chainFromAdminParts(
  parts: Array<{ trackId: string; fromFrame: number; toFrame: number }>,
  tracksById: ReadonlyMap<string, CachedTrack>,
): { chain: ChainPart[] } | { error: string } {
  for (const [index, part] of parts.entries()) {
    const track = tracksById.get(part.trackId);
    if (!track) return { error: `parts[${index}]: no track ${part.trackId} in this bundle` };
    if (part.toFrame < part.fromFrame) {
      return { error: `parts[${index}]: toFrame ${part.toFrame} is before fromFrame ${part.fromFrame}` };
    }
    if (part.fromFrame < track.startFrame || part.toFrame > track.endFrame) {
      return {
        error: `parts[${index}]: frames ${part.fromFrame}-${part.toFrame} fall outside track ${part.trackId} (${track.startFrame}-${track.endFrame})`,
      };
    }
  }
  // One person cannot be two tracks at once. Overlapping parts of one track
  // are harmless (normaliseChain merges them); overlapping different tracks
  // is a mistake in the request.
  const sorted = [...parts].sort((a, b) => a.fromFrame - b.fromFrame);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.trackId !== prev.trackId && cur.fromFrame <= prev.toFrame) {
      return {
        error: `parts overlap: ${prev.trackId} ${prev.fromFrame}-${prev.toFrame} and ${cur.trackId} ${cur.fromFrame}-${cur.toFrame}`,
      };
    }
  }
  const chain = normaliseChain(
    parts.map((part) => ({ ...part, reviewedThrough: part.toFrame + 1 })),
    tracksById,
  );
  return { chain };
}

/**
 * Set a player's claim chain on their behalf.
 *
 * For when the claim flow cannot get someone there -- a tracker that keeps
 * swapping them, a player who will not sit through it -- and an admin has
 * worked out which pieces are theirs on the identity board. It goes through
 * exactly what a player's own decisions go through: loadContext (as that
 * player), persistChain under the row lock (so their row moves off the board
 * rows it takes from, history and undo included) and syncChainClaim (binding,
 * completion, earned clips and stats). No training label is written: an
 * admin's assembly is not a decision at a frame.
 */
router.post("/admin/recordings/:id/claim-match/chain-for-user", async (req, res): Promise<void> => {
  const adminId = await requireAccountUser(req);
  if (!adminId) {
    unauthenticatedResponse(res, req, "Authenticated account required");
    return;
  }
  const [admin] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, adminId));
  if (!admin?.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const recordingId = parseId(req.params.id);
  if (!recordingId) {
    res.status(400).json({ error: "Invalid recording id" });
    return;
  }
  const body = ChainForUserBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [player] = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, body.data.userId));
  if (!player) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const loaded = await loadContext(req, recordingId, body.data.userId);
  if (!loaded.ctx) {
    res.status(loaded.status ?? 500).json({ error: loaded.error ?? "Refused" });
    return;
  }
  const ctx = loaded.ctx;
  if (body.data.bundleFingerprint !== ctx.fingerprint) {
    res.status(409).json({
      error: "This recording's tracking has been replaced. Rebuild the parts against the current bundle.",
      currentBundleFingerprint: ctx.fingerprint,
    });
    return;
  }

  const built = chainFromAdminParts(body.data.parts, ctx.tracksById);
  if ("error" in built) {
    res.status(400).json({ error: built.error });
    return;
  }

  const existing = (ctx.manifest.identities ?? []).find((item) => item.id === ctx.identityId);
  if (body.data.dryRun) {
    const preview = describe(ctx, built.chain, body.data.name ?? existing?.name ?? null);
    const state = deriveChainClaimState(
      ctx.manifest,
      ctx.segments.map((segment) => ({ tracks: segment.tracks, events: segment.events })),
      built.chain,
      { offPitch: ctx.offPitch, hasOpenQuestion: preview.nextUncertainty !== null },
    );
    res.json({
      dryRun: true,
      userId: body.data.userId,
      ...preview,
      completionReason: state.completionReason,
      earnedClipCount: state.earnedClips.length,
      binding: null,
      progress: null,
    });
    return;
  }

  const saved = await persistChain(ctx, built.chain, { chosen: body.data.name ?? null },
    { kind: "decision", answeredFrame: null });
  const described = describe(ctx, saved.chain, saved.name);
  await syncChainClaim(ctx, saved.chain, described.nextUncertainty !== null);

  const [binding] = await db
    .select({
      personId: claimMatchIdentityBindingsTable.personId,
      state: claimMatchIdentityBindingsTable.state,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(and(
      eq(claimMatchIdentityBindingsTable.recordingId, recordingId),
      eq(claimMatchIdentityBindingsTable.userId, body.data.userId),
    ));
  const [progress] = await db
    .select({
      completed: claimMatchProgressTable.completed,
      claimedPercent: claimMatchProgressTable.claimedPercent,
      clipsUnlocked: claimMatchProgressTable.clipsUnlocked,
      stage: claimMatchProgressTable.stage,
    })
    .from(claimMatchProgressTable)
    .where(and(
      eq(claimMatchProgressTable.recordingId, recordingId),
      eq(claimMatchProgressTable.userId, body.data.userId),
    ));
  console.info("[claim-chain] admin set chain", {
    adminId, recordingId, userId: body.data.userId, parts: saved.chain.length,
  });
  res.json({
    dryRun: false,
    userId: body.data.userId,
    ...described,
    binding: binding ?? null,
    progress: progress ?? null,
  });
});

export default router;

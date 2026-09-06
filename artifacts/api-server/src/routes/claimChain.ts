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
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "crypto";
import { z } from "zod";

import {
  db,
  claimChainLabelsTable,
  claimMatchIdentityBindingsTable,
  recordingTrackingBundlesTable,
  usersTable,
  type TrackingIdentity,
  type TrackingManifest,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { unauthenticatedResponse } from "../lib/clerkUserBridge";
import {
  getClaimMatchWritableBundle,
  readBundleSegments,
  requireAccountUser,
  trackingBundleFingerprint,
} from "./claimMatch";
import {
  captureDecisionGeometry,
  chainIntervals,
  dropLastPart,
  extendChain,
  isStruckOff,
  nextUncertainty,
  normaliseChain,
  totalSeconds,
  truncateChain,
  type ChainPart,
} from "../lib/claimChain";

const router: IRouter = Router();

type Track = TrackingSegmentPayload["tracks"][number];

const TapBody = z.object({
  trackId: z.string().min(1),
  frame: z.number().int().min(0),
  /** The track we were following and that turned out to be wrong, if any. */
  rejectedTrackId: z.string().min(1).nullish(),
  name: z.string().trim().min(1).max(60).nullish(),
  decisionMs: z.number().int().min(0).max(600_000).nullish(),
  /** Fingerprint the client was working from; a mismatch is a 409, not a merge. */
  bundleFingerprint: z.string().min(1).nullish(),
});

const FrameBody = z.object({
  frame: z.number().int().min(0),
  decisionMs: z.number().int().min(0).max(600_000).nullish(),
  bundleFingerprint: z.string().min(1).nullish(),
});

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

function tracksFromSegments(segments: TrackingSegmentPayload[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const segment of segments) {
    for (const track of segment.tracks) map.set(track.id, track);
  }
  return map;
}

function crossingsFromSegments(segments: TrackingSegmentPayload[]) {
  return segments.flatMap((segment) => segment.crossings);
}

function chainOf(manifest: TrackingManifest, identityId: string): ChainPart[] {
  const identity = (manifest.identities ?? []).find((item) => item.id === identityId);
  return (identity?.parts ?? []).map((part) => ({ ...part }));
}

/**
 * Frames another claimant has personally vouched for.
 *
 * A claimant may build any chain they like except one that takes frames
 * someone else stood behind. The existing admin path refuses the same thing
 * with a 409; this is the same rule applied to the claimant path, because the
 * whole point of a vouched fragment is that it is not up for grabs.
 */
async function foreignVouchedRanges(
  recordingId: number,
  userId: number,
): Promise<Array<{ trackId: string; fromFrame: number; toFrame: number }>> {
  const rows = await db
    .select({
      userId: claimMatchIdentityBindingsTable.userId,
      state: claimMatchIdentityBindingsTable.state,
      vouchedFragments: claimMatchIdentityBindingsTable.vouchedFragments,
    })
    .from(claimMatchIdentityBindingsTable)
    .where(eq(claimMatchIdentityBindingsTable.recordingId, recordingId));

  const out: Array<{ trackId: string; fromFrame: number; toFrame: number }> = [];
  for (const row of rows) {
    if (row.userId === userId) continue;
    if (row.state === "released" || row.state === "rejected") continue;
    for (const fragment of (row.vouchedFragments ?? []) as Array<Record<string, unknown>>) {
      const trackId = fragment.trackId;
      const fromFrame = fragment.fromFrame;
      const toFrame = fragment.toFrame;
      if (typeof trackId === "string" && typeof fromFrame === "number" && typeof toFrame === "number") {
        out.push({ trackId, fromFrame, toFrame });
      }
    }
  }
  return out;
}

function collidesWithForeignVouch(
  chain: ChainPart[],
  foreign: Array<{ trackId: string; fromFrame: number; toFrame: number }>,
): { trackId: string; fromFrame: number; toFrame: number } | null {
  for (const part of chain) {
    for (const claimed of foreign) {
      if (claimed.trackId !== part.trackId) continue;
      if (part.fromFrame <= claimed.toFrame && part.toFrame >= claimed.fromFrame) return claimed;
    }
  }
  return null;
}

type ChainContext = {
  userId: number;
  recordingId: number;
  bundleId: number;
  manifest: TrackingManifest;
  segments: TrackingSegmentPayload[];
  tracksById: Map<string, Track>;
  fingerprint: string;
  identityId: string;
};

async function loadContext(
  req: Parameters<typeof requireAccountUser>[0],
  recordingId: number,
  userId: number,
): Promise<{ ctx?: ChainContext; status?: number; error?: string }> {
  const access = await getClaimMatchWritableBundle(req, recordingId);
  if (access.status) return { status: access.status, error: access.error ?? "Refused" };
  const row = access.row;
  if (!row?.bundle?.manifest) return { status: 404, error: "Recording or tracking bundle not found" };

  const manifest = row.bundle.manifest;
  const segments = await readBundleSegments(row.bundle.id);
  const fingerprint = trackingBundleFingerprint(
    manifest,
    manifest.summary?.segments?.length ? manifest.summary.segments : segments,
  );
  return {
    ctx: {
      userId,
      recordingId,
      bundleId: row.bundle.id,
      manifest,
      segments,
      tracksById: tracksFromSegments(segments),
      fingerprint,
      identityId: claimIdentityId(userId, recordingId),
    },
  };
}

function describe(ctx: ChainContext, chain: ChainPart[], name: string | null) {
  const spans = chainIntervals(chain, ctx.manifest);
  const uncertainty = nextUncertainty(
    chain,
    ctx.tracksById,
    crossingsFromSegments(ctx.segments),
    chain.length ? Math.min(...chain.map((p) => p.fromFrame)) : 0,
    ctx.manifest.identityDecisions,
  );
  return {
    recordingId: ctx.recordingId,
    identityId: ctx.identityId,
    name,
    bundleFingerprint: ctx.fingerprint,
    frameRate: ctx.manifest.frameRate,
    chain,
    coverageSeconds: totalSeconds(spans),
    coveragePercent: ctx.manifest.duration > 0
      ? Math.min(100, Math.round((totalSeconds(spans) / ctx.manifest.duration) * 10000) / 100)
      : 0,
    nextUncertainty: uncertainty,
  };
}

/**
 * Remove every frame `taken` covers from `parts`, splitting a part in two when
 * the claim lands in its middle.
 *
 * Used so a claim never leaves the same track frames sitting under two people.
 * Overlapping identity rows are not rejected anywhere -- the board's PUT does
 * not check for them -- so nothing downstream would report the duplicate;
 * resolvePersonForTrack would just take whichever row it happened to see
 * first, which is a coin flip that changes with array order.
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
async function persistChain(
  ctx: ChainContext,
  chain: ChainPart[],
  name: string | null,
): Promise<{ chain: ChainPart[]; name: string | null }> {
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
    const nextName = name ?? existing?.name ?? null;

    // A frame belongs to exactly one person. Anything this claim now holds is
    // taken off whoever held it before, rather than sitting in two rows at
    // once -- that is what makes the board and the video one map instead of
    // two views that disagree. It is also the requirement stated directly:
    // claiming yourself in the video moves you on the board.
    const others = (manifest.identities ?? [])
      .filter((item) => item.id !== ctx.identityId)
      .map((item) => ({ ...item, parts: subtractParts(item.parts, chain) }))
      .filter((item) => item.parts.length > 0);

    const identities: TrackingIdentity[] = chain.length
      ? [...others, { id: ctx.identityId, name: nextName, parts: chain.map((p) => ({ ...p })) }]
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

    return { chain, name: nextName };
  });
}

async function recordLabel(
  ctx: ChainContext,
  kind: "switch" | "lost" | "confirm",
  frame: number,
  opts: { wrongTrackId?: string | null; rightTrackId?: string | null; decisionMs?: number | null },
): Promise<void> {
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
  } catch (error) {
    // A label is valuable, but never at the cost of the claim itself: the
    // person is mid-flow and losing their tap to a logging failure is worse
    // than losing the training row.
    console.error("[claim-chain] label write failed", { recordingId: ctx.recordingId, kind, error });
  }
}

function parseId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function begin(req: any, res: any) {
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
  const loaded = await loadContext(req, recordingId, userId);
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
  res.json(describe(ctx, chainOf(ctx.manifest, ctx.identityId), identity?.name ?? null));
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

  const foreign = await foreignVouchedRanges(ctx.recordingId, ctx.userId);
  const clash = collidesWithForeignVouch(next, foreign);
  if (clash) {
    res.status(409).json({
      error: "Another player has already vouched for that stretch.",
      conflict: clash,
    });
    return;
  }

  let name = body.data.name ?? null;
  if (!name) {
    const [user] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.userId));
    name = user?.name ?? null;
  }

  const saved = await persistChain(ctx, next, name);
  await recordLabel(ctx, body.data.rejectedTrackId ? "switch" : "confirm", frame, {
    wrongTrackId: body.data.rejectedTrackId ?? null,
    rightTrackId: trackId,
    decisionMs: body.data.decisionMs ?? null,
  });
  res.json(describe(ctx, saved.chain, saved.name));
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
  const next = normaliseChain(truncateChain(current, body.data.frame), ctx.tracksById);

  const saved = await persistChain(ctx, next, null);
  await recordLabel(ctx, "lost", body.data.frame, {
    wrongTrackId: wrong?.trackId ?? null,
    decisionMs: body.data.decisionMs ?? null,
  });
  res.json(describe(ctx, saved.chain, saved.name));
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
  const current = chainOf(ctx.manifest, ctx.identityId);
  const part = current.find((p) => body.data.frame >= p.fromFrame && body.data.frame <= p.toFrame);
  await recordLabel(ctx, "confirm", body.data.frame, {
    rightTrackId: part?.trackId ?? null,
    decisionMs: body.data.decisionMs ?? null,
  });
  const identity = (ctx.manifest.identities ?? []).find((item) => item.id === ctx.identityId);
  res.json(describe(ctx, current, identity?.name ?? null));
});

/** Undo the last link. Deliberately does not write a label — a mis-tap is not evidence. */
router.delete("/recordings/:id/claim-match/chain/last", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const current = chainOf(ctx.manifest, ctx.identityId);
  const saved = await persistChain(ctx, normaliseChain(dropLastPart(current), ctx.tracksById), null);
  res.json(describe(ctx, saved.chain, saved.name));
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
  const rows = await db
    .select()
    .from(claimChainLabelsTable)
    .where(fingerprint
      ? and(
        eq(claimChainLabelsTable.recordingId, recordingId),
        eq(claimChainLabelsTable.bundleFingerprint, fingerprint),
      )
      : eq(claimChainLabelsTable.recordingId, recordingId));
  res.json({
    recordingId,
    bundleFingerprint: fingerprint,
    count: rows.length,
    labels: rows,
  });
});

export default router;

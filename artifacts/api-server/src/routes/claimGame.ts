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
 *
 * The identity row is written by the same persistChain / syncChainClaim the
 * claim chain uses, so the board, player stats, earned clips and "claimed
 * matches" all see a game claim exactly as they see a chain claim.
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  db,
  claimMatchOffPitchSpansTable,
  claimMatchProgressTable,
  type TrackingSegmentPayload,
} from "@workspace/db";
import { normaliseChain, type ChainPart } from "../lib/claimChain";
import { begin, persistChain, syncChainClaim, type ChainContext } from "./claimChain";

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
  /** the claimant reached the done screen */
  done: z.boolean(),
  bundleFingerprint: z.string().min(1).nullish(),
});

/** State is the page's own document; keep it bounded rather than trusting its size. */
const MAX_STATE_BYTES = 2_000_000;

const inPlayCache = new Map<string, Array<[number, number]>>();

function inPlaySpans(ctx: ChainContext): Array<[number, number]> {
  const cached = inPlayCache.get(ctx.fingerprint);
  if (cached) return cached;
  const spans: Array<[number, number]> = [];
  for (const segment of ctx.segments as TrackingSegmentPayload[]) {
    for (const span of segment.inPlaySpans ?? []) {
      if (span.end > span.start) spans.push([span.start, span.end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (inPlayCache.size > 32) inPlayCache.clear();
  inPlayCache.set(ctx.fingerprint, spans);
  return spans;
}

router.get("/recordings/:id/claim-match/game", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  const [row] = await db
    .select({ gameState: claimMatchProgressTable.gameState, updatedAt: claimMatchProgressTable.updatedAt })
    .from(claimMatchProgressTable)
    .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));
  const state = row?.gameState ?? null;
  // A state saved against a different bundle names tracks that no longer exist.
  const stale = !!state && typeof state === "object" && (state as { bundle?: unknown }).bundle !== ctx.fingerprint;
  res.json({
    state: stale ? null : state,
    staleState: stale,
    bundleFingerprint: ctx.fingerprint,
    inPlaySpans: inPlaySpans(ctx),
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
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
    await persistChain(ctx, chain, { chosen: null, fallback: null }, { kind: "decision", answeredFrame: null });
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

  const state = { ...parsed.data.state, bundle: ctx.fingerprint };
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
  const ctx = await begin(req, res);
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

export default router;

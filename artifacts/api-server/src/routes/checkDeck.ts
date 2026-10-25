/**
 * "Is this you?" (2026-10-25): the swipe deck a player gets after claiming
 * himself. See lib/checkDeck.ts for what goes in it and why.
 *
 *   GET  /recordings/:id/claim-match/check-deck          the cards
 *   POST /recordings/:id/claim-match/check-deck/answer   { cardId, verdict: yes | no | skip }
 *
 * Each card carries what the page needs to play it at once: the stretch of
 * the recording, and where the player (or the ball) is through it, so the
 * page can follow him on the panorama without asking anything else.
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, claimMatchProgressTable, recordingsTable, userClipsTable } from "@workspace/db";
import { begin, chainOf, persistChain, syncChainClaim, type ChainContext } from "./claimChain";
import { loadRecordingPlay, type RecordingPlay } from "../lib/matchPlayLoad";
import { personalMoments } from "../lib/personalMoments";
import { clipPartsToMatchWindow, readMatchWindow } from "../lib/matchWindow";
import { goalVotesFor, reviewedGoalsOf, setGoalVote } from "../lib/goalReview";
import { goalVoteRights } from "../lib/goalRights";
import { kitOfParts, seedTeams, sideOfKit, type ClaimedPart } from "../lib/matchPlay";
import {
  CHECK,
  applyCuts,
  ballFocus,
  clockOf,
  goalCardsFor,
  momentNumbers,
  notMeCut,
  partsFocus,
  trackIndex,
  unsureMoments,
  type DeckCard,
  type UnsureMoment,
} from "../lib/checkDeck";
import { momentChecksFor, saveMomentCheck } from "../lib/momentChecks";
import { invalidateMatchStatsCacheForRecording } from "../lib/matchStatsCache";
import { resyncChainClaimsForRecording } from "./claimChain";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type Deck = {
  ctx: ChainContext;
  play: RecordingPlay;
  parts: ClaimedPart[];
  unsure: UnsureMoment[];
  completed: boolean;
};

async function deckState(ctx: ChainContext): Promise<Deck | null> {
  const play = await loadRecordingPlay(ctx.recordingId);
  if (!play?.hasBall) return null;
  const chain = chainOf(ctx.manifest, ctx.identityId);
  const parts = clipPartsToMatchWindow(
    chain.map((p) => ({ trackId: p.trackId, fromFrame: p.fromFrame, toFrame: p.toFrame })),
    ctx.manifest,
  );
  const goalVotes = (await goalVotesFor([ctx.recordingId])).get(ctx.recordingId) ?? [];
  const mine = parts.length ? personalMoments(play, parts, ctx.segments, ctx.manifest, goalVotes) : [];
  const [progress] = await db.select({ completed: claimMatchProgressTable.completed })
    .from(claimMatchProgressTable)
    .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));
  return { ctx, play, parts, unsure: unsureMoments(mine, parts, ctx.segments, play.manifest, play.kits), completed: progress?.completed === true };
}

function browserVideoUrl(videoUrl: string): string {
  try {
    const parsed = new URL(videoUrl);
    if (parsed.hostname.endsWith(".b-cdn.net") && parsed.pathname.endsWith(".m3u8")) {
      return `/api/hls-proxy/manifest?url=${encodeURIComponent(videoUrl)}`;
    }
  } catch {
    // a relative source plays as it is
  }
  return videoUrl;
}

router.get("/recordings/:id/claim-match/check-deck", async (req, res): Promise<void> => {
  const ctx = await begin(req, res);
  if (!ctx) return;
  try {
    const [recording] = await db.select().from(recordingsTable).where(eq(recordingsTable.id, ctx.recordingId));
    const deck = await deckState(ctx);
    const base = {
      recordingId: ctx.recordingId,
      videoUrl: recording ? browserVideoUrl(recording.videoUrl) : null,
      srcW: ctx.manifest.width,
      srcH: ctx.manifest.height,
      videoStartSeconds: ctx.manifest.videoStartSeconds ?? 0,
    };
    if (!deck || !recording || !deck.parts.length) {
      res.json({ ...base, completed: deck?.completed ?? false, cards: [] });
      return;
    }
    const { play, parts } = deck;
    const answers = await momentChecksFor(ctx.userId, ctx.recordingId);
    const tracks = trackIndex(ctx.segments);
    const vs = ctx.manifest.videoStartSeconds ?? 0;
    const cards: DeckCard[] = [];
    for (const u of deck.unsure.filter((x) => !answers.has(x.moment.id)).slice(0, CHECK.maxYou)) {
      const t = u.moment.momentSeconds;
      const from = Math.max(0, t - CHECK.youBefore), to = t + CHECK.youAfter;
      const numbers = momentNumbers(u.moment.title);
      cards.push({
        id: `you:${u.moment.id}`,
        kind: "you",
        at: t + vs,
        start: from + vs,
        end: to + vs,
        clock: clockOf(t),
        focus: partsFocus(parts, tracks, ctx.manifest, from, to, vs, u.part.trackId),
        you: { momentId: u.moment.id, momentKind: u.moment.kind as NonNullable<DeckCard["you"]>["momentKind"], ...numbers, reasons: u.reasons },
      });
    }
    // Goal candidates in the match window that nobody has confirmed and he has not answered
    const window = readMatchWindow(play.manifest);
    const votes = (await goalVotesFor([ctx.recordingId])).get(ctx.recordingId) ?? [];
    const answeredKeys = new Set<number>(votes.filter((v) => v.userId === ctx.userId).map((v) => v.atTenths));
    for (const [id] of answers) if (id.startsWith("goal:")) answeredKeys.add(Number(id.slice(5)));
    const reviewed = reviewedGoalsOf(play, votes)
      .filter((g) => !window || (g.t >= window.startSeconds && g.t < window.endSeconds));
    const own = kitOfParts(parts, play.sidecars, play.fps);
    const pick = own ? seedTeams(own, play.kitOptions, play.bib ?? null) : null;
    const ball = play.sidecars.flatMap((sc) => sc?.ball ?? []);
    // Only someone in the match may say a chance was a goal (the same rule as
    // the match page); anyone else gets just his own "Is this you?" cards.
    const mayVote = await goalVoteRights(ctx.userId, ctx.recordingId);
    for (const g of goalCardsFor(reviewed.filter((c) => mayVote(c.t)), ctx.userId, answeredKeys)) {
      const from = Math.max(0, g.t - CHECK.goalBefore), to = g.t + CHECK.goalAfter;
      const side = pick ? sideOfKit(g.kit, pick) : null;
      cards.push({
        id: `goal:${g.key}`,
        kind: "goal",
        at: g.t + vs,
        start: from + vs,
        end: to + vs,
        clock: clockOf(g.t),
        focus: ballFocus(ball, ctx.manifest, from, to, vs),
        goal: {
          recordingId: ctx.recordingId,
          key: g.key,
          source: g.source,
          likely: g.source === "goal",
          side: side === 0 ? "yours" : side === 1 ? "theirs" : null,
          ownGoal: g.ownGoal === true,
        },
      });
    }
    // his moments first, the goals after: a goal card is the deck's finale
    res.json({ ...base, completed: deck.completed, cards });
  } catch (error) {
    logger.error({ recordingId: ctx.recordingId, err: error }, "check deck failed");
    res.status(500).json({ error: "Could not build the deck" });
  }
});

const AnswerBody = z.object({
  cardId: z.string().min(3).max(120),
  verdict: z.enum(["yes", "no", "skip"]),
});

router.post("/recordings/:id/claim-match/check-deck/answer", async (req, res): Promise<void> => {
  const parsed = AnswerBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid answer" });
    return;
  }
  const ctx = await begin(req, res);
  if (!ctx) return;
  const { cardId, verdict } = parsed.data;
  try {
    if (cardId.startsWith("goal:")) {
      const key = Number(cardId.slice(5));
      const play = await loadRecordingPlay(ctx.recordingId);
      const votes = (await goalVotesFor([ctx.recordingId])).get(ctx.recordingId) ?? [];
      const chance = play && Number.isSafeInteger(key) ? reviewedGoalsOf(play, votes).find((g) => g.key === key) : undefined;
      if (!chance) {
        res.status(404).json({ error: "No such chance" });
        return;
      }
      if (!(await goalVoteRights(ctx.userId, ctx.recordingId))(chance.t)) {
        res.status(403).json({ error: "Only players in this match can confirm goals" });
        return;
      }
      if (verdict === "skip") await saveMomentCheck(ctx.userId, ctx.recordingId, cardId, "skip", null);
      else await setGoalVote(ctx.recordingId, key, ctx.userId, verdict === "yes" ? "goal" : "not_goal", null);
      if (verdict !== "skip") {
        await invalidateMatchStatsCacheForRecording(ctx.recordingId);
        void resyncChainClaimsForRecording(req, ctx.recordingId).catch((error) =>
          logger.warn({ recordingId: ctx.recordingId, err: error }, "re-sync after a deck goal vote failed"));
      }
      res.json({ ok: true, clip: false });
      return;
    }

    if (!cardId.startsWith("you:")) {
      res.status(400).json({ error: "Unknown card" });
      return;
    }
    const momentId = cardId.slice(4);
    const deck = await deckState(ctx);
    const unsure = deck?.unsure.find((u) => u.moment.id === momentId);
    if (!deck || !unsure) {
      res.status(404).json({ error: "That moment is not waiting for an answer" });
      return;
    }
    const chain = chainOf(ctx.manifest, ctx.identityId);
    if (verdict === "no") {
      const cut = notMeCut(unsure, ctx.manifest.frameRate);
      await saveMomentCheck(ctx.userId, ctx.recordingId, momentId, "no", cut);
      const next = applyCuts(chain, [cut]);
      const saved = await persistChain(ctx, next, { chosen: null }, { kind: "decision", answeredFrame: null });
      // A clip made of this moment before the deck existed comes out of his clips.
      const [progress] = await db.select({ earnedClips: claimMatchProgressTable.earnedClips })
        .from(claimMatchProgressTable)
        .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));
      const made = (progress?.earnedClips ?? []).find((c) => c.id === momentId)?.userClipId;
      if (made) {
        await db.update(userClipsTable).set({ isHidden: true })
          .where(and(eq(userClipsTable.id, made), eq(userClipsTable.userId, ctx.userId)));
      }
      await syncChainClaim(ctx, saved.chain, !deck.completed);
      await invalidateMatchStatsCacheForRecording(ctx.recordingId);
      res.json({ ok: true, clip: false });
      return;
    }
    await saveMomentCheck(ctx.userId, ctx.recordingId, momentId, verdict, null);
    if (verdict === "yes") {
      await syncChainClaim(ctx, chain, !deck.completed);
      const [progress] = await db.select({ earnedClips: claimMatchProgressTable.earnedClips })
        .from(claimMatchProgressTable)
        .where(and(eq(claimMatchProgressTable.userId, ctx.userId), eq(claimMatchProgressTable.recordingId, ctx.recordingId)));
      const clip = (progress?.earnedClips ?? []).find((c) => c.id === momentId);
      res.json({ ok: true, clip: Boolean(clip), userClipId: clip?.userClipId ?? null });
      return;
    }
    res.json({ ok: true, clip: false });
  } catch (error) {
    logger.error({ recordingId: ctx.recordingId, cardId, err: error }, "check deck answer failed");
    res.status(503).json({ error: "Could not save that answer" });
  }
});

export default router;

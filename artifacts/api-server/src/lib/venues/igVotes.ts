import { and, eq, inArray, isNull } from "drizzle-orm";
import { academySocialCommentsTable, db, venueIgItemsTable, type VenueIgAward, type VenueIgItem } from "@workspace/db";
import { logger } from "../logger";
import { graphGet } from "../meta/graph";
import { getSocialAccount, pageToken } from "../social/account";
import { recordComment } from "../social/inbox";
import { readNominees } from "./igAwards";
import { commentVotes } from "./igCalendar";

/**
 * Votes in Instagram comments (Mohammed, 2026-11-04: "vote for clip of the week on insta").
 * The nominees carousel asks for the clip's number ("2", "٢"); "which is nicer?" for A or B
 * ("ب"). Comments reach the field's inbox through the webhook (lib/social/inbox.ts); before a
 * count the post's comments are also read from Instagram, so a missed webhook loses no vote.
 * One vote per Instagram account: its latest comment that makes a choice.
 */

const PULL_EVERY_MS = 20 * 60_000;
const lastPull = new Map<string, number>();

type GraphComment = { id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string } };

/** Read a post's comments from Instagram into the inbox (at most every 20 minutes per post). */
export async function pullComments(academyId: number, igMediaId: string, force = false): Promise<number> {
  const key = `${academyId}:${igMediaId}`;
  if (!force && Date.now() - (lastPull.get(key) ?? 0) < PULL_EVERY_MS) return 0;
  lastPull.set(key, Date.now());
  const account = await getSocialAccount(academyId);
  if (!account?.pageTokenEnc || account.status !== "connected") return 0;
  const token = pageToken(account);
  let added = 0;
  let after: string | undefined;
  try {
    for (let page = 0; page < 20; page += 1) {
      const res = await graphGet<{ data?: GraphComment[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${igMediaId}/comments`, {
        fields: "id,text,timestamp,username,from",
        limit: "50",
        ...(after ? { after } : {}),
      }, { token });
      for (const c of res.data ?? []) {
        const ok = await recordComment(account, "instagram", {
          commentId: c.id,
          postId: igMediaId,
          fromId: c.from?.id ?? null,
          fromName: (c.from?.username ?? c.username) ? `@${c.from?.username ?? c.username}` : null,
          body: c.text ?? "",
          createdAt: c.timestamp ? new Date(c.timestamp) : undefined,
        });
        if (ok) added += 1;
      }
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
    }
  } catch (error) {
    logger.warn({ academyId, igMediaId, error: (error as Error).message }, "Instagram: reading a post's comments failed");
  }
  return added;
}

/** Choice (1-based) per Instagram account on a post, from the comments stored for it. */
export async function postCommentVotes(academyId: number, igMediaId: string, choices: number): Promise<Map<string, number>> {
  const account = await getSocialAccount(academyId);
  const rows = await db.select({ fromId: academySocialCommentsTable.fromId, body: academySocialCommentsTable.body, createdAt: academySocialCommentsTable.createdAt })
    .from(academySocialCommentsTable)
    .where(and(eq(academySocialCommentsTable.academyId, academyId), eq(academySocialCommentsTable.channel, "instagram"), eq(academySocialCommentsTable.postId, igMediaId), isNull(academySocialCommentsTable.deletedAt)));
  // A deleted comment stays in the inbox table (deletedAt) but its vote no longer counts.
  return commentVotes(rows, choices, [account?.igUserId ?? null, account?.pageId ?? null]);
}

/** An award's votes from the comments on its nominees carousel, as nominee keys. */
export async function awardCommentVotes(award: VenueIgAward, opts: { pull?: boolean } = {}): Promise<Array<{ nomineeKey: string }>> {
  const [item] = await db.select().from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, award.academyId),
    eq(venueIgItemsTable.originKey, `nominees:${award.id}`),
  ));
  if (!item?.igMediaId) return [];
  if (opts.pull) await pullComments(award.academyId, item.igMediaId, true);
  const nominees = readNominees(award.nominees);
  const votes = await postCommentVotes(award.academyId, item.igMediaId, nominees.length);
  return [...votes.values()].map((n) => ({ nomineeKey: nominees[n - 1].key }));
}

/** "Which is nicer?": votes for A and B so far. */
export async function versusVotes(item: VenueIgItem, opts: { pull?: boolean } = {}): Promise<{ a: number; b: number } | null> {
  if (item.kind !== "versus" || !item.igMediaId) return null;
  if (opts.pull) await pullComments(item.academyId, item.igMediaId);
  const votes = await postCommentVotes(item.academyId, item.igMediaId, 2);
  let a = 0;
  let b = 0;
  for (const n of votes.values()) if (n === 1) a += 1; else b += 1;
  return { a, b };
}

/** Pull comments on the field's live votes (nominee carousels and which-is-nicer Reels from the last week). */
export async function pullOpenVotes(academyId: number, now = new Date()): Promise<number> {
  const rows = await db.select({ igMediaId: venueIgItemsTable.igMediaId, publishedAt: venueIgItemsTable.publishedAt }).from(venueIgItemsTable).where(and(
    eq(venueIgItemsTable.academyId, academyId),
    eq(venueIgItemsTable.status, "published"),
    inArray(venueIgItemsTable.kind, ["award_nominees", "versus"]),
  ));
  let n = 0;
  for (const r of rows) {
    if (!r.igMediaId || !r.publishedAt || now.getTime() - r.publishedAt.getTime() > 7 * 86_400_000) continue;
    n += await pullComments(academyId, r.igMediaId);
  }
  return n;
}

/** For tests. */
export function resetCommentPulls(): void {
  lastPull.clear();
}

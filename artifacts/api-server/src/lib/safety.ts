import { and, eq, or } from "drizzle-orm";
import { db, userBlocksTable } from "@workspace/db";
import { isMissingRelationError } from "./settings";
import { logger } from "./logger";

let warnedMissingBlocks = false;

export async function blockedUserIdsFor(userId: number): Promise<Set<number>> {
  try {
    const rows = await db.select({
      blockerId: userBlocksTable.blockerId,
      blockedId: userBlocksTable.blockedId,
    }).from(userBlocksTable).where(or(
      eq(userBlocksTable.blockerId, userId),
      eq(userBlocksTable.blockedId, userId),
    ));
    return new Set(rows.map((row) => row.blockerId === userId ? row.blockedId : row.blockerId));
  } catch (error) {
    if (isMissingRelationError(error)) {
      if (!warnedMissingBlocks) {
        warnedMissingBlocks = true;
        logger.warn("user_blocks does not exist yet — block filtering is temporarily inactive. Run the database schema push.");
      }
      return new Set();
    }
    throw error;
  }
}

export async function isBlockedEitherWay(a: number, b: number): Promise<boolean> {
  const blocked = await blockedUserIdsFor(a);
  return blocked.has(b);
}
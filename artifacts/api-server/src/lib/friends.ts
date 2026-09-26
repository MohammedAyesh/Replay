import { and, eq, or } from "drizzle-orm";
import { db, friendshipsTable, userBlocksTable } from "@workspace/db";

export async function acceptedFriendshipBetween(a: number, b: number): Promise<boolean> {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const [row] = await db.select({ id: friendshipsTable.id })
    .from(friendshipsTable)
    .where(and(
      eq(friendshipsTable.userLowId, low),
      eq(friendshipsTable.userHighId, high),
      eq(friendshipsTable.status, "accepted"),
    ));
  return !!row;
}

export async function friendshipBetween(a: number, b: number) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  const [row] = await db.select().from(friendshipsTable)
    .where(and(eq(friendshipsTable.userLowId, low), eq(friendshipsTable.userHighId, high)));
  return row ?? null;
}

export async function blockedEitherWay(a: number, b: number): Promise<boolean> {
  const [row] = await db.select({ blockerId: userBlocksTable.blockerId }).from(userBlocksTable).where(or(
    and(eq(userBlocksTable.blockerId, a), eq(userBlocksTable.blockedId, b)),
    and(eq(userBlocksTable.blockerId, b), eq(userBlocksTable.blockedId, a)),
  ));
  return !!row;
}
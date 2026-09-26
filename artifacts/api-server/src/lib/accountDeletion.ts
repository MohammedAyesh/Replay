import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  adClicksTable,
  adImpressionsTable,
  clipsTable,
  footageCancellationRequestsTable,
  footagePaymentsTable,
  footageRequestsTable,
  fieldOwnersTable,
  followsTable,
  likesTable,
  savedClipsTable,
  settingsRulesTable,
  statUnlocksTable,
  userClipsTable,
  usersTable,
  varMarksTable,
} from "@workspace/db";
import { deleteBunnyClipAssets, deleteBunnyStoragePath } from "./bunny";
import { deleteClerkUserAccount } from "./clerkUserBridge";
import { logger } from "./logger";

const ACTIVE_FOOTAGE_STATUSES = ["queued", "running", "scheduled", "recording", "awaiting_payment"];
export const DELETED_PLAYER_EMAIL = "deleted-player@soccerwatch.local";
const DELETED_PLAYER_NAME = "Deleted player";

export function isLastActiveAdmin(activeAdminCount: number): boolean {
  return activeAdminCount <= 1;
}

export type AccountDeletionResult =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "active_footage"; activeFootageRequests: number }
  | { status: "admin" }
  | { status: "field_owner" }
  | { status: "last_admin" }
  | { status: "clerk_failure" }
  | { status: "database_failure" };

class ActiveFootageRequestError extends Error {
  constructor(readonly activeFootageRequests: number) {
    super("Account still has active footage requests");
  }
}

function isDeletedPlayer(user: {
  name: string;
  email: string;
  isGuest: boolean;
  isDisabled: boolean;
  isAdmin: boolean;
  clerkId: string | null;
}): boolean {
  return user.name === DELETED_PLAYER_NAME
    && user.email === DELETED_PLAYER_EMAIL
    && user.isGuest
    && user.isDisabled
    && !user.isAdmin
    && user.clerkId === null;
}

async function disableAfterDeletionFailure(userId: number): Promise<void> {
  try {
    await db.update(usersTable).set({ isDisabled: true }).where(eq(usersTable.id, userId));
  } catch (disableError) {
    logger.error(
      { err: disableError, userId },
      "Could not disable local account after account deletion failed",
    );
  }
}

/**
 * Shared account-erasure flow for self-service and administrative deletion.
 * Retained financial and footage records are attributed to a disabled system
 * placeholder; user-generated clips and their likes are removed.
 */
async function deleteUserAccountNow(
  userId: number,
  actor: "self" | "admin",
): Promise<AccountDeletionResult> {
  let user: {
    id: number;
    clerkId: string | null;
    email: string;
    isAdmin: boolean;
    isDisabled: boolean;
    avatarPath: string | null;
  } | undefined;
  let activeRequests: { id: number }[];

  try {
    [user] = await db
      .select({
        id: usersTable.id,
        clerkId: usersTable.clerkId,
        email: usersTable.email,
        isAdmin: usersTable.isAdmin,
        isDisabled: usersTable.isDisabled,
        avatarPath: usersTable.avatarPath,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) return { status: "not_found" };

    if (user.email === DELETED_PLAYER_EMAIL) {
      return { status: "not_found" };
    }

    if (actor === "self") {
      if (user.isAdmin) return { status: "admin" };
      const [fieldOwnership] = await db
        .select({ id: fieldOwnersTable.id })
        .from(fieldOwnersTable)
        .where(eq(fieldOwnersTable.userId, userId))
        .limit(1);
      if (fieldOwnership) return { status: "field_owner" };
    }

    activeRequests = await db
      .select({ id: footageRequestsTable.id })
      .from(footageRequestsTable)
      .where(and(
        eq(footageRequestsTable.requestedBy, userId),
        inArray(footageRequestsTable.status, ACTIVE_FOOTAGE_STATUSES),
      ));
    if (activeRequests.length === 0 && actor === "admin" && user.isAdmin && !user.isDisabled) {
      const activeAdmins = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(
          eq(usersTable.isAdmin, true),
          eq(usersTable.isDisabled, false),
          ne(usersTable.email, DELETED_PLAYER_EMAIL),
        ));
      if (isLastActiveAdmin(activeAdmins.length)) return { status: "last_admin" };
    }
  } catch (error) {
    logger.error({ err: error, userId }, "Could not check account deletion prerequisites");
    return { status: "database_failure" };
  }

  if (activeRequests.length > 0) {
    return { status: "active_footage", activeFootageRequests: activeRequests.length };
  }

  if (user.clerkId) {
    try {
      await deleteClerkUserAccount(user.clerkId);
    } catch (error) {
      logger.error({ err: error, userId }, "Could not delete Clerk identity; local account was not changed");
      return { status: "clerk_failure" };
    }
  }

  let deletedClipAssets: Array<{ id: number; posterPath: string | null }>;
  try {
    deletedClipAssets = await db.transaction(async (tx) => {
      // Recheck after the external identity is deleted to avoid removing an
      // account while a footage request was started during the Clerk call.
      const active = await tx
        .select({ id: footageRequestsTable.id })
        .from(footageRequestsTable)
        .where(and(
          eq(footageRequestsTable.requestedBy, userId),
          inArray(footageRequestsTable.status, ACTIVE_FOOTAGE_STATUSES),
        ));
      if (active.length > 0) throw new ActiveFootageRequestError(active.length);

      const clipAssets = await tx
        .select({ id: userClipsTable.id, posterPath: userClipsTable.posterPath })
        .from(userClipsTable)
        .where(eq(userClipsTable.userId, userId));

      const likedSurvivingClips = await tx
        .select({ id: userClipsTable.id })
        .from(likesTable)
        .innerJoin(userClipsTable, eq(userClipsTable.id, likesTable.userClipId))
        .where(and(
          eq(likesTable.userId, userId),
          ne(userClipsTable.userId, userId),
        ));
      const survivingClipIds = [...new Set(likedSurvivingClips.map(({ id }) => id))];
      if (survivingClipIds.length > 0) {
        await tx
          .update(userClipsTable)
          .set({ likeCount: sql`GREATEST(${userClipsTable.likeCount} - 1, 0)` })
          .where(inArray(userClipsTable.id, survivingClipIds));
      }

      const likedLegacyClips = await tx
        .select({ id: clipsTable.id })
        .from(likesTable)
        .innerJoin(clipsTable, eq(clipsTable.id, likesTable.clipId))
        .where(eq(likesTable.userId, userId));
      const legacyClipIds = [...new Set(likedLegacyClips.map(({ id }) => id))];
      if (legacyClipIds.length > 0) {
        await tx
          .update(clipsTable)
          .set({ likeCount: sql`GREATEST(${clipsTable.likeCount} - 1, 0)` })
          .where(inArray(clipsTable.id, legacyClipIds));
      }

      // Keep queries on the transaction connection sequential; concurrent
      // pg queries on one transaction client trigger driver warnings.
      const ownedFootage = await tx.select({ id: footageRequestsTable.id })
        .from(footageRequestsTable)
        .where(eq(footageRequestsTable.requestedBy, userId)).limit(1);
      const cancellationRequests = await tx.select({ id: footageCancellationRequestsTable.id })
        .from(footageCancellationRequestsTable)
        .where(eq(footageCancellationRequestsTable.requestedBy, userId)).limit(1);
      const payments = await tx.select({ id: footagePaymentsTable.id })
        .from(footagePaymentsTable)
        .where(eq(footagePaymentsTable.recordedBy, userId)).limit(1);
      const marks = await tx.select({ id: varMarksTable.id })
        .from(varMarksTable)
        .where(eq(varMarksTable.createdBy, userId)).limit(1);
      const unlocks = await tx.select({ id: statUnlocksTable.id })
        .from(statUnlocksTable)
        .where(eq(statUnlocksTable.userId, userId)).limit(1);

      if ([ownedFootage, cancellationRequests, payments, marks, unlocks].some((rows) => rows.length > 0)) {
        let placeholderId: number | undefined;
        const [existingPlaceholder] = await tx
          .select({
            id: usersTable.id,
            name: usersTable.name,
            email: usersTable.email,
            isGuest: usersTable.isGuest,
            isDisabled: usersTable.isDisabled,
            isAdmin: usersTable.isAdmin,
            clerkId: usersTable.clerkId,
          })
          .from(usersTable)
          .where(eq(usersTable.email, DELETED_PLAYER_EMAIL));

        if (existingPlaceholder) {
          if (!isDeletedPlayer(existingPlaceholder)) {
            throw new Error("Reserved deleted-player account is occupied");
          }
          placeholderId = existingPlaceholder.id;
        } else {
          const [created] = await tx
            .insert(usersTable)
            .values({
              name: DELETED_PLAYER_NAME,
              email: DELETED_PLAYER_EMAIL,
              isGuest: true,
              isDisabled: true,
            })
            .onConflictDoNothing()
            .returning({ id: usersTable.id });
          if (created) {
            placeholderId = created.id;
          } else {
            const [racedPlaceholder] = await tx
              .select({
                id: usersTable.id,
                name: usersTable.name,
                email: usersTable.email,
                isGuest: usersTable.isGuest,
                isDisabled: usersTable.isDisabled,
                isAdmin: usersTable.isAdmin,
                clerkId: usersTable.clerkId,
              })
              .from(usersTable)
              .where(eq(usersTable.email, DELETED_PLAYER_EMAIL));
            if (!racedPlaceholder || !isDeletedPlayer(racedPlaceholder)) {
              throw new Error("Reserved deleted-player account is occupied");
            }
            placeholderId = racedPlaceholder.id;
          }
        }

        if (placeholderId === undefined) throw new Error("Could not create deleted-player account");

        // Keep historical transactions and match annotations without retaining
        // the deleted user's identity. These changes do not alter their amounts,
        // statuses, references, footage, or review state.
        await tx.update(footageRequestsTable)
          .set({ requestedBy: placeholderId })
          .where(eq(footageRequestsTable.requestedBy, userId));
        await tx.update(footageCancellationRequestsTable)
          .set({ requestedBy: placeholderId })
          .where(eq(footageCancellationRequestsTable.requestedBy, userId));
        await tx.update(footagePaymentsTable)
          .set({ recordedBy: placeholderId })
          .where(eq(footagePaymentsTable.recordedBy, userId));
        await tx.update(varMarksTable)
          .set({ createdBy: placeholderId })
          .where(eq(varMarksTable.createdBy, userId));
        await tx.update(statUnlocksTable)
          .set({ userId: placeholderId })
          .where(eq(statUnlocksTable.userId, userId));
      }

      // Keep ad analytics while removing the account foreign-key association.
      await tx.update(adImpressionsTable).set({ userId: null }).where(eq(adImpressionsTable.userId, userId));
      await tx.update(adClicksTable).set({ userId: null }).where(eq(adClicksTable.userId, userId));
      await tx.delete(savedClipsTable).where(eq(savedClipsTable.userId, userId));
      await tx.delete(likesTable).where(eq(likesTable.userId, userId));
      await tx.delete(followsTable).where(eq(followsTable.followerId, userId));
      await tx.delete(followsTable).where(eq(followsTable.followeeId, userId));
      await tx.delete(settingsRulesTable).where(and(
        eq(settingsRulesTable.scopeType, "user"),
        eq(settingsRulesTable.scopeId, userId),
      ));
      await tx.delete(userClipsTable).where(eq(userClipsTable.userId, userId));
      await tx.delete(usersTable).where(eq(usersTable.id, userId));

      return clipAssets;
    });
  } catch (error) {
    await disableAfterDeletionFailure(userId);
    logger.error({ err: error, userId }, "Account deletion transaction failed; local account disabled");
    return { status: "database_failure" };
  }

  const assetCleanup = await Promise.allSettled([
    ...deletedClipAssets.map(({ id, posterPath }) => deleteBunnyClipAssets(id, posterPath)),
    ...(user.avatarPath ? [deleteBunnyStoragePath(user.avatarPath)] : []),
  ]);
  assetCleanup.forEach((result, index) => {
    if (result.status === "rejected") {
      const isAvatarCleanup = index >= deletedClipAssets.length;
      logger.warn(
        {
          err: result.reason,
          userId,
          ...(isAvatarCleanup ? {} : { clipId: deletedClipAssets[index]?.id }),
        },
        isAvatarCleanup
          ? "Could not remove Bunny avatar for deleted account"
          : "Could not remove Bunny assets for deleted user clip",
      );
    }
  });

  return { status: "deleted" };
}

let adminDeletionQueue: Promise<void> = Promise.resolve();

async function serializeAdminDeletion<T>(operation: () => Promise<T>): Promise<T> {
  const previous = adminDeletionQueue;
  let release!: () => void;
  adminDeletionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export function deleteUserAccount(
  userId: number,
  options: { actor: "self" | "admin" },
): Promise<AccountDeletionResult> {
  return options.actor === "admin"
    ? serializeAdminDeletion(() => deleteUserAccountNow(userId, options.actor))
    : deleteUserAccountNow(userId, options.actor);
}

export function accountDeletionHttpResponse(result: AccountDeletionResult): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  switch (result.status) {
    case "deleted":
      return { statusCode: 200, body: { ok: true } };
    case "not_found":
      return { statusCode: 404, body: { error: "User not found", reason: "not_found" } };
    case "active_footage":
      return {
        statusCode: 409,
        body: {
          error: "Finish or cancel active footage requests before deleting this account.",
          reason: "upcoming_booking",
          activeFootageRequests: result.activeFootageRequests,
        },
      };
    case "admin":
      return { statusCode: 403, body: { error: "Admins cannot delete their own account here", reason: "admin" } };
    case "field_owner":
      return { statusCode: 409, body: { error: "Field ownership must be transferred first", reason: "field_owner" } };
    case "last_admin":
      return { statusCode: 409, body: { error: "The last active administrator cannot be deleted", reason: "last_admin" } };
    case "clerk_failure":
      return {
        statusCode: 502,
        body: { error: "Could not delete the sign-in account. No account data was changed.", reason: "clerk_failed" },
      };
    case "database_failure":
      return {
        statusCode: 500,
        body: {
          error: "Could not finish deleting this account. The local account has been disabled.",
          reason: "data_failed",
        },
      };
  }
}
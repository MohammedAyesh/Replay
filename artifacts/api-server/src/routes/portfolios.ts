import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  followsTable,
  portfolioHistoryTable,
  userClipsTable,
  usersTable,
} from "@workspace/db";
import {
  GetUserPortfolioParams,
  GetUserPortfolioResponse,
  UpdateUserPortfolioBody,
  UpdateUserPortfolioParams,
  UpdateUserPortfolioResponse,
} from "@workspace/api-zod";
import {
  getLocalAccountUserId,
  unauthenticatedResponse,
} from "../lib/clerkUserBridge";
import {
  getBunnyPortfolioPlaybackUrl,
  getPortfolioClipStoragePath,
  isBunnyStorageConfigured,
} from "../lib/bunny";
import { portfolioPlaybackPath } from "../lib/shareCard";
import { planPortfolioPlayback } from "../lib/portfolioPlayback";
import { isBackupExportRef } from "../lib/backupExport";
import { logger } from "../lib/logger";
import { isLiveVideoId, isUserClipExportInFlight } from "./userClips";

const router: IRouter = Router();
const MAX_PROFILE_PHOTO_BYTES = 1.5 * 1024 * 1024;
const PHOTO_PATTERN = /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/=\s]+$/i;

function validatePortfolioBody(body: ReturnType<typeof UpdateUserPortfolioBody.parse>): string | null {
  if (body.name.trim().length === 0 || body.name.trim().length > 120) {
    return "Name must be between 1 and 120 characters";
  }
  if (body.nation !== null && body.nation.trim().length > 80) {
    return "Nation must be 80 characters or fewer";
  }
  if (body.position !== null && body.position.trim().length > 64) {
    return "Position must be 64 characters or fewer";
  }

  if (body.profilePhoto !== null) {
    if (!PHOTO_PATTERN.test(body.profilePhoto)) {
      return "Profile photo must be a compressed WebP or JPEG image";
    }
    if (Buffer.byteLength(body.profilePhoto, "utf8") > MAX_PROFILE_PHOTO_BYTES) {
      return "Profile photo must be 1.5 MiB or smaller";
    }
  }

  const orders = new Set<number>();
  let currentCount = 0;
  for (const item of body.history) {
    if (item.teamName.trim().length === 0 || item.teamName.trim().length > 120) {
      return "Team or academy names must be between 1 and 120 characters";
    }
    if (item.roleLabel.trim().length === 0 || item.roleLabel.trim().length > 80) {
      return "Role labels must be between 1 and 80 characters";
    }
    if (!Number.isInteger(item.startYear) || item.startYear < 1900 || item.startYear > 2100) {
      return "Start years must be between 1900 and 2100";
    }
    if (item.endYear !== null && (!Number.isInteger(item.endYear) || item.endYear < 1900 || item.endYear > 2100)) {
      return "End years must be between 1900 and 2100";
    }
    if (item.isCurrent && item.endYear !== null) {
      return "Current history entries cannot have an end year";
    }
    if (item.endYear !== null && item.startYear > item.endYear) {
      return "History start years must not be after end years";
    }
    if (orders.has(item.displayOrder) || !Number.isInteger(item.displayOrder) || item.displayOrder < 0) {
      return "History display order must contain unique non-negative integers";
    }
    orders.add(item.displayOrder);
    if (item.isCurrent) currentCount++;
  }
  if (currentCount > 1) {
    return "Portfolio history can have at most one current entry";
  }

  return null;
}

async function buildPortfolio(targetId: number, canEdit: boolean) {
  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      age: usersTable.age,
      position: usersTable.position,
      nation: usersTable.nation,
      profilePhoto: usersTable.profilePhoto,
      isGuest: usersTable.isGuest,
    })
    .from(usersTable)
    .where(eq(usersTable.id, targetId));
  if (!user || user.isGuest) return null;

  const [followerResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(followsTable)
    .where(eq(followsTable.followeeId, targetId));
  const [followingResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(followsTable)
    .where(eq(followsTable.followerId, targetId));
  const [clipResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userClipsTable)
    .where(and(
      eq(userClipsTable.userId, targetId),
      eq(userClipsTable.visibility, "public"),
      eq(userClipsTable.isHidden, false),
    ));

  const history = await db
    .select()
    .from(portfolioHistoryTable)
    .where(eq(portfolioHistoryTable.userId, targetId))
    .orderBy(asc(portfolioHistoryTable.displayOrder), asc(portfolioHistoryTable.id));

  const clips = await db
    .select()
    .from(userClipsTable)
    .where(and(
      eq(userClipsTable.userId, targetId),
      eq(userClipsTable.visibility, "public"),
      eq(userClipsTable.showInPortfolio, true),
      eq(userClipsTable.isHidden, false),
    ))
    .orderBy(desc(userClipsTable.createdAt));

  const storageReady = isBunnyStorageConfigured();
  const portfolioClips = clips.map((clip) => {
    const live = isLiveVideoId(clip.videoId);
    const thumbnailTime = clip.thumbnailTime != null ? parseFloat(clip.thumbnailTime) : null;
    let playbackStatus: "ready" | "processing" | "expired" | "unavailable" =
      live
        ? "unavailable"
        : planPortfolioPlayback(clip, storageReady, isUserClipExportInFlight(clip.id)).status;
    let playbackUrl: string | null = null;

    if (playbackStatus === "ready" && clip.exportedUrl && isBackupExportRef(clip.exportedUrl)) {
      playbackUrl = portfolioPlaybackPath(clip.id);
    } else if (playbackStatus === "ready" && clip.exportedUrl) {
      if (!getPortfolioClipStoragePath(clip.id, clip.exportedUrl)) {
        playbackStatus = "unavailable";
      } else {
        playbackUrl = getBunnyPortfolioPlaybackUrl(clip.id, clip.exportedUrl)
          ?? portfolioPlaybackPath(clip.id);
      }
    }

    return {
      id: clip.id,
      userId: clip.userId,
      title: clip.title,
      startTime: parseFloat(clip.startTime),
      endTime: parseFloat(clip.endTime),
      cropPath: clip.cropPath,
      visibility: "public" as const,
      likeCount: clip.likeCount,
      aspectRatio: clip.aspectRatio,
      thumbnailTime,
      thumbnailUrl: null,
      playbackUrl,
      playbackStatus,
      createdAt: clip.createdAt.toISOString(),
      academyId: clip.academyId ?? null,
      introVideoUrl: null,
    };
  });

  return {
    id: user.id,
    name: user.name,
    age: user.age ?? null,
    position: user.position ?? null,
    nation: user.nation ?? null,
    profilePhoto: user.profilePhoto ?? null,
    followerCount: Number(followerResult?.count ?? 0),
    followingCount: Number(followingResult?.count ?? 0),
    clipCount: Number(clipResult?.count ?? 0),
    history: history.map((item) => ({
      id: item.id,
      teamName: item.teamName,
      roleLabel: item.roleLabel,
      startYear: item.startYear,
      endYear: item.endYear ?? null,
      isCurrent: item.isCurrent,
      displayOrder: item.displayOrder,
    })),
    clips: portfolioClips,
    canEdit,
  };
}

router.get("/users/:id/portfolio", async (req, res): Promise<void> => {
  const params = GetUserPortfolioParams.safeParse({ id: req.params.id });
  if (!params.success || params.data.id <= 0) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const viewerId = await getLocalAccountUserId(req);
  const portfolio = await buildPortfolio(params.data.id, viewerId === params.data.id);
  if (!portfolio) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  res.json(GetUserPortfolioResponse.parse(portfolio));
});

router.patch("/users/:id/portfolio", async (req, res): Promise<void> => {
  const params = UpdateUserPortfolioParams.safeParse({ id: req.params.id });
  if (!params.success || params.data.id <= 0) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const ownerId = await getLocalAccountUserId(req);
  if (!ownerId) {
    unauthenticatedResponse(res, req);
    return;
  }
  if (ownerId !== params.data.id) {
    res.status(403).json({ error: "Only the portfolio owner can update it" });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id, isGuest: usersTable.isGuest })
    .from(usersTable)
    .where(eq(usersTable.id, params.data.id));
  if (!existing || existing.isGuest) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const body = UpdateUserPortfolioBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid portfolio data" });
    return;
  }
  const validationError = validatePortfolioBody(body.data);
  if (validationError) {
    if (validationError.startsWith("Profile photo must be 1.5 MiB")) {
      res.status(413).json({ error: validationError });
    } else {
      res.status(400).json({ error: validationError });
    }
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({
        name: body.data.name.trim(),
        age: body.data.age,
        position: body.data.position?.trim() || null,
        nation: body.data.nation?.trim() || null,
        profilePhoto: body.data.profilePhoto,
      })
      .where(eq(usersTable.id, ownerId));

    await tx
      .delete(portfolioHistoryTable)
      .where(eq(portfolioHistoryTable.userId, ownerId));

    if (body.data.history.length > 0) {
      await tx.insert(portfolioHistoryTable).values(body.data.history.map((item) => ({
        userId: ownerId,
        teamName: item.teamName.trim(),
        roleLabel: item.roleLabel.trim(),
        startYear: item.startYear,
        endYear: item.endYear,
        isCurrent: item.isCurrent,
        displayOrder: item.displayOrder,
      })));
    }
  });

  const portfolio = await buildPortfolio(ownerId, true);
  if (!portfolio) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(UpdateUserPortfolioResponse.parse(portfolio));
});

export default router;
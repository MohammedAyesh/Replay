import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  CreateAdminReviewerSignInLinksBody,
  CreateAdminReviewerSignInLinksResponse,
  type AdminReviewerSignInLinksInput,
} from "@workspace/api-zod";
import { getLocalUserId } from "../lib/clerkUserBridge";
import { createClerkSignInToken } from "../lib/clerkSignInTokens";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const SECONDS_PER_DAY = 24 * 60 * 60;

function getReplayOrigin(): string | null {
  const configuredDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (!configuredDomain) return null;

  try {
    const url = new URL(
      configuredDomain.includes("://") ? configuredDomain : `https://${configuredDomain}`,
    );
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

router.post("/admin/reviewer-sign-in-links", async (req, res): Promise<void> => {
  const adminId = await getLocalUserId(req);
  if (!adminId) {
    res.status(403).json({ error: "Forbidden" });
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

  res.setHeader("Cache-Control", "no-store");
  const parsed = CreateAdminReviewerSignInLinksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide one Replay user and valid link settings." });
    return;
  }

  const input = parsed.data as AdminReviewerSignInLinksInput & {
    email?: string;
    userId?: number;
    count?: number;
    validityDays?: number;
  };
  const hasEmail = typeof input.email === "string";
  const hasUserId = typeof input.userId === "number";
  const count = input.count ?? 3;
  const validityDays = input.validityDays ?? 30;
  if (
    hasEmail === hasUserId
    || (hasUserId && !Number.isSafeInteger(input.userId))
    || !Number.isSafeInteger(count)
    || count < 1
    || count > 5
    || !Number.isSafeInteger(validityDays)
    || validityDays < 1
    || validityDays > 30
  ) {
    res.status(400).json({ error: "Provide one Replay user and valid link settings." });
    return;
  }

  const targetFilter = hasUserId
    ? eq(usersTable.id, input.userId!)
    : eq(sql`lower(${usersTable.email})`, input.email!.trim().toLowerCase());
  const [target] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      isGuest: usersTable.isGuest,
      isAdmin: usersTable.isAdmin,
      clerkId: usersTable.clerkId,
    })
    .from(usersTable)
    .where(targetFilter);

  if (!target) {
    res.status(404).json({ error: "Replay user not found." });
    return;
  }
  if (target.isGuest) {
    res.status(400).json({ error: "Guest accounts cannot receive reviewer sign-in links." });
    return;
  }
  if (target.isAdmin) {
    res.status(400).json({ error: "Reviewer sign-in links cannot target admin accounts." });
    return;
  }
  if (!target.clerkId) {
    res.status(400).json({ error: "This user is not linked to a Clerk account." });
    return;
  }

  const origin = getReplayOrigin();
  if (!origin) {
    res.status(503).json({ error: "Reviewer sign-in links are unavailable because the app domain is not configured." });
    return;
  }

  const urls: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const token = await createClerkSignInToken(
        target.clerkId,
        validityDays * SECONDS_PER_DAY,
      );
      const url = new URL("/reviewer-sign-in", origin);
      url.searchParams.set("token", token);
      urls.push(url.toString());
    }
  } catch {
    logger.error(
      { adminId, targetUserId: target.id },
      "Clerk reviewer sign-in token creation failed",
    );
    res.status(502).json({ error: "Clerk could not create reviewer sign-in links. Try again." });
    return;
  }

  const createdAt = new Date().toISOString();
  logger.info({
    adminId,
    targetUserId: target.id,
    targetEmail: target.email,
    linkCount: count,
    validityDays,
    createdAt,
  }, "Reviewer sign-in links created");

  res.status(201).json(CreateAdminReviewerSignInLinksResponse.parse({ urls }));
});

export default router;

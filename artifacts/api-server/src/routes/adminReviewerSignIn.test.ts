import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { db, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  getLocalUserId: vi.fn(),
  createClerkSignInToken: vi.fn(),
}));

vi.mock("../lib/clerkUserBridge", () => ({
  getLocalUserId: mocks.getLocalUserId,
}));
vi.mock("../lib/clerkSignInTokens", () => ({
  createClerkSignInToken: mocks.createClerkSignInToken,
}));

import { getLocalUserId } from "../lib/clerkUserBridge";
import { createClerkSignInToken } from "../lib/clerkSignInTokens";

const mockedGetLocalUserId = vi.mocked(getLocalUserId);
const mockedCreateClerkSignInToken = vi.mocked(createClerkSignInToken);
const TAG = `reviewer_links_${Date.now()}`;
const originalDomains = process.env.REPLIT_DOMAINS;
const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
const originalPublicShareBaseUrl = process.env.PUBLIC_SHARE_BASE_URL;
let app: Express;
let insertedIds: number[] = [];
let adminId: number;
let nonAdminId: number;
let targetId: number;
let guestId: number;
let adminTargetId: number;
let unlinkedId: number;
let targetEmail: string;
let ticketNumber = 0;

beforeAll(async () => {
  process.env.REPLIT_DOMAINS = "replayjo.replit.app";
  process.env.PUBLIC_BASE_URL = "https://replayjo.com";
  delete process.env.PUBLIC_SHARE_BASE_URL;
  const { default: reviewerSignInRouter } = await import("./adminReviewerSignIn");
  app = express();
  app.use(express.json());
  app.use("/api", reviewerSignInRouter);

  targetEmail = `target_${TAG}@example.test`;
  const rows = await db.insert(usersTable).values([
    { name: "Reviewer Links Admin", email: `admin_${TAG}@example.test`, isAdmin: true, clerkId: `clerk_admin_${TAG}` },
    { name: "Reviewer Links Member", email: `member_${TAG}@example.test`, clerkId: `clerk_member_${TAG}` },
    { name: "Reviewer Links Target", email: targetEmail, clerkId: `clerk_target_${TAG}` },
    { name: "Reviewer Links Guest", email: `guest_${TAG}@example.test`, isGuest: true, clerkId: `clerk_guest_${TAG}` },
    { name: "Reviewer Links Admin Target", email: `admin_target_${TAG}@example.test`, isAdmin: true, clerkId: `clerk_admin_target_${TAG}` },
    { name: "Reviewer Links Unlinked", email: `unlinked_${TAG}@example.test` },
  ]).returning({ id: usersTable.id });

  insertedIds = rows.map((row) => row.id);
  [adminId, nonAdminId, targetId, guestId, adminTargetId, unlinkedId] = insertedIds;
});

afterAll(async () => {
  if (insertedIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, insertedIds));
  }
  if (originalDomains === undefined) delete process.env.REPLIT_DOMAINS;
  else process.env.REPLIT_DOMAINS = originalDomains;
  if (originalPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  if (originalPublicShareBaseUrl === undefined) delete process.env.PUBLIC_SHARE_BASE_URL;
  else process.env.PUBLIC_SHARE_BASE_URL = originalPublicShareBaseUrl;
});

beforeEach(() => {
  ticketNumber = 0;
  mockedGetLocalUserId.mockResolvedValue(adminId);
  mockedCreateClerkSignInToken.mockReset().mockImplementation(async () => `reviewer-ticket-${++ticketNumber}`);
});

const postLinks = (body: unknown) =>
  request(app).post("/api/admin/reviewer-sign-in-links").send(body as object);

describe("admin reviewer sign-in links", () => {
  it("requires an authenticated admin", async () => {
    mockedGetLocalUserId.mockResolvedValue(null);
    await postLinks({ email: targetEmail }).expect(403);

    mockedGetLocalUserId.mockResolvedValue(nonAdminId);
    await postLinks({ email: targetEmail }).expect(403);
    expect(mockedCreateClerkSignInToken).not.toHaveBeenCalled();
  });

  it("rejects unknown, guest, admin, and non-Clerk targets", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    await postLinks({ email: `missing_${TAG}@example.test` }).expect(404);
    await postLinks({ userId: guestId }).expect(400);
    await postLinks({ userId: adminTargetId }).expect(400);
    await postLinks({ userId: unlinkedId }).expect(400);
    expect(mockedCreateClerkSignInToken).not.toHaveBeenCalled();
  });

  it.each([
    { name: "invalid email", body: { email: "bad-email" } },
    { name: "both user selectors", body: { email: targetEmail, userId: targetId } },
    { name: "missing user selector", body: { count: 1 } },
    { name: "count below minimum", body: { email: targetEmail, count: 0 } },
    { name: "count above maximum", body: { email: targetEmail, count: 6 } },
    { name: "fractional count", body: { email: targetEmail, count: 1.5 } },
    { name: "validity below minimum", body: { email: targetEmail, validityDays: 0 } },
    { name: "validity above maximum", body: { email: targetEmail, validityDays: 31 } },
    { name: "fractional validity", body: { email: targetEmail, validityDays: 1.5 } },
  ])("validates request limits ($name)", async ({ body }) => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    await postLinks(body).expect(400);
    expect(mockedCreateClerkSignInToken).not.toHaveBeenCalled();
  });

  it("defaults to three links for 30 days and returns only Replay sign-in URLs", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const response = await postLinks({ email: targetEmail.toUpperCase() }).expect(201);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.body)).toEqual(["urls"]);
    expect(response.body.urls).toEqual([
      "https://replayjo.com/reviewer-sign-in?token=reviewer-ticket-1",
      "https://replayjo.com/reviewer-sign-in?token=reviewer-ticket-2",
      "https://replayjo.com/reviewer-sign-in?token=reviewer-ticket-3",
    ]);
    expect(mockedCreateClerkSignInToken).toHaveBeenCalledTimes(3);
    expect(mockedCreateClerkSignInToken).toHaveBeenNthCalledWith(1, `clerk_target_${TAG}`, 30 * 24 * 60 * 60);
  });

  it("builds links from the configured public base URL, not the Replit domain", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const response = await postLinks({ email: targetEmail, count: 1 }).expect(201);

    expect(response.body.urls[0]).toMatch(/^https:\/\/replayjo\.com\/reviewer-sign-in\?token=/);
  });

  it("accepts the minimum and maximum supported bounds by user ID", async () => {
    mockedGetLocalUserId.mockResolvedValue(adminId);
    const min = await postLinks({ userId: targetId, count: 1, validityDays: 1 }).expect(201);
    expect(min.body.urls).toHaveLength(1);
    expect(mockedCreateClerkSignInToken).toHaveBeenNthCalledWith(1, `clerk_target_${TAG}`, 24 * 60 * 60);

    mockedCreateClerkSignInToken.mockClear();
    const max = await postLinks({ userId: targetId, count: 5, validityDays: 30 }).expect(201);
    expect(max.body.urls).toHaveLength(5);
    expect(mockedCreateClerkSignInToken).toHaveBeenCalledTimes(5);
    expect(mockedCreateClerkSignInToken).toHaveBeenNthCalledWith(5, `clerk_target_${TAG}`, 30 * 24 * 60 * 60);
  });
});

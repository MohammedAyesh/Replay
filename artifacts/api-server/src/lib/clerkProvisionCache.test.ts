import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Request } from "express";

// Clerk's servers: one profile per Clerk id, counted.
const clerk = vi.hoisted(() => ({ calls: 0, users: new Map<string, { firstName: string; lastName: string; email: string }>() }));
vi.mock("@clerk/express", () => ({
  createClerkClient: vi.fn(() => ({
    users: {
      getUser: vi.fn(async (id: string) => {
        clerk.calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        const u = clerk.users.get(id);
        return { id, firstName: u?.firstName ?? "", lastName: u?.lastName ?? "", emailAddresses: u ? [{ id: "e1", emailAddress: u.email }] : [], primaryEmailAddressId: "e1", unsafeMetadata: {}, publicMetadata: {} };
      }),
    },
  })),
  getAuth: vi.fn((req: { headers: Record<string, string> }) => ({ userId: req.headers["x-clerk-user"] ?? null })),
  clerkClient: undefined,
}));

import { db, usersTable } from "@workspace/db";
import { PROVISION_TTL_MS, forgetClerkProvision, getLocalUserRecord } from "./clerkUserBridge";

const tag = Date.now();
const req = (clerkId: string) => ({ headers: { "x-clerk-user": clerkId }, cookies: {} }) as unknown as Request;

describe("Clerk profile check, remembered per user", () => {
  const clerkId = `user_cache_${tag}`;
  beforeAll(() => {
    clerk.users.set(clerkId, { firstName: "Cache", lastName: "Test", email: `cache-${tag}@example.com` });
  });

  it("asks Clerk once for a burst of requests, then not again for a while", async () => {
    forgetClerkProvision();
    clerk.calls = 0;
    const users = await Promise.all(Array.from({ length: 6 }, () => getLocalUserRecord(req(clerkId))));
    expect(new Set(users.map((u) => u?.id)).size).toBe(1);
    expect(users[0]).toMatchObject({ clerkId, name: "Cache Test" });
    expect(clerk.calls).toBe(1);
    await getLocalUserRecord(req(clerkId));
    await getLocalUserRecord(req(clerkId));
    expect(clerk.calls).toBe(1);
    expect(PROVISION_TTL_MS).toBe(600_000);
  });

  it("checks with Clerk again once the time is up, and picks up a changed name", async () => {
    clerk.users.set(clerkId, { firstName: "Renamed", lastName: "Player", email: `cache-${tag}@example.com` });
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + PROVISION_TTL_MS + 1);
    try {
      const user = await getLocalUserRecord(req(clerkId));
      expect(clerk.calls).toBe(2);
      expect(user?.name).toBe("Renamed Player");
    } finally {
      spy.mockRestore();
    }
  });

  it("asks Clerk again when the remembered user's row is gone", async () => {
    const before = await getLocalUserRecord(req(clerkId));
    await db.delete(usersTable).where(eq(usersTable.id, before!.id));
    const calls = clerk.calls;
    const after = await getLocalUserRecord(req(clerkId));
    expect(clerk.calls).toBe(calls + 1);
    expect(after?.id).not.toBe(before!.id);
    expect(after?.clerkId).toBe(clerkId);
  });

  it("never mixes two users", async () => {
    const other = `user_cache_other_${tag}`;
    clerk.users.set(other, { firstName: "Other", lastName: "One", email: `other-${tag}@example.com` });
    const [a, b] = await Promise.all([getLocalUserRecord(req(clerkId)), getLocalUserRecord(req(other))]);
    expect(a?.clerkId).toBe(clerkId);
    expect(b?.clerkId).toBe(other);
  });
});

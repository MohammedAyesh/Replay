import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/express", () => ({
  createClerkClient: vi.fn(() => ({
    users: { getUser: vi.fn() },
  })),
  getAuth: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  usersTable: {},
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { getClerkProfileSyncPlan } from "./clerkUserBridge";

const profile = {
  existingUserId: 314,
  existingName: "Old Name",
  existingEmail: "clerk_user_314@soccerwatch.local",
  freshName: "Fresh Name",
  freshEmail: "player@example.com",
  emailOwnerId: null as number | null,
  emailOwnershipKnown: true,
};

describe("getClerkProfileSyncPlan", () => {
  it("preserves the local email when another row owns the fresh Clerk email", () => {
    expect(
      getClerkProfileSyncPlan({
        ...profile,
        emailOwnerId: 27,
      }),
    ).toEqual({
      updateName: true,
      updateEmail: false,
      emailConflictUserId: 27,
    });
  });

  it("still syncs a fresh email when ownership is available", () => {
    expect(getClerkProfileSyncPlan(profile)).toEqual({
      updateName: true,
      updateEmail: true,
      emailConflictUserId: null,
    });
  });

  it("does not overwrite email when ownership could not be checked", () => {
    expect(
      getClerkProfileSyncPlan({
        ...profile,
        emailOwnershipKnown: false,
      }),
    ).toEqual({
      updateName: true,
      updateEmail: false,
      emailConflictUserId: null,
    });
  });

  it("does not treat the current row as an email conflict", () => {
    expect(
      getClerkProfileSyncPlan({
        ...profile,
        emailOwnerId: profile.existingUserId,
      }),
    ).toEqual({
      updateName: true,
      updateEmail: true,
      emailConflictUserId: null,
    });
  });
});
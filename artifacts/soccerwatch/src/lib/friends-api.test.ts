import { describe, expect, it } from "vitest";
import { friendStatusFor, normalizeFriendInviteSelection, type FriendsData } from "./friends-api";

const data: FriendsData = {
  friends: [{ userId: 1, name: "Friend", avatarUrl: null, position: null }],
  incoming: [{ userId: 2, name: "Incoming", avatarUrl: null, position: null, requestId: 20 }],
  outgoing: [{ userId: 3, name: "Outgoing", avatarUrl: null, position: null, requestId: 30 }],
};

describe("friendStatusFor", () => {
  it("returns accepted, pending, and empty states with request ids", () => {
    expect(friendStatusFor(1, data)).toEqual({ status: "friends" });
    expect(friendStatusFor(2, data)).toEqual({ status: "incoming", requestId: 20 });
    expect(friendStatusFor(3, data)).toEqual({ status: "outgoing", requestId: 30 });
    expect(friendStatusFor(4, data)).toEqual({ status: "none" });
    expect(friendStatusFor(4, undefined)).toEqual({ status: "none" });
  });
});

describe("normalizeFriendInviteSelection", () => {
  it("removes friends already on the roster, de-duplicates, and caps at 30", () => {
    const friends = Array.from({ length: 35 }, (_, index) => ({
      userId: index + 1,
      name: `Friend ${index + 1}`,
      avatarUrl: null,
      position: null,
    }));
    const selected = Array.from({ length: 35 }, (_, index) => index + 1);
    const roster = [{ userId: 2 }, { userId: 35 }, { userId: null }];
    const result = normalizeFriendInviteSelection([...selected, 1], friends, roster);
    expect(result).toHaveLength(30);
    expect(result).not.toContain(2);
    expect(result).not.toContain(35);
    expect(new Set(result).size).toBe(result.length);
  });
});
import { describe, expect, it } from "vitest";
import { clearPendingFriendLink, readPendingFriendLink, writePendingFriendLink } from "./friend-link-pending";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("pending friend-link storage", () => {
  it("returns a matching code for one hour and expires it after that", () => {
    const storage = memoryStorage();
    writePendingFriendLink("abC234", storage, 1_000);
    expect(readPendingFriendLink("ABC234", storage, 1_000 + 59 * 60_000)).toBe("ABC234");
    expect(readPendingFriendLink("ABC234", storage, 1_000 + 60 * 60_000)).toBeNull();
    expect(readPendingFriendLink("ABC234", storage, 1_000 + 60 * 60_000 + 1)).toBeNull();
  });

  it("clears mismatched and malformed pending links", () => {
    const storage = memoryStorage();
    writePendingFriendLink("ABC234", storage, 100);
    expect(readPendingFriendLink("OTHER2", storage, 101)).toBeNull();
    expect(readPendingFriendLink("ABC234", storage, 101)).toBeNull();
    storage.setItem("replay_pending_friend_link", "{bad json");
    expect(readPendingFriendLink("ABC234", storage, 102)).toBeNull();
    clearPendingFriendLink(storage);
  });
});
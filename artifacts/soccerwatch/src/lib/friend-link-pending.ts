const STORAGE_KEY = "replay_pending_friend_link";
const MAX_AGE_MS = 60 * 60 * 1000;

type PendingFriendLink = { code: string; at: number };
type FriendLinkStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): FriendLinkStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function writePendingFriendLink(code: string, storage = defaultStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ code: code.toUpperCase(), at: now }));
  } catch {
    // Private browsing or a storage policy may prevent session storage.
  }
}

export function readPendingFriendLink(
  code: string,
  storage = defaultStorage(),
  now = Date.now(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<PendingFriendLink>;
    const pendingCode = pending.code;
    const age = now - Number(pending.at);
    const valid = typeof pendingCode === "string"
      && pendingCode.toUpperCase() === code.toUpperCase()
      && Number.isFinite(age)
      && age >= 0
      && age < MAX_AGE_MS;
    if (!valid) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return pendingCode.toUpperCase();
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore inaccessible storage.
    }
    return null;
  }
}

export function clearPendingFriendLink(storage = defaultStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore inaccessible storage.
  }
}
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";

/**
 * One-time explainers ("coach marks"). Each explainer has a key; once the
 * player has seen it (tapped Got it, or did the action it points at) it never
 * shows again on that device for that account.
 *
 * Keys carry a version (".v1") so a rewritten explainer can show again by
 * bumping it. Storage is per account (the Replay user id, or "guest"), and
 * every read and write is wrapped: private windows and blocked storage simply
 * mean the explainer shows, never that the page breaks.
 */

export type ExplainerKey =
  | "clip-player.look-around.v1"
  | "clip-player.record.v1"
  | "match-page.invite.v1"
  | "home.first-clip.dismissed.v1"
  | "free-match.home.dismissed.v1"
  // Not explainers: steps of Home's "Get your first clip" that only this device can see.
  | "home.first-clip.watched.v1"
  | "home.first-clip.shared.v1";

const PREFIX = "replay.seen";
const listeners = new Set<() => void>();

function storageKey(owner: string, key: ExplainerKey): string {
  return `${PREFIX}:${owner}:${key}`;
}

/** The storage owner for an account: its id, "guest", or "anon" when signed out. */
export function ownerOf(user: { id: number; isGuest?: boolean } | null | undefined): string {
  return user ? (user.isGuest ? "guest" : String(user.id)) : "anon";
}

export function hasSeen(owner: string, key: ExplainerKey): boolean {
  try {
    return window.localStorage.getItem(storageKey(owner, key)) === "1";
  } catch {
    return false;
  }
}

export function markSeen(owner: string, key: ExplainerKey): void {
  try {
    window.localStorage.setItem(storageKey(owner, key), "1");
  } catch {
    // Storage unavailable: the explainer may show again next visit, which is fine.
  }
  listeners.forEach((listener) => listener());
}

/**
 * `[show, dismiss]` for one explainer. `show` is false until the account is
 * known, so a signed-in player never sees a guest's explainer flash first.
 * `enabled` lets the caller hold an explainer back until its moment (for
 * example, until the video is actually playing).
 */
export function useFirstTime(key: ExplainerKey, enabled = true): [boolean, () => void] {
  const { user, isLoading } = useAuth();
  // Signed-out visitors (share links) count as one "anon" owner on the device.
  const owner = user ? (user.isGuest ? "guest" : String(user.id)) : isLoading ? null : "anon";
  const [seen, setSeen] = useState(() => (owner ? hasSeen(owner, key) : true));

  useEffect(() => {
    if (!owner) return;
    setSeen(hasSeen(owner, key));
    const listener = () => setSeen(hasSeen(owner, key));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [owner, key]);

  const dismiss = useCallback(() => {
    if (owner) markSeen(owner, key);
    setSeen(true);
  }, [owner, key]);

  return [Boolean(owner) && !isLoading && enabled && !seen, dismiss];
}

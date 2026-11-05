import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/academy-studio-api";
import { siteServiceWorker } from "@/lib/video-cache";

/**
 * Chat notifications on this device (api-server routes/academyNotifications.ts): the console's
 * "Notify me" switch. Subscribing turns on notifications for every academy or field this person
 * answers chats in; the service worker (public/video-cache-sw.js) shows them.
 *
 *   unsupported  this browser can't (an iPhone outside the Home Screen app, an old browser)
 *   ios-install  an iPhone or iPad in Safari: add Replay to the Home Screen first (iOS 16.4+)
 *   blocked      the person said no; only the browser's site settings can undo it
 *   off / on
 */
export type PushState = "loading" | "unsupported" | "ios-install" | "blocked" | "off" | "on";

const path = (academyId: number) => `/academy/console/academies/${academyId}/notifications`;

export function isIos(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || window.matchMedia?.("(display-mode: fullscreen)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The base64url VAPID key as the bytes PushManager wants. */
export function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await siteServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

export function useChatNotifications(academyId: number | null) {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (academyId === null) return;
    if (!pushSupported()) { setState(isIos() && !standalone() ? "ios-install" : "unsupported"); return; }
    if (Notification.permission === "denied") { setState("blocked"); return; }
    try {
      const sub = await currentSubscription();
      if (!sub) { setState("off"); return; }
      const r = await call<{ on: boolean }>(`${path(academyId)}?endpoint=${encodeURIComponent(sub.endpoint)}`);
      setState(r.on ? "on" : "off");
    } catch {
      setState("off");
    }
  }, [academyId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const turnOn = useCallback(async () => {
    if (academyId === null) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState(permission === "denied" ? "blocked" : "off"); return; }
      const reg = await siteServiceWorker();
      if (!reg) throw new Error("no worker");
      await navigator.serviceWorker.ready;
      const { publicKey } = await call<{ publicKey: string }>(path(academyId));
      let sub = await reg.pushManager.getSubscription();
      // A subscription made with another key can't be used: start again.
      const key = sub?.options.applicationServerKey;
      if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== publicKey) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
      await call(path(academyId), { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
      setState("on");
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }, [academyId]);

  const turnOff = useCallback(async () => {
    if (academyId === null) return;
    setBusy(true);
    setError(null);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await call(path(academyId), { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
        await sub.unsubscribe().catch(() => false);
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }, [academyId]);

  return { state, busy, error, turnOn, turnOff };
}

/** A notification's link (/academy/chats?a=3&phone=… or &thread=…): which academy and chat to open. */
export function readChatLink(search = typeof window !== "undefined" ? window.location.search : ""): { academyId: number | null; phone: string | null; thread: number | null } {
  const q = new URLSearchParams(search);
  const a = Number(q.get("a"));
  const t = Number(q.get("thread"));
  const phone = q.get("phone");
  return {
    academyId: Number.isSafeInteger(a) && a > 0 ? a : null,
    phone: phone && /^[0-9a-z@._:-]{3,64}$/i.test(phone) ? phone : null,
    thread: Number.isSafeInteger(t) && t > 0 ? t : null,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, X } from "lucide-react";
import { apiBase, matchKey } from "@/lib/match-api";
import {
  FIRST_FRAME_TIMEOUT_MS, POLL_MS, STALL_TIMEOUT_MS,
  canDecodeHevc, earlyPlayPositionKey, initialSource, interpretProbe, loadKey, mediaMessage,
  offlineMessage, onFirstFrameTimeout, onStall, planForMediaError, pollFailedMessage, probeMessage,
  reasonMessage, savedPosition, showCard, sourceUrl, stallMessage,
  type EarlyPlayReason, type EarlyPlayStatus, type Source,
} from "./earlyPlayLogic";

export type { EarlyPlayReason, EarlyPlayState, EarlyPlayStatus } from "./earlyPlayLogic";
export { earlyPlayPositionKey } from "./earlyPlayLogic";

export function supportsEarlyHevc(): boolean {
  return canDecodeHevc(document.createElement("video"), typeof MediaSource === "undefined" ? undefined : MediaSource);
}
export const earlyReasonMessage = (code: EarlyPlayReason | undefined, locale: string) => reasonMessage(code, locale);
export const mediaErrorMessage = (errorCode: number, locale: string) => mediaMessage(errorCode, locale);

function readPosition(code: string, durationSec?: number | null): number {
  try { return savedPosition(sessionStorage.getItem(earlyPlayPositionKey(code)), durationSec); } catch { return 0; }
}
function writePosition(code: string, seconds: number | null): void {
  try {
    if (seconds === null) sessionStorage.removeItem(earlyPlayPositionKey(code));
    else sessionStorage.setItem(earlyPlayPositionKey(code), String(seconds));
  } catch { /* storage is optional */ }
}

type Props = { code: string; locale: string; compact?: boolean; previewState?: "early" | "unsupported" | "notAvailable" };

export function EarlyPlay({ code, locale, compact = false, previewState }: Props) {
  const ar = locale === "ar";
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EarlyPlayStatus | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("proxy");
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);
  const [retryNonce, setRetryNonce] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const statusRef = useRef<EarlyPlayStatus | null>(null);
  const sourceRef = useRef<Source>("proxy");
  const gotFrame = useRef(false);
  const pendingSeek = useRef(0);
  const firstFrameTimer = useRef<number | undefined>(undefined);
  const stallTimer = useRef<number | undefined>(undefined);
  statusRef.current = status;
  sourceRef.current = source;

  const fetchStatus = useCallback(async (): Promise<EarlyPlayStatus | null> => {
    try {
      const response = await fetch(`${apiBase}/matches/${encodeURIComponent(code)}/early-play`, { credentials: "include" });
      if (!response.ok) return null;
      return await response.json() as EarlyPlayStatus;
    } catch {
      return null;
    }
  }, [code]);

  // Poll. A failed background poll never touches the player: it only shows a
  // quiet note on the card, and the last good status stays in place.
  const refresh = useCallback(async () => {
    const next = await fetchStatus();
    if (!next) { setPollFailed(true); return; }
    setPollFailed(false);
    setStatus(next);
    if (next.state === "ready") void queryClient.invalidateQueries({ queryKey: matchKey(code) });
  }, [code, fetchStatus, queryClient]);

  useEffect(() => {
    if (previewState) {
      setStatus({ state: "early", streamUrl: "/fixture.mp4", encodeProgress: 62 });
      setSupported(previewState !== "unsupported");
      setOpen(previewState === "notAvailable");
      setError(previewState === "notAvailable" ? probeMessage({ kind: "gone" }, locale) : "");
      return;
    }
    setSupported(supportsEarlyHevc());
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [locale, previewState, refresh]);

  useEffect(() => {
    const onOffline = () => { setOffline(true); videoRef.current?.pause(); };
    const onOnline = () => setOffline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => { window.removeEventListener("offline", onOffline); window.removeEventListener("online", onOnline); };
  }, []);

  const clearTimers = () => { window.clearTimeout(firstFrameTimer.current); window.clearTimeout(stallTimer.current); };
  useEffect(() => clearTimers, []);

  const fallbackToProxy = useCallback(() => {
    clearTimers();
    pendingSeek.current = videoRef.current?.currentTime || pendingSeek.current;
    setError("");
    setSource("proxy");
  }, []);

  const armStall = useCallback(() => {
    window.clearTimeout(stallTimer.current);
    stallTimer.current = window.setTimeout(() => {
      if (onStall(sourceRef.current, statusRef.current) === "fallback") fallbackToProxy();
      else setError(stallMessage(locale));
    }, STALL_TIMEOUT_MS);
  }, [fallbackToProxy, locale]);

  // (Re)load the <video> only when loadKey changes: a new URL, a fallback or a
  // retry. Polls and timeupdates do not reload it.
  const key = loadKey(status, source, retryNonce, open && !error && previewState !== "notAvailable");
  useEffect(() => {
    const video = videoRef.current;
    const url = sourceUrl(statusRef.current, sourceRef.current);
    if (!key || !video || !url) return;
    gotFrame.current = false;
    video.src = url;
    video.load();
    void video.play().catch(() => { /* autoplay may need a tap; controls are shown */ });
    window.clearTimeout(firstFrameTimer.current);
    firstFrameTimer.current = window.setTimeout(() => {
      if (onFirstFrameTimeout(sourceRef.current, gotFrame.current, statusRef.current) === "fallback") fallbackToProxy();
    }, FIRST_FRAME_TIMEOUT_MS);
    return () => window.clearTimeout(firstFrameTimer.current);
  }, [key, fallbackToProxy]);

  const handleError = useCallback(async () => {
    clearTimers();
    const plan = planForMediaError(sourceRef.current, videoRef.current?.error?.code, statusRef.current);
    if (plan.kind === "fallback") { fallbackToProxy(); return; }
    if (plan.kind === "message") { setError(mediaMessage(plan.mediaCode, locale)); return; }
    // MediaError 4: a missing or forbidden URL looks exactly like an

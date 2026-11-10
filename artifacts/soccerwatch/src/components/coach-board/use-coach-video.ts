import { useEffect, useRef, useState, type RefObject } from "react";
import Hls from "hls.js";
import { canUseUhdPlayback, uhdPlaybackUrlForStreamUrl } from "@/lib/uhdPlayback";

/** The stream copy through the API's proxy (Bunny Stream needs its referer). */
export function proxiedStreamUrl(videoUrl: string): string {
  try {
    const u = new URL(videoUrl);
    if (u.hostname.endsWith(".b-cdn.net") && u.pathname.endsWith(".m3u8")) return `/api/hls-proxy/manifest?url=${encodeURIComponent(videoUrl)}`;
  } catch {
    // relative: already ours
  }
  return videoUrl;
}

/**
 * Play a recording in a plain <video>: the camera's 4K original when this
 * device can decode it, else (or when the 4K fails) the stream copy. Seeks to
 * `startAt` once playable. Returns an error message, or "".
 */
export function useCoachVideo(videoRef: RefObject<HTMLVideoElement | null>, videoUrl: string | null, startAt: number): { error: string; ready: boolean } {
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const startRef = useRef(startAt);
  startRef.current = startAt;

  useEffect(() => {
    const video = videoRef.current;
    setError("");
    setReady(false);
    if (!video || !videoUrl) return;
    let cancelled = false;
    let hls: Hls | null = null;
    let fellBack = false;
    const stream = proxiedStreamUrl(videoUrl);
    const uhd = uhdPlaybackUrlForStreamUrl(videoUrl);

    const onReady = () => {
      if (cancelled) return;
      setReady(true);
      setError("");
    };
    const seekOnce = (at: number) => {
      const go = () => {
        try { video.currentTime = Math.max(0, at); } catch { /* not seekable yet */ }
      };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(video.duration) && video.duration > 0) go();
      else video.addEventListener("loadedmetadata", go, { once: true });
    };

    const start = (url: string, isUhd: boolean, at: number) => {
      if (cancelled) return;
      if (hls) { hls.destroy(); hls = null; }
      const fail = () => {
        if (isUhd && !fellBack) {
          fellBack = true;
          start(stream, false, video.currentTime || at);
          return;
        }
        setError("video");
      };
      // An HLS playlist through hls.js; a plain file (an MP4) or Safari's native HLS straight into the element.
      if (Hls.isSupported() && /\.m3u8($|\?)|hls-proxy/.test(url)) {
        hls = new Hls({ maxBufferLength: 20, backBufferLength: 30, startPosition: Math.max(0, at) });
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) fail(); });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        video.src = url;
        video.onerror = fail;
        seekOnce(at);
      }
    };

    video.addEventListener("canplay", onReady);
    void canUseUhdPlayback(video, uhd).catch(() => false).then((ok) => start(ok && uhd ? uhd : stream, Boolean(ok && uhd), startRef.current));
    return () => {
      cancelled = true;
      video.removeEventListener("canplay", onReady);
      video.onerror = null;
      if (hls) hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [videoRef, videoUrl]);

  return { error, ready };
}

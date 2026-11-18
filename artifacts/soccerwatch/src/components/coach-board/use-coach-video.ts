import { useEffect, useRef, useState, type RefObject } from "react";
import Hls from "hls.js";
import { directStoragePlaylistForSourceUrl, isStreamlessStorageUrl } from "@/lib/uhdPlayback";

/** Keep browser playback on the supplied CDN URL; API relay URLs are not playable here. */
export function proxiedStreamUrl(videoUrl: string): string {
  return /\/api\/hls-proxy\//.test(videoUrl) ? "" : videoUrl;
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
    const streamless = isStreamlessStorageUrl(videoUrl);
    const stream = streamless
      ? directStoragePlaylistForSourceUrl(videoUrl, "h264")
        ?? directStoragePlaylistForSourceUrl(videoUrl, "4k")
        ?? ""
      : proxiedStreamUrl(videoUrl);
    const fallback = streamless && stream !== directStoragePlaylistForSourceUrl(videoUrl, "4k")
      ? directStoragePlaylistForSourceUrl(videoUrl, "4k")
      : null;

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
        if (!isUhd && fallback && !fellBack) {
          fellBack = true;
          start(fallback, true, video.currentTime || at);
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
    if (stream) start(stream, false, startRef.current);
    else setError("video");
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

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Hls from "hls.js";

/**
 * One video at a time.
 *
 * A phone that tries to decode the hero, a clip and a 3840-wide match at once
 * stutters, heats up and on some Androids simply stops showing frames. Every
 * player on the page registers here; starting one pauses the rest.
 */
let activeId: string | null = null;
const listeners = new Set<() => void>();

export function claimPlayback(id: string): void {
  if (activeId === id) return;
  activeId = id;
  for (const listener of listeners) listener();
}

export function releasePlayback(id: string): void {
  if (activeId !== id) return;
  activeId = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActivePlayback(): string | null {
  return useSyncExternalStore(subscribe, () => activeId, () => null);
}

/** True while the element is within `margin` of the viewport. */
export function useInView<T extends Element>(margin = "0px", threshold = 0.35) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { rootMargin: margin, threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [margin, threshold]);
  return { ref, inView };
}

export type HlsState = "idle" | "loading" | "ready" | "failed";

/**
 * Attach a VOD HLS source to a <video>, natively on Safari and through hls.js
 * elsewhere. Nothing is fetched until `enabled` is true, and everything is torn
 * down when it goes false, so a player that scrolls away stops downloading.
 */
export function useHlsSource(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  src: string | null,
  enabled: boolean,
  attempt = 0,
): HlsState {
  const [state, setState] = useState<HlsState>("idle");

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !enabled) {
      setState("idle");
      return;
    }
    setState("loading");
    let hls: Hls | null = null;
    const onReady = () => setState("ready");
    const onError = () => setState("failed");
    video.addEventListener("loadedmetadata", onReady);

    const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (!Hls.isSupported() && nativeHls) {
      video.addEventListener("error", onError);
      video.src = src;
      video.load();
    } else if (Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        backBufferLength: 30,
        capLevelToPlayerSize: false,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          return;
        }
        setState("failed");
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      setState("failed");
    }

    return () => {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
      if (hls) hls.destroy();
      else {
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [videoRef, src, enabled, attempt]);

  return state;
}

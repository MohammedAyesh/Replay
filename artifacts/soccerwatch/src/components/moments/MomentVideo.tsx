import { memo, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { UserClip } from "@workspace/api-client-react";
import { capPlaybackQuality } from "@/lib/hlsQuality";
import { applyFrameToVideo, frameToVideoStyle, interpolateFrame, type CropKeyframe } from "@/lib/cropFrame";
import { momentPlayback } from "@/lib/moment-deck";

export type MomentVideoState = "loading" | "ready" | "failed";

/**
 * One moment, muted and looping, for the swipe deck.
 *
 * A saved moment plays its own file (already cut and framed on the player),
 * which keeps working after the match video is deleted. A moment still being
 * saved plays its window of the match video, framed with the clip's crop.
 * If the saved file will not play, the match video is tried before giving up.
 *
 * `load` says when it may fetch (the card on top first, the next one after);
 * `active` says when it plays.
 */
export const MomentVideo = memo(function MomentVideo({ clip, active, load, onState }: {
  clip: UserClip;
  active: boolean;
  load: boolean;
  onState?: (state: MomentVideoState) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<MomentVideoState>("loading");
  const report = useRef(onState);
  report.current = onState;
  // Cards are keyed by clip, so the source is chosen once per mount.
  const [source, setSource] = useState(() => momentPlayback(clip));

  const set = (s: MomentVideoState) => { setState(s); report.current?.(s); };

  // Attach the source once this card may load.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !load || !source) {
      if (!source) set("failed");
      return;
    }
    set("loading");
    const onReady = () => set("ready");
    const onError = () => {
      // A saved file that will not play: fall back to the match video.
      if (source.kind === "file" && clip.playbackUrl) setSource({ kind: "stream", url: clip.playbackUrl });
      else set("failed");
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);

    let hls: Hls | null = null;
    let seek: (() => void) | null = null;
    if (source.kind === "file") {
      video.src = source.url;
    } else {
      let seeked = false;
      seek = () => {
        const dur = video.duration || 0;
        if (seeked || !(dur > 0 && isFinite(dur))) return;
        seeked = true;
        video.currentTime = clip.startTime * dur;
      };
      video.addEventListener("loadedmetadata", seek);
      video.addEventListener("durationchange", seek);
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: false, maxBufferLength: 20 });
        capPlaybackQuality(hls);
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) set("failed"); });
        hls.loadSource(source.url);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = source.url;
      } else {
        set("failed");
      }
    }
    return () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      if (seek) {
        video.removeEventListener("loadedmetadata", seek);
        video.removeEventListener("durationchange", seek);
      }
      if (hls) hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, source, clip.id]);

  // Play the card on top, hold the others on their first frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active && state === "ready") void video.play().catch(() => {});
    else if (!active) video.pause();
  }, [active, state]);

  // A match-video window loops by hand and follows the clip's crop.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || source?.kind !== "stream") return;
    const keyframes = (clip.cropPath ?? []) as CropKeyframe[];
    let raf = 0;
    const tick = () => {
      const dur = video.duration || 0;
      if (dur > 0 && isFinite(dur)) {
        const s = clip.startTime * dur;
        const e = clip.endTime * dur;
        if (video.currentTime >= e || video.currentTime < s - 1) video.currentTime = s;
        if (keyframes.length) applyFrameToVideo(video, interpolateFrame(keyframes, Math.max(0, Math.min(1, (video.currentTime - s) / Math.max(0.1, e - s)))));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source, clip.startTime, clip.endTime, clip.cropPath]);

  const keyframes = (clip.cropPath ?? []) as CropKeyframe[];
  const style = source?.kind === "stream" && keyframes.length
    ? frameToVideoStyle(interpolateFrame(keyframes, 0))
    : { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "contain" as const };

  return (
    <div dir="ltr" className="absolute inset-0 overflow-hidden bg-black">
      <video
        ref={videoRef}
        className="pointer-events-none"
        style={style}
        muted
        playsInline
        loop={source?.kind === "file"}
        preload={load ? "auto" : "none"}
        disablePictureInPicture
        aria-hidden="true"
      />
    </div>
  );
});

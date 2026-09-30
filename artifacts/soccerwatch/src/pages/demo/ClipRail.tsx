import { useEffect, useId, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

import type { DemoCopy } from "./copy";
import { formatClock, withBase, type DemoClip } from "./data";
import { claimPlayback, releasePlayback, useActivePlayback, useInView } from "./playback";

function ClipCard({ clip, copy }: { clip: DemoClip; copy: DemoCopy["sections"]["clips"] }) {
  const id = `clip-${useId()}`;
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useActivePlayback();
  const { ref, inView } = useInView<HTMLDivElement>("0px", 0.6);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  // Another player started, or this card scrolled away: stop.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if ((active !== id || !inView) && !video.paused) video.pause();
  }, [active, id, inView]);

  useEffect(() => () => releasePlayback(id), [id]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      claimPlayback(id);
      setStarted(true);
      void video.play().catch(() => setFailed(true));
    } else {
      video.pause();
    }
  };

  return (
    <div
      ref={ref}
      className={`dm-clip ${clip.aspectRatio === "9:16" ? "dm-clip--tall" : "dm-clip--wide"}`}
      data-testid={`demo-clip-${clip.id}`}
    >
      <video
        ref={videoRef}
        className="dm-clip-video"
        src={withBase(clip.src)}
        poster={withBase(clip.poster)}
        preload={started ? "auto" : "metadata"}
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        playsInline
        muted={muted}
        loop
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          releasePlayback(id);
        }}
        onError={() => setFailed(true)}
      />
      <button type="button" className="dm-clip-hit" onClick={toggle} aria-label={playing ? copy.pause : copy.play}>
        {!playing && (
          <span className="dm-play-disc" aria-hidden="true">
            <Play className="dm-icon" fill="currentColor" />
          </span>
        )}
      </button>
      <div className="dm-clip-foot">
        <span className="dm-tc">{duration !== null ? formatClock(duration) : ""}</span>
        {started && (
          <span className="dm-clip-tools">
            <button type="button" className="dm-icon-btn" onClick={toggle} aria-label={playing ? copy.pause : copy.play}>
              {playing ? <Pause className="dm-icon" /> : <Play className="dm-icon" />}
            </button>
            <button type="button" className="dm-icon-btn" onClick={() => setMuted((m) => !m)} aria-label={muted ? copy.unmute : copy.mute}>
              {muted ? <VolumeX className="dm-icon" /> : <Volume2 className="dm-icon" />}
            </button>
          </span>
        )}
      </div>
      {failed && <div className="dm-clip-failed" aria-hidden="true" />}
    </div>
  );
}

export function ClipRail({ clips, copy }: { clips: DemoClip[]; copy: DemoCopy["sections"]["clips"] }) {
  return (
    <div className="dm-rail" role="list">
      {clips.map((clip) => (
        <div role="listitem" key={clip.id} className="dm-rail-item">
          <ClipCard clip={clip} copy={copy} />
        </div>
      ))}
    </div>
  );
}

/**
 * The hero: a real clip, muted and looping, only while it is on screen. The
 * poster is the first paint; the video never blocks it.
 */
export function HeroVideo({ clip, fallbackPoster }: { clip: DemoClip | null; fallbackPoster: string | null }) {
  const id = "hero";
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useActivePlayback();
  const { ref, inView } = useInView<HTMLDivElement>("0px", 0.25);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip) return;
    if (inView && (active === null || active === id)) {
      claimPlayback(id);
      void video.play().catch(() => undefined);
    } else if (!video.paused) {
      video.pause();
      if (!inView) releasePlayback(id);
    }
  }, [inView, active, clip]);

  const poster = clip ? withBase(clip.poster) : fallbackPoster ? withBase(fallbackPoster) : undefined;
  return (
    <div ref={ref} className="dm-hero-media" aria-hidden="true">
      {clip ? (
        <video
          ref={videoRef}
          className={`dm-hero-video ${clip.aspectRatio === "9:16" ? "dm-hero-video--tall" : ""}`}
          src={withBase(clip.src)}
          poster={poster}
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : poster ? (
        <img className="dm-hero-video" src={poster} alt="" />
      ) : null}
      <div className="dm-hero-shade" />
    </div>
  );
}

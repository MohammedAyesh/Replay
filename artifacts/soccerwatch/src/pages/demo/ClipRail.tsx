import { useEffect, useId, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

import type { DemoCopy } from "./copy";
import { formatClock, withBase, type DemoClip } from "./data";
import { DemoLoader } from "./Loader";
import { claimPlayback, releasePlayback, useActivePlayback, useInView } from "./playback";

export function ClipCard({ clip, copy, near, autoplay }: { clip: DemoClip; copy: DemoCopy["sections"]["clips"]; near: boolean; autoplay: boolean }) {
  const id = `clip-${useId()}`;
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useActivePlayback();
  const { ref, inView } = useInView<HTMLDivElement>("240px 0px", 0.01);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [posterReady, setPosterReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [seen, setSeen] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const poster = withBase(clip.poster);

  // Autoplay (muted) while most of the card is on screen, unless the visitor
  // paused it or another video is playing.
  useEffect(() => {
    const node = ref.current;
    if (!autoplay || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setSeen(Boolean(entry?.isIntersecting)), { threshold: 0.6 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoplay, ref]);

  useEffect(() => {
    const video = videoRef.current;
    if (!autoplay || !video || userPaused || failed) return;
    if (seen && (active === null || active === id) && video.paused) {
      claimPlayback(id);
      setStarted(true);
      void video.play().catch(() => releasePlayback(id));
    } else if (!seen && !video.paused) {
      video.pause();
    }
  }, [autoplay, seen, active, id, userPaused, failed]);

  // Every poster in the rail starts loading as soon as the rail is near, not
  // when each card scrolls into the rail's own window: they are small stills,
  // and a card that is swiped to should already have its picture.
  useEffect(() => {
    if (!near || posterReady) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setPosterReady(true); };
    image.onerror = () => { if (!cancelled) setPosterReady(true); };
    image.src = poster;
    return () => { cancelled = true; };
  }, [near, poster, posterReady]);

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
      setUserPaused(false);
      setBuffering(video.readyState < 3);
      void video.play().catch(() => setFailed(true));
    } else {
      setUserPaused(true);
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
        poster={near || posterReady ? poster : undefined}
        preload={started ? "auto" : near || posterReady ? "metadata" : "none"}
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        playsInline
        muted={muted}
        loop
        onPlay={() => setPlaying(true)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onPause={() => {
          setPlaying(false);
          setBuffering(false);
          releasePlayback(id);
        }}
        onError={() => setFailed(true)}
      />
      {(!posterReady || buffering) && !failed && <DemoLoader label={copy.loading} />}
      <button type="button" className="dm-clip-hit" onClick={toggle} aria-label={playing ? copy.pause : copy.play}>
        {!playing && posterReady && !buffering && (
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

/**
 * The clips players cut, as the demo's own copies in the Jordan Galaxy
 * branding: the crest and the sign-off card are in the video itself, so
 * nothing is drawn over them here.
 */
export function ClipRail({ clips, copy, autoplayWide = false }: {
  clips: DemoClip[];
  copy: DemoCopy["sections"]["clips"];
  /** Wide (16:9) clips play by themselves, muted, while on screen. */
  autoplayWide?: boolean;
}) {
  const { ref, inView: near } = useInView<HTMLDivElement>("600px 0px", 0);
  return (
    <div ref={ref} className="dm-rail" role="list">
      {clips.map((clip) => (
        <div role="listitem" key={clip.id} className="dm-rail-item">
          <ClipCard clip={clip} copy={copy} near={near} autoplay={autoplayWide && clip.aspectRatio === "16:9"} />
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
      // A phone that blocks autoplay leaves it paused: give the claim back,
      // or no other player on the page (the live block) could ever start.
      void video.play().catch(() => releasePlayback(id));
    } else {
      if (!video.paused) video.pause();
      // Released whether or not it was playing: a hero that never started
      // (still loading, autoplay blocked) used to keep the claim for good.
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

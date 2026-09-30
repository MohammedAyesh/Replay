import { useEffect, useRef, useState } from "react";

import { HlsPlayer } from "@/components/HlsPlayer";
import { fetchLiveSource, nextPollMs, type LiveSource } from "@/lib/liveSource";
import type { DemoCopy } from "./copy";
import { withBase } from "./data";
import { claimPlayback, releasePlayback, useActivePlayback, useInView } from "./playback";

const CAMERA = "camera1";
const PLAYER_ID = "live";

/**
 * Live, honestly: the real camera when it is on, and a plain "off right now"
 * when it is not. There is no simulated stream and no viewer count.
 */
export function LiveBlock({ copy, poster, onlyWhenLive = false }: {
  copy: DemoCopy["sections"]["live"];
  poster: string | null;
  /** Render nothing until camera 1 is actually live (used under the broadcast demo). */
  onlyWhenLive?: boolean;
}) {
  const [source, setSource] = useState<LiveSource | null>(null);
  const [checked, setChecked] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>("200px", 0.1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useActivePlayback();

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      let next: LiveSource | null = null;
      try {
        const pan = await fetchLiveSource(CAMERA, "pan");
        next = pan.status.live ? pan : await fetchLiveSource(CAMERA, "hls");
      } catch {
        next = null;
      }
      if (cancelled) return;
      setSource(next);
      setChecked(true);
      timer = window.setTimeout(poll, nextPollMs(next?.status ?? null));
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [inView]);

  const live = Boolean(source?.status.live);

  // Share the one-video-at-a-time rule with the rest of the page.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !live) return;
    const onPlay = () => claimPlayback(PLAYER_ID);
    const onPause = () => releasePlayback(PLAYER_ID);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      releasePlayback(PLAYER_ID);
    };
  }, [live]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && active !== null && active !== PLAYER_ID && !video.paused) video.pause();
  }, [active]);

  if (onlyWhenLive && !live) return <div ref={ref} className="dm-live-probe" aria-hidden="true" />;

  return (
    <div ref={ref} className={`dm-live ${onlyWhenLive ? "dm-live--real" : ""}`}>
      {onlyWhenLive && <p className="dm-kicker dm-kicker--live">{copy.realLive}</p>}
      <div className="dm-live-head">
        {live ? (
          <span className="dm-live-badge"><span className="dm-live-dot" aria-hidden="true" />{copy.liveBadge}</span>
        ) : (
          <span className="dm-off-badge">{checked ? copy.offTitle : copy.checking}</span>
        )}
        <span className="dm-small">{copy.camera}</span>
        {live && source?.variant === "pan" && <span className="dm-small dm-accent">{copy.following}</span>}
      </div>
      <div className="dm-live-stage">
        {live && inView && source ? (
          <HlsPlayer
            ref={videoRef}
            key={`${source.variant}:${source.url}`}
            url={source.url}
            label={copy.camera}
            retryOnNetworkError
            showDvrControls={false}
            liveEdgeToleranceSeconds={source.variant === "pan" ? 30 : undefined}
            videoClassName="dm-live-video"
          />
        ) : (
          <>
            {poster && <img className="dm-live-poster" src={withBase(poster)} alt="" loading="lazy" />}
            {checked && !live && (
              <div className="dm-live-off">
                <strong>{copy.offTitle}</strong>
                <span>{copy.offBody}</span>
              </div>
            )}
          </>
        )}
      </div>
      <p className="dm-small">{copy.delay}</p>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { Play } from "lucide-react";

import type { DemoCopy, Persona } from "./copy";
import { withBase, type DemoClip } from "./data";
import { FieldLogo, LogoBug } from "./FieldLogo";
import { claimPlayback, releasePlayback, useActivePlayback, useInView } from "./playback";

const END_CARD_MS = 3200;

/**
 * One phone: a vertical clip with the pitch's badge in the corner and an end
 * card after it, the way a player's story looks when he posts it.
 */
function StoryPhone({ clip, name, persona, copy, active, onActivate, onFocusIn }: {
  clip: DemoClip;
  name: string;
  persona: Persona;
  copy: DemoCopy["sections"]["social"];
  active: boolean;
  onActivate: () => void;
  onFocusIn: (node: HTMLElement) => void;
}) {
  const id = `story-${useId()}`;
  const videoRef = useRef<HTMLVideoElement>(null);
  const playing = useActivePlayback();
  const [ending, setEnding] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active && (playing === null || playing === id) && !ending) {
      claimPlayback(id);
      void video.play().catch(() => undefined);
    } else if (!video.paused) {
      video.pause();
    }
  }, [active, playing, id, ending]);

  useEffect(() => {
    if (!active) {
      setEnding(false);
      releasePlayback(id);
    }
  }, [active, id]);

  useEffect(() => () => releasePlayback(id), [id]);

  useEffect(() => {
    if (!ending) return;
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (video) video.currentTime = 0;
      setEnding(false);
    }, END_CARD_MS);
    return () => window.clearTimeout(timer);
  }, [ending]);

  return (
    <button
      type="button"
      className={`dm-phone ${active ? "is-on" : ""}`}
      onClick={(event) => {
        onActivate();
        onFocusIn(event.currentTarget);
      }}
      aria-pressed={active}
    >
      <span className="dm-phone-screen">
        <video
          ref={videoRef}
          className="dm-phone-video"
          src={withBase(clip.src)}
          poster={withBase(clip.poster)}
          muted
          playsInline
          preload="metadata"
          onTimeUpdate={(event) => {
            const v = event.currentTarget;
            if (v.duration > 0) setProgress(v.currentTime / v.duration);
          }}
          onEnded={() => {
            setProgress(1);
            setEnding(true);
          }}
        />
        <span className="dm-phone-bar" aria-hidden="true"><i style={{ width: `${Math.round((ending ? 1 : progress) * 100)}%` }} /></span>
        <span className="dm-phone-bug"><LogoBug name={name} compact /></span>
        {!active && (
          <span className="dm-phone-play" aria-hidden="true"><Play className="dm-icon" fill="currentColor" /></span>
        )}
        <span className={`dm-endcard ${ending ? "is-on" : ""}`} aria-hidden={!ending}>
          <FieldLogo name={name} size={64} />
          <strong>{name}</strong>
          <span>{copy.endBook[persona]}</span>
          <small>{copy.endFilmed}</small>
        </span>
      </span>
    </button>
  );
}

export function SocialSection({ clips, persona, copy, name, onName }: {
  clips: DemoClip[];
  persona: Persona;
  copy: DemoCopy["sections"]["social"];
  name: string;
  onName: (value: string) => void;
}) {
  const inputId = useId();
  const [active, setActive] = useState(0);
  const { ref, inView } = useInView<HTMLDivElement>("0px", 0.4);
  const shown = clips.slice(0, 3);

  return (
    <div className="dm-social">
      <div className="dm-social-text">
        <p className="dm-lead dm-lead--flush">{copy.body[persona]}</p>
        <ul className="dm-points">
          {copy.points[persona].map((point) => <li key={point}>{point}</li>)}
        </ul>
        <label className="dm-field" htmlFor={inputId}>
          <span>{copy.nameLabel[persona]}</span>
        </label>
        <input
          id={inputId}
          className="dm-text-input"
          value={name}
          maxLength={28}
          onChange={(event) => onName(event.target.value)}
          autoComplete="off"
        />
        <p className="dm-small">{copy.platforms}</p>
        <p className="dm-small">{copy.sample}</p>
      </div>
      <div ref={ref} className="dm-phones">
        {shown.map((clip, index) => (
          <StoryPhone
            key={clip.id}
            clip={clip}
            name={name.trim() || copy.defaultName[persona]}
            persona={persona}
            copy={copy}
            active={inView && active === index}
            onActivate={() => setActive(index)}
            onFocusIn={(node) => node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })}
          />
        ))}
      </div>
    </div>
  );
}

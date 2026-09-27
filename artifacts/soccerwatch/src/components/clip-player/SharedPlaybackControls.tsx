import {
  forwardRef,
  useCallback,
  useEffect,
  useState,
  type RefObject,
  type VideoHTMLAttributes,
} from "react";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import { cn } from "@/lib/utils";

export type ClipPlayerLabels = {
  play: string;
  pause: string;
  enterFullscreen: string;
  exitFullscreen: string;
  timeline: string;
  mute: string;
  unmute: string;
};

export const SharedClipVideo = forwardRef<
  HTMLVideoElement,
  VideoHTMLAttributes<HTMLVideoElement>
>(function SharedClipVideo(props, ref) {
  return <video {...props} ref={ref} controls={false} playsInline />;
});

function isIOSDevice(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function useClipPlayerFullscreen(videoRef: RefObject<HTMLVideoElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { setFullscreenVideo } = useFullscreenVideo();

  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  const tryEnterFullscreen = useCallback((fullscreenTarget?: HTMLElement | null) => {
    const video = videoRef.current;
    if (!video) return;
    if (isIOSDevice()) {
      const enterNative = (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen;
      if (enterNative) {
        try { enterNative.call(video); } catch { /* iOS requires a user gesture. */ }
      }
      return;
    }
    if (!getFullscreenElement()) {
      const target = fullscreenTarget ?? document.documentElement;
      const legacyTarget = target as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (typeof target.requestFullscreen === "function") {
        void target.requestFullscreen().catch(() => {});
      } else if (typeof legacyTarget.webkitRequestFullscreen === "function") {
        try { legacyTarget.webkitRequestFullscreen(); } catch { /* Browser rejected the request. */ }
      }
    }
  }, [videoRef]);

  const tryExitFullscreen = useCallback(() => {
    if (isIOSDevice()) {
      const video = videoRef.current;
      const exitNative = video && (video as HTMLVideoElement & { webkitExitFullscreen?: () => void }).webkitExitFullscreen;
      if (exitNative) {
        try { exitNative.call(video); } catch { /* Native fullscreen may already be closing. */ }
      }
      return;
    }
    const legacyDocument = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (legacyDocument.webkitFullscreenElement && legacyDocument.webkitExitFullscreen) {
      try { legacyDocument.webkitExitFullscreen(); } catch { /* Browser already exited fullscreen. */ }
    }
  }, [videoRef]);

  const toggleFullscreen = useCallback((fullscreenTarget?: HTMLElement | null) => {
    if (isFullscreen || getFullscreenElement()) tryExitFullscreen();
    else tryEnterFullscreen(fullscreenTarget);
  }, [isFullscreen, tryEnterFullscreen, tryExitFullscreen]);

  useEffect(() => {
    const updateStandardFullscreen = () => setIsFullscreen(!!getFullscreenElement());
    const updateNativeFullscreen = (event: Event) => {
      setIsFullscreen(event.type === "webkitbeginfullscreen");
    };
    const video = videoRef.current;
    document.addEventListener("fullscreenchange", updateStandardFullscreen);
    document.addEventListener("webkitfullscreenchange", updateStandardFullscreen);
    video?.addEventListener("webkitbeginfullscreen", updateNativeFullscreen);
    video?.addEventListener("webkitendfullscreen", updateNativeFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", updateStandardFullscreen);
      document.removeEventListener("webkitfullscreenchange", updateStandardFullscreen);
      video?.removeEventListener("webkitbeginfullscreen", updateNativeFullscreen);
      video?.removeEventListener("webkitendfullscreen", updateNativeFullscreen);
    };
  }, [videoRef]);

  return { isFullscreen, tryEnterFullscreen, tryExitFullscreen, toggleFullscreen };
}

function getFullscreenElement(): Element | null {
  const legacyDocument = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? legacyDocument.webkitFullscreenElement ?? null;
}

export function SharedClipTimeline({
  progressSec,
  durationSec,
  onChange,
  onScrubStart,
  onScrubEnd,
  labels,
  className,
  direction = "ltr",
}: {
  progressSec: number;
  durationSec: number;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onScrubStart?: () => void;
  onScrubEnd?: (event: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => void;
  labels: Pick<ClipPlayerLabels, "timeline">;
  className?: string;
  direction?: "ltr" | "rtl" | "inherit";
}) {
  const progress = durationSec > 0
    ? Math.max(0, Math.min(100, (progressSec / durationSec) * 100))
    : 0;

  return (
    <div
      className={cn("flex items-center gap-2 w-full", className)}
      dir={direction === "inherit" ? undefined : direction}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="text-[11px] text-white/70 tabular-nums min-w-[30px] drop-shadow">
        {formatPlayerTime(progressSec)}
      </span>
      <div className="flex-1 relative h-6 flex items-center">
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 bg-white/25 rounded-full" />
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 bg-primary rounded-full pointer-events-none"
          style={{ width: `${progress}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow pointer-events-none"
          style={{ left: `${progress}%`, transform: "translate(-50%, -50%)" }}
        />
        <input
          type="range"
          min={0}
          max={durationSec || 1}
          step={0.05}
          value={Math.max(0, Math.min(durationSec || 0, progressSec))}
          onMouseDown={onScrubStart}
          onTouchStart={onScrubStart}
          onChange={onChange}
          onMouseUp={onScrubEnd}
          onTouchEnd={onScrubEnd}
          className="w-full h-full appearance-none cursor-pointer relative z-10 opacity-0"
          aria-label={labels.timeline}
          disabled={durationSec <= 0}
        />
      </div>
      <span className="text-[11px] text-white/70 tabular-nums min-w-[30px] text-right drop-shadow">
        {formatPlayerTime(durationSec)}
      </span>
    </div>
  );
}

export function SharedClipPlayerButtons({
  isPlaying,
  isFullscreen,
  onTogglePlayback,
  onToggleFullscreen,
  labels,
  playLabel,
  disabled = false,
  muted,
  onToggleMuted,
  className,
  direction = "ltr",
}: {
  isPlaying: boolean;
  isFullscreen: boolean;
  onTogglePlayback: () => void;
  onToggleFullscreen: () => void;
  labels: ClipPlayerLabels;
  playLabel?: string;
  disabled?: boolean;
  muted?: boolean;
  onToggleMuted?: () => void;
  className?: string;
  direction?: "ltr" | "rtl" | "inherit";
}) {
  return (
    <div
      className={cn("flex items-center gap-3 shrink-0", className)}
      dir={direction === "inherit" ? undefined : direction}
    >
      {onToggleMuted && (
        <button
          type="button"
          onClick={onToggleMuted}
          disabled={disabled}
          className="w-11 h-11 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 active:scale-95 transition-all shrink-0 disabled:opacity-50"
          aria-label={muted ? labels.unmute : labels.mute}
          title={muted ? labels.unmute : labels.mute}
        >
          {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      )}
      <button
        type="button"
        onClick={onToggleFullscreen}
        disabled={disabled}
        className="w-10 h-10 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 active:scale-95 transition-all shrink-0 disabled:opacity-50"
        aria-label={isFullscreen ? labels.exitFullscreen : labels.enterFullscreen}
        title={isFullscreen ? labels.exitFullscreen : labels.enterFullscreen}
      >
        {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
      </button>
      <button
        type="button"
        onClick={onTogglePlayback}
        disabled={disabled}
        className="w-12 h-12 rounded-full bg-white text-black flex items-center justify-center active:scale-95 transition-transform shrink-0 disabled:opacity-50"
        aria-label={isPlaying ? labels.pause : playLabel ?? labels.play}
        title={isPlaying ? labels.pause : playLabel ?? labels.play}
      >
        {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
      </button>
    </div>
  );
}

function formatPlayerTime(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
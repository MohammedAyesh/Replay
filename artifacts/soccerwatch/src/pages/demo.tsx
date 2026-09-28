import {
  ArrowRight,
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Eye,
  Film,
  Globe2,
  Heart,
  Link2,
  LockKeyhole,
  Pause,
  Play,
  QrCode,
  Radio,
  RotateCcw,
  ScanLine,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  Users,
  Video,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslation } from "@/i18n/context";
import { demoStrings } from "@/i18n/demo-strings";
import { HlsPlayer } from "@/components/HlsPlayer";
import { VarPlayer } from "@/components/var-player/VarPlayer";

export interface DemoClip {
  id: string | number;
  title?: string;
  label?: string;
  timestamp?: string;
  duration?: string;
  src?: string;
  rawSrc?: string;
  poster?: string;
  accent?: string;
  isSample?: boolean;
  startTime?: number;
  endTime?: number;
  playbackStartTime?: number;
  playbackEndTime?: number;
}

export interface SoccerWatchDemoProps {
  clips: DemoClip[];
  panorama?: DemoClip;
  onOpenClaim: (clip?: DemoClip) => void;
  isClipsLoading?: boolean;
}

const STOP_COUNT = 9;

function DemoLogo() {
  return (
    <div className="flex items-center gap-2" data-testid="text-demo-brand">
      <span className="grid size-8 place-items-center bg-[var(--replay-floodlight)] text-[var(--replay-void)] [clip-path:polygon(25%_5%,75%_5%,100%_50%,75%_95%,25%_95%,0_50%)]">
        <span className="font-display text-lg font-bold">R</span>
      </span>
      <span className="font-display text-[13px] font-bold tracking-[0.2em] text-text">REPLAY</span>
    </div>
  );
}

function SectionHeading({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <div className="max-w-[390px]">
      <p className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--replay-floodlight)]" data-testid="text-step-kicker">
        <span className="h-px w-7 bg-[var(--replay-floodlight)]" aria-hidden="true" />
        {kicker}
      </p>
      <h1 className="font-display text-[clamp(34px,10vw,56px)] font-bold leading-[0.92] tracking-[-0.055em] text-text" data-testid="text-step-title">
        {title}
      </h1>
      <p className="mt-5 max-w-[360px] text-sm leading-6 text-muted-text" data-testid="text-step-body">
        {body}
      </p>
    </div>
  );
}

function DemoButton({
  children,
  onClick,
  variant = "ghost",
  icon,
  testId,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "quiet";
  icon?: React.ReactNode;
  testId: string;
  disabled?: boolean;
}) {
  const className =
    variant === "primary"
      ? "border-[var(--replay-floodlight)] bg-[var(--replay-floodlight)] text-[var(--replay-void)] hover:bg-[#e4ff82]"
      : variant === "quiet"
        ? "border-transparent bg-transparent text-muted-text hover:bg-raised hover:text-text"
        : "border-line bg-raised text-text hover:border-[var(--replay-turf)] hover:bg-surface";
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

function DemoMediaStage({
  clip,
  label,
  playLabel,
  pauseLabel,
  sampleLabel,
  unavailableLabel,
  autoStart = false,
  panoramaMode = "full",
  panoramaAngle = 50,
}: {
  clip?: DemoClip;
  label: string;
  playLabel: string;
  pauseLabel: string;
  sampleLabel: string;
  unavailableLabel: string;
  autoStart?: boolean;
  panoramaMode?: "full" | "follow";
  panoramaAngle?: number;
}) {
  const [started, setStarted] = useState(Boolean(autoStart && (clip?.src || clip?.rawSrc)));
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const src = clip?.src ?? clip?.rawSrc;
  const isHls = Boolean(src && (src.includes(".m3u8") || clip?.rawSrc?.includes(".m3u8")));
  const framingStyle = {
    objectPosition: `${panoramaMode === "follow" ? panoramaAngle : 50}% center`,
    transform: panoramaMode === "follow" ? "scale(1.65)" : "scale(1)",
    transformOrigin: `${panoramaAngle}% center`,
  };
  const framingClass = panoramaMode === "follow" ? "object-cover" : "object-contain";

  useEffect(() => {
    const video = videoRef.current;
    if (!started || !video) return;
    video.muted = true;
    video.loop = true;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    void video.play().catch(() => {
      // Keep the large play prompt available if muted autoplay is blocked.
      setStarted(false);
      setPlaying(false);
    });
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [started, src]);

  useEffect(() => {
    const video = videoRef.current;
    const start = clip?.playbackStartTime;
    const end = clip?.playbackEndTime;
    if (!started || !video || start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    let didSeek = false;
    const seekToStart = () => {
      if (didSeek || !Number.isFinite(video.duration) || video.duration <= start) return;
      didSeek = true;
      video.currentTime = start;
    };
    const loopClip = () => {
      if (video.currentTime >= end) video.currentTime = start;
    };
    video.addEventListener("loadedmetadata", seekToStart);
    video.addEventListener("durationchange", seekToStart);
    video.addEventListener("timeupdate", loopClip);
    seekToStart();
    return () => {
      video.removeEventListener("loadedmetadata", seekToStart);
      video.removeEventListener("durationchange", seekToStart);
      video.removeEventListener("timeupdate", loopClip);
    };
  }, [started, src, clip?.playbackStartTime, clip?.playbackEndTime]);

  useEffect(() => {
    setStarted(Boolean(autoStart && (clip?.src || clip?.rawSrc)));
    setPlaying(false);
    setFailed(false);
  }, [autoStart, clip?.id, clip?.src, clip?.rawSrc]);

  return (
    <div className="relative aspect-video min-h-[220px] overflow-hidden rounded-2xl border border-line bg-[#10231f]" data-testid="stage-demo-media">
      {!src ? (
        <div className="absolute inset-0 grid place-items-center bg-[var(--replay-raised)] px-6 text-center" data-testid="state-demo-media-unavailable">
          <div>
            <Film className="mx-auto mb-3 size-7 text-[var(--replay-turf)]" aria-hidden="true" />
            <p className="max-w-[310px] text-xs leading-5 text-muted-text">{unavailableLabel}</p>
          </div>
        </div>
      ) : started ? (
        isHls ? (
          <HlsPlayer
            ref={videoRef}
            url={src}
            label={label}
            controls
            showDvrControls={false}
            showStatusOverlays={false}
            videoClassName={`h-full w-full ${framingClass}`}
            videoStyle={framingStyle}
            onPlaybackState={(state) => {
              if (state.error) setFailed(true);
            }}
          />
        ) : (
          <video
            ref={videoRef}
            src={src}
            poster={clip?.poster}
            autoPlay
            muted
            loop
            playsInline
            controls
            onError={() => setFailed(true)}
            style={framingStyle}
            className={`h-full w-full ${framingClass}`}
          />
        )
      ) : (
        <div className="absolute inset-0 bg-[linear-gradient(125deg,#183a31,#2e7555_50%,#13231f)]">
          {clip?.poster ? (
            <img src={clip.poster} alt="" className="h-full w-full object-cover opacity-65" />
          ) : <div className="absolute inset-0 grid place-items-center bg-[var(--replay-raised)]"><Film className="size-8 text-muted-text" aria-hidden="true" /></div>}
          <button
            type="button"
            aria-label={playLabel}
            data-testid="button-play-demo-video"
            onClick={() => {
              setStarted(true);
            }}
            className="absolute inset-0 grid place-items-center bg-black/20 text-white transition-colors hover:bg-black/35"
          >
            <span className="grid size-16 place-items-center rounded-full bg-[var(--replay-floodlight)] text-[var(--replay-void)] shadow-xl">
              <Play className="ms-1 size-6 fill-current" aria-hidden="true" />
            </span>
            <span className="absolute bottom-4 start-4 rounded-lg bg-black/55 px-3 py-2 text-xs font-semibold backdrop-blur-sm">{playLabel}</span>
          </button>
        </div>
      )}
      {started && src && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <button
            type="button"
            aria-label={playing ? pauseLabel : playLabel}
            data-testid="button-toggle-demo-playback"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              if (video.paused) {
                void video.play().catch(() => setFailed(true));
              } else {
                video.pause();
              }
            }}
            className="pointer-events-auto grid size-14 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:opacity-100 focus:opacity-100"
          >
            {playing ? <Pause className="size-5 fill-current" aria-hidden="true" /> : <Play className="ms-0.5 size-5 fill-current" aria-hidden="true" />}
          </button>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
        <span className="rounded-full bg-black/50 px-2.5 py-1.5 font-mono text-[9px] text-white/85">{label}</span>
        {clip?.isSample && <span className="rounded-full bg-[var(--replay-floodlight)] px-2.5 py-1.5 font-mono text-[9px] font-bold text-black">{sampleLabel}</span>}
      </div>
      {failed && <p role="status" className="absolute inset-x-3 bottom-3 rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white">{unavailableLabel}</p>}
    </div>
  );
}

function getYouTubeEmbedUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.match(/^https?:\/\//i) ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
      return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : null;
    }
    if (host !== "youtube.com" && host !== "m.youtube.com") return null;
    const watchId = parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
    const liveMatch = parsed.pathname.match(/^\/live\/([A-Za-z0-9_-]{11})\/?$/);
    const id = watchId ?? liveMatch?.[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : null;
  } catch {
    return null;
  }
}

export default function SoccerWatchDemo({ clips, panorama, onOpenClaim, isClipsLoading = false }: SoccerWatchDemoProps) {
  const { locale } = useTranslation();
  const { setLocale } = useLocale();
  const copy = demoStrings[locale === "ar" ? "ar" : "en"];
  const [activeStop, setActiveStop] = useState(0);
  const [activeClip, setActiveClip] = useState<DemoClip | undefined>(clips[0]);
  const [likedClips, setLikedClips] = useState<Record<string, boolean>>({});
  const [savedClips, setSavedClips] = useState<Record<string, boolean>>({});
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [panoramaMode, setPanoramaMode] = useState<"full" | "follow">("full");
  const [panoramaAngle, setPanoramaAngle] = useState(50);
  const [viewerCount, setViewerCount] = useState(47);
  const [liveSeconds, setLiveSeconds] = useState(0);
  const [isRecording, setIsRecording] = useState(true);
  const [varDecision, setVarDecision] = useState<"pending" | "goal" | "noGoal">("pending");
  const [varMarked, setVarMarked] = useState(false);
  const [youtubeInput, setYoutubeInput] = useState("");
  const [requestSent, setRequestSent] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [billingPaid, setBillingPaid] = useState(false);
  const [roiMatches, setRoiMatches] = useState(12);
  const [roiPrice, setRoiPrice] = useState(2);
  const [roomCopied, setRoomCopied] = useState(false);
  const touchStart = useRef<number | null>(null);
  const panoramaClip = panorama;
  const youtubeEmbedUrl = getYouTubeEmbedUrl(youtubeInput);

  useEffect(() => {
    setActiveClip(clips[0]);
  }, [clips]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setViewerCount((count) => (count >= 62 ? 47 : count + 1));
    }, 3200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => setLiveSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (panoramaMode !== "follow") return;
    const timer = window.setInterval(() => {
      setPanoramaAngle((angle) => (angle > 80 ? 20 : angle + 7));
    }, 900);
    return () => window.clearInterval(timer);
  }, [panoramaMode]);

  const goTo = (index: number) => setActiveStop(Math.max(0, Math.min(STOP_COUNT - 1, index)));
  const next = () => goTo(activeStop + 1);
  const previous = () => goTo(activeStop - 1);
  const reset = () => {
    setActiveStop(0);
    setShareOpen(false);
    setCopied(false);
    setPanoramaMode("full");
    setPanoramaAngle(50);
    setIsRecording(true);
    setLiveSeconds(0);
    setVarDecision("pending");
    setVarMarked(false);
    setYoutubeInput("");
    setRequestSent(false);
    setShowQr(false);
    setBillingPaid(false);
    setLikedClips({});
    setSavedClips({});
    setRoomCopied(false);
    setViewerCount(47);
    setRoiMatches(12);
    setRoiPrice(2);
    setActiveClip(clips[0]);
  };

  const copyText = async (value: string, kind: "clip" | "room" | "owner") => {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      // Clipboard is optional in a preview-only demo.
    }
    if (kind === "room") {
      setRoomCopied(true);
      window.setTimeout(() => setRoomCopied(false), 1800);
    } else if (kind === "owner") {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } else {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const toggleLocale = () => setLocale(locale === "ar" ? "en" : "ar");
  const totalLift = Math.round(roiMatches * 4 * roiPrice);
  const stepCopy = copy.steps[activeStop];
  const roiControls: Array<{ label: string; value: number; setter: (value: number) => void; min: number; max: number; step: number; suffix?: string }> = [
    { label: copy.roi.matches, value: roiMatches, setter: setRoiMatches, min: 1, max: 30, step: 1 },
    { label: copy.roi.price, value: roiPrice, setter: setRoiPrice, min: 1, max: 10, step: 0.5, suffix: copy.jod },
  ];
  const panoramaHlsSrc = panoramaClip?.rawSrc?.includes(".m3u8") || panoramaClip?.src?.includes(".m3u8")
    ? panoramaClip?.src ?? panoramaClip?.rawSrc
    : undefined;
  const liveTime = `${String(Math.floor(liveSeconds / 60)).padStart(2, "0")}:${String(liveSeconds % 60).padStart(2, "0")}`;

  return (
    <div
      lang={locale === "ar" ? "ar" : "en"}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="min-h-[100dvh] overflow-x-hidden bg-[var(--replay-void)] text-text"
      data-testid="page-soccerwatch-demo"
      onTouchStart={(event) => {
        touchStart.current = event.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (touchStart.current === null) return;
        const delta = (event.changedTouches[0]?.clientX ?? 0) - touchStart.current;
        if (Math.abs(delta) > 55) (delta < 0 ? next : previous)();
        touchStart.current = null;
      }}
    >
      <div className="pointer-events-none fixed inset-0 z-0 opacity-25" aria-hidden="true">
        <div className="absolute -start-24 -top-32 h-96 w-96 rounded-full bg-[var(--replay-turf)]/10 blur-3xl" />
        <div className="absolute -bottom-28 -end-24 h-96 w-96 rounded-full bg-[var(--replay-violet)]/10 blur-3xl" />
      </div>

      <header className="sticky top-0 z-30 border-b border-line bg-[var(--replay-void)]/90 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex w-full max-w-[920px] items-center justify-between gap-3">
          <DemoLogo />
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] uppercase tracking-[0.12em] text-muted-text sm:inline" data-testid="text-locale-label">
              {copy.localeLabel}
            </span>
            <button
              type="button"
              data-testid="button-toggle-locale"
              aria-label={copy.localeLabel}
              onClick={toggleLocale}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--replay-floodlight)]/45 bg-[var(--replay-floodlight)]/10 px-3.5 text-xs font-bold text-[var(--replay-floodlight)] transition-colors hover:bg-[var(--replay-floodlight)]/20"
            >
              <Globe2 className="size-4" aria-hidden="true" />
              <span>{locale === "ar" ? "AR" : "EN"}</span>
            </button>
            <button
              type="button"
              data-testid="button-reset-demo"
              aria-label={copy.reset}
              onClick={reset}
              className="grid size-11 place-items-center rounded-full border border-line bg-raised text-muted-text transition-colors hover:border-[var(--replay-turf)] hover:text-text"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-[920px] px-4 pb-36 pt-6 sm:px-6 sm:pt-9">
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-[var(--replay-floodlight)]/15 bg-[var(--replay-floodlight)]/5 px-3 py-2.5 text-[10px] text-[var(--replay-floodlight)]" data-testid="banner-sample-data">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{panoramaClip?.src || panoramaClip?.rawSrc || clips.some((clip) => clip.src || clip.rawSrc) ? copy.sampleBanner : copy.noMediaBanner}</span>
          </div>
          <span className="hidden shrink-0 font-mono tracking-[0.12em] sm:inline">{copy.brand}</span>
        </div>

        <div className="mb-6 flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-muted-text">
          <span className="h-px w-8 bg-[var(--replay-turf)]" aria-hidden="true" />
          <span data-testid="text-demo-eyebrow">{copy.eyebrow}</span>
          <span className="ms-auto font-mono text-text/60" data-testid="text-step-counter">
            {String(activeStop + 1).padStart(2, "0")} {copy.stepOf} {STOP_COUNT}
          </span>
        </div>

        <section className="min-h-[590px] overflow-hidden rounded-[26px] border border-line bg-[var(--replay-surface)] shadow-2xl shadow-black/20" aria-live="polite">
          {activeStop === 0 && (
            <div className="grid min-h-[590px] content-between gap-10 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div>
                <div className="mb-6 grid gap-2.5 sm:grid-cols-3">
                  {copy.steps[0].chips.map((chip, index) => (
                    <div key={chip.label} className="rounded-2xl border border-line bg-raised p-4" data-testid={`card-value-chip-${index}`}>
                      <div className="mb-8 flex items-center justify-between">
                        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-text">{chip.label}</span>
                        <span className="size-2 rounded-full bg-[var(--replay-floodlight)]" />
                      </div>
                      <p className="text-sm font-semibold text-text">{chip.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <DemoButton variant="primary" testId="button-next-welcome" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>
                    {stepCopy.cta}
                  </DemoButton>
                  <span className="text-[10px] text-muted-text">{copy.galaxy}</span>
                </div>
              </div>
            </div>
          )}

          {activeStop === 1 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="grid gap-3">
                <div className="relative">
                  <DemoMediaStage
                    clip={panoramaClip}
                    label={copy.panorama.cameraStatus}
                    playLabel={copy.playVideo}
                    pauseLabel={copy.pause}
                    sampleLabel={copy.sampleFootage}
                    unavailableLabel={copy.videoUnavailable}
                    autoStart
                    panoramaMode={panoramaMode}
                    panoramaAngle={panoramaAngle}
                  />
                  {(panoramaClip?.src || panoramaClip?.rawSrc) && <>
                    <span className="pointer-events-none absolute end-3 top-3 rounded-full border border-[var(--replay-floodlight)]/30 bg-black/55 px-3 py-1.5 font-mono text-[9px] text-[var(--replay-floodlight)] backdrop-blur-md">{copy.panorama.overview} · {copy.simulated}</span>
                    <span className="pointer-events-none absolute top-[43%] size-4 rounded-full bg-[var(--replay-floodlight)] shadow-[0_0_0_7px_rgba(212,255,79,.14)] transition-transform duration-500" style={{ insetInlineStart: `${panoramaMode === "follow" ? panoramaAngle : 50}%`, transform: "translate(-50%, -50%)" }} />
                  </>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="max-w-[300px] text-[10px] leading-4 text-muted-text">{copy.panorama.dragHint}</p>
                  <div className="flex rounded-xl border border-line bg-raised p-1">
                    <button type="button" data-testid="button-panorama-full" onClick={() => setPanoramaMode("full")} className={`min-h-9 rounded-lg px-3 text-[10px] font-semibold ${panoramaMode === "full" ? "bg-text text-background" : "text-muted-text"}`}>
                      {copy.panorama.full}
                    </button>
                    <button type="button" data-testid="button-panorama-follow" onClick={() => setPanoramaMode("follow")} className={`min-h-9 rounded-lg px-3 text-[10px] font-semibold ${panoramaMode === "follow" ? "bg-[var(--replay-floodlight)] text-black" : "text-muted-text"}`}>
                      {copy.panorama.follow}
                    </button>
                  </div>
                  <input
                    type="range"
                    min="20"
                    max="80"
                    step="1"
                    value={panoramaAngle}
                    aria-label={copy.panorama.dragHint}
                    onChange={(event) => setPanoramaAngle(Number(event.target.value))}
                    className="w-24 accent-[var(--replay-floodlight)]"
                    disabled={panoramaMode !== "follow"}
                  />
                </div>
              </div>
              <DemoButton variant="primary" testId="button-next-panorama" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 2 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="font-display text-2xl font-bold text-text" data-testid="text-clips-title">{copy.clips.title}</p>
                  <p className="mt-1 text-xs text-muted-text">{copy.clips.subtitle}</p>
                   <p className="mt-3 max-w-[420px] text-[10px] leading-4 text-muted-text">{copy.clips.detection}</p>
                </div>
                <Film className="size-6 text-[var(--replay-turf)]" aria-hidden="true" />
              </div>
              {isClipsLoading ? (
                <div className="grid gap-3" data-testid="state-clips-loading">
                  {[1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-2xl border border-line bg-raised" />)}
                  <p className="text-xs text-muted-text">{copy.clips.loadingTitle} · {copy.clips.loadingBody}</p>
                </div>
              ) : clips.length === 0 ? (
                <div className="grid min-h-48 place-items-center rounded-2xl border border-dashed border-line bg-raised/60 p-6 text-center" data-testid="state-clips-empty">
                  <div>
                    <Film className="mx-auto mb-3 size-7 text-muted-text" aria-hidden="true" />
                    <p className="text-sm font-semibold text-text">{copy.clips.emptyTitle}</p>
                    <p className="mt-2 max-w-[250px] text-xs leading-5 text-muted-text">{copy.clips.emptyBody}</p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                  {clips.slice(0, 4).map((clip, index) => {
                    const id = String(clip.id);
                    const active = activeClip?.id === clip.id;
                    const cameraLabel = clip.isSample
                      ? copy.sampleFootage
                      : `${copy.clips.camera} ${index + 1}`;
                    return (
                      <article key={id} className={`overflow-hidden rounded-2xl border bg-raised transition-colors ${active ? "border-[var(--replay-turf)]/65" : "border-line"}`} data-testid={`card-demo-clip-${id}`}>
                        <button type="button" data-testid={`button-select-clip-${id}`} onClick={() => setActiveClip(clip)} className="group relative block aspect-[16/8] w-full overflow-hidden bg-[#10231f] text-start">
            {clip.poster ? <img className="h-full w-full object-cover opacity-80" src={clip.poster} alt="" loading="lazy" /> : <div className="absolute inset-0 grid place-items-center bg-[var(--replay-raised)]"><Film className="size-7 text-muted-text" aria-hidden="true" /></div>}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                          <span className="absolute start-3 top-3 rounded-full bg-black/45 px-2 py-1 font-mono text-[9px] text-white/80">{cameraLabel}</span>
                          <span className="absolute bottom-3 start-3 text-xs font-semibold text-white">{clip.title ?? cameraLabel}</span>
                          <span className="absolute bottom-3 end-3 font-mono text-[10px] text-white/70">{clip.duration ?? "—"}</span>
                          <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100"><span className="grid size-11 place-items-center rounded-full bg-[var(--replay-floodlight)] text-black"><Play className="ms-0.5 size-4 fill-current" aria-hidden="true" /></span></span>
                        </button>
                        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                          <span className="font-mono text-[10px] text-muted-text">{clip.timestamp ?? copy.live.recorded}</span>
                          <div className="flex items-center gap-1">
                            <button type="button" data-testid={`button-like-clip-${id}`} aria-label={likedClips[id] ? copy.clips.liked : copy.clips.like} onClick={() => setLikedClips((state) => ({ ...state, [id]: !state[id] }))} className={`grid size-9 place-items-center rounded-lg ${likedClips[id] ? "text-[var(--replay-live)]" : "text-muted-text hover:text-text"}`}><Heart className={`size-4 ${likedClips[id] ? "fill-current" : ""}`} aria-hidden="true" /></button>
                            <button type="button" data-testid={`button-save-clip-${id}`} aria-label={savedClips[id] ? copy.clips.saved : copy.clips.save} onClick={() => setSavedClips((state) => ({ ...state, [id]: !state[id] }))} className={`grid size-9 place-items-center rounded-lg ${savedClips[id] ? "text-[var(--replay-floodlight)]" : "text-muted-text hover:text-text"}`}><Star className={`size-4 ${savedClips[id] ? "fill-current" : ""}`} aria-hidden="true" /></button>
                            <button type="button" data-testid={`button-share-clip-${id}`} aria-label={copy.clips.share} onClick={() => { setActiveClip(clip); setShareOpen(true); }} className="grid size-9 place-items-center rounded-lg text-muted-text hover:text-text"><Share2 className="size-4" aria-hidden="true" /></button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {activeClip && (
                  <div className="grid gap-3">
                    <p className="text-xs font-semibold text-text">{activeClip.isSample ? copy.sampleFootage : copy.clips.camera}</p>
                    <DemoMediaStage
                      key={String(activeClip.id)}
                      clip={activeClip}
                      label={activeClip.isSample ? copy.sampleFootage : copy.clips.camera}
                      playLabel={copy.playVideo}
                      pauseLabel={copy.pause}
                      sampleLabel={copy.sampleFootage}
                      unavailableLabel={copy.videoUnavailable}
                      autoStart
                    />
                  </div>
                )}
                </div>
              )}
               <div className="flex items-center gap-3 rounded-xl border border-[var(--replay-violet)]/25 bg-[var(--replay-violet)]/5 p-3" data-testid="preview-social-export">
                 <div className="rounded-lg bg-[var(--replay-violet)] px-2 py-2 font-mono text-[8px] font-bold tracking-[-0.04em] text-white">ArabiGaming</div>
                 <p className="text-[10px] leading-4 text-muted-text">{copy.clips.socialExport}</p>
               </div>
              <DemoButton variant="primary" testId="button-next-clips" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

           {activeStop === 3 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="relative overflow-hidden rounded-2xl border border-line bg-[#0b211d] p-4 sm:p-6">
                <div className="mb-5 flex items-center justify-between gap-3">
                   <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--replay-live)] px-2.5 py-1 font-mono text-[9px] font-bold text-white"><span className="size-1.5 rounded-full bg-white" /> {copy.live.badge}</span><span className="font-mono text-[10px] text-white/55">{copy.galaxy} · {copy.panorama.cameraStatus}</span></div>
                   <div className="flex items-center gap-3 font-mono text-[10px] text-white/65"><span data-testid="text-live-timer">{liveTime}</span><span className="flex items-center gap-1.5"><Eye className="size-3.5" aria-hidden="true" /><span data-testid="text-live-viewers">{viewerCount}</span> {copy.live.viewers}</span></div>
                </div>
                <DemoMediaStage
                   clip={panoramaClip}
                  label={copy.live.recorded}
                  playLabel={copy.playVideo}
                  pauseLabel={copy.pause}
                  sampleLabel={copy.sampleFootage}
                  unavailableLabel={copy.videoUnavailable}
                  autoStart
                   panoramaMode={panoramaMode}
                   panoramaAngle={panoramaAngle}
                 />
                 <div className="mt-4 rounded-xl border border-white/10 bg-black/15 p-3">
                   <label htmlFor="demo-youtube-url" className="mb-2 block text-[10px] font-semibold text-white/75">{copy.live.youtubeLabel}</label>
                   <input id="demo-youtube-url" data-testid="input-youtube-url" value={youtubeInput} onChange={(event) => setYoutubeInput(event.target.value)} placeholder={copy.live.youtubePlaceholder} className="min-h-10 w-full rounded-lg border border-white/10 bg-black/25 px-3 text-xs text-white outline-none placeholder:text-white/35 focus:border-[var(--replay-floodlight)]" inputMode="url" />
                   {youtubeInput && !youtubeEmbedUrl && <p role="status" data-testid="status-youtube-invalid" className="mt-2 text-[10px] text-[var(--replay-live)]">{copy.live.youtubeInvalid}</p>}
                   {youtubeEmbedUrl ? (
                     <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black">
                       <iframe title={copy.live.youtubePreview} data-testid="iframe-youtube-preview" src={youtubeEmbedUrl} className="aspect-video w-full" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />
                     </div>
                   ) : (
                     <p className="mt-2 text-[10px] leading-4 text-white/45">{copy.live.youtubeSetup}</p>
                   )}
                 </div>
                 <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                   <div className="rounded-xl border border-white/10 bg-black/15 p-3"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-xs font-semibold text-white"><Radio className="size-4 text-[var(--replay-floodlight)]" /> {copy.live.recorded}</span><span className="font-mono text-[9px] text-[var(--replay-floodlight)]">{copy.simulated}</span></div><p className="mt-2 text-[10px] text-white/50">{panoramaClip?.src || panoramaClip?.rawSrc ? copy.live.demoNote : copy.live.noSourceNote}</p></div>
                  <div className="rounded-xl border border-white/10 bg-black/15 p-3 sm:min-w-44"><p className="mb-2 font-mono text-[9px] uppercase tracking-[0.12em] text-white/45">{copy.live.ownerControl}</p><button type="button" data-testid="button-toggle-recording" onClick={() => setIsRecording((value) => !value)} className={`flex min-h-10 w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold ${isRecording ? "bg-[var(--replay-live)] text-white" : "bg-[var(--replay-floodlight)] text-black"}`}>{isRecording ? <><Pause className="size-3.5" /> {copy.live.stop}</> : <><Play className="size-3.5 fill-current" /> {copy.live.start}</>}</button><p className="mt-2 text-center font-mono text-[9px] text-white/55">{isRecording ? copy.live.recording : copy.live.stopped}</p></div>
                </div>
              </div>
              <DemoButton variant="primary" testId="button-next-live" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 4 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="relative overflow-hidden rounded-2xl border border-line bg-[#0d1718]">
                 {panoramaHlsSrc ? (
                  <VarPlayer
                     src={panoramaHlsSrc}
                    title={`${copy.var.title} · ${copy.galaxy}`}
                  />
                  ) : panoramaClip?.src || panoramaClip?.rawSrc ? (
                  <div className="p-3">
                    <DemoMediaStage
                       clip={panoramaClip}
                      label={copy.var.title}
                      playLabel={copy.playVideo}
                      pauseLabel={copy.pause}
                      sampleLabel={copy.sampleFootage}
                      unavailableLabel={copy.videoUnavailable}
                      autoStart
                       panoramaMode={panoramaMode}
                       panoramaAngle={panoramaAngle}
                    />
                  </div>
                 ) : (
                   <div className="grid min-h-56 place-items-center p-6 text-center" data-testid="state-var-unavailable">
                     <div>
                       <ScanLine className="mx-auto mb-3 size-7 text-muted-text" aria-hidden="true" />
                       <p className="text-sm font-semibold text-text">{copy.var.noFootage}</p>
                       <p className="mt-2 max-w-[300px] text-xs leading-5 text-muted-text">{copy.var.noFootageBody}</p>
                     </div>
                   </div>
                )}
                <div className="pointer-events-none absolute end-3 top-3 flex flex-wrap justify-end gap-2">
                   <span className="rounded-full bg-black/65 px-2.5 py-1.5 font-mono text-[9px] text-white/85">{copy.var.decision}: {varDecision === "goal" ? copy.var.goal : varDecision === "noGoal" ? copy.var.noGoal : copy.var.pending}</span>
                  {varMarked && <span className="animate-pulse rounded-full bg-[var(--replay-turf)] px-2.5 py-1.5 font-mono text-[9px] font-bold text-black">{copy.var.marked}</span>}
                </div>
              </div>
               <div className="grid gap-3">
                 <div className="flex flex-wrap gap-2">
                    <DemoButton testId="button-var-goal" onClick={() => { setVarDecision("goal"); setVarMarked(false); }} disabled={!panoramaClip?.src && !panoramaClip?.rawSrc} variant={varDecision === "goal" ? "primary" : "ghost"}>{copy.var.goal}</DemoButton>
                    <DemoButton testId="button-var-no-goal" onClick={() => { setVarDecision("noGoal"); setVarMarked(false); }} disabled={!panoramaClip?.src && !panoramaClip?.rawSrc} variant={varDecision === "noGoal" ? "primary" : "ghost"}>{copy.var.noGoal}</DemoButton>
                   <DemoButton testId="button-mark-var" onClick={() => setVarMarked(true)} disabled={varDecision === "pending"} icon={varMarked ? <Check className="size-4" /> : <ScanLine className="size-4" />}>{varMarked ? copy.var.complete : copy.var.mark}</DemoButton>
                 </div>
                 <p className="max-w-[390px] text-[10px] leading-4 text-muted-text"><LockKeyhole className="me-1 inline size-3 text-[var(--replay-turf)]" />{copy.var.privateBody}</p>
               </div>
              <DemoButton variant="primary" testId="button-next-var" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 5 && (
            <div className="grid min-h-[590px] content-between gap-8 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="grid gap-3 sm:grid-cols-3">
                {copy.claim.steps.map((label, index) => <div key={label} className="flex items-center gap-3 rounded-2xl border border-line bg-raised p-4" data-testid={`card-claim-step-${index}`}><span className={`grid size-8 shrink-0 place-items-center rounded-full font-mono text-xs ${index === 0 ? "bg-[var(--replay-floodlight)] text-black" : "bg-surface text-muted-text"}`}>{index + 1}</span><span className="text-xs font-semibold">{label}</span></div>)}
              </div>
              <div className="rounded-2xl border border-[var(--replay-floodlight)]/15 bg-[var(--replay-floodlight)]/5 p-5"><div className="mb-4 flex items-center gap-2 text-[var(--replay-floodlight)]"><Target className="size-5" /><span className="text-xs font-bold">{copy.claim.ready}</span></div><p className="max-w-[380px] text-sm leading-6 text-text/75">{copy.claim.body}</p><p className="mt-4 text-[10px] text-muted-text">{copy.claim.note}</p></div>
              <div className="flex flex-wrap gap-3"><DemoButton variant="primary" testId="button-open-claim" onClick={() => onOpenClaim(activeClip)} icon={<Target className="size-4" />}>{copy.claim.action}</DemoButton><DemoButton testId="button-next-claim" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton></div>
            </div>
          )}

          {activeStop === 6 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="rounded-2xl border border-line bg-raised p-5">
                <p className="mb-4 text-[10px] text-muted-text">{copy.player.sampleLabel}</p>
                <div className="flex items-center gap-3 border-b border-line pb-4"><div className="grid size-11 place-items-center rounded-full bg-[var(--replay-violet)] text-sm font-bold text-white">09</div><div><p className="text-sm font-bold">{copy.player.demoPlayer}</p><p className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--replay-turf)]"><ShieldCheck className="size-3" /> {copy.player.verified}</p></div><span className="ms-auto rounded-full border border-line px-2 py-1 font-mono text-[9px] text-muted-text">#09</span></div>
                  <div className="grid grid-cols-3 gap-2 pt-5">{[[copy.player.distance, "6.8 km"], [copy.player.calories, "642 kcal"], [copy.player.passes, "31"]].map(([label, value]) => <div key={label} className="rounded-xl bg-surface p-3"><p className="text-[10px] text-muted-text">{label}</p><p className="mt-2 font-display text-2xl font-bold text-text" data-testid={`text-player-stat-${label}`}>{value}</p></div>)}</div>
                 <div className="mt-4 grid gap-2 sm:grid-cols-2">
                   <div className="rounded-xl border border-line bg-surface p-3">
                     <p className="mb-3 text-[10px] font-semibold text-muted-text">{copy.player.teamStats}</p>
                     <div className="grid grid-cols-3 gap-2 border-b border-line pb-2 font-mono text-[9px] text-muted-text"><span /> <span className="text-end">{copy.player.homeTeam}</span><span className="text-end">{copy.player.awayTeam}</span></div>
                     <div className="mt-2 grid gap-2 text-[10px]">
                        {[[copy.player.distance, "26.8 km", "24.1 km"], [copy.player.calories, "2,642", "2,588"], [copy.player.passes, "71", "67"], [copy.player.possession, "54%", "46%"]].map(([label, home, away]) => <div key={label} className="grid grid-cols-3 gap-2"><span className="text-muted-text">{label}</span><span className="text-end font-mono text-text">{home}</span><span className="text-end font-mono text-text">{away}</span></div>)}
                     </div>
                   </div>
                   <div className="rounded-xl border border-line bg-surface p-3">
                     <p className="mb-3 text-[10px] font-semibold text-muted-text">{copy.player.rosterTitle}</p>
                     <div className="grid grid-cols-2 gap-x-3 gap-y-2">{copy.player.roster.map((name, index) => <span key={name} className="font-mono text-[10px] text-text"><span className="me-1 text-muted-text">{String(index + 4).padStart(2, "0")}</span>{name}</span>)}</div>
                   </div>
                 </div>
                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--replay-turf)]/20 bg-[var(--replay-turf)]/5 p-3"><div className="flex items-center gap-2"><Users className="size-4 text-[var(--replay-turf)]" /><span className="text-xs font-semibold">{copy.player.room}</span></div><span className="font-mono text-[10px] text-muted-text">8 {copy.player.players}</span></div>
              </div>
              <div className="flex flex-wrap gap-3"><DemoButton testId="button-share-room" onClick={() => copyText("replay.jo/room/friday-7", "room")} icon={roomCopied ? <Check className="size-4" /> : <Share2 className="size-4" />}>{roomCopied ? copy.player.copied : copy.player.share}</DemoButton><DemoButton testId="button-invite-friends" onClick={() => copyText("replay.jo/room/friday-7/invite", "room")} icon={<Send className="size-4" />}>{copy.player.friend}</DemoButton><DemoButton variant="primary" testId="button-next-player" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton></div>
            </div>
          )}

          {activeStop === 7 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-line bg-raised p-4 sm:col-span-2"><div className="mb-3 flex items-center justify-between gap-2"><p className="text-xs font-bold">{copy.owner.bookings}</p><span className="rounded-full bg-[var(--replay-turf)]/10 px-2 py-1 text-[9px] font-semibold text-[var(--replay-turf)]">{copy.owner.bookingStatus}</span></div><div className="flex items-center justify-between gap-3 text-xs"><span>{copy.owner.bookingTime}</span><span className="font-mono text-muted-text">{copy.owner.pitch}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full w-[72%] rounded-full bg-[var(--replay-floodlight)]" /></div></div>
                  <div className="rounded-2xl border border-line bg-raised p-4"><div className="mb-5 flex items-center justify-between"><Video className="size-5 text-[var(--replay-floodlight)]" /><span className="font-mono text-xs text-muted-text">{copy.jod}</span></div><label htmlFor="demo-owner-match-price" className="text-[10px] text-muted-text">{copy.owner.recording}</label><p className="mt-1 font-display text-3xl font-bold">{roiPrice} <span className="font-mono text-xs font-normal text-muted-text">{copy.jod}</span></p><input id="demo-owner-match-price" data-testid="input-owner-match-price" type="range" min="1" max="10" step="0.5" value={roiPrice} onChange={(event) => setRoiPrice(Number(event.target.value))} className="mt-3 w-full accent-[var(--replay-floodlight)]" /><p className="mt-2 text-[9px] text-muted-text">{copy.owner.priceHint}</p></div>
                 <div className="rounded-2xl border border-line bg-raised p-4"><div className="mb-5 flex items-center justify-between"><ScanLine className="size-5 text-[var(--replay-violet)]" /><span className="font-mono text-xs text-muted-text">{copy.simulated}</span></div><p className="text-[10px] text-muted-text">{copy.owner.varPrice}</p><p className="mt-3 text-xs leading-5 text-text">{copy.owner.varDemo}</p></div>
                <div className="rounded-2xl border border-line bg-raised p-4 sm:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold">{copy.owner.share}</p><p className="mt-1 font-mono text-[10px] text-muted-text">{copy.owner.sampleLink}</p><p className="mt-2 flex items-center gap-1 text-[9px] text-[var(--replay-floodlight)]"><Clock3 className="size-3" /> {copy.owner.expires} 6 {copy.owner.days}</p></div><div className="flex items-center gap-2"><button type="button" data-testid="button-copy-owner-link" aria-label={copy.owner.copy} onClick={() => copyText(copy.owner.sampleLink, "owner")} className="grid size-10 place-items-center rounded-lg border border-line bg-surface text-muted-text hover:text-text">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button><button type="button" data-testid="button-toggle-owner-qr" aria-label={showQr ? copy.owner.qrHidden : copy.owner.qr} onClick={() => setShowQr((value) => !value)} className="grid size-10 place-items-center rounded-lg border border-line bg-surface text-muted-text hover:text-text"><QrCode className="size-4" /></button></div></div>{showQr && <div className="mt-4 flex items-center gap-3 rounded-xl bg-text p-3 text-[var(--replay-void)]"><div className="grid size-20 grid-cols-5 gap-1 bg-text p-1">{Array.from({ length: 25 }).map((_, index) => <span key={index} className={(index * 7 + index) % 3 === 0 ? "bg-[var(--replay-void)]" : "bg-transparent"} />)}</div><span className="text-[10px] font-semibold">{copy.owner.qr} · {copy.owner.expires} 6 {copy.owner.days}</span></div>}</div>
                 <div className="rounded-2xl border border-line bg-raised p-4 sm:col-span-2"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-bold">{copy.owner.billing}</p><p className="mt-1 text-[10px] text-muted-text">{copy.owner.bookingLabel} · {roiPrice} {copy.jod}</p></div><button type="button" data-testid="button-toggle-billing" onClick={() => setBillingPaid((value) => !value)} className={`min-h-9 rounded-lg px-3 text-[10px] font-bold ${billingPaid ? "bg-[var(--replay-turf)] text-black" : "bg-surface text-muted-text"}`}>{billingPaid ? copy.owner.billed : copy.owner.pending}</button></div><div className="flex gap-2"><DemoButton testId="button-request-footage" onClick={() => setRequestSent(true)} icon={requestSent ? <Check className="size-4" /> : <Send className="size-4" />}>{requestSent ? copy.owner.requested : copy.owner.request}</DemoButton><p className="self-center text-[10px] text-muted-text">{copy.owner.requestBody}</p></div></div>
              </div>
              <DemoButton variant="primary" testId="button-next-owner" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 8 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="rounded-2xl border border-line bg-raised p-5">
                <div className="mb-6 flex items-start justify-between gap-3"><div><p className="text-sm font-bold">{copy.roi.title}</p><p className="mt-1 text-[10px] text-muted-text">{copy.roi.basis}</p></div><TrendingUp className="size-5 text-[var(--replay-floodlight)]" /></div>
                {roiControls.map(({ label, value, setter, min, max, step, suffix }, index) => <label key={label} className="mb-5 block last:mb-0"><div className="mb-2 flex items-center justify-between text-[11px]"><span className="text-muted-text">{label}</span><span className="font-mono font-bold text-text">{value}{suffix ? ` ${suffix}` : ""}</span></div><input data-testid={`input-roi-${index}`} type="range" min={min} max={max} step={step} value={value} onChange={(event) => setter(Number(event.target.value))} className="h-1.5 w-full accent-[var(--replay-floodlight)]" /></label>)}
                <p className="mt-5 text-[10px] text-muted-text">{copy.roi.attendanceAssumption}</p>
                <div className="mt-7 flex items-end justify-between gap-3 border-t border-line pt-5"><div><p className="text-[10px] text-muted-text">{copy.roi.monthly}</p><p className="mt-1 font-display text-4xl font-bold text-[var(--replay-floodlight)]" data-testid="text-roi-total">{totalLift.toLocaleString(locale === "ar" ? "ar-JO" : "en-US")} <span className="font-mono text-xs font-normal text-muted-text">{copy.roi.currency}</span></p></div><Banknote className="size-7 text-[var(--replay-turf)]" /></div>
              </div>
               <DemoButton variant="primary" testId="button-replay-tour" onClick={reset} icon={<RotateCcw className="size-4" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

        </section>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(12px,env(safe-area-inset-bottom))]" aria-label={copy.stepNavigation}>
        <div className="mx-auto flex max-w-[920px] items-center gap-2 rounded-2xl border border-line bg-[var(--replay-surface)]/95 p-2 shadow-2xl shadow-black/35 backdrop-blur-xl">
          <button type="button" data-testid="button-demo-back" aria-label={copy.back} onClick={previous} disabled={activeStop === 0} className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-raised text-muted-text hover:text-text disabled:opacity-30"><ChevronLeft className="size-4 rtl:rotate-180" /></button>
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1" role="tablist">
            {Array.from({ length: STOP_COUNT }).map((_, index) => <button key={index} type="button" role="tab" aria-selected={activeStop === index} data-testid={`button-demo-step-${index + 1}`} aria-label={`${index + 1}`} onClick={() => goTo(index)} className={`h-2.5 shrink-0 rounded-full transition-all ${activeStop === index ? "w-8 bg-[var(--replay-floodlight)]" : index < activeStop ? "w-2.5 bg-[var(--replay-turf)]" : "w-2.5 bg-line hover:bg-muted-text"}`} />)}
          </div>
          <button type="button" data-testid="button-demo-next" aria-label={copy.next} onClick={next} disabled={activeStop === STOP_COUNT - 1} className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--replay-floodlight)] text-[var(--replay-void)] hover:bg-[#e4ff82] disabled:opacity-30"><ChevronRight className="size-4 rtl:rotate-180" /></button>
        </div>
      </nav>

      {shareOpen && activeClip && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-black/65 p-3 backdrop-blur-sm sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="share-title" data-testid="dialog-share-clip">
          <div className="w-full max-w-[420px] rounded-3xl border border-line bg-[var(--replay-surface)] p-5 shadow-2xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-3"><div><p id="share-title" className="font-display text-2xl font-bold">{copy.clips.shareTitle}</p><p className="mt-1 text-xs text-muted-text">{copy.clips.shareBody}</p></div><button type="button" data-testid="button-close-share" aria-label={copy.clips.close} onClick={() => setShareOpen(false)} className="grid size-10 place-items-center rounded-xl border border-line text-muted-text hover:text-text"><X className="size-4" /></button></div>
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-raised p-3"><div className="grid size-12 place-items-center rounded-lg bg-[#205640] text-[var(--replay-floodlight)]"><Play className="size-4 fill-current" /></div><div><p className="text-xs font-semibold">{activeClip.title ?? copy.clips.recorded}</p><p className="mt-1 font-mono text-[10px] text-muted-text">{activeClip.timestamp ?? copy.galaxy} · {activeClip.duration ?? "—"}</p></div></div>
            <div className="grid gap-2"><DemoButton variant="primary" testId="button-copy-demo-link" onClick={() => copyText(`replay.jo/clip/${activeClip.id}`, "clip")} icon={copied ? <Check className="size-4" /> : <Link2 className="size-4" />}>{copied ? copy.owner.copied : copy.clips.copyLink}</DemoButton><DemoButton testId="button-share-claim" onClick={() => { setShareOpen(false); onOpenClaim(activeClip); }} icon={<Target className="size-4" />}>{copy.clips.claim}</DemoButton></div>
          </div>
        </div>
      )}
    </div>
  );
}
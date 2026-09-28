import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Eye,
  Film,
  Gauge,
  Globe2,
  Heart,
  Link2,
  LockKeyhole,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  QrCode,
  Radio,
  RotateCcw,
  ScanLine,
  Send,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Target,
  Timer,
  TrendingUp,
  Users,
  Video,
  Wifi,
  X,
  Zap,
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
}

export interface SoccerWatchDemoProps {
  clips: DemoClip[];
  onOpenClaim: (clip?: DemoClip) => void;
  isClipsLoading?: boolean;
}

const STOP_COUNT = 11;

const pitchLines = (
  <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden="true">
    <div className="absolute inset-[7%] rounded-[8%] border border-white/40" />
    <div className="absolute inset-y-[7%] start-1/2 w-px -translate-x-1/2 bg-white/35" />
    <div className="absolute start-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/45" />
    <div className="absolute start-[7%] top-1/2 h-20 w-[13%] -translate-y-1/2 rounded-e-[50%] border border-sky-100/40 border-s" />
    <div className="absolute end-[7%] top-1/2 h-20 w-[13%] -translate-y-1/2 rounded-s-[50%] border border-sky-100/40 border-e" />
    <div className="absolute start-[14%] top-[47%] h-2 w-2 rounded-full bg-white/70" />
  </div>
);

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
}: {
  clip?: DemoClip;
  label: string;
  playLabel: string;
  pauseLabel: string;
  sampleLabel: string;
  unavailableLabel: string;
  autoStart?: boolean;
}) {
  const [started, setStarted] = useState(Boolean(autoStart && clip?.src));
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const src = clip?.src;
  const isHls = Boolean(src && (src.includes(".m3u8") || clip?.rawSrc?.includes(".m3u8")));

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
    setStarted(Boolean(autoStart && clip?.src));
    setPlaying(false);
    setFailed(false);
  }, [autoStart, clip?.id, clip?.src]);

  return (
    <div className="relative aspect-video min-h-[220px] overflow-hidden rounded-2xl border border-line bg-[#10231f]" data-testid="stage-demo-media">
      {started && src ? (
        isHls ? (
          <HlsPlayer
            ref={videoRef}
            url={src}
            label={label}
            controls
            showDvrControls={false}
            showStatusOverlays={false}
            videoClassName="h-full w-full object-contain"
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
            className="h-full w-full object-contain"
          />
        )
      ) : (
        <div className="absolute inset-0 bg-[linear-gradient(125deg,#183a31,#2e7555_50%,#13231f)]">
          {clip?.poster ? (
            <img src={clip.poster} alt="" className="h-full w-full object-cover opacity-65" />
          ) : (
            pitchLines
          )}
          <button
            type="button"
            aria-label={playLabel}
            data-testid="button-play-demo-video"
            onClick={() => {
              if (!src) {
                setFailed(true);
                return;
              }
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

export default function SoccerWatchDemo({ clips, onOpenClaim, isClipsLoading = false }: SoccerWatchDemoProps) {
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
  const [isRecording, setIsRecording] = useState(true);
  const [varMarked, setVarMarked] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [billingPaid, setBillingPaid] = useState(false);
  const [roiMatches, setRoiMatches] = useState(12);
  const [roiBuyerPercent, setRoiBuyerPercent] = useState(35);
  const [roiPrice, setRoiPrice] = useState(2.5);
  const [clearedQueue, setClearedQueue] = useState<number[]>([]);
  const [roomCopied, setRoomCopied] = useState(false);
  const [pilotStarted, setPilotStarted] = useState(false);
  const touchStart = useRef<number | null>(null);

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
    setVarMarked(false);
    setRequestSent(false);
    setShowQr(false);
    setBillingPaid(false);
    setClearedQueue([]);
    setLikedClips({});
    setSavedClips({});
    setRoomCopied(false);
    setPilotStarted(false);
    setViewerCount(47);
    setRoiMatches(12);
    setRoiBuyerPercent(35);
    setRoiPrice(2.5);
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
  const averagePlayersPerMatch = 18;
  const totalLift = Math.round(roiMatches * 4 * averagePlayersPerMatch * (roiBuyerPercent / 100) * roiPrice);
  const stepCopy = copy.steps[activeStop];
  const roiControls: Array<{ label: string; value: number; setter: (value: number) => void; min: number; max: number; step: number; suffix?: string }> = [
    { label: copy.roi.matches, value: roiMatches, setter: setRoiMatches, min: 1, max: 30, step: 1 },
    { label: copy.roi.buying, value: roiBuyerPercent, setter: setRoiBuyerPercent, min: 5, max: 80, step: 5, suffix: "%" },
    { label: copy.roi.price, value: roiPrice, setter: setRoiPrice, min: 0.5, max: 5, step: 0.5, suffix: copy.jod },
  ];

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
              <span className="text-[10px] text-text/50">↔</span>
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
            <span>{copy.sampleBanner}</span>
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
                    clip={clips[0]}
                    label={copy.panorama.cameraStatus}
                    playLabel={copy.playVideo}
                    pauseLabel={copy.pause}
                    sampleLabel={copy.sampleFootage}
                    unavailableLabel={copy.videoUnavailable}
                    autoStart
                  />
                  <span className="pointer-events-none absolute end-3 top-3 rounded-full border border-[var(--replay-floodlight)]/30 bg-black/55 px-3 py-1.5 font-mono text-[9px] text-[var(--replay-floodlight)] backdrop-blur-md">{copy.panorama.overview} · {copy.simulated}</span>
                  <span
                    className="pointer-events-none absolute top-[43%] size-4 rounded-full bg-[var(--replay-floodlight)] shadow-[0_0_0_7px_rgba(212,255,79,.14)] transition-transform duration-500"
                    style={{ insetInlineStart: `${panoramaMode === "follow" ? panoramaAngle : 50}%`, transform: "translate(-50%, -50%)" }}
                  />
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
                          {clip.poster ? <img className="h-full w-full object-cover opacity-80" src={clip.poster} alt="" loading="lazy" /> : <div className="h-full w-full bg-[linear-gradient(125deg,#183a31,#2e7555_50%,#13231f)]">{pitchLines}<span className="absolute start-[38%] top-[35%] size-3 rounded-full bg-[var(--replay-floodlight)]" /></div>}
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
              <DemoButton variant="primary" testId="button-next-clips" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 3 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="relative overflow-hidden rounded-2xl border border-line bg-[#0b211d] p-4 sm:p-6">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--replay-floodlight)] px-2.5 py-1 font-mono text-[9px] font-bold text-black"><span className="size-1.5 rounded-full bg-black/65" /> {copy.live.badge}</span><span className="font-mono text-[10px] text-white/55">{copy.galaxy} · {copy.panorama.cameraStatus}</span></div>
                  <div className="flex items-center gap-1.5 font-mono text-[10px] text-white/65"><Eye className="size-3.5" aria-hidden="true" /><span data-testid="text-live-viewers">{viewerCount}</span> {copy.live.viewers}</div>
                </div>
                <DemoMediaStage
                  clip={clips[0]}
                  label={copy.live.recorded}
                  playLabel={copy.playVideo}
                  pauseLabel={copy.pause}
                  sampleLabel={copy.sampleFootage}
                  unavailableLabel={copy.videoUnavailable}
                  autoStart
                />
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div className="rounded-xl border border-white/10 bg-black/15 p-3"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-xs font-semibold text-white"><Radio className="size-4 text-[var(--replay-floodlight)]" /> {copy.live.recorded}</span><span className="font-mono text-[9px] text-[var(--replay-floodlight)]">{copy.simulated}</span></div><p className="mt-2 text-[10px] text-white/50">{copy.live.demoNote} · {copy.live.signal}</p></div>
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
                {clips[0]?.rawSrc?.includes(".m3u8") && clips[0]?.src ? (
                  <VarPlayer
                    src={clips[0].rawSrc}
                    fallbackSrc={clips[0].src}
                    title={`${copy.var.title} · ${copy.galaxy}`}
                  />
                ) : (
                  <div className="p-3">
                    <DemoMediaStage
                      clip={clips[0]}
                      label={copy.var.title}
                      playLabel={copy.playVideo}
                      pauseLabel={copy.pause}
                      sampleLabel={copy.sampleFootage}
                      unavailableLabel={copy.videoUnavailable}
                      autoStart
                    />
                  </div>
                )}
                <div className="pointer-events-none absolute end-3 top-3 flex flex-wrap justify-end gap-2">
                  <span className="rounded-full bg-black/65 px-2.5 py-1.5 font-mono text-[9px] text-white/85">{copy.var.decision}: {copy.var.overturned}</span>
                  {varMarked && <span className="animate-pulse rounded-full bg-[var(--replay-turf)] px-2.5 py-1.5 font-mono text-[9px] font-bold text-black">{copy.var.marked}</span>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3"><DemoButton testId="button-mark-var" onClick={() => setVarMarked(true)} icon={varMarked ? <Check className="size-4" /> : <ScanLine className="size-4" />}>{varMarked ? copy.var.marked : copy.var.mark}</DemoButton><p className="max-w-[290px] text-[10px] leading-4 text-muted-text"><LockKeyhole className="me-1 inline size-3 text-[var(--replay-turf)]" />{copy.var.privateBody}</p></div>
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
                <div className="grid grid-cols-3 gap-2 pt-5">{[[copy.player.minutes, "68"], [copy.player.moments, "7"], [copy.player.rating, "8.4"]].map(([label, value]) => <div key={label} className="rounded-xl bg-surface p-3"><p className="text-[10px] text-muted-text">{label}</p><p className="mt-2 font-display text-2xl font-bold text-text" data-testid={`text-player-stat-${label}`}>{value}</p></div>)}</div>
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
                <div className="rounded-2xl border border-line bg-raised p-4"><div className="mb-5 flex items-center justify-between"><Video className="size-5 text-[var(--replay-floodlight)]" /><span className="font-mono text-xs text-muted-text">{copy.jod}</span></div><p className="text-[10px] text-muted-text">{copy.owner.recording}</p><p className="mt-1 font-display text-3xl font-bold">18 <span className="font-mono text-xs font-normal text-muted-text">{copy.jod}</span></p><p className="mt-2 text-[9px] text-muted-text">{copy.owner.priceHint}</p></div>
                <div className="rounded-2xl border border-line bg-raised p-4"><div className="mb-5 flex items-center justify-between"><ScanLine className="size-5 text-[var(--replay-violet)]" /><span className="font-mono text-xs text-muted-text">{copy.jod}</span></div><p className="text-[10px] text-muted-text">{copy.owner.varPrice}</p><p className="mt-1 font-display text-3xl font-bold">6 <span className="font-mono text-xs font-normal text-muted-text">{copy.jod}</span></p><p className="mt-2 text-[9px] text-muted-text">{copy.owner.priceHint}</p></div>
                <div className="rounded-2xl border border-line bg-raised p-4 sm:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold">{copy.owner.share}</p><p className="mt-1 font-mono text-[10px] text-muted-text">{copy.owner.sampleLink}</p><p className="mt-2 flex items-center gap-1 text-[9px] text-[var(--replay-floodlight)]"><Clock3 className="size-3" /> {copy.owner.expires} 6 {copy.owner.days}</p></div><div className="flex items-center gap-2"><button type="button" data-testid="button-copy-owner-link" aria-label={copy.owner.copy} onClick={() => copyText(copy.owner.sampleLink, "owner")} className="grid size-10 place-items-center rounded-lg border border-line bg-surface text-muted-text hover:text-text">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button><button type="button" data-testid="button-toggle-owner-qr" aria-label={showQr ? copy.owner.qrHidden : copy.owner.qr} onClick={() => setShowQr((value) => !value)} className="grid size-10 place-items-center rounded-lg border border-line bg-surface text-muted-text hover:text-text"><QrCode className="size-4" /></button></div></div>{showQr && <div className="mt-4 flex items-center gap-3 rounded-xl bg-text p-3 text-[var(--replay-void)]"><div className="grid size-20 grid-cols-5 gap-1 bg-text p-1">{Array.from({ length: 25 }).map((_, index) => <span key={index} className={(index * 7 + index) % 3 === 0 ? "bg-[var(--replay-void)]" : "bg-transparent"} />)}</div><span className="text-[10px] font-semibold">{copy.owner.qr} · {copy.owner.expires} 6 {copy.owner.days}</span></div>}</div>
                <div className="rounded-2xl border border-line bg-raised p-4 sm:col-span-2"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-bold">{copy.owner.billing}</p><p className="mt-1 text-[10px] text-muted-text">{copy.owner.bookingLabel} · 18 {copy.jod}</p></div><button type="button" data-testid="button-toggle-billing" onClick={() => setBillingPaid((value) => !value)} className={`min-h-9 rounded-lg px-3 text-[10px] font-bold ${billingPaid ? "bg-[var(--replay-turf)] text-black" : "bg-surface text-muted-text"}`}>{billingPaid ? copy.owner.billed : copy.owner.pending}</button></div><div className="flex gap-2"><DemoButton testId="button-request-footage" onClick={() => setRequestSent(true)} icon={requestSent ? <Check className="size-4" /> : <Send className="size-4" />}>{requestSent ? copy.owner.requested : copy.owner.request}</DemoButton><p className="self-center text-[10px] text-muted-text">{copy.owner.requestBody}</p></div></div>
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
              <DemoButton variant="primary" testId="button-next-roi" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 9 && (
            <div className="grid gap-6 p-5 sm:p-8">
              <SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} />
              <div className="grid gap-3 sm:grid-cols-3">
                {copy.ops.cameraNames.map((name, index) => <div key={name} className="rounded-2xl border border-line bg-raised p-4" data-testid={`card-camera-${index}`}><div className="mb-6 flex items-center justify-between"><Wifi className="size-5 text-[var(--replay-turf)]" /><span className="size-2 rounded-full bg-[var(--replay-turf)] shadow-[0_0_0_4px_rgba(47,216,196,.11)]" /></div><p className="text-xs font-semibold">{name}</p><p className="mt-1 text-[10px] text-[var(--replay-turf)]">{copy.ops.online} · 98%</p></div>)}
              </div>
              <div className="rounded-2xl border border-line bg-raised p-4"><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-bold">{copy.ops.queue}</p><p className="mt-1 text-[10px] text-muted-text">{copy.ops.waiting}</p></div><Timer className="size-5 text-[var(--replay-floodlight)]" /></div><div className="grid gap-2">{copy.ops.queueItems.map((item, index) => <div key={item} className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${clearedQueue.includes(index) ? "border-[var(--replay-turf)]/25 bg-[var(--replay-turf)]/5 opacity-60" : "border-line bg-surface"}`}><span className="flex items-center gap-2 text-[10px]"><span className={`size-1.5 rounded-full ${clearedQueue.includes(index) ? "bg-[var(--replay-turf)]" : "bg-[var(--replay-floodlight)]"}`} />{item}</span><button type="button" data-testid={`button-clear-queue-${index}`} onClick={() => setClearedQueue((queue) => queue.includes(index) ? queue : [...queue, index])} className="min-h-8 rounded-lg px-2.5 text-[9px] font-semibold text-muted-text hover:bg-raised hover:text-text">{clearedQueue.includes(index) ? <Check className="size-3" /> : copy.ops.clear}</button></div>)}</div></div>
              <DemoButton variant="primary" testId="button-next-ops" onClick={next} icon={<ArrowRight className="size-4 rtl:rotate-180" />}>{stepCopy.cta}</DemoButton>
            </div>
          )}

          {activeStop === 10 && (
            <div className="relative grid min-h-[590px] content-between overflow-hidden bg-[linear-gradient(145deg,#182b28,#111921_58%,#201c34)] p-5 sm:p-8">
              <div className="pointer-events-none absolute -end-12 -top-12 size-64 rounded-full border border-[var(--replay-floodlight)]/15" /><div className="pointer-events-none absolute -end-4 -top-4 size-48 rounded-full border border-[var(--replay-floodlight)]/10" />
              <div><p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--replay-floodlight)]/25 bg-[var(--replay-floodlight)]/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--replay-floodlight)]"><Zap className="size-3" /> {copy.pilot.badge}</p><SectionHeading kicker={stepCopy.kicker} title={stepCopy.title} body={stepCopy.body} /></div>
              <div><div className="mb-6 grid gap-3 sm:grid-cols-3">{copy.pilot.steps.map((item, index) => <div key={item} className="rounded-xl border border-white/10 bg-black/15 p-3"><p className="font-mono text-[9px] text-white/45">0{index + 1}</p><p className="mt-5 text-xs font-semibold text-white/85">{item}</p></div>)}</div><div className="flex flex-wrap items-center gap-3"><DemoButton variant="primary" testId="button-start-pilot" onClick={() => setPilotStarted(true)} icon={pilotStarted ? <Check className="size-4" /> : <ArrowRight className="size-4 rtl:rotate-180" />}>{pilotStarted ? copy.pilot.started : copy.pilot.action}</DemoButton><span className="font-mono text-[10px] text-white/50">{copy.pilot.secondary}</span></div></div>
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
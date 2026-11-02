import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { X } from "lucide-react";
import { useLocale } from "@/i18n/context";

/**
 * The live player for an academy's parents, coaches and owner.
 *
 * Both views play straight from Bunny (vps1's private copies of the session's
 * live feed), never through the app. A match also gets "Follow the ball": a
 * 1920x1080 view panned by a GPU vps1 rents from VAR open to VAR close (booked
 * with pan=1). It opens on that view whenever it is ready, and "Full pitch" is
 * one tap away. Training sessions have the full pitch only.
 */
type LiveStatus = {
  status: "upcoming" | "live" | "not_live" | "ended" | "no_booking";
  sessionType?: "training" | "match";
  playlistPath: string | null;
  panPlaylistPath?: string | null;
  panAvailable?: boolean;
  message: string;
};

type View = "follow" | "full";

const COPY = {
  en: {
    follow: "Follow the ball",
    full: "Full pitch",
    viewLabel: "Choose the view",
    live: "Live",
    checking: "Checking live session…",
    close: "Close live player",
    followStarting: "Follow the ball starts a minute or two after kick-off.",
    behind: "About 30 seconds behind the pitch.",
    signIn: "Sign in to watch this session.",
    unavailable: "This live session is unavailable.",
    statusFailed: "Live status unavailable.",
    noHls: "This browser cannot play this video.",
  },
  ar: {
    follow: "تتبّع الكرة",
    full: "الملعب كامل",
    viewLabel: "اختر العرض",
    live: "مباشر",
    checking: "عم نتحقق من البث…",
    close: "إغلاق البث",
    followStarting: "تتبّع الكرة بيبدأ بعد دقيقة أو دقيقتين من بداية المباراة.",
    behind: "متأخر عن الملعب حوالي ٣٠ ثانية.",
    signIn: "سجّل دخولك لتشاهد هالحصة.",
    unavailable: "هالبث مش متاح.",
    statusFailed: "حالة البث مش متاحة.",
    noHls: "هالمتصفح ما بيشغّل هالفيديو.",
  },
} as const;

const VIEW_KEY = "replay-academy-live-view";

export function AcademyLiveOverlay({
  statusUrl,
  title,
  onClose,
}: {
  statusUrl: string;
  title: string;
  onClose: () => void;
}) {
  const { locale } = useLocale();
  const c = COPY[locale === "ar" ? "ar" : "en"];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => {
    try {
      return sessionStorage.getItem(VIEW_KEY) === "full" ? "full" : "follow";
    } catch {
      return "follow";
    }
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = await fetch(statusUrl, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 ? c.signIn : c.unavailable);
        const result = await response.json() as LiveStatus;
        if (active) {
          setStatus(result);
          setError(null);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : c.statusFailed);
      } finally {
        if (active) timer = setTimeout(check, 8_000);
      }
    };
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [statusUrl, c.signIn, c.unavailable, c.statusFailed]);

  const isLive = status?.status === "live" && Boolean(status.playlistPath);
  const isMatch = status?.sessionType === "match";
  const panUrl = isLive && isMatch ? status?.panPlaylistPath ?? null : null;
  const showFollow = view === "follow" && panUrl !== null;
  const src = !isLive ? null : showFollow ? panUrl : status?.playlistPath ?? null;

  useEffect(() => {
    try {
      sessionStorage.setItem(VIEW_KEY, view);
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, [view]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 20 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => undefined); });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // If the ball-follow view dies (GPU stopped, stock ran out), fall back to the
        // full pitch rather than leave a frozen frame.
        if (data.fatal && showFollow) setView("full");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      void video.play().catch(() => undefined);
    } else {
      setError(c.noHls);
    }
    return () => {
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, showFollow, c.noHls]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const note = error ?? (!isLive ? status?.message ?? c.checking : null);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      dir={locale === "ar" ? "rtl" : "ltr"}
      data-testid="academy-live-player"
    >
      <header className="flex items-center gap-3 px-4 py-3 sm:px-6">
        {isLive && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#E5484D] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden="true" />
            {c.live}
          </span>
        )}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/10"
          aria-label={c.close}
        >
          <X size={22} aria-hidden="true" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 bg-black">
        {src
          ? <video key={src} ref={videoRef} className="h-full w-full object-contain" controls autoPlay playsInline muted={false} />
          : <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75" aria-live="polite">{note}</div>}
      </div>

      {isLive && (
        <footer className="flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          {isMatch && (
            <div role="group" aria-label={c.viewLabel} className="flex rounded-full bg-white/10 p-1">
              {(["follow", "full"] as const).map((option) => {
                const disabled = option === "follow" && panUrl === null;
                const pressed = option === "follow" ? showFollow : !showFollow;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={pressed}
                    disabled={disabled}
                    onClick={() => setView(option)}
                    className={`min-h-11 rounded-full px-5 text-sm font-semibold transition-colors disabled:opacity-40 ${
                      pressed ? "bg-white text-black" : "text-white/80"
                    }`}
                  >
                    {option === "follow" ? c.follow : c.full}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-center text-xs text-white/55" aria-live="polite">
            {isMatch && panUrl === null ? c.followStarting : c.behind}
          </p>
        </footer>
      )}
    </div>
  );
}

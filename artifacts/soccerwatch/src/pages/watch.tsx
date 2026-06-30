import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { useListClips, useToggleLike, useSaveClip, useUnsaveClip, getListClipsQueryKey, getListSavedClipsQueryKey, Clip, Ad } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Bookmark, Volume2, VolumeX, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";

const FALLBACK_VIDEOS = [
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
];

function isUsableUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Reject if hostname has spaces or no dot (malformed placeholder URLs)
    return u.hostname.includes(".") && !u.hostname.includes(" ");
  } catch {
    return false;
  }
}

export default function Watch() {
  const { data: clips, isLoading } = useListClips();
  const { t } = useTranslation();

  if (isLoading) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white">{t.watch.loadingFeed}</div>;
  }

  if (!clips || clips.length === 0) {
    return <div className="flex-1 bg-black flex items-center justify-center text-white">{t.watch.noClips}</div>;
  }

  return (
    <div className="flex-1 min-h-0 bg-black overflow-y-scroll snap-y snap-mandatory no-scrollbar">
      {clips.map((clip, idx) => (
        <ClipScreen key={clip.id} clip={clip} index={idx} />
      ))}
    </div>
  );
}

type AdPhase = "idle" | "showing" | "done";

function handleAdClick(ad: Ad) {
  fetch(`/api/ads/${ad.id}/click`, {
    method: "POST",
    credentials: "include",
  }).catch(() => {});
  window.open(ad.clickUrl, "_blank", "noopener,noreferrer");
}

function ClipScreen({ clip, index }: { clip: Clip; index: number }) {
  const queryClient = useQueryClient();
  const { isGuest } = useAuth();
  const { toast } = useToast();

  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Ad state
  const [adPhase, setAdPhase] = useState<AdPhase>("idle");
  const [currentAd, setCurrentAd] = useState<Ad | null>(null);
  const [skipSecondsLeft, setSkipSecondsLeft] = useState<number | null>(null);
  const adVideoRef = useRef<HTMLVideoElement>(null);
  const adHlsRef = useRef<Hls | null>(null);
  const adElapsedRef = useRef(0);
  const adCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const adImageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleLikeMutation = useToggleLike();
  const saveClipMutation = useSaveClip();
  const unsaveClipMutation = useUnsaveClip();

  const startClip = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.play().catch(() => {});
    setIsPlaying(true);
  }, []);

  const finishAd = useCallback((ad: Ad, skippedAt?: number) => {
    if (adCountdownRef.current) { clearInterval(adCountdownRef.current); adCountdownRef.current = null; }
    if (adImageTimeoutRef.current) { clearTimeout(adImageTimeoutRef.current); adImageTimeoutRef.current = null; }
    if (adHlsRef.current) { adHlsRef.current.destroy(); adHlsRef.current = null; }
    if (adVideoRef.current) { adVideoRef.current.pause(); adVideoRef.current.removeAttribute("src"); }

    const completed = skippedAt === undefined;
    fetch(`/api/ads/${ad.id}/impression`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipId: clip.id, completed, skippedAtSecond: skippedAt ?? null }),
    }).catch(() => {});

    setAdPhase("done");
    setCurrentAd(null);
    startClip();
  }, [clip.id, startClip]);

  // Clear all ad timers helper
  const clearAdTimers = useCallback(() => {
    if (adCountdownRef.current) { clearInterval(adCountdownRef.current); adCountdownRef.current = null; }
    if (adImageTimeoutRef.current) { clearTimeout(adImageTimeoutRef.current); adImageTimeoutRef.current = null; }
  }, []);

  // Load clip video via HLS.js, with automatic fallback on error
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const primary =
      (isUsableUrl(clip.bunnyPlaybackUrl) ? clip.bunnyPlaybackUrl : null) ??
      (isUsableUrl(clip.videoUrl) ? clip.videoUrl : null);
    const fallbackSrc = FALLBACK_VIDEOS[index % FALLBACK_VIDEOS.length];
    let usedFallback = false;

    function loadSrc(src: string) {
      if (!video) return;
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.pause();
      video.removeAttribute("src");
      video.load();

      if (src.includes(".m3u8")) {
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: false });
          hlsRef.current = hls;
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && !usedFallback) {
              usedFallback = true;
              loadSrc(fallbackSrc);
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
        }
      } else {
        video.src = src;
      }
    }

    function handleVideoError() {
      if (!usedFallback) {
        usedFallback = true;
        loadSrc(fallbackSrc);
      }
    }

    video.addEventListener("error", handleVideoError);
    loadSrc(primary ?? fallbackSrc);

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeEventListener("error", handleVideoError);
    };
  }, [clip.id, clip.bunnyPlaybackUrl, clip.videoUrl, index]);

  // Load ad video when ad starts
  useEffect(() => {
    if (adPhase !== "showing" || !currentAd) return;
    const adVideo = adVideoRef.current;
    if (!adVideo) return;

    const src = currentAd.creativeUrl;
    if (src.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false });
        adHlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(adVideo);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          adVideo.play().catch(() => {});
        });
      } else if (adVideo.canPlayType("application/vnd.apple.mpegurl")) {
        adVideo.src = src;
        adVideo.play().catch(() => {});
      }
    } else if (src.match(/\.(mp4|webm|ogg)$/i)) {
      adVideo.src = src;
      adVideo.play().catch(() => {});
    }

    return () => {
      if (adHlsRef.current) { adHlsRef.current.destroy(); adHlsRef.current = null; }
    };
  }, [adPhase, currentAd]);

  // Skip countdown timer
  useEffect(() => {
    if (adPhase !== "showing" || !currentAd) return;

    const SKIP_AFTER = 5;
    setSkipSecondsLeft(SKIP_AFTER);
    adElapsedRef.current = 0;

    adCountdownRef.current = setInterval(() => {
      adElapsedRef.current += 1;
      const left = SKIP_AFTER - adElapsedRef.current;
      setSkipSecondsLeft(left > 0 ? left : 0);
    }, 1000);

    return () => {
      if (adCountdownRef.current) { clearInterval(adCountdownRef.current); adCountdownRef.current = null; }
    };
  }, [adPhase, currentAd]);

  // Intersection Observer: fetch ad then autoplay
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setAdPhase("idle");
          setCurrentAd(null);
          fetch(`/api/ads/next?clipId=${clip.id}`, { credentials: "include" })
            .then(async (r) => {
              if (r.status === 204 || !r.ok) return null;
              return r.json() as Promise<Ad>;
            })
            .then((ad) => {
              if (ad && ad.id) {
                setCurrentAd(ad);
                setAdPhase("showing");
              } else {
                setAdPhase("done");
                video.play().catch(() => {});
                setIsPlaying(true);
              }
            })
            .catch(() => {
              setAdPhase("done");
              video.play().catch(() => {});
              setIsPlaying(true);
            });
        } else {
          video.pause();
          setIsPlaying(false);
          clearAdTimers();
          if (adHlsRef.current) { adHlsRef.current.destroy(); adHlsRef.current = null; }
          setAdPhase("idle");
          setCurrentAd(null);
        }
      },
      { threshold: 0.6 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [clip.id, clearAdTimers]);

  const { t } = useTranslation();

  const handleToggleLike = () => {
    if (isGuest) {
      toast({ title: t.watch.signInToLike, description: t.watch.signInToLikeDesc });
      return;
    }
    toggleLikeMutation.mutate(
      { id: clip.id },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getListClipsQueryKey(), (old: Clip[] | undefined) =>
            old?.map(c => c.id === clip.id ? { ...c, isLiked: data.liked, likeCount: data.likeCount } : c)
          );
        }
      }
    );
  };

  const handleToggleSave = () => {
    if (isGuest) {
      toast({ title: t.watch.signInToSave, description: t.watch.signInToSaveDesc });
      return;
    }

    if (clip.isSaved) {
      unsaveClipMutation.mutate(
        { clipId: clip.id },
        {
          onSuccess: () => {
            queryClient.setQueryData(getListClipsQueryKey(), (old: Clip[] | undefined) =>
              old?.map(c => c.id === clip.id ? { ...c, isSaved: false } : c)
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
          }
        }
      );
    } else {
      saveClipMutation.mutate(
        { clipId: clip.id },
        {
          onSuccess: () => {
            queryClient.setQueryData(getListClipsQueryKey(), (old: Clip[] | undefined) =>
              old?.map(c => c.id === clip.id ? { ...c, isSaved: true } : c)
            );
            queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
            toast({ title: t.watch.savedToMyClips, className: "bg-primary text-white border-none" });
          }
        }
      );
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (video) {
      video.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const togglePlay = () => {
    if (adPhase === "showing") return;
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) { video.pause(); } else { video.play().catch(() => {}); }
    setIsPlaying(!isPlaying);
  };

  const isVideoAd = currentAd && (
    currentAd.creativeUrl.includes(".m3u8") ||
    currentAd.creativeUrl.match(/\.(mp4|webm|ogg)$/i)
  );

  return (
    <div className="relative w-full h-full shrink-0 snap-start bg-black overflow-hidden" onClick={togglePlay}>
      <div className="absolute inset-0 field-pattern opacity-30" />

      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        loop
        muted={isMuted}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/80 pointer-events-none" />

      {/* Top Bar */}
      <div className="absolute top-0 start-0 w-full h-1 bg-white/20">
        <div className="h-full bg-primary w-1/3" />
      </div>

      <div className="absolute top-safe pt-4 px-4 w-full flex justify-between items-start pointer-events-none">
        <div className="bg-primary/90 text-white px-3 py-1.5 rounded-full text-xs font-bold shadow-lg flex items-center gap-1.5">
          <CrownIcon className="w-3 h-3" />
          {clip.rank === 1 ? t.watch.rankFirst : t.watch.rankOther(clip.rank)}
        </div>
        <button
          onClick={toggleMute}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white pointer-events-auto backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Right Rail */}
      <div className="absolute end-4 bottom-28 flex flex-col items-center gap-6 pointer-events-auto">
        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleToggleLike}
            className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90"
          >
            <Heart className={cn("w-6 h-6 transition-colors", clip.isLiked ? "fill-destructive text-destructive" : "text-white")} />
          </button>
          <span className="text-white font-medium text-xs shadow-black drop-shadow-md">{clip.likeCount}</span>
        </div>

        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleToggleSave}
            className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90"
          >
            <Bookmark className={cn("w-6 h-6 transition-colors", clip.isSaved ? "fill-primary text-primary" : "text-white")} />
          </button>
        </div>

        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90">
            <Share className="w-6 h-6 text-white" />
          </button>
        </div>
      </div>

      {/* Bottom Info */}
      <div className="absolute bottom-24 start-4 end-20 text-white pointer-events-auto">
        <div className="bg-primary text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase inline-block mb-2">
          {clip.momentLabel}
        </div>
        <h2 className="text-xl font-bold mb-1 shadow-black drop-shadow-md">{clip.fieldName || t.watch.localPitch}</h2>
        <p className="text-white/80 text-sm mb-3 shadow-black drop-shadow-md">{clip.court || t.watch.court1} • {clip.date || t.watch.recent}</p>

        {clip.playerTags && clip.playerTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {clip.playerTags.map((tag) => (
              <span key={tag} className="text-xs bg-white/20 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/10 font-medium">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Ad Overlay */}
      {adPhase === "showing" && currentAd && (
        <div
          className="absolute inset-0 bg-black z-20 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {isVideoAd ? (
            <video
              ref={adVideoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted={isMuted}
              onEnded={() => finishAd(currentAd)}
            />
          ) : (
            <img
              src={currentAd.creativeUrl}
              alt="Advertisement"
              className="absolute inset-0 w-full h-full object-cover"
              onLoad={() => {
                if (adImageTimeoutRef.current) clearTimeout(adImageTimeoutRef.current);
                adImageTimeoutRef.current = setTimeout(
                  () => finishAd(currentAd),
                  currentAd.durationSeconds * 1000
                );
              }}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/60 pointer-events-none" />

          {/* Ad badge — clickable, opens click-through URL */}
          <div className="absolute top-safe pt-4 px-4 w-full flex justify-between items-start pointer-events-auto">
            <button
              onClick={() => handleAdClick(currentAd)}
              className="bg-black/60 text-white/80 border border-white/20 text-[10px] font-bold px-2 py-1 rounded backdrop-blur-sm active:scale-95 transition-transform"
            >
              AD
            </button>
            {skipSecondsLeft !== null && skipSecondsLeft > 0 ? (
              <span className="bg-black/60 text-white/70 border border-white/20 text-xs px-3 py-1.5 rounded backdrop-blur-sm">
                {t.watch.skipIn(skipSecondsLeft)}
              </span>
            ) : (
              <button
                onClick={() => finishAd(currentAd, adElapsedRef.current)}
                className="bg-white/90 text-black text-xs font-bold px-3 py-1.5 rounded active:scale-95 transition-transform"
              >
                {t.watch.skipNow}
              </button>
            )}
          </div>

          {/* Visit button */}
          <div className="absolute bottom-safe pb-8 px-6 w-full pointer-events-auto">
            <button
              onClick={() => handleAdClick(currentAd)}
              className="w-full bg-white text-black font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg"
            >
              <ExternalLink className="w-4 h-4" />
              {t.watch.visit}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CrownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" />
    </svg>
  );
}

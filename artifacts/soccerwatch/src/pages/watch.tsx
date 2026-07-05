import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import Hls from "hls.js";
import {
  useGetFeed,
  useToggleUserClipLike,
  useRecordView,
  useRecordShare,
  getGetFeedQueryKey,
  FeedClip,
  Ad,
  CropKeyframe,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Heart, Share, Volume2, VolumeX, ExternalLink, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const FALLBACK_VIDEOS = [
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
];

function isUsableUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.includes(".") && !u.hostname.includes(" ");
  } catch {
    return false;
  }
}

function SocialLikesLine({
  socialLikes,
  onNavigate,
}: {
  socialLikes: { userId: number; name: string }[];
  onNavigate: (path: string) => void;
}) {
  const first = socialLikes[0];
  const rest = socialLikes.length - 1;

  let textNode: React.ReactNode;
  if (socialLikes.length === 1) {
    textNode = (
      <>
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(`/players/${first.userId}`); }}
          className="font-semibold underline-offset-2 hover:underline active:opacity-70"
        >
          {first.name}
        </button>
        {" liked this"}
      </>
    );
  } else if (socialLikes.length === 2) {
    const second = socialLikes[1];
    textNode = (
      <>
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(`/players/${first.userId}`); }}
          className="font-semibold underline-offset-2 hover:underline active:opacity-70"
        >
          {first.name}
        </button>
        {" and "}
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(`/players/${second.userId}`); }}
          className="font-semibold underline-offset-2 hover:underline active:opacity-70"
        >
          {second.name}
        </button>
        {" liked this"}
      </>
    );
  } else {
    textNode = (
      <>
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate(`/players/${first.userId}`); }}
          className="font-semibold underline-offset-2 hover:underline active:opacity-70"
        >
          {first.name}
        </button>
        {` and ${rest} others you follow liked this`}
      </>
    );
  }

  return (
    <p className="mt-1.5 text-[11px] text-white/80 leading-snug drop-shadow">
      {"❤ "}
      {textNode}
    </p>
  );
}

function interpolateCropPath(cropPath: CropKeyframe[], t: number): CropKeyframe {
  if (cropPath.length === 0) return { t, x: 0, y: 0, w: 1, h: 1 };
  if (cropPath.length === 1) return cropPath[0];
  const first = cropPath[0];
  const last = cropPath[cropPath.length - 1];
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  const nextIdx = cropPath.findIndex((kf) => kf.t > t);
  const prevIdx = nextIdx - 1;
  const kf0 = cropPath[prevIdx];
  const kf1 = cropPath[nextIdx];
  const alpha = (t - kf0.t) / (kf1.t - kf0.t);
  return {
    t,
    x: kf0.x + (kf1.x - kf0.x) * alpha,
    y: kf0.y + (kf1.y - kf0.y) * alpha,
    w: kf0.w + (kf1.w - kf0.w) * alpha,
    h: kf0.h + (kf1.h - kf0.h) * alpha,
  };
}

function cropToTransform(kf: CropKeyframe): string {
  if (!kf || kf.w <= 0) return "";
  const cx = kf.x + kf.w / 2;
  const cy = kf.y + kf.h / 2;
  const scale = 1 / kf.w;
  const tx = (0.5 - cx) / kf.w * 100;
  const ty = (0.5 - cy) / kf.w * 100;
  return `translateX(${tx}%) translateY(${ty}%) scale(${scale})`;
}

export default function Watch() {
  const { data: clips, isLoading } = useGetFeed();
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [slideHeight, setSlideHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSlideHeight(el.clientHeight));
    ro.observe(el);
    setSlideHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const ready = slideHeight > 0;

  return (
    <div ref={containerRef} className="flex-1 min-h-0 bg-black overflow-y-scroll snap-y snap-mandatory no-scrollbar">
      {isLoading || !ready ? (
        <div className="flex items-center justify-center text-white" style={{ height: slideHeight || "100%" }}>
          {t.watch.loadingFeed}
        </div>
      ) : !clips || clips.length === 0 ? (
        <div className="flex items-center justify-center text-white" style={{ height: slideHeight }}>
          {t.watch.noClips}
        </div>
      ) : (
        clips.map((clip, idx) => (
          <ClipScreen key={clip.id} clip={clip} index={idx} slideHeight={slideHeight} />
        ))
      )}
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

function ClipScreen({ clip, index, slideHeight }: { clip: FeedClip; index: number; slideHeight: number }) {
  const queryClient = useQueryClient();
  const { isGuest } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const scrollRef9 = useRef<HTMLDivElement>(null);

  const [adPhase, setAdPhase] = useState<AdPhase>("idle");
  const [currentAd, setCurrentAd] = useState<Ad | null>(null);
  const [skipSecondsLeft, setSkipSecondsLeft] = useState<number | null>(null);
  const adVideoRef = useRef<HTMLVideoElement>(null);
  const adHlsRef = useRef<Hls | null>(null);
  const adElapsedRef = useRef(0);
  const adCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const adImageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleLikeMutation = useToggleUserClipLike();
  const recordViewMutation = useRecordView();
  const recordShareMutation = useRecordShare();

  // Track clip playback boundaries
  const clipStartSec = useRef<number>(0);
  const clipEndSec = useRef<number>(Infinity);
  const durationRef = useRef<number>(0);
  const startTimeRecorded = useRef<boolean>(false);
  const viewStartRef = useRef<number>(0);

  // Reset view tracking on mount so off-screen clips don't get false views
  useEffect(() => {
    viewStartRef.current = 0;
    startTimeRecorded.current = false;
  }, [clip.id]);

  const startClip = useCallback(() => {
    const video = videoRef.current;
    if (!video || !durationRef.current) return;
    const startSec = clip.startTime * durationRef.current;
    const endSec = clip.endTime * durationRef.current;
    clipStartSec.current = startSec;
    clipEndSec.current = endSec;
    video.currentTime = startSec;
    video.play().catch(() => {});
    setIsPlaying(true);
  }, [clip.startTime, clip.endTime]);

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

  const clearAdTimers = useCallback(() => {
    if (adCountdownRef.current) { clearInterval(adCountdownRef.current); adCountdownRef.current = null; }
    if (adImageTimeoutRef.current) { clearTimeout(adImageTimeoutRef.current); adImageTimeoutRef.current = null; }
  }, []);

  const shouldPlayRef = useRef(false);

  // Load clip video via HLS.js, with automatic fallback on error
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    startTimeRecorded.current = false;

    const primary = isUsableUrl(clip.playbackUrl) ? clip.playbackUrl : null;
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
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (shouldPlayRef.current) {
              durationRef.current = video.duration || 0;
              const startSec = clip.startTime * durationRef.current;
              video.currentTime = startSec;
              video.play().catch(() => {});
            }
          });
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && !usedFallback) {
              usedFallback = true;
              loadSrc(fallbackSrc);
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
          video.addEventListener("canplay", () => {
            if (shouldPlayRef.current) {
              durationRef.current = video.duration || 0;
              const startSec = clip.startTime * durationRef.current;
              video.currentTime = startSec;
              video.play().catch(() => {});
            }
          }, { once: true });
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

    function applyCrop(kf: CropKeyframe) {
      if (clip.aspectRatio === "9:16") {
        const scrollEl = scrollRef9.current;
        if (scrollEl) {
          const totalW = scrollEl.scrollWidth;
          const viewW = scrollEl.clientWidth;
          const cropCenterPx = (kf.x + kf.w / 2) * totalW;
          scrollEl.scrollLeft = Math.max(0, Math.min(totalW - viewW, cropCenterPx - viewW / 2));
        }
      } else {
        video!.style.transform = cropToTransform(kf);
      }
    }

    // On loadedmetadata, compute clip boundaries and apply initial crop
    function handleLoadedMetadata() {
      if (!video) return;
      durationRef.current = video.duration || 0;
      clipStartSec.current = clip.startTime * durationRef.current;
      clipEndSec.current = clip.endTime * durationRef.current;
      if (clip.cropPath.length > 0) {
        const kf = interpolateCropPath(clip.cropPath, 0);
        applyCrop(kf);
        if (clip.aspectRatio !== "9:16") {
          video.style.transition = "transform 0.1s linear";
        }
      }
    }

    function handleTimeUpdate() {
      if (!video || !durationRef.current) return;
      // Loop within clip boundaries
      if (video.currentTime >= clipEndSec.current) {
        video.currentTime = clipStartSec.current;
      }
      // Apply crop pan
      if (clip.cropPath.length > 0) {
        const clipDuration = clipEndSec.current - clipStartSec.current;
        const t = clipDuration > 0
          ? (video.currentTime - clipStartSec.current) / clipDuration
          : 0;
        const kf = interpolateCropPath(clip.cropPath, Math.max(0, Math.min(1, t)));
        applyCrop(kf);
      }
    }

    video.addEventListener("error", handleVideoError);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("timeupdate", handleTimeUpdate);
    loadSrc(primary ?? fallbackSrc);

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeEventListener("error", handleVideoError);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      if (clip.aspectRatio !== "9:16") {
        video.style.transform = "";
        video.style.transition = "";
      }
    };
  }, [clip.id, clip.playbackUrl, clip.startTime, clip.endTime, clip.cropPath, clip.aspectRatio, index]);

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

  // Intersection Observer: fetch ad then autoplay, track views
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          shouldPlayRef.current = true;
          viewStartRef.current = Date.now();
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
          shouldPlayRef.current = false;
          video.pause();
          setIsPlaying(false);
          clearAdTimers();
          if (adHlsRef.current) { adHlsRef.current.destroy(); adHlsRef.current = null; }
          setAdPhase("idle");
          setCurrentAd(null);

          // Record view on exit if the clip was actually intersected (>2s watched) and not already recorded
          if (!startTimeRecorded.current && viewStartRef.current > 0) {
            const watched = (Date.now() - viewStartRef.current) / 1000;
            if (watched > 2) {
              startTimeRecorded.current = true;
              recordViewMutation.mutate(
                { id: clip.id, data: { secondsWatched: watched } },
                {
                  onSuccess: (data) => {
                    if (data.ok) {
                      queryClient.setQueryData(getGetFeedQueryKey(), (old: FeedClip[] | undefined) =>
                        old?.map((c) =>
                          c.id === clip.id
                            ? { ...c, viewCount: data.viewCount, score: data.score }
                            : c
                        )
                      );
                    }
                  },
                }
              );
            }
          }
        }
      },
      { threshold: 0.6 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [clip.id, clearAdTimers, queryClient, recordViewMutation]);

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
          queryClient.setQueryData(getGetFeedQueryKey(), (old: FeedClip[] | undefined) =>
            old?.map(c => c.id === clip.id ? { ...c, isLiked: data.liked, likeCount: data.likeCount } : c)
          );
        }
      }
    );
  };

  const handleShare = () => {
    // Track share on backend
    recordShareMutation.mutate(
      { id: clip.id },
      {
        onSuccess: (data) => {
          if (data.ok) {
            queryClient.setQueryData(getGetFeedQueryKey(), (old: FeedClip[] | undefined) =>
              old?.map(c => c.id === clip.id ? { ...c, shareCount: data.shareCount, score: data.score } : c)
            );
          }
        },
      }
    );

    // Native share if available
    if (navigator.share) {
      navigator.share({ title: clip.title, text: `Check out this clip by ${clip.creatorName}!` }).catch(() => {});
    } else {
      // Fallback: copy link to clipboard
      const url = `${window.location.origin}/watch?clip=${clip.id}`;
      navigator.clipboard.writeText(url).catch(() => {});
      toast({ title: "Link copied!", className: "bg-primary text-white border-none" });
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
    <div
      className="relative w-full shrink-0 snap-start bg-black overflow-hidden"
      style={{ height: slideHeight }}
      onClick={togglePlay}
    >
      <div className="absolute inset-0 field-pattern opacity-30" />

      {clip.aspectRatio === "9:16" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <div
            ref={scrollRef9}
            className="h-full aspect-[9/16] overflow-x-hidden overflow-y-hidden no-scrollbar relative"
          >
            <video
              ref={videoRef}
              className="h-full max-w-none pointer-events-none"
              style={{ aspectRatio: "3840/1080" }}
              playsInline
              loop
              muted={isMuted}
            />
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center bg-black">
          <video
            ref={videoRef}
            className="w-full aspect-[16/9] object-cover"
            playsInline
            loop
            muted={isMuted}
          />
        </div>
      )}

      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/80 pointer-events-none" />

      {/* Top Bar */}
      <div className="absolute top-0 start-0 w-full h-1 bg-white/20" />

      <div className="absolute top-safe pt-4 px-4 w-full flex justify-end items-start pointer-events-none">
        <button
          onClick={toggleMute}
          className="w-10 h-10 bg-black/40 rounded-full flex items-center justify-center text-white pointer-events-auto backdrop-blur-md"
        >
          {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* Right Rail */}
      <div className="absolute end-4 bottom-28 flex flex-col items-center gap-5 pointer-events-auto">
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
          <button className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90">
            <Eye className="w-6 h-6 text-white" />
          </button>
          <span className="text-white font-medium text-xs shadow-black drop-shadow-md">{clip.viewCount}</span>
        </div>

        <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleShare}
            className="w-12 h-12 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-md transition-transform active:scale-90"
          >
            <Share className="w-6 h-6 text-white" />
          </button>
          <span className="text-white font-medium text-xs shadow-black drop-shadow-md">{clip.shareCount}</span>
        </div>
      </div>

      {/* Bottom Info */}
      <div className="absolute bottom-24 start-4 end-20 text-white pointer-events-auto">
        <button
          onClick={(e) => { e.stopPropagation(); setLocation(`/players/${clip.creatorId}`); }}
          className="flex items-center gap-2 mb-3 active:opacity-70 transition-opacity"
        >
          <div className="w-9 h-9 rounded-full bg-primary/90 flex items-center justify-center shadow-md border border-white/20 text-white text-xs font-bold shrink-0">
            {getInitials(clip.creatorName)}
          </div>
          <div className="text-start">
            <p className="text-white text-xs font-semibold leading-tight drop-shadow">{clip.creatorName}</p>
            {clip.creatorPosition && (
              <p className="text-white/70 text-[10px] capitalize leading-tight">{clip.creatorPosition}</p>
            )}
          </div>
        </button>

        <h2 className="text-xl font-bold mb-1 shadow-black drop-shadow-md">{clip.title}</h2>

        {clip.visibility === "followers" && (
          <span className="text-[10px] bg-white/20 backdrop-blur-sm px-2 py-0.5 rounded-full border border-white/20 font-medium">
            Followers only
          </span>
        )}

        {clip.socialLikes && clip.socialLikes.length > 0 && (
          <SocialLikesLine socialLikes={clip.socialLikes} onNavigate={setLocation} />
        )}
      </div>

      {/* Ad Overlay */}
      {adPhase === "showing" && currentAd && (
        <div
          className="absolute inset-0 bg-black z-20 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {isVideoAd ? (
            <div className="absolute inset-0 flex items-center bg-black">
              <video
                ref={adVideoRef}
                className="w-full aspect-[16/9] object-cover"
                playsInline
                muted={isMuted}
                onEnded={() => finishAd(currentAd)}
              />
            </div>
          ) : (
            <img
              src={currentAd.creativeUrl}
              alt="Advertisement"
              className="absolute inset-0 w-full h-full object-contain bg-black"
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

import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Heart, MapPin, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/lib/auth";
import {
  useGetNextAd,
  useListFields,
  useListClips,
  getGetNextAdQueryKey,
  getListFieldsQueryKey,
  getListClipsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const BANNER_INTERVAL = 5000;

const fieldGradients = [
  "from-emerald-700 to-green-900",
  "from-blue-700 to-indigo-900",
  "from-teal-600 to-emerald-900",
  "from-sky-700 to-blue-900",
];

const clipGradients = [
  "from-slate-700 to-slate-900",
  "from-zinc-700 to-zinc-900",
  "from-neutral-700 to-neutral-900",
  "from-stone-700 to-stone-900",
  "from-gray-700 to-gray-900",
];

export default function Home() {
  const { t } = useTranslation();
  const { user, isGuest } = useAuth();
  const qc = useQueryClient();
  const [slide, setSlide] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const firstName = user && !isGuest ? (user.name?.split(" ")[0] ?? user.email?.split("@")[0] ?? "") : "";

  /* Real ad data */
  const { data: adData } = useGetNextAd({
    query: { queryKey: getGetNextAdQueryKey() },
  });
  const hasAd = !!adData && typeof adData === "object" && "id" in adData;
  const ad = hasAd ? adData : null;

  /* Real fields */
  const { data: fieldsData } = useListFields({
    query: { queryKey: getListFieldsQueryKey() },
  });
  const fields = (fieldsData ?? []).slice(0, 4);

  /* Real clips — top 5 by likes */
  const { data: clipsData } = useListClips({
    query: { queryKey: getListClipsQueryKey() },
  });
  const clips = (clipsData ?? [])
    .slice()
    .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    .slice(0, 5);

  /* Banner slides: if there's an ad, use it as the first slide + 2 generic backups */
  const slides = ad
    ? [
        {
          id: `ad-${ad.id}`,
          image: ad.creativeUrl,
          title: ad.title,
          desc: "Sponsored",
          isAd: true as const,
          adId: ad.id,
          clickUrl: ad.clickUrl,
        },
        {
          id: "trending",
          image: null,
          title: t.home.bannerSlide1Title,
          desc: t.home.bannerSlide1Desc,
          isAd: false as const,
        },
        {
          id: "local",
          image: null,
          title: t.home.bannerSlide2Title,
          desc: t.home.bannerSlide2Desc,
          isAd: false as const,
        },
      ]
    : [
        {
          id: "trending",
          image: null,
          title: t.home.bannerSlide1Title,
          desc: t.home.bannerSlide1Desc,
          isAd: false as const,
        },
        {
          id: "local",
          image: null,
          title: t.home.bannerSlide2Title,
          desc: t.home.bannerSlide2Desc,
          isAd: false as const,
        },
      ];

  useEffect(() => {
    if (slides.length <= 1) return;
    intervalRef.current = setInterval(() => {
      setSlide((s) => (s + 1) % slides.length);
    }, BANNER_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [slides.length]);

  const goToSlide = useCallback((i: number) => {
    setSlide(i);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setSlide((s) => (s + 1) % slides.length);
    }, BANNER_INTERVAL);
  }, []);

  const handleAdClick = useCallback(() => {
    const current = slides[slide];
    if (!current.isAd || !current.clickUrl) return;
    window.open(current.clickUrl, "_blank", "noopener,noreferrer");
    /* Record impression as "completed" since they clicked */
    if (current.adId) {
      fetch(`/api/ads/${current.adId}/impression`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId: 0, completed: true }),
      }).catch(() => {});
    }
  }, [slide, slides]);

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-background pb-20">
      {/* Banner carousel — now shows real ads when available */}
      <div className="relative w-full aspect-[16/9] overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={slide}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.35, ease: "easeInOut" }}
            className="absolute inset-0"
          >
            {slides[slide].image ? (
              <>
                <img
                  src={slides[slide].image ?? undefined}
                  alt={slides[slide].title}
                  className="absolute inset-0 w-full h-full object-cover"
                  loading="eager"
                />
                <div className="absolute inset-0 bg-black/40" />
              </>
            ) : (
              <div className={cn(
                "absolute inset-0 bg-gradient-to-br flex flex-col justify-end p-5",
                slide % 2 === 0
                  ? "from-emerald-800 via-green-700 to-teal-600"
                  : "from-slate-800 via-blue-900 to-indigo-800"
              )}>
                <div className="absolute inset-0 bg-black/30" />
              </div>
            )}

            <div className="absolute inset-0 flex flex-col justify-end p-5">
              <div className="relative z-10">
                {slides[slide].isAd && (
                  <p className="text-white/70 text-xs font-semibold uppercase tracking-widest mb-1">
                    {t.home.sponsored ?? "Sponsored"}
                  </p>
                )}
                {!slides[slide].isAd && (
                  <p className="text-white/70 text-xs font-semibold uppercase tracking-widest mb-1">
                    {t.home.trendingNow ?? "Trending Now"}
                  </p>
                )}
                <h2 className="text-white text-2xl font-bold leading-tight mb-1">
                  {slides[slide].title}
                </h2>
                <p className="text-white/80 text-sm">{slides[slide].desc}</p>

                {slides[slide].isAd && (
                  <button
                    onClick={handleAdClick}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/20 text-white text-xs font-semibold hover:bg-white/30 active:scale-95 transition-all"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {t.home.learnMore ?? "Learn more"}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Dot indicators */}
        {slides.length > 1 && (
          <div className="absolute bottom-3 start-0 end-0 flex justify-center gap-1.5 z-10">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => goToSlide(i)}
                className={cn(
                  "rounded-full transition-all duration-300",
                  i === slide ? "w-5 h-1.5 bg-white" : "w-1.5 h-1.5 bg-white/40"
                )}
                aria-label={`Slide ${i + 1}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Personalised greeting — now below banner, not a sticky bar */}
      <div className="px-4 pt-5 pb-1">
        <p className="text-foreground/70 text-sm">
          {firstName ? t.home.greeting(firstName) : t.home.guestGreeting}
        </p>
      </div>

      {/* Nearest Fields — real data */}
      <div className="mt-4">
        <div className="flex items-center justify-between px-4 mb-3">
          <h3 className="font-bold text-base">{t.home.nearestFields}</h3>
          <Link href="/fields" className="flex items-center gap-0.5 text-primary text-xs font-semibold">
            {t.home.seeAll ?? "See all"} <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
        <div className="flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-hide snap-x snap-mandatory">
          {fields.length === 0 && (
            <p className="text-muted-foreground text-sm px-2">{t.home.noFields ?? "No fields yet"}</p>
          )}
          {fields.map((field, idx) => (
            <Link
              key={field.id}
              href={`/fields/${field.id}`}
              className="snap-start flex-shrink-0 w-36 rounded-2xl overflow-hidden shadow-sm border border-border bg-card"
            >
              <div
                className={cn(
                  "w-full h-20 bg-gradient-to-br flex items-end p-2",
                  fieldGradients[idx % fieldGradients.length]
                )}
              >
                <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center">
                  <MapPin className="w-4 h-4 text-white" />
                </div>
              </div>
              <div className="p-2.5">
                <p className="font-semibold text-xs leading-tight truncate">{field.name}</p>
                <p className="text-muted-foreground text-[10px] mt-0.5 truncate">{field.location}</p>
                <p className="text-primary text-[10px] font-medium mt-0.5">
                  {t.home.clips(field.clipCount ?? 0)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Trending Clips — real data sorted by likes */}
      <div className="mt-5">
        <div className="flex items-center justify-between px-4 mb-3">
          <h3 className="font-bold text-base">{t.home.trendingClips}</h3>
          <Link href="/watch" className="flex items-center gap-0.5 text-primary text-xs font-semibold">
            {t.home.seeAll ?? "See all"} <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
        <div className="flex flex-col gap-3 px-4">
          {clips.length === 0 && (
            <p className="text-muted-foreground text-sm">{t.home.noClips ?? "No clips yet"}</p>
          )}
          {clips.map((clip, idx) => (
            <Link
              key={clip.id}
              href={`/player/${clip.id}`}
              className="flex gap-3 items-center bg-card rounded-2xl overflow-hidden shadow-sm border border-border"
            >
              <div
                className={cn(
                  "flex-shrink-0 w-24 h-16 bg-gradient-to-br rounded-l-2xl",
                  clipGradients[idx % clipGradients.length]
                )}
              />
              <div className="flex-1 min-w-0 py-2 pe-3">
                <p className="font-semibold text-sm leading-tight truncate">{clip.momentLabel}</p>
                <p className="text-muted-foreground text-xs mt-0.5 truncate">{clip.fieldName ?? clip.court ?? ""}</p>
                <div className="flex items-center gap-1 mt-1">
                  <Heart className="w-3 h-3 text-rose-500" />
                  <span className="text-xs text-muted-foreground">{t.home.likes(clip.likeCount ?? 0)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

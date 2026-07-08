import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, MapPin, Heart, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import {
  useListBanners,
  useListFields,
  useGetFeed,
  getListBannersQueryKey,
  getListFieldsQueryKey,
  getGetFeedQueryKey,
} from "@workspace/api-client-react";

const BANNER_INTERVAL = 5000;

function splitName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type DiscoverItem =
  | { kind: "field"; id: number; name: string; location: string; clipCount: number; courts: number; score: number; distanceKm: number | null }
  | { kind: "clip"; id: number; title: string; thumbnailUrl: string | null; likeCount: number; viewCount: number; score: number };

export default function Home() {
  const { t } = useTranslation();
  const [slide, setSlide] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationState, setLocationState] = useState<"idle" | "granted" | "denied">("idle");

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocationState("granted");
      },
      () => setLocationState("denied"),
      { timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  const { data: bannersData } = useListBanners({
    query: {
      queryKey: getListBannersQueryKey(),
      staleTime: 24 * 60 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
    },
  });
  const banners = bannersData ?? [];

  const { data: fieldsData } = useListFields({
    query: {
      queryKey: getListFieldsQueryKey(),
      staleTime: 10 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
    },
  });
  const fields = fieldsData ?? [];

  const { data: feedData } = useGetFeed({
    query: {
      queryKey: getGetFeedQueryKey(),
      staleTime: 5 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
    },
  });
  const clips = feedData ?? [];

  const discoverItems = useMemo<DiscoverItem[]>(() => {
    const scoredFields: DiscoverItem[] = fields.map((f) => {
      let distanceKm: number | null = null;
      let distanceFactor = 1;
      if (userLocation && f.latitude != null && f.longitude != null) {
        distanceKm = haversineKm(userLocation.lat, userLocation.lng, f.latitude, f.longitude);
        distanceFactor = 1 / (1 + distanceKm * 0.05);
      }
      return {
        kind: "field" as const,
        id: f.id,
        name: f.name,
        location: f.location,
        clipCount: f.clipCount,
        courts: f.courts,
        score: f.weight * distanceFactor,
        distanceKm,
      };
    }).sort((a, b) => b.score - a.score);

    const hoursAgo = (iso: string) =>
      Math.max(0, (Date.now() - new Date(iso).getTime()) / 36e5);

    const scoredClips: DiscoverItem[] = clips.map((c) => {
      const h = hoursAgo(c.createdAt);
      const decay = Math.exp(-h / 168);
      return {
        kind: "clip" as const,
        id: c.id,
        title: c.title,
        thumbnailUrl: c.thumbnailUrl ?? null,
        likeCount: c.likeCount,
        viewCount: c.viewCount,
        score: (c.likeCount * 5 + c.viewCount + c.shareCount * 10) * decay,
      };
    }).sort((a, b) => b.score - a.score);

    const mixed: DiscoverItem[] = [];
    const len = Math.max(scoredFields.length, scoredClips.length);
    for (let i = 0; i < len; i++) {
      if (i < scoredFields.length) mixed.push(scoredFields[i]);
      if (i < scoredClips.length) mixed.push(scoredClips[i]);
    }
    return mixed;
  }, [fields, clips, userLocation]);

  const bannerSlides = banners.map((b) => ({
    id: b.id,
    image: b.imageUrl,
    upperSubtext: b.upperSubtext ?? "",
    title: b.title ?? "",
    lowerSubtext: b.lowerSubtext ?? "",
  }));

  const fallbackSlides = [
    {
      id: "trending",
      image: null,
      upperSubtext: t.home.trendingNow ?? "Trending",
      title: t.home.bannerSlide1Title,
      lowerSubtext: t.home.bannerSlide1Desc,
    },
    {
      id: "local",
      image: null,
      upperSubtext: "",
      title: t.home.bannerSlide2Title,
      lowerSubtext: t.home.bannerSlide2Desc,
    },
  ];

  const slides = bannerSlides.length > 0 ? bannerSlides : fallbackSlides;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (slides.length <= 1) return;
    intervalRef.current = setInterval(() => {
      setSlide((s) => (s + 1) % slides.length);
    }, BANNER_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [slides.length]);

  const goToSlide = useCallback(
    (i: number) => {
      setSlide(i);
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        setSlide((s) => (s + 1) % slides.length);
      }, BANNER_INTERVAL);
    },
    [slides.length]
  );

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-background pb-20">
      {/* Banner carousel */}
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
                  className="absolute inset-0 w-full h-full object-contain bg-black"
                  loading="eager"
                />
                <div className="absolute inset-0 bg-black/40" />
              </>
            ) : (
              <div className="absolute inset-0 field-pattern bg-[#0d1f0d]">
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-900/60 via-green-800/40 to-black/70" />
              </div>
            )}

            <div className="absolute inset-0 flex flex-col justify-end p-5">
              <div className="relative z-10">
                {slides[slide].upperSubtext && (
                  <p className="text-white/70 text-xs font-semibold uppercase tracking-widest mb-1">
                    {slides[slide].upperSubtext}
                  </p>
                )}
                <h2 className="text-white text-2xl font-bold leading-tight mb-1">
                  {slides[slide].title}
                </h2>
                <p className="text-white/80 text-sm">{slides[slide].lowerSubtext}</p>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>

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
              />
            ))}
          </div>
        )}
      </div>

      {/* Discover section */}
      <div className="px-4 pt-5 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground font-bold text-lg">
            {t.home.discover ?? "For You"}
          </h2>
          <div className="flex items-center gap-3">
            {locationState === "idle" && (
              <button
                onClick={requestLocation}
                className="flex items-center gap-1 text-xs text-muted-foreground active:opacity-70"
              >
                <MapPin className="w-3.5 h-3.5" />
                {t.home.enableLocation ?? "Enable location"}
              </button>
            )}
            {locationState === "granted" && (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <MapPin className="w-3.5 h-3.5" />
                {t.home.usingLocation ?? "Near you"}
              </span>
            )}
            <Link
              href="/fields"
              className="flex items-center gap-0.5 text-sm text-primary font-medium active:opacity-70"
            >
              {t.home.seeAll ?? "See all"} <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>

      {discoverItems.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto px-4 pb-4 snap-x snap-mandatory no-scrollbar">
          {discoverItems.map((item, idx) =>
            item.kind === "field" ? (
              <FieldCard key={`field-${item.id}`} item={item} t={t} idx={idx} />
            ) : (
              <ClipCard key={`clip-${item.id}`} item={item} t={t} idx={idx} />
            )
          )}
        </div>
      ) : (
        <div className="px-4 pb-4 text-center py-8">
          <p className="text-muted-foreground text-sm">{t.home.noFields ?? "No content yet"}</p>
        </div>
      )}
    </div>
  );
}

function FieldCard({
  item,
  t,
  idx,
}: {
  item: Extract<DiscoverItem, { kind: "field" }>;
  t: ReturnType<typeof useTranslation>["t"];
  idx: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.04, duration: 0.3 }}
    >
      <Link
        href={`/fields/${item.id}`}
        className="relative shrink-0 snap-start w-44 aspect-[4/5] rounded-2xl overflow-hidden block group"
      >
        <div className="absolute inset-0 field-pattern" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
        <div className="absolute top-2.5 start-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/60 bg-black/30 rounded-full px-2 py-0.5">
            Field
          </span>
        </div>
        <div className="absolute inset-0 flex flex-col justify-end p-3">
          <h3 className="text-white font-bold text-sm leading-snug">
            {splitName(item.name).join(" ")}
          </h3>
          <p className="text-white/50 text-xs mt-0.5 truncate">{item.location}</p>
          <div className="flex items-center gap-2 mt-1.5">
            {item.clipCount > 0 && (
              <span className="text-white/60 text-xs">
                {t.home.clips(item.clipCount)}
              </span>
            )}
            {item.distanceKm != null && (
              <span className="flex items-center gap-0.5 text-emerald-400 text-xs">
                <MapPin className="w-3 h-3" />
                {item.distanceKm < 1
                  ? `${Math.round(item.distanceKm * 1000)} m`
                  : `${item.distanceKm.toFixed(1)} km`}
              </span>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

function ClipCard({
  item,
  t,
  idx,
}: {
  item: Extract<DiscoverItem, { kind: "clip" }>;
  t: ReturnType<typeof useTranslation>["t"];
  idx: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.04, duration: 0.3 }}
    >
      <Link
        href="/watch"
        className="relative shrink-0 snap-start w-36 aspect-[9/16] rounded-2xl overflow-hidden block group"
      >
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt={item.title}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 field-pattern bg-[#0d1f0d]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        <div className="absolute top-2.5 start-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/60 bg-black/30 rounded-full px-2 py-0.5">
            Reel
          </span>
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-active:opacity-100 transition-opacity">
          <div className="w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <Play className="w-4 h-4 text-white fill-white" />
          </div>
        </div>
        <div className="absolute inset-0 flex flex-col justify-end p-2.5">
          <p className="text-white font-semibold text-xs leading-snug line-clamp-2">{item.title}</p>
          {item.likeCount > 0 && (
            <span className="flex items-center gap-1 text-white/60 text-xs mt-1">
              <Heart className="w-3 h-3" />
              {item.likeCount.toLocaleString()}
            </span>
          )}
        </div>
      </Link>
    </motion.div>
  );
}

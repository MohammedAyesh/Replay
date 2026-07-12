import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import {
  useListBanners,
  useGetBunnyCollections,
  getListBannersQueryKey,
} from "@workspace/api-client-react";

const BANNER_INTERVAL = 5000;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type DiscoverItem = { kind: "field"; id: string; name: string; videoCount: number; previewImageUrl: string | null };

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

  const { data: collectionsData } = useGetBunnyCollections();
  const collections = collectionsData ?? [];

  const discoverItems = useMemo<DiscoverItem[]>(() => {
    return collections.slice(0, 6).map((c) => ({
      kind: "field" as const,
      id: c.guid,
      name: c.name,
      videoCount: c.videoCount,
      previewImageUrl: c.previewImageUrl ?? null,
    }));
  }, [collections]);

  const bannerSlides = banners.map((b) => ({
    id: b.id,
    image: b.imageUrl,
    upperSubtext: b.upperSubtext ?? "",
    title: b.title ?? "",
    lowerSubtext: b.lowerSubtext ?? "",
    hyperlink: b.hyperlink ?? null,
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
              <>
                <img
                  src={`${basePath}/brand-hero.jpg`}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover object-center"
                  aria-hidden="true"
                />
                <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/40 to-black/80" />
              </>
            )}

            {(() => {
              const hl = (slides[slide] as { hyperlink?: string | null }).hyperlink;
              const content = (
                <div className="absolute inset-0 flex flex-col justify-end p-5">
                  <div className="relative z-10">
                    {slides[slide].upperSubtext && (
                      <p className="text-primary text-[10px] font-bold uppercase tracking-widest mb-1">
                        {slides[slide].upperSubtext}
                      </p>
                    )}
                    <h2 className="font-display font-black text-white text-3xl leading-none uppercase mb-1">
                      {slides[slide].title}
                    </h2>
                    <p className="text-white/70 text-sm">{slides[slide].lowerSubtext}</p>
                  </div>
                </div>
              );
              return hl ? (
                <a href={hl} target="_blank" rel="noopener noreferrer" className="block absolute inset-0">
                  {content}
                </a>
              ) : content;
            })()}
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
                  i === slide ? "w-5 h-1.5 bg-primary" : "w-1.5 h-1.5 bg-white/30"
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
              <span className="flex items-center gap-1 text-xs text-primary">
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
          {discoverItems.map((item, idx) => (
            <FieldCard key={`field-${item.id}`} item={item} t={t} idx={idx} />
          ))}
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
        {item.previewImageUrl ? (
          <img
            src={item.previewImageUrl}
            alt={item.name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="absolute inset-0 field-pattern" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
        <div className="absolute top-2.5 start-2.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-primary/90 bg-black/40 rounded-full px-2 py-0.5">
            Field
          </span>
        </div>
        <div className="absolute inset-0 flex flex-col justify-end p-3">
          <p className="text-white font-display font-bold text-sm uppercase leading-tight">{item.name}</p>
          {item.videoCount > 0 && (
            <p className="text-white/50 text-xs">
              {t.home.clips(item.videoCount)}
            </p>
          )}
        </div>
      </Link>
    </motion.div>
  );
}

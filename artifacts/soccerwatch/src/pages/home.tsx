import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import {
  useListBanners,
  useListFields,
  getListBannersQueryKey,
  getListFieldsQueryKey,
} from "@workspace/api-client-react";

const BANNER_INTERVAL = 5000;

function splitName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

export default function Home() {
  const { t } = useTranslation();
  const [slide, setSlide] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Banners from Bunny storage */
  const { data: bannersData } = useListBanners({
    query: { queryKey: getListBannersQueryKey() },
  });
  const banners = bannersData ?? [];

  /* Real fields */
  const { data: fieldsData } = useListFields({
    query: { queryKey: getListFieldsQueryKey() },
  });
  const fields = (fieldsData ?? []).slice(0, 4);

  /* Build slides: banners first, then fallback static slides */
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
  }, [slides.length]);

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

      {/* Nearest Fields */}
      <div className="px-4 pt-5 pb-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-foreground font-bold text-lg">{t.home.nearestFields ?? "Nearest Fields"}</h2>
          <Link
            href="/fields"
            className="flex items-center gap-0.5 text-sm text-primary font-medium active:opacity-70"
          >
            See all <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {fields.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto px-4 pb-4 snap-x snap-mandatory no-scrollbar">
          {fields.map((f) => (
            <Link
              key={f.id}
              href={`/fields/${f.id}`}
              className="relative shrink-0 snap-start w-48 aspect-[4/5] rounded-2xl overflow-hidden group"
            >
              <div className="absolute inset-0 field-pattern" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
              <div className="absolute inset-0 flex flex-col justify-end p-3">
                <h3 className="text-white font-bold text-base leading-tight">
                  {splitName(f.name).join(" ")}
                </h3>
                {(f.clipCount ?? 0) > 0 && (
                  <p className="text-white/60 text-xs mt-0.5">
                    {(f.clipCount ?? 0).toLocaleString()} clips
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="px-4 pb-4 text-center">
          <p className="text-muted-foreground text-sm">No fields found</p>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, Heart, MapPin, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/lib/auth";

const BANNER_INTERVAL = 4000;

const bannerSlides = [
  { gradient: "from-emerald-800 via-green-700 to-teal-600" },
  { gradient: "from-slate-800 via-blue-900 to-indigo-800" },
  { gradient: "from-orange-900 via-red-800 to-rose-700" },
];

const nearestFields = [
  { id: 1, name: "Riverside Park", distance: "0.8", clips: 24 },
  { id: 2, name: "Central Arena", distance: "1.4", clips: 57 },
  { id: 3, name: "Eastside Pitch", distance: "2.1", clips: 12 },
  { id: 4, name: "Northfield FC", distance: "3.0", clips: 38 },
];

const trendingClips = [
  { id: 1, title: "Bicycle kick in the 90th", field: "Riverside Park", likes: 312 },
  { id: 2, title: "Last-minute winner", field: "Central Arena", likes: 204 },
  { id: 3, title: "Triple nutmeg assist", field: "Northfield FC", likes: 178 },
];

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
];

export default function Home() {
  const { t } = useTranslation();
  const { user, isGuest } = useAuth();
  const [slide, setSlide] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const firstName = user && !isGuest ? (user.name?.split(" ")[0] ?? user.email?.split("@")[0] ?? "") : "";
  const greeting = firstName ? t.home.greeting(firstName) : t.home.guestGreeting;

  const bannerTitles = [
    t.home.bannerSlide1Title,
    t.home.bannerSlide2Title,
    t.home.bannerSlide3Title,
  ];
  const bannerDescs = [
    t.home.bannerSlide1Desc,
    t.home.bannerSlide2Desc,
    t.home.bannerSlide3Desc,
  ];

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSlide((s) => (s + 1) % bannerSlides.length);
    }, BANNER_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const goToSlide = (i: number) => {
    setSlide(i);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setSlide((s) => (s + 1) % bannerSlides.length);
    }, BANNER_INTERVAL);
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-background pb-20">
      {/* Top bar */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b border-border flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center">
            <Crown className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-base tracking-tight">SOCCERWATCH</span>
        </div>
        <span className="text-sm font-medium text-foreground/80">{greeting}</span>
      </div>

      {/* Banner carousel */}
      <div className="relative w-full aspect-[16/9] overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={slide}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.35, ease: "easeInOut" }}
            className={cn(
              "absolute inset-0 bg-gradient-to-br flex flex-col justify-end p-5",
              bannerSlides[slide].gradient
            )}
          >
            <div className="absolute inset-0 bg-black/30" />
            <div className="relative z-10">
              <p className="text-white/70 text-xs font-semibold uppercase tracking-widest mb-1">
                Trending Now
              </p>
              <h2 className="text-white text-2xl font-bold leading-tight mb-1">
                {bannerTitles[slide]}
              </h2>
              <p className="text-white/80 text-sm">{bannerDescs[slide]}</p>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Dot indicators */}
        <div className="absolute bottom-3 start-0 end-0 flex justify-center gap-1.5 z-10">
          {bannerSlides.map((_, i) => (
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
      </div>

      {/* Nearest Fields */}
      <div className="mt-5">
        <div className="flex items-center justify-between px-4 mb-3">
          <h3 className="font-bold text-base">{t.home.nearestFields}</h3>
          <Link href="/fields" className="flex items-center gap-0.5 text-primary text-xs font-semibold">
            See all <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
        <div className="flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-hide snap-x snap-mandatory">
          {nearestFields.map((field, idx) => (
            <Link
              key={field.id}
              href="/fields"
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
                <p className="text-muted-foreground text-[10px] mt-0.5">
                  {t.home.km(field.distance)}
                </p>
                <p className="text-primary text-[10px] font-medium mt-0.5">
                  {t.home.clips(field.clips)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Trending Clips */}
      <div className="mt-5">
        <div className="flex items-center justify-between px-4 mb-3">
          <h3 className="font-bold text-base">{t.home.trendingClips}</h3>
          <Link href="/watch" className="flex items-center gap-0.5 text-primary text-xs font-semibold">
            See all <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
        <div className="flex flex-col gap-3 px-4">
          {trendingClips.map((clip, idx) => (
            <Link
              key={clip.id}
              href="/watch"
              className="flex gap-3 items-center bg-card rounded-2xl overflow-hidden shadow-sm border border-border"
            >
              <div
                className={cn(
                  "flex-shrink-0 w-24 h-16 bg-gradient-to-br",
                  clipGradients[idx % clipGradients.length]
                )}
              />
              <div className="flex-1 min-w-0 py-2 pe-3">
                <p className="font-semibold text-sm leading-tight truncate">{clip.title}</p>
                <p className="text-muted-foreground text-xs mt-0.5 truncate">{clip.field}</p>
                <div className="flex items-center gap-1 mt-1">
                  <Heart className="w-3 h-3 text-rose-500" />
                  <span className="text-xs text-muted-foreground">{t.home.likes(clip.likes)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Watch Feed CTA */}
      <div className="px-4 mt-6 mb-2">
        <Button asChild className="w-full rounded-2xl py-6 text-base font-semibold bg-primary hover:bg-primary/90 text-white">
          <Link href="/watch">{t.home.jumpBackIn}</Link>
        </Button>
      </div>
    </div>
  );
}

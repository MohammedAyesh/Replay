import { useLocation } from "wouter";
import {
  useLoginAsGuest,
  listBanners,
  getBunnyCollections,
  getListBannersQueryKey,
  getGetBunnyCollectionsQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Globe, Video, Scissors, Radio, MapPin, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import { useEffect } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Logo geometry (identical to layout.tsx) ──────────────────────────────────
function hexPoints(cx: number, cy: number, size: number) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 30);
    return `${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`;
  }).join(" ");
}

function LogoMark({ size = 34 }: { size?: number }) {
  const facets = [
    { cx: 95, cy: 96, color: "#22C7B5" },
    { cx: 126.2, cy: 42, color: "#BFFF5C" },
    { cx: 63.8, cy: 42, color: "#3FE0C9" },
    { cx: 157.4, cy: 96, color: "#1FA79B" },
    { cx: 32.6, cy: 96, color: "#186E7E" },
    { cx: 126.2, cy: 150, color: "#1C8AA0" },
    { cx: 63.8, cy: 150, color: "#6C4FE0" },
  ];

  return (
    <span className="block shrink-0" style={{ width: size, height: size * (200 / 220) }}>
      <svg viewBox="-5 0 225 200" width="100%" height="100%" aria-hidden="true">
        <defs>
          <clipPath id="login-logo-ball-clip">
            <circle cx="95" cy="96" r="88" />
          </clipPath>
        </defs>
        <g clipPath="url(#login-logo-ball-clip)">
          {facets.map((facet) => (
            <polygon
              key={`${facet.cx}-${facet.cy}`}
              points={hexPoints(facet.cx, facet.cy, 36)}
              fill={facet.color}
              stroke="#0B0F1A"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          ))}
        </g>
        <circle cx="95" cy="96" r="88" fill="none" stroke="#0B0F1A" strokeWidth="3" opacity="0.35" />
        <polygon
          points="170,62 170,134 210,98"
          fill="#0B0F1A"
          stroke="#0B0F1A"
          strokeWidth="16"
          strokeLinejoin="round"
        />
        <polygon
          points="172,68 172,128 206,98"
          fill="#D4FF4F"
          stroke="#D4FF4F"
          strokeWidth="12"
          strokeLinejoin="round"
        />
        <circle cx="178" cy="46" r="7.5" fill="#0B0F1A" />
        <circle cx="178" cy="46" r="5.5" fill="#FF5A3C" />
      </svg>
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { t, locale, setLocale } = useTranslation();
  const guestMutation = useLoginAsGuest();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  const { isSignedIn, isLoaded } = useUser();
  const shouldReduceMotion = useReducedMotion();

  // Existing: redirect already-authenticated users straight to /home
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      setLocation("/home");
    }
  }, [isLoaded, isSignedIn, setLocation]);

  // Existing: prefetch home data before guest navigation
  const preloadHomeData = () => {
    queryClient.prefetchQuery({
      queryKey: getListBannersQueryKey(),
      queryFn: () => listBanners(),
      staleTime: 0,
    });
    queryClient.prefetchQuery({
      queryKey: getGetBunnyCollectionsQueryKey(),
      queryFn: () => getBunnyCollections(),
      staleTime: 5 * 60 * 1000,
    });
  };

  // Existing guest handler — unchanged
  const handleGuest = async () => {
    await signOut().catch(() => {});
    queryClient.clear();
    preloadHomeData();
    guestMutation.mutate(undefined, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetMeQueryKey(), data.user);
        setLocation("/home");
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: t.login.guestLoginFailed,
          description: t.login.guestLoginError,
        });
      },
    });
  };

  const ar = locale === "ar";

  // Animation helpers — no movement when prefers-reduced-motion is set
  const fadeUp = (delay = 0) =>
    shouldReduceMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15, delay: 0 } }
      : {
          initial: { opacity: 0, y: 28 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.5, delay, ease: "easeOut" as const },
        };

  const sectionReveal = (delay = 0) =>
    shouldReduceMotion
      ? { initial: { opacity: 0 }, whileInView: { opacity: 1 }, viewport: { once: true }, transition: { duration: 0.15 } }
      : {
          initial: { opacity: 0, y: 32 },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true },
          transition: { duration: 0.5, delay, ease: "easeOut" as const },
        };

  // ── Feature cards ──────────────────────────────────────────────────────────
  const features = [
    {
      icon: <Video className="w-5 h-5 text-primary" />,
      title: ar ? "كل مباراة مسجّلة" : "Every match recorded",
      body: ar ? "الكاميرات تعمل طوال المساء. لا شيء تجهّزه." : "Cameras run all evening. Nothing to set up.",
    },
    {
      icon: <Scissors className="w-5 h-5 text-primary" />,
      title: ar ? "اقتطع مقاطعك" : "Cut your own clips",
      body: ar ? "اقتطع، حرّك، قرّب، حمّل وشارك." : "Trim, pan, zoom, download and share.",
    },
    {
      icon: <Radio className="w-5 h-5 text-primary" />,
      title: ar ? "شاهد مباشرة" : "Watch live",
      body: ar ? "الأهل يشاهدون من أي مكان، ويبقى محفوظاً." : "Family watch from anywhere, kept afterwards.",
    },
    {
      icon: <MapPin className="w-5 h-5 text-primary" />,
      title: ar ? "ننتشر في عمّان" : "Growing across Amman",
      body: ar ? "ملاعب شريكة جديدة كل شهر." : "New partner pitches every month.",
    },
  ];

  // TODO: placeholder testimonials — replace with real quotes before public launch
  const reviews = [
    {
      quote: ar ? "وجدت هدفي قبل أن أصل إلى السيارة." : "I found my goal before I got to the car.",
      name: ar ? "عمر" : "Omar",
      role: ar ? "لاعب" : "player",
    },
    {
      quote: ar ? "أهلي شاهدوا المباراة من مدينة أخرى." : "My parents watched the match from another city.",
      name: ar ? "رامي" : "Rami",
      role: ar ? "لاعب" : "player",
    },
    {
      quote: ar ? "المقاطع تصل إلى مجموعة الأصدقاء كل أسبوع." : "The clips end up in the group chat every week.",
      name: ar ? "يوسف" : "Yousef",
      role: ar ? "لاعب" : "player",
    },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

      {/* Language selector — sits above the scroll layer */}
      <div className="absolute top-safe end-4 z-30">
        <button
          onClick={() => setLocale(locale === "en" ? "ar" : "en")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white/10 backdrop-blur-md text-white/80 hover:text-white hover:bg-white/20 transition-colors text-xs font-semibold"
        >
          <Globe className="w-3.5 h-3.5" />
          {locale === "en" ? "EN" : "عربي"}
        </button>
      </div>

      {/* ── Scrolling container ──────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">

        {/* ── 1. HERO ───────────────────────────────────────────── */}
        <section className="relative flex flex-col min-h-[100dvh] rp-glow">
          {/* Background image */}
          <img
            src={`${basePath}/auth-hero.png`}
            alt=""
            className="absolute inset-0 w-full h-full object-cover object-center"
            aria-hidden="true"
          />
          {/* Dark gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-black/85" />

          <div className="relative z-10 flex flex-col flex-1 justify-between px-6 pb-10 pt-16">
            {/* Logo row */}
            <motion.div {...fadeUp(0)} className="flex items-center gap-2">
              <LogoMark size={36} />
              <span
                className="font-display font-bold text-2xl tracking-tight uppercase"
                style={{
                  background: "linear-gradient(90deg, #2FD8C4, #7B5CFF)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                REPLAY
              </span>
            </motion.div>

            {/* Headline + subtitle + buttons */}
            <div>
              <motion.h1
                {...fadeUp(0.12)}
                className="font-display font-black text-5xl leading-[0.95] mb-4 uppercase tracking-tight text-white"
              >
                {ar ? "كل مباراة." : "EVERY GAME."}<br />
                <span className="text-primary">{ar ? "كل زاوية." : "EVERY ANGLE."}</span>
              </motion.h1>

              <motion.p {...fadeUp(0.2)} className="text-base text-white/75 leading-snug mb-8">
                {t.login.description}
              </motion.p>

              <motion.div {...fadeUp(0.28)} className="space-y-3">
                <Button
                  asChild
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold py-6 rounded-xl text-base uppercase tracking-wide"
                >
                  <a href={`${basePath}/sign-in`}>{t.login.signIn}</a>
                </Button>

                <Button
                  asChild
                  variant="outline"
                  className="w-full font-semibold py-6 rounded-xl text-base bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
                >
                  <a href={`${basePath}/sign-up`}>{t.login.createAccount}</a>
                </Button>

                <div className="flex justify-center py-1">
                  <span className="text-white/40 text-xs uppercase">{t.login.or}</span>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-white/60 hover:text-white hover:bg-white/10 font-medium py-4 rounded-xl"
                  onClick={handleGuest}
                  disabled={guestMutation.isPending}
                >
                  {guestMutation.isPending ? t.login.startingGuest : t.login.browseAsGuest}
                </Button>
              </motion.div>
            </div>

            {/* Scroll cue */}
            <motion.div
              animate={shouldReduceMotion ? {} : { y: [0, 6, 0] }}
              transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
              className="flex justify-center mt-6"
              aria-hidden="true"
            >
              <ChevronDown className="w-5 h-5 text-white/40" />
            </motion.div>
          </div>
        </section>

        {/* ── 2. FEATURES ───────────────────────────────────────── */}
        <section className="bg-background px-5 py-12">
          <motion.h2
            {...sectionReveal(0)}
            className="font-display font-bold text-2xl text-foreground mb-6"
          >
            {ar ? "لماذا ريبلاي" : "Why Replay"}
          </motion.h2>
          <div className="flex flex-col gap-3">
            {features.map((f, i) => (
              <motion.div
                key={i}
                {...sectionReveal(i * 0.07)}
                className="rounded-[22px] border border-border bg-card p-4 flex items-start gap-3"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
                  {f.icon}
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{f.title}</p>
                  <p className="text-[13px] text-muted-foreground leading-snug mt-0.5">{f.body}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </section>

        {/* ── 3. REVIEWS ────────────────────────────────────────── */}
        <section className="bg-background px-5 pb-12">
          <motion.h2
            {...sectionReveal(0)}
            className="font-display font-bold text-2xl text-foreground mb-6"
          >
            {ar ? "آراء اللاعبين" : "What players say"}
          </motion.h2>
          <div className="flex flex-col gap-3">
            {reviews.map((r, i) => (
              <motion.div
                key={i}
                {...sectionReveal(i * 0.07)}
                className="rounded-[22px] border border-border bg-card p-5"
              >
                <p className="text-[14px] text-foreground leading-relaxed mb-3">"{r.quote}"</p>
                <p className="text-[12px] text-muted-foreground font-semibold">
                  {r.name} · {r.role}
                </p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* ── 4. ABOUT ──────────────────────────────────────────── */}
        <section className="bg-background px-5 pb-12">
          <motion.h2
            {...sectionReveal(0)}
            className="font-display font-bold text-2xl text-foreground mb-4"
          >
            {ar ? "من نحن" : "About us"}
          </motion.h2>
          <motion.div {...sectionReveal(0.06)} className="space-y-3">
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              {ar
                ? "ريبلاي أول منصة في الأردن تسجّل كل مباراة في الملاعب الشريكة وتضع التسجيل مباشرة بين يدي اللاعبين."
                : "Replay is the first platform in Jordan to record every match at partner pitches and put the footage straight into players' hands."}
            </p>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              {ar
                ? "بدأنا بملعب واحد في عمّان. الكاميرات تغطي الملعب بالكامل، والتسجيل يعمل طوال المساء، وكل ساعة جاهزة للمشاهدة بعد دقائق من صافرة النهاية."
                : "We started with one field in Amman. Cameras cover the full pitch, recording runs all evening, and every hour is ready to watch minutes after the final whistle."}
            </p>
          </motion.div>
        </section>

        {/* ── 5. CONTACT ────────────────────────────────────────── */}
        <section className="bg-background px-5 pb-16">
          <motion.h2
            {...sectionReveal(0)}
            className="font-display font-bold text-2xl text-foreground mb-3"
          >
            {ar ? "تواصل معنا" : "Contact us"}
          </motion.h2>
          <motion.p {...sectionReveal(0.06)} className="text-[14px] text-muted-foreground leading-relaxed mb-5">
            {ar
              ? "هل لديك ملعب أو أكاديمية؟ تواصل معنا لتنضم إلى الشبكة."
              : "Have a pitch or academy? Reach out to join the network."}
          </motion.p>
          <motion.div {...sectionReveal(0.1)}>
            {/* Non-functional by design — no href, no onClick, no handler */}
            <Button type="button" variant="outline" className="rounded-xl font-semibold px-6 py-5">
              {ar ? "تواصل معنا" : "Get in touch"}
            </Button>
          </motion.div>
        </section>

      </div>
    </div>
  );
}

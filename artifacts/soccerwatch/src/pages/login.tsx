import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useLoginAsGuest,
  listBanners,
  getBunnyCollections,
  getListBannersQueryKey,
  getGetBunnyCollectionsQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import heroImage from "@/assets/hero-floodlit-pitch.png";

// ─── bilingual copy ────────────────────────────────────────────────────────────

const COPY = {
  en: {
    langShort: "EN",
    signIn: "Sign In",
    createAccount: "Create Account",
    browseGuest: "Browse as Guest",
    or: "or",
    heroLine1: "No need to tell the story.",
    heroLine2: "We already filmed it.",
    heroSub:
      "Minutes after the final whistle, it's in the app — ready to watch, clip and share.",
    eyebrowHow: "HOW IT WORKS",
    howTitle: "From kickoff to highlight reel",
    stepLabel: "Step",
    steps: [
      {
        title: "Play",
        iconPath: "M8 5.2v13.6L19 12 8 5.2Z",
        bullets: [
          "Book a partner pitch and play your match.",
          "Cameras are already mounted and recording.",
          "Nothing to set up, nothing to press.",
        ],
      },
      {
        title: "Watch",
        iconPath: "M3.2 5h17.6v16H3.2V5Zm4.8-2v4M16 3v4M3.2 10.5h17.6",
        bullets: [
          "Open the app and pick your pitch and date.",
          "Every recorded hour is ready minutes after the final whistle.",
          "Academy sessions also stream live for family watching from anywhere.",
        ],
      },
      {
        title: "Clip & Share",
        iconPath:
          "M7.2 8.4a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Zm0 12.4a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2ZM9 9.8 19.6 20M19.6 3.4 9 14",
        bullets: [
          "Scrub to the moment that matters.",
          "Trim, pan and zoom right on your phone.",
          "Download the clip or share it instantly.",
        ],
      },
    ],
    eyebrowAbout: "ABOUT US",
    aboutTitle: "The first of its kind in Jordan",
    firstBadge: "First in Jordan",
    aboutP1:
      "Replay is the first platform in Jordan to bring automatic full-match recording to the pitch — every session captured start to finish, with the footage placed directly in players' hands.",
    aboutP2:
      "It started with a single field in Amman. New pitches and academies are joining the network every month.",
    eyebrowContact: "TALK TO US",
    contactTitle: "Got a pitch or academy in mind?",
    contactSub:
      "We're always looking for new partner pitches and academies across Amman.",
    getInTouch: "Get in touch",
    faqTitle: "FAQ",
    faqs: [
      {
        q: "Do I need to set anything up?",
        a: "No — cameras are already installed and always recording at partner pitches.",
      },
      {
        q: "How soon can I watch after the match?",
        a: "Minutes after the final whistle.",
      },
      {
        q: "Can I download my clips?",
        a: "Yes — trim the moment you want and download it as a normal video file.",
      },
      {
        q: "Can my family watch live?",
        a: "Academy sessions stream live right in the app.",
      },
      {
        q: "Which pitches are covered?",
        a: "Partner pitches across Amman, with new ones joining every month.",
      },
    ],
    footerDesc:
      "Automatic match recording for football pitches and academies across Amman.",
    footerCity: "Amman, Jordan",
  },
  ar: {
    langShort: "ع",
    signIn: "تسجيل الدخول",
    createAccount: "إنشاء حساب",
    browseGuest: "تصفح كزائر",
    or: "أو",
    heroLine1: "مش لازم تحكي عنها",
    heroLine2: "إحنا صورناها.",
    heroSub:
      "دقائق بعد صافرة النهاية، تكون في التطبيق — جاهزة للمشاهدة والقص والمشاركة.",
    eyebrowHow: "كيف تعمل",
    howTitle: "من الانطلاقة حتى أفضل اللقطات",
    stepLabel: "الخطوة",
    steps: [
      {
        title: "العب",
        iconPath: "M8 5.2v13.6L19 12 8 5.2Z",
        bullets: [
          "احجز ملعبًا شريكًا واستمتع بمباراتك.",
          "الكاميرات مثبّتة ومسجّلة مسبقًا.",
          "بلا إعداد وبلا أي ضغط على زر.",
        ],
      },
      {
        title: "شاهد",
        iconPath: "M3.2 5h17.6v16H3.2V5Zm4.8-2v4M16 3v4M3.2 10.5h17.6",
        bullets: [
          "افتح التطبيق واختر ملعبك وتاريخك.",
          "كل ساعة مسجّلة تكون جاهزة دقائق بعد صافرة النهاية.",
          "جلسات الأكاديميات تُبث مباشرة أيضًا لمتابعة العائلة من أي مكان.",
        ],
      },
      {
        title: "قص وشارك",
        iconPath:
          "M7.2 8.4a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Zm0 12.4a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2ZM9 9.8 19.6 20M19.6 3.4 9 14",
        bullets: [
          "انتقل مباشرة إلى اللحظة المهمة.",
          "قصّ وحرّك وقرّب المشهد من هاتفك.",
          "نزّل المقطع أو شاركه فورًا.",
        ],
      },
    ],
    eyebrowAbout: "من نحن",
    aboutTitle: "الأول من نوعه في الأردن",
    firstBadge: "الأول في الأردن",
    aboutP1:
      "Replay هو أول منصة في الأردن تُدخل التسجيل التلقائي الكامل للمباريات إلى الملعب — كل جلسة تُسجَّل من البداية للنهاية، واللقطات تصل مباشرة إلى اللاعبين.",
    aboutP2:
      "بدأت الرحلة بملعب واحد في عمّان، وتنضم ملاعب وأكاديميات جديدة إلى الشبكة كل شهر.",
    eyebrowContact: "تواصل معنا",
    contactTitle: "هل لديك ملعب أو أكاديمية؟",
    contactSub: "نبحث دائمًا عن ملاعب وأكاديميات شريكة جديدة في عمّان.",
    getInTouch: "تواصل معنا",
    faqTitle: "الأسئلة الشائعة",
    faqs: [
      {
        q: "هل أحتاج لإعداد أي شيء؟",
        a: "لا — الكاميرات مثبّتة ومسجّلة دائمًا في الملاعب الشريكة.",
      },
      {
        q: "بعد كم تصبح المباراة جاهزة للمشاهدة؟",
        a: "بعد دقائق من صافرة النهاية.",
      },
      {
        q: "هل يمكنني تنزيل مقاطعي؟",
        a: "نعم — قصّ اللحظة التي تريدها ونزّلها كملف فيديو عادي.",
      },
      {
        q: "هل تستطيع عائلتي المتابعة مباشرة؟",
        a: "جلسات الأكاديميات تُبث مباشرة داخل التطبيق.",
      },
      {
        q: "أي الملاعب مغطاة؟",
        a: "الملاعب الشريكة في عمّان، وينضم إليها ملاعب جديدة كل شهر.",
      },
    ],
    footerDesc: "تسجيل تلقائي للمباريات في ملاعب وأكاديميات عمّان.",
    footerCity: "عمّان، الأردن",
  },
} as const;

const STEP_ACCENTS = [
  { accent: "#D4FF4F", tint: "rgba(212,255,79,.12)", ghost: "rgba(212,255,79,.07)" },
  { accent: "#2FD8C4", tint: "rgba(47,216,196,.13)", ghost: "rgba(47,216,196,.08)" },
  { accent: "#7B5CFF", tint: "rgba(123,92,255,.13)", ghost: "rgba(123,92,255,.08)" },
];

// Convert ASCII digits to Arabic-Indic numerals for RTL step labels
const toArDigits = (s: string) =>
  s.replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

// ─── logo ─────────────────────────────────────────────────────────────────────

function hexPoints(cx: number, cy: number, size: number) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 90);
    return `${(cx + size * Math.cos(a)).toFixed(1)},${(cy + size * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

function LogoMark({ size = 34 }: { size?: number }) {
  const facets = [
    { cx: 95,    cy: 96,  color: "#22C7B5" },
    { cx: 126.2, cy: 42,  color: "#BFFF5C" },
    { cx: 63.8,  cy: 42,  color: "#3FE0C9" },
    { cx: 157.4, cy: 96,  color: "#1FA79B" },
    { cx: 32.6,  cy: 96,  color: "#186E7E" },
    { cx: 126.2, cy: 150, color: "#1C8AA0" },
    { cx: 63.8,  cy: 150, color: "#6C4FE0" },
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
          {facets.map((f) => (
            <polygon
              key={`${f.cx}-${f.cy}`}
              points={hexPoints(f.cx, f.cy, 36)}
              fill={f.color}
              stroke="#0B0F1A"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          ))}
        </g>
        <circle cx="95" cy="96" r="88" fill="none" stroke="#0B0F1A" strokeWidth="3" opacity="0.35" />
        <polygon points="170,62 170,134 210,98" fill="#0B0F1A" stroke="#0B0F1A" strokeWidth="16" strokeLinejoin="round" />
        <polygon points="172,68 172,128 206,98" fill="#D4FF4F" stroke="#D4FF4F" strokeWidth="12" strokeLinejoin="round" />
        <circle cx="178" cy="46" r="7.5" fill="#0B0F1A" />
        <circle cx="178" cy="46" r="5.5" fill="#FF5A3C" />
      </svg>
    </span>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { t, locale, setLocale } = useTranslation();
  const guestMutation = useLoginAsGuest();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  const { isSignedIn, isLoaded } = useUser();
  const [scrolled, setScrolled] = useState(false);
  const [openFaq, setOpenFaq] = useState<number>(0); // first item open by default

  const isRtl = locale === "ar";
  const tc = COPY[isRtl ? "ar" : "en"];
  const bodyFont = isRtl
    ? "'Tajawal','Cairo',system-ui,sans-serif"
    : "'Inter',system-ui,sans-serif";
  const headFont = isRtl
    ? "'Cairo','Rajdhani',sans-serif"
    : "'Rajdhani','Cairo',sans-serif";

  // Redirect already-authenticated users immediately
  useEffect(() => {
    if (isLoaded && isSignedIn) setLocation("/home");
  }, [isLoaded, isSignedIn, setLocation]);

  // Scroll cue — fades once the user has scrolled past the hero
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 160);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  // ─── handlers (preserved exactly) ──────────────────────────────────────────

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

  // ─── render ─────────────────────────────────────────────────────────────────

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      style={{
        minHeight: "100vh",
        background: "#0B0F1A",
        color: "#F3F6FA",
        fontFamily: bodyFont,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div style={{ maxWidth: 440, margin: "0 auto", position: "relative" }}>

        {/* ── STICKY HEADER ───────────────────────────────────────────────── */}
        <header
          style={{
            position: "sticky",
            top: 10,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            gap: 12,
            margin: "0 14px",
            padding: "11px 16px",
            borderRadius: 20,
            background: "rgba(10,11,13,.6)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            boxShadow: "0 8px 24px rgba(0,0,0,.28), inset 0 0 0 1px rgba(255,255,255,.09)",
          }}
        >
          <LogoMark size={30} />
          <span
            style={{
              flex: 1,
              fontFamily: headFont,
              fontWeight: 700,
              fontSize: 19,
              letterSpacing: "-0.015em",
              backgroundImage: "linear-gradient(90deg,#2FD8C4,#7B5CFF)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            REPLAY
          </span>
          <button
            onClick={() => setLocale(isRtl ? "en" : "ar")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 13px",
              borderRadius: 99,
              border: 0,
              background: "rgba(255,255,255,.09)",
              color: "#F3F6FA",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.03em",
              cursor: "pointer",
              fontFamily: bodyFont,
            }}
          >
            {/* Globe icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3.2 12h17.6" />
              <path d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z" />
            </svg>
            {tc.langShort}
          </button>
        </header>

        {/* ── HERO ────────────────────────────────────────────────────────── */}
        <section
          style={{
            position: "relative",
            minHeight: "100vh",
            marginTop: -64,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            overflow: "hidden",
          }}
        >
          {/* Background image */}
          <motion.img
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1.35, ease: [0.22, 1, 0.36, 1] }}
            src={heroImage}
            alt=""
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center 38%",
            }}
          />
          {/* Soft navy vignette */}
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(ellipse 110% 88% at 50% 44%,rgba(11,15,26,0) 0%,rgba(11,15,26,.05) 34%,rgba(11,15,26,.22) 70%,rgba(11,15,26,.84) 100%),linear-gradient(180deg,rgba(11,15,26,.38) 0%,rgba(11,15,26,.12) 35%,rgba(11,15,26,.24) 68%,rgba(11,15,26,.94) 100%)",
            }}
          />

          {/* Hero content */}
          <div style={{ position: "relative", padding: "0 22px 30px" }}>
            <motion.h1
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.1, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
              style={{
                margin: 0,
                fontFamily: headFont,
                fontWeight: 700,
                fontSize: 42,
                lineHeight: 1,
                letterSpacing: "-0.02em",
              }}
            >
              <span style={{ display: "block", color: "#F3F6FA" }}>{tc.heroLine1}</span>
              <span style={{ display: "block", color: "#D4FF4F" }}>{tc.heroLine2}</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.05, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
              style={{
                margin: "14px 0 0",
                fontSize: 15,
                lineHeight: 1.55,
                fontWeight: 500,
                color: "rgba(243,246,250,.8)",
                fontFamily: bodyFont,
                maxWidth: 330,
              }}
            >
              {tc.heroSub}
            </motion.p>

            {/* Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.42, ease: [0.22, 1, 0.36, 1] }}
              style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}
            >
              {/* Sign In — lime bg, DARK text */}
              <Link
                href="/sign-in"
                style={{
                  display: "block",
                  width: "100%",
                  padding: "16px",
                  borderRadius: 16,
                  border: 0,
                  background: "#D4FF4F",
                  color: "#0B0F1A",
                  fontSize: 15.5,
                  fontWeight: 800,
                  letterSpacing: "0.01em",
                  cursor: "pointer",
                  fontFamily: bodyFont,
                  textAlign: "center",
                  textDecoration: "none",
                  boxSizing: "border-box",
                }}
              >
                {tc.signIn}
              </Link>

              {/* Create Account — bordered translucent */}
              <Link
                href="/sign-up"
                style={{
                  display: "block",
                  width: "100%",
                  padding: "16px",
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,.16)",
                  background: "rgba(255,255,255,.06)",
                  color: "#F3F6FA",
                  fontSize: 15.5,
                  fontWeight: 800,
                  letterSpacing: "0.01em",
                  cursor: "pointer",
                  fontFamily: bodyFont,
                  textAlign: "center",
                  textDecoration: "none",
                  boxSizing: "border-box",
                }}
              >
                {tc.createAccount}
              </Link>

              {/* "or" divider */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 0" }}>
                <span style={{ height: 1, flex: 1, background: "rgba(255,255,255,.12)" }} />
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "rgba(243,246,250,.45)",
                    fontFamily: bodyFont,
                  }}
                >
                  {tc.or}
                </span>
                <span style={{ height: 1, flex: 1, background: "rgba(255,255,255,.12)" }} />
              </div>

              {/* Browse as Guest — muted text link */}
              <button
                type="button"
                onClick={handleGuest}
                disabled={guestMutation.isPending}
                style={{
                  alignSelf: "center",
                  padding: "6px",
                  border: 0,
                  background: "transparent",
                  color: "rgba(243,246,250,.72)",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: guestMutation.isPending ? "default" : "pointer",
                  fontFamily: bodyFont,
                  opacity: guestMutation.isPending ? 0.6 : 1,
                }}
              >
                {guestMutation.isPending ? t.login.startingGuest : tc.browseGuest}
              </button>
            </motion.div>

            {/* Scroll cue — bouncing chevron */}
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginTop: 22,
                opacity: scrolled ? 0 : 1,
                transition: "opacity 0.35s ease",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(243,246,250,.45)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ animation: "lpBounce 1.8s ease-in-out infinite" }}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>
        </section>

        {/* Bounce keyframes injected once */}
        <style>{`
          @keyframes lpBounce {
            0%,100% { transform: translateY(0); }
            50%      { transform: translateY(6px); }
          }
        `}</style>

        {/* ── MAIN CONTENT ─────────────────────────────────────────────── */}
        <main style={{ padding: "0 20px 40px", display: "flex", flexDirection: "column" }}>

          {/* ── HOW IT WORKS ──────────────────────────────────────────── */}
          <section style={{ marginTop: 52 }}>
            {/* Lime eyebrow pill */}
            <span
              style={{
                display: "inline-flex",
                padding: "5px 11px",
                borderRadius: 99,
                background: "rgba(212,255,79,.1)",
                border: "1px solid rgba(212,255,79,.24)",
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#D4FF4F",
                fontFamily: bodyFont,
              }}
            >
              {tc.eyebrowHow}
            </span>
            <h2
              style={{
                margin: "14px 0 26px",
                fontFamily: headFont,
                fontWeight: 700,
                fontSize: 27,
                letterSpacing: "-0.015em",
                lineHeight: 1.15,
                color: "#F3F6FA",
              }}
            >
              {tc.howTitle}
            </h2>

            <div style={{ display: "flex", flexDirection: "column", gap: 44 }}>
              {tc.steps.map((step, i) => {
                const { accent, tint, ghost } = STEP_ACCENTS[i];
                const numRaw = String(i + 1).padStart(2, "0");
                const numDisplay = isRtl ? toArDigits(numRaw) : numRaw;
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-60px" }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    style={{ position: "relative" }}
                  >
                    {/* Ghost number behind top-end of card */}
                    <div
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: -30,
                        insetInlineEnd: 2,
                        fontFamily: headFont,
                        fontWeight: 700,
                        fontSize: 118,
                        lineHeight: 1,
                        letterSpacing: "-0.02em",
                        color: ghost,
                        zIndex: 0,
                        pointerEvents: "none",
                        userSelect: "none",
                      }}
                    >
                      {numDisplay}
                    </div>

                    {/* Card */}
                    <div
                      style={{
                        position: "relative",
                        zIndex: 1,
                        padding: 22,
                        borderRadius: 22,
                        background: "#141B2C",
                        border: "1px solid rgba(255,255,255,.08)",
                      }}
                    >
                      {/* Step pill */}
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 10px",
                          borderRadius: 99,
                          background: tint,
                          fontSize: 10.5,
                          fontWeight: 800,
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          color: accent,
                          fontFamily: bodyFont,
                        }}
                      >
                        {/* Use bdi to isolate the numeral from surrounding RTL text */}
                        <bdi>{tc.stepLabel}</bdi>{" "}<bdi>{numDisplay}</bdi>
                      </span>

                      {/* Icon + title */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          marginTop: 14,
                        }}
                      >
                        <span
                          style={{
                            width: 38,
                            height: 38,
                            flexShrink: 0,
                            borderRadius: 11,
                            background: tint,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: accent,
                          }}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d={step.iconPath} />
                          </svg>
                        </span>
                        <p
                          style={{
                            margin: 0,
                            fontFamily: headFont,
                            fontWeight: 700,
                            fontSize: 20,
                            letterSpacing: "-0.01em",
                            color: "#F3F6FA",
                          }}
                        >
                          {step.title}
                        </p>
                      </div>

                      {/* Bullets */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                          marginTop: 14,
                        }}
                      >
                        {step.bullets.map((b, bi) => (
                          <div
                            key={bi}
                            style={{ display: "flex", alignItems: "flex-start", gap: 9 }}
                          >
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke={accent}
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ flexShrink: 0, marginTop: 2 }}
                            >
                              <path d="m5 12.5 4.5 4.5L19 7" />
                            </svg>
                            <p
                              style={{
                                margin: 0,
                                fontSize: 13.5,
                                lineHeight: 1.5,
                                color: "rgba(243,246,250,.68)",
                                fontFamily: bodyFont,
                              }}
                            >
                              {b}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </section>

          {/* ── ABOUT US ──────────────────────────────────────────────── */}
          <motion.section
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{ marginTop: 56 }}
          >
            {/* Violet eyebrow pill */}
            <span
              style={{
                display: "inline-flex",
                padding: "5px 11px",
                borderRadius: 99,
                background: "rgba(123,92,255,.12)",
                border: "1px solid rgba(123,92,255,.28)",
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#7B5CFF",
                fontFamily: bodyFont,
              }}
            >
              {tc.eyebrowAbout}
            </span>
            <h2
              style={{
                margin: "14px 0 6px",
                fontFamily: headFont,
                fontWeight: 700,
                fontSize: 27,
                letterSpacing: "-0.015em",
                lineHeight: 1.15,
                color: "#F3F6FA",
              }}
            >
              {tc.aboutTitle}
            </h2>

            {/* "First in Jordan" badge */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                margin: "10px 0 16px",
                padding: "6px 12px",
                borderRadius: 99,
                background: "rgba(212,255,79,.09)",
                border: "1px solid rgba(212,255,79,.3)",
                boxShadow: "0 0 24px rgba(212,255,79,.1)",
              }}
            >
              {/* Flag icon */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#D4FF4F"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 3v18" />
                <path d="M5 4h13l-3 4 3 4H5" />
              </svg>
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                  color: "#D4FF4F",
                  fontFamily: bodyFont,
                }}
              >
                {tc.firstBadge}
              </span>
            </div>

            <p
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: 1.65,
                color: "rgba(243,246,250,.72)",
                fontFamily: bodyFont,
              }}
            >
              {tc.aboutP1}
            </p>
            <p
              style={{
                margin: "12px 0 0",
                fontSize: 14,
                lineHeight: 1.65,
                color: "rgba(243,246,250,.72)",
                fontFamily: bodyFont,
              }}
            >
              {tc.aboutP2}
            </p>
          </motion.section>

          {/* ── CONTACT ───────────────────────────────────────────────── */}
          <motion.section
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{ marginTop: 52 }}
          >
            {/* Teal eyebrow pill */}
            <span
              style={{
                display: "inline-flex",
                padding: "5px 11px",
                borderRadius: 99,
                background: "rgba(47,216,196,.12)",
                border: "1px solid rgba(47,216,196,.28)",
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#2FD8C4",
                fontFamily: bodyFont,
              }}
            >
              {tc.eyebrowContact}
            </span>
            <h2
              style={{
                margin: "14px 0 20px",
                fontFamily: headFont,
                fontWeight: 700,
                fontSize: 27,
                letterSpacing: "-0.015em",
                lineHeight: 1.15,
                color: "#F3F6FA",
              }}
            >
              {tc.contactTitle}
            </h2>

            {/* Contact card */}
            <div
              style={{
                padding: 24,
                borderRadius: 22,
                background: "linear-gradient(160deg,rgba(47,216,196,.09),rgba(123,92,255,.06))",
                border: "1px solid rgba(255,255,255,.1)",
                textAlign: "center",
              }}
            >
              {/* Chat icon */}
              <span
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 13,
                  background: "rgba(255,255,255,.06)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                  color: "#F3F6FA",
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 4h16v12H8l-4 4V4Z" />
                </svg>
              </span>
              <p
                style={{
                  margin: 0,
                  fontSize: 14.5,
                  lineHeight: 1.55,
                  color: "rgba(243,246,250,.72)",
                  fontFamily: bodyFont,
                }}
              >
                {tc.contactSub}
              </p>
              {/* Intentionally non-functional — no onClick, no href */}
              <button
                type="button"
                style={{
                  width: "100%",
                  marginTop: 18,
                  padding: 15,
                  borderRadius: 14,
                  border: 0,
                  background: "#D4FF4F",
                  color: "#0B0F1A",
                  fontSize: 14.5,
                  fontWeight: 800,
                  cursor: "default",
                  fontFamily: bodyFont,
                  boxShadow: "0 10px 30px rgba(212,255,79,.18)",
                }}
              >
                {tc.getInTouch}
              </button>
            </div>
          </motion.section>

          {/* ── FAQ ───────────────────────────────────────────────────── */}
          <motion.section
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{ marginTop: 52 }}
          >
            <h2
              style={{
                margin: "0 0 18px",
                fontFamily: headFont,
                fontWeight: 700,
                fontSize: 27,
                letterSpacing: "-0.015em",
                color: "#F3F6FA",
              }}
            >
              {tc.faqTitle}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {tc.faqs.map((faq, i) => {
                const isOpen = openFaq === i;
                return (
                  <div
                    key={i}
                    style={{
                      border: "1px solid rgba(255,255,255,.08)",
                      background: "#141B2C",
                      borderRadius: 16,
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? -1 : i)}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        gap: 12,
                        padding: 16,
                        border: 0,
                        background: "transparent",
                        color: "#F3F6FA",
                        textAlign: "start",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          fontSize: 14,
                          fontWeight: 700,
                          fontFamily: bodyFont,
                          textAlign: isRtl ? "right" : "left",
                        }}
                      >
                        {faq.q}
                      </span>
                      <span
                        style={{
                          flexShrink: 0,
                          width: 26,
                          height: 26,
                          borderRadius: 99,
                          background: "rgba(255,255,255,.07)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#F3F6FA",
                        }}
                      >
                        {isOpen ? (
                          /* minus */
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
                            <path d="M5 12h14" />
                          </svg>
                        ) : (
                          /* plus */
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                        )}
                      </span>
                    </button>
                    {isOpen && (
                      <div style={{ padding: "0 16px 16px" }}>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 13.5,
                            lineHeight: 1.6,
                            color: "rgba(243,246,250,.65)",
                            fontFamily: bodyFont,
                          }}
                        >
                          {faq.a}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.section>

          {/* ── FOOTER ────────────────────────────────────────────────── */}
          <footer
            style={{
              marginTop: 56,
              paddingTop: 32,
              borderTop: "1px solid rgba(255,255,255,.08)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              textAlign: "center",
            }}
          >
            {/* Small logo + wordmark */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 20, height: 18 }}>
                <svg viewBox="-5 0 225 200" width="100%" height="100%" aria-hidden="true">
                  <clipPath id="ft-clip">
                    <circle cx="95" cy="96" r="88" />
                  </clipPath>
                  <g clipPath="url(#ft-clip)">
                    <polygon points={hexPoints(95, 96, 36)}    fill="#22C7B5" />
                    <polygon points={hexPoints(126.2, 42, 36)} fill="#BFFF5C" />
                    <polygon points={hexPoints(63.8, 42, 36)}  fill="#3FE0C9" />
                    <polygon points={hexPoints(157.4, 96, 36)} fill="#1FA79B" />
                    <polygon points={hexPoints(32.6, 96, 36)}  fill="#186E7E" />
                    <polygon points={hexPoints(126.2, 150, 36)} fill="#1C8AA0" />
                    <polygon points={hexPoints(63.8, 150, 36)} fill="#6C4FE0" />
                  </g>
                  <polygon points="170,62 170,134 210,98" fill="#0B0F1A" />
                  <polygon points="172,68 172,128 206,98" fill="#D4FF4F" />
                  <circle cx="178" cy="46" r="7.5" fill="#0B0F1A" />
                  <circle cx="178" cy="46" r="5.5" fill="#FF5A3C" />
                </svg>
              </div>
              <span
                style={{
                  fontFamily: headFont,
                  fontWeight: 700,
                  fontSize: 15,
                  letterSpacing: "-0.01em",
                  backgroundImage: "linear-gradient(90deg,#2FD8C4,#7B5CFF)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                REPLAY
              </span>
            </div>

            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "rgba(243,246,250,.45)",
                fontFamily: bodyFont,
                maxWidth: 280,
              }}
            >
              {tc.footerDesc}
            </p>

            {/* Sign In / Create Account links */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 4 }}>
              <a
                href={`${basePath}/sign-in`}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "rgba(243,246,250,.6)",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: bodyFont,
                  textDecoration: "none",
                }}
              >
                {tc.signIn}
              </a>
              <span
                style={{
                  width: 3,
                  height: 3,
                  borderRadius: 99,
                  background: "rgba(243,246,250,.3)",
                  flexShrink: 0,
                }}
              />
              <a
                href={`${basePath}/sign-up`}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "rgba(243,246,250,.6)",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: bodyFont,
                  textDecoration: "none",
                }}
              >
                {tc.createAccount}
              </a>
            </div>

            <p
              style={{
                margin: "6px 0 0",
                fontSize: 11,
                fontWeight: 600,
                color: "rgba(243,246,250,.28)",
                fontFamily: bodyFont,
              }}
            >
              {tc.footerCity}
            </p>
          </footer>

        </main>
      </div>
    </div>
  );
}

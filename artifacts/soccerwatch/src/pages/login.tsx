import { useEffect, useRef, useState } from "react";
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
import { useReducedMotion } from "framer-motion";
import { useTranslation } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import heroImage from "@/assets/hero-floodlit-pitch.png";
import playersImage from "@/assets/clips-editing.png";
import ownersImage from "@/assets/fields-amman.png";
import familyImage from "@/assets/academies-watching.png";
import { useSupportContact, supportMailto } from "@/lib/client-settings";
import { useLegalCopy } from "@/i18n/legal-strings";
import { useReport, useShowcase, withBase, type DemoClip } from "@/pages/demo/data";
import { LiveBroadcast } from "@/pages/demo/LiveBroadcast";
import { demoCopy } from "@/pages/demo/copy";
import "@/pages/demo/demo.css";
import "./landing.css";

// ─── copy ─────────────────────────────────────────────────────────────────────
// Every line here is on the page. Arabic is Ammani, per the app's copy rule.

const COPY = {
  en: {
    lang: "ع",
    langLabel: "العربية",
    forOwners: "For pitches",
    signIn: "Sign in",
    createAccount: "Create account",
    guest: "Browse as guest",
    hero: ["No need to tell the story.", "We already filmed it."],
    lead: "Clips, stats and a live stream from every match. All automatic.",
    clips: "clips made",
    rebook: "of teams book again",
    pillarsTitle: "One camera. Nothing to press.",
    pillars: [
      { id: "clips", title: "Automatic clips", text: "Cut and branded for you." },
      { id: "stats", title: "Automatic stats", text: "For every team and player." },
      { id: "live", title: "Automated live stream", text: "The camera follows the ball." },
    ],
    cardsTitle: "Made for both sides of the pitch.",
    players: "Players",
    playersText: "Watch, clip and share every match.",
    owners: "Pitches and academies",
    ownersText: "More bookings. No extra work for your staff.",
    seeHow: "See how it works",
    clipsTitle: "Automatic clips.",
    clipsText: "Every goal and chance, cut for you with the pitch's badge on it. Pick yourself once to get yours.",
    statsTitle: "Automatic stats.",
    statsText: "Possession, shots and passes for both teams. Distance and touches for every player. Nothing to wear.",
    possession: "Possession",
    shots: "Shots",
    passes: "Passes",
    goals: "Goals",
    dribbles: "Dribbles won",
    statsNote: (date: string) => `A real match, ${date}. Names hidden.`,
    liveTitle: "Automated live stream.",
    liveText: "The camera follows the ball on its own, with the score and clock on screen. Family watches from anywhere.",
    liveNote: "A recorded match, shown as it streams.",
    ownerTitle: "Run a pitch or an academy?",
    ownerText: "Cameras installed for you. Clips, stats and live run by themselves, with your name on them.",
    whatsapp: "WhatsApp",
    privacy: "Privacy",
    terms: "Terms",
    contact: "Contact",
    city: "Amman, Jordan",
  },
  ar: {
    lang: "EN",
    langLabel: "English",
    forOwners: "لأصحاب الملاعب",
    signIn: "سجّل دخول",
    createAccount: "أنشئ حساب",
    guest: "تصفّح كزائر",
    hero: ["مش لازم تحكي عنها", "إحنا صورناها."],
    lead: "مقاطع وإحصائيات وبث مباشر من كل مباراة. كله أوتوماتيك.",
    clips: "مقطع انعمل",
    rebook: "من الفرق بترجع تحجز",
    pillarsTitle: "كاميرا وحدة. ولا إشي بدك تكبسه.",
    pillars: [
      { id: "clips", title: "مقاطع أوتوماتيك", text: "مقصوصة وعليها شعار الملعب." },
      { id: "stats", title: "إحصائيات أوتوماتيك", text: "لكل فريق ولكل لاعب." },
      { id: "live", title: "بث مباشر أوتوماتيك", text: "الكاميرا بتلحق الطابة." },
    ],
    cardsTitle: "معمول للاعبين وللملاعب.",
    players: "اللاعبين",
    playersText: "شوف، قص، وشارك كل مباراة.",
    owners: "الملاعب والأكاديميات",
    ownersText: "حجوزات أكثر، وبدون أي شغل زيادة على موظفينك.",
    seeHow: "شوف كيف بتشتغل",
    clipsTitle: "مقاطع أوتوماتيك.",
    clipsText: "كل هدف وفرصة بنقصّوا إلك وعليه شعار الملعب. اختار حالك مرة وحدة وبتوصلك لقطاتك.",
    statsTitle: "إحصائيات أوتوماتيك.",
    statsText: "الاستحواذ والتسديدات والتمريرات للفريقين، والمسافة واللمسات لكل لاعب. بدون ما تلبس إشي.",
    possession: "الاستحواذ",
    shots: "التسديدات",
    passes: "التمريرات",
    goals: "الأهداف",
    dribbles: "مراوغات ناجحة",
    statsNote: (date: string) => `مباراة حقيقية، ${date}. الأسماء مخفية.`,
    liveTitle: "بث مباشر أوتوماتيك.",
    liveText: "الكاميرا بتلحق الطابة لحالها، والنتيجة والوقت على الشاشة. الأهل بتابعوا من وين ما كانوا.",
    liveNote: "مباراة مسجّلة، معروضة مثل ما بتنبث.",
    ownerTitle: "عندك ملعب أو أكاديمية؟",
    ownerText: "الكاميرات بنركبها إحنا. المقاطع والإحصائيات والبث بيشتغلوا لحالهم، وعليهم اسمك.",
    whatsapp: "واتساب",
    privacy: "الخصوصية",
    terms: "الشروط",
    contact: "تواصل معنا",
    city: "عمّان، الأردن",
  },
} as const;

const PILLAR_ICONS: Record<string, string> = {
  clips: "M6.5 8.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0 12a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5ZM8.3 7.6 20 19M20 5 8.3 16.4",
  stats: "M4 20V11M10 20V4M16 20v-7M22 20H2",
  live: "M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2",
};

const OWNER_WHATSAPP_TEXT = {
  en: "Hi, I'd like Replay at my pitch.",
  ar: "مرحبا، بدي ريبلاي بملعبي.",
} as const;

// ─── small parts ──────────────────────────────────────────────────────────────

function Chevron() {
  return (
    <svg className="lp-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Brand() {
  return (
    <>
      <img src={`${import.meta.env.BASE_URL}replay-mark.svg`} alt="" aria-hidden="true" />
      <span className="replay-wordmark" aria-label="Replay">
        <span className="replay-wordmark-ar" lang="ar">ريبلاي</span>
        <span className="replay-wordmark-en">REPLAY</span>
      </span>
    </>
  );
}

/**
 * A muted looping clip that plays only while on screen, and never plays when
 * the visitor has asked for reduced motion (the poster stays instead).
 */
function LoopVideo({ clip, fallback, className }: { clip: DemoClip | undefined; fallback: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const video = ref.current;
    if (!video || reduceMotion || !clip) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.25 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [clip, reduceMotion]);

  if (!clip || reduceMotion) {
    return <img className={className} src={clip ? withBase(clip.poster) : fallback} alt="" aria-hidden="true" />;
  }
  return (
    <video
      ref={ref}
      className={className}
      src={withBase(clip.src)}
      poster={withBase(clip.poster)}
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
    />
  );
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── page ─────────────────────────────────────────────────────────────────────

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const legal = useLegalCopy();
  const { t, locale, setLocale } = useTranslation();
  const { supportEmail } = useSupportContact();
  const supportHref = supportMailto(supportEmail);
  const guestMutation = useLoginAsGuest();
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  const { isSignedIn, isLoaded } = useUser();
  const [solidNav, setSolidNav] = useState(false);

  const isRtl = locale === "ar";
  const lang = isRtl ? "ar" : "en";
  const c = COPY[lang];

  const { data: showcase } = useShowcase();
  const { data: reportData } = useReport(Boolean(showcase?.match?.analysed));
  const report = reportData?.report ?? null;
  const team = report?.team ?? null;

  const wideClips = showcase?.clips ?? [];
  const heroClip = wideClips[0];
  const reduceMotion = useReducedMotion();
  const storyClip = (showcase?.socialClips ?? []).find((clip) => clip.aspectRatio === "9:16");
  const clipCount = showcase?.counts.clips ?? null;
  const returnRate = showcase?.returnRatePercent ?? null;
  const salesWhatsapp = showcase?.salesWhatsapp ?? null;
  const whatsappHref = salesWhatsapp
    ? `https://wa.me/${salesWhatsapp}?text=${encodeURIComponent(OWNER_WHATSAPP_TEXT[lang])}`
    : null;

  const numberFormat = new Intl.NumberFormat(isRtl ? "ar-JO-u-nu-latn" : "en-US");
  const formatDate = (iso: string) => {
    const parsed = new Date(`${iso}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return iso;
    return new Intl.DateTimeFormat(isRtl ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(parsed);
  };

  useEffect(() => {
    try {
      if (sessionStorage.getItem("replay_account_deleted") !== "1") return;
      sessionStorage.removeItem("replay_account_deleted");
      toast({
        title: legal.accountDeletion.successTitle,
        description: legal.accountDeletion.successDescription,
      });
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, [legal.accountDeletion.successDescription, legal.accountDeletion.successTitle, toast]);

  // Signed-in visitors go straight to the app.
  useEffect(() => {
    if (isLoaded && isSignedIn) setLocation("/home");
  }, [isLoaded, isSignedIn, setLocation]);

  // The nav turns to glass once the hero starts to scroll away.
  useEffect(() => {
    const onScroll = () => setSolidNav(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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

  // Only rows with something in them: a 0–0 row says nothing.
  const teamRows = team
    ? ([
        [c.goals, team.goals],
        [c.shots, team.shots],
        [c.passes, team.passesCompleted],
        [c.dribbles, team.dribblesWon],
      ] as const).filter(([, pair]) => pair[0] + pair[1] > 0)
    : [];

  return (
    <div className="lp" dir={isRtl ? "rtl" : "ltr"} lang={lang}>
      {/* ── nav ─────────────────────────────────────────────────────────── */}
      <header className="lp-nav" data-solid={solidNav}>
        <nav className="lp-wrap lp-nav-row" aria-label="Replay">
          <a className="lp-brand" href={`${basePath}/`} aria-label="Replay">
            <Brand />
          </a>
          <Link className="lp-nav-link lp-nav-link--wide" href="/demo">{c.forOwners}</Link>
          <button
            type="button"
            className="lp-lang"
            onClick={() => setLocale(isRtl ? "en" : "ar")}
            aria-label={c.langLabel}
            lang={isRtl ? "en" : "ar"}
          >
            {c.lang}
          </button>
          <Link className="lp-btn lp-btn--quiet lp-btn--small" href="/sign-in">{c.signIn}</Link>
        </nav>
      </header>

      <main>
        {/* ── hero ──────────────────────────────────────────────────────── */}
        <section className="lp-hero">
          <LoopVideo clip={heroClip} fallback={heroImage} className="lp-hero-media" />
          <div className="lp-wrap lp-hero-body">
            <h1 className="lp-h1">
              <span>{c.hero[0]}</span>
              <span>{c.hero[1]}</span>
            </h1>
            <p className="lp-lead">{c.lead}</p>
            <div className="lp-actions">
              <Link className="lp-btn lp-btn--primary" href="/sign-up">{c.createAccount}</Link>
              <Link className="lp-btn lp-btn--quiet" href="/sign-in">{c.signIn}</Link>
              <button type="button" className="lp-guest" onClick={handleGuest} disabled={guestMutation.isPending}>
                {guestMutation.isPending ? t.login.startingGuest : c.guest}
              </button>
            </div>
          </div>
        </section>

        {/* ── proof ─────────────────────────────────────────────────────── */}
        {(clipCount || returnRate) && (
          <div className="lp-wrap">
            <dl className="lp-proof">
              {clipCount ? (
                <div>
                  <dt>{c.clips}</dt>
                  <dd>{numberFormat.format(clipCount)}</dd>
                </div>
              ) : null}
              {returnRate ? (
                <div>
                  <dt>{c.rebook}</dt>
                  <dd>{numberFormat.format(returnRate)}%</dd>
                </div>
              ) : null}
            </dl>
          </div>
        )}

        {/* ── what the camera does ──────────────────────────────────────── */}
        <section className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2 lp-center">{c.pillarsTitle}</h2>
            <ul className="lp-pillars">
              {c.pillars.map((pillar) => (
                <li key={pillar.id}>
                  <a className="lp-pillar" href={`#${pillar.id}`}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={PILLAR_ICONS[pillar.id]} />
                    </svg>
                    <h3 className="lp-h3">{pillar.title}</h3>
                    <p className="lp-text">{pillar.text}</p>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── features ──────────────────────────────────────────────────── */}
        <section className="lp-section lp-section--raised">
          <div className="lp-wrap">
            <div className="lp-feature" id="clips">
              <div>
                <h2 className="lp-h2">{c.clipsTitle}</h2>
                <p className="lp-text">{c.clipsText}</p>
              </div>
              {storyClip ? (
                <div className="lp-phone">
                  <div className="lp-media">
                    <LoopVideo clip={storyClip} fallback={playersImage} />
                  </div>
                </div>
              ) : (
                <div className="lp-media">
                  <LoopVideo clip={wideClips[1] ?? wideClips[0]} fallback={playersImage} />
                </div>
              )}
            </div>

            <div className="lp-feature lp-feature--flip" id="stats">
              <div>
                <h2 className="lp-h2">{c.statsTitle}</h2>
                <p className="lp-text">{c.statsText}</p>
              </div>
              {team && report ? (
                <figure className="lp-stats" style={{ margin: 0 }}>
                  <div className="lp-stats-row">
                    <b>{team.possessionPercent[0]}%</b>
                    <span>{c.possession}</span>
                    <b>{team.possessionPercent[1]}%</b>
                  </div>
                  <div className="lp-bar" aria-hidden="true">
                    <i style={{ width: `${team.possessionPercent[0]}%`, background: "var(--replay-floodlight)" }} />
                    <i style={{ width: `${team.possessionPercent[1]}%`, background: "var(--replay-violet)" }} />
                  </div>
                  {teamRows.map(([label, pair]) => (
                    <div className="lp-stats-row" key={label}>
                      <b>{pair[0]}</b>
                      <span>{label}</span>
                      <b>{pair[1]}</b>
                    </div>
                  ))}
                  <figcaption className="lp-stats-note">{c.statsNote(formatDate(report.date))}</figcaption>
                </figure>
              ) : (
                <div className="lp-media">
                  <img src={showcase?.match?.poster ?? heroImage} alt="" aria-hidden="true" />
                </div>
              )}
            </div>

            <div className="lp-feature" id="live">
              <div>
                <h2 className="lp-h2">{c.liveTitle}</h2>
                <p className="lp-text">{c.liveText}</p>
              </div>
              {showcase?.match && report?.broadcast && !reduceMotion ? (
                <figure className="lp-live" style={{ margin: 0 }}>
                  <LiveBroadcast match={showcase.match} report={report} copy={demoCopy[lang].sections.live} />
                  <figcaption className="lp-stats-note">{c.liveNote}</figcaption>
                </figure>
              ) : (
                <div className="lp-media lp-media--plain">
                  <img src={familyImage} alt="" aria-hidden="true" />
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── two audiences ─────────────────────────────────────────────── */}
        <section className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2 lp-center">{c.cardsTitle}</h2>
            <div className="lp-cards">
              <article className="lp-card">
                <img src={playersImage} alt="" aria-hidden="true" />
                <h3 className="lp-h3">{c.players}</h3>
                <p className="lp-text">{c.playersText}</p>
                <Link className="lp-more" href="/sign-up">{c.createAccount} <Chevron /></Link>
              </article>
              <article className="lp-card">
                <img src={ownersImage} alt="" aria-hidden="true" />
                <h3 className="lp-h3">{c.owners}</h3>
                <p className="lp-text">{c.ownersText}</p>
                <Link className="lp-more" href="/demo">{c.seeHow} <Chevron /></Link>
              </article>
            </div>
          </div>
        </section>

        {/* ── owners ────────────────────────────────────────────────────── */}
        <section className="lp-section">
          <div className="lp-wrap">
            <div className="lp-owner lp-center">
              <h2 className="lp-h2">{c.ownerTitle}</h2>
              <p className="lp-text">{c.ownerText}</p>
              <div className="lp-actions">
                <Link className="lp-btn lp-btn--primary" href="/demo">{c.seeHow}</Link>
                {whatsappHref && (
                  <a className="lp-btn lp-btn--quiet" href={whatsappHref} target="_blank" rel="noreferrer">{c.whatsapp}</a>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── footer ────────────────────────────────────────────────────── */}
      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <a className="lp-brand" href={`${basePath}/`} aria-label="Replay">
            <Brand />
          </a>
          <a href={`${basePath}/privacy`}>{c.privacy}</a>
          <a href={`${basePath}/terms`}>{c.terms}</a>
          {supportHref && <a href={supportHref}>{c.contact}</a>}
          <span>{c.city}</span>
        </div>
      </footer>
    </div>
  );
}

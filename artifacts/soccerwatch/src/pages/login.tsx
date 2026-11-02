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
import { useTranslation } from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import heroImage from "@/assets/hero-floodlit-pitch.png";
import playersImage from "@/assets/clips-editing.png";
import ownersImage from "@/assets/fields-amman.png";
import familyImage from "@/assets/academies-watching.png";
import { useSupportContact, supportMailto } from "@/lib/client-settings";
import { useLegalCopy } from "@/i18n/legal-strings";
import { useShowcase } from "@/pages/demo/data";
import "@/pages/demo/demo.css";
import { AppShot, basePath, Brand, BRANDED_GOAL, brandedClips, Chevron, Icon, LIVE_DEMO, LoopVideo, type IconName } from "./landing-parts";
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
    statsShot: "Straight from the Replay app: a real match at Jordan Galaxy, 26 October.",
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
    statsShot: "من تطبيق ريبلاي: مباراة حقيقية بجوردان جالاكسي، 26 تشرين الأول.",
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

const OWNER_WHATSAPP_TEXT = {
  en: "Hi, I'd like Replay at my pitch.",
  ar: "مرحبا، بدي ريبلاي بملعبي.",
} as const;

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

  // Branded copies only: the page says every clip carries the pitch's badge.
  const branded = brandedClips(showcase);
  const heroClip = branded.wide[0];
  const clipCount = showcase?.counts.clips ?? null;
  const returnRate = showcase?.returnRatePercent ?? null;
  const salesWhatsapp = showcase?.salesWhatsapp ?? null;
  const whatsappHref = salesWhatsapp
    ? `https://wa.me/${salesWhatsapp}?text=${encodeURIComponent(OWNER_WHATSAPP_TEXT[lang])}`
    : null;

  const numberFormat = new Intl.NumberFormat(isRtl ? "ar-JO-u-nu-latn" : "en-US");
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
        <section className="lp-hero" style={{ ["--lp-hero-still" as string]: `url(${heroImage})` }}>
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
                    <Icon name={pillar.id as IconName} />
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
              <div className="lp-phone">
                <div className="lp-media">
                  <LoopVideo clip={BRANDED_GOAL} fallback={playersImage} />
                </div>
              </div>
            </div>

            <div className="lp-feature lp-feature--flip" id="stats">
              <div>
                <h2 className="lp-h2">{c.statsTitle}</h2>
                <p className="lp-text">{c.statsText}</p>
              </div>
              <AppShot lang={lang} caption={c.statsShot} />
            </div>

            <div className="lp-feature" id="live">
              <div>
                <h2 className="lp-h2">{c.liveTitle}</h2>
                <p className="lp-text">{c.liveText}</p>
              </div>
              <figure className="lp-shot">
                <div className="lp-media">
                  <LoopVideo clip={LIVE_DEMO} fallback={familyImage} />
                </div>
                <figcaption className="lp-stats-note">{c.liveNote}</figcaption>
              </figure>
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

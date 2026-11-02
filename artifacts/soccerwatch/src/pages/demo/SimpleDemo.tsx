import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useReducedMotion } from "framer-motion";

import heroImage from "@/assets/hero-floodlit-pitch.png";
import familyImage from "@/assets/academies-watching.png";
import playersImage from "@/assets/clips-editing.png";
import { useLocale } from "@/i18n/context";
import { basePath, Brand, Chevron, Icon, LoopVideo, MatchStatsCard, type IconName } from "@/pages/landing-parts";
import { demoCopy, type DemoLocale, type Persona } from "./copy";
import { LiveBroadcast } from "./LiveBroadcast";
import { useReport, useShowcase, withBase, type DemoClip } from "./data";
import "./demo.css";
import "@/pages/landing.css";

/**
 * /demo (rewritten 2026-11-02): the owner's side of the home page. Same
 * design (landing.css, Apple HIG restraint), same real footage and match.
 * Pitches and academies get their own words; no money figure on this page
 * (Mohammed, 26 Oct). The long page lives on at /demo/full.
 */

type PersonaText = Record<Persona, string>;
type Item = { icon: IconName; title: string; text: string };

const COPY: Record<DemoLocale, {
  title: string;
  lang: string;
  langLabel: string;
  forPlayers: string;
  getProposal: string;
  whatsapp: string;
  personaLabel: string;
  personas: PersonaText;
  hero: Record<Persona, [string, string]>;
  lead: PersonaText;
  rebook: string;
  clips: string;
  valuesTitle: string;
  values: Record<Persona, Item[]>;
  brandTitle: string;
  brandText: PersonaText;
  statsTitle: string;
  statsText: PersonaText;
  stats: { possession: string; goals: string; shots: string; passes: string; dribbles: string; note: (date: string) => string };
  liveTitle: string;
  liveText: PersonaText;
  liveNote: string;
  consoleTitle: string;
  console: Item[];
  stepsTitle: string;
  steps: Array<{ title: string; text: string }>;
  contactTitle: PersonaText;
  callBackOnly: string;
  fullDemo: string;
  privacy: string;
  terms: string;
  city: string;
}> = {
  en: {
    title: "Replay · for pitches and academies",
    lang: "ع",
    langLabel: "العربية",
    forPlayers: "For players",
    getProposal: "Get a proposal",
    whatsapp: "WhatsApp",
    personaLabel: "Show for",
    personas: { pitch: "Pitches", academy: "Academies" },
    hero: {
      pitch: ["Let your players", "market your pitch."],
      academy: ["Let your players", "market your academy."],
    },
    lead: {
      pitch: "One camera records every match. Players share clips with your badge on them, and their friends come to play.",
      academy: "One camera records every session. Players share clips with your badge on them, and parents watch live.",
    },
    rebook: "of paying teams book again",
    clips: "clips made",
    valuesTitle: "What it brings you.",
    values: {
      pitch: [
        { icon: "calendar", title: "More bookings", text: "Every shared clip shows where the match was played." },
        { icon: "players", title: "Teams come back", text: "Players return to see their clips and stats." },
        { icon: "hands", title: "Nothing to run", text: "No camera operator. No editing. No staff time." },
      ],
      academy: [
        { icon: "players", title: "More players", text: "Every clip parents share carries your badge." },
        { icon: "stats", title: "Players stay", text: "Parents see their child improve, session after session." },
        { icon: "hands", title: "Nothing to run", text: "No camera operator. No editing. No coach time." },
      ],
    },
    brandTitle: "Your badge on every clip.",
    brandText: {
      pitch: "Your logo in the corner and a booking card at the end. Players post them on Instagram, TikTok and WhatsApp.",
      academy: "Your logo on every clip and a card at the end. Parents share them with the whole family.",
    },
    statsTitle: "Pro stats. No wearables.",
    statsText: {
      pitch: "Possession, passes and distance for every player, measured by the camera. Players come back to see theirs.",
      academy: "Possession, passes and distance for every player, measured by the camera. Parents see the progress.",
    },
    stats: {
      possession: "Possession",
      goals: "Goals",
      shots: "Shots",
      passes: "Passes",
      dribbles: "Dribbles won",
      note: (date) => `A real match, ${date}. Names hidden.`,
    },
    liveTitle: "Live, with no one filming.",
    liveText: {
      pitch: "The camera follows the ball, with the score and clock on screen. Friends watch from home.",
      academy: "The camera follows the ball, with the score and clock on screen. Parents watch from work.",
    },
    liveNote: "A recorded match, shown as it streams.",
    consoleTitle: "Run it from your phone.",
    console: [
      { icon: "history", title: "Any past hour", text: "Request it from your console and get it on WhatsApp." },
      { icon: "calendar", title: "Booked matches", text: "Book a match and the team gets the video." },
      { icon: "var", title: "VAR", text: "Check a disputed goal while the match is still on." },
    ],
    stepsTitle: "Running after one visit.",
    steps: [
      { title: "One camera, installed.", text: "It runs on your own internet." },
      { title: "It records by itself.", text: "Every match and session. No staff needed." },
      { title: "Players get their clips.", text: "After the whistle, with your badge on them." },
    ],
    contactTitle: { pitch: "See it on your pitch.", academy: "See it at your academy." },
    callBackOnly: "Leave your number and we'll call you back.",
    fullDemo: "See the full demo",
    privacy: "Privacy",
    terms: "Terms",
    city: "Amman, Jordan",
  },
  ar: {
    title: "ريبلاي · للملاعب والأكاديميات",
    lang: "EN",
    langLabel: "English",
    forPlayers: "للاعبين",
    getProposal: "اطلب عرض",
    whatsapp: "واتساب",
    personaLabel: "اعرض لـ",
    personas: { pitch: "ملاعب", academy: "أكاديميات" },
    hero: {
      pitch: ["خلّي لاعبينك", "يسوّقوا لملعبك."],
      academy: ["خلّي لاعبينك", "يسوّقوا لأكاديميتك."],
    },
    lead: {
      pitch: "كاميرا وحدة بتصوّر كل مباراة. اللاعبين بنشروا مقاطعهم وعليها شعار ملعبك، وأصحابهم بيجوا يلعبوا عندك.",
      academy: "كاميرا وحدة بتصوّر كل حصة. اللاعبين بنشروا مقاطعهم وعليها شعار أكاديميتك، والأهل بتابعوا مباشر.",
    },
    rebook: "من الفرق اللي بتدفع بترجع تحجز",
    clips: "مقطع انعمل",
    valuesTitle: "شو بتجيبلك.",
    values: {
      pitch: [
        { icon: "calendar", title: "حجوزات أكثر", text: "كل مقطع بنشروه بيبيّن وين انلعبت المباراة." },
        { icon: "players", title: "الفرق بترجع", text: "اللاعبين بيرجعوا يشوفوا مقاطعهم وأرقامهم." },
        { icon: "hands", title: "ولا إشي تشغّله", text: "بدون مصوّر، بدون مونتاج، وبدون وقت من موظفينك." },
      ],
      academy: [
        { icon: "players", title: "لاعبين أكثر", text: "كل مقطع بنشروه الأهل عليه شعار أكاديميتك." },
        { icon: "stats", title: "اللاعبين بضلّوا", text: "الأهل بشوفوا ابنهم بتحسّن حصة بعد حصة." },
        { icon: "hands", title: "ولا إشي تشغّله", text: "بدون مصوّر، بدون مونتاج، وبدون وقت من المدربين." },
      ],
    },
    brandTitle: "شعارك على كل مقطع.",
    brandText: {
      pitch: "شعارك بالزاوية وبطاقة حجز بالآخر. اللاعبين بنشروها على إنستغرام وتيك توك وواتساب.",
      academy: "شعارك على كل مقطع وبطاقة بالآخر. الأهل بنشروها للعيلة كلها.",
    },
    statsTitle: "أرقام محترفين. بدون ما حدا يلبس إشي.",
    statsText: {
      pitch: "الاستحواذ والتمريرات والمسافة لكل لاعب، والكاميرا بتقيسها. اللاعبين بيرجعوا يشوفوا أرقامهم.",
      academy: "الاستحواذ والتمريرات والمسافة لكل لاعب، والكاميرا بتقيسها. الأهل بشوفوا التحسّن.",
    },
    stats: {
      possession: "الاستحواذ",
      goals: "الأهداف",
      shots: "التسديدات",
      passes: "التمريرات",
      dribbles: "مراوغات ناجحة",
      note: (date) => `مباراة حقيقية، ${date}. الأسماء مخفية.`,
    },
    liveTitle: "بث مباشر بدون مصوّر.",
    liveText: {
      pitch: "الكاميرا بتلحق الطابة، والنتيجة والوقت على الشاشة. الأصحاب بتابعوا من البيت.",
      academy: "الكاميرا بتلحق الطابة، والنتيجة والوقت على الشاشة. الأهل بتابعوا من الشغل.",
    },
    liveNote: "مباراة مسجّلة، معروضة مثل ما بتنبث.",
    consoleTitle: "شغّلها من تلفونك.",
    console: [
      { icon: "history", title: "أي ساعة فاتت", text: "اطلبها من لوحتك وبتوصلك عالواتساب." },
      { icon: "calendar", title: "المباريات المحجوزة", text: "احجز مباراة والفريق بتوصله الفيديو." },
      { icon: "var", title: "VAR", text: "شيّك على هدف مختلف عليه والمباراة لسا شغّالة." },
    ],
    stepsTitle: "بتشتغل من أول زيارة.",
    steps: [
      { title: "منركّب كاميرا وحدة.", text: "بتشتغل على الإنترنت اللي عندك." },
      { title: "بتصوّر لحالها.", text: "كل مباراة وكل حصة، بدون موظفين." },
      { title: "اللاعبين بتوصلهم مقاطعهم.", text: "بعد الصافرة، وعليها شعارك." },
    ],
    contactTitle: { pitch: "شوفها على ملعبك.", academy: "شوفها بأكاديميتك." },
    callBackOnly: "اترك رقمك ومنرجعلك.",
    fullDemo: "شوف الديمو الكامل",
    privacy: "الخصوصية",
    terms: "الشروط",
    city: "عمّان، الأردن",
  },
};

const PERSONA_KEY = "replay-demo-persona";

function initialPersona(): Persona {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("for");
    if (fromUrl === "academy" || fromUrl === "pitch") return fromUrl;
    const saved = window.sessionStorage.getItem(PERSONA_KEY);
    if (saved === "academy" || saved === "pitch") return saved;
  } catch {
    // Storage can be blocked (private mode, in-app browsers); the default is fine.
  }
  return "pitch";
}

/** The callback form (POST /api/demo/leads) and WhatsApp, in the page's style. */
function LeadForm({ persona, lang, whatsappHref, leadsEnabled }: {
  persona: Persona;
  lang: DemoLocale;
  whatsappHref: string | null;
  leadsEnabled: boolean;
}) {
  const copy = demoCopy[lang].sections.contact;
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state === "sending") return;
    setState("sending");
    try {
      const response = await fetch(withBase("/api/demo/leads"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ name, place, phone, persona, website, locale: lang }),
      });
      setState(response.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="lp-form">
      {leadsEnabled && state !== "sent" && (
        <form onSubmit={submit}>
          <label className="lp-field">
            <span>{copy.name}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
          </label>
          <label className="lp-field">
            <span>{copy.place[persona]}</span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} required maxLength={120} autoComplete="organization" />
          </label>
          <label className="lp-field">
            <span>{copy.phone}</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              pattern="[0-9+ ()\-]{7,20}"
              dir="ltr"
            />
          </label>
          {/* honeypot: people never see or fill it */}
          <input className="lp-hp" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <button type="submit" className="lp-btn lp-btn--primary lp-btn--block" disabled={state === "sending"}>
            {state === "sending" ? copy.sending : copy.send}
          </button>
          {state === "error" && <p className="lp-form-msg lp-form-msg--error" role="alert">{copy.error}</p>}
        </form>
      )}
      {state === "sent" && <p className="lp-form-msg" role="status">{copy.sent}</p>}
      {whatsappHref && (
        <a className={`lp-btn lp-btn--block ${leadsEnabled ? "lp-btn--quiet" : "lp-btn--primary"}`} href={whatsappHref} target="_blank" rel="noopener noreferrer">
          {copy.whatsapp}
        </a>
      )}
      {!leadsEnabled && !whatsappHref && <p className="lp-form-msg">{copy.noChannel}</p>}
    </div>
  );
}

export default function SimpleDemo() {
  const { locale, setLocale } = useLocale();
  const lang: DemoLocale = locale === "en" ? "en" : "ar";
  const isRtl = lang === "ar";
  const c = COPY[lang];
  const contactCopy = demoCopy[lang].sections.contact;
  const reduceMotion = useReducedMotion();
  const [persona, setPersonaState] = useState<Persona>(initialPersona);
  const [solidNav, setSolidNav] = useState(false);

  const { data } = useShowcase();
  const { data: reportData } = useReport(Boolean(data?.match?.analysed));
  const report = reportData?.available ? reportData.report : null;

  const setPersona = (next: Persona) => {
    setPersonaState(next);
    try {
      window.sessionStorage.setItem(PERSONA_KEY, next);
      const url = new URL(window.location.href);
      url.searchParams.set("for", next);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // Not remembering the choice is harmless.
    }
  };

  useEffect(() => {
    const previous = document.title;
    document.title = c.title;
    return () => { document.title = previous; };
  }, [c.title]);

  useEffect(() => {
    const onScroll = () => setSolidNav(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The academy view only ever shows academy-branded copies, never a pitch's.
  const { wideClip, tallClip } = useMemo(() => {
    const clips: DemoClip[] = (persona === "academy" ? data?.academyClips : data?.clips) ?? [];
    const byViews = [...clips].sort((x, y) => y.viewCount - x.viewCount);
    const wide = byViews.find((clip) => clip.aspectRatio === "16:9") ?? null;
    const tall = byViews.find((clip) => clip.aspectRatio === "9:16")
      ?? (persona === "pitch" ? (data?.socialClips ?? []).find((clip) => clip.branded && clip.aspectRatio === "9:16") : undefined)
      ?? null;
    return { wideClip: wide, tallClip: tall };
  }, [data?.clips, data?.academyClips, data?.socialClips, persona]);

  const returnRate = persona === "pitch" ? data?.returnRatePercent ?? null : null;
  const clipCount = data?.counts.clips ?? null;
  const numberFormat = new Intl.NumberFormat(isRtl ? "ar-JO-u-nu-latn" : "en-US");
  const whatsappHref = data?.salesWhatsapp
    ? `https://wa.me/${data.salesWhatsapp}?text=${encodeURIComponent(contactCopy.whatsappMessage[persona])}`
    : null;
  const toContact = () => document.getElementById("contact")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  // Bunny Stream thumbnails need a referer, so stills come from the app's own assets.
  const stillFallback = heroImage;

  return (
    <div className="lp" dir={isRtl ? "rtl" : "ltr"} lang={lang} data-testid="page-demo">
      {/* ── nav ─────────────────────────────────────────────────────────── */}
      <header className="lp-nav" data-solid={solidNav}>
        <nav className="lp-wrap lp-nav-row" aria-label="Replay">
          <a className="lp-brand" href={`${basePath}/`} aria-label="Replay">
            <Brand />
          </a>
          <a className="lp-nav-link lp-nav-link--wide" href={`${basePath}/`}>{c.forPlayers}</a>
          <button type="button" className="lp-lang" onClick={() => setLocale(isRtl ? "en" : "ar")} aria-label={c.langLabel} lang={isRtl ? "en" : "ar"}>
            {c.lang}
          </button>
          <button type="button" className="lp-btn lp-btn--primary lp-btn--small" onClick={toContact}>{c.getProposal}</button>
        </nav>
      </header>

      <main>
        {/* ── hero ──────────────────────────────────────────────────────── */}
        <section className="lp-hero" style={{ ["--lp-hero-still" as string]: `url(${heroImage})` }}>
          <LoopVideo clip={wideClip} fallback={stillFallback} className="lp-hero-media" />
          <div className="lp-wrap lp-hero-body">
            <div className="lp-seg" role="group" aria-label={c.personaLabel}>
              {(["pitch", "academy"] as Persona[]).map((key) => (
                <button key={key} type="button" aria-pressed={persona === key} onClick={() => setPersona(key)}>
                  {c.personas[key]}
                </button>
              ))}
            </div>
            <h1 className="lp-h1">
              <span>{c.hero[persona][0]}</span>
              <span>{c.hero[persona][1]}</span>
            </h1>
            <p className="lp-lead">{c.lead[persona]}</p>
            <div className="lp-actions">
              <button type="button" className="lp-btn lp-btn--primary" onClick={toContact}>{c.getProposal}</button>
              {whatsappHref && (
                <a className="lp-btn lp-btn--quiet" href={whatsappHref} target="_blank" rel="noopener noreferrer">{c.whatsapp}</a>
              )}
            </div>
          </div>
        </section>

        {/* ── proof ─────────────────────────────────────────────────────── */}
        {(returnRate || clipCount) && (
          <div className="lp-wrap">
            <dl className="lp-proof">
              {returnRate ? (
                <div>
                  <dt>{c.rebook}</dt>
                  <dd>{numberFormat.format(returnRate)}%</dd>
                </div>
              ) : null}
              {clipCount ? (
                <div>
                  <dt>{c.clips}</dt>
                  <dd>{numberFormat.format(clipCount)}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        )}

        {/* ── what it brings ────────────────────────────────────────────── */}
        <section className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2 lp-center">{c.valuesTitle}</h2>
            <ul className="lp-pillars">
              {c.values[persona].map((item) => (
                <li key={item.title}>
                  <div className="lp-pillar">
                    <Icon name={item.icon} />
                    <h3 className="lp-h3">{item.title}</h3>
                    <p className="lp-text">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── the three automations, owner's view ───────────────────────── */}
        <section className="lp-section lp-section--raised">
          <div className="lp-wrap">
            <div className="lp-feature">
              <div>
                <h2 className="lp-h2">{c.brandTitle}</h2>
                <p className="lp-text">{c.brandText[persona]}</p>
              </div>
              {tallClip ? (
                <div className="lp-phone">
                  <div className="lp-media">
                    <LoopVideo clip={tallClip} fallback={stillFallback} />
                  </div>
                </div>
              ) : wideClip ? (
                <div className="lp-media">
                  <LoopVideo clip={wideClip} fallback={playersImage} />
                </div>
              ) : (
                <div className="lp-media lp-media--plain">
                  <img src={playersImage} alt="" aria-hidden="true" />
                </div>
              )}
            </div>

            {report?.team && (
              <div className="lp-feature lp-feature--flip">
                <div>
                  <h2 className="lp-h2">{c.statsTitle}</h2>
                  <p className="lp-text">{c.statsText[persona]}</p>
                </div>
                <MatchStatsCard report={report} labels={c.stats} rtl={isRtl} />
              </div>
            )}

            <div className={`lp-feature${report?.team ? "" : " lp-feature--flip"}`}>
              <div>
                <h2 className="lp-h2">{c.liveTitle}</h2>
                <p className="lp-text">{c.liveText[persona]}</p>
              </div>
              {data?.match && report?.broadcast && !reduceMotion ? (
                <figure className="lp-live" style={{ margin: 0 }}>
                  <LiveBroadcast match={data.match} report={report} copy={demoCopy[lang].sections.live} />
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

        {/* ── the owner console ─────────────────────────────────────────── */}
        <section className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2 lp-center">{c.consoleTitle}</h2>
            <ul className="lp-pillars">
              {c.console.map((item) => (
                <li key={item.title}>
                  <div className="lp-pillar">
                    <Icon name={item.icon} />
                    <h3 className="lp-h3">{item.title}</h3>
                    <p className="lp-text">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── how it starts ─────────────────────────────────────────────── */}
        <section className="lp-section lp-section--raised">
          <div className="lp-wrap">
            <h2 className="lp-h2 lp-center">{c.stepsTitle}</h2>
            <ol className="lp-steps">
              {c.steps.map((step, index) => (
                <li key={step.title}>
                  <span className="lp-step-num" aria-hidden="true">{numberFormat.format(index + 1)}</span>
                  <h3 className="lp-h3">{step.title}</h3>
                  <p className="lp-text">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── contact ───────────────────────────────────────────────────── */}
        <section className="lp-section" id="contact">
          <div className="lp-wrap">
            <div className="lp-owner lp-contact">
              <div>
                <h2 className="lp-h2">{c.contactTitle[persona]}</h2>
                <p className="lp-text">
                  {data?.leadsEnabled
                    ? (whatsappHref ? contactCopy.body : c.callBackOnly)
                    : contactCopy.bodyWhatsapp}
                </p>
              </div>
              <LeadForm persona={persona} lang={lang} whatsappHref={whatsappHref} leadsEnabled={Boolean(data?.leadsEnabled)} />
            </div>
            <p className="lp-center lp-more-row">
              <a className="lp-more" href={withBase(`/demo/full?for=${persona}`)}>
                {c.fullDemo} <Chevron />
              </a>
            </p>
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
          <span>{c.city}</span>
        </div>
      </footer>
    </div>
  );
}

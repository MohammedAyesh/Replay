import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ReplayMark } from "@/components/ReplayMark";
import { useLocale } from "@/i18n/context";
import { Calculator } from "./Calculator";
import { ClipRail, HeroVideo } from "./ClipRail";
import { Contact } from "./Contact";
import { demoCopy, type DemoLocale, type Persona } from "./copy";
import { formatMatchDate, formatNumber, useReport, useShowcase, withBase } from "./data";
import { FamilyWatching } from "./FamilyWatching";
import { LiveBlock } from "./LiveBlock";
import { LiveBroadcast } from "./LiveBroadcast";
import { Panorama } from "./Panorama";
import { PlayerSection } from "./PlayerSection";
import { useInView } from "./playback";
import { Report } from "./Report";
import { SocialSection } from "./SocialSection";
import { StoryTab } from "./StoryTab";
import "./demo.css";

type SectionKey = "products" | "try" | "live" | "after" | "setup";
type DemoView = "demo" | "story";

const ORDER: Record<Persona, SectionKey[]> = {
  pitch: ["products", "try", "live", "after", "setup"],
  academy: ["try", "after", "live", "products", "setup"],
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

function initialView(): DemoView {
  try {
    return new URLSearchParams(window.location.search).get("view") === "story" ? "story" : "demo";
  } catch {
    return "demo";
  }
}

function usePersona(): [Persona, (next: Persona) => void] {
  const [persona, setPersonaState] = useState<Persona>(initialPersona);
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
  return [persona, setPersona];
}

function Section({ id, index, kicker, title, body, children, tone }: {
  id: string;
  index: number;
  kicker: string;
  title: string;
  body?: ReactNode;
  children: ReactNode;
  tone?: "raised";
}) {
  return (
    <section id={id} className={`dm-section ${tone === "raised" ? "dm-section--raised" : ""}`} aria-labelledby={`${id}-title`}>
      <div className="dm-wrap">
        <header className="dm-section-head">
          <p className="dm-kicker"><span className="dm-kicker-num">{String(index).padStart(2, "0")}</span>{kicker}</p>
          <h2 id={`${id}-title`} className="dm-h2">{title}</h2>
          {body && <p className="dm-lead">{body}</p>}
        </header>
        {children}
      </div>
    </section>
  );
}

function TestimonialCard({ testimonial, locale }: {
  testimonial: NonNullable<NonNullable<ReturnType<typeof useShowcase>["data"]>["testimonial"]>;
  locale: DemoLocale;
}) {
  return (
    <figure className="dm-testimonial" dir={locale === "ar" ? "rtl" : "ltr"}>
      <blockquote>{locale === "ar" ? testimonial.quoteAr : testimonial.quoteEn}</blockquote>
      <figcaption><strong>{testimonial.name}</strong><span>{testimonial.role} · {testimonial.pitch}</span></figcaption>
    </figure>
  );
}

export default function DemoPage() {
  const { locale, setLocale } = useLocale();
  const lang: DemoLocale = locale === "en" ? "en" : "ar";
  const copy = demoCopy[lang];
  const [persona, setPersona] = usePersona();
  const [view, setViewState] = useState<DemoView>(initialView);
  const showcase = useShowcase();
  const data = showcase.data;
  const reportQuery = useReport(Boolean(data?.match?.analysed));
  const report = reportQuery.data?.available ? reportQuery.data.report : null;
  const { ref: heroRef, inView: heroInView } = useInView<HTMLElement>("0px", 0.05);
  const { ref: contactRef, inView: contactInView } = useInView<HTMLElement>("0px", 0.05);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [brandName, setBrandName] = useState("");
  const [brandLook, setBrandLook] = useState<"galaxy" | "custom">("galaxy");
  const [brandColor, setBrandColor] = useState("#D4FF4F");
  // With the Jordan Galaxy look the story's clips carry Galaxy's crest, so its
  // words name Galaxy too; a typed name (or the custom look) names the owner's.
  const brand = brandName.trim()
    || (brandLook === "galaxy" && persona === "pitch" ? (lang === "ar" ? "جوردان جالاكسي" : "Jordan Galaxy") : copy.sections.social.defaultName[persona]);
  const s = copy.sections;
  const setView = (next: DemoView) => {
    if (next === view) return;
    setViewState(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("view", next);
      window.history.pushState(window.history.state, "", url.toString());
    } catch {
      // The current tab still changes if the URL cannot be updated.
    }
    window.setTimeout(() => document.getElementById("demo-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  useEffect(() => {
    const syncView = () => setViewState(initialView());
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") !== view) {
        url.searchParams.set("view", view);
        window.history.replaceState(window.history.state, "", url.toString());
      }
    } catch {
      // Tab state remains usable when history APIs are unavailable.
    }
  }, [view]);

  useEffect(() => {
    const previous = document.title;
    document.title = lang === "ar" ? "ريبلاي · كاميرا لملعبك" : "Replay · a camera for your pitch";
    return () => {
      document.title = previous;
    };
  }, [lang]);

  const heroClip = useMemo(() => {
    const clips = data?.clips ?? [];
    if (!clips.length) return null;
    const mostWatched = [...clips].sort((a, b) => b.viewCount - a.viewCount)[0];
    const goals = report?.moments.filter((moment) => moment.type === "goal") ?? [];
    if (!data?.match || !report || goals.length === 0) return mostWatched;
    const goalClips = clips
      .filter((clip) => clip.videoId === data.match?.videoId && goals.some((goal) => {
        const start = clip.startFraction * report.durationSeconds;
        const end = clip.endFraction * report.durationSeconds;
        return goal.t >= start && goal.t <= end;
      }))
      .sort((a, b) => b.viewCount - a.viewCount);
    return goalClips[0] ?? mostWatched;
  }, [data?.clips, data?.match, report]);

  const matchDate = report?.date ?? data?.match?.date ?? null;
  const dateLabel = matchDate ? formatMatchDate(matchDate, lang) : null;
  const momentsState: "loading" | "ready" | "none" = !data?.match?.analysed
    ? "none"
    : reportQuery.isLoading
      ? "loading"
      : report && report.moments.length > 0
        ? "ready"
        : "none";
  const reportVisible = Boolean(data?.match?.analysed) && !reportQuery.isError && (reportQuery.isLoading || Boolean(report && (report.team || report.players.length)));

  const scrollToContact = () => document.getElementById("contact")?.scrollIntoView({ behavior: "smooth", block: "start" });

  const socialClips = (data?.socialClips?.length ? data.socialClips : data?.clips) ?? [];
  const available: Record<SectionKey, boolean> = {
    products: (data?.clips.length ?? 0) > 0 || socialClips.length > 0,
    try: Boolean(data?.match),
    live: true,
    after: reportVisible,
    setup: true,
  };
  const order = ORDER[persona].filter((key) => available[key]);
  const navItems = view === "demo"
    ? [
      ...order.map((key) => ({
        id: key,
        label: {
          products: s.clips.kicker,
          try: s.tryIt.kicker,
          live: s.live.kicker,
          after: s.report.kicker,
          setup: s.setup.kicker,
        }[key],
      })),
      { id: "demo-bridge", label: copy.bridge.action },
      { id: "contact", label: s.contact.title[persona] },
    ]
    : [
      { id: "story-timeline", label: copy.story.nav.timeline },
      { id: "story-flywheel", label: copy.story.nav.flywheel },
      { id: "story-revenue", label: copy.story.nav.revenue },
      { id: "story-calculator", label: copy.story.nav.calculator },
      { id: "contact", label: s.contact.title[persona] },
    ];
  const render = (key: SectionKey, index: number) => {
    switch (key) {
      case "products":
        return (
          <Section key={key} id="products" index={index} kicker={s.clips.kicker} title={s.clips.title[persona]} body={data?.clips[0]?.branded ? s.clips.bodyBranded : s.clips.body}>
            {persona === "pitch" && <p className="dm-loss">{s.clips.loss}</p>}
            {data?.clips.length ? <ClipRail clips={data.clips} copy={s.clips} /> : null}
            <SocialSection persona={persona} copy={s.social} name={brandName} onName={setBrandName} look={brandLook} onLook={setBrandLook} color={brandColor} onColor={setBrandColor} />
          </Section>
        );
      case "try":
        return (
          <Section key={key} id="try" index={index} kicker={s.tryIt.kicker} title={s.tryIt.title} body={dateLabel ? s.tryIt.body(dateLabel) : s.tryIt.bodyNoDate} tone="raised">
            <Panorama match={data!.match!} moments={report?.moments ?? []} momentsState={momentsState} copy={s.tryIt} />
          </Section>
        );
      case "live":
        return (
          <Section key={key} id="live" index={index} kicker={s.live.kicker} title={s.live.title[persona]} body={s.live.body[persona]}>
            {report?.broadcast && data?.match ? (
              <>
                <div className={persona === "academy" ? "dm-live-grid" : undefined}>
                  <div>
                    <LiveBroadcast match={data.match} report={report} copy={s.live} />
                    <p className="dm-small">{s.live.demoNote}</p>
                  </div>
                  {persona === "academy" && (
                    <figure className="dm-family-wrap">
                      <FamilyWatching title={s.live.familyAlt} />
                      <figcaption className="dm-small">{s.live.family}</figcaption>
                    </figure>
                  )}
                </div>
                <LiveBlock copy={s.live} poster={null} onlyWhenLive />
              </>
            ) : (
              <>
                <LiveBlock copy={s.live} poster={data?.match?.poster ?? null} />
                {persona === "academy" && (
                  <figure className="dm-family-wrap">
                    <FamilyWatching title={s.live.familyAlt} />
                    <figcaption className="dm-small">{s.live.family}</figcaption>
                  </figure>
                )}
              </>
            )}
          </Section>
        );
      case "after":
        return (
          <Section key={key} id="after" index={index} kicker={s.report.kicker} title={s.report.title[persona]} body={dateLabel ? s.report.body(dateLabel) : undefined} tone="raised">
            {report ? (
              <>
                <Report report={report} copy={s.report} locale={lang} />
                {report.players.length >= 2 && <PlayerSection report={report} persona={persona} copy={s.players} reportCopy={s.report} locale={lang} />}
              </>
            ) : (
              <div className="dm-loading" role="status">
                <span className="dm-loading-bar" aria-hidden="true" />
                <p className="dm-small">{s.report.loading}</p>
              </div>
            )}
          </Section>
        );
      case "setup":
        return (
          <Section key={key} id="setup" index={index} kicker={s.setup.kicker} title={s.setup.title}>
            <div className="dm-setup">
              <ol className="dm-steps">
                {s.setup.steps.map((step, i) => (
                  <li key={step}><span className="dm-step-num">{i + 1}</span>{step}</li>
                ))}
              </ol>
              <ul className="dm-tools-inline">
                {s.tools.items[persona].map((item) => <li key={item.title}><strong>{item.title}</strong> — {item.body}</li>)}
              </ul>
              <div className="dm-faq">
                <h3 className="dm-h3">{s.setup.faqTitle}</h3>
                {s.setup.faq[persona].map((item, i) => {
                  const open = openFaq === i;
                  return (
                    <div key={item.q} className={`dm-faq-item ${open ? "is-open" : ""}`}>
                      <h4>
                        <button type="button" aria-expanded={open} aria-controls={`faq-${i}`} onClick={() => setOpenFaq(open ? null : i)}>
                          <span>{item.q}</span>
                          <span className="dm-faq-sign" aria-hidden="true">{open ? "−" : "+"}</span>
                        </button>
                      </h4>
                      <p id={`faq-${i}`} hidden={!open}>{item.a}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </Section>
        );
      default:
        return null;
    }
  };

  const contactBody = data?.leadsEnabled ? s.contact.body : data?.salesWhatsapp ? s.contact.bodyWhatsapp : null;

  return (
    <div className="dm" lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} data-testid="page-demo">
      <header className="dm-top">
        <div className="dm-wrap dm-top-row">
          <a className="dm-brand" href="#top" aria-label="Replay">
            <ReplayMark className="dm-brand-mark" />
            <span className="dm-brand-word">{copy.brand}</span>
          </a>
          <nav className="dm-top-nav" aria-label={copy.sectionNav}>
            {navItems.map(({ id, label }) => <a key={id} href={`#${id}`}>{label}</a>)}
          </nav>
          <div className="dm-top-actions">
            <button type="button" className="dm-lang" onClick={() => setLocale(lang === "ar" ? "en" : "ar")} lang={lang === "ar" ? "en" : "ar"}>
              {copy.switchLanguage}
            </button>
            <button type="button" className="dm-btn dm-btn--primary dm-btn--small" onClick={scrollToContact}>{copy.getCamera}</button>
          </div>
        </div>
      </header>

      <main id="top">
        <section ref={heroRef} className="dm-hero" aria-labelledby="dm-hero-title">
          <HeroVideo clip={heroClip} fallbackPoster={data?.match?.poster ?? null} />
          <div className="dm-wrap dm-hero-body">
            <p className="dm-hero-kicker">{copy.hero.kicker[persona]}</p>
            <h1 id="dm-hero-title" className="dm-h1">{copy.hero.title[persona]}</h1>
            <p className="dm-hero-lead">{copy.hero.body[persona]}</p>
            <fieldset className="dm-persona">
              <legend>{copy.personaQuestion}</legend>
              {(["pitch", "academy"] as Persona[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={persona === key}
                  className={`dm-persona-btn ${persona === key ? "is-on" : ""}`}
                  onClick={() => setPersona(key)}
                >
                  {copy.personas[key]}
                </button>
              ))}
            </fieldset>
          </div>
        </section>

        <section className="dm-proof" aria-label={copy.proof.note}>
          <div className="dm-wrap dm-proof-layout">
            <dl className="dm-proof-grid">
              {data?.returnRatePercent != null && (
                <div className="dm-proof-tile">
                  <dt>{copy.proof.returnRate}</dt>
                  <dd className="dm-num">{formatNumber(data.returnRatePercent, lang)}%</dd>
                </div>
              )}
              {data?.counts.clips != null && (
                <div className="dm-proof-tile">
                  <dt>{copy.proof.clips}</dt>
                  <dd className="dm-num">{formatNumber(data.counts.clips, lang)}</dd>
                </div>
              )}
            </dl>
            {data?.testimonial && <TestimonialCard testimonial={data.testimonial} locale={lang} />}
          </div>
        </section>

        <div className="dm-tab-switch" role="tablist" aria-label={copy.sectionNav}>
          {(["demo", "story"] as DemoView[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`demo-tab-${tab}`}
              aria-controls="demo-panel"
              aria-selected={view === tab}
              className={`dm-tab-switch-btn ${view === tab ? "is-on" : ""}`}
              onClick={() => setView(tab)}
            >
              {copy.tabs[tab]}
            </button>
          ))}
        </div>

        <div id="demo-panel" className="dm-tab-panel-main" role="tabpanel" aria-labelledby={`demo-tab-${view}`}>
          {showcase.isLoading && (
            <div className="dm-wrap dm-page-loading" role="status"><span className="dm-loading-bar" aria-hidden="true" /></div>
          )}

          {view === "demo" ? (
            <>
              {order.map((key, i) => render(key, i + 1))}
              <section id="demo-bridge" className="dm-bridge" aria-label={copy.bridge.body}>
                <div className="dm-wrap dm-bridge-row">
                  <p>{copy.bridge.body}</p>
                  <button type="button" className="dm-btn dm-btn--primary" onClick={() => setView("story")}>{copy.bridge.action}</button>
                </div>
              </section>
            </>
          ) : (
            <>
              <StoryTab
                persona={persona}
                locale={lang}
                match={data?.match ?? null}
                clip={socialClips.find((item) => item.aspectRatio === "9:16") ?? socialClips[0] ?? null}
                brandName={brand}
                brandLook={brandLook}
                brandColor={brandColor}
                previewLabels={s.social.showcases}
                returnRatePercent={data?.returnRatePercent ?? null}
                clipCount={data?.counts.clips ?? null}
                copy={{
                  title: copy.story.title,
                  subtitle: copy.story.subtitle,
                  chapters: copy.story.chapters[persona],
                  closing: copy.story.closing[persona],
                  exampleNote: copy.story.exampleNote,
                  visualFallback: copy.story.visualFallback,
                  flywheel: {
                    ...copy.story.flywheel,
                    steps: copy.story.flywheel.steps[persona],
                    clipsLabel: copy.proof.clips,
                  },
                  revenueTitle: copy.story.revenueTitle,
                  revenueCards: copy.story.revenueCards[persona],
                  calculatorExampleNote: copy.story.calculatorExampleNote,
                  nav: copy.story.nav,
                  endScreensTitle: copy.story.endScreensTitle,
                  loading: copy.story.loading,
                }}
                calculator={<Calculator key={persona} persona={persona} copy={s.numbers} jod={copy.jod} locale={lang} />}
              />
              {data?.testimonial && <div className="dm-wrap dm-story-testimonial"><TestimonialCard testimonial={data.testimonial} locale={lang} /></div>}
            </>
          )}
        </div>

        <section id="contact" ref={contactRef} className="dm-contact" aria-labelledby="contact-title">
          <div className="dm-wrap dm-contact-grid">
            <div>
              <h2 id="contact-title" className="dm-h2">{s.contact.title[persona]}</h2>
              {contactBody && <p className="dm-lead">{contactBody}</p>}
            </div>
            <Contact persona={persona} copy={s.contact} whatsapp={data?.salesWhatsapp ?? null} leadsEnabled={Boolean(data?.leadsEnabled)} />
          </div>
        </section>
      </main>

      <footer className="dm-footer">
        <div className="dm-wrap dm-footer-row">
          <span>{copy.footer}</span>
          <a href={withBase("/privacy")}>{lang === "ar" ? "الخصوصية" : "Privacy"}</a>
        </div>
      </footer>

      <div className={`dm-sticky ${!heroInView && !contactInView ? "is-shown" : ""}`} aria-hidden={heroInView || contactInView}>
        <button type="button" className="dm-btn dm-btn--primary dm-btn--wide" onClick={scrollToContact} tabIndex={heroInView || contactInView ? -1 : 0}>
          {copy.getCamera}
        </button>
      </div>
    </div>
  );
}

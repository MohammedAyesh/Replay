import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ReplayMark } from "@/components/ReplayMark";
import { useLocale } from "@/i18n/context";
import { Calculator } from "./Calculator";
import { ClipRail, HeroVideo } from "./ClipRail";
import { Contact } from "./Contact";
import { demoCopy, type DemoLocale, type Persona } from "./copy";
import { formatMatchDate, formatNumber, useReport, useShowcase, withBase } from "./data";
import { LiveBlock } from "./LiveBlock";
import { Panorama } from "./Panorama";
import { useInView } from "./playback";
import { Report } from "./Report";
import "./demo.css";

type SectionKey = "clips" | "try" | "live" | "report" | "tools" | "numbers" | "setup";

const ORDER: Record<Persona, SectionKey[]> = {
  pitch: ["clips", "try", "live", "report", "tools", "numbers", "setup"],
  academy: ["try", "report", "clips", "live", "tools", "numbers", "setup"],
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

export default function DemoPage() {
  const { locale, setLocale } = useLocale();
  const lang: DemoLocale = locale === "en" ? "en" : "ar";
  const copy = demoCopy[lang];
  const [persona, setPersona] = usePersona();
  const showcase = useShowcase();
  const data = showcase.data;
  const reportQuery = useReport(Boolean(data?.match?.analysed));
  const report = reportQuery.data?.available ? reportQuery.data.report : null;
  const { ref: heroRef, inView: heroInView } = useInView<HTMLElement>("0px", 0.05);
  const { ref: contactRef, inView: contactInView } = useInView<HTMLElement>("0px", 0.05);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = lang === "ar" ? "ريبلاي · كاميرا لملعبك" : "Replay · a camera for your pitch";
    return () => {
      document.title = previous;
    };
  }, [lang]);

  const heroClip = useMemo(() => {
    const clips = data?.clips ?? [];
    return clips.find((clip) => clip.aspectRatio === "16:9") ?? clips[0] ?? null;
  }, [data?.clips]);

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

  const available: Record<SectionKey, boolean> = {
    clips: (data?.clips.length ?? 0) > 0,
    try: Boolean(data?.match),
    live: true,
    report: reportVisible,
    tools: true,
    numbers: true,
    setup: true,
  };
  const order = ORDER[persona].filter((key) => available[key]);

  const tiles = data
    ? ([
      [data.counts.recordings, copy.proof.recordings],
      [data.counts.clips, copy.proof.clips],
      [data.counts.analysed, copy.proof.analysed],
    ] as Array<[number, string]>).filter(([n]) => n > 0)
    : [];

  const s = copy.sections;
  const render = (key: SectionKey, index: number) => {
    switch (key) {
      case "clips":
        return (
          <Section key={key} id="clips" index={index} kicker={s.clips.kicker} title={s.clips.title[persona]} body={s.clips.body}>
            {persona === "pitch" && <p className="dm-loss">{s.clips.loss}</p>}
            <ClipRail clips={data!.clips} copy={s.clips} />
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
          <Section key={key} id="live" index={index} kicker={s.live.kicker} title={s.live.title[persona]}>
            <LiveBlock copy={s.live} poster={data?.match?.poster ?? null} />
          </Section>
        );
      case "report":
        return (
          <Section key={key} id="report" index={index} kicker={s.report.kicker} title={s.report.title[persona]} body={dateLabel ? s.report.body(dateLabel) : undefined} tone="raised">
            {report ? (
              <Report report={report} copy={s.report} locale={lang} />
            ) : (
              <div className="dm-loading" role="status">
                <span className="dm-loading-bar" aria-hidden="true" />
                <p className="dm-small">{s.report.loading}</p>
              </div>
            )}
          </Section>
        );
      case "tools":
        return (
          <Section key={key} id="tools" index={index} kicker={s.tools.kicker} title={s.tools.title[persona]}>
            <ol className="dm-tools">
              {s.tools.items[persona].map((item) => (
                <li key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ol>
          </Section>
        );
      case "numbers":
        return (
          <Section key={key} id="numbers" index={index} kicker={s.numbers.kicker} title={s.numbers.title[persona]} tone="raised">
            <Calculator key={persona} persona={persona} copy={s.numbers} jod={copy.jod} locale={lang} />
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
            {order.map((key) => {
              const label = {
                clips: s.clips.kicker,
                try: s.tryIt.kicker,
                live: s.live.kicker,
                report: s.report.kicker,
                tools: s.tools.kicker,
                numbers: s.numbers.kicker,
                setup: s.setup.kicker,
              }[key];
              return <a key={key} href={`#${key}`}>{label}</a>;
            })}
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
            <p className="dm-hero-kicker">{copy.hero.kicker}</p>
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

        {tiles.length > 0 && (
          <div className="dm-proof">
            <div className="dm-wrap">
              <dl className="dm-proof-grid" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
                {tiles.map(([n, label]) => (
                  <div key={label} className="dm-proof-tile">
                    <dt>{label}</dt>
                    <dd className="dm-num">{formatNumber(n, lang)}</dd>
                  </div>
                ))}
              </dl>
              <p className="dm-small">{copy.proof.note}</p>
            </div>
          </div>
        )}

        {showcase.isLoading && (
          <div className="dm-wrap dm-page-loading" role="status"><span className="dm-loading-bar" aria-hidden="true" /></div>
        )}

        {order.map((key, i) => render(key, i + 1))}

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

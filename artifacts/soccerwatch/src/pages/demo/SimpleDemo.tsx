import { useEffect, useId, useMemo, useState } from "react";

import { ReplayMark } from "@/components/ReplayMark";
import { useLocale } from "@/i18n/context";
import { ClipRail, HeroVideo } from "./ClipRail";
import { Contact } from "./Contact";
import { demoCopy, type DemoLocale, type Persona } from "./copy";
import { formatNumber, useShowcase, withBase } from "./data";
import { useInView } from "./playback";
import { simpleCopy } from "./simpleCopy";
import "./demo.css";

/**
 * The short /demo (2026-10-26): what an owner gets, real clips as proof, what
 * it adds a month, and how to get it. Everything else is on /demo/full.
 */

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

function Slider({ label, value, onChange, min, max, step }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  const id = useId();
  return (
    <div className="dm-field">
      <label htmlFor={id}>{label} <b className="dm-num">{value}</b></label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} dir="ltr" />
    </div>
  );
}

function Money({ persona, lang }: { persona: Persona; lang: DemoLocale }) {
  const c = simpleCopy[lang];
  const [a, setA] = useState(persona === "pitch" ? 20 : 60);
  const [b, setB] = useState(persona === "pitch" ? 40 : 35);
  useEffect(() => {
    setA(persona === "pitch" ? 20 : 60);
    setB(persona === "pitch" ? 40 : 35);
  }, [persona]);
  const weeks = 52 / 12;
  // Pitch: 4 in 10 bookings pay 3 JOD more to be filmed, plus one booking a
  // week from shared clips. Academy: 3 JOD more per player, plus two new
  // players a month. The same figures the full page's calculator starts from.
  const monthly = persona === "pitch" ? a * weeks * 0.4 * 3 + weeks * b : a * 3 + 2 * b;
  return (
    <div className="dm-money">
      <div className="dm-money-result" aria-live="polite">
        <strong className="dm-big-num" dir="ltr">+{formatNumber(Math.round(monthly), lang)}</strong>
        <span>{c.perMonth}</span>
        <span className="dm-small">{c.perYear(formatNumber(Math.round(monthly * 12), lang))}</span>
      </div>
      <div className="dm-money-inputs">
        {persona === "pitch" ? (
          <>
            <Slider label={c.inputs.pitch.a} value={a} onChange={setA} min={5} max={100} step={1} />
            <Slider label={c.inputs.pitch.b} value={b} onChange={setB} min={10} max={100} step={5} />
          </>
        ) : (
          <>
            <Slider label={c.inputs.academy.a} value={a} onChange={setA} min={10} max={300} step={5} />
            <Slider label={c.inputs.academy.b} value={b} onChange={setB} min={10} max={100} step={5} />
          </>
        )}
        <p className="dm-small">{c.assumption[persona]}</p>
      </div>
    </div>
  );
}

export default function SimpleDemo() {
  const { locale, setLocale } = useLocale();
  const lang: DemoLocale = locale === "en" ? "en" : "ar";
  const copy = demoCopy[lang];
  const c = simpleCopy[lang];
  const [persona, setPersonaState] = useState<Persona>(initialPersona);
  const showcase = useShowcase();
  const data = showcase.data;
  const { ref: heroRef, inView: heroInView } = useInView<HTMLElement>("0px", 0.05);
  const { ref: contactRef, inView: contactInView } = useInView<HTMLElement>("0px", 0.05);

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
    document.title = lang === "ar" ? "ريبلاي · كاميرا لملعبك" : "Replay · a camera for your pitch";
    return () => { document.title = previous; };
  }, [lang]);

  const heroClip = useMemo(() => {
    const clips = data?.clips ?? [];
    return clips.length ? [...clips].sort((x, y) => y.viewCount - x.viewCount)[0] : null;
  }, [data?.clips]);
  // One shape in the rail: mixing tall and wide cards leaves a tall empty band
  // above the wide ones on a phone. Wide clips if there are a few, else all.
  const railClips = useMemo(() => {
    const clips = data?.clips ?? [];
    const wide = clips.filter((clip) => clip.aspectRatio === "16:9");
    return wide.length >= 3 ? wide : clips;
  }, [data?.clips]);
  const returnRate = data?.returnRatePercent ?? null;
  const values = c.values[persona].filter((value) => value.stat !== "returnRate" || returnRate !== null);
  const scrollToContact = () => document.getElementById("contact")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="dm dm-simple" lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} data-testid="page-demo">
      <header className="dm-top">
        <div className="dm-wrap dm-top-row">
          <a className="dm-brand" href="#top" aria-label="Replay">
            <ReplayMark className="dm-brand-mark" />
            <span className="dm-brand-word">{copy.brand}</span>
          </a>
          <div className="dm-top-actions">
            <button type="button" className="dm-lang" onClick={() => setLocale(lang === "ar" ? "en" : "ar")} lang={lang === "ar" ? "en" : "ar"}>
              {copy.switchLanguage}
            </button>
            <button type="button" className="dm-btn dm-btn--primary dm-btn--small" onClick={scrollToContact}>{copy.getCamera}</button>
          </div>
        </div>
      </header>

      <main id="top">
        <section ref={heroRef} className="dm-hero dm-hero--short" aria-labelledby="dm-hero-title">
          <HeroVideo clip={heroClip} fallbackPoster={data?.match?.poster ?? null} />
          <div className="dm-wrap dm-hero-body">
            <p className="dm-hero-kicker">{c.kicker[persona]}</p>
            <h1 id="dm-hero-title" className="dm-h1">{c.title[persona]}</h1>
            <p className="dm-hero-lead">{c.lead[persona]}</p>
            <div className="dm-hero-actions">
              <button type="button" className="dm-btn dm-btn--primary" onClick={scrollToContact}>{copy.getCamera}</button>
              <div className="dm-seg" role="group" aria-label={copy.personaQuestion}>
                {(["pitch", "academy"] as Persona[]).map((key) => (
                  <button key={key} type="button" aria-pressed={persona === key} className={`dm-seg-btn ${persona === key ? "is-on" : ""}`} onClick={() => setPersona(key)}>
                    {copy.personas[key]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="dm-section dm-section--tight" aria-labelledby="dm-values-title">
          <div className="dm-wrap">
            <h2 id="dm-values-title" className="dm-h2 dm-h2--small">{c.valuesTitle}</h2>
            <ul className="dm-values">
              {values.map((value) => (
                <li key={value.title} className={`dm-value ${value.stat ? "dm-value--stat" : ""}`}>
                  {value.stat === "returnRate" && returnRate !== null && (
                    <strong className="dm-big-num" dir="ltr">{formatNumber(returnRate, lang)}%</strong>
                  )}
                  <h3>{value.title}</h3>
                  <p>{value.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {railClips.length ? (
          <section className="dm-section dm-section--tight dm-section--raised" aria-labelledby="dm-clips-title">
            <div className="dm-wrap">
              <h2 id="dm-clips-title" className="dm-h2 dm-h2--small">{c.clipsTitle}</h2>
              <p className="dm-small dm-simple-note">{c.clipsNote}</p>
              <ClipRail clips={railClips} copy={copy.sections.clips} />
            </div>
          </section>
        ) : null}

        <section className="dm-section dm-section--tight" aria-labelledby="dm-money-title">
          <div className="dm-wrap">
            <h2 id="dm-money-title" className="dm-h2 dm-h2--small">{c.moneyTitle}</h2>
            <Money persona={persona} lang={lang} />
          </div>
        </section>

        <section className="dm-section dm-section--tight dm-section--raised" aria-labelledby="dm-also-title">
          <div className="dm-wrap">
            <h2 id="dm-also-title" className="dm-h2 dm-h2--small">{c.alsoTitle}</h2>
            <ul className="dm-also">
              {c.also.map((item) => (
                <li key={item.title}><strong>{item.title}</strong><span>{item.body}</span></li>
              ))}
            </ul>
            <p className="dm-simple-setup">{c.setup}</p>
            <a className="dm-simple-full" href={withBase(`/demo/full?for=${persona}`)}>{c.full}</a>
          </div>
        </section>

        <section id="contact" ref={contactRef} className="dm-contact" aria-labelledby="contact-title">
          <div className="dm-wrap dm-contact-grid">
            <div>
              <h2 id="contact-title" className="dm-h2">{copy.sections.contact.title[persona]}</h2>
              <p className="dm-lead">{data?.leadsEnabled ? copy.sections.contact.body : copy.sections.contact.bodyWhatsapp}</p>
            </div>
            <Contact persona={persona} copy={copy.sections.contact} whatsapp={data?.salesWhatsapp ?? null} leadsEnabled={Boolean(data?.leadsEnabled)} />
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

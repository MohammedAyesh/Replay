import { useEffect, useId, useMemo, useState } from "react";

import { ReplayMark } from "@/components/ReplayMark";
import { useLocale } from "@/i18n/context";
import { ClipRail, HeroVideo } from "./ClipRail";
import { Contact } from "./Contact";
import { demoCopy, type DemoLocale, type Persona } from "./copy";
import { formatMatchDate, formatNumber, useReport, useShowcase, withBase, type DemoReport } from "./data";
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
  const [a, setA] = useState(persona === "pitch" ? 20 : 100);
  const [b, setB] = useState(persona === "pitch" ? 40 : 35);
  useEffect(() => {
    setA(persona === "pitch" ? 20 : 100);
    setB(persona === "pitch" ? 40 : 35);
  }, [persona]);
  const weeks = 52 / 12;
  // Pitch: 4 in 10 bookings pay 3 JOD more to be filmed, plus one booking a
  // week from shared clips (the full page's calculator starts from the same).
  // Academy (Mohammed, 26 Oct: "have the slider be free ads per month"): one
  // new player for every 50 clips shared.
  const parts = persona === "pitch"
    ? [
      { count: a * weeks * 0.4, unit: 3, value: a * weeks * 0.4 * 3 },
      { count: weeks, unit: b, value: weeks * b },
    ]
    : [
      { count: a / 50, unit: b, value: (a / 50) * b },
    ];
  const monthly = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <div className="dm-money">
      <div className="dm-money-result" aria-live="polite">
        {persona === "academy" && (
          <p className="dm-money-ads">
            <strong className="dm-num" dir="ltr">{formatNumber(a, lang)}</strong>
            <span>{c.ads.headline}</span>
          </p>
        )}
        <strong className="dm-big-num" dir="ltr">+{formatNumber(Math.round(monthly), lang)}</strong>
        <span>{c.perMonth}</span>
        <span className="dm-small">{c.perYear(formatNumber(Math.round(monthly * 12), lang))}</span>
        {persona === "academy" && <span className="dm-small">{c.ads.reach}</span>}
      </div>
      <div className="dm-money-inputs">
        {persona === "pitch" ? (
          <>
            <Slider label={c.inputs.pitch.a} value={a} onChange={setA} min={5} max={100} step={1} />
            <Slider label={c.inputs.pitch.b} value={b} onChange={setB} min={10} max={100} step={5} />
          </>
        ) : (
          <>
            <Slider label={c.inputs.academy.a} value={a} onChange={setA} min={10} max={500} step={10} />
            <Slider label={c.inputs.academy.b} value={b} onChange={setB} min={10} max={100} step={5} />
          </>
        )}
      </div>
      <div className="dm-money-how">
        <h3>{c.howTitle}</h3>
        <ol>
          {c.parts[persona].map((part, index) => (
            <li key={part.title}>
              <div>
                <strong>{part.title}</strong>
                <span className="dm-small">{part.detail(formatNumber(parts[index].count, lang, parts[index].count < 10 && !Number.isInteger(parts[index].count) ? 1 : 0), formatNumber(parts[index].unit, lang))}</span>
              </div>
              <b className="dm-num" dir="ltr">+{formatNumber(Math.round(parts[index].value), lang)}</b>
            </li>
          ))}
        </ol>
        <p className="dm-small">{c.assumption[persona]}</p>
      </div>
    </div>
  );
}

/** Real numbers from the demo's analysed match: the match, and its standout players. */
function RealNumbers({ report, lang }: { report: DemoReport; lang: DemoLocale }) {
  const c = simpleCopy[lang];
  const furthest = Math.max(0, ...report.players.map((p) => p.distanceKm ?? 0));
  const fastest = Math.max(0, ...report.players.map((p) => p.topSpeedKmh ?? 0));
  const tiles: Array<{ label: string; value: string; unit?: string }> = [];
  if (report.team) {
    tiles.push({ label: c.stats.score, value: `${report.team.goals[0]} – ${report.team.goals[1]}` });
    tiles.push({ label: c.stats.possession, value: `${Math.round(report.team.possessionPercent[0])}–${Math.round(report.team.possessionPercent[1])}`, unit: "%" });
    tiles.push({ label: c.stats.shots, value: `${report.team.shots[0]} – ${report.team.shots[1]}` });
  }
  if (report.players.length) tiles.push({ label: c.stats.players, value: formatNumber(report.players.length, lang) });
  if (furthest > 0) tiles.push({ label: c.stats.furthest, value: formatNumber(furthest, lang, 1), unit: c.stats.km });
  if (fastest > 0) tiles.push({ label: c.stats.fastest, value: formatNumber(fastest, lang, 1), unit: c.stats.kmh });
  if (!tiles.length) return null;
  return (
    <section className="dm-section dm-section--tight" aria-labelledby="dm-real-title">
      <div className="dm-wrap">
        <h2 id="dm-real-title" className="dm-h2 dm-h2--small">{c.statsTitle}</h2>
        <p className="dm-small dm-simple-note">{c.statsNote(formatMatchDate(report.date, lang))}</p>
        <dl className="dm-real">
          {tiles.map((tile) => (
            <div key={tile.label} className="dm-real-tile">
              <dt>{tile.label}</dt>
              <dd><span className="dm-num" dir="ltr">{tile.value}</span>{tile.unit && <small>{tile.unit}</small>}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
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
  const reportQuery = useReport(Boolean(data?.match?.analysed));
  const report = reportQuery.data?.available ? reportQuery.data.report : null;
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
  // Wide clips first (the first one plays by itself), then the vertical ones.
  // The academy view shows only academy-branded copies, never a pitch's.
  const railClips = useMemo(() => {
    const clips = (persona === "academy" ? data?.academyClips : data?.clips) ?? [];
    return [...clips.filter((clip) => clip.aspectRatio === "16:9"), ...clips.filter((clip) => clip.aspectRatio !== "16:9")];
  }, [data?.clips, data?.academyClips, persona]);
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
              <a className="dm-btn dm-btn--ghost" href={withBase(`/demo/full?for=${persona}`)}>{c.full}</a>
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
              <h2 id="dm-clips-title" className="dm-h2 dm-h2--small">{c.clipsTitle[persona]}</h2>
              <p className="dm-small dm-simple-note">{c.clipsNote[persona]}</p>
              <ClipRail clips={railClips} copy={copy.sections.clips} autoplayWide />
            </div>
          </section>
        ) : null}

        {report && <RealNumbers report={report} lang={lang} />}

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
            <a className="dm-full-card" href={withBase(`/demo/full?for=${persona}`)}>
              <span>
                <strong>{c.full}</strong>
                <span>{c.fullBody}</span>
              </span>
              <span className="dm-full-card-go" aria-hidden="true">{lang === "ar" ? "←" : "→"}</span>
            </a>
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

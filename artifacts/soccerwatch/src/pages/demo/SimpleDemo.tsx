import { useEffect, useMemo, useState } from "react";

import { ReplayMark } from "@/components/ReplayMark";
import { useLocale } from "@/i18n/context";
import { ClipCard, HeroVideo } from "./ClipRail";
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

/*
 * No money figure on this page (Mohammed, 26 Oct): for pitches the value is
 * more bookings, for academies more players who stay longer. The full page's
 * calculator (/demo/full) is unchanged.
 */

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

  // Two videos on the page, no more (Mohammed, 26 Oct): one sideline (16:9)
  // that plays by itself, and one vertical (9:16) inside a phone frame. The
  // academy view uses only academy-branded copies, never a pitch's.
  const { wideClip, tallClip } = useMemo(() => {
    const clips = (persona === "academy" ? data?.academyClips : data?.clips) ?? [];
    const byViews = [...clips].sort((x, y) => y.viewCount - x.viewCount);
    const wide = byViews.find((clip) => clip.aspectRatio === "16:9") ?? null;
    const tall = byViews.find((clip) => clip.aspectRatio === "9:16")
      ?? (persona === "pitch" ? (data?.socialClips ?? []).find((clip) => clip.branded && clip.aspectRatio === "9:16") : undefined)
      ?? null;
    return { wideClip: wide, tallClip: tall };
  }, [data?.clips, data?.academyClips, data?.socialClips, persona]);
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
          {/* A still, not a third video. */}
          <HeroVideo clip={null} fallbackPoster={wideClip?.poster ?? data?.match?.poster ?? null} />
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

        {wideClip || tallClip ? (
          <section className="dm-section dm-section--tight dm-section--raised" aria-labelledby="dm-clips-title">
            <div className="dm-wrap">
              <h2 id="dm-clips-title" className="dm-h2 dm-h2--small">{c.clipsTitle[persona]}</h2>
              <p className="dm-small dm-simple-note">{c.clipsNote[persona]}</p>
              <div className="dm-pair">
                {wideClip && (
                  <div className="dm-pair-wide">
                    <ClipCard clip={wideClip} copy={copy.sections.clips} near autoplay />
                  </div>
                )}
                {tallClip && (
                  <figure className="dm-phone">
                    <div className="dm-phone-body">
                      <span className="dm-phone-notch" aria-hidden="true" />
                      <ClipCard clip={tallClip} copy={copy.sections.clips} near autoplay={false} />
                      <span className="dm-phone-bar" aria-hidden="true" />
                    </div>
                    <figcaption className="dm-small">{c.phoneCaption[persona]}</figcaption>
                  </figure>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {report && <RealNumbers report={report} lang={lang} />}

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

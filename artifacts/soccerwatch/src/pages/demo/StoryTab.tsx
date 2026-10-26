import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DemoLocale, Persona } from "./copy";
import { withBase, formatNumber, type DemoClip, type DemoMatch } from "./data";
import { FieldLogo } from "./FieldLogo";
import { DemoLoader } from "./Loader";
import { claimPlayback, releasePlayback, useActivePlayback, useInView } from "./playback";
import "./story.css";

export type StoryVisual = "panorama" | "phone" | "clip" | "chat" | "booking" | "progress";

export type StoryTabCopy = {
  title: string;
  subtitle: string;
  chapters: Array<{ time: string; body: string; visual: StoryVisual }>;
  closing: string;
  exampleNote: string;
  visualFallback: string;
  flywheel: {
    title: string;
    steps: string[];
    returnLabel: string;
    clipsLabel: string;
    atLabel: string;
  };
  revenueTitle: string;
  revenueCards: Array<{ title: string; body: string; driver: string; driverIndex: 0 | 1 }>;
  calculatorExampleNote: string;
  nav: { timeline: string; flywheel: string; revenue: string; calculator: string };
  endScreensTitle: string;
  loading: string;
};

type StoryTabProps = {
  persona: Persona;
  locale: DemoLocale;
  match: DemoMatch | null;
  clip: DemoClip | null;
  brandName: string;
  brandLook: "galaxy" | "custom";
  brandColor: string;
  previewLabels: Record<"cornerCrest" | "broadcastBar" | "academyFrame" | "signOff" | "player" | "match" | "academy", string>;
  returnRatePercent: number | null;
  clipCount: number | null;
  copy: StoryTabCopy;
  calculator: ReactNode;
};

function useReveal() {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.16, rootMargin: "0px 0px -6% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, visible };
}

function AssetFallback({ children }: { children: ReactNode }) {
  return <div className="dm-story-fallback" role="img">{children}</div>;
}

function StoryVisualPanel({
  visual,
  persona,
  match,
  clip,
  brandName,
  fallback,
  signOffSrc,
}: {
  visual: StoryVisual;
  persona: Persona;
  match: DemoMatch | null;
  clip: DemoClip | null;
  brandName: string;
  fallback: string;
  /** The real sign-off card, drawn by the same code as an export. */
  signOffSrc: string | null;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const logoName = brandName.trim();
  const clipPoster = clip?.poster ? withBase(clip.poster) : "";

  if (visual === "panorama") {
    return (
      <div className="dm-story-panorama" aria-label={fallback}>
        {match?.poster ? (
          <img src={withBase(match.poster)} alt="" onError={() => setPosterFailed(true)} />
        ) : null}
        {(!match?.poster || posterFailed) && <AssetFallback>{fallback}</AssetFallback>}
        <span className="dm-story-panorama-mark" aria-hidden="true" />
        <span className="dm-story-panorama-lines" aria-hidden="true" />
      </div>
    );
  }

  if (visual === "phone") {
    return (
      <div className="dm-story-phone-scene">
        <div className="dm-story-phone">
          <div className="dm-story-phone-notch" aria-hidden="true" />
          <div className="dm-story-phone-screen">
            {clipPoster && !posterFailed ? (
              <img className="dm-story-poster" src={clipPoster} alt="" onError={() => setPosterFailed(true)} />
            ) : <AssetFallback>{fallback}</AssetFallback>}
            {clip?.src && !videoFailed && (
              <video
                className="dm-story-video"
                src={withBase(clip.src)}
                poster={clipPoster || undefined}
                controls
                muted
                playsInline
                preload="none"
                onError={() => setVideoFailed(true)}
                aria-label={fallback}
              />
            )}
            {!clip?.branded && <span className="dm-story-brand-bug"><FieldLogo name={logoName} size={22} /><b>{logoName}</b></span>}
          </div>
          <div className="dm-story-phone-base" aria-hidden="true" />
        </div>
        {persona === "academy" && (
          <div className="dm-story-live-card" aria-hidden="true">
            <span className="dm-story-live-dot" aria-hidden="true" />
            <span className="dm-story-live-lines"><i /><i /></span>
          </div>
        )}
      </div>
    );
  }

  if (visual === "clip") {
    return (
      <div className="dm-story-clip-scene">
        <div className="dm-story-clip-frame">
          {clipPoster && !posterFailed ? (
            <img src={clipPoster} alt="" onError={() => setPosterFailed(true)} />
          ) : <AssetFallback>{fallback}</AssetFallback>}
          {clip?.src && !videoFailed && (
            <video
              src={withBase(clip.src)}
              poster={clipPoster || undefined}
              controls
              muted
              playsInline
              preload="none"
              onError={() => setVideoFailed(true)}
              aria-label={fallback}
            />
          )}
          {!clip?.branded && <span className="dm-story-brand-bug"><FieldLogo name={logoName} size={24} /><b>{logoName}</b></span>}
        </div>
        {signOffSrc ? (
          <img className="dm-story-end-card dm-story-end-card--real" src={signOffSrc} alt="" loading="lazy" />
        ) : (
          <div className="dm-story-end-card">
            <FieldLogo name={logoName} size={34} />
            <span className="dm-story-end-rule" aria-hidden="true" />
            <strong>{logoName}</strong>
          </div>
        )}
      </div>
    );
  }

  if (visual === "chat") {
    return (
      <div className="dm-story-chat" aria-hidden="true">
        <div className="dm-story-chat-head"><i /><i /><i /></div>
        <div className="dm-story-bubble dm-story-bubble--start"><i /><i /></div>
        <div className="dm-story-bubble dm-story-bubble--end"><i /><i /><i /></div>
        <div className="dm-story-chat-clip">
          {clipPoster && !posterFailed ? (
            <img src={clipPoster} alt="" onError={() => setPosterFailed(true)} />
          ) : <span>{fallback}</span>}
          <FieldLogo name={logoName} size={20} />
        </div>
        <div className="dm-story-bubble dm-story-bubble--start dm-story-bubble--short"><i /></div>
      </div>
    );
  }

  return (
    <div className={`dm-story-outcome ${persona === "academy" ? "is-academy" : ""}`}>
      <div className="dm-story-outcome-head">
        <FieldLogo name={logoName} size={32} />
        <span className="dm-story-outcome-name">{logoName}</span>
        <span className="dm-story-outcome-stamp" aria-hidden="true" />
      </div>
      {persona === "pitch" ? (
        <div className="dm-story-booking-body">
          <div className="dm-story-booking-field"><i /><i /></div>
          <div className="dm-story-booking-field"><i /><i /></div>
          <div className="dm-story-booking-action"><i /></div>
        </div>
      ) : (
        <div className="dm-story-progress-body">
          <div className="dm-story-progress-avatar"><FieldLogo name={logoName} size={24} /></div>
          <div className="dm-story-progress-lines"><i /><i /><i /></div>
          <div className="dm-story-progress-track"><i /></div>
          <div className="dm-story-progress-bars"><i /><i /><i /><i /><i /></div>
        </div>
      )}
    </div>
  );
}

function Flywheel({ copy, returnRatePercent, clipCount, locale }: {
  copy: StoryTabCopy["flywheel"];
  returnRatePercent: number | null;
  clipCount: number | null;
  locale: DemoLocale;
}) {
  const rate = returnRatePercent !== null && Number.isFinite(returnRatePercent)
    ? `${new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-US", { maximumFractionDigits: 2 }).format(returnRatePercent)}%`
    : "—";
  const clips = clipCount !== null && Number.isFinite(clipCount) ? formatNumber(clipCount, locale) : "—";

  return (
    <section id="story-flywheel" className="dm-story-loop" aria-labelledby="dm-story-loop-title">
      <div className="dm-story-loop-copy">
        <h2 className="dm-story-eyebrow" id="dm-story-loop-title">{copy.title}</h2>
        <ol className="dm-story-loop-steps">
          {copy.steps.map((step, index) => <li key={`${index}-${step}`}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}
        </ol>
        <p className="dm-story-metrics">
          <span className="dm-story-metric">
            <strong dir="ltr">{rate}</strong>
            <span>{copy.returnLabel} <i>{copy.atLabel}</i></span>
          </span>
          <span className="dm-story-metric">
            <strong dir="ltr">{clips}</strong>
            <span>{copy.clipsLabel}</span>
          </span>
        </p>
      </div>
      <div className="dm-story-loop-art" aria-hidden="true">
        <svg viewBox="0 0 420 260" fill="none">
          <path className="dm-story-loop-path dm-story-loop-path--one" d="M90 126C90 71 139 35 205 35C269 35 320 70 320 126" />
          <path className="dm-story-loop-path dm-story-loop-path--two" d="M320 134C320 190 270 225 205 225C140 225 90 190 90 134" />
          <path className="dm-story-loop-arrow" d="M307 116L321 132L337 117" />
          <path className="dm-story-loop-arrow" d="M103 145L89 129L73 144" />
          <circle className="dm-story-loop-dot dm-story-loop-dot--a" r="6" />
          <circle className="dm-story-loop-dot dm-story-loop-dot--b" r="6" />
          <circle className="dm-story-loop-dot dm-story-loop-dot--c" r="6" />
          <circle className="dm-story-loop-core" cx="205" cy="130" r="43" />
          <path className="dm-story-loop-core-mark" d="M188 131L200 143L224 116" />
        </svg>
      </div>
    </section>
  );
}

export function StoryTab({
  persona,
  locale,
  match,
  clip,
  brandName,
  brandLook,
  brandColor,
  previewLabels,
  returnRatePercent,
  clipCount,
  copy,
  calculator,
}: StoryTabProps) {
  const signOffParams = new URLSearchParams({ look: brandLook, what: "signOff", persona, aspect: "9:16" });
  if (brandLook === "custom") {
    signOffParams.set("name", brandName);
    signOffParams.set("color", brandColor);
  }
  const signOffSrc = withBase(`/api/demo/branding/preview.png?${signOffParams.toString()}`);
  return (
    <div className="dm-story" lang={locale === "ar" ? "ar" : "en"} dir={locale === "ar" ? "rtl" : "ltr"}>
      <section className="dm-story-intro">
        <h2 className="dm-story-eyebrow" id="dm-story-title">{copy.title}</h2>
        <p className="dm-story-subtitle">{copy.subtitle}</p>
      </section>

      <RendererStoryPreviews
        persona={persona}
        look={brandLook}
        name={brandName}
        color={brandColor}
        labels={previewLabels}
        label={copy.endScreensTitle}
        loading={copy.loading}
      />

      <div id="story-timeline" className="dm-story-timeline" aria-label={copy.nav.timeline}>
        {copy.chapters.map((chapter, index) => (
          <StoryChapter
            key={`${chapter.time}-${chapter.visual}-${index}`}
            chapter={chapter}
            index={index}
            persona={persona}
            match={match}
            clip={clip}
            brandName={brandName}
            fallback={copy.visualFallback}
            signOffSrc={signOffSrc}
          />
        ))}
      </div>

      <p className="dm-story-closing">{copy.closing}</p>
      <p className="dm-story-example-note">{copy.exampleNote}</p>

      <Flywheel
        copy={copy.flywheel}
        returnRatePercent={returnRatePercent}
        clipCount={clipCount}
        locale={locale}
      />

      <section id="story-revenue" className="dm-story-revenue" aria-labelledby="dm-story-revenue-title">
        <div className="dm-story-revenue-heading">
          <h2 id="dm-story-revenue-title">{copy.revenueTitle}</h2>
          <p>{copy.calculatorExampleNote}</p>
        </div>
        <div className="dm-story-revenue-cards">
          {copy.revenueCards.map((card, index) => (
            <article className="dm-story-revenue-card" key={`${index}-${card.title}`}>
              <span className="dm-story-revenue-index">{String(index + 1).padStart(2, "0")}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
              <a className="dm-story-driver" href={`#demo-calc-line-${card.driverIndex}`}>{card.driver}</a>
            </article>
          ))}
        </div>
        <div id="story-calculator" className="dm-story-calculator" aria-label={copy.nav.calculator}>{calculator}</div>
      </section>
    </div>
  );
}

function RendererStoryPreviews({
  persona,
  look,
  name,
  color,
  labels,
  label,
  loading,
}: {
  loading: string;
  persona: Persona;
  look: "galaxy" | "custom";
  name: string;
  color: string;
  labels: Record<"cornerCrest" | "broadcastBar" | "academyFrame" | "signOff" | "player" | "match" | "academy", string>;
  label: string;
}) {
  const kinds: Array<"signOff" | "player" | "match" | "academy"> = persona === "academy"
    ? ["signOff", "player", "academy"]
    : ["signOff", "player", "match", "academy"];
  const aspect = look === "galaxy" ? "9:16" : "16:9";
  return (
    <section className="dm-story-renderer" aria-label={label} data-testid="story-renderer-previews">
      <p className="dm-story-renderer-heading">{label}</p>
      <div className="dm-story-renderer-grid">
        {kinds.map((kind) => (
          <RendererStoryVideo
            key={`${kind}-${persona}`}
            kind={kind}
            title={labels[kind]}
            persona={persona}
            look={look}
            name={name}
            color={color}
            aspect={aspect}
            loading={loading}
          />
        ))}
      </div>
    </section>
  );
}

function RendererStoryVideo({ kind, title, persona, look, name, color, aspect, loading }: {
  loading: string;
  kind: "signOff" | "player" | "match" | "academy";
  title: string;
  persona: Persona;
  look: "galaxy" | "custom";
  name: string;
  color: string;
  aspect: "9:16" | "16:9";
}) {
  const id = `renderer-story-${persona}-${kind}`;
  const { ref, inView } = useInView<HTMLElement>("160px 0px", 0.15);
  const activePlayback = useActivePlayback();
  const params = new URLSearchParams({ look, kind, persona, aspect });
  if (look === "custom") {
    params.set("name", name);
    params.set("color", color);
    params.set(/[\u0600-\u06FF]/.test(name) ? "nameAr" : "nameEn", name);
  }
  const src = withBase(`/api/demo/branding/preview.mp4?${params.toString()}`);
  const [ready, setReady] = useState(false);
  // A new source, or the video unmounting as it scrolls away, starts the loader again.
  useEffect(() => setReady(false), [src, inView]);

  useEffect(() => {
    const video = ref.current?.querySelector("video");
    if (!video) return;
    if (inView && (activePlayback === null || activePlayback === id)) {
      claimPlayback(id);
      void video.play().catch(() => undefined);
    } else if (!video.paused) {
      video.pause();
    }
    if (!inView) releasePlayback(id);
  }, [activePlayback, id, inView, ref]);

  useEffect(() => () => releasePlayback(id), [id]);

  return (
    <figure ref={ref} className="dm-story-renderer-item" data-testid={`story-video-${kind}`}>
      <div className={`dm-story-renderer-frame ${aspect === "9:16" ? "is-vertical" : "is-horizontal"}`}>
        {inView && (
          <video
            src={src}
            muted
            playsInline
            loop
            preload="auto"
            onLoadedData={() => setReady(true)}
            onError={() => setReady(true)}
            aria-label={title}
            data-testid={`story-video-player-${kind}`}
          />
        )}
        {!ready && <DemoLoader label={loading} />}
      </div>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

function StoryChapter({
  chapter,
  index,
  persona,
  match,
  clip,
  brandName,
  fallback,
  signOffSrc,
}: {
  chapter: StoryTabCopy["chapters"][number];
  index: number;
  persona: Persona;
  match: DemoMatch | null;
  clip: DemoClip | null;
  brandName: string;
  fallback: string;
  signOffSrc: string | null;
}) {
  const { ref, visible } = useReveal();

  return (
    <article ref={ref} className={`dm-story-chapter ${visible ? "is-visible" : ""} ${index % 2 ? "is-reverse" : ""}`}>
      <div className="dm-story-chapter-copy">
          <span className="dm-story-time">{chapter.time}</span>
          <p>{chapter.body.replaceAll("[اسم ملعبك]", brandName).replaceAll("[your pitch]", brandName)}</p>
      </div>
      <div className="dm-story-visual">
        <span className="dm-story-visual-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <StoryVisualPanel
          visual={chapter.visual}
          persona={persona}
          match={match}
          clip={clip}
          brandName={brandName}
          fallback={fallback}
          signOffSrc={signOffSrc}
        />
      </div>
    </article>
  );
}

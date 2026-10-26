import { useEffect, useId, useMemo, useState } from "react";

import type { DemoCopy, Persona } from "./copy";
import { withBase } from "./data";
import { DemoLoader } from "./Loader";

type BrandLook = "galaxy" | "custom";
type ShowcaseWhat = "cornerCrest" | "broadcastBar" | "academyFrame" | "signOff" | "player" | "match" | "academy";
type Aspect = "9:16" | "16:9";

const HEX = /^#[0-9a-fA-F]{6}$/;

function hasArabic(value: string) {
  return /[\u0600-\u06FF]/.test(value);
}

function previewUrl(what: ShowcaseWhat, look: BrandLook, name: string, color: string, persona: Persona, aspect: Aspect) {
  const params = new URLSearchParams({ look, what, persona, aspect });
  if (look === "custom") {
    params.set("name", name);
    params.set("color", color);
    params.set(hasArabic(name) ? "nameAr" : "nameEn", name);
  }
  return withBase(`/api/demo/branding/preview.png?${params.toString()}`);
}

function LazyShowcase({ what, title, look, name, color, persona, aspect }: {
  what: ShowcaseWhat;
  title: string;
  look: BrandLook;
  name: string;
  color: string;
  persona: Persona;
  aspect: Aspect;
}) {
  const [near, setNear] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState("");
  const url = useMemo(() => previewUrl(what, look, name, color, persona, aspect), [what, look, name, color, persona, aspect]);

  useEffect(() => {
    const node = document.getElementById(`branding-showcase-${what}`);
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [what]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const load = () => {
      setFailed(false);
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        setLoadedSrc(url);
        setSrc(url);
      };
      image.onerror = () => {
        if (!cancelled) setFailed(true);
      };
      image.src = url;
    };
    const timer = window.setTimeout(load, look === "custom" ? 400 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [near, url, look]);

  return (
    <figure id={`branding-showcase-${what}`} className="dm-branding-showcase" data-testid={`preview-${what}`}>
      <figcaption>{title}</figcaption>
      <div className={`dm-branding-image dm-branding-image--${aspect === "9:16" ? "tall" : "wide"}`}>
        {src && <img src={src} alt={title} loading="lazy" />}
        {!src && !failed && <DemoLoader label={title} />}
        {failed && !loadedSrc && <span className="dm-branding-error">{title}</span>}
      </div>
    </figure>
  );
}

export function SocialSection({ persona, copy, name, onName, look, onLook, color, onColor }: {
  persona: Persona;
  copy: DemoCopy["sections"]["social"];
  name: string;
  onName: (value: string) => void;
  look: BrandLook;
  onLook: (value: BrandLook) => void;
  color: string;
  onColor: (value: string) => void;
}) {
  const inputId = useId();
  const colorId = useId();
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [colorDraft, setColorDraft] = useState(color);
  const effectiveName = name.trim() || copy.defaultName[persona];
  const acceptedColor = HEX.test(colorDraft) ? colorDraft.toUpperCase() : "#D4FF4F";
  const whatItems: Array<{ what: ShowcaseWhat; title: string }> = persona === "academy"
    ? [
      { what: "academyFrame", title: copy.showcases.academyFrame },
      { what: "broadcastBar", title: copy.showcases.broadcastBar },
      { what: "signOff", title: copy.showcases.signOff },
      { what: "player", title: copy.showcases.player },
      { what: "academy", title: copy.showcases.academy },
    ]
    : [
      { what: "cornerCrest", title: copy.showcases.cornerCrest },
      { what: "broadcastBar", title: copy.showcases.broadcastBar },
      { what: "signOff", title: copy.showcases.signOff },
      { what: "player", title: copy.showcases.player },
      { what: "match", title: copy.showcases.match },
    ];
  useEffect(() => {
    setColorDraft(color);
  }, [color]);

  return (
    <div className="dm-social" data-testid="branding-studio">
      <div className="dm-social-text">
        <p className="dm-lead dm-lead--flush">{copy.body[persona]}</p>
        <ul className="dm-points">
          {copy.points[persona].map((point) => <li key={point}>{point}</li>)}
        </ul>

        <fieldset className="dm-branding-fieldset">
          <legend>{copy.lookLabel}</legend>
          <div className="dm-branding-options">
            {(["galaxy", "custom"] as BrandLook[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`dm-btn dm-branding-choice ${look === option ? "is-on" : ""}`}
                aria-pressed={look === option}
                onClick={() => onLook(option)}
                data-testid={`branding-look-${option}`}
              >
                {copy.looks[option]}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="dm-field" htmlFor={inputId}>
          <span>{copy.nameLabel[persona]}</span>
        </label>
        <input
          id={inputId}
          className="dm-text-input"
          value={name}
          maxLength={28}
          onChange={(event) => onName(event.target.value)}
          autoComplete="off"
          data-testid="branding-name"
        />
        <div className="dm-branding-meta">
          <span>{name.length}/28</span>
        </div>

        <label className="dm-field dm-color-field" htmlFor={colorId}>{copy.colorLabel}</label>
        <div className="dm-branding-color-row">
          <input
            id={colorId}
            className="dm-text-input dm-branding-color"
            value={colorDraft}
            maxLength={7}
            onChange={(event) => {
              const next = event.target.value;
              setColorDraft(next);
              if (HEX.test(next)) onColor(next.toUpperCase());
            }}
            onBlur={() => {
              const next = HEX.test(colorDraft) ? colorDraft.toUpperCase() : "#D4FF4F";
              setColorDraft(next);
              onColor(next);
            }}
            aria-invalid={!HEX.test(colorDraft)}
            data-testid="branding-color"
            dir="ltr"
          />
          <span className="dm-branding-swatch" style={{ backgroundColor: acceptedColor }} aria-label={`${copy.colorLabel} ${acceptedColor}`} />
        </div>
        <p className="dm-small">{copy.colorHint}</p>
        <p className="dm-small">{copy.platforms}</p>
        <p className="dm-small">{copy.sample}</p>
      </div>

      <div className="dm-branding-preview-area">
        <div className="dm-branding-preview-head">
          <div>
            <p className="dm-kicker">{copy.previewKicker}</p>
            <p className="dm-small">{copy.previewDescription[persona]}</p>
          </div>
          <div className="dm-seg" role="group" aria-label={copy.aspectLabel}>
            {(["9:16", "16:9"] as Aspect[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`dm-seg-btn ${aspect === value ? "is-on" : ""}`}
                aria-pressed={aspect === value}
                onClick={() => setAspect(value)}
                data-testid={`branding-aspect-${value.replace(":", "-")}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="dm-branding-grid">
          {whatItems.map((item) => (
            <LazyShowcase
              key={item.what}
              {...item}
              look={look}
              name={effectiveName}
              color={acceptedColor}
              persona={persona}
              aspect={aspect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useId, useMemo, useState } from "react";

import type { DemoCopy, Persona } from "./copy";
import { withBase } from "./data";
import { DemoLoader } from "./Loader";

type ShowcaseWhat = "cornerCrest" | "academyFrame" | "signOff";

/** The colours an owner can try. The first is Jordan Galaxy's own. */
export const BRAND_SWATCHES = ["#F4CF1F", "#D4FF4F", "#2FD8C4", "#7B5CFF", "#FF5A3C", "#F2F4F8"] as const;

function previewUrl(what: ShowcaseWhat, name: string, color: string | null, persona: Persona) {
  const custom = Boolean(name.trim()) || color !== null;
  const params = new URLSearchParams({ look: custom ? "custom" : "galaxy", what, persona, aspect: "9:16" });
  if (custom) {
    params.set("name", name.trim());
    params.set("color", color ?? BRAND_SWATCHES[0]);
  }
  return withBase(`/api/demo/branding/preview.png?${params.toString()}`);
}

function Preview({ what, title, name, color, persona }: {
  what: ShowcaseWhat;
  title: string;
  name: string;
  color: string | null;
  persona: Persona;
}) {
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const url = useMemo(() => previewUrl(what, name, color, persona), [what, name, color, persona]);

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

  // A typed name waits for a pause in typing; the preset loads at once.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const load = () => {
      setFailed(false);
      const image = new Image();
      image.onload = () => { if (!cancelled) setSrc(url); };
      image.onerror = () => { if (!cancelled) setFailed(true); };
      image.src = url;
    };
    const timer = window.setTimeout(load, name.trim() ? 450 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [near, url, name]);

  return (
    <figure id={`branding-showcase-${what}`} className="dm-branding-showcase" data-testid={`preview-${what}`}>
      <div className="dm-branding-image dm-branding-image--tall">
        {src && <img src={src} alt={title} />}
        {src !== url && !failed && <DemoLoader label={title} />}
      </div>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

/**
 * "Try it with your pitch": a name and a colour, and the two things every clip
 * carries, drawn by the same code an export runs.
 */
export function SocialSection({ persona, copy, name, onName, color, onColor }: {
  persona: Persona;
  copy: DemoCopy["sections"]["social"];
  name: string;
  onName: (value: string) => void;
  color: string | null;
  onColor: (value: string | null) => void;
}) {
  const inputId = useId();
  const items: Array<{ what: ShowcaseWhat; title: string }> = [
    { what: persona === "academy" ? "academyFrame" : "cornerCrest", title: copy.duringClip },
    { what: "signOff", title: copy.endOfClip },
  ];

  return (
    <div className="dm-brandtry" data-testid="branding-studio">
      <div className="dm-brandtry-form">
        <label className="dm-brandtry-title" htmlFor={inputId}>{copy.tryTitle[persona]}</label>
        <input
          id={inputId}
          className="dm-text-input"
          value={name}
          maxLength={28}
          placeholder={copy.namePlaceholder[persona]}
          onChange={(event) => onName(event.target.value)}
          autoComplete="off"
          data-testid="branding-name"
        />
        <div className="dm-swatches" role="group" aria-label={copy.colorLabel}>
          {BRAND_SWATCHES.map((swatch, index) => {
            const on = (color ?? BRAND_SWATCHES[0]) === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={`dm-swatch ${on ? "is-on" : ""}`}
                style={{ backgroundColor: swatch }}
                aria-pressed={on}
                aria-label={`${copy.colorLabel} ${swatch}`}
                onClick={() => onColor(index === 0 && !name.trim() ? null : swatch)}
              />
            );
          })}
        </div>
        <p className="dm-small">{copy.platforms}</p>
      </div>
      <div className="dm-brandtry-previews">
        {items.map((item) => (
          <Preview key={item.what} {...item} name={name} color={color} persona={persona} />
        ))}
      </div>
    </div>
  );
}

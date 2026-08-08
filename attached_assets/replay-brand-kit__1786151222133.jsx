import React, { useState } from "react";
import { Play, Users, Scissors, Radio, Copy, Check } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Design tokens — every color in this file traces back to one of these */
/* ------------------------------------------------------------------ */
const TOKENS = {
  void: "#0B0F1A",
  surface: "#141B2C",
  surface2: "#1B2438",
  border: "#232C42",
  ink: "#8A93A6",
  white: "#F3F6FA",
  floodlight: "#D4FF4F",
  stoppage: "#7B5CFF",
  live: "#FF5A3C",
  turf: "#2FD8C4",
};

const FONT_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&family=Cairo:wght@800;900&family=Tajawal:wght@400;500;700&display=swap');";

const FONT_EN_DISPLAY = "'Rajdhani', sans-serif";
const FONT_EN_BODY = "'Inter', sans-serif";
const FONT_AR_DISPLAY = "'Cairo', sans-serif";
const FONT_AR_BODY = "'Tajawal', sans-serif";

/* ------------------------------------------------------------------ */
/* Logo mark — a faceted (low-poly) sphere: seven flat-shaded hexagon */
/* panels lit from the top right (toward Floodlight) and shadowed     */
/* toward the bottom left (toward Stoppage Violet), a play blade      */
/* breaking the right edge of the ball, and a live/record dot.        */
/* ------------------------------------------------------------------ */
function hexPoints(cx, cy, s) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

const FACETS = [
  { cx: 95, cy: 96, color: "#22C7B5" }, // core
  { cx: 126.2, cy: 42, color: "#BFFF5C" }, // upper right — lit, toward Floodlight
  { cx: 63.8, cy: 42, color: "#3FE0C9" }, // upper left
  { cx: 157.4, cy: 96, color: "#1FA79B" }, // right
  { cx: 32.6, cy: 96, color: "#186E7E" }, // left — shadow
  { cx: 126.2, cy: 150, color: "#1C8AA0" }, // lower right
  { cx: 63.8, cy: 150, color: "#6C4FE0" }, // lower left — shadow, toward Stoppage Violet
];

function LogoMark({ size = 96 }) {
  return (
    <div style={{ width: size, height: size * (200 / 220), flexShrink: 0 }}>
      <svg viewBox="-5 0 225 200" width="100%" height="100%">
        <defs>
          <clipPath id="ballClip">
            <circle cx="95" cy="96" r="88" />
          </clipPath>
        </defs>
        <g clipPath="url(#ballClip)">
          {FACETS.map((f, i) => (
            <polygon
              key={i}
              points={hexPoints(f.cx, f.cy, 36)}
              fill={f.color}
              stroke={TOKENS.void}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          ))}
        </g>
        <circle cx="95" cy="96" r="88" fill="none" stroke={TOKENS.void} strokeWidth="3" opacity="0.35" />
        {/* play blade, popping off the ball's right edge */}
        <polygon
          points="170,62 170,134 210,98"
          fill={TOKENS.void}
          stroke={TOKENS.void}
          strokeWidth="16"
          strokeLinejoin="round"
        />
        <polygon
          points="172,68 172,128 206,98"
          fill={TOKENS.floodlight}
          stroke={TOKENS.floodlight}
          strokeWidth="12"
          strokeLinejoin="round"
        />
        {/* record / live dot */}
        <circle cx="178" cy="46" r="7.5" fill={TOKENS.void} />
        <circle cx="178" cy="46" r="5.5" fill={TOKENS.live} className="animate-pulse" />
      </svg>
    </div>
  );
}

function Lockup({ size = 72, arabicSize = "2.1rem" }) {
  return (
    <div className="flex items-center gap-4">
      <LogoMark size={size} />
      <div>
        <div
          dir="rtl"
          style={{
            fontFamily: FONT_AR_DISPLAY,
            fontWeight: 900,
            fontSize: arabicSize,
            lineHeight: 1,
            backgroundImage: `linear-gradient(90deg, ${TOKENS.turf}, ${TOKENS.stoppage})`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          ريبلاي
        </div>
        <div
          style={{
            fontFamily: FONT_EN_DISPLAY,
            fontWeight: 700,
            fontSize: "0.8rem",
            letterSpacing: "0.4em",
            color: TOKENS.ink,
            marginTop: "0.35rem",
          }}
        >
          REPLAY
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section shell                                                      */
/* ------------------------------------------------------------------ */
function Section({ eyebrow, title, children }) {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-14">
      <p
        style={{ fontFamily: FONT_EN_DISPLAY, color: TOKENS.turf, fontWeight: 600, letterSpacing: "0.3em" }}
        className="text-xs uppercase mb-2"
      >
        {eyebrow}
      </p>
      <h2
        style={{ fontFamily: FONT_EN_DISPLAY, color: TOKENS.white, fontWeight: 700 }}
        className="text-3xl md:text-4xl mb-8"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Color palette                                                      */
/* ------------------------------------------------------------------ */
const PALETTE = [
  { name: "Floodlight", hex: TOKENS.floodlight, role: "Primary", usage: "Play buttons, active states, one CTA per screen." },
  { name: "Stoppage Violet", hex: TOKENS.stoppage, role: "Secondary", usage: "Clips, saved highlights, premium tiers." },
  { name: "Live", hex: TOKENS.live, role: "Functional only", usage: "Broadcast dot and record state. Never decorative." },
  { name: "Turf", hex: TOKENS.turf, role: "Brand mark", usage: "Reserved for the logo and gradient accents — not a UI action color." },
  { name: "Surface", hex: TOKENS.surface, role: "Elevation", usage: "Cards, sheets, and modals sitting above the Void." },
  { name: "Void", hex: TOKENS.void, role: "Base", usage: "The app background. Every screen sits on this." },
];

function SwatchCard({ name, hex, role, usage }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      /* clipboard unavailable — silently ignore */
    }
  };
  const lightText = ["Floodlight", "Turf"].includes(name);
  return (
    <div className="rounded-2xl overflow-hidden border" style={{ borderColor: TOKENS.border, backgroundColor: TOKENS.surface }}>
      <button
        onClick={handleCopy}
        className="relative w-full h-24 flex items-start justify-end p-3 group"
        style={{ backgroundColor: hex }}
      >
        <span
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest rounded-full px-2 py-1 opacity-80 group-hover:opacity-100 transition-opacity"
          style={{
            backgroundColor: lightText ? "rgba(11,15,26,0.75)" : "rgba(255,255,255,0.18)",
            color: lightText ? TOKENS.white : TOKENS.white,
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
      <div className="p-4">
        <div className="flex items-baseline justify-between">
          <h3 style={{ fontFamily: FONT_EN_BODY, color: TOKENS.white, fontWeight: 600 }} className="text-sm">
            {name}
          </h3>
          <span style={{ fontFamily: FONT_EN_BODY, color: TOKENS.turf }} className="text-xs">
            {hex}
          </span>
        </div>
        <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-[11px] uppercase tracking-wider mt-1">
          {role}
        </p>
        <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-xs mt-2 leading-relaxed">
          {usage}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Typography scale                                                   */
/* ------------------------------------------------------------------ */
function TypeBlock({ dir, label, faceLabel, children }) {
  return (
    <div dir={dir} className="py-4 border-b" style={{ borderColor: TOKENS.border }}>
      <div className="flex items-baseline justify-between mb-1">
        <span style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-[11px] uppercase tracking-wider">
          {label}
        </span>
        <span style={{ fontFamily: FONT_EN_BODY, color: TOKENS.turf }} className="text-[11px]">
          {faceLabel}
        </span>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Real-world UI preview                                              */
/* ------------------------------------------------------------------ */
function LiveMatchCard() {
  return (
    <div className="rounded-2xl overflow-hidden border max-w-md" style={{ borderColor: TOKENS.border, backgroundColor: TOKENS.surface }}>
      <div
        className="relative h-48"
        style={{
          backgroundImage: `radial-gradient(circle at 75% 25%, ${TOKENS.turf}33, transparent 60%), radial-gradient(circle at 20% 80%, ${TOKENS.stoppage}26, transparent 55%), ${TOKENS.void}`,
        }}
      >
        <div
          className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 border backdrop-blur"
          style={{ backgroundColor: "rgba(11,15,26,0.7)", borderColor: `${TOKENS.live}66` }}
        >
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: TOKENS.live }} />
          <span style={{ fontFamily: FONT_EN_DISPLAY, color: TOKENS.live, fontWeight: 700 }} className="text-[11px] tracking-widest">
            LIVE
          </span>
        </div>
        <div
          className="absolute top-3 right-3 flex items-center gap-1 rounded-full px-2.5 py-1"
          style={{ backgroundColor: "rgba(11,15,26,0.7)", color: TOKENS.ink }}
        >
          <Users size={12} />
          <span style={{ fontFamily: FONT_EN_BODY }} className="text-[11px]">1,204</span>
        </div>
        <button
          className="absolute inset-0 m-auto w-14 h-14 rounded-full flex items-center justify-center"
          style={{ backgroundColor: `${TOKENS.floodlight}E6` }}
          aria-label="Watch live"
        >
          <Play size={22} color={TOKENS.void} fill={TOKENS.void} />
        </button>
        <div
          className="absolute bottom-0 left-0 right-0 p-3"
          style={{ backgroundImage: `linear-gradient(180deg, transparent, ${TOKENS.void}F2)` }}
        >
          <p dir="rtl" style={{ fontFamily: FONT_AR_BODY, color: TOKENS.white, fontWeight: 700 }} className="text-sm">
            الأهلي ضد الوحدات
          </p>
          <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-[11px] mt-0.5">
            Camera 2 · Al Hussein Stadium
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2.5 p-3">
        <button
          className="flex-1 flex items-center justify-center gap-2 rounded-full py-2.5 font-semibold text-sm"
          style={{ backgroundColor: TOKENS.floodlight, color: TOKENS.void, fontFamily: FONT_EN_BODY }}
        >
          <Play size={14} fill={TOKENS.void} /> Watch Live
        </button>
        <button
          className="flex-1 flex items-center justify-center gap-2 rounded-full py-2.5 font-semibold text-sm border"
          style={{ borderColor: TOKENS.stoppage, color: TOKENS.stoppage, fontFamily: FONT_EN_BODY }}
        >
          <Scissors size={14} /> Save Clip
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                          */
/* ------------------------------------------------------------------ */
export default function ReplayBrandKit() {
  return (
    <div style={{ backgroundColor: TOKENS.void, minHeight: "100%" }}>
      <style>{FONT_IMPORT}</style>

      {/* header */}
      <header className="border-b" style={{ borderColor: TOKENS.border }}>
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <LogoMark size={34} />
            <span style={{ fontFamily: FONT_EN_DISPLAY, color: TOKENS.white, fontWeight: 600 }} className="text-sm tracking-wide">
              Replay — Brand Kit
            </span>
          </div>
          <span style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-xs hidden sm:block">
            Identity system · v1.0
          </span>
        </div>
      </header>

      {/* hero */}
      <div className="mx-auto max-w-6xl px-6 pt-16 pb-6">
        <Lockup size={104} arabicSize="3rem" />
        <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="max-w-xl mt-6 text-sm leading-relaxed">
          A faceted mark for a platform built on captured moments: a low-poly ball lit toward Floodlight and
          shadowed toward Stoppage Violet, with a play blade breaking its edge and a live dot standing in for
          the record state. Flat, scalable, no gloss.
        </p>

        <div className="flex items-end gap-6 mt-10">
          <div className="text-center">
            <div className="rounded-3xl p-6 border" style={{ borderColor: TOKENS.border, backgroundColor: TOKENS.surface }}>
              <LogoMark size={96} />
            </div>
            <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-[11px] mt-2">Hero</p>
          </div>
          <div className="text-center">
            <div className="rounded-2xl p-3 border" style={{ borderColor: TOKENS.border, backgroundColor: TOKENS.surface }}>
              <LogoMark size={40} />
            </div>
            <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-[11px] mt-2">App icon</p>
          </div>
          <div className="text-center">
            <div className="rounded-lg p-1.5 border" style={{ borderColor: TOKENS.border, backgroundColor: TOKENS.surface }}>
              <LogoMark size={20} />
            </div>
            <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-[11px] mt-2">Favicon</p>
          </div>
        </div>
      </div>

      <Section eyebrow="01 — Color" title="Signal System">
        <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-sm mb-8 max-w-2xl">
          Three functional signals govern every interactive screen; Turf, Surface, and Void carry the brand
          and the structure around them. Tap a swatch to copy its hex.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {PALETTE.map((p) => (
            <SwatchCard key={p.name} {...p} />
          ))}
        </div>
      </Section>

      <Section eyebrow="02 — Type" title="Typography System">
        <div className="grid md:grid-cols-2 gap-10">
          <div>
            <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.turf }} className="text-xs uppercase tracking-widest mb-3">
              English — Rajdhani / Inter
            </p>
            <TypeBlock label="Headline" faceLabel="Rajdhani 700">
              <h3 style={{ fontFamily: FONT_EN_DISPLAY, color: TOKENS.white, fontWeight: 700 }} className="text-4xl uppercase tracking-wide">
                Match Day
              </h3>
            </TypeBlock>
            <TypeBlock label="Subtitle" faceLabel="Rajdhani 600">
              <h4 style={{ fontFamily: FONT_EN_DISPLAY, color: TOKENS.white, fontWeight: 600 }} className="text-xl">
                Every touch, saved
              </h4>
            </TypeBlock>
            <TypeBlock label="Body" faceLabel="Inter 400">
              <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-sm leading-relaxed">
                Cameras at the pitch record continuously. Players clip their own highlights the moment play stops.
              </p>
            </TypeBlock>
          </div>

          <div dir="rtl">
            <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.turf }} className="text-xs uppercase tracking-widest mb-3" dir="ltr">
              Arabic — Cairo / Tajawal
            </p>
            <TypeBlock dir="rtl" label="عنوان" faceLabel="Cairo 800">
              <h3 style={{ fontFamily: FONT_AR_DISPLAY, color: TOKENS.white, fontWeight: 800 }} className="text-4xl">
                يوم المباراة
              </h3>
            </TypeBlock>
            <TypeBlock dir="rtl" label="عنوان فرعي" faceLabel="Tajawal 700">
              <h4 style={{ fontFamily: FONT_AR_BODY, color: TOKENS.white, fontWeight: 700 }} className="text-xl">
                كل لمسة، محفوظة
              </h4>
            </TypeBlock>
            <TypeBlock dir="rtl" label="النص الأساسي" faceLabel="Tajawal 400">
              <p style={{ fontFamily: FONT_AR_BODY, color: TOKENS.ink }} className="text-sm leading-relaxed">
                الكاميرات في الملعب تسجل باستمرار. يقوم اللاعبون بقص أبرز لحظاتهم فور توقف اللعب.
              </p>
            </TypeBlock>
          </div>
        </div>
      </Section>

      <Section eyebrow="03 — Applied" title="On Screen">
        <div className="flex flex-wrap gap-8 items-start">
          <LiveMatchCard />
          <div className="max-w-sm">
            <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-sm leading-relaxed">
              Floodlight carries the one primary action on screen — here, joining the live stream. Stoppage
              Violet marks the secondary path into saved clips. Live red never sits on a button; it only ever
              marks that something is actually broadcasting right now.
            </p>
          </div>
        </div>
      </Section>

      <footer className="border-t py-8 text-center" style={{ borderColor: TOKENS.border }}>
        <p style={{ fontFamily: FONT_EN_BODY, color: TOKENS.ink }} className="text-xs">
          Replay Brand Kit · Amman, Jordan
        </p>
      </footer>
    </div>
  );
}

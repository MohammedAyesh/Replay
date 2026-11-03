import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { fillText, resolveColor, type CreativeBrand, type CreativeData, type SceneLayer } from "@workspace/api-zod";
import {
  baselineIn,
  displayText,
  fontFace,
  hasArabic,
  isolateLtrRuns,
  layoutText,
  textDirection,
  type FontFace,
  type TextLayout,
} from "./layout";
import { roundRectPath } from "./shapes";
import { installLibraryFontFaces, libraryCssFont, libraryFontsVersion, requestLibraryFace, subscribeLibraryFonts } from "./library-fonts";

type TextLayer = Extract<SceneLayer, { kind: "text" }>;

/**
 * Text layers in the DOM, laid out with the same maths as the API's renderer
 * (layout.ts), measured with a canvas in the same faces the app loads from
 * Google Fonts (index.css: Rajdhani 600/700, Cairo 700/800). The API draws
 * Cairo's 900 where the browser has 800; otherwise the faces are the same.
 * A layer's `family` uses the Creative font library: the very files the API
 * draws with, served by the API (library-fonts.ts).
 */

const CSS_FAMILY: Record<"rajdhani" | "cairo", string> = { rajdhani: "Rajdhani", cairo: "Cairo" };
/** The weights the app loads; the server's Cairo 900 shows as 800 here. */
const cssWeight = (face: FontFace) => (face.family === "cairo" ? (face.weight === 900 ? 800 : 700) : face.weight === 600 ? 600 : 700);
const ITALIC_SKEW_DEG = -Math.atan(0.25) * (180 / Math.PI);

export const cssFont = (face: FontFace, size: number) => {
  if (face.family === "library") {
    requestLibraryFace(face);
    return libraryCssFont(face, size);
  }
  return `${cssWeight(face)} ${size}px ${CSS_FAMILY[face.family]}`;
};

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** Width of `text` in a face, with letter spacing added per character as both canvas and CSS do. */
function measure(face: FontFace, text: string, size: number, spacing: number): number {
  const c = ctx2d();
  const chars = [...text].length;
  if (!c) return text.length * size * 0.5 + spacing * chars;
  c.font = cssFont(face, size);
  return c.measureText(text).width + spacing * chars;
}

function fontMetrics(face: FontFace, size: number): { ascent: number; descent: number } {
  const c = ctx2d();
  if (!c) return { ascent: size * 0.8, descent: size * 0.2 };
  c.font = cssFont(face, size);
  const m = c.measureText("Hg");
  return { ascent: m.fontBoundingBoxAscent || size * 0.8, descent: m.fontBoundingBoxDescent || size * 0.2 };
}

const FONT_LOADS = ["600 40px Rajdhani", "700 40px Rajdhani", "700 40px Cairo", "800 40px Cairo"];
let fontsReady = false;
const fontsListeners = new Set<() => void>();
let fontsStarted = false;

/**
 * Re-renders once the scene's faces have loaded, so layout is measured in the
 * right font: 0 until the house faces are in, then it changes again every time
 * a library face arrives. Pass it to TextLayerView as `fonts`.
 */
export function useFontsReady(): number {
  const [ready, setReady] = useState(fontsReady);
  const library = useSyncExternalStore(subscribeLibraryFonts, libraryFontsVersion, libraryFontsVersion);
  useEffect(() => { installLibraryFontFaces(); }, []);
  useEffect(() => {
    if (fontsReady) { setReady(true); return; }
    const done = () => setReady(true);
    fontsListeners.add(done);
    if (!fontsStarted && typeof document !== "undefined" && document.fonts) {
      fontsStarted = true;
      void Promise.all(FONT_LOADS.map((f) => document.fonts.load(f).catch(() => [])))
        .finally(() => { fontsReady = true; fontsListeners.forEach((l) => l()); fontsListeners.clear(); });
    } else if (typeof document === "undefined" || !document.fonts) {
      fontsReady = true;
      done();
    }
    return () => { fontsListeners.delete(done); };
  }, []);
  return ready ? 1 + library : 0;
}

export type PreparedText = {
  text: string;
  dir: "ltr" | "rtl";
  face: FontFace;
  layout: TextLayout;
  spacing: number;
};

export function prepareText(layer: TextLayer, data: CreativeData): PreparedText | null {
  const text = displayText(layer, fillText(layer.text, data, false));
  if (!text.trim()) return null;
  const dir = textDirection(layer, text);
  const face = fontFace(layer, text);
  const arabic = face.arabic;
  const spacingAt = (size: number) => (!hasArabic(text) && layer.letterSpacing ? (layer.letterSpacing * size) / layer.size : 0);
  const shown = (line: string) => (dir === "rtl" ? isolateLtrRuns(line) : line);
  const layout = layoutText(layer, text, dir, arabic, (t, size) => measure(face, shown(t), size, spacingAt(size)));
  return { text, dir, face, layout, spacing: spacingAt(layout.size) };
}

export function TextLayerView({ layer, brand, data, fonts, hidden }: {
  layer: TextLayer;
  brand: CreativeBrand;
  data: CreativeData;
  /** Changes when fonts finish loading, to measure again (useFontsReady). */
  fonts: number;
  /** Inline editing hides the drawn text. */
  hidden?: boolean;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prepared = useMemo(() => prepareText(layer, data), [layer, data, fonts]);
  if (!prepared || hidden) return null;
  const { layout, face, dir } = prepared;
  const { ascent, descent } = fontMetrics(face, layout.size);
  const k = layout.size / layer.size;
  const color = resolveColor(layer.color, brand, "#0B0F1A");
  const stroke = layer.stroke && layer.stroke.width > 0 ? layer.stroke : null;
  const shadow = layer.shadow;
  const lineStyle: CSSProperties = {
    position: "absolute",
    height: layout.lineHeight,
    // The font shorthand resets line-height, so it comes first.
    font: cssFont(face, layout.size),
    lineHeight: `${layout.lineHeight}px`,
    whiteSpace: "pre",
    letterSpacing: prepared.spacing ? `${prepared.spacing}px` : undefined,
    color,
    textAlign: "left",
    ...(stroke ? { WebkitTextStroke: `${stroke.width * 2 * k}px ${resolveColor(stroke.color, brand, "#000000")}`, paintOrder: "stroke fill" } : {}),
    ...(shadow ? { textShadow: `${shadow.x * k}px ${shadow.y * k}px ${shadow.blur * k}px ${resolveColor(shadow.color, brand, "#000000")}` } : {}),
  };
  const baseline = baselineIn(0, layout.lineHeight, ascent, descent);
  return (
    <>
      {layer.background ? (
        <svg className="pointer-events-none absolute" style={{ left: 0, top: 0, overflow: "visible" }} width={layer.w} height={layer.h} aria-hidden>
          <path d={roundRectPath(layout.block.x, layout.block.y, layout.block.w, layout.block.h, layer.background.radius)}
            fill={resolveColor(layer.background.color, brand, "#000000")} />
        </svg>
      ) : null}
      {layout.lines.map((line, i) => (line ? (
        <div key={i} dir={dir} style={{
          ...lineStyle,
          left: layout.positions[i].x,
          top: layout.positions[i].top,
          width: layout.widths[i],
          ...(face.italic ? { transform: `skewX(${ITALIC_SKEW_DEG}deg)`, transformOrigin: `0 ${baseline}px` } : {}),
        }}>
          {dir === "rtl" ? isolateLtrRuns(line) : line}
        </div>
      ) : null))}
    </>
  );
}

/** The raw text (bindings kept) in a textarea over the layer, styled like the layer. */
export function TextEditor({ layer, brand, onDone }: { layer: TextLayer; brand: CreativeBrand; onDone: (text: string | null) => void }) {
  const [value, setValue] = useState(layer.text);
  const face = fontFace(layer, layer.text);
  const dir = textDirection(layer, layer.text);
  return (
    <textarea
      autoFocus
      dir={dir}
      value={value}
      data-testid="scene-canvas-text-editor"
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onDone(null); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onDone(value); }
      }}
      onBlur={() => onDone(value)}
      style={{
        position: "absolute", inset: 0, width: layer.w, height: layer.h, resize: "none", overflow: "hidden",
        background: "rgba(11,15,26,0.35)", outline: "none", border: "none", padding: 0, margin: 0,
        font: cssFont(face, Math.min(layer.size, Math.max(12, layer.h * 0.8))),
        color: resolveColor(layer.color, brand, "#0B0F1A"),
        textAlign: layer.align === "center" ? "center" : layer.align === "end" ? "end" : "start",
        lineHeight: 1.15,
      }}
    />
  );
}

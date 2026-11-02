import { useId } from "react";
import { resolveColor, type CreativeBrand, type SceneLayer } from "@workspace/api-zod";
import { gradientPoints, lineGeometry, slantPoints } from "./layout";

type ShapeLayer = Extract<SceneLayer, { kind: "shape" }>;

/** The rounded rectangle the API draws (clipBranding/draw.ts roundRect: quadratic corners), as an SVG path. */
export function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M${x + rr},${y}`, `L${x + w - rr},${y}`, `Q${x + w},${y} ${x + w},${y + rr}`,
    `L${x + w},${y + h - rr}`, `Q${x + w},${y + h} ${x + w - rr},${y + h}`,
    `L${x + rr},${y + h}`, `Q${x},${y + h} ${x},${y + h - rr}`,
    `L${x},${y + rr}`, `Q${x},${y} ${x + rr},${y}`, "Z",
  ].join(" ");
}

/**
 * A shape layer as SVG, with the API renderer's geometry: strokes inside the
 * box (the path inset by half the stroke), gradients along the CSS angle,
 * slants and lines as layout.ts defines them.
 */
export function ShapeView({ layer, brand }: { layer: ShapeLayer; brand: CreativeBrand }) {
  const gid = useId().replace(/:/g, "");
  const { w, h } = layer;
  const g = layer.gradient ? gradientPoints(w, h, layer.gradient.angle ?? 180) : null;
  const fillPaint = g ? `url(#g${gid})` : layer.fill ? resolveColor(layer.fill, brand, "#000000") : "none";
  const sw = layer.stroke && layer.stroke.width > 0 ? layer.stroke.width : 0;
  const strokeColor = layer.stroke ? resolveColor(layer.stroke.color, brand, "#000000") : "none";

  const shapeAt = (inset: number, props: Record<string, string | number>) => {
    if (layer.shape === "ellipse") {
      return <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - inset)} ry={Math.max(0, h / 2 - inset)} {...props} />;
    }
    if (layer.shape === "slant") {
      const pts = slantPoints(w - inset * 2, h - inset * 2, layer.skew ?? 12).map(([x, y]) => `${x + inset},${y + inset}`).join(" ");
      return <polygon points={pts} {...props} />;
    }
    return <path d={roundRectPath(inset, inset, w - inset * 2, h - inset * 2, Math.max(0, (layer.radius ?? 0) - inset))} {...props} />;
  };

  let body;
  if (layer.shape === "line") {
    const l = lineGeometry(w, h, layer.stroke?.width);
    const c = layer.stroke?.color ?? layer.fill ?? layer.gradient?.from ?? "@ink";
    const paint = layer.gradient && !layer.stroke ? `url(#g${gid})` : resolveColor(c, brand, "#000000");
    body = <line x1={l.x0} y1={l.y0} x2={l.x1} y2={l.y1} stroke={paint} strokeWidth={l.width} strokeLinecap="butt" />;
  } else {
    body = (
      <>
        {fillPaint !== "none" ? shapeAt(0, { fill: fillPaint }) : null}
        {sw ? shapeAt(sw / 2, { fill: "none", stroke: strokeColor, strokeWidth: sw, strokeLinejoin: "miter" }) : null}
      </>
    );
  }
  return (
    <svg className="pointer-events-none absolute" style={{ left: 0, top: 0, overflow: "visible" }} width={w} height={h} aria-hidden>
      {g && layer.gradient ? (
        <defs>
          <linearGradient id={`g${gid}`} gradientUnits="userSpaceOnUse" x1={g.x0} y1={g.y0} x2={g.x1} y2={g.y1}>
            <stop offset="0" stopColor={resolveColor(layer.gradient.from, brand, "#000000")} />
            <stop offset="1" stopColor={resolveColor(layer.gradient.to, brand, "#000000")} />
          </linearGradient>
        </defs>
      ) : null}
      {body}
    </svg>
  );
}

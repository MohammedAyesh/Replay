import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CREATIVE_FORMATS,
  isVideoScene,
  layerShownFor,
  layerVisibleAt,
  parsePlateKey,
  PLATE_LAYER_ID,
  resolveColor,
  resolveSource,
  resolveTint,
  slowZoomAt,
  slowZoomOrigin,
  slowZoomsLayer,
  type CreativeBrand,
  type CreativeData,
  type Scene,
  type SceneLayer,
} from "@workspace/api-zod";
import { withMediaVariant } from "@/lib/creative-hub-media";
import { moveBox, resizeBox, rotationTo, tidy, type Box, type Corner, type Snap } from "./canvas/editing";
import { blurAt, entranceAt } from "./canvas/layout";
import { fadeAt } from "@workspace/api-zod";
import { ImageView, VideoView } from "./canvas/media";
import { ShapeView } from "./canvas/shapes";
import { TextEditor, TextLayerView, useFontsReady } from "./canvas/text";

/**
 * Live preview of a scene, drawn with the DOM at any width (scaled from the
 * 1080-wide canvas). The API's renderer draws the same scene for export.
 * Props are frozen: Editor, Templates, For you and Publish all rely on them.
 */
export type SceneCanvasProps = {
  scene: Scene;
  brand: CreativeBrand;
  data?: CreativeData;
  /** Display width in CSS pixels. */
  width: number;
  /** Current time for video scenes (ms). Ignored for stills. */
  timeMs?: number;
  playing?: boolean;
  /** Resolves a media source to a URL the browser can load (thumb for stills, video for clips). */
  mediaUrl?: (layer: Extract<SceneLayer, { kind: "image" | "video" }>) => string | null;
  editable?: boolean;
  selectedLayerId?: string | null;
  onSelectLayer?: (id: string | null) => void;
  /** Drag / resize result, in canvas pixels. */
  onLayerChange?: (id: string, change: Partial<Pick<SceneLayer, "x" | "y" | "w" | "h" | "rotation">>) => void;
  /** Inline text edit result. */
  onTextChange?: (id: string, text: string) => void;
  className?: string;
};

/*
 * How it is built (Engine):
 *   - One stage div at true canvas size (1080 × H) scaled to `width`, so every
 *     layer is placed in design pixels exactly as the API draws it. The stage
 *     is dir="ltr" on purpose: scene coordinates are physical; each text line
 *     carries its own direction.
 *   - Text uses the API's layout maths (canvas/layout.ts) measured in the same
 *     faces, shapes are SVG with the API's geometry, images use object-fit,
 *     footage is a <video> on the scene clock.
 *   - {{bindings}} are filled with fillText(text, data, false); binding media
 *     sources are resolved with `data` before `mediaUrl` sees the layer, so
 *     mediaUrl always gets a concrete source. No URL → a neutral placeholder.
 *   - Tinted image layers and background plates: the URL mediaUrl returns
 *     gets the scene format and the tint (brand tokens resolved with `brand`)
 *     added (withMediaVariant), so the server sends the picture recoloured by
 *     the same code the export uses. A plate that fails to load draws nothing,
 *     as in the export. A locked plate ignores the pointer, so a tap on the
 *     background still clears the selection.
 *   - Editing: click selects, drag moves (centre snaps to the canvas centre
 *     lines), corner handles resize in the layer's rotated frame (Shift keeps
 *     the aspect), the knob rotates (snaps to right angles; Shift = 15° steps),
 *     double-click edits text in place (⌘/Ctrl+Enter or click away saves, Esc
 *     cancels). Locked layers select but never move. A gesture is reported
 *     once, when it ends.
 *   - Slow zoom (video scenes with scene.slowZoom): the background and
 *     full-bleed photos (slowZoomsLayer) scale by slowZoomAt(t) about
 *     slowZoomOrigin, the same numbers the export's zoompan and frame
 *     previews use.
 */

type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;
type Gesture = { id: string; box: Box; snap: Snap; committed?: boolean };

const EMPTY_DATA: CreativeData = {};
const NO_SNAP: Snap = { x: false, y: false };
const FLOODLIGHT = "#D4FF4F";
const VIOLET = "#7B5CFF";
const CORNERS: Corner[] = ["nw", "ne", "se", "sw"];

const boxOfLayer = (l: SceneLayer): Box => ({ x: l.x, y: l.y, w: l.w, h: l.h, rotation: l.rotation ?? 0 });

export function SceneCanvas({
  scene, brand, data, width, timeMs, playing = false, mediaUrl, editable = false,
  selectedLayerId = null, onSelectLayer, onLayerChange, onTextChange, className,
}: SceneCanvasProps) {
  const { w: W, h: H } = CREATIVE_FORMATS[scene.format] ?? CREATIVE_FORMATS.post;
  const scale = width / W;
  const height = H * scale;
  const fonts = useFontsReady();
  const d = data ?? EMPTY_DATA;
  const video = isVideoScene(scene);
  const t = video ? timeMs ?? 0 : null;
  const rootRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // A finished gesture stays drawn until the new layer comes back from the parent.
  useEffect(() => {
    if (!gesture?.committed) return;
    const timer = setTimeout(() => setGesture(null), 600);
    return () => clearTimeout(timer);
  }, [gesture]);
  useEffect(() => {
    setGesture((g) => (g?.committed ? null : g));
  }, [scene.layers]);

  // Layers with a `when` show only for data that meets it (a line-up's photo tiles), as in the export.
  const visible = scene.layers.filter((l) => layerVisibleAt(l, t) && layerShownFor(l, d));
  const boxOf = (l: SceneLayer): Box => (gesture?.id === l.id ? gesture.box : boxOfLayer(l));

  const toCanvas = useCallback((clientX: number, clientY: number): [number, number] => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return [0, 0];
    return [(clientX - r.left) / scale, (clientY - r.top) / scale];
  }, [scale]);

  const startGesture = (kind: "move" | "rotate" | Corner, layer: SceneLayer, e: ReactPointerEvent) => {
    const start = boxOfLayer(layer);
    const [sx, sy] = toCanvas(e.clientX, e.clientY);
    let moved = false;
    let latest = start;
    const move = (ev: PointerEvent) => {
      const [px, py] = toCanvas(ev.clientX, ev.clientY);
      let snap = NO_SNAP;
      if (kind === "move") {
        if (!moved && Math.hypot(px - sx, py - sy) * scale < 3) return;
        const r = moveBox(start, px - sx, py - sy, { w: W, h: H }, 8 / scale);
        latest = r.box;
        snap = r.snap;
      } else if (kind === "rotate") {
        latest = { ...start, rotation: rotationTo(start, px, py, ev.shiftKey) };
      } else {
        latest = resizeBox(start, kind, px, py, ev.shiftKey);
      }
      moved = true;
      setGesture({ id: layer.id, box: latest, snap });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!moved) { setGesture(null); return; }
      const b = tidy(latest);
      setGesture({ id: layer.id, box: b, snap: NO_SNAP, committed: true });
      onLayerChange?.(layer.id, kind === "move" ? { x: b.x, y: b.y } : kind === "rotate" ? { rotation: b.rotation } : { x: b.x, y: b.y, w: b.w, h: b.h });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const urlFor = (layer: MediaLayer): string | null => {
    const src = resolveSource(layer.src, d);
    if (!src || !mediaUrl) return null;
    const url = mediaUrl({ ...layer, src } as MediaLayer);
    if (layer.kind !== "image") return url;
    const plate = src.type === "artwork" && !!parsePlateKey(src.key);
    const tint = resolveTint(layer.tint, brand);
    // Covering a box of another shape needs up to ~1.5× its longest side; device pixels, not CSS pixels.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const size = Math.ceil(Math.max(layer.w, layer.h) * scale * dpr * 1.5);
    return plate || tint ? withMediaVariant(url, { format: plate ? scene.format : undefined, tint, size }) : url;
  };
  const isPlate = (layer: MediaLayer) => {
    const src = resolveSource(layer.src, d);
    return layer.kind === "image" && src?.type === "artwork" && !!parsePlateKey(src.key);
  };

  const isFootage = (layer: MediaLayer) => {
    const src = resolveSource(layer.src, d);
    return layer.kind === "video" && !!src && (src.type === "clip" || src.type === "recording" || src.type === "upload");
  };

  const selected = editable && selectedLayerId ? visible.find((l) => l.id === selectedLayerId) ?? null : null;

  return (
    <div
      ref={rootRef}
      className={className}
      data-testid="scene-canvas"
      dir="ltr"
      style={{ position: "relative", width, height, touchAction: editable ? "none" : undefined, userSelect: "none" }}
      onPointerDown={editable ? () => { onSelectLayer?.(null); } : undefined}
    >
      <div className="absolute inset-0 overflow-hidden">
        <div style={{
          position: "absolute", left: 0, top: 0, width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0",
          background: resolveColor(scene.background, brand, "#FFFFFF"),
        }}>
          {visible.map((layer) => {
            const box = boxOf(layer);
            const enter = video && timeMs !== undefined ? entranceAt(layer, t ?? 0, { w: W, h: H }) : { alpha: 1, dx: 0, dy: 0 };
            const zoom = video && timeMs !== undefined && gesture?.id !== layer.id && layer.kind === "image" && slowZoomsLayer(layer, resolveSource(layer.src, d), scene.format)
              ? slowZoomAt(scene, t ?? 0) : 1;
            const origin = zoom !== 1 ? slowZoomOrigin(layer, scene.format) : null;
            const fade = video && timeMs !== undefined ? fadeAt(layer, t ?? 0, scene.durationMs ?? 0) : 1;
            const alpha = (layer.opacity ?? 1) * enter.alpha * fade;
            const editing = editingId === layer.id && layer.kind === "text";
            const interactive = editable && !(layer.id === PLATE_LAYER_ID && layer.locked);
            return (
              <div
                key={layer.id}
                data-testid={`scene-layer-${layer.id}`}
                onPointerDown={interactive ? (e) => {
                  e.stopPropagation();
                  if (editing || e.button !== 0) return;
                  onSelectLayer?.(layer.id);
                  if (!layer.locked) startGesture("move", layer, e);
                } : undefined}
                onDoubleClick={editable && layer.kind === "text" && onTextChange ? (e) => { e.stopPropagation(); setEditingId(layer.id); } : undefined}
                style={{
                  position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
                  transform: `translate(${enter.dx}px, ${enter.dy}px) rotate(${box.rotation}deg)${zoom !== 1 ? ` scale(${zoom})` : ""}`,
                  transformOrigin: origin ? `${origin.x - box.x}px ${origin.y - box.y}px` : "50% 50%",
                  opacity: alpha,
                  pointerEvents: interactive ? "auto" : "none",
                  cursor: interactive ? (layer.locked ? "default" : "move") : undefined,
                }}
              >
                {layer.kind === "shape" ? <ShapeView layer={{ ...layer, w: box.w, h: box.h }} brand={brand} />
                  : layer.kind === "text" ? (
                    <>
                      <TextLayerView layer={gesture?.id === layer.id ? { ...layer, w: box.w, h: box.h } : layer} brand={brand} data={d} fonts={fonts} hidden={editing} />
                      {editing ? (
                        <TextEditor layer={{ ...layer, w: box.w, h: box.h }} brand={brand} onDone={(text) => {
                          setEditingId(null);
                          if (text !== null && text !== layer.text) onTextChange?.(layer.id, text);
                        }} />
                      ) : null}
                    </>
                  )
                  : layer.kind === "video" && isFootage(layer) ? (
                    <VideoView layer={{ ...layer, w: box.w, h: box.h }} url={urlFor(layer)} timeMs={t ?? 0} playing={playing && video} blurPx={video ? blurAt(layer, t ?? 0) : 0} />
                  )
                  : <ImageView layer={{ ...layer, w: box.w, h: box.h }} url={urlFor(layer)} quiet={isPlate(layer)} />}
              </div>
            );
          })}
        </div>
      </div>

      {editable ? (
        <div className="pointer-events-none absolute left-0 top-0" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
          {gesture?.snap.x ? <div style={{ position: "absolute", left: W / 2 - 1 / scale, top: 0, width: 2 / scale, height: H, background: VIOLET }} /> : null}
          {gesture?.snap.y ? <div style={{ position: "absolute", top: H / 2 - 1 / scale, left: 0, height: 2 / scale, width: W, background: VIOLET }} /> : null}
          {selected ? <Selection layer={selected} box={boxOf(selected)} scale={scale} onStart={(kind, e) => startGesture(kind, selected, e)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The selection outline, corner handles and rotate knob, sized for the screen whatever the scale. */
function Selection({ layer, box, scale, onStart }: {
  layer: SceneLayer;
  box: Box;
  scale: number;
  onStart: (kind: "rotate" | Corner, e: ReactPointerEvent) => void;
}) {
  const px = (n: number) => n / scale;
  const handle = px(14);
  const locked = !!layer.locked;
  const grab = (kind: "rotate" | Corner) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onStart(kind, e);
  };
  const at: Record<Corner, { left: number; top: number; cursor: string }> = {
    nw: { left: -handle / 2, top: -handle / 2, cursor: "nwse-resize" },
    ne: { left: box.w - handle / 2, top: -handle / 2, cursor: "nesw-resize" },
    se: { left: box.w - handle / 2, top: box.h - handle / 2, cursor: "nwse-resize" },
    sw: { left: -handle / 2, top: box.h - handle / 2, cursor: "nesw-resize" },
  };
  return (
    <div data-testid="scene-canvas-selection" style={{
      position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
      transform: `rotate(${box.rotation}deg)`, transformOrigin: "50% 50%",
      outline: `${px(2)}px ${locked ? "dashed" : "solid"} ${FLOODLIGHT}`,
    }}>
      {locked ? null : (
        <>
          {CORNERS.map((c) => (
            <div key={c} data-testid={`scene-canvas-handle-${c}`} onPointerDown={grab(c)} style={{
              position: "absolute", left: at[c].left, top: at[c].top, width: handle, height: handle,
              background: "#FFFFFF", border: `${px(2)}px solid ${VIOLET}`, borderRadius: px(3),
              cursor: at[c].cursor, pointerEvents: "auto", touchAction: "none",
            }} />
          ))}
          <div style={{ position: "absolute", left: box.w / 2 - px(1), top: -px(30), width: px(2), height: px(30), background: FLOODLIGHT }} />
          <div data-testid="scene-canvas-rotate" onPointerDown={grab("rotate")} style={{
            position: "absolute", left: box.w / 2 - handle * 0.65, top: -px(30) - handle * 1.3, width: handle * 1.3, height: handle * 1.3,
            borderRadius: "50%", background: FLOODLIGHT, border: `${px(2)}px solid #0B0F1A`,
            cursor: "grab", pointerEvents: "auto", touchAction: "none",
          }} />
        </>
      )}
    </div>
  );
}

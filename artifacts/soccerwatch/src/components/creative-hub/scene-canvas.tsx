import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CREATIVE_FORMATS,
  isVideoScene,
  layerVisibleAt,
  resolveColor,
  resolveSource,
  type CreativeBrand,
  type CreativeData,
  type Scene,
  type SceneLayer,
} from "@workspace/api-zod";
import { moveBox, resizeBox, rotationTo, tidy, type Box, type Corner, type Snap } from "./canvas/editing";
import { entranceAt } from "./canvas/layout";
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
 *   - Editing: click selects, drag moves (centre snaps to the canvas centre
 *     lines), corner handles resize in the layer's rotated frame (Shift keeps
 *     the aspect), the knob rotates (snaps to right angles; Shift = 15° steps),
 *     double-click edits text in place (⌘/Ctrl+Enter or click away saves, Esc
 *     cancels). Locked layers select but never move. A gesture is reported
 *     once, when it ends.
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

  const visible = scene.layers.filter((l) => layerVisibleAt(l, t));
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
    return mediaUrl({ ...layer, src } as MediaLayer);
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
            const enter = video && timeMs !== undefined ? entranceAt(layer, t ?? 0) : { alpha: 1, dx: 0, dy: 0 };
            const alpha = (layer.opacity ?? 1) * enter.alpha;
            const editing = editingId === layer.id && layer.kind === "text";
            return (
              <div
                key={layer.id}
                data-testid={`scene-layer-${layer.id}`}
                onPointerDown={editable ? (e) => {
                  e.stopPropagation();
                  if (editing || e.button !== 0) return;
                  onSelectLayer?.(layer.id);
                  if (!layer.locked) startGesture("move", layer, e);
                } : undefined}
                onDoubleClick={editable && layer.kind === "text" && onTextChange ? (e) => { e.stopPropagation(); setEditingId(layer.id); } : undefined}
                style={{
                  position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
                  transform: `translate(${enter.dx}px, ${enter.dy}px) rotate(${box.rotation}deg)`, transformOrigin: "50% 50%",
                  opacity: alpha,
                  pointerEvents: editable ? "auto" : "none",
                  cursor: editable ? (layer.locked ? "default" : "move") : undefined,
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
                    <VideoView layer={{ ...layer, w: box.w, h: box.h }} url={urlFor(layer)} timeMs={t ?? 0} playing={playing && video} />
                  )
                  : <ImageView layer={{ ...layer, w: box.w, h: box.h }} url={urlFor(layer)} />}
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

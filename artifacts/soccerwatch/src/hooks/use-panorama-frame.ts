import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_SRC_ASPECT,
  OUT_ASPECT,
  makeFrame,
  type AspectRatio,
  type Frame,
} from "@/lib/cropFrame";

const MIN_FRAME_ZOOM = 0.4;
const MAX_FRAME_ZOOM = 4;

export function maxZoomFor(ratio: AspectRatio): number {
  return ratio === "9:16" ? MAX_FRAME_ZOOM : 1;
}

export function usePanoramaFrame() {
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const frameZoomRef = useRef(1);
  const selectedRatioRef = useRef<AspectRatio>("16:9");
  const srcAspectRef = useRef(DEFAULT_SRC_ASPECT);
  const frameOriginRef = useRef({ x: 0.25, y: 0 });
  const draggedRef = useRef(false);
  const dragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const [selectedRatio, setSelectedRatio] = useState<AspectRatio>("16:9");
  const [srcAspect, setSrcAspect] = useState(DEFAULT_SRC_ASPECT);
  const [frameZoom, setFrameZoom] = useState(1);
  const [frameOrigin, setFrameOrigin] = useState({ x: 0.25, y: 0 });
  const frame = makeFrame(
    frameOrigin.x,
    frameOrigin.y,
    frameZoom,
    srcAspect,
    OUT_ASPECT[selectedRatio],
  );

  const readFrame = useCallback(() => makeFrame(
    frameOriginRef.current.x,
    frameOriginRef.current.y,
    frameZoomRef.current,
    srcAspectRef.current,
    OUT_ASPECT[selectedRatioRef.current],
  ), []);

  const setOrigin = useCallback((x: number, y: number) => {
    const next = makeFrame(
      x,
      y,
      frameZoomRef.current,
      srcAspectRef.current,
      OUT_ASPECT[selectedRatioRef.current],
    );
    frameOriginRef.current = { x: next.x, y: next.y };
    setFrameOrigin({ x: next.x, y: next.y });
  }, []);

  const applyFrameChange = useCallback((requestedZoom: number, nextRatio: AspectRatio) => {
    const nextZoom = Math.max(MIN_FRAME_ZOOM, Math.min(maxZoomFor(nextRatio), requestedZoom));
    const previous = makeFrame(
      frameOriginRef.current.x,
      frameOriginRef.current.y,
      frameZoomRef.current,
      srcAspectRef.current,
      OUT_ASPECT[selectedRatioRef.current],
    );
    const cx = previous.x + previous.w / 2;
    const cy = previous.y + previous.h / 2;
    const sized = makeFrame(0, 0, nextZoom, srcAspectRef.current, OUT_ASPECT[nextRatio]);
    const next = makeFrame(
      cx - sized.w / 2,
      cy - sized.h / 2,
      nextZoom,
      srcAspectRef.current,
      OUT_ASPECT[nextRatio],
    );
    frameZoomRef.current = nextZoom;
    selectedRatioRef.current = nextRatio;
    frameOriginRef.current = { x: next.x, y: next.y };
    setFrameZoom(nextZoom);
    setSelectedRatio(nextRatio);
    setFrameOrigin({ x: next.x, y: next.y });
  }, []);

  const setSourceAspect = useCallback((aspect: number) => {
    if (!(aspect > 0) || Math.abs(aspect - srcAspectRef.current) < 1e-6) return;
    srcAspectRef.current = aspect;
    setSrcAspect(aspect);
    const sized = makeFrame(
      0,
      0,
      frameZoomRef.current,
      aspect,
      OUT_ASPECT[selectedRatioRef.current],
    );
    const centered = makeFrame(
      (1 - sized.w) / 2,
      (1 - sized.h) / 2,
      frameZoomRef.current,
      aspect,
      OUT_ASPECT[selectedRatioRef.current],
    );
    frameOriginRef.current = { x: centered.x, y: centered.y };
    setFrameOrigin({ x: centered.x, y: centered.y });
  }, []);

  // Two fingers on the frame pinch-zoom it; one finger pans it.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef({ active: false, startDistance: 0, startZoom: 1 });

  const pointerDistance = () => {
    const [a, b] = [...pointersRef.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const handleFramePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const distance = pointerDistance();
      pinchRef.current = { active: distance > 0, startDistance: distance, startZoom: frameZoomRef.current };
      dragRef.current.active = false;
      draggedRef.current = true;
      return;
    }
    if (pointersRef.current.size > 2) return;
    draggedRef.current = false;
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      originX: frameOriginRef.current.x,
      originY: frameOriginRef.current.y,
    };
  }, []);

  const handleFramePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>, onDragStart?: () => void) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinchRef.current.active) {
      const distance = pointerDistance();
      if (distance > 0 && pinchRef.current.startDistance > 0) {
        onDragStart?.();
        applyFrameChange(
          pinchRef.current.startZoom * (distance / pinchRef.current.startDistance),
          selectedRatioRef.current,
        );
      }
      return;
    }
    if (!dragRef.current.active || !frameBoxRef.current) return;
    const box = frameBoxRef.current;
    if (!(box.clientWidth > 0) || !(box.clientHeight > 0)) return;
    const rawX = event.clientX - dragRef.current.startX;
    const rawY = event.clientY - dragRef.current.startY;
    if (!draggedRef.current && Math.hypot(rawX, rawY) > 8) {
      draggedRef.current = true;
      onDragStart?.();
      dragRef.current.originX = frameOriginRef.current.x;
      dragRef.current.originY = frameOriginRef.current.y;
    }
    const current = readFrame();
    setOrigin(
      dragRef.current.originX - (rawX / box.clientWidth) * current.w,
      dragRef.current.originY - (rawY / box.clientHeight) * current.h,
    );
  }, [applyFrameChange, readFrame, setOrigin]);

  const handleFramePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may release capture before pointerup.
    }
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current.active = false;
    // Lifting one finger of a pinch must not turn the other into a pan jump.
    dragRef.current.active = false;
  }, []);

  return {
    frameBoxRef,
    frameZoomRef,
    selectedRatioRef,
    srcAspectRef,
    frameOriginRef,
    draggedRef,
    frame,
    frameZoom,
    frameOrigin,
    selectedRatio,
    srcAspect,
    readFrame,
    setOrigin,
    applyFrameChange,
    setSourceAspect,
    handleFramePointerDown,
    handleFramePointerMove,
    handleFramePointerUp,
    maxZoomFor,
  };
}
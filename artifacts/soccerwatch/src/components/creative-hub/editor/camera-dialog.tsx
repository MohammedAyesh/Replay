import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { resolveSource } from "@workspace/api-zod";
import { useCreativeFramerCopy } from "@/i18n/creative-framer-strings";
import { NO_BRANDING, fetchFraming, type FramedClip } from "@/lib/creative-framing";
import type { MediaLayer } from "@/lib/creative-editor-state";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClipFramer, type FramerStart } from "../framer/clip-framer";
import type { EditorApi } from "./editor-api";

type VideoLayer = Extract<MediaLayer, { kind: "video" }>;

/** The footage a video layer plays, when it is match footage the framer can work on. */
export function framerFootage(ed: EditorApi, layer: MediaLayer) {
  if (layer.kind !== "video") return null;
  const src = resolveSource(layer.src, ed.data);
  return src && (src.type === "recording" || src.type === "clip") ? src : null;
}

/**
 * Editor → a video layer → "Camera & length": the clip framer on the layer's
 * footage. A clip opens on its place in its recording, so its start and end
 * can move past the clip's own edges. Done writes the footage, camera and
 * length back to the layer and the branding to the scene.
 */
export function CameraDialog({ ed, layer, open, onOpenChange }: { ed: EditorApi; layer: VideoLayer; open: boolean; onOpenChange: (v: boolean) => void }) {
  const copy = useCreativeFramerCopy();
  const footage = framerFootage(ed, layer);
  const [start, setStart] = useState<FramerStart | null>(null);

  useEffect(() => {
    if (!open || !footage) return;
    setStart(null);
    if (footage.type === "recording") {
      setStart({ type: "recording", recordingId: footage.recordingId, fromMs: footage.fromMs, toMs: footage.toMs });
      return;
    }
    let cancelled = false;
    const fallback = Math.max(2000, (layer.trimOutMs ?? 60_000) - (layer.trimInMs ?? 0));
    fetchFraming(ed.academyId, { type: "clip", clipId: footage.clipId })
      .then((a) => { if (!cancelled) setStart(a.window ? { type: "recording", ...a.window } : { type: "clip", clipId: footage.clipId, durationMs: fallback }); })
      .catch(() => { if (!cancelled) setStart({ type: "clip", clipId: footage.clipId, durationMs: fallback }); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(footage)]);

  const apply = (value: FramedClip) => {
    const total = ed.scene.durationMs ?? 0;
    const before = (layer.trimOutMs ?? total) - (layer.trimInMs ?? 0);
    // A layer that played to the end of the video keeps doing so at its new length.
    const fillsScene = (layer.startMs ?? 0) === 0 && (layer.endMs === undefined || layer.endMs >= total) && before >= total - 50;
    // A template's footage slot: the clip goes to every part of the design that shows it, and the design follows its length.
    if (layer.src.type === "binding") {
      ed.setSlotVideo(layer.src.path, value.src, value.durationMs, value.framing ?? null, !!value.ballTrail);
      ed.updateScene({ branding: value.branding });
      onOpenChange(false);
      return;
    }
    ed.update(layer.id, {
      src: value.src,
      framing: value.framing ?? undefined,
      ballTrail: value.ballTrail || undefined,
      trimInMs: 0,
      trimOutMs: value.durationMs,
      slowMo: undefined,
    });
    ed.updateScene({ branding: value.branding, ...(fillsScene ? { durationMs: Math.min(180_000, value.durationMs) } : {}) });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto rounded-2xl border-line bg-void p-4" data-testid="editor-camera-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="sr-only">{copy.dragHint}</DialogDescription>
        </DialogHeader>
        {!start ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{copy.loading}</p>
        ) : (
          <ClipFramer key={JSON.stringify(start)} academyId={ed.academyId} start={start}
            framing={layer.framing}
            ballTrail={!!layer.ballTrail}
            lockedAspect={layer.w > 0 && layer.h > 0 ? layer.w / layer.h : 16 / 9}
            branding={ed.scene.branding ?? NO_BRANDING}
            actions={(value) => (
              <div className="flex gap-2">
                <button type="button" onClick={() => onOpenChange(false)} className="min-h-11 flex-1 rounded-full border border-line text-sm font-semibold text-text">{copy.cancel}</button>
                <button type="button" onClick={() => apply(value)} data-testid="editor-camera-done"
                  className="min-h-11 flex-1 rounded-full bg-floodlight text-sm font-bold text-void">{copy.done}</button>
              </div>
            )} />
        )}
      </DialogContent>
    </Dialog>
  );
}

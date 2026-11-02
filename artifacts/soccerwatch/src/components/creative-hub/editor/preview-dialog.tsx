import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { CreativeBrand, CreativeData, Scene } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { canvasHeight } from "@/lib/creative-editor-state";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SceneCanvas, type SceneCanvasProps } from "../scene-canvas";
import { IconButton } from "./controls";
import { usePlayback } from "./hooks";
import { formatMs } from "./timeline";

/** The design as it will export: no selection, plays from the start for videos. */
export function PreviewDialog({ open, onOpenChange, scene, brand, data, mediaUrl }: {
  open: boolean; onOpenChange: (o: boolean) => void; scene: Scene; brand: CreativeBrand; data: CreativeData; mediaUrl: SceneCanvasProps["mediaUrl"];
}) {
  const copy = useCreativeEditorCopy();
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const isVideo = scene.durationMs !== undefined;
  useEffect(() => { if (open) { setTimeMs(0); setPlaying(isVideo); } else setPlaying(false); }, [open, isVideo]);
  usePlayback(scene.durationMs, open && playing, setTimeMs);
  const vw = typeof window === "undefined" ? 400 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const width = Math.floor(Math.min(420, vw - 48, (vh * 0.72 * 1080) / canvasHeight(scene.format)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-fit rounded-2xl border-line bg-void p-4" data-testid="editor-preview">
        <DialogHeader>
          <DialogTitle>{copy.previewTitle}</DialogTitle>
          <DialogDescription>{copy.previewHint}</DialogDescription>
        </DialogHeader>
        <div className="mx-auto overflow-hidden rounded-xl">
          <SceneCanvas scene={scene} brand={brand} data={data} width={width} mediaUrl={mediaUrl} timeMs={isVideo ? timeMs : undefined} playing={isVideo && playing} />
        </div>
        {isVideo ? (
          <div className="flex items-center gap-3" dir="ltr">
            <IconButton label={playing ? copy.pause : copy.play} onClick={() => setPlaying(!playing)}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </IconButton>
            <input type="range" min={0} max={scene.durationMs} step={10} value={timeMs} aria-label={copy.scrub}
              onChange={(e) => { setPlaying(false); setTimeMs(Number(e.target.value)); }} className="flex-1 accent-[var(--color-floodlight)]" />
            <span className="font-mono text-xs text-muted-text">{formatMs(timeMs)}</span>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

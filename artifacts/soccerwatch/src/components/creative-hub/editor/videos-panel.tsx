import { useState } from "react";
import { Crosshair, Film, Replace } from "lucide-react";
import { resolveSource } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { findLayer, videoPlayMs, type VideoLayer, type VideoSlot } from "@/lib/creative-editor-state";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CameraDialog, framerFootage } from "./camera-dialog";
import { formatMs } from "./timeline";
import type { EditorApi } from "./editor-api";

/**
 * Editor → Videos: one place per footage slot the template has (Video 1, Video 2 …). Adding or
 * changing a video fills every part of the design that shows it and ripples the design's length
 * to the clip's; "Camera & length" opens the same framer as Clips.
 */
export function VideosPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  if (!ed.slots.length) return null;
  return (
    <div className="space-y-3" data-testid="editor-videos-panel">
      <p className="text-xs text-muted-text">{copy.videos.hint(ed.slots.length)}</p>
      {ed.slots.map((slot) => <SlotCard key={slot.path} ed={ed} slot={slot} />)}
    </div>
  );
}

function SlotCard({ ed, slot }: { ed: EditorApi; slot: VideoSlot }) {
  const copy = useCreativeEditorCopy();
  const [cameraOpen, setCameraOpen] = useState(false);
  const anchor = findLayer(ed.scene, slot.anchorId) as VideoLayer | null;
  if (!anchor) return null;
  const src = anchor.src.type === "binding" ? resolveSource(anchor.src, ed.data) : null;
  const plays = src ? videoPlayMs({ ...anchor, src } as VideoLayer) : null;
  const active = ed.selected ? slot.layerIds.includes(ed.selected.id) : false;
  const pick = () => ed.pick("video", (picked, meta) => {
    const playMs = picked.type === "recording" ? picked.toMs - picked.fromMs : meta.durationMs ?? null;
    ed.setSlotVideo(slot.path, picked, playMs);
    ed.frameFootage({ slot: slot.path }, picked);
  });
  return (
    <section className={cn("space-y-3 rounded-2xl border bg-surface p-3", active ? "border-turf" : "border-line")} data-testid={`editor-video-slot-${slot.n}`}>
      <button type="button" onClick={() => ed.select(slot.anchorId)} className="flex w-full items-center gap-3 text-start">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl font-display text-lg font-bold", src ? "bg-violet/80 text-white" : "border border-dashed border-line text-muted-text")}>
          {slot.n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-text">{copy.videos.slot(slot.n)}</span>
          <span className="block truncate text-xs text-muted-text">
            {src ? `${copy.mediaKinds[src.type] ?? src.type}${plays ? ` · ${copy.videos.length(formatMs(plays))}` : ""}` : copy.videos.empty}
            {" · "}{copy.videos.segments(slot.layerIds.length)}
          </span>
        </span>
      </button>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant={src ? "outline" : "default"} className={cn("min-h-10 rounded-xl", !src && "col-span-2")} onClick={pick} data-testid={`editor-video-slot-${slot.n}-pick`}>
          {src ? <Replace className="h-4 w-4" /> : <Film className="h-4 w-4" />}{src ? copy.videos.change : copy.videos.add}
        </Button>
        {src && framerFootage(ed, anchor) ? (
          <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={() => setCameraOpen(true)} data-testid={`editor-video-slot-${slot.n}-edit`}>
            <Crosshair className="h-4 w-4" />{copy.videos.edit}
          </Button>
        ) : null}
      </div>
      {src ? <p className="text-[11px] text-muted-text">{copy.videos.editHint}</p> : null}
      {src && framerFootage(ed, anchor) ? (
        <label className="flex items-center justify-between gap-3 text-sm text-text">
          {copy.videos.ballTrail}
          <Switch checked={!!anchor.ballTrail} data-testid={`editor-video-slot-${slot.n}-trail`}
            onCheckedChange={(v) => { for (const id of slot.layerIds) ed.update(id, { ballTrail: v || undefined }); }} />
        </label>
      ) : null}
      {cameraOpen ? <CameraDialog ed={ed} layer={anchor} open={cameraOpen} onOpenChange={setCameraOpen} /> : null}
    </section>
  );
}

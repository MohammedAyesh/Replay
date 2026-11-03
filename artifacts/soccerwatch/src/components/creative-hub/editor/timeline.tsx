import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Music2, Pause, Play, Plus, Scissors } from "lucide-react";
import { isPhotoVideo, PHOTO_VIDEO_MAX_MS, PHOTO_VIDEO_MIN_MS, type SceneLayer } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { useCreativeMusicCopy } from "@/i18n/creative-music-strings";
import { laneBars } from "@/lib/creative-music";
import { dragWindow, layerWindow, videoPlayMs, videoSourceMs, type VideoLayer } from "@/lib/creative-editor-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Chip, IconButton, NumberSlider, Section, Toggle } from "./controls";
import { layerTitle } from "./layers-panel";
import type { EditorApi } from "./editor-api";

export const formatMs = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

const BAR_COLOR: Record<SceneLayer["kind"], string> = {
  video: "bg-violet/80", image: "bg-turf/70", text: "bg-floodlight/80", shape: "bg-muted-text/60",
};
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const SLOW_SPEEDS = [0.25, 0.5, 0.75];

/** The soundtrack's lane: what the scene plays of it (from the start point, looping). Tapping it opens Music. */
export type MusicLane = { title: string | null; peaks: number[]; trackMs: number; startMs: number; active: boolean; onOpen: () => void };

/** Under the canvas for video scenes: playhead, one track per layer, the music lane, and the selected video's trim / speed / slow motion. */
export function Timeline({ ed, music }: { ed: EditorApi; music?: MusicLane }) {
  const copy = useCreativeEditorCopy();
  const duration = ed.scene.durationMs ?? 0;
  const layers = [...ed.scene.layers].reverse();
  const video = ed.selected?.kind === "video" ? ed.selected : null;
  const pct = (ms: number) => `${(duration ? (ms / duration) * 100 : 0).toFixed(3)}%`;
  // A photo with music is a short video: 5–30 s.
  const [minS, maxS] = isPhotoVideo(ed.scene) ? [PHOTO_VIDEO_MIN_MS / 1000, PHOTO_VIDEO_MAX_MS / 1000] : [0.5, 180];

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-surface p-3" dir="ltr" data-testid="editor-timeline">
      <div className="flex items-center gap-3">
        <IconButton label={ed.playing ? copy.pause : copy.play} onClick={() => ed.setPlaying(!ed.playing)} active={ed.playing} testId="editor-play">
          {ed.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </IconButton>
        <span className="font-mono text-xs text-text"><bdi>{formatMs(ed.timeMs)}</bdi> <span className="text-muted-text">/ {formatMs(duration)}</span></span>
        <label className="ms-auto flex items-center gap-1.5 text-xs text-muted-text">
          {copy.total}
          <input type="number" min={minS} max={maxS} step={0.5} value={Math.round(duration / 100) / 10} data-testid="editor-duration"
            onChange={(e) => {
              const s = Number(e.target.value);
              if (Number.isFinite(s) && s >= minS && s <= maxS) ed.updateScene({ durationMs: Math.round(s * 1000) }, "duration");
            }}
            className="h-9 w-16 rounded-lg border border-line bg-raised px-2 text-end font-mono text-xs text-text" />
          {copy.seconds}
        </label>
      </div>

      <div className="relative">
        <input type="range" min={0} max={duration} step={10} value={Math.min(ed.timeMs, duration)} aria-label={copy.scrub} data-testid="editor-scrubber"
          onChange={(e) => { ed.setPlaying(false); ed.setTimeMs(Number(e.target.value)); }}
          className="h-6 w-full cursor-pointer accent-[var(--color-floodlight)]" />
      </div>

      <div className="relative max-h-56 space-y-1 overflow-y-auto pe-1">
        {layers.map((layer) => (
          <Track key={layer.id} ed={ed} layer={layer} duration={duration} pct={pct} />
        ))}
        {music ? <MusicTrackLane lane={music} ed={ed} duration={duration} pct={pct} /> : null}
      </div>
      <p className="text-[11px] text-muted-text">{copy.barHint}</p>

      {video ? <VideoControls key={video.id} ed={ed} layer={video} /> : null}
    </div>
  );
}

function Track({ ed, layer, duration, pct }: { ed: EditorApi; layer: SceneLayer; duration: number; pct: (ms: number) => string }) {
  const copy = useCreativeEditorCopy();
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ edge: "move" | "start" | "end"; x: number; win: { start: number; end: number }; width: number } | null>(null);
  const win = layerWindow(layer, duration);
  const active = ed.selected?.id === layer.id;

  const down = (edge: "move" | "start" | "end") => (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    ed.select(layer.id);
    if (layer.locked || !area.current) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { edge, x: e.clientX, win, width: area.current.getBoundingClientRect().width };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !d.width) return;
    const delta = ((e.clientX - d.x) / d.width) * duration;
    ed.update(layer.id, dragWindow(d.win, d.edge, delta, duration), "timing");
  };
  const up = () => { drag.current = null; };

  return (
    <div className="flex items-center gap-2" data-testid={`editor-track-${layer.id}`}>
      <button type="button" onClick={() => ed.select(layer.id)}
        className={cn("w-20 shrink-0 truncate text-start text-[11px]", active ? "font-semibold text-text" : "text-muted-text")}>
        <bdi dir="auto">{layerTitle(layer, copy, ed.data)}</bdi>
      </button>
      <div ref={area} className={cn("relative h-8 flex-1 rounded-md bg-raised", layer.hidden && "opacity-40")}
        onPointerDown={(e) => { if (e.target === e.currentTarget) { ed.setPlaying(false); ed.setTimeMs(((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth) * duration); } }}>
        <div
          className={cn("absolute inset-y-1 touch-none rounded-md", BAR_COLOR[layer.kind], active && "ring-2 ring-text", layer.locked ? "cursor-not-allowed" : "cursor-grab")}
          style={{ left: pct(win.start), width: pct(win.end - win.start) }}
          onPointerDown={down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          {!layer.locked ? (
            <>
              <span className="absolute inset-y-0 start-0 w-3 cursor-ew-resize touch-none rounded-s-md bg-black/25" onPointerDown={down("start")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-hidden />
              <span className="absolute inset-y-0 end-0 w-3 cursor-ew-resize touch-none rounded-e-md bg-black/25" onPointerDown={down("end")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-hidden />
            </>
          ) : null}
        </div>
        <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-floodlight" style={{ left: pct(Math.min(ed.timeMs, duration)) }} aria-hidden />
      </div>
    </div>
  );
}

function MusicTrackLane({ lane, ed, duration, pct }: { lane: MusicLane; ed: EditorApi; duration: number; pct: (ms: number) => string }) {
  const copy = useCreativeMusicCopy();
  const has = !!lane.title && lane.trackMs > 0;
  const bars = has ? laneBars(lane.peaks, lane.trackMs, lane.startMs, duration, 64) : [];
  return (
    <div className="flex items-center gap-2" data-testid="editor-track-music">
      <button type="button" onClick={lane.onOpen}
        className={cn("flex w-20 shrink-0 items-center gap-1 truncate text-start text-[11px]", lane.active ? "font-semibold text-text" : "text-muted-text")}>
        <Music2 className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{copy.lane}</span>
      </button>
      <button type="button" onClick={lane.onOpen} aria-label={has ? lane.title! : copy.laneEmpty}
        className={cn("relative h-8 flex-1 overflow-hidden rounded-md", has ? "bg-raised" : "border border-dashed border-line")}>
        {has ? (
          <span className={cn("absolute inset-y-1 inset-x-0 flex items-center gap-px rounded-md bg-sky-500/25 px-1", lane.active && "ring-2 ring-text")}>
            {bars.map((v, i) => <span key={i} aria-hidden className="flex-1 rounded-full bg-sky-400/90" style={{ height: `${Math.round(v * 100)}%`, minWidth: 1 }} />)}
            <bdi dir="auto" className="pointer-events-none absolute start-2 top-1/2 max-w-[70%] -translate-y-1/2 truncate rounded bg-void/70 px-1.5 text-[10px] font-semibold text-text">{lane.title}</bdi>
          </span>
        ) : (
          <span className="flex h-full items-center justify-center gap-1 text-[11px] text-muted-text"><Plus className="h-3 w-3" aria-hidden />{copy.laneEmpty}</span>
        )}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-floodlight" style={{ left: pct(Math.min(ed.timeMs, duration)) }} aria-hidden />
      </button>
    </div>
  );
}

function VideoControls({ ed, layer }: { ed: EditorApi; layer: VideoLayer }) {
  const copy = useCreativeEditorCopy();
  const duration = ed.scene.durationMs ?? 0;
  const speed = layer.speed ?? 1;
  const trimIn = layer.trimInMs ?? 0;
  const max = Math.max(videoSourceMs(layer) ?? 0, layer.trimOutMs ?? 0, Math.round(duration * speed), 1000);
  const trimOut = layer.trimOutMs ?? max;
  const plays = videoPlayMs(layer);
  const set = (change: Partial<VideoLayer>, key?: string) => ed.update(layer.id, change, key);
  const sec = (ms: number) => Math.round(ms / 100) / 10;

  const slowAtPlayhead = () => {
    const start = layerWindow(layer, duration).start;
    const from = Math.min(trimOut - 500, Math.max(trimIn, Math.round(trimIn + (ed.timeMs - start) * speed)));
    set({ slowMo: { fromMs: from, toMs: Math.min(trimOut, from + 2000), speed: 0.5 } });
  };

  return (
    <div className="space-y-4 border-t border-line pt-3" data-testid="editor-video-controls">
      <Section title={copy.trim} aside={<Scissors className="h-4 w-4 text-muted-text" />}>
        <NumberSlider label={copy.trimIn} value={sec(trimIn)} min={0} max={sec(max)} step={0.1} unit={copy.seconds}
          onChange={(v) => set({ trimInMs: Math.min(Math.round(v * 1000), trimOut - 200) }, "trimIn")} testId="editor-trim-in" />
        <NumberSlider label={copy.trimOut} value={sec(trimOut)} min={0} max={sec(max)} step={0.1} unit={copy.seconds}
          onChange={(v) => set({ trimOutMs: Math.max(Math.round(v * 1000), trimIn + 200) }, "trimOut")} testId="editor-trim-out" />
      </Section>
      <Section title={copy.speed}>
        <div className="flex flex-wrap gap-1.5">
          {SPEEDS.map((s) => <Chip key={s} active={speed === s} onClick={() => set({ speed: s })} className="min-h-8 font-mono">{s}×</Chip>)}
        </div>
      </Section>
      <Section title={copy.slowMo}>
        <Toggle id={`slowmo-${layer.id}`} label={copy.slowMo} checked={!!layer.slowMo} testId="editor-slowmo"
          onChange={(v) => (v ? slowAtPlayhead() : set({ slowMo: undefined }))} />
        {layer.slowMo ? (
          <div className="space-y-3 rounded-xl bg-raised/60 p-3">
            <NumberSlider label={copy.slowMoFrom} value={sec(layer.slowMo.fromMs)} min={sec(trimIn)} max={sec(trimOut)} step={0.1} unit={copy.seconds}
              onChange={(v) => set({ slowMo: { ...layer.slowMo!, fromMs: Math.min(Math.round(v * 1000), layer.slowMo!.toMs - 100) } }, "slowFrom")} />
            <NumberSlider label={copy.slowMoTo} value={sec(layer.slowMo.toMs)} min={sec(trimIn)} max={sec(trimOut)} step={0.1} unit={copy.seconds}
              onChange={(v) => set({ slowMo: { ...layer.slowMo!, toMs: Math.max(Math.round(v * 1000), layer.slowMo!.fromMs + 100) } }, "slowTo")} />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm text-text">{copy.slowMoSpeed}</span>
              {SLOW_SPEEDS.map((s) => <Chip key={s} active={layer.slowMo!.speed === s} onClick={() => set({ slowMo: { ...layer.slowMo!, speed: s } })} className="min-h-8 font-mono">{s}×</Chip>)}
            </div>
            <Button type="button" variant="outline" size="sm" className="min-h-9 rounded-xl" onClick={slowAtPlayhead}>{copy.slowMoAtPlayhead}</Button>
          </div>
        ) : null}
      </Section>
      {plays ? (
        <Button type="button" variant="outline" className="min-h-10 w-full rounded-xl" data-testid="editor-fit-duration"
          onClick={() => ed.updateScene({ durationMs: Math.min(180_000, Math.max(500, layerWindow(layer, duration).start + plays)) })}>
          {copy.fitToVideo} · <bdi className="font-mono">{formatMs(plays)}</bdi>
        </Button>
      ) : null}
    </div>
  );
}

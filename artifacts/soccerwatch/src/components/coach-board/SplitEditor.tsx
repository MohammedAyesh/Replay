import { useState } from "react";
import { ArrowLeftToLine, ArrowRightToLine, Combine, Loader2, Plus, Trash2, Undo2 } from "lucide-react";
import { useCoachCopy } from "@/i18n/coach-strings";
import type { TrainingSegment, TrainingSegmentLabel } from "@/lib/academy-training";
import { EDITABLE_LABELS, joinNext, moveEdge, relabel, removePart, segmentColor, startPartAt, tidy } from "@/lib/split-editor";
import { cn } from "@/lib/utils";

/**
 * The coach's own split of a training. Play to where a part starts and tap "Start here";
 * move an edge to the playhead, relabel, join or remove parts; save. Works with or without
 * the analysis's split (on a session it never split, this is how the parts get made).
 */
export function SplitEditor({ initial, analysisSegments, edited, duration, time, clock, labels, onSeek, onSave, onClose }: {
  initial: TrainingSegment[];
  analysisSegments: TrainingSegment[];
  edited: boolean;
  duration: number;
  /** the playhead, seconds */
  time: number;
  clock: (t: number) => string;
  labels: Record<TrainingSegmentLabel, string>;
  onSeek: (t: number) => void;
  /** null: back to the analysis's split */
  onSave: (segments: TrainingSegment[] | null) => Promise<void>;
  onClose: () => void;
}) {
  const copy = useCoachCopy();
  const [parts, setParts] = useState<TrainingSegment[]>(() => tidy(initial));
  const [label, setLabel] = useState<TrainingSegmentLabel>("warm-up");
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [dirty, setDirty] = useState(false);
  const change = (next: TrainingSegment[]) => { setParts(next); setDirty(true); };
  const total = Math.max(duration, ...parts.map((p) => p.end), 1);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100))}%`;
  const save = async (segments: TrainingSegment[] | null) => {
    setState("saving");
    try { await onSave(segments); onClose(); } catch { setState("failed"); }
  };
  const t = Math.round(time * 10) / 10;

  return (
    <section className="mb-3 rounded-xl border border-floodlight/40 bg-raised/40 p-3" data-testid="coach-split-editor">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-bold text-text">{copy.splits.title}</h3>
          <p className="text-xs text-muted-text">{copy.splits.hint}</p>
        </div>
        <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm font-semibold text-muted-text hover:text-text">{copy.cancel}</button>
        <button type="button" onClick={() => void save(parts)} disabled={state === "saving" || !dirty}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-floodlight px-4 text-sm font-bold text-void disabled:opacity-40" data-testid="coach-split-save">
          {state === "saving" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{copy.splits.save}
        </button>
      </div>
      {state === "failed" && <p className="mt-1 text-xs text-live" role="alert">{copy.splits.failed}</p>}

      {/* The parts on the video's length, with the playhead; a tap goes there. */}
      <div className="relative mt-2 h-7 cursor-pointer overflow-hidden rounded-md bg-void" dir="ltr"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * total); }}
        data-testid="coach-split-bar">
        {parts.map((p, i) => (
          <span key={`${p.start}-${i}`} className="absolute inset-y-0 border-e border-void/60" style={{ left: pct(p.start), width: `calc(${pct(p.end)} - ${pct(p.start)})`, background: segmentColor(p.label) }} title={`${labels[p.label]} ${clock(p.start)}–${clock(p.end)}`} />
        ))}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-floodlight" style={{ left: pct(t) }} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select value={label} onChange={(e) => setLabel(e.target.value as TrainingSegmentLabel)} aria-label={copy.splits.kind}
          className="h-9 rounded-lg border border-line bg-surface px-2 text-sm font-semibold text-text" data-testid="coach-split-label">
          {EDITABLE_LABELS.map((l) => <option key={l} value={l}>{labels[l]}</option>)}
        </select>
        <button type="button" onClick={() => change(startPartAt(parts, t, label, total))}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-turf px-3 text-sm font-bold text-void" data-testid="coach-split-start">
          <Plus className="h-4 w-4" aria-hidden />{copy.splits.startHere(clock(t))}
        </button>
        {(edited || dirty) && analysisSegments.length > 0 && (
          <button type="button" onClick={() => void save(null)} disabled={state === "saving"}
            className="ms-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-muted-text hover:text-text" data-testid="coach-split-reset">
            <Undo2 className="h-3.5 w-3.5" aria-hidden />{copy.splits.reset}
          </button>
        )}
      </div>

      {parts.length === 0 ? (
        <p className="mt-2 text-xs text-muted-text">{copy.splits.empty}</p>
      ) : (
        <ol className="mt-2 max-h-44 space-y-1 overflow-y-auto pe-1" data-testid="coach-split-list">
          {parts.map((p, i) => {
            const here = p.start <= t && t < p.end;
            return (
              <li key={`${p.start}-${i}`} className={cn("flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1", here ? "border-floodlight/60 bg-floodlight/5" : "border-line")} data-testid="coach-split-row">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: segmentColor(p.label) }} />
                <select value={p.label} onChange={(e) => change(relabel(parts, i, e.target.value as TrainingSegmentLabel))} aria-label={copy.splits.kind}
                  className="h-8 min-w-0 rounded-md border border-line bg-surface px-1.5 text-xs font-semibold text-text">
                  {[...new Set([...EDITABLE_LABELS, p.label])].map((l) => <option key={l} value={l}>{labels[l]}</option>)}
                </select>
                <span className="inline-flex items-center gap-0.5 font-mono text-xs tabular-nums text-muted-text" dir="ltr">
                  <button type="button" onClick={() => change(moveEdge(parts, i, "start", t))} title={copy.splits.startToNow} aria-label={copy.splits.startToNow} className="grid h-7 w-7 place-items-center rounded hover:bg-raised hover:text-text"><ArrowLeftToLine className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => onSeek(p.start)} className="rounded px-1 hover:bg-raised hover:text-text">{clock(p.start)}</button>
                  –
                  <button type="button" onClick={() => onSeek(Math.max(p.start, p.end - 3))} className="rounded px-1 hover:bg-raised hover:text-text">{clock(p.end)}</button>
                  <button type="button" onClick={() => change(moveEdge(parts, i, "end", t))} title={copy.splits.endToNow} aria-label={copy.splits.endToNow} className="grid h-7 w-7 place-items-center rounded hover:bg-raised hover:text-text"><ArrowRightToLine className="h-3.5 w-3.5" /></button>
                </span>
                <span className="ms-auto flex items-center">
                  {i < parts.length - 1 && (
                    <button type="button" onClick={() => change(joinNext(parts, i))} title={copy.splits.join} aria-label={copy.splits.join} className="grid h-7 w-7 place-items-center rounded text-muted-text hover:bg-raised hover:text-text"><Combine className="h-3.5 w-3.5" /></button>
                  )}
                  <button type="button" onClick={() => change(removePart(parts, i))} title={copy.delete} aria-label={copy.delete} className="grid h-7 w-7 place-items-center rounded text-muted-text hover:bg-raised hover:text-live"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

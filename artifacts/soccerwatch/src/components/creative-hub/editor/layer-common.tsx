import { ArrowDownToLine, ArrowUpToLine, Copy, Trash2 } from "lucide-react";
import type { SceneLayer } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { Button } from "@/components/ui/button";
import { Chip, NumberSlider, Section } from "./controls";
import type { EditorApi } from "./editor-api";

const ENTRANCES = ["none", "fade", "slide-up", "slide-left", "pop", "push-up", "push-down", "wipe"] as const;

/** Seconds, 0 to 5 in tenths, as ms (0 = no fade). */
const toMs = (s: number) => Math.round(s * 10) * 100;

/** Fade in at the layer's start and out at its end (video designs). */
export function FadeSliders({ ed, layer, onChange }: {
  ed: EditorApi; layer: Pick<SceneLayer, "id" | "fadeInMs" | "fadeOutMs">;
  /** Instead of ed.update (the background plate goes through setPlate). */
  onChange?: (change: { fadeInMs?: number; fadeOutMs?: number }, key: string) => void;
}) {
  const copy = useCreativeEditorCopy();
  const set = (change: { fadeInMs?: number; fadeOutMs?: number }, key: string) =>
    onChange ? onChange(change, key) : ed.update(layer.id, change.fadeInMs !== undefined ? { fadeInMs: change.fadeInMs || undefined } : { fadeOutMs: change.fadeOutMs || undefined }, key);
  return (
    <div className="space-y-2" data-testid={`editor-fades-${layer.id}`}>
      <NumberSlider label={copy.fadeIn} value={(layer.fadeInMs ?? 0) / 1000} min={0} max={5} step={0.1} unit="s" testId={`editor-fade-in-${layer.id}`}
        onChange={(v) => set({ fadeInMs: toMs(v) }, "fade-in")} />
      <NumberSlider label={copy.fadeOut} value={(layer.fadeOutMs ?? 0) / 1000} min={0} max={5} step={0.1} unit="s" testId={`editor-fade-out-${layer.id}`}
        onChange={(v) => set({ fadeOutMs: toMs(v) }, "fade-out")} />
      <p className="text-[11px] text-muted-text">{copy.fadeHint}</p>
    </div>
  );
}

/** Opacity, rotation, fades, entrance and the arrange buttons, under every kind's own controls. */
export function LayerCommon({ ed, layer }: { ed: EditorApi; layer: SceneLayer }) {
  const copy = useCreativeEditorCopy();
  return (
    <Section title={copy.layerKinds[layer.kind]}>
      <NumberSlider label={copy.opacity} value={Math.round((layer.opacity ?? 1) * 100)} min={0} max={100} unit="%"
        onChange={(v) => ed.update(layer.id, { opacity: v >= 100 ? undefined : v / 100 }, "opacity")} />
      <NumberSlider label={copy.rotation} value={layer.rotation ?? 0} min={-180} max={180} unit="°"
        onChange={(v) => ed.update(layer.id, { rotation: v === 0 ? undefined : v }, "rotation")} />
      {ed.isVideo ? <FadeSliders ed={ed} layer={layer} /> : null}
      {ed.isVideo ? (
        <div className="space-y-1.5">
          <span className="text-sm text-text">{copy.entrance}</span>
          <div className="flex flex-wrap gap-1.5">
            {ENTRANCES.map((e) => (
              <Chip key={e} active={(layer.enter ?? "none") === e} onClick={() => ed.update(layer.id, { enter: e === "none" ? undefined : e })} className="min-h-8">{copy.entrances[e]}</Chip>
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={() => ed.move(layer.id, "up")}><ArrowUpToLine className="h-4 w-4" />{copy.bringForward}</Button>
        <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={() => ed.move(layer.id, "down")}><ArrowDownToLine className="h-4 w-4" />{copy.sendBackward}</Button>
        <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={() => ed.duplicate(layer.id)} data-testid="editor-duplicate"><Copy className="h-4 w-4" />{copy.duplicate}</Button>
        <Button type="button" variant="outline" className="min-h-10 rounded-xl text-live" onClick={() => ed.remove(layer.id)} data-testid="editor-delete"><Trash2 className="h-4 w-4" />{copy.remove}</Button>
      </div>
    </Section>
  );
}

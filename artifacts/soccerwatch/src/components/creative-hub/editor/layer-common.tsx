import { ArrowDownToLine, ArrowUpToLine, Copy, Trash2 } from "lucide-react";
import type { SceneLayer } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { Button } from "@/components/ui/button";
import { Chip, NumberSlider, Section } from "./controls";
import type { EditorApi } from "./editor-api";

const ENTRANCES = ["none", "fade", "slide-up", "slide-left", "pop", "push-up", "push-down", "wipe"] as const;

/** Opacity, rotation, entrance and the arrange buttons, under every kind's own controls. */
export function LayerCommon({ ed, layer }: { ed: EditorApi; layer: SceneLayer }) {
  const copy = useCreativeEditorCopy();
  return (
    <Section title={copy.layerKinds[layer.kind]}>
      <NumberSlider label={copy.opacity} value={Math.round((layer.opacity ?? 1) * 100)} min={0} max={100} unit="%"
        onChange={(v) => ed.update(layer.id, { opacity: v >= 100 ? undefined : v / 100 }, "opacity")} />
      <NumberSlider label={copy.rotation} value={layer.rotation ?? 0} min={-180} max={180} unit="°"
        onChange={(v) => ed.update(layer.id, { rotation: v === 0 ? undefined : v }, "rotation")} />
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

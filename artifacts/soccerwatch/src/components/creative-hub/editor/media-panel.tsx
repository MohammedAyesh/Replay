import { Film, ImagePlus, Replace, Shield } from "lucide-react";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { newMediaLayer, type MediaLayer } from "@/lib/creative-editor-state";
import { Button } from "@/components/ui/button";
import { Chip, NumberSlider, Section, Toggle, panelEmpty } from "./controls";
import { LayerCommon } from "./layer-common";
import type { EditorApi } from "./editor-api";

export function MediaPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const layer = ed.selected && (ed.selected.kind === "image" || ed.selected.kind === "video") ? (ed.selected as MediaLayer) : null;

  const adders = (
    <div className="grid grid-cols-2 gap-2">
      <Button type="button" variant="outline" className="min-h-10 rounded-xl" data-testid="editor-add-picture"
        onClick={() => ed.pick("image", (src) => ed.add(newMediaLayer(ed.scene, "image", src)))}>
        <ImagePlus className="h-4 w-4" />{copy.addPicture}
      </Button>
      <Button type="button" variant="outline" className="min-h-10 rounded-xl" data-testid="editor-add-crest"
        onClick={() => ed.add(newMediaLayer(ed.scene, "image", { type: "crest" }))}>
        <Shield className="h-4 w-4" />{copy.addCrest}
      </Button>
      {ed.isVideo ? (
        <Button type="button" variant="outline" className="col-span-2 min-h-10 rounded-xl" data-testid="editor-add-video"
          onClick={() => ed.pick("video", (src, meta) => ed.add(newMediaLayer(ed.scene, "video", src, meta.durationMs)))}>
          <Film className="h-4 w-4" />{copy.addVideo}
        </Button>
      ) : null}
    </div>
  );

  if (!layer) {
    return (
      <div className="space-y-3">
        {adders}
        {!ed.isVideo ? <p className="text-xs text-muted-text">{copy.videoOnlyInVideo}</p> : null}
        <p className={panelEmpty}>{copy.nothingSelected}</p>
      </div>
    );
  }

  const replace = () => ed.pick(layer.kind === "video" ? "video" : "image", (src, meta) => {
    if (layer.kind === "video") {
      const span = src.type === "recording" ? src.toMs - src.fromMs : meta.durationMs;
      ed.update(layer.id, { src, trimInMs: 0, trimOutMs: span, slowMo: undefined });
    } else ed.update(layer.id, { src });
  });
  const sourceLabel = copy.mediaKinds[layer.src.type] ?? layer.src.type;

  return (
    <div className="space-y-5" data-testid="editor-media-panel">
      <Section title={copy.layerKinds[layer.kind]}>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3">
          <span className="text-sm text-text">{sourceLabel}</span>
          <Button type="button" size="sm" className="min-h-9 rounded-xl" onClick={replace} data-testid="editor-replace-media">
            <Replace className="h-4 w-4" />{copy.replace}
          </Button>
        </div>
        {layer.src.type === "binding" ? <p className="text-xs text-muted-text">{copy.slotEmpty}</p> : null}
        {layer.kind === "image" && layer.src.type !== "crest" ? (
          <Button type="button" variant="outline" className="min-h-10 w-full rounded-xl" onClick={() => ed.update(layer.id, { src: { type: "crest" }, fit: "contain" })}>
            <Shield className="h-4 w-4" />{copy.useCrest}
          </Button>
        ) : null}
      </Section>

      <Section title={copy.fit}>
        <div className="flex gap-1.5">
          <Chip active={(layer.fit ?? "cover") === "cover"} onClick={() => ed.update(layer.id, { fit: "cover" })}>{copy.fitCover}</Chip>
          <Chip active={layer.fit === "contain"} onClick={() => ed.update(layer.id, { fit: "contain" })}>{copy.fitContain}</Chip>
        </div>
        {layer.kind === "image" ? (
          <>
            <Toggle id={`cutout-${layer.id}`} label={copy.cutout} checked={!!layer.cutout} onChange={(v) => ed.update(layer.id, { cutout: v || undefined })} />
            <NumberSlider label={copy.roundness} value={layer.radius ?? 0} min={0} max={300} onChange={(v) => ed.update(layer.id, { radius: v || undefined }, "radius")} />
          </>
        ) : (
          <Toggle id={`muted-${layer.id}`} label={copy.muted} checked={!!layer.muted} onChange={(v) => ed.update(layer.id, { muted: v })} />
        )}
      </Section>

      <LayerCommon ed={ed} layer={layer} />
      {adders}
    </div>
  );
}

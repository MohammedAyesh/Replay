import { useState } from "react";
import { Crosshair, Film, ImagePlus, Replace, Shield } from "lucide-react";
import { useCreativeFramerCopy } from "@/i18n/creative-framer-strings";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { newMediaLayer, uniqueLayerId, type MediaLayer } from "@/lib/creative-editor-state";
import { Button } from "@/components/ui/button";
import { Chip, NumberSlider, Section, Toggle, panelEmpty } from "./controls";
import { LayerCommon } from "./layer-common";
import type { EditorApi } from "./editor-api";
import { CameraDialog, framerFootage } from "./camera-dialog";

export function MediaPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const framerCopy = useCreativeFramerCopy();
  const [cameraOpen, setCameraOpen] = useState(false);
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
          onClick={() => ed.pick("video", (src, meta) => {
            const layer = newMediaLayer(ed.scene, "video", src, meta.durationMs);
            ed.add(layer);
            ed.frameFootage({ layerId: uniqueLayerId(ed.scene, layer.id) }, src);
          })}>
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
      ed.frameFootage({ layerId: layer.id }, src);
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
        {layer.kind === "video" && framerFootage(ed, layer) ? (
          <>
            <Button type="button" variant="outline" className="min-h-10 w-full rounded-xl" onClick={() => setCameraOpen(true)} data-testid="editor-camera">
              <Crosshair className="h-4 w-4" />{framerCopy.title}
            </Button>
            <CameraDialog ed={ed} layer={layer} open={cameraOpen} onOpenChange={setCameraOpen} />
          </>
        ) : layer.src.type === "binding" ? <p className="text-xs text-muted-text">{copy.slotEmpty}</p> : null}
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
          <>
            <Toggle id={`muted-${layer.id}`} label={copy.muted} checked={!!layer.muted} onChange={(v) => ed.update(layer.id, { muted: v })} />
            {framerFootage(ed, layer) ? (
              <Toggle id={`trail-${layer.id}`} label={copy.ballTrail} checked={!!layer.ballTrail} testId="editor-ball-trail"
                onChange={(v) => ed.update(layer.id, { ballTrail: v || undefined })} />
            ) : null}
          </>
        )}
      </Section>

      <LayerCommon ed={ed} layer={layer} />
      {adders}
    </div>
  );
}

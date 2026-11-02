import { Circle, Minus, Square } from "lucide-react";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { newShapeLayer, type ShapeLayer } from "@/lib/creative-editor-state";
import { ColorPicker, NumberSlider, Section, Toggle, panelEmpty } from "./controls";
import { LayerCommon } from "./layer-common";
import type { EditorApi } from "./editor-api";

const SHAPES: Array<{ shape: ShapeLayer["shape"]; icon: typeof Square }> = [
  { shape: "rect", icon: Square }, { shape: "ellipse", icon: Circle }, { shape: "line", icon: Minus }, { shape: "slant", icon: Square },
];

export function ShapesPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const layer = ed.selected?.kind === "shape" ? ed.selected : null;
  const adders = (
    <Section title={copy.addShape}>
      <div className="grid grid-cols-4 gap-2">
        {SHAPES.map(({ shape, icon: Icon }) => (
          <button key={shape} type="button" onClick={() => ed.add(newShapeLayer(ed.scene, shape))} data-testid={`editor-add-shape-${shape}`}
            className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface text-[11px] font-semibold text-muted-text hover:text-text">
            <Icon className={shape === "slant" ? "h-5 w-5 -skew-x-12" : "h-5 w-5"} />
            {copy.shapes[shape]}
          </button>
        ))}
      </div>
    </Section>
  );
  if (!layer) return <div className="space-y-3">{adders}<p className={panelEmpty}>{copy.nothingSelected}</p></div>;
  const set = (change: Partial<ShapeLayer>, key?: string) => ed.update(layer.id, change, key);
  return (
    <div className="space-y-5" data-testid="editor-shape-panel">
      <Section title={copy.fill}>
        <ColorPicker label={copy.fill} value={layer.gradient?.from ?? layer.fill} brand={ed.brand}
          onChange={(c) => (layer.gradient ? set({ gradient: { ...layer.gradient, from: c } }, "gradFrom") : set({ fill: c }, "fill"))} />
        <Toggle id={`grad-${layer.id}`} label={copy.gradient} checked={!!layer.gradient}
          onChange={(v) => set({ gradient: v ? { from: layer.fill ?? "@primary", to: "#00000000", angle: 180 } : undefined })} />
        {layer.gradient ? (
          <div className="space-y-3 rounded-xl bg-raised/60 p-3">
            <ColorPicker label={copy.gradientTo} value={layer.gradient.to} brand={ed.brand} onChange={(c) => set({ gradient: { ...layer.gradient!, to: c } }, "gradTo")} />
            <NumberSlider label={copy.angle} value={layer.gradient.angle ?? 180} min={0} max={360} unit="°" onChange={(v) => set({ gradient: { ...layer.gradient!, angle: v } }, "gradAngle")} />
          </div>
        ) : null}
      </Section>
      <Section title={copy.outline}>
        <Toggle id={`sstroke-${layer.id}`} label={copy.outline} checked={!!layer.stroke}
          onChange={(v) => set({ stroke: v ? { color: "@ink", width: 4 } : undefined })} />
        {layer.stroke ? (
          <div className="space-y-3 rounded-xl bg-raised/60 p-3">
            <ColorPicker label={copy.colour} value={layer.stroke.color} brand={ed.brand} onChange={(c) => set({ stroke: { ...layer.stroke!, color: c } }, "strokeColor")} />
            <NumberSlider label={copy.width} value={layer.stroke.width} min={0} max={40} onChange={(v) => set({ stroke: { ...layer.stroke!, width: v } }, "strokeWidth")} />
          </div>
        ) : null}
        {layer.shape === "rect" ? <NumberSlider label={copy.roundness} value={layer.radius ?? 0} min={0} max={300} onChange={(v) => set({ radius: v || undefined }, "radius")} /> : null}
        {layer.shape === "slant" ? <NumberSlider label={copy.skew} value={layer.skew ?? 0} min={-45} max={45} unit="°" onChange={(v) => set({ skew: v }, "skew")} /> : null}
      </Section>
      <LayerCommon ed={ed} layer={layer} />
      {adders}
    </div>
  );
}

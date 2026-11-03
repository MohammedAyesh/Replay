import { useRef, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Braces, Plus } from "lucide-react";
import { fillText } from "@workspace/api-zod";
import { fieldLabel, useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { insertBinding, newTextLayer, type TextLayer } from "@/lib/creative-editor-state";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Chip, ColorPicker, NumberSlider, Section, Toggle, panelEmpty } from "./controls";
import { LayerCommon } from "./layer-common";
import type { EditorApi } from "./editor-api";

const FONTS: TextLayer["font"][] = ["display", "condensed", "body", "serif", "script", "arabic", "arabic-display"];
const FONT_CLASS: Record<TextLayer["font"], string> = {
  display: "font-display font-extrabold", condensed: "font-display tracking-tight", body: "font-sans", serif: "font-serif",
  script: "italic", arabic: "font-sans", "arabic-display": "font-display font-black",
};
const WEIGHTS = [400, 600, 700, 800, 900];

export function TextPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const layer = ed.selected?.kind === "text" ? ed.selected : null;
  const addButton = (
    <Button type="button" variant="outline" className="min-h-10 w-full rounded-xl" data-testid="editor-add-text"
      onClick={() => ed.add(newTextLayer(ed.scene, copy.newText))}>
      <Plus className="h-4 w-4" />{copy.addText}
    </Button>
  );
  if (!layer) return <div className="space-y-3">{addButton}<p className={panelEmpty}>{copy.nothingSelected}</p></div>;
  return <TextEditor key={layer.id} ed={ed} layer={layer} addButton={addButton} />;
}

function TextEditor({ ed, layer, addButton }: { ed: EditorApi; layer: TextLayer; addButton: ReactNode }) {
  const copy = useCreativeEditorCopy();
  const area = useRef<HTMLTextAreaElement>(null);
  const set = (change: Partial<TextLayer>, key?: string) => ed.update(layer.id, change, key);
  const filled = fillText(layer.text, ed.data, false);

  const insert = (path: string) => {
    const el = area.current;
    const { text, caret } = insertBinding(layer.text, path, el?.selectionStart ?? layer.text.length, el?.selectionEnd ?? layer.text.length);
    set({ text });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
  };

  return (
    <div className="space-y-5" data-testid="editor-text-panel">
      <Section title={copy.content}>
        <Textarea ref={area} value={layer.text} rows={3} dir="auto" maxLength={2000} data-testid="editor-text-content"
          onChange={(e) => set({ text: e.target.value }, "text")} className="rounded-xl bg-surface text-base" />
        {ed.fields.length ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-text"><Braces className="h-3.5 w-3.5" />{copy.insertField}</p>
            <div className="flex flex-wrap gap-1.5">
              {ed.fields.filter((f) => f !== "media" && f !== "player.photo" && !f.startsWith("more.") && !f.startsWith("photos.")).map((f) => (
                <Chip key={f} onClick={() => insert(f)} testId={`editor-binding-${f}`} className="min-h-8 px-2.5">{fieldLabel(copy, f)}</Chip>
              ))}
            </div>
            <p className="text-[11px] text-muted-text">{copy.insertFieldHint}</p>
          </div>
        ) : null}
        {filled !== layer.text ? (
          <p className="rounded-lg bg-raised px-3 py-2 text-xs text-muted-text"><span className="font-semibold">{copy.showsAs}: </span><bdi dir="auto" className="text-text">{filled || "—"}</bdi></p>
        ) : null}
      </Section>

      <Section title={copy.font}>
        <div className="flex flex-wrap gap-1.5">
          {FONTS.map((f) => (
            <Chip key={f} active={layer.font === f} onClick={() => set({ font: f })} className={FONT_CLASS[f]} testId={`editor-font-${f}`}>{copy.fonts[f]}</Chip>
          ))}
        </div>
        <NumberSlider label={copy.size} value={layer.size} min={12} max={400} onChange={(v) => set({ size: v }, "size")} testId="editor-text-size" />
        <div className="flex flex-wrap gap-1.5">
          {WEIGHTS.map((w) => <Chip key={w} active={(layer.weight ?? 700) === w} onClick={() => set({ weight: w })} className="min-h-8"><span style={{ fontWeight: w }}>{copy.weights[w]}</span></Chip>)}
          <Chip active={!!layer.italic} onClick={() => set({ italic: !layer.italic || undefined })} className="min-h-8 italic">{copy.italic}</Chip>
          <Chip active={!!layer.uppercase} onClick={() => set({ uppercase: !layer.uppercase || undefined })} className="min-h-8">{copy.uppercase}</Chip>
        </div>
      </Section>

      <Section title={copy.colour}>
        <ColorPicker label={copy.colour} value={layer.color} brand={ed.brand} onChange={(c) => set({ color: c }, "color")} testId="editor-text-colour" />
      </Section>

      <Section title={copy.align}>
        <div className="flex flex-wrap gap-1.5">
          {([["start", AlignLeft, copy.alignStart], ["center", AlignCenter, copy.alignCenter], ["end", AlignRight, copy.alignEnd]] as const).map(([a, Icon, label]) => (
            <Chip key={a} active={(layer.align ?? "start") === a} onClick={() => set({ align: a })} title={label}><Icon className="h-4 w-4 rtl:-scale-x-100" />{label}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {([["auto", copy.dirAuto], ["rtl", copy.dirRtl], ["ltr", copy.dirLtr]] as const).map(([d, label]) => (
            <Chip key={d} active={(layer.dir ?? "auto") === d} onClick={() => set({ dir: d })} className="min-h-8">{label}</Chip>
          ))}
        </div>
        <NumberSlider label={copy.letterSpacing} value={layer.letterSpacing ?? 0} min={-10} max={40} onChange={(v) => set({ letterSpacing: v || undefined }, "letterSpacing")} />
        <NumberSlider label={copy.lineHeight} value={layer.lineHeight ?? 1.1} min={0.7} max={2} step={0.05} onChange={(v) => set({ lineHeight: v }, "lineHeight")} />
        <Toggle id={`fit-${layer.id}`} label={copy.fitText} checked={!!layer.fit} onChange={(v) => set({ fit: v || undefined })} />
      </Section>

      <Section title={copy.outline}>
        <Toggle id={`stroke-${layer.id}`} label={copy.outline} checked={!!layer.stroke} testId="editor-text-stroke"
          onChange={(v) => set({ stroke: v ? { color: "@paper", width: 4 } : undefined })} />
        {layer.stroke ? (
          <div className="space-y-3 rounded-xl bg-raised/60 p-3">
            <ColorPicker label={copy.colour} value={layer.stroke.color} brand={ed.brand} onChange={(c) => set({ stroke: { ...layer.stroke!, color: c } }, "strokeColor")} />
            <NumberSlider label={copy.width} value={layer.stroke.width} min={0} max={30} onChange={(v) => set({ stroke: { ...layer.stroke!, width: v } }, "strokeWidth")} />
          </div>
        ) : null}
        <Toggle id={`shadow-${layer.id}`} label={copy.shadow} checked={!!layer.shadow} testId="editor-text-shadow"
          onChange={(v) => set({ shadow: v ? { color: "#00000099", blur: 24, x: 0, y: 6 } : undefined })} />
        {layer.shadow ? (
          <div className="space-y-3 rounded-xl bg-raised/60 p-3">
            <ColorPicker label={copy.colour} value={layer.shadow.color} brand={ed.brand} onChange={(c) => set({ shadow: { ...layer.shadow!, color: c } }, "shadowColor")} />
            <NumberSlider label={copy.blur} value={layer.shadow.blur} min={0} max={80} onChange={(v) => set({ shadow: { ...layer.shadow!, blur: v } }, "shadowBlur")} />
          </div>
        ) : null}
        <Toggle id={`pill-${layer.id}`} label={copy.pill} checked={!!layer.background} testId="editor-text-pill"
          onChange={(v) => set({ background: v ? { color: "@primary", padding: 24, radius: 999 } : undefined })} />
        {layer.background ? (
          <div className="space-y-3 rounded-xl bg-raised/60 p-3">
            <ColorPicker label={copy.colour} value={layer.background.color} brand={ed.brand} onChange={(c) => set({ background: { ...layer.background!, color: c } }, "pillColor")} />
            <NumberSlider label={copy.padding} value={layer.background.padding} min={0} max={120} onChange={(v) => set({ background: { ...layer.background!, padding: v } }, "pillPadding")} />
            <NumberSlider label={copy.roundness} value={Math.min(layer.background.radius, 200)} min={0} max={200} onChange={(v) => set({ background: { ...layer.background!, radius: v } }, "pillRadius")} />
          </div>
        ) : null}
      </Section>

      <LayerCommon ed={ed} layer={layer} />
      {addButton}
    </div>
  );
}

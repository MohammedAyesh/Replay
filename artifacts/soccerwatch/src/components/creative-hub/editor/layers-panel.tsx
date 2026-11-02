import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, Film, Image, Lock, LockOpen, Shapes, Trash2, Type } from "lucide-react";
import { fillText, type SceneLayer } from "@workspace/api-zod";
import { useCreativeEditorCopy, type CreativeEditorStrings } from "@/i18n/creative-editor-strings";
import { cn } from "@/lib/utils";
import { panelEmpty } from "./controls";
import type { EditorApi } from "./editor-api";

const ICON = { text: Type, image: Image, video: Film, shape: Shapes } as const;

export function layerTitle(layer: SceneLayer, copy: CreativeEditorStrings, data: EditorApi["data"]): string {
  if (layer.name) return layer.name;
  if (layer.kind === "text") {
    const t = fillText(layer.text, data, true).replace(/\s+/g, " ").trim();
    return t ? (t.length > 28 ? `${t.slice(0, 28)}…` : t) : copy.layerKinds.text;
  }
  if (layer.kind === "shape") return copy.shapes[layer.shape];
  return copy.mediaKinds[layer.src.type] ?? copy.layerKinds[layer.kind];
}

export function LayersPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const layers = [...ed.scene.layers].reverse();
  if (!layers.length) return <p className={panelEmpty}>{copy.noLayers}</p>;
  return (
    <div className="space-y-2" data-testid="editor-layers-panel">
      <p className="text-xs text-muted-text">{copy.layersHint}</p>
      <ul className="space-y-1.5">
        {layers.map((layer, i) => {
          const Icon = ICON[layer.kind];
          const active = ed.selected?.id === layer.id;
          return (
            <li key={layer.id} data-testid={`editor-layer-${layer.id}`}
              className={cn("flex items-center gap-1 rounded-xl border bg-surface p-1 ps-2", active ? "border-turf" : "border-line", layer.hidden && "opacity-60")}>
              <button type="button" onClick={() => ed.select(layer.id)} className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-start">
                <Icon className="h-4 w-4 shrink-0 text-muted-text" />
                <bdi dir="auto" className="truncate text-sm text-text">{layerTitle(layer, copy, ed.data)}</bdi>
              </button>
              <RowButton label={layer.hidden ? copy.show : copy.hide} onClick={() => ed.update(layer.id, { hidden: layer.hidden ? undefined : true })}>
                {layer.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </RowButton>
              <RowButton label={layer.locked ? copy.unlock : copy.lock} onClick={() => ed.update(layer.id, { locked: layer.locked ? undefined : true })} active={layer.locked}>
                {layer.locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
              </RowButton>
              <RowButton label={copy.bringForward} onClick={() => ed.move(layer.id, "up")} disabled={i === 0}><ChevronUp className="h-4 w-4" /></RowButton>
              <RowButton label={copy.sendBackward} onClick={() => ed.move(layer.id, "down")} disabled={i === layers.length - 1}><ChevronDown className="h-4 w-4" /></RowButton>
              <RowButton label={copy.remove} onClick={() => ed.remove(layer.id)} className="hover:text-live"><Trash2 className="h-4 w-4" /></RowButton>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RowButton({ label, onClick, children, disabled, active, className }: {
  label: string; onClick: () => void; children: ReactNode; disabled?: boolean; active?: boolean; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className={cn("grid h-10 w-9 shrink-0 place-items-center rounded-lg text-muted-text hover:text-text disabled:opacity-30", active && "text-floodlight", className)}>
      {children}
    </button>
  );
}

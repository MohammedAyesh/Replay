import { useMemo } from "react";
import { Check } from "lucide-react";
import { CREATIVE_STYLES, type CreativeStyle, type Scene } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { changeStyle } from "@/lib/creative-editor-state";
import { cn } from "@/lib/utils";
import { SceneCanvas } from "../scene-canvas";
import { panelEmpty } from "./controls";
import type { EditorApi } from "./editor-api";

/** The seven looks, each previewed with the manager's own text and pictures carried over. */
export function StylePanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const current = ed.scene.template?.style ?? null;
  const previews = useMemo(() => {
    if (!ed.scene.template) return null;
    const out = {} as Record<CreativeStyle, Scene>;
    for (const s of CREATIVE_STYLES) out[s] = s === current ? ed.scene : changeStyle(ed.scene, s);
    return out;
  }, [ed.scene, current]);
  if (!previews) return <p className={panelEmpty}>{copy.noTemplate}</p>;
  return (
    <div className="space-y-3" data-testid="editor-style-panel">
      <p className="text-xs text-muted-text">{copy.styleHint}</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
        {CREATIVE_STYLES.map((s) => (
          <button key={s} type="button" onClick={() => ed.setStyle(s)} aria-pressed={current === s} data-testid={`editor-style-${s}`}
            className={cn("group relative flex flex-col items-center gap-1.5 rounded-xl border p-1.5 transition-colors",
              current === s ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text")}>
            <div className="pointer-events-none w-full overflow-hidden rounded-lg">
              <SceneCanvas scene={previews[s]} brand={ed.brand} data={ed.data} width={96} mediaUrl={ed.mediaUrl} className="mx-auto" />
            </div>
            <span className="text-[11px] font-semibold text-text">{copy.styles[s]}</span>
            {current === s ? <Check className="absolute end-2 top-2 h-4 w-4 rounded-full bg-turf p-0.5 text-void" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

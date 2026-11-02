import type { CreativeFormat } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { cn } from "@/lib/utils";
import type { EditorApi } from "./editor-api";

const FORMATS: Array<{ f: CreativeFormat; box: string }> = [
  { f: "post", box: "h-12 w-[38px]" },
  { f: "square", box: "h-10 w-10" },
  { f: "story", box: "h-14 w-[31px]" },
];

export function FormatPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const designed = ed.template?.formats ?? [];
  return (
    <div className="space-y-3" data-testid="editor-format-panel">
      <div className="grid grid-cols-3 gap-2">
        {FORMATS.map(({ f, box }) => (
          <button key={f} type="button" onClick={() => ed.setFormat(f)} aria-pressed={ed.scene.format === f} data-testid={`editor-format-${f}`}
            className={cn("flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border p-2 text-center",
              ed.scene.format === f ? "border-turf bg-turf/10" : "border-line bg-surface hover:border-muted-text")}>
            <span className={cn("rounded-md border-2", box, ed.scene.format === f ? "border-turf" : "border-muted-text")} />
            <span className="text-sm font-semibold text-text">{copy.formats[f]}</span>
            <span className="text-[11px] text-muted-text"><bdi>{copy.formatSizes[f]}</bdi></span>
            {designed.includes(f) ? <span className="rounded-full bg-violet/20 px-2 py-0.5 text-[10px] font-semibold text-violet">{copy.designedFor}</span> : null}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-text">{copy.formatHint}</p>
    </div>
  );
}

import type { CreativeFormat } from "@workspace/api-zod";
import { useCreativeEditorCopy } from "@/i18n/creative-editor-strings";
import { useCreativeFramerCopy } from "@/i18n/creative-framer-strings";
import { NO_BRANDING } from "@/lib/creative-framing";
import { Toggle } from "./controls";
import { cn } from "@/lib/utils";
import type { EditorApi } from "./editor-api";

const FORMATS: Array<{ f: CreativeFormat; box: string }> = [
  { f: "post", box: "h-12 w-[38px]" },
  { f: "square", box: "h-10 w-10" },
  { f: "story", box: "h-14 w-[31px]" },
  { f: "wide", box: "h-[27px] w-12" },
];

export function FormatPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeEditorCopy();
  const designed = ed.template?.formats ?? [];
  return (
    <div className="space-y-3" data-testid="editor-format-panel">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
      {ed.isVideo ? <BrandingSwitches ed={ed} /> : null}
    </div>
  );
}

/** A video's branding: the venue's mark over it and its sign-off card after it. */
function BrandingSwitches({ ed }: { ed: EditorApi }) {
  const copy = useCreativeFramerCopy();
  const b = ed.scene.branding ?? NO_BRANDING;
  return (
    <div className="space-y-1 rounded-xl border border-line bg-surface p-3" data-testid="editor-branding">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-text">{copy.branding}</p>
      <Toggle id="branding-logo" label={copy.logo} checked={b.overlay} onChange={(v) => ed.updateScene({ branding: { ...b, overlay: v } })} />
      <Toggle id="branding-end-card" label={copy.endCard} checked={b.endCard} onChange={(v) => ed.updateScene({ branding: { ...b, endCard: v } })} />
    </div>
  );
}

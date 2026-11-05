import { useState } from "react";
import { BookmarkPlus, Trash2 } from "lucide-react";
import { CLUB_TEMPLATES, CREATIVE_TEMPLATES, FIELD_TEMPLATES, type CreativeBrand, type CreativeData, type Scene, type SceneLayer, type TemplateMeta } from "@workspace/api-zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMyTemplatesCopy } from "@/i18n/my-templates-strings";
import { useConsoleKind } from "@/lib/console-kind";
import { useMyTemplateActions, useMyTemplates, type MyTemplate } from "@/lib/my-templates-api";
import { cn } from "@/lib/utils";
import { TemplateCard } from "./templates/template-card";

type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;
const CATALOGUE: TemplateMeta[] = [...CREATIVE_TEMPLATES, ...FIELD_TEMPLATES, ...CLUB_TEMPLATES];
export const catalogueMeta = (key: string | null | undefined) => (key ? CATALOGUE.find((t) => t.key === key) ?? null : null);

/**
 * Editor → "Save as template": keeps the design to start from again (My templates). A design
 * made from one of the academy's templates can update it instead. "Use it instead" makes it
 * stand in for the catalogue template everywhere, the autopilots included.
 */
export function SaveTemplateButton({ academyId, projectId, templateKey, scene, title, flush, onMarked }: {
  academyId: number;
  projectId: number;
  templateKey: string | null;
  scene: Scene;
  title: string;
  /** Saves the editor's changes first: the server reads the project. */
  flush: () => Promise<unknown>;
  /** The design now belongs to this template (scene.template.mine). */
  onMarked: (template: MyTemplate) => void;
}) {
  const copy = useMyTemplatesCopy();
  const venue = useConsoleKind() === "venue";
  const list = useMyTemplates(academyId);
  const act = useMyTemplateActions(academyId);
  const [open, setOpen] = useState(false);
  const baseKey = templateKey ?? scene.template?.key ?? null;
  const base = catalogueMeta(baseKey);
  const baseTitle = base ? base.title[copy.locale] : "";
  const mine = list.data?.find((t) => t.id === scene.template?.mine) ?? null;
  const [name, setName] = useState("");
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const busy = act.save.isPending || act.update.isPending;
  const error = act.save.error ?? act.update.error;

  const start = () => {
    setName(mine?.title ?? (title || baseTitle).slice(0, 80));
    setReplace(mine?.replacesBase ?? false);
    setDone(null);
    act.save.reset();
    act.update.reset();
    setOpen(true);
  };
  const finish = (t: MyTemplate) => { onMarked(t); setDone(copy.saved(t.title)); setTimeout(() => setOpen(false), 900); };
  const saveNew = async () => {
    await flush();
    finish(await act.save.mutateAsync({ projectId, title: name.trim(), replacesBase: replace }));
  };
  const update = async () => {
    if (!mine) return;
    await flush();
    finish(await act.update.mutateAsync({ id: mine.id, projectId, title: name.trim(), replacesBase: replace }));
  };

  return (
    <>
      <Button type="button" variant="outline" className="min-h-10 rounded-xl" onClick={start} data-testid="editor-save-template">
        <BookmarkPlus className="h-4 w-4" /><span className="hidden sm:inline">{copy.save}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="save-template-dialog">
          <DialogHeader>
            <DialogTitle>{copy.dialogTitle}</DialogTitle>
            <DialogDescription>{baseKey ? copy.dialogBody : copy.noTemplate}</DialogDescription>
          </DialogHeader>
          {baseKey ? (
            <div className="space-y-4">
              <label className="block text-sm font-semibold text-text">{copy.name}
                <input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} dir="auto" data-testid="save-template-name"
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-line bg-raised px-3 text-sm text-text focus:border-turf focus:outline-none" />
              </label>
              {base ? (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-raised/50 p-3">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--turf,#22c55e)]" data-testid="save-template-replace" />
                  <span className="text-sm">
                    <span className="block font-semibold text-text">{copy.replace(baseTitle)}</span>
                    <span className="block text-xs leading-5 text-muted-text">{venue ? copy.replaceHintVenue : copy.replaceHintAcademy}</span>
                  </span>
                </label>
              ) : null}
              {error ? <p className="text-sm text-red-400" role="alert">{(error as Error).message}</p> : null}
              {done ? <p className="text-sm font-semibold text-turf" role="status">{done}</p> : null}
              <div className="flex flex-col gap-2">
                {mine ? (
                  <>
                    <Button type="button" className="min-h-11 rounded-xl" disabled={busy || !name.trim()} onClick={() => void update()} data-testid="save-template-update">
                      {busy ? copy.saving : copy.update(mine.title)}
                    </Button>
                    <p className="-mt-1 text-xs text-muted-text">{copy.updateHint}</p>
                  </>
                ) : null}
                <Button type="button" variant={mine ? "outline" : "default"} className="min-h-11 rounded-xl" disabled={busy || !name.trim()} onClick={() => void saveNew()} data-testid="save-template-new">
                  {busy && !mine ? copy.saving : mine ? copy.asNew : copy.save}
                </Button>
                <Button type="button" variant="ghost" className="min-h-10 rounded-xl" onClick={() => setOpen(false)}>{copy.cancel}</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Templates → My templates: the academy's saved designs, opened like any template. */
export function MyTemplatesGrid({ academyId, brand, width, cols, gap, dataFor, mediaUrl, onOpen, pending, labels }: {
  academyId: number;
  brand: CreativeBrand;
  width: number;
  cols: number;
  gap: number;
  /** The starting data the catalogue template would get (seed, latest match, academy). */
  dataFor: (baseKey: string) => CreativeData;
  mediaUrl: (layer: MediaLayer) => string | null;
  onOpen: (t: MyTemplate) => void;
  pending: number | null;
  labels: { video: string; seconds: (n: number) => string; creating: string; open: (title: string) => string };
}) {
  const copy = useMyTemplatesCopy();
  const list = useMyTemplates(academyId);
  const act = useMyTemplateActions(academyId);
  if (list.isLoading) return <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap }}>{Array.from({ length: cols }, (_, i) => <div key={i} className="aspect-[4/5] animate-pulse rounded-xl bg-raised" />)}</div>;
  if (list.isError) return <p className="text-sm text-red-400" role="alert">{(list.error as Error).message}</p>;
  const items = list.data ?? [];
  if (!items.length) return <p className="text-sm text-muted-text" data-testid="my-templates-empty">{copy.empty}</p>;
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap }} data-testid="my-templates">
      {items.map((t) => {
        const base = catalogueMeta(t.baseKey);
        const meta: TemplateMeta = { ...(base ?? { key: t.baseKey, formats: [t.format], title: { en: t.title, ar: t.title } } as TemplateMeta), key: `my-${t.id}`, kind: t.kind } as TemplateMeta;
        return (
          <div key={t.id} className="min-w-0">
            <TemplateCard meta={meta} title={t.title} scene={t.scene} data={{ ...(t.sampleData ?? {}), ...dataFor(t.baseKey) }} brand={brand} width={width}
              mediaUrl={mediaUrl} onOpen={() => onOpen(t)} busy={pending === t.id} disabled={pending !== null} failed={null}
              labels={{ ...labels, open: labels.open(t.title) }}
              star={t.replacesBase ? <span className="rounded-full bg-turf px-2 py-0.5 text-[11px] font-bold text-void">{copy.inUse}</span> : null} />
            {base ? <p className="truncate text-[11px] text-muted-text">{copy.basedOn(base.title[copy.locale])}</p> : null}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <button type="button" disabled={act.update.isPending} onClick={() => act.update.mutate({ id: t.id, replacesBase: !t.replacesBase })}
                data-testid={`my-template-replace-${t.id}`}
                className={cn("min-h-8 rounded-full border px-2.5 text-[11px] font-semibold", t.replacesBase ? "border-turf text-turf" : "border-line text-muted-text hover:text-text")}>
                {t.replacesBase ? copy.stopUsing : copy.useInstead}
              </button>
              <button type="button" aria-label={copy.remove} disabled={act.remove.isPending}
                onClick={() => { if (window.confirm(copy.confirmRemove(t.title))) act.remove.mutate(t.id); }}
                data-testid={`my-template-remove-${t.id}`} className="grid min-h-8 min-w-8 place-items-center rounded-full text-muted-text hover:text-live">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

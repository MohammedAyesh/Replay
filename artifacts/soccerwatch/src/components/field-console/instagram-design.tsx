import { useMemo, useState } from "react";
import { Check, Film, Loader2, Wand2 } from "lucide-react";
import { FIELD_STYLE, buildFieldMontage, buildTemplateScene, resolveSource, type CreativeBrand, type Scene, type SceneLayer } from "@workspace/api-zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SceneCanvas } from "@/components/creative-hub/scene-canvas";
import { startingData } from "@/components/creative-hub/templates/data";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { IG_PICKABLE, useItemCandidates, useSavePicks, type IgItem } from "@/lib/instagram-api";
import { cn } from "@/lib/utils";

/**
 * Field console → Instagram calendar: what a post looks like before it is rendered, and the
 * owner picking its clips.
 *
 * A post's design is made a few hours before its time, so until then there is no frame to show
 * (that box used to be black). DesignThumb draws the post's template live, in the field's own
 * colours, crest and name, with sample footage: what it will look like, at once.
 */

/** The field pack template each kind of post is made from. */
export const KIND_TEMPLATE: Record<string, string> = {
  booking_clip: "field-booking-clip",
  award_nominees: "field-nominees-cover",
  award_winner: "field-award",
  versus: "field-versus",
  top5: "field-top5",
  thanks: "field-thanks",
  match_week: "field-match-week",
  player_week: "field-potw",
  milestone: "field-milestone",
  open_slots: "field-open-slots",
  leaderboard: "field-leaderboard",
  match_highlights: "field-match-highlights",
  day_best: "field-day-best",
};

const FALLBACK: CreativeBrand = { primary: "#D4FF4F", accent: "#7B5CFF", ink: "#0B0F1A", paper: "#FFFFFF", muted: "#8A93A6", nameEn: "", nameAr: null };
type MediaLayer = Extract<SceneLayer, { kind: "image" | "video" }>;

/** The opening card, a moment in: crest, title and numbers are on screen. */
const THUMB_AT_MS = 1700;

export function DesignThumb({ venueId, item, width }: { venueId: number; item: Pick<IgItem, "kind" | "placement" | "picks">; width: number }) {
  const copy = useInstagramCopy();
  const brandQ = useCreativeBrand(venueId);
  const key = KIND_TEMPLATE[item.kind];
  const locale = copy.locale;
  const info = brandQ.data;
  const scene = useMemo<Scene | null>(() => {
    if (!key) return null;
    const format = item.placement === "carousel" ? "post" : "story";
    const clips = item.picks?.length ?? 0;
    return (key === "field-match-highlights" || key === "field-day-best") && clips >= 2
      ? buildFieldMontage(key, clips, format, locale)
      : buildTemplateScene(key, FIELD_STYLE, format, locale);
  }, [key, item.placement, item.picks?.length, locale]);
  const data = useMemo(() => key ? startingData({
    key, locale, seed: null,
    academy: { nameEn: info?.brand.nameEn ?? "", nameAr: info?.brand.nameAr ?? null, phone: info?.phone ?? null, instagram: info?.instagram ?? null, showPlayerNames: info?.showPlayerNames ?? false },
  }) : {}, [key, locale, info]);
  if (!scene || !info) return <div className="h-full w-full animate-pulse bg-raised" />;
  return (
    <div className="pointer-events-none h-full w-full" title={copy.calendar.designPreview} data-testid="ig-design-thumb">
      <SceneCanvas scene={scene} brand={info.brand ?? FALLBACK} data={data} width={width} timeMs={scene.durationMs ? THUMB_AT_MS : undefined}
        mediaUrl={(l: MediaLayer) => { const src = resolveSource(l.src, data); return src ? creativeMediaUrl(venueId, src, "still") : null; }} />
    </div>
  );
}

/** Pick the clips for a post, in play order; saving re-edits and renders it. */
export function PickClipsDialog({ venueId, item, onClose }: { venueId: number; item: IgItem; onClose: () => void }) {
  const copy = useInstagramCopy();
  const q = useItemCandidates(venueId, item.id);
  const save = useSavePicks(venueId);
  const rule = q.data ? { min: q.data.min, max: q.data.max } : IG_PICKABLE[item.kind] ?? { min: 1, max: 1 };
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? q.data?.picked ?? [];
  const toggle = (k: string) => {
    const now = chosen.includes(k) ? chosen.filter((x) => x !== k) : rule.max === 1 ? [k] : chosen.length >= rule.max ? chosen : [...chosen, k];
    setPicked(now);
  };
  const ok = chosen.length >= rule.min && chosen.length <= rule.max;
  const ar = copy.locale === "ar";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={ar ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-2xl" data-testid="ig-pick-dialog">
        <DialogHeader className="text-start">
          <DialogTitle>{copy.calendar.pickTitle}</DialogTitle>
          <DialogDescription className="text-start text-muted-text">{copy.calendar.pickHint(rule.min, rule.max)}</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{copy.calendar.pickLoading}</p>
        ) : q.isError ? (
          <p className="text-sm text-red-400" role="alert">{(q.error as Error).message}</p>
        ) : !q.data?.candidates.length ? (
          <p className="py-6 text-sm text-muted-text" data-testid="ig-pick-none">{q.data?.empty === "not_allowed" ? copy.calendar.pickNotAllowed : q.data?.empty === "no_games" ? copy.calendar.pickNoGames : copy.calendar.pickNone}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {q.data.candidates.map((c) => {
              const n = chosen.indexOf(c.key);
              return (
                <li key={c.key}>
                  <button type="button" onClick={() => toggle(c.key)} aria-pressed={n >= 0} data-testid={`ig-pick-${c.key}`}
                    className={cn("relative w-full overflow-hidden rounded-xl border text-start transition-colors", n >= 0 ? "border-turf ring-2 ring-turf" : "border-line hover:border-muted-text")}>
                    <span className="block aspect-video bg-void">
                      {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Film className="m-auto mt-6 h-5 w-5 text-muted-text" />}
                    </span>
                    {n >= 0 && <span className="absolute start-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-turf text-xs font-bold text-void">{rule.max === 1 ? <Check className="h-3.5 w-3.5" /> : n + 1}</span>}
                    <span className="block px-2 py-1.5">
                      <span className="block text-xs font-bold text-text">{copy.calendar.sources[c.source] ?? c.source}</span>
                      <span className="block truncate text-[11px] text-muted-text">{ar ? c.labelAr : c.label}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="button" disabled={!ok || save.isPending} onClick={() => save.mutate({ id: item.id, keys: chosen }, { onSuccess: onClose })} data-testid="ig-pick-save">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}<span className="ms-1.5">{copy.calendar.pickSave}</span>
          </Button>
          {(item.picks?.length ?? 0) > 0 && (
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate({ id: item.id, keys: [] }, { onSuccess: onClose })}>
              <Wand2 className="h-4 w-4" /><span className="ms-1.5">{copy.calendar.pickAuto}</span>
            </Button>
          )}
          <span className="text-xs text-muted-text">{copy.calendar.pickCount(chosen.length, rule.min, rule.max)}</span>
        </div>
        {save.error ? <p className="text-sm text-red-400" role="alert">{(save.error as Error).message}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

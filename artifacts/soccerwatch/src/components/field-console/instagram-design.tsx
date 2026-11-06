import { useMemo } from "react";
import { FIELD_STYLE, buildFieldMontage, buildTemplateScene, resolveSource, type CreativeBrand, type Scene, type SceneLayer } from "@workspace/api-zod";
import { SceneCanvas } from "@/components/creative-hub/scene-canvas";
import { startingData } from "@/components/creative-hub/templates/data";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { type IgItem } from "@/lib/instagram-api";

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

export { PickClipsDialog } from "./instagram-pick";

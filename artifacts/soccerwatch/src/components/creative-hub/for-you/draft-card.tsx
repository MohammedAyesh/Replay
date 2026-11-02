import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarPlus, Clapperboard, PenTool, Send, X } from "lucide-react";
import { resolveSource, type CreativeData, type SceneLayer } from "@workspace/api-zod";
import { Button } from "@/components/ui/button";
import type { CreativeForYouStrings } from "@/i18n/creative-foryou-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import type { CreativeBrandInfo } from "@/lib/creative-hub-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import type { ForYouDraft, ForYouFixture } from "@/lib/creative-hub-foryou-api";
import { SceneCanvas } from "../scene-canvas";
import { whyLine } from "./why";

const RATIO = { post: 1350 / 1080, square: 1, story: 1920 / 1080 } as const;

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;
    setWidth(node.clientWidth);
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

/** Resolves a preview's pictures and footage (bindings, crest, the academy's media). */
export function previewMediaUrl(academyId: number, brand: CreativeBrandInfo | undefined, data: CreativeData | undefined) {
  return (layer: Extract<SceneLayer, { kind: "image" | "video" }>): string | null => {
    const src = resolveSource(layer.src, data ?? {});
    if (!src) return null;
    if (src.type === "crest") {
      const crest = brand?.crestUrl ?? null;
      return crest ? (crest.startsWith("/api/") ? apiUrl(crest) : crest) : null;
    }
    return creativeMediaUrl(academyId, src, layer.kind === "video" ? "video" : "still");
  };
}

export function DraftCard({ draft, academyId, brand, copy, locale, busy, onEdit, onPublish, onSkip }: {
  draft: ForYouDraft;
  academyId: number;
  brand: CreativeBrandInfo | undefined;
  copy: CreativeForYouStrings;
  locale: "en" | "ar";
  busy: boolean;
  onEdit: () => void;
  onPublish: () => void;
  onSkip: () => void;
}) {
  const [box, boxWidth] = useWidth<HTMLDivElement>();
  const data = (draft.data ?? undefined) as CreativeData | undefined;
  const ratio = RATIO[draft.scene.format] ?? RATIO.post;
  // Tall stories stay on one screen: never taller than 560 px in the feed.
  const width = Math.max(0, Math.min(boxWidth, Math.floor(560 / ratio)));
  const isVideo = draft.scene.durationMs !== undefined;

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface" data-testid={`creative-draft-${draft.id}`}>
      <div ref={box} className="relative flex justify-center bg-raised">
        {brand && width > 0 ? (
          <SceneCanvas
            scene={draft.scene}
            brand={brand.brand}
            data={data}
            width={width}
            timeMs={isVideo ? Math.round((draft.scene.durationMs ?? 0) * 0.5) : undefined}
            mediaUrl={previewMediaUrl(academyId, brand, data)}
          />
        ) : (
          <div className="w-full animate-pulse bg-raised" style={{ aspectRatio: `1080 / ${Math.round(1080 * ratio)}`, maxHeight: 560 }} />
        )}
        <div className="pointer-events-none absolute start-2 top-2 flex flex-wrap gap-1">
          <span className="rounded-full bg-void/80 px-2.5 py-1 text-[11px] font-semibold text-floodlight">{copy.kinds[draft.reason.kind]}</span>
          {isVideo ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-void/80 px-2.5 py-1 text-[11px] font-semibold text-white">
              <Clapperboard className="h-3 w-3" aria-hidden />{copy.video}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3 sm:p-4">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-text" dir="auto">{draft.title || copy.kinds[draft.reason.kind]}</h3>
          <p className="mt-0.5 text-sm text-muted-text">{whyLine(draft.reason, copy, locale)}</p>
        </div>
        <div className="mt-auto flex flex-wrap gap-2">
          <Button type="button" className="min-h-11 flex-1 rounded-xl bg-floodlight font-bold text-void hover:bg-floodlight/90" disabled={busy} onClick={onPublish} data-testid={`creative-draft-publish-${draft.id}`}>
            <Send className="h-4 w-4" aria-hidden /><span className="ms-1.5">{copy.publish}</span>
          </Button>
          <Button type="button" variant="outline" className="min-h-11 flex-1 rounded-xl" disabled={busy} onClick={onEdit} data-testid={`creative-draft-edit-${draft.id}`}>
            <PenTool className="h-4 w-4" aria-hidden /><span className="ms-1.5">{copy.edit}</span>
          </Button>
          <Button type="button" variant="ghost" className="min-h-11 rounded-xl text-muted-text" disabled={busy} onClick={onSkip} data-testid={`creative-draft-skip-${draft.id}`}>
            <X className="h-4 w-4" aria-hidden /><span className="ms-1.5">{copy.skip}</span>
          </Button>
        </div>
      </div>
    </article>
  );
}

/** A fixture coming up that has no matchday draft (yet): one tap to make one. */
export function FixtureCard({ fixture, copy, locale, onMake }: {
  fixture: ForYouFixture;
  copy: CreativeForYouStrings;
  locale: "en" | "ar";
  onMake: () => void;
}) {
  const vs = fixture.opponent ? copy.vs(fixture.opponent) : "";
  return (
    <article className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 sm:p-4" data-testid={`creative-fixture-${fixture.sessionId}`}>
      <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-turf/15 text-turf">
        <CalendarPlus className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-text" dir="auto">{copy.fixtureTitle(vs)}</p>
        <p className="truncate text-sm text-muted-text" dir="auto">
          {[fixture.dateLabel[locale], fixture.time, fixture.squad, fixture.place].filter(Boolean).join(" · ")}
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" className="min-h-10 shrink-0 rounded-xl border-turf/40 text-turf" onClick={onMake}>
        {copy.fixtureCta}
      </Button>
    </article>
  );
}

export function DraftSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface" aria-hidden>
      <div className="aspect-[4/5] w-full animate-pulse bg-raised" />
      <div className="space-y-2 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-raised" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-raised" />
        <div className="h-11 w-full animate-pulse rounded-xl bg-raised" />
      </div>
    </div>
  );
}

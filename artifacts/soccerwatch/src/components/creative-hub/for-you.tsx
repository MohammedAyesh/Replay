import { useMemo, useState } from "react";
import { LayoutTemplate, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useForYouCopy } from "@/i18n/creative-foryou-strings";
import { useCreativeBrand } from "@/lib/creative-hub-api";
import { useForYou, useSkipForYouDraft, type ForYouDraft, type ForYouGroup } from "@/lib/creative-hub-foryou-api";
import { DraftCard, DraftSkeleton, FixtureCard } from "./for-you/draft-card";
import { WeekPlan } from "./for-you/week-plan";
import { StarButton } from "./star-button";
import { starredFirst, useFavorites } from "@/lib/favorites-api";
import type { SectionProps, TemplateSeed } from "./types";

const GROUPS: ForYouGroup[] = ["after", "upcoming", "week"];

/**
 * Creative hub → For you (owner only): drafts Replay prepared from the
 * academy's own matches, each with a live preview in the academy's look.
 * Opening the tab is what prepares new ones (server-side, throttled).
 */
export function CreativeForYou({ academyId, nav }: SectionProps & { seed?: TemplateSeed | null }) {
  const copy = useForYouCopy();
  const feed = useForYou(academyId);
  const brand = useCreativeBrand(academyId);
  const skip = useSkipForYouDraft(academyId);
  const fav = useFavorites(academyId);
  const [skipping, setSkipping] = useState<number | null>(null);

  const groups = useMemo(() => {
    const out: Record<ForYouGroup, ForYouDraft[]> = { after: [], upcoming: [], week: [] };
    for (const d of starredFirst(feed.data?.drafts ?? [], (x) => x.id, fav.data.project)) out[d.group]?.push(d);
    return out;
  }, [feed.data, fav.data.project]);
  const fixtures = (feed.data?.upcoming ?? []).filter((f) => f.draftId === null);
  const total = feed.data?.drafts.length ?? 0;

  const onSkip = (id: number) => {
    setSkipping(id);
    skip.mutate(id, {
      onSuccess: () => toast({ description: copy.skipped }),
      onError: () => toast({ description: copy.skipFailed, variant: "destructive" }),
      onSettled: () => setSkipping(null),
    });
  };

  if (feed.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="creative-for-you-loading">
        {[0, 1, 2].map((i) => <DraftSkeleton key={i} />)}
      </div>
    );
  }

  if (feed.isError) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6 text-center" data-testid="creative-for-you-error">
        <p className="text-sm text-muted-text">{copy.error}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3 rounded-xl" onClick={() => void feed.refetch()}>
          <RefreshCw className="h-4 w-4" aria-hidden /><span className="ms-1.5">{copy.retry}</span>
        </Button>
      </div>
    );
  }

  if (!total && !fixtures.length) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center" data-testid="creative-for-you-empty">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet/15 text-violet-300">
          <Sparkles className="h-6 w-6" aria-hidden />
        </div>
        <h2 className="mt-3 font-display text-lg font-bold text-text">{copy.emptyTitle}</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-text">{copy.emptyBody}</p>
        <Button type="button" className="mt-4 min-h-11 rounded-xl bg-floodlight font-bold text-void hover:bg-floodlight/90" onClick={() => nav.openTemplates()}>
          <LayoutTemplate className="h-4 w-4" aria-hidden /><span className="ms-1.5">{copy.emptyCta}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="creative-for-you">
      <p className="text-sm text-muted-text">{copy.intro}</p>
      <WeekPlan academyId={academyId} drafts={feed.data?.drafts ?? []} onOpen={(id) => nav.openInEditor(id)} />
      {GROUPS.map((group) => {
        const drafts = groups[group];
        const extra = group === "upcoming" ? fixtures : [];
        if (!drafts.length && !extra.length) return null;
        return (
          <section key={group} className="space-y-3" aria-labelledby={`creative-for-you-${group}`} data-testid={`creative-for-you-group-${group}`}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 id={`creative-for-you-${group}`} className="font-display text-lg font-bold text-text">{copy.groups[group]}</h2>
              {drafts.length ? <span className="text-xs text-muted-text">{copy.count(drafts.length)}</span> : null}
            </div>
            {drafts.length ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {drafts.map((d) => (
                  <DraftCard
                    key={d.id}
                    draft={d}
                    academyId={academyId}
                    brand={brand.data}
                    copy={copy}
                    locale={copy.locale}
                    busy={skipping === d.id}
                    onEdit={() => nav.openInEditor(d.id)}
                    onPublish={() => nav.openInPublish(d.id)}
                    onSkip={() => onSkip(d.id)}
                    star={<StarButton on={fav.isStarred("project", d.id)} onToggle={() => fav.toggle("project", d.id)} testId={`star-draft-${d.id}`} />}
                  />
                ))}
              </div>
            ) : null}
            {extra.length ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {extra.map((f) => (
                  <FixtureCard key={f.sessionId} fixture={f} copy={copy} locale={copy.locale}
                    onMake={() => nav.openTemplates({ type: "session", sessionId: f.sessionId })} />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

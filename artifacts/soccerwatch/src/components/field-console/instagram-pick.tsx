import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Film, Loader2, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dayLabel } from "@/components/creative-hub/library/browser";
import { formatLength, stillUrls, Thumb } from "@/components/creative-hub/library/media";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import {
  IG_PICKABLE,
  libraryPickKey,
  useItemCandidates,
  useItemLibrary,
  useSavePicks,
  type IgClipKind,
  type IgItem,
  type IgLibraryClip,
  type IgLibraryFilter,
} from "@/lib/instagram-api";
import { cn } from "@/lib/utils";

/**
 * Pick the clips for an autopilot post, in play order (Mohammed, 2026-11-06): from the field's whole
 * clip library, any day, by kind (goals, dribbles, passes, shots), by who made them (players or
 * Replay), grouped by date, match or player; or from the post's own suggestions. Saving re-edits
 * and renders the post.
 */

type Picked = { key: string; label: string; thumbs: string[] };
type Group = "date" | "match" | "player";
const KINDS: Array<IgClipKind | null> = [null, "goal", "dribble", "pass", "shot", "other"];

function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} data-testid={testId}
      className={cn("flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-semibold transition-colors",
        active ? "border-transparent bg-floodlight text-void" : "border-line text-muted-text hover:text-text")}>
      {children}
    </button>
  );
}

function Order({ n, single }: { n: number; single: boolean }) {
  return (
    <span className="absolute end-1.5 top-1.5 z-10 grid h-6 w-6 place-items-center rounded-full bg-turf text-xs font-bold text-void">
      {single ? <Check className="h-3.5 w-3.5" /> : n + 1}
    </span>
  );
}

export function PickClipsDialog({ venueId, item, onClose }: { venueId: number; item: IgItem; onClose: () => void }) {
  const copy = useInstagramCopy();
  const c = copy.calendar;
  const ar = copy.locale === "ar";
  const q = useItemCandidates(venueId, item.id);
  const save = useSavePicks(venueId);
  const rule = q.data ? { min: q.data.min, max: q.data.max } : IG_PICKABLE[item.kind] ?? { min: 1, max: 1 };
  const [tab, setTab] = useState<"library" | "suggested">("library");
  const [chosen, setChosen] = useState<Picked[] | null>(null);
  // Start from what's saved on the post.
  useEffect(() => {
    if (chosen !== null || !q.data) return;
    setChosen((q.data.pickedItems ?? []).map((p) => ({ key: p.key, label: ar ? p.labelAr : p.label, thumbs: p.thumbnailUrl ? [p.thumbnailUrl] : [] })));
  }, [q.data, chosen, ar]);
  const picked = chosen ?? [];
  const toggle = (p: Picked) => setChosen((prev) => {
    const now = prev ?? [];
    if (now.some((x) => x.key === p.key)) return now.filter((x) => x.key !== p.key);
    if (rule.max === 1) return [p];
    return now.length >= rule.max ? now : [...now, p];
  });
  const orderOf = (key: string) => picked.findIndex((x) => x.key === key);
  const ok = picked.length >= rule.min && picked.length <= rule.max;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir={ar ? "rtl" : "ltr"} className="flex max-h-[94dvh] flex-col gap-3 overflow-hidden border-line bg-surface text-text sm:max-w-5xl" data-testid="ig-pick-dialog">
        <DialogHeader className="text-start">
          <DialogTitle>{c.pickTitle}</DialogTitle>
          <DialogDescription className="text-start text-muted-text">{c.pickHint(rule.min, rule.max)}</DialogDescription>
        </DialogHeader>

        {/* The picks, in play order. */}
        <div className="flex min-h-[4.5rem] gap-2 overflow-x-auto rounded-xl border border-line bg-raised/40 p-2" data-testid="ig-picked">
          {picked.length === 0 ? (
            <p className="self-center px-1 text-xs text-muted-text">{c.pickedNone}</p>
          ) : picked.map((p, i) => (
            <div key={p.key} className="relative w-28 shrink-0" data-testid={`ig-picked-${p.key}`}>
              <Thumb urls={p.thumbs} video className="aspect-video w-full" />
              <span className="absolute start-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-turf text-[11px] font-bold text-void">{i + 1}</span>
              <button type="button" onClick={() => toggle(p)} aria-label={c.pickRemove}
                className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white"><X className="h-3 w-3" /></button>
              <span className="mt-0.5 block truncate text-[10px] text-muted-text">{p.label}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-1.5" role="tablist">
          {(["library", "suggested"] as const).map((t) => (
            <Chip key={t} active={tab === t} onClick={() => setTab(t)} testId={`ig-pick-tab-${t}`}>{c.pickTabs[t]}</Chip>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pe-1">
          {tab === "library" ? (
            <LibraryPane venueId={venueId} item={item} orderOf={orderOf} single={rule.max === 1} onToggle={toggle} />
          ) : q.isLoading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{c.pickLoading}</p>
          ) : q.isError ? (
            <p className="text-sm text-red-400" role="alert">{(q.error as Error).message}</p>
          ) : !q.data?.candidates.length ? (
            <p className="py-6 text-sm text-muted-text" data-testid="ig-pick-none">{q.data?.empty === "not_allowed" ? c.pickNotAllowed : q.data?.empty === "no_games" ? c.pickNoGames : c.pickNone}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {q.data.candidates.map((cand) => {
                const n = orderOf(cand.key);
                const label = ar ? cand.labelAr : cand.label;
                return (
                  <li key={cand.key}>
                    <button type="button" onClick={() => toggle({ key: cand.key, label, thumbs: cand.thumbnailUrl ? [cand.thumbnailUrl] : [] })} aria-pressed={n >= 0} data-testid={`ig-pick-${cand.key}`}
                      className={cn("relative w-full overflow-hidden rounded-xl border text-start transition-colors", n >= 0 ? "border-turf ring-2 ring-turf" : "border-line hover:border-muted-text")}>
                      <span className="block aspect-video bg-void">
                        {cand.thumbnailUrl ? <img src={cand.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Film className="m-auto mt-6 h-5 w-5 text-muted-text" />}
                      </span>
                      {n >= 0 && <Order n={n} single={rule.max === 1} />}
                      <span className="block px-2 py-1.5">
                        <span className="block text-xs font-bold text-text">{c.sources[cand.source] ?? cand.source}</span>
                        <span className="block truncate text-[11px] text-muted-text">{label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button type="button" disabled={!ok || save.isPending} onClick={() => save.mutate({ id: item.id, keys: picked.map((p) => p.key) }, { onSuccess: onClose })} data-testid="ig-pick-save">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}<span className="ms-1.5">{c.pickSave}</span>
          </Button>
          {(item.picks?.length ?? 0) > 0 && (
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => save.mutate({ id: item.id, keys: [] }, { onSuccess: onClose })}>
              <Wand2 className="h-4 w-4" /><span className="ms-1.5">{c.pickAuto}</span>
            </Button>
          )}
          <span className="text-xs text-muted-text">{c.pickCount(picked.length, rule.min, rule.max)}</span>
          {save.error ? <p className="w-full text-sm text-red-400" role="alert">{(save.error as Error).message}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The field's clips for this post: filters, then the clips grouped by date, match or player. */
export function LibraryPane({ venueId, item, orderOf, single, onToggle }: {
  venueId: number;
  item: IgItem;
  orderOf: (key: string) => number;
  single: boolean;
  onToggle: (p: Picked) => void;
}) {
  const copy = useInstagramCopy();
  const c = copy.calendar;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [origin, setOrigin] = useState<IgLibraryFilter["origin"]>(null);
  const [kind, setKind] = useState<IgClipKind | null>(null);
  const [group, setGroup] = useState<Group>("date");
  const filter: IgLibraryFilter = { from, to, origin, kind, sort: group === "player" ? "player" : "match" };
  const lib = useItemLibrary(venueId, item.id, filter);

  const groups = useMemo(() => {
    const out: Array<{ key: string; title: string; sub: string | null; clips: IgLibraryClip[] }> = [];
    for (const clip of lib.items) {
      const m = clip.match;
      const key = group === "date" ? m?.date ?? clip.date : group === "match" ? m?.key ?? "none" : clip.player?.key ?? "none";
      let g = out[out.length - 1];
      if (!g || g.key !== key) {
        const title = group === "date" ? dayLabel(m?.date ?? clip.date, copy.locale)
          : group === "match" ? (m ? `${dayLabel(m.date, copy.locale)} · ${m.time}` : c.pickOtherGame)
            : clip.player?.name ?? c.sources.saved_clip;
        g = { key, title, sub: group === "match" ? m?.pitch ?? null : null, clips: [] };
        out.push(g);
      }
      g.clips.push(clip);
    }
    return out;
  }, [lib.items, group, copy.locale, c]);

  const counts = lib.counts;
  const kindCounts = lib.kindCounts;
  return (
    <div className="flex flex-col gap-3" data-testid="ig-pick-library">
      {lib.oneGame && <p className="text-xs text-muted-text">{c.pickOneGame}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-muted-text">
          {c.pickFrom}
          <input type="date" dir="ltr" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
            className="bg-transparent text-xs font-semibold text-text outline-none [color-scheme:dark]" data-testid="ig-pick-from" />
        </label>
        <label className="flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-muted-text">
          {c.pickTo}
          <input type="date" dir="ltr" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
            className="bg-transparent text-xs font-semibold text-text outline-none [color-scheme:dark]" data-testid="ig-pick-to" />
        </label>
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
        {([null, "player", "auto"] as const).map((o) => (
          <Chip key={o ?? "all"} active={origin === o} onClick={() => setOrigin(o)} testId={`ig-pick-origin-${o ?? "all"}`}>
            {o === "auto" && <Sparkles className="h-3.5 w-3.5" aria-hidden />}
            {c.pickOrigin[o ?? "all"]}{counts ? ` · ${o ? counts[o] : counts.all}` : ""}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => (
          <Chip key={k ?? "all"} active={kind === k} onClick={() => setKind(k)} testId={`ig-pick-kind-${k ?? "all"}`}>
            {c.pickKinds[k ?? "all"]}{k && kindCounts ? ` · ${kindCounts[k]}` : ""}
          </Chip>
        ))}
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-text">{c.pickGroup}</span>
        {(["date", "match", "player"] as const).map((g) => (
          <Chip key={g} active={group === g} onClick={() => setGroup(g)} testId={`ig-pick-group-${g}`}>{c.pickGroups[g]}</Chip>
        ))}
      </div>

      {lib.isLoading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />{c.pickLoading}</p>
      ) : lib.isError ? (
        <p className="text-sm text-red-400" role="alert">{(lib.error as Error).message}</p>
      ) : !lib.items.length ? (
        <p className="py-6 text-sm text-muted-text" data-testid="ig-pick-library-none">{c.pickLibraryNone}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g, gi) => (
            <section key={`${g.key}-${gi}`} data-testid={`ig-pick-group-${g.key}`}>
              <header className="mb-2 flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
                <h3 className="truncate text-sm font-bold text-text">{g.title}{g.sub ? <span className="font-semibold text-muted-text"> · {g.sub}</span> : null}</h3>
                <span className="shrink-0 text-xs text-muted-text">{c.pickClipCount(group === "date" ? g.clips.length : lib.groupSizes[g.key] ?? g.clips.length)}</span>
              </header>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {g.clips.map((clip) => {
                  const key = libraryPickKey(clip.clipId);
                  const n = orderOf(key);
                  const thumbs = stillUrls(venueId, clip.source, clip.thumbnailUrl);
                  const label = clip.title ?? c.sources.saved_clip;
                  return (
                    <li key={clip.clipId}>
                      <button type="button" onClick={() => onToggle({ key, label, thumbs })} aria-pressed={n >= 0} data-testid={`ig-pick-${key}`}
                        className={cn("relative block w-full rounded-xl text-start", n >= 0 && "ring-2 ring-turf")}>
                        <Thumb urls={thumbs} video length={formatLength(clip.durationMs)} className="aspect-video w-full">
                          {clip.origin && (
                            <span className={cn("absolute start-1.5 top-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold",
                              clip.origin === "auto" ? "bg-floodlight text-void" : "bg-black/70 text-white")}>
                              {clip.origin === "auto" && <Sparkles className="h-3 w-3" aria-hidden />}
                              {clip.origin === "auto" ? "Replay" : clip.madeBy ?? c.pickOrigin.player}
                            </span>
                          )}
                          {n >= 0 && <Order n={n} single={single} />}
                        </Thumb>
                        <span className="mt-1 block truncate text-xs font-semibold text-text">{label}</span>
                        {group !== "match" && clip.match && <span className="block truncate text-[11px] text-muted-text">{clip.match.time}{clip.match.pitch ? ` · ${clip.match.pitch}` : ""}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {lib.hasNextPage && (
            <button type="button" disabled={lib.isFetchingNextPage} onClick={() => void lib.fetchNextPage()}
              className="mx-auto flex min-h-10 items-center gap-2 rounded-full border border-line px-5 text-sm font-semibold text-text disabled:opacity-60">
              {lib.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}{c.pickMore}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Download,
  Film,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { UserClip } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useReelCopy } from "@/i18n/reel-strings";
import { useMatchCopy } from "@/i18n/match-strings";
import { formatClipTitle } from "@/lib/clip-title";
import { fetchDownloadQuota, formatQuotaLabel, isQuotaExhausted } from "@/lib/downloadQuota";
import { EndScreenSheet } from "@/components/end-screen/EndScreenSheet";
import {
  clipShape,
  reelApi,
  REEL_MAX_CLIPS,
  REEL_MIN_CLIPS,
  type EndScreenChoice,
  type UserReel,
} from "@/lib/end-screen";

export const REELS_QUERY_KEY = ["user-reels"] as const;

/**
 * My Clips → Reels: the player's highlight reels and the builder that makes
 * one from his clips. Reels render on the server from the clips' recordings;
 * a pending reel polls itself until it settles.
 */
export function ReelsTab({ clips, clipsLoading }: { clips: UserClip[] | undefined; clipsLoading: boolean }) {
  const copy = useReelCopy();
  const [building, setBuilding] = useState(false);
  const reels = useQuery({ queryKey: REELS_QUERY_KEY, queryFn: reelApi.list });
  const clipsById = useMemo(() => new Map((clips ?? []).map((c) => [c.id, c])), [clips]);
  const usable = (clips ?? []).filter((c) => !c.isHidden);
  const canBuild = usable.length >= REEL_MIN_CLIPS;

  return (
    <div className="flex flex-col gap-4" data-testid="reels-tab">
      <div className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-turf/10 text-turf">
            <Film className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-bold text-text">{copy.reelsTitle}</h2>
            <p className="mt-0.5 text-sm text-muted-text">{copy.reelsSubtitle}</p>
          </div>
        </div>
        <Button
          className="mt-4 w-full bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={!canBuild || clipsLoading}
          onClick={() => setBuilding(true)}
          data-testid="make-reel"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {copy.makeReel}
        </Button>
        {!clipsLoading && !canBuild && <p className="mt-2 text-center text-xs text-muted-text">{copy.needClips}</p>}
      </div>

      {reels.isLoading && (
        <div className="flex flex-col gap-3">
          {[1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl border border-line bg-surface" />)}
        </div>
      )}
      {reels.isError && <p className="text-center text-sm text-violet">{copy.loadReelsFailed}</p>}
      {reels.data && reels.data.length === 0 && (
        <div className="py-10 text-center">
          <p className="font-medium text-muted-text">{copy.noReels}</p>
          <p className="mt-1 text-sm text-muted-text">{copy.noReelsDesc}</p>
        </div>
      )}
      {reels.data?.map((reel, i) => (
        <ReelCard key={reel.id} reel={reel} index={i} clipsById={clipsById} />
      ))}

      {building && (
        <ReelBuilder
          open={building}
          onOpenChange={setBuilding}
          clips={usable}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function useClipLabel() {
  const matchCopy = useMatchCopy();
  const copy = useReelCopy();
  return (clip: UserClip | undefined) => {
    if (!clip) return { day: copy.untitledClip, rest: null as string | null };
    const t = formatClipTitle(clip.title, matchCopy.locale, Date.now(), matchCopy);
    return { day: t.dayLabel, rest: [t.time, t.pitch].filter(Boolean).join(" · ") || null };
  };
}

function Thumb({ clip, className }: { clip: UserClip | undefined; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-raised", className)}>
      {clip?.thumbnailUrl && !failed ? (
        <img src={clip.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-muted-text">
          <Film className="h-4 w-4" aria-hidden />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReelBuilder({
  open,
  onOpenChange,
  clips,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clips: UserClip[];
}) {
  const copy = useReelCopy();
  const label = useClipLabel();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"pick" | "details">("pick");
  const [picked, setPicked] = useState<number[]>([]);
  const [title, setTitle] = useState(copy.defaultTitle);
  const [endScreen, setEndScreen] = useState<EndScreenChoice | null>(null);
  const [endScreenOpen, setEndScreenOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const shape = picked.length ? clipShape(byId.get(picked[0])?.aspectRatio) : null;

  const toggle = (id: number) => {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= REEL_MAX_CLIPS ? p : [...p, id]));
  };
  const move = (i: number, by: -1 | 1) => {
    setPicked((p) => {
      const j = i + by;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const reel = await reelApi.create({ title: title.trim() || copy.defaultTitle, clipIds: picked, endScreen });
      queryClient.setQueryData<UserReel[]>(REELS_QUERY_KEY, (old) => [reel, ...(old ?? [])]);
      toast({ title: copy.making, description: copy.makingDesc });
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message || copy.createFailed);
    } finally {
      setCreating(false);
    }
  };

  const endScreenSummary = endScreen?.card || endScreen?.stats?.length
    ? copy.endScreenSummary(copy.cards[endScreen.card ?? "auto"] ?? copy.endScreenAuto, endScreen.stats?.length ?? 0)
    : copy.endScreenAuto;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          dir={copy.isRtl ? "rtl" : "ltr"}
          className="mx-auto flex h-[92dvh] w-full max-w-2xl flex-col gap-0 rounded-t-3xl border-line bg-surface p-0"
          data-testid="reel-builder"
        >
          <SheetHeader className="shrink-0 px-4 pb-3 pt-5 text-start">
            <SheetTitle className="font-display text-2xl text-text">{copy.builderTitle}</SheetTitle>
            <SheetDescription className="text-start text-sm text-muted-text">
              {step === "pick" ? copy.pickClips(REEL_MIN_CLIPS, REEL_MAX_CLIPS) : copy.reelsSubtitle}
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {step === "pick" ? (
              <>
                {shape && (
                  <p className="mb-3 rounded-xl border border-line bg-raised px-3 py-2 text-xs text-muted-text">
                    {copy.shapeHint(shape)}
                  </p>
                )}
                <ul className="flex flex-col gap-2">
                  {clips.map((clip) => {
                    const order = picked.indexOf(clip.id);
                    const on = order >= 0;
                    const otherShape = shape !== null && clipShape(clip.aspectRatio) !== shape;
                    const full = !on && picked.length >= REEL_MAX_CLIPS;
                    const disabled = otherShape || full;
                    const l = label(clip);
                    return (
                      <li key={clip.id}>
                        <button
                          type="button"
                          aria-pressed={on}
                          disabled={disabled}
                          onClick={() => toggle(clip.id)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-xl border p-2 text-start transition-colors",
                            on ? "border-turf bg-turf/10" : "border-line hover:bg-raised",
                            disabled && "cursor-not-allowed opacity-35",
                          )}
                        >
                          <Thumb clip={clip} className={clipShape(clip.aspectRatio) === "9:16" ? "h-16 w-9 shrink-0" : "h-12 w-20 shrink-0"} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-text">{l.day}</span>
                            <span className="block truncate text-xs text-muted-text">
                              {[l.rest, clipShape(clip.aspectRatio) === "9:16" ? copy.vertical : copy.wide].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                              on ? "bg-turf text-void" : "border border-line text-muted-text",
                            )}
                            aria-hidden
                          >
                            {on ? order + 1 : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <div className="flex flex-col gap-5">
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-text">{copy.order}</h3>
                  <ol className="flex flex-col gap-2">
                    {picked.map((id, i) => {
                      const clip = byId.get(id);
                      const l = label(clip);
                      return (
                        <li key={id} className="flex items-center gap-2 rounded-xl border border-line p-2">
                          <span className="w-5 shrink-0 text-center text-sm font-bold text-turf">{i + 1}</span>
                          <Thumb clip={clip} className={shape === "9:16" ? "h-14 w-8 shrink-0" : "h-10 w-16 shrink-0"} />
                          <span className="min-w-0 flex-1 truncate text-sm text-text">{l.day}{l.rest ? ` · ${l.rest}` : ""}</span>
                          <IconButton label={copy.moveUp} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                          <IconButton label={copy.moveDown} disabled={i === picked.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                          <IconButton
                            label={copy.removeFromReel}
                            disabled={picked.length <= REEL_MIN_CLIPS}
                            onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                          >
                            <X className="h-4 w-4" />
                          </IconButton>
                        </li>
                      );
                    })}
                  </ol>
                </section>

                <section>
                  <label htmlFor="reel-title" className="mb-2 block text-sm font-semibold text-text">{copy.titleLabel}</label>
                  <input
                    id="reel-title"
                    value={title}
                    maxLength={80}
                    onChange={(e) => setTitle(e.target.value)}
                    className="h-11 w-full rounded-xl border border-line bg-raised px-3 text-base text-text outline-none focus:border-turf"
                  />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-semibold text-text">{copy.endScreenStep}</h3>
                  <button
                    type="button"
                    onClick={() => setEndScreenOpen(true)}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-line px-3 text-start hover:bg-raised"
                  >
                    <Clapperboard className="h-4 w-4 shrink-0 text-turf" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{endScreenSummary}</span>
                    <span className="text-sm font-semibold text-turf">{copy.change}</span>
                  </button>
                </section>

                {error && <p className="text-sm text-violet" role="alert">{error}</p>}
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-2 border-t border-line px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            {step === "pick" ? (
              <>
                <span className="flex flex-1 items-center text-sm text-muted-text">{copy.picked(picked.length, REEL_MAX_CLIPS)}</span>
                <Button
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={picked.length < REEL_MIN_CLIPS}
                  onClick={() => setStep("details")}
                  data-testid="reel-next"
                >
                  {copy.next}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" className="flex-1" onClick={() => setStep("pick")}>{copy.back}</Button>
                <Button
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={creating || picked.length < REEL_MIN_CLIPS}
                  onClick={create}
                  data-testid="reel-create"
                >
                  {creating ? copy.creating : copy.create}
                </Button>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {endScreenOpen && (
        <EndScreenSheet
          open={endScreenOpen}
          onOpenChange={setEndScreenOpen}
          target={{ mode: "draft", clipIds: picked, initial: endScreen, onPick: setEndScreen }}
        />
      )}
    </>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-text hover:bg-raised disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */

function ReelCard({ reel, index, clipsById }: { reel: UserReel; index: number; clipsById: Map<number, UserClip> }) {
  const copy = useReelCopy();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [endScreenOpen, setEndScreenOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const portrait = reel.aspectRatio === "9:16";

  const patch = (next: UserReel) =>
    queryClient.setQueryData<UserReel[]>(REELS_QUERY_KEY, (old) => old?.map((r) => (r.id === next.id ? next : r)));

  // A reel being made polls itself every 5 s until it settles.
  useEffect(() => {
    if (reel.status !== "pending") return;
    let cancelled = false;
    const id = window.setInterval(() => {
      reelApi.get(reel.id).then((next) => { if (!cancelled) patch(next); }).catch(() => {});
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reel.id, reel.status]);

  const retry = async () => {
    setBusy(true);
    try { patch(await reelApi.retry(reel.id)); } catch { toast({ title: copy.failed, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const download = async () => {
    const quota = await fetchDownloadQuota();
    if (isQuotaExhausted(quota)) {
      toast({ title: copy.downloadLimit, description: formatQuotaLabel(quota, copy.locale) ?? undefined, variant: "destructive" });
      return;
    }
    const a = document.createElement("a");
    a.href = reelApi.downloadUrl(reel.id);
    a.download = `${reel.title || "reel"}.mp4`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast({ title: copy.downloadStarted });
  };

  const remove = async () => {
    setBusy(true);
    try {
      await reelApi.remove(reel.id);
      queryClient.setQueryData<UserReel[]>(REELS_QUERY_KEY, (old) => old?.filter((r) => r.id !== reel.id));
      toast({ title: copy.deleted });
    } catch {
      toast({ title: copy.deleteFailed, variant: "destructive" });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const firstClips = reel.clipIds.slice(0, 5).map((id) => clipsById.get(id));

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, transition: { delay: index * 0.05, duration: 0.3 } }}
      className="overflow-hidden rounded-2xl border border-line bg-surface"
      data-testid={`reel-${reel.id}`}
    >
      {reel.status === "done" ? (
        <div className="bg-black">
          <video
            src={reelApi.playbackUrl(reel.id)}
            controls
            playsInline
            preload="metadata"
            className={cn("mx-auto block bg-black", portrait ? "aspect-[9/16] h-[min(60dvh,480px)] w-auto max-w-full" : "aspect-video w-full")}
          />
        </div>
      ) : (
        <div className="flex gap-1.5 overflow-hidden bg-raised p-2" aria-hidden>
          {firstClips.map((clip, i) => (
            <Thumb key={i} clip={clip} className={portrait ? "h-20 w-[45px] shrink-0" : "h-14 w-24 shrink-0"} />
          ))}
        </div>
      )}

      <div className="p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-display text-lg font-bold text-text">{reel.title}</h3>
            <p className="text-sm text-muted-text">
              {[copy.clipsCount(reel.clipIds.length), reel.durationSec ? copy.seconds(reel.durationSec) : null].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>

        {reel.status === "pending" && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-raised px-3 py-2.5" role="status">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-turf" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-text">{copy.making}</p>
              <p className="text-xs text-muted-text">{copy.makingDesc}</p>
            </div>
          </div>
        )}
        {reel.status === "error" && (
          <div className="mt-3 rounded-xl border border-violet/40 bg-violet/10 px-3 py-2.5" role="alert">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-violet" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text">{copy.failed}</p>
                {reel.error && <p className="text-xs text-muted-text">{reel.error}</p>}
              </div>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={retry} className="mt-2">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {copy.retry}
            </Button>
          </div>
        )}
        {reel.status === "expired" && (
          <p className="mt-3 rounded-xl bg-raised px-3 py-2.5 text-sm text-muted-text" role="status">{copy.expired}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {reel.status === "done" && (
            <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={download}>
              <Download className="h-4 w-4" aria-hidden /> {copy.download}
            </Button>
          )}
          {reel.status !== "expired" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEndScreenOpen(true)}>
              <Clapperboard className="h-4 w-4" aria-hidden /> {copy.changeEndScreen}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)} className="text-muted-text">
            <Trash2 className="h-4 w-4" aria-hidden /> {copy.delete}
          </Button>
        </div>
      </div>

      {endScreenOpen && (
        <EndScreenSheet
          open={endScreenOpen}
          onOpenChange={setEndScreenOpen}
          target={{
            mode: "reel",
            reelId: reel.id,
            clipIds: reel.clipIds,
            save: async (choice) => {
              const next = await reelApi.update(reel.id, { endScreen: choice });
              patch(next);
              toast({ title: copy.saved, description: next.status === "pending" ? copy.remakingReel : undefined });
            },
          }}
        />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent dir={copy.isRtl ? "rtl" : "ltr"} className="border-line bg-surface text-text">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.deleteDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void remove(); }} disabled={busy} className="bg-violet text-white hover:bg-violet/90">
              {copy.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.article>
  );
}


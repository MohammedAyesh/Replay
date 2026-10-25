import { useEffect, useMemo, useState } from "react";
import { Check, Clapperboard, ImageOff, RotateCcw } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useReelCopy } from "@/i18n/reel-strings";
import {
  choiceBody,
  effectiveCard,
  endScreenApi,
  formatStatValue,
  maxStatsFor,
  previewQuery,
  toggleStat,
  type EndScreenCardKind,
  type EndScreenChoice,
  type EndScreenOptions,
  type EndScreenStatKey,
} from "@/lib/end-screen";

/**
 * "What plays after your clip": the card and the numbers on it.
 *
 * Three targets share it:
 * - a saved clip (saves with PUT, the clip is remade),
 * - a saved reel (saves with PATCH, the reel is remade),
 * - a reel being built (nothing is saved; the pick goes back to the builder).
 */
export type EndScreenTarget =
  | { mode: "clip"; clipId: number }
  | { mode: "reel"; reelId: number; clipIds: number[]; save: (choice: EndScreenChoice | null) => Promise<void> }
  | { mode: "draft"; clipIds: number[]; initial: EndScreenChoice | null; onPick: (choice: EndScreenChoice | null) => void };

export function EndScreenSheet({
  open,
  onOpenChange,
  target,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EndScreenTarget;
  /** After a save: the server's answer (clip mode), or null (reel/draft). */
  onSaved?: (result: EndScreenOptions | null) => void;
}) {
  const copy = useReelCopy();
  const [options, setOptions] = useState<EndScreenOptions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [card, setCard] = useState<EndScreenChoice["card"]>("auto");
  const [stats, setStats] = useState<EndScreenStatKey[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The card is drawn at the clip's shape; learnt from the first preview. */
  const [wide, setWide] = useState(false);

  const targetKey = target.mode === "clip" ? `c${target.clipId}` : target.mode === "reel" ? `r${target.reelId}` : `d${target.clipIds.join(",")}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOptions(null);
    setLoadError(false);
    setSaveError(null);
    const load = target.mode === "clip"
      ? endScreenApi.clipOptions(target.clipId)
      : target.mode === "reel"
        ? endScreenApi.reelOptions(target.reelId)
        : endScreenApi.draftOptions(target.clipIds);
    load.then((o) => {
      if (cancelled) return;
      setOptions(o);
      const start = target.mode === "draft" ? target.initial ?? {} : o.choice;
      setCard(start.card ?? "auto");
      setStats(start.stats ?? []);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  const cards = options?.cards ?? [];
  const shown = useMemo(() => effectiveCard(cards, card), [cards, card]);
  const max = maxStatsFor(shown);
  const showNumbers = (shown === "player" || shown === "academy") && (options?.stats.length ?? 0) > 0;
  // An academy card holds three: drop the extra ones the moment it applies.
  useEffect(() => {
    if (stats.length > max) setStats((s) => s.slice(0, max));
  }, [max, stats.length]);

  const query = previewQuery(card, showNumbers ? stats : []);
  const previewUrl = target.mode === "clip"
    ? endScreenApi.clipPreviewUrl(target.clipId, query)
    : endScreenApi.draftPreviewUrl(target.clipIds, query);
  const debounced = useDebounced(open && options?.enabled ? previewUrl : null, 350);
  const [preview, setPreview] = useState<{ url: string; state: "loading" | "ready" | "none" | "failed" } | null>(null);
  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    setPreview({ url: debounced, state: "loading" });
    // HEAD-less check: fetch once so a 404 can say "no end screen" instead of a broken image.
    fetch(debounced, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) { setPreview({ url: debounced, state: "none" }); return; }
        if (!res.ok) { setPreview({ url: debounced, state: "failed" }); return; }
        const blob = await res.blob();
        if (cancelled) return;
        setPreview({ url: URL.createObjectURL(blob), state: "ready" });
      })
      .catch(() => { if (!cancelled) setPreview({ url: debounced, state: "failed" }); });
    return () => { cancelled = true; };
  }, [debounced]);
  useEffect(() => () => {
    if (preview?.state === "ready") URL.revokeObjectURL(preview.url);
  }, [preview]);

  const cardLabel = (kind: string) => copy.cards[kind] ?? kind;

  const save = async () => {
    const body = choiceBody(card, showNumbers ? stats : []);
    const stored = Object.keys(body).length ? body : null;
    setSaveError(null);
    if (target.mode === "draft") {
      target.onPick(stored);
      onSaved?.(null);
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      if (target.mode === "clip") {
        const result = await endScreenApi.saveClip(target.clipId, body);
        onSaved?.(result);
      } else {
        await target.save(stored);
        onSaved?.(null);
      }
      onOpenChange(false);
    } catch {
      setSaveError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const dir = copy.isRtl ? "rtl" : "ltr";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        dir={dir}
        className="z-[70] mx-auto max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border-line bg-surface p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-5"
        data-testid="end-screen-sheet"
      >
        <SheetHeader className="text-start">
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-turf/10 text-turf">
            <Clapperboard className="h-5 w-5" aria-hidden="true" />
          </div>
          <SheetTitle className="font-display text-2xl text-text">
            {target.mode === "clip" ? copy.sheetTitle : copy.sheetTitleReel}
          </SheetTitle>
          {options?.enabled && (
            <SheetDescription className="text-start text-sm text-muted-text">{copy.sheetDesc(options.seconds)}</SheetDescription>
          )}
        </SheetHeader>

        {loadError && <p className="mt-6 text-sm text-violet">{copy.loadFailed}</p>}
        {!options && !loadError && (
          <div className="mt-6 space-y-3" aria-busy="true">
            <div className="h-10 animate-pulse rounded-xl bg-raised" />
            <div className="h-48 animate-pulse rounded-xl bg-raised" />
          </div>
        )}
        {options && !options.enabled && <p className="mt-6 text-sm text-muted-text">{copy.off}</p>}

        {options?.enabled && (
          <div className="mt-4 flex flex-col gap-5 sm:flex-row-reverse sm:items-start">
            {/* Preview */}
            <div className="flex justify-center sm:w-[42%] sm:shrink-0">
              <div
                className={cn(
                  "relative w-full overflow-hidden rounded-2xl border border-line bg-raised",
                  wide ? "aspect-video" : "max-w-[150px] aspect-[9/16] sm:max-w-[200px]",
                )}
              >
                {preview?.state === "ready" && (
                  <img
                    src={preview.url}
                    alt={copy.previewAlt}
                    className="absolute inset-0 h-full w-full object-contain"
                    onLoad={(e) => setWide(e.currentTarget.naturalWidth > e.currentTarget.naturalHeight)}
                  />
                )}
                {(preview === null || preview.state === "loading") && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-text">
                    <span className="h-5 w-5 rounded-full border-2 border-white/20 border-t-turf animate-spin" />
                    {copy.previewLoading}
                  </div>
                )}
                {(preview?.state === "none" || preview?.state === "failed") && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-text">
                    <ImageOff className="h-5 w-5" aria-hidden />
                    {preview.state === "none" ? copy.previewNone : copy.previewFailed}
                  </div>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1 space-y-5">
              {/* Card */}
              <section>
                <h3 className="mb-2 text-sm font-semibold text-text">{copy.cardHeading}</h3>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={copy.cardHeading}>
                  <Chip selected={card === "auto"} onClick={() => setCard("auto")}>{copy.cards.auto}</Chip>
                  {cards.map((c) => (
                    <Chip
                      key={c.kind}
                      selected={card === c.kind}
                      disabled={!c.available}
                      onClick={() => setCard(c.kind)}
                      hint={c.available ? undefined : copy.unavailable[c.kind]}
                    >
                      {cardLabel(c.kind)}
                    </Chip>
                  ))}
                </div>
                {card === "auto" && shown && (
                  <p className="mt-2 text-xs text-muted-text">{copy.autoNote(cardLabel(shown))}</p>
                )}
                {cards.some((c) => !c.available) && (
                  <ul className="mt-2 space-y-0.5 text-xs text-muted-text">
                    {cards.filter((c) => !c.available).map((c) => (
                      <li key={c.kind}>{cardLabel(c.kind)}: {copy.unavailable[c.kind]}</li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Numbers */}
              {(shown === "player" || shown === "academy") && (
                <section>
                  <h3 className="text-sm font-semibold text-text">{copy.numbersHeading(max)}</h3>
                  {showNumbers ? (
                    <>
                      <p className="mb-2 text-xs text-muted-text">{copy.numbersHint} {copy.numbersAuto}</p>
                      <ul className="flex flex-col gap-1.5">
                        {options.stats.map((s) => {
                          const position = stats.indexOf(s.key);
                          const on = position >= 0;
                          const full = !on && stats.length >= max;
                          // Not measured for this match: the card would leave it out anyway.
                          const missing = !on && s.value === null;
                          return (
                            <li key={s.key}>
                              <button
                                type="button"
                                aria-pressed={on}
                                disabled={full || missing}
                                onClick={() => setStats((p) => toggleStat(p, s.key, max))}
                                className={cn(
                                  "flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-start text-sm transition-colors",
                                  on ? "border-turf bg-turf/10 text-text" : "border-line text-text hover:bg-raised",
                                  (full || missing) && "opacity-40",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                                    on ? "bg-turf text-void" : "border border-line text-muted-text",
                                  )}
                                  aria-hidden
                                >
                                  {on ? position + 1 : ""}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{copy.isRtl ? s.labelAr : s.labelEn}</span>
                                <span dir="ltr" className="font-display font-semibold tabular-nums text-muted-text">
                                  {formatStatValue(s.value, s.decimals, s.unit)}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted-text">{copy.noStats}</p>
                  )}
                </section>
              )}

              {(card !== "auto" || stats.length > 0) && (
                <button
                  type="button"
                  onClick={() => { setCard("auto"); setStats([]); }}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-turf underline-offset-4 hover:underline"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  {copy.resetAuto}
                </button>
              )}
            </div>
          </div>
        )}

        {saveError && <p className="mt-4 text-sm text-violet" role="alert">{saveError}</p>}

        <div className="mt-6 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
          <Button
            className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={!options?.enabled || saving}
            onClick={save}
            data-testid="end-screen-save"
          >
            {saving ? copy.saving : target.mode === "draft" ? copy.use : copy.save}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Chip({
  selected,
  disabled,
  onClick,
  hint,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      title={hint}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors",
        selected ? "border-turf bg-turf text-void" : "border-line text-text hover:bg-raised",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {selected && <Check className="h-3.5 w-3.5" aria-hidden />}
      {children}
    </button>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export type { EndScreenCardKind };

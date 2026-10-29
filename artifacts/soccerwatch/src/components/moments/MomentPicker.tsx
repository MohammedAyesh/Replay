import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudCheck, Loader2, RotateCcw, Send, Target, Trophy, X, Zap, Sparkles, Film } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMomentsCopy, type MomentStrings } from "@/i18n/moments-strings";
import { keptClipIds, momentTitle, type DeckChoice, type DeckMoment } from "@/lib/moment-deck";
import { REEL_MAX_CLIPS, REEL_MIN_CLIPS } from "@/lib/end-screen";
import { MomentVideo, type MomentVideoState } from "./MomentVideo";

/** a swipe this far decides, px */
const SWIPE = 96;
/** how long a decided card takes to fly off, ms */
const FLY_MS = 220;

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

const KIND_ICON: Record<string, typeof Sparkles> = {
  "your-goal": Trophy, "your-shot": Target, dribble: Zap, "long-pass": Send, goal: Trophy,
};

/**
 * Swipe through your moments and keep the ones you want in a reel: right (or
 * the tick) keeps, left (or the cross) skips, Undo takes the last swipe back.
 * Right means keep in both languages, as on every swipe app, so the controls
 * stay in that order in Arabic too. Stops at a full reel; then hands the kept
 * clips, in the order kept, to the reel builder.
 */
export function MomentPicker({ deck, onClose, onDone }: {
  deck: DeckMoment[];
  onClose: () => void;
  onDone: (clipIds: number[]) => void;
}) {
  const copy = useMomentsCopy();
  const [i, setI] = useState(0);
  const [choices, setChoices] = useState<DeckChoice[]>([]);
  const [videoState, setVideoState] = useState<Record<number, MomentVideoState>>({});
  const flying = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const kept = useMemo(() => keptClipIds(choices, REEL_MAX_CLIPS), [choices]);
  const full = kept.length >= REEL_MAX_CLIPS;
  const done = i >= deck.length || full;

  // Nothing behind the deck scrolls while it is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const decide = useCallback((keep: boolean) => {
    if (flying.current || i >= deck.length || full) return;
    flying.current = true;
    const el = cardRef.current;
    if (el) {
      el.style.transition = `transform ${FLY_MS}ms ease-in, opacity ${FLY_MS}ms ease-in`;
      el.style.transform = `translate(${keep ? "120vw" : "-120vw"}, -2vh) rotate(${keep ? 14 : -14}deg)`;
      el.style.opacity = "0";
    }
    const card = deck[i];
    window.setTimeout(() => {
      setChoices((c) => [...c, { clipId: card.clipId, keep }]);
      setI((n) => n + 1);
      flying.current = false;
    }, FLY_MS);
  }, [deck, i, full]);

  const undo = useCallback(() => {
    if (flying.current || choices.length === 0) return;
    setChoices((c) => c.slice(0, -1));
    setI((n) => Math.max(0, n - 1));
  }, [choices.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (done) return;
      else if (e.key === "ArrowRight") { e.preventDefault(); decide(true); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); decide(false); }
      else if (e.key === "Backspace" || e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, undo, onClose, done]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.eyebrow}
      dir={copy.isRtl ? "rtl" : "ltr"}
      className="fixed inset-0 z-[60] flex flex-col bg-void text-text"
      data-testid="moment-picker"
    >
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 overflow-hidden px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))]">
        <Header copy={copy} onClose={onClose} at={Math.min(i, deck.length)} of={deck.length} kept={kept.length} />
        {done ? (
          <Done copy={copy} deck={deck} kept={kept} full={full}
            onMake={() => onDone(kept)}
            onAgain={() => { setChoices([]); setI(0); }}
            onUndo={choices.length ? undo : undefined} />
        ) : (
          <>
            <div className="relative min-h-0 flex-1">
              {deck.slice(i, i + 2).map((card, k) => (
                <Card
                  key={card.clipId}
                  card={card}
                  depth={k}
                  copy={copy}
                  cardRef={k === 0 ? cardRef : undefined}
                  videoState={videoState[card.clipId] ?? "loading"}
                  onVideoState={(s) => setVideoState((v) => (v[card.clipId] === s ? v : { ...v, [card.clipId]: s }))}
                  onDecide={decide}
                />
              )).reverse()}
            </div>
            <Controls copy={copy} canUndo={choices.length > 0} onDecide={decide} onUndo={undo} />
          </>
        )}
      </div>
    </div>
  );
}

function Header({ copy, onClose, at, of, kept }: { copy: MomentStrings; onClose: () => void; at: number; of: number; kept: number }) {
  return (
    <div className="flex min-h-12 items-center gap-3">
      <button type="button" aria-label={copy.close} onClick={onClose} data-testid="button-picker-close"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line text-text">
        <X className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">{copy.eyebrow}</span>
        <div className="flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={at}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-turf transition-[width] duration-200 rtl:ms-auto" style={{ width: of ? `${(at / of) * 100}%` : "0%" }} />
          </div>
          <span dir="ltr" className="shrink-0 font-mono text-[11px] tabular-nums text-muted-text">{Math.min(at + 1, of)}/{of}</span>
        </div>
      </div>
      <span className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-floodlight/40 bg-floodlight/10 px-2.5 text-xs font-bold text-floodlight" data-testid="picker-kept">
        <Check className="h-3.5 w-3.5" strokeWidth={3} />{copy.kept(kept, REEL_MAX_CLIPS)}
      </span>
    </div>
  );
}

function Card({ card, depth, copy, cardRef, videoState, onVideoState, onDecide }: {
  card: DeckMoment; depth: number; copy: MomentStrings & { locale: "en" | "ar" }; cardRef?: React.MutableRefObject<HTMLDivElement | null>;
  videoState: MomentVideoState; onVideoState: (s: MomentVideoState) => void; onDecide: (keep: boolean) => void;
}) {
  const local = useRef<HTMLDivElement | null>(null);
  const keepRef = useRef<HTMLDivElement | null>(null);
  const skipRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const active = depth === 0;
  const Icon = KIND_ICON[card.moment.kind] ?? Sparkles;
  const kind = copy.kinds[card.moment.kind] ?? copy.kindFallback;

  const setRef = (el: HTMLDivElement | null) => { local.current = el; if (cardRef) cardRef.current = el; };
  const paint = (dx: number, dy: number) => {
    const el = local.current;
    if (!el) return;
    el.style.transform = `translate(${dx}px, ${Math.min(0, dy) / 3}px) rotate(${dx / 20}deg)`;
    if (keepRef.current) keepRef.current.style.opacity = String(Math.max(0, Math.min(1, dx / SWIPE)));
    if (skipRef.current) skipRef.current.style.opacity = String(Math.max(0, Math.min(1, -dx / SWIPE)));
  };
  const onDown = (e: React.PointerEvent) => {
    if (!active) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags */ }
    if (local.current) local.current.style.transition = "none";
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    paint(e.clientX - drag.current.x, e.clientY - drag.current.y);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const dx = e.clientX - drag.current.x;
    drag.current = null;
    if (dx > SWIPE) onDecide(true);
    else if (dx < -SWIPE) onDecide(false);
    else if (local.current) { local.current.style.transition = "transform .2s ease-out"; paint(0, 0); }
  };

  return (
    // The card is as tall as what is on it, centred in the space above the buttons.
    <div className={cn("pointer-events-none absolute inset-0 flex items-center", active ? "z-20" : "z-10")}>
    <div
      ref={setRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className={cn("pointer-events-auto flex max-h-full w-full select-none flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_20px_48px_rgba(0,0,0,.45)]",
        active ? "cursor-grab touch-none" : "")}
      style={active ? undefined : { transform: "translateY(14px) scale(.95)", transition: "transform .24s" }}
      data-testid={active ? "picker-card-active" : undefined}
    >
      <div className="relative aspect-video w-full shrink-0">
        <MomentVideo clip={card.clip} active={active} load={depth <= 1} onState={onVideoState} />
        {active && videoState === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-xs font-semibold text-white/80">
            <Loader2 className="h-4 w-4 animate-spin" />{copy.videoSlow}
          </div>
        )}
        {videoState === "failed" && (
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-xl bg-black/65 p-3 text-center text-xs text-white">{copy.videoFailed}</div>
        )}
        <div ref={keepRef} className="pointer-events-none absolute start-4 top-4 -rotate-12 rounded-xl border-[3px] border-floodlight bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-floodlight" style={{ opacity: 0 }}>{copy.keep}</div>
        <div ref={skipRef} className="pointer-events-none absolute end-4 top-4 rotate-12 rounded-xl border-[3px] border-text bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-text" style={{ opacity: 0 }}>{copy.skip}</div>
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] pb-[18px] pt-4">
        <span className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">
            <Icon className="h-3.5 w-3.5" />{kind}
          </span>
          <span dir="ltr" className="font-mono text-xs tabular-nums text-muted-text">{clock(card.moment.momentSeconds)}</span>
        </span>
        <span dir="auto" className="font-display text-[26px] font-bold leading-[1.08] [text-wrap:balance]">{momentTitle(card.moment, copy.locale)}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="min-w-0 truncate text-sm text-muted-text">{card.matchLabel} · <span dir="ltr">{card.date}</span></span>
          {card.save === "saved" ? (
            <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-turf/40 bg-turf/10 px-2.5 text-xs font-semibold text-turf"><CloudCheck className="h-3.5 w-3.5" />{copy.saved}</span>
          ) : (
            <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-xs font-semibold text-muted-text"><Loader2 className="h-3.5 w-3.5 animate-spin" />{copy.stillSaving}</span>
          )}
        </span>
      </div>
    </div>
    </div>
  );
}

function Controls({ copy, canUndo, onDecide, onUndo }: { copy: MomentStrings; canUndo: boolean; onDecide: (keep: boolean) => void; onUndo: () => void }) {
  return (
    <div className="flex flex-col gap-1.5" dir="ltr">
      <div className="flex items-center justify-center gap-5">
        <button type="button" aria-label={copy.skip} onClick={() => onDecide(false)} data-testid="button-picker-skip"
          className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface/60 text-text active:scale-95">
          <X className="h-7 w-7" />
        </button>
        <button type="button" aria-label={copy.undo} onClick={onUndo} disabled={!canUndo} data-testid="button-picker-undo"
          className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface/60 text-muted-text active:scale-95 disabled:opacity-35">
          <RotateCcw className="h-5 w-5" />
        </button>
        <button type="button" aria-label={copy.keep} onClick={() => onDecide(true)} data-testid="button-picker-keep"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-floodlight text-void active:scale-95">
          <Check className="h-7 w-7" strokeWidth={2.8} />
        </button>
      </div>
      <div className="flex justify-center gap-5 text-xs font-semibold text-muted-text">
        <span className="w-16 text-center">{copy.skip}</span><span className="w-12 text-center">{copy.undo}</span><span className="w-16 text-center">{copy.keep}</span>
      </div>
    </div>
  );
}

function Done({ copy, deck, kept, full, onMake, onAgain, onUndo }: {
  copy: MomentStrings & { locale: "en" | "ar" }; deck: DeckMoment[]; kept: number[]; full: boolean;
  onMake: () => void; onAgain: () => void; onUndo?: () => void;
}) {
  const byId = new Map(deck.map((c) => [c.clipId, c]));
  const enough = kept.length >= REEL_MIN_CLIPS;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="picker-done">
      <div className="flex flex-col items-center gap-2 rounded-3xl border border-floodlight/40 bg-surface px-5 py-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-floodlight/15 text-floodlight"><Film className="h-8 w-8" /></span>
        {full && <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-floodlight rtl:text-xs rtl:tracking-normal">{copy.full(REEL_MAX_CLIPS)}</span>}
        <h2 className="font-display text-[28px] font-bold leading-[1.05] [text-wrap:balance]">{kept.length ? copy.doneTitle(kept.length) : copy.doneNone}</h2>
        <p className="text-sm leading-6 text-muted-text">{enough ? copy.doneDesc : copy.needMore}</p>
      </div>
      {kept.length > 0 && (
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" aria-label={copy.doneTitle(kept.length)}>
          {kept.map((id, n) => {
            const c = byId.get(id);
            if (!c) return null;
            const Icon = KIND_ICON[c.moment.kind] ?? Sparkles;
            return (
              <li key={id} className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2.5">
                <span dir="ltr" className="w-5 shrink-0 text-center font-mono text-xs tabular-nums text-muted-text">{n + 1}</span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-turf/10 text-turf"><Icon className="h-4 w-4" /></span>
                <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-semibold">{momentTitle(c.moment, copy.locale)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {kept.length === 0 && <div className="flex-1" />}
      <button type="button" onClick={onMake} disabled={!enough} data-testid="button-picker-make"
        className="min-h-12 rounded-full bg-floodlight text-base font-bold text-void disabled:opacity-40">{copy.makeReel}</button>
      <div className="flex gap-2">
        {onUndo && (
          <button type="button" onClick={onUndo} className="min-h-12 flex-1 rounded-full border border-line bg-surface/60 text-sm font-semibold">
            <span className="inline-flex items-center gap-1.5"><RotateCcw className="h-4 w-4" />{copy.undo}</span>
          </button>
        )}
        <button type="button" onClick={onAgain} className="min-h-12 flex-1 rounded-full border border-turf/60 text-sm font-bold text-turf">{copy.again}</button>
      </div>
    </div>
  );
}

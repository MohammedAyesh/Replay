import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, CircleAlert, Loader2, Play, Trophy, Undo2, X } from "lucide-react";
import { DeckVideo, type DeckVideoState } from "@/components/check-deck/DeckVideo";
import type { DeckCard } from "@/lib/check-deck";
import { createVoteSaver, useGoalReel, type ReelCard } from "@/lib/goal-reel";
import { matchKey, type MatchRoom, type TeamSide } from "@/lib/match-api";
import { useGoalReelCopy, type GoalReelStrings } from "@/i18n/goal-reel-strings";
import { cn } from "@/lib/utils";

/**
 * "Was it a goal?" as a reel (2026-10-31): every chance in the match nobody
 * has decided, played one after another right on the match page. Each card
 * is a few seconds of the recording following the ball; Goal (or swipe
 * right), No goal (left), Can't tell (up), Back takes the last answer back.
 * The next card plays the moment one is answered.
 *
 * It opens as a popup over the match page, which stays in view behind it.
 *
 * Quick by construction (the "Is this you?" deck's player, DeckVideo): the
 * card list is fetched while the match page is open, so the reel opens at
 * once; a card is the recording seeked to its few seconds on the lightest
 * useful rung; the card on screen loads first and the next two behind it;
 * answers are saved behind the reel, several to a request.
 */

type Verdict = "goal" | "not_goal" | "skip";
type Result = { card: ReelCard; verdict: Verdict };

const FLOOD = "#D4FF4F";
/** a swipe this far decides, px */
const SWIPE = 96;
/** how long a decided card takes to fly off, ms */
const FLY_MS = 220;
/** the card behind waits this long for the one on screen before loading anyway, ms */
const PRELOAD_GRACE = 2500;

const toDeckCard = (card: ReelCard): DeckCard => ({
  id: card.id, kind: "goal", at: card.at, start: card.start, end: card.end, clock: card.clock, focus: card.focus,
});

/** Open the reel: the list of chances is fetched as soon as the button is on the page. */
export function GoalReelButton({ room, names, colors, openCount, className, variant = "primary" }: {
  room: MatchRoom;
  names: Record<TeamSide, string>;
  colors: Record<TeamSide, string>;
  openCount: number;
  className?: string;
  variant?: "primary" | "row";
}) {
  const copy = useGoalReelCopy();
  const [open, setOpen] = useState(false);
  // prefetch: by the time the thumb lands the cards are here
  useGoalReel(room.code, openCount > 0);
  if (openCount <= 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          variant === "primary"
            ? "flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight px-5 text-sm font-bold text-void active:scale-[.98]"
            : "flex min-h-12 w-full items-center gap-3 rounded-2xl border border-live/40 bg-live/10 px-3.5 text-start text-sm font-semibold",
          className,
        )}
        data-testid="button-goal-reel"
      >
        {variant === "primary" ? (
          <><Play className="h-4 w-4 fill-current" />{copy.open(openCount)}</>
        ) : (
          <>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-floodlight text-void"><Play className="h-3.5 w-3.5 fill-current" /></span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{copy.title} · {copy.open(openCount)}</span>
              <span className="truncate text-[11px] font-normal text-muted-text">{copy.openNote}</span>
            </span>
          </>
        )}
      </button>
      {open && <GoalReel room={room} names={names} colors={colors} onClose={() => setOpen(false)} />}
    </>
  );
}

export function GoalReel({ room, names, colors, onClose }: {
  room: MatchRoom;
  names: Record<TeamSide, string>;
  colors: Record<TeamSide, string>;
  onClose: () => void;
}) {
  const copy = useGoalReelCopy();
  const queryClient = useQueryClient();
  const reelQuery = useGoalReel(room.code, true);
  // The reel is fixed when it first arrives: a refetch never reshuffles cards under a thumb.
  const [cards, setCards] = useState<ReelCard[] | null>(null);
  useEffect(() => { if (reelQuery.data && cards === null) setCards(reelQuery.data.cards); }, [reelQuery.data, cards]);
  const recordings = useMemo(() => new Map((reelQuery.data?.recordings ?? []).map((r) => [r.recordingId, r])), [reelQuery.data]);

  const [i, setI] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const [videoState, setVideoState] = useState<Record<string, DeckVideoState>>({});
  const [graceFor, setGraceFor] = useState<string | null>(null);
  const flying = useRef(false);
  const saver = useMemo(() => createVoteSaver(room.code, (ids) => setFailed((f) => [...f, ...ids])), [room.code]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  // While the reel is open nothing behind it scrolls, takes focus or answers a key.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.hasAttribute("inert") ?? false;
    document.body.style.overflow = "hidden";
    root?.setAttribute("inert", "");
    dialogRef.current?.querySelector<HTMLElement>("[data-testid=button-reel-close]")?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (root && !wasInert) root.removeAttribute("inert");
      prevFocus?.focus?.();
    };
  }, []);

  // Leaving: let the last answers land, then the match page reads the new goals.
  const answered = results.some((r) => r.verdict !== "skip");
  const leave = useCallback(() => {
    onClose();
    void saver.drain().then(() => { void queryClient.invalidateQueries({ queryKey: matchKey(room.code) }); });
  }, [onClose, saver, queryClient, room.code]);
  const close = useCallback(() => { if (answered && !done) setDone(true); else leave(); }, [answered, done, leave]);

  const current = cards && !done ? cards[i] ?? null : null;
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setGraceFor(current.id), PRELOAD_GRACE);
    return () => window.clearTimeout(timer);
  }, [current]);
  // one card loads at a time: each starts once the one in front has its whole moment in
  const settled = (id: string | undefined) => !id || videoState[id] === "buffered" || videoState[id] === "failed";
  const primed = (id: string | undefined) => !id || videoState[id] === "ready" || settled(id);
  const frontDone = current ? settled(current.id) || graceFor === current.id : false;
  const onVideoState = useCallback((id: string, state: DeckVideoState) => {
    setVideoState((s) => (s[id] === state ? s : { ...s, [id]: state }));
  }, []);

  const decide = useCallback((verdict: Verdict) => {
    if (!cards || !current || flying.current) return;
    flying.current = true;
    const el = document.getElementById(`reel-card-${current.id}`);
    if (el) {
      el.style.transition = `transform ${FLY_MS}ms cubic-bezier(.2,.8,.2,1), opacity ${FLY_MS}ms`;
      el.style.transform = verdict === "goal" ? "translate(140%, -6%) rotate(16deg)"
        : verdict === "not_goal" ? "translate(-140%, -6%) rotate(-16deg)" : "translate(0, -120%)";
      el.style.opacity = "0";
    }
    try { navigator.vibrate?.(verdict === "skip" ? 6 : 14); } catch { /* not supported */ }
    if (verdict !== "skip") saver.push(current.id, { recordingId: current.recordingId, key: current.key, verdict });
    if (verdict !== "skip") setToast({ text: verdict === "goal" ? copy.toastGoal : copy.toastNoGoal, key: Date.now() });
    setResults((r) => [...r, { card: current, verdict }]);
    window.setTimeout(() => {
      flying.current = false;
      if (i + 1 >= cards.length) setDone(true);
      else setI(i + 1);
    }, FLY_MS);
  }, [cards, current, saver, copy, i]);

  // Back: the last card comes back and its answer is taken back.
  const back = useCallback(() => {
    if (flying.current || !results.length) return;
    const last = results[results.length - 1];
    if (last.verdict !== "skip") saver.push(last.card.id, { recordingId: last.card.recordingId, key: last.card.key, verdict: null });
    setResults((r) => r.slice(0, -1));
    setDone(false);
    setI(Math.max(0, results.length - 1));
  }, [results, saver]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1100);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (done) return;
      if (e.key === "ArrowRight") { e.preventDefault(); decide("goal"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); decide("not_goal"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); decide("skip"); }
      else if (e.key === "Backspace") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, back, close, done]);

  let body: React.ReactNode;
  if (!cards) {
    body = reelQuery.isError ? (
      <Centered>
        <p className="text-sm text-muted-text">{copy.error}</p>
        <button type="button" onClick={() => void reelQuery.refetch()} className="mt-3 min-h-12 rounded-full border border-line bg-surface/60 px-5 text-sm font-semibold">{copy.retry}</button>
      </Centered>
    ) : (
      <Centered><Loader2 className="h-6 w-6 animate-spin text-turf" /><p className="mt-3 text-sm text-muted-text">{copy.loading}</p></Centered>
    );
  } else if (!cards.length) {
    body = (
      <Centered>
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-turf/15 text-turf"><Check className="h-7 w-7" /></span>
        <h2 className="mt-3 font-display text-[26px] font-bold">{copy.noneTitle}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.noneDesc}</p>
        <button type="button" onClick={leave} className="mt-6 min-h-12 rounded-full bg-floodlight px-6 text-base font-bold text-void">{copy.backToMatch}</button>
      </Centered>
    );
  } else if (done) {
    body = <Done copy={copy} results={results} total={cards.length} failed={failed.length > 0} onBack={leave} onUndo={results.length ? back : null} />;
  } else {
    // the card on screen, the one peeking behind it, and one more loading out of sight
    const stack = cards.slice(i, i + 3).map((card, k) => ({ card, k }));
    body = (
      <>
        <div className="relative min-h-0 flex-1">
          {stack.slice().reverse().map(({ card, k }) => {
            const rec = recordings.get(card.recordingId);
            return (
              <CardView
                key={card.id}
                card={card}
                depth={k}
                copy={copy}
                names={names}
                colors={colors}
                url={rec?.videoUrl ?? ""}
                srcAspect={rec && rec.srcW > 0 && rec.srcH > 0 ? rec.srcW / rec.srcH : 3840 / 1080}
                active={k === 0}
                load={k === 0 || (k === 1 && frontDone) || (k === 2 && frontDone && primed(stack[1]?.card.id))}
                videoState={videoState[card.id] ?? "loading"}
                onVideoState={onVideoState}
                onDecide={decide}
              />
            );
          })}
          {toast && (
            <div key={toast.key} role="status" className="pointer-events-none absolute left-1/2 top-[34%] z-30 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full border border-turf/40 bg-raised py-2 pe-4 ps-2 shadow-[0_12px_32px_rgba(0,0,0,.45)] [animation:reel-toast_1.1s_ease-out_forwards]">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-turf/15 text-turf"><Check className="h-4 w-4" /></span>
              <span className="font-display text-base font-bold">{toast.text}</span>
            </div>
          )}
        </div>
        <Controls copy={copy} onDecide={decide} onBack={results.length ? back : null} />
      </>
    );
  }

  // A popup over the match page, not a page of its own: the match stays in
  // view behind it, and a tap outside closes it (2026-10-31, Mohammed).
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/65 backdrop-blur-[2px] [animation:reel-fade_.18s_ease-out] sm:items-center sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="goal-reel-backdrop"
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={copy.title} dir={copy.locale === "ar" ? "rtl" : "ltr"}
        className="relative flex h-[min(88dvh,720px)] w-full max-w-[440px] flex-col gap-3 overflow-hidden rounded-t-[28px] border border-line bg-void px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-2.5 text-text shadow-[0_-12px_48px_rgba(0,0,0,.55)] [animation:reel-up_.24s_cubic-bezier(.2,.8,.2,1)] sm:rounded-[28px]"
        data-testid="goal-reel">
        <span aria-hidden="true" className="mx-auto h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" />
        <Header copy={copy} onClose={close} progress={cards && cards.length && !done ? { at: i, of: cards.length } : null} />
        {body}
      </div>
      <style>{`@keyframes reel-toast{0%{transform:translate(-50%,12px);opacity:0}15%{transform:translate(-50%,0);opacity:1}80%{opacity:1}100%{transform:translate(-50%,-8px);opacity:0}}
@keyframes reel-up{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes reel-fade{from{opacity:0}to{opacity:1}}`}</style>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------- pieces */

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center text-center">{children}</div>;
}

function Header({ copy, onClose, progress }: { copy: GoalReelStrings; onClose: () => void; progress: { at: number; of: number } | null }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <button type="button" aria-label={copy.close} onClick={onClose} data-testid="button-reel-close"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-text">
        <X className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate font-display text-[11px] font-bold uppercase tracking-[0.3em] text-floodlight rtl:text-xs rtl:tracking-normal">{copy.title}</span>
        {progress && (
          <div className="flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={progress.of} aria-valuenow={progress.at}>
            {/* fills from the start of the line: from the right in Arabic */}
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-floodlight transition-[width] duration-200" style={{ width: `${(progress.at / progress.of) * 100}%` }} />
            </div>
            <span dir="ltr" className="shrink-0 font-mono text-[11px] tabular-nums text-muted-text">{Math.min(progress.at + 1, progress.of)}/{progress.of}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function cardText(card: ReelCard, copy: GoalReelStrings & { locale: "en" | "ar" }, names: Record<TeamSide, string>) {
  const team = card.side ? names[card.side] : null;
  // a Latin name in an Arabic line keeps its question mark on its own side
  const question: React.ReactNode = card.ownGoal
    ? (team ? copy.ownGoalFor(team) : copy.ownGoal)
    : card.scorer ? <><bdi>{card.scorer}</bdi>{copy.locale === "ar" ? "؟" : "?"}</> : team ? copy.forTeam(team) : copy.unknownSide;
  const reason = card.source === "goal" ? copy.sourceGoal : card.source === "event" ? copy.sourceEvent : copy.sourceShot;
  return { question, reason };
}

function CardView({ card, depth, copy, names, colors, url, srcAspect, active, load, videoState, onVideoState, onDecide }: {
  card: ReelCard; depth: number; copy: GoalReelStrings & { locale: "en" | "ar" }; names: Record<TeamSide, string>; colors: Record<TeamSide, string>;
  url: string; srcAspect: number; active: boolean; load: boolean; videoState: DeckVideoState;
  onVideoState: (id: string, state: DeckVideoState) => void;
  onDecide: (verdict: Verdict) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const yesRef = useRef<HTMLDivElement | null>(null);
  const noRef = useRef<HTMLDivElement | null>(null);
  const upRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const deckCard = useMemo(() => toDeckCard(card), [card]);
  const text = cardText(card, copy, names);

  const paint = (dx: number, dy: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `translate(${dx}px, ${Math.min(0, dy)}px) rotate(${dx / 20}deg)`;
    // right is goal in both languages, as on every swipe app; the buttons stay in that order too
    if (yesRef.current) yesRef.current.style.opacity = String(Math.max(0, Math.min(1, dx / SWIPE)));
    if (noRef.current) noRef.current.style.opacity = String(Math.max(0, Math.min(1, -dx / SWIPE)));
    if (upRef.current) upRef.current.style.opacity = String(Math.abs(dx) < 40 ? Math.max(0, Math.min(1, -dy / SWIPE)) : 0);
  };
  const reset = () => {
    if (!ref.current) return;
    ref.current.style.transition = "transform .2s ease-out";
    paint(0, 0);
  };
  const onDown = (e: React.PointerEvent) => {
    if (!active) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags */ }
    if (ref.current) ref.current.style.transition = "none";
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    paint(e.clientX - drag.current.x, e.clientY - drag.current.y);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = null;
    if (dx > SWIPE) onDecide("goal");
    else if (dx < -SWIPE) onDecide("not_goal");
    else if (dy < -SWIPE && Math.abs(dx) < 60) onDecide("skip");
    else reset();
  };
  // a drag the system took away is not an answer (some browsers report it at 0,0)
  const onCancel = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    reset();
  };

  const behind = depth > 0;
  const dot = card.side ? colors[card.side] : "#8A94A6";
  return (
    <div
      id={`reel-card-${card.id}`}
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      className={cn("absolute inset-0 flex select-none flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_20px_48px_rgba(0,0,0,.45)]",
        active ? "z-20 cursor-grab touch-none" : "z-10")}
      style={behind ? { transform: `translateY(${12 * depth}px) scale(${1 - 0.05 * depth})`, opacity: depth === 1 ? 1 : 0, transition: "transform .24s, opacity .24s" } : undefined}
      data-testid={active ? "reel-card-active" : undefined}
    >
      <div className="relative min-h-0 flex-1">
        {url && (
          <DeckVideo card={deckCard} url={url} srcAspect={srcAspect} active={active} load={load}
            onState={onVideoState} ringColor={FLOOD} tag={copy.tag} />
        )}
        <div className="pointer-events-none absolute left-3 right-40 top-3 flex flex-wrap gap-1.5" dir="ltr">
          <span className="rounded-md bg-black/60 px-2 py-0.5 font-display text-xs font-bold text-white">{card.minute}′</span>
          {card.likely && <span className="rounded-md bg-turf px-2 py-0.5 font-display text-xs font-bold text-void">{copy.likely}</span>}
        </div>
        {videoState === "failed" && (
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-xl bg-black/60 p-3 text-center text-xs text-white">{copy.videoFailed}</div>
        )}
        {active && videoState === "loading" && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-2 text-xs font-semibold text-muted-text">
            <Loader2 className="h-4 w-4 animate-spin" />{copy.videoSlow}
          </div>
        )}
        <div ref={yesRef} className="pointer-events-none absolute start-5 top-16 -rotate-12 rounded-xl border-[3px] border-floodlight bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-floodlight" style={{ opacity: 0 }}>{copy.goal}</div>
        <div ref={noRef} className="pointer-events-none absolute end-5 top-16 rotate-12 rounded-xl border-[3px] border-text bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-text" style={{ opacity: 0 }}>{copy.noGoal}</div>
        <div ref={upRef} className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-xl border-[3px] border-muted-text bg-void/55 px-3 py-1 font-display text-xl font-bold uppercase tracking-wider" style={{ opacity: 0 }}>{copy.cantTell}</div>
      </div>
      <div className="flex flex-col gap-2 px-[18px] pb-4 pt-3.5">
        <span className="flex min-w-0 items-start gap-2">
          <span className="mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden="true" />
          <span className="line-clamp-2 font-display text-[24px] font-bold leading-[1.15]">{text.question}</span>
        </span>
        <span className="inline-flex min-h-7 w-fit items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-xs font-semibold text-muted-text">
          <CircleAlert className="h-3.5 w-3.5" />{text.reason}
        </span>
      </div>
    </div>
  );
}

function Controls({ copy, onDecide, onBack }: { copy: GoalReelStrings; onDecide: (v: Verdict) => void; onBack: (() => void) | null }) {
  return (
    <div className="flex flex-col gap-1.5" dir="ltr">
      <div className="flex items-center justify-center gap-4">
        <button type="button" aria-label={copy.back} onClick={() => onBack?.()} disabled={!onBack} data-testid="button-reel-back"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface/60 text-muted-text active:scale-95 disabled:opacity-30">
          <Undo2 className="h-4 w-4" />
        </button>
        <button type="button" aria-label={copy.noGoal} onClick={() => onDecide("not_goal")} data-testid="button-reel-no"
          className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface/60 text-text active:scale-95">
          <X className="h-7 w-7" />
        </button>
        <button type="button" aria-label={copy.cantTell} onClick={() => onDecide("skip")} data-testid="button-reel-skip"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface/60 text-muted-text active:scale-95">
          <ArrowUp className="h-4 w-4" />
        </button>
        <button type="button" aria-label={copy.goal} onClick={() => onDecide("goal")} data-testid="button-reel-yes"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-floodlight text-void active:scale-95">
          <Check className="h-7 w-7" strokeWidth={2.8} />
        </button>
      </div>
      <div className="flex justify-center gap-4 text-[11px] font-semibold text-muted-text">
        <span className="w-11 text-center">{copy.back}</span>
        <span className="w-16 text-center">{copy.noGoal}</span>
        <span className="w-11 text-center">{copy.cantTell}</span>
        <span className="w-16 text-center">{copy.goal}</span>
      </div>
    </div>
  );
}

function Done({ copy, results, total, failed, onBack, onUndo }: {
  copy: GoalReelStrings; results: Result[]; total: number; failed: boolean; onBack: () => void; onUndo: (() => void) | null;
}) {
  const goals = results.filter((r) => r.verdict === "goal").length;
  const noGoals = results.filter((r) => r.verdict === "not_goal").length;
  const skipped = results.filter((r) => r.verdict === "skip").length;
  const left = Math.max(0, total - results.length);
  const tiles = [
    { value: goals, label: copy.goals, cls: "text-floodlight" },
    { value: noGoals, label: copy.noGoals, cls: "text-text" },
    { value: skipped, label: copy.skipped, cls: "text-muted-text" },
  ];
  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="goal-reel-done">
      <div className="flex flex-col items-center gap-2 rounded-3xl border border-floodlight/40 bg-surface px-5 py-5 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-floodlight/15 text-floodlight"><Trophy className="h-7 w-7" /></span>
        <h2 className="font-display text-[28px] font-bold leading-[1.05]">{left > 0 ? copy.pausedTitle(left) : copy.doneTitle}</h2>
        <p className="text-sm leading-6 text-muted-text">{left > 0 ? copy.pausedDesc : copy.doneDesc}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="flex flex-col gap-0.5 rounded-2xl border border-line bg-surface px-3 py-3.5">
            <span dir="ltr" className={cn("font-display text-[30px] font-bold leading-tight tabular-nums", tile.cls)}>{tile.value}</span>
            <span className="text-xs text-muted-text">{tile.label}</span>
          </div>
        ))}
      </div>
      {failed && <p role="alert" className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-muted-text">{copy.saveFailed}</p>}
      <div className="flex-1" />
      <button type="button" onClick={onBack} className="min-h-12 rounded-full bg-floodlight text-base font-bold text-void" data-testid="button-reel-done">{copy.backToMatch}</button>
      {onUndo && (
        <button type="button" onClick={onUndo} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-line text-sm font-semibold">
          <Undo2 className="h-4 w-4" />{copy.back}
        </button>
      )}
    </div>
  );
}

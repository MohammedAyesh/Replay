import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUp, Check, CircleAlert, Flame, Trophy, X } from "lucide-react";
import { getGetClaimChainQueryKey, getGetClaimMatchQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { createAnswerQueue, checkDeckKey, useCheckDeck, type DeckCard, type DeckVerdict } from "@/lib/check-deck";
import { DeckVideo, type DeckVideoState } from "@/components/check-deck/DeckVideo";
import { useCheckCopy, type CheckStrings } from "@/i18n/check-strings";
import { cn } from "@/lib/utils";

/**
 * "Is this you?" (/find/:id/check): after claiming himself, a player swipes
 * through the moments Replay is not sure were his, and through goals nobody
 * has confirmed. Right = that's me / goal, left = not me / no goal, up =
 * can't tell. Buttons and arrow keys do the same.
 *
 * Quick by design: the first two cards start loading on the intro screen, the
 * next ones load while you watch the current one, an answer moves the deck on
 * at once and is saved behind it (in order, one at a time).
 */

type Screen = "intro" | "deck" | "done";
type Result = { card: DeckCard; verdict: DeckVerdict };

const TURF = "#2FD8C4";
const FLOOD = "#D4FF4F";
/** a swipe this far decides, px */
const SWIPE = 96;
/** the card behind waits this long for the active one before loading anyway, ms */
const PRELOAD_GRACE = 2500;

export default function CheckDeckPage() {
  const params = useParams<{ id?: string }>();
  const recordingId = Number(params.id);
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const copy = useCheckCopy();
  const queryClient = useQueryClient();
  const deckQuery = useCheckDeck(recordingId, Boolean(user) && !isGuest);

  // The deck is fixed when it first arrives: a refetch never reshuffles cards under a thumb.
  const [cards, setCards] = useState<DeckCard[] | null>(null);
  useEffect(() => { if (deckQuery.data && cards === null) setCards(deckQuery.data.cards); }, [deckQuery.data, cards]);

  const [screen, setScreen] = useState<Screen>("intro");
  const [i, setI] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [videoState, setVideoState] = useState<Record<string, DeckVideoState>>({});
  const [graceFor, setGraceFor] = useState<string | null>(null);
  const flying = useRef(false);

  const queue = useMemo(() => createAnswerQueue(recordingId, (id) => setFailed((f) => [...f, id])), [recordingId]);
  const back = useCallback(() => setLocation(`/find/${recordingId}`), [recordingId, setLocation]);

  const finish = useCallback(() => {
    setScreen("done");
    void queue.drain().then(() => {
      void queryClient.invalidateQueries({ queryKey: checkDeckKey(recordingId) });
      void queryClient.invalidateQueries({ queryKey: getGetClaimMatchQueryKey(recordingId) });
      void queryClient.invalidateQueries({ queryKey: getGetClaimChainQueryKey(recordingId) });
    });
  }, [queue, queryClient, recordingId]);

  const current = cards?.[i] ?? null;
  // the card behind starts once the active one shows a frame, or after a short grace
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setGraceFor(current.id), PRELOAD_GRACE);
    return () => window.clearTimeout(timer);
  }, [current]);
  // one card loads at a time: each starts once the one in front of it has its whole moment in
  const settled = (id: string | undefined) => !id || videoState[id] === "buffered" || videoState[id] === "failed";
  const primed = (id: string | undefined) => !id || videoState[id] === "ready" || settled(id);
  // the card on top has what it needs: on the intro its first frame, in the deck its whole moment
  const frontDone = current
    ? (screen === "deck" ? settled(current.id) : primed(current.id)) || graceFor === current.id
    : false;

  const onVideoState = useCallback((id: string, state: DeckVideoState) => {
    setVideoState((s) => (s[id] === state ? s : { ...s, [id]: state }));
  }, []);

  const decide = useCallback((verdict: DeckVerdict) => {
    if (!cards || !current || flying.current || screen !== "deck") return;
    flying.current = true;
    const el = document.getElementById(`deck-card-${current.id}`);
    if (el) {
      el.style.transition = "transform .24s cubic-bezier(.2,.8,.2,1), opacity .24s";
      el.style.transform = verdict === "yes" ? "translate(140%, -6%) rotate(16deg)"
        : verdict === "no" ? "translate(-140%, -6%) rotate(-16deg)" : "translate(0, -120%)";
      el.style.opacity = "0";
    }
    try { navigator.vibrate?.(verdict === "skip" ? 6 : 14); } catch { /* not supported */ }
    void queue.push(current.id, verdict);
    const isGoal = current.kind === "goal";
    const text = verdict === "yes" ? (isGoal ? copy.toastGoal : copy.toastClip)
      : verdict === "no" ? (isGoal ? copy.toastNoGoal : copy.toastNotYou) : null;
    if (text) setToast({ text, key: Date.now() });
    setResults((r) => [...r, { card: current, verdict }]);
    setStreak((s) => {
      const next = verdict === "skip" ? s : s + 1;
      setBest((b) => Math.max(b, next));
      return next;
    });
    window.setTimeout(() => {
      flying.current = false;
      if (i + 1 >= cards.length) finish();
      else setI(i + 1);
    }, 230);
  }, [cards, current, screen, queue, copy, i, finish]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1300);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // arrow keys on a keyboard
  useEffect(() => {
    if (screen !== "deck") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); decide("yes"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); decide("no"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); decide("skip"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, decide]);

  if (authLoading || (deckQuery.isLoading && !cards)) {
    return <Frame><Centered><p className="text-sm text-muted-text">{copy.loading}</p></Centered></Frame>;
  }
  if (!user || isGuest) {
    return <Frame><Centered><button type="button" onClick={back} className="text-sm font-semibold text-turf">{copy.later}</button></Centered></Frame>;
  }
  if (deckQuery.isError && !cards) {
    return (
      <Frame>
        <Centered>
          <p className="text-sm text-muted-text">{copy.error}</p>
          <button type="button" onClick={() => void deckQuery.refetch()} className="mt-3 min-h-12 rounded-full border border-line bg-surface/60 px-5 text-sm font-semibold">{copy.retry}</button>
        </Centered>
      </Frame>
    );
  }
  const deck = deckQuery.data;
  if (!cards || !deck) return <Frame><Centered><p className="text-sm text-muted-text">{copy.loading}</p></Centered></Frame>;

  if (!cards.length) {
    return (
      <Frame>
        <Header copy={copy} onClose={back} title={copy.eyebrow} />
        <div className="flex flex-1 flex-col justify-center gap-3 rounded-3xl border border-line bg-surface p-6 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-turf/15 text-turf"><Check className="h-7 w-7" /></span>
          <h1 className="font-display text-[28px] font-bold leading-tight">{copy.emptyTitle}</h1>
          <p className="text-sm leading-6 text-muted-text">{copy.emptyDesc}</p>
        </div>
        <button type="button" onClick={back} className="mt-4 min-h-12 rounded-full bg-floodlight text-base font-bold text-void">{copy.backToMatch}</button>
      </Frame>
    );
  }

  const youCount = cards.filter((c) => c.kind === "you").length;
  const goalCount = cards.length - youCount;
  const srcAspect = deck.srcW > 0 && deck.srcH > 0 ? deck.srcW / deck.srcH : 3840 / 1080;
  const url = deck.videoUrl ?? "";

  // the stack: the active card, the one peeking behind it, and one more loading out of sight
  const stack = cards.slice(i, i + 3).map((card, k) => ({ card, k }));

  return (
    <Frame>
      {screen === "deck" && (
        <Header
          copy={copy}
          onClose={finish}
          title={current?.kind === "goal" ? copy.deckGoals : copy.deckYou}
          progress={{ at: i, of: cards.length }}
          streak={streak}
        />
      )}

      {/* The deck is mounted from the intro on, so the first cards load while you read. */}
      <div className={cn("relative flex-1", screen !== "deck" && "pointer-events-none absolute inset-x-4 bottom-0 top-0 opacity-0")}>
        {stack.slice().reverse().map(({ card, k }) => (
          <CardView
            key={card.id}
            card={card}
            depth={k}
            copy={copy}
            url={url}
            srcAspect={srcAspect}
            active={screen === "deck" && k === 0}
            load={k === 0 || (k === 1 && frontDone) || (k === 2 && frontDone && primed(stack[1]?.card.id))}
            videoState={videoState[card.id] ?? "loading"}
            onVideoState={onVideoState}
            onDecide={decide}
          />
        ))}
        {toast && (
          <div key={toast.key} role="status" className="pointer-events-none absolute left-1/2 top-[34%] z-30 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full border border-turf/40 bg-raised py-2 pe-4 ps-2 shadow-[0_12px_32px_rgba(0,0,0,.45)] [animation:deck-toast_1.3s_ease-out_forwards]">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-turf/15 text-turf"><Check className="h-4 w-4" /></span>
            <span className="font-display text-base font-bold">{toast.text}</span>
          </div>
        )}
      </div>

      {screen === "deck" && current && (
        <Controls copy={copy} goal={current.kind === "goal"} onDecide={decide} />
      )}

      {screen === "intro" && (
        <Intro copy={copy} youCount={youCount} goalCount={goalCount} onStart={() => setScreen("deck")} onLater={back} />
      )}

      {screen === "done" && (
        <Done copy={copy} results={results} best={best} total={cards.length} failed={failed.length > 0}
          onClips={() => setLocation("/my-clips")} onBack={back} />
      )}
      <style>{`
        @keyframes deck-toast{0%{transform:translate(-50%,12px);opacity:0}15%{transform:translate(-50%,0);opacity:1}80%{opacity:1}100%{transform:translate(-50%,-8px);opacity:0}}
        @keyframes deck-fall{0%{transform:translateY(-30px) rotate(0deg);opacity:1}100%{transform:translateY(105vh) rotate(420deg);opacity:.8}}
        @keyframes deck-pop{0%{transform:scale(.7);opacity:0}60%{transform:scale(1.06);opacity:1}100%{transform:scale(1)}}
      `}</style>
    </Frame>
  );
}

/* --------------------------------------------------------------- layout */

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-center overflow-hidden bg-void text-text">
      <div className="relative flex h-full w-full max-w-[460px] flex-col gap-3 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))]">
        {children}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center text-center">{children}</div>;
}

function Header({ copy, onClose, title, progress, streak }: {
  copy: CheckStrings; onClose: () => void; title: string; progress?: { at: number; of: number }; streak?: number;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3">
      <button type="button" aria-label={copy.close} onClick={onClose}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line text-text">
        {progress ? <X className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5 rtl:rotate-180" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">{title}</span>
        {progress && (
          <div className="flex items-center gap-2" role="progressbar" aria-valuemin={0} aria-valuemax={progress.of} aria-valuenow={progress.at}>
            <div className="flex flex-1 gap-1">
              {Array.from({ length: progress.of }, (_, k) => (
                <span key={k} className={cn("h-1 flex-1 rounded-full", k < progress.at ? "bg-turf" : k === progress.at ? "bg-turf/45" : "bg-line")} />
              ))}
            </div>
            <span dir="ltr" className="shrink-0 font-mono text-[11px] tabular-nums text-muted-text">{Math.min(progress.at + 1, progress.of)}/{progress.of}</span>
          </div>
        )}
      </div>
      {streak !== undefined && (
        <span className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full border border-violet/40 bg-violet/10 px-2.5 font-display text-sm font-bold text-[#A98CFF]">
          <Flame className="h-3.5 w-3.5" /><span dir="ltr">{streak}</span>
        </span>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- card */

function cardText(card: DeckCard, copy: CheckStrings) {
  if (card.kind === "goal" && card.goal) {
    const g = card.goal;
    return {
      kicker: copy.kickerGoal,
      question: g.side === "yours" ? copy.goalYours : g.side === "theirs" ? copy.goalTheirs : copy.goalUnknown,
      reason: g.ownGoal ? copy.ownGoal : g.source === "goal" ? copy.sourceGoal : g.source === "event" ? copy.sourceEvent : copy.sourceShot,
      yes: copy.goal, no: copy.noGoal,
    };
  }
  const y = card.you!;
  const question = y.momentKind === "your-shot" ? copy.momentShot
    : y.momentKind === "your-goal" ? copy.momentGoal
      : y.momentKind === "dribble" ? copy.momentDribble(y.beaten) : copy.momentPass(y.metres);
  const r = y.reasons[0];
  const reason = r === "teammate" ? copy.reasonTeammate : r === "crowd" ? copy.reasonCrowd : r === "join" ? copy.reasonJoin : copy.reasonShort;
  return { kicker: copy.kickerYou, question, reason, yes: copy.thatsMe, no: copy.notMe };
}

function CardView({ card, depth, copy, url, srcAspect, active, load, videoState, onVideoState, onDecide }: {
  card: DeckCard; depth: number; copy: CheckStrings & { isRtl: boolean }; url: string; srcAspect: number;
  active: boolean; load: boolean; videoState: DeckVideoState;
  onVideoState: (id: string, state: DeckVideoState) => void;
  onDecide: (verdict: DeckVerdict) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const yesRef = useRef<HTMLDivElement | null>(null);
  const noRef = useRef<HTMLDivElement | null>(null);
  const upRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const text = cardText(card, copy);
  const isGoal = card.kind === "goal";
  const ring = isGoal ? FLOOD : TURF;

  const paint = (dx: number, dy: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `translate(${dx}px, ${Math.min(0, dy)}px) rotate(${dx / 20}deg)`;
    // right is yes in every language, as on every swipe app; the buttons stay in that order too
    const toward = dx;
    if (yesRef.current) yesRef.current.style.opacity = String(Math.max(0, Math.min(1, toward / SWIPE)));
    if (noRef.current) noRef.current.style.opacity = String(Math.max(0, Math.min(1, -toward / SWIPE)));
    if (upRef.current) upRef.current.style.opacity = String(Math.abs(dx) < 40 ? Math.max(0, Math.min(1, -dy / SWIPE)) : 0);
  };
  const onDown = (e: React.PointerEvent) => {
    if (!active) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer that can't be captured still drags */ }
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
    const toward = dx;
    if (toward > SWIPE) onDecide("yes");
    else if (toward < -SWIPE) onDecide("no");
    else if (dy < -SWIPE && Math.abs(dx) < 60) onDecide("skip");
    else if (ref.current) {
      ref.current.style.transition = "transform .2s ease-out";
      paint(0, 0);
    }
  };

  const behind = depth > 0;
  return (
    <div
      id={`deck-card-${card.id}`}
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className={cn("absolute inset-0 flex select-none flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_20px_48px_rgba(0,0,0,.45)]",
        active ? "z-20 cursor-grab touch-none" : "z-10")}
      style={behind ? { transform: `translateY(${12 * depth}px) scale(${1 - 0.05 * depth})`, opacity: depth === 1 ? 1 : 0, transition: "transform .24s, opacity .24s" } : undefined}
      data-testid={active ? "deck-card-active" : undefined}
    >
      <div className="relative min-h-0 flex-1">
        {url && (
          <DeckVideo card={card} url={url} srcAspect={srcAspect} active={active} load={load}
            onState={onVideoState} ringColor={ring} tag={isGoal ? copy.in : copy.you} />
        )}
        <div className="pointer-events-none absolute left-3 right-40 top-3 flex flex-wrap gap-1.5" dir="ltr">
          <span dir="ltr" className="rounded-md bg-black/60 px-2 py-0.5 font-display text-xs font-bold text-white">{card.clock}</span>
          {card.goal?.likely && <span className="rounded-md bg-turf px-2 py-0.5 font-display text-xs font-bold text-void">{copy.likely}</span>}
        </div>
        {videoState === "failed" && (
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-xl bg-black/60 p-3 text-center text-xs text-white">{copy.videoFailed}</div>
        )}
        {active && videoState === "loading" && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-xs font-semibold text-muted-text">{copy.videoSlow}</div>
        )}
        <div ref={yesRef} className="pointer-events-none absolute start-5 top-16 -rotate-12 rounded-xl border-[3px] border-floodlight bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-floodlight" style={{ opacity: 0 }}>{text.yes}</div>
        <div ref={noRef} className="pointer-events-none absolute end-5 top-16 rotate-12 rounded-xl border-[3px] border-text bg-void/55 px-3 py-1 font-display text-2xl font-bold uppercase tracking-wider text-text" style={{ opacity: 0 }}>{text.no}</div>
        <div ref={upRef} className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-xl border-[3px] border-muted-text bg-void/55 px-3 py-1 font-display text-xl font-bold uppercase tracking-wider" style={{ opacity: 0 }}>{copy.cantTell}</div>
      </div>
      <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-4">
        <span className={cn("font-display text-[11px] font-bold uppercase tracking-[0.3em] rtl:text-xs rtl:tracking-normal", isGoal ? "text-floodlight" : "text-turf")}>{text.kicker}</span>
        <span className="font-display text-[28px] font-bold leading-[1.05]">{text.question}</span>
        <span className="inline-flex min-h-7 w-fit items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-xs font-semibold text-muted-text">
          <CircleAlert className="h-3.5 w-3.5" />{text.reason}
        </span>
      </div>
    </div>
  );
}

function Controls({ copy, goal, onDecide }: { copy: CheckStrings; goal: boolean; onDecide: (v: DeckVerdict) => void }) {
  const no = goal ? copy.noGoal : copy.notMe, yes = goal ? copy.goal : copy.thatsMe;
  return (
    <div className="flex flex-col gap-1.5" dir="ltr">
      <div className="flex items-center justify-center gap-5">
        <button type="button" aria-label={no} onClick={() => onDecide("no")} data-testid="button-deck-no"
          className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-surface/60 text-text active:scale-95">
          <X className="h-7 w-7" />
        </button>
        <button type="button" aria-label={copy.cantTell} onClick={() => onDecide("skip")} data-testid="button-deck-skip"
          className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface/60 text-muted-text active:scale-95">
          <ArrowUp className="h-5 w-5" />
        </button>
        <button type="button" aria-label={yes} onClick={() => onDecide("yes")} data-testid="button-deck-yes"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-floodlight text-void active:scale-95">
          <Check className="h-7 w-7" strokeWidth={2.8} />
        </button>
      </div>
      <div className="flex justify-center gap-5 text-xs font-semibold text-muted-text">
        <span className="w-16 text-center">{no}</span><span className="w-12 text-center">{copy.skip}</span><span className="w-16 text-center">{yes}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- intro */

function Intro({ copy, youCount, goalCount, onStart, onLater }: {
  copy: CheckStrings; youCount: number; goalCount: number; onStart: () => void; onLater: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col gap-4 bg-void px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))]">
      <Header copy={copy} onClose={onLater} title={copy.eyebrow} />
      <div className="flex flex-col gap-2.5 rounded-3xl border border-turf/40 bg-surface p-5">
        <span className="inline-flex items-center gap-2 font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">
          <Check className="h-3.5 w-3.5" />{copy.claimed}
        </span>
        <h1 className="font-display text-[30px] font-bold leading-[1.05]">{youCount ? copy.introTitle(youCount) : copy.introGoalsOnly(goalCount)}</h1>
        <p className="text-sm leading-6 text-muted-text">{youCount ? copy.introDesc : copy.goalsOnlyDesc}</p>
      </div>
      <div className="grid grid-cols-3 gap-2" dir="ltr">
        {[
          { icon: <X className="h-[18px] w-[18px]" />, label: copy.notMe, hint: copy.swipeLeft, tone: "plain" },
          { icon: <ArrowUp className="h-[18px] w-[18px]" />, label: copy.cantTell, hint: copy.swipeUp, tone: "plain" },
          { icon: <Check className="h-[18px] w-[18px]" />, label: copy.thatsMe, hint: copy.swipeRight, tone: "flood" },
        ].map((item) => (
          <div key={item.label} className={cn("flex flex-col items-center gap-1.5 rounded-2xl border bg-surface px-2 py-3.5 text-center", item.tone === "flood" ? "border-floodlight/40" : "border-line")}>
            <span className={cn("flex h-10 w-10 items-center justify-center rounded-full", item.tone === "flood" ? "bg-floodlight text-void" : "border border-line bg-raised")}>{item.icon}</span>
            <span className="font-display text-[15px] font-bold">{item.label}</span>
            <span className="text-[11px] text-muted-text">{item.hint}</span>
          </div>
        ))}
      </div>
      {youCount > 0 && goalCount > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-floodlight/15 text-floodlight"><Trophy className="h-[18px] w-[18px]" /></span>
          <span className="text-sm leading-5">{copy.introGoals(goalCount)}</span>
        </div>
      )}
      <div className="flex-1" />
      <button type="button" onClick={onStart} data-testid="button-deck-start" className="min-h-12 rounded-full bg-floodlight text-base font-bold text-void">{copy.start}</button>
      <button type="button" onClick={onLater} className="min-h-12 rounded-full border border-line bg-surface/60 text-sm font-semibold">{copy.later}</button>
    </div>
  );
}

/* ----------------------------------------------------------------- done */

function Done({ copy, results, best, total, failed, onClips, onBack }: {
  copy: CheckStrings; results: Result[]; best: number; total: number; failed: boolean; onClips: () => void; onBack: () => void;
}) {
  const kept = results.filter((r) => r.card.kind === "you" && r.verdict === "yes").length;
  const sentBack = results.filter((r) => r.card.kind === "you" && r.verdict === "no").length;
  const goals = results.filter((r) => r.card.kind === "goal" && r.verdict === "yes").length;
  const answered = results.filter((r) => r.verdict !== "skip").length;
  const confetti = useMemo(() => Array.from({ length: 22 }, (_, k) => ({
    left: `${(k * 41) % 100}%`, w: 5 + (k % 3) * 2, h: 9 + (k % 4) * 2,
    color: ["#D4FF4F", "#2FD8C4", "#7B5CFF", "#F2F4F8"][k % 4],
    anim: `deck-fall ${2.4 + (k % 5) * 0.35}s ${(k % 7) * 0.12}s ease-in both`,
  })), []);
  const tiles = [
    { value: kept, label: copy.kept, cls: "text-floodlight" },
    { value: sentBack, label: copy.sentBack, cls: "text-text" },
    { value: goals, label: copy.goalsConfirmed, cls: "text-turf" },
    { value: best, label: copy.bestStreak, cls: "text-[#A98CFF]" },
  ];
  return (
    <div className="absolute inset-0 z-30 flex flex-col gap-4 overflow-hidden bg-void px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))]">
      {answered > 0 && confetti.map((c, k) => (
        <span key={k} aria-hidden="true" className="pointer-events-none absolute top-0 rounded-[2px]"
          style={{ left: c.left, width: c.w, height: c.h, background: c.color, animation: c.anim }} />
      ))}
      <div className="flex min-h-12 items-center justify-center">
        <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-turf rtl:text-xs rtl:tracking-normal">{copy.doneEyebrow}</span>
      </div>
      <div className="flex flex-col items-center gap-2.5 rounded-3xl border border-floodlight/40 bg-surface px-5 py-6 text-center">
        <span className="flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-floodlight/15 text-floodlight [animation:deck-pop_.5s_ease-out_both]"><Trophy className="h-9 w-9" /></span>
        <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-floodlight rtl:text-xs rtl:tracking-normal">{answered === total ? copy.badgeAll : copy.badgeSome}</span>
        <h2 className="font-display text-[30px] font-bold leading-[1.05]">{copy.doneTitle}</h2>
        <p className="text-sm leading-6 text-muted-text">{copy.doneDesc}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="flex flex-col gap-0.5 rounded-2xl border border-line bg-surface px-4 py-3.5">
            <span dir="ltr" className={cn("font-display text-[32px] font-bold leading-tight tabular-nums", tile.cls)}>{tile.value}</span>
            <span className="text-xs text-muted-text">{tile.label}</span>
          </div>
        ))}
      </div>
      {failed && <p role="alert" className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-muted-text">{copy.saveFailed}</p>}
      <div className="flex-1" />
      <button type="button" onClick={onClips} className="min-h-12 rounded-full bg-floodlight text-base font-bold text-void">{copy.seeClips}</button>
      <button type="button" onClick={onBack} className="min-h-12 rounded-full border border-turf/60 text-sm font-bold text-turf">{copy.backToMatch}</button>
    </div>
  );
}
